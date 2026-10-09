#!/usr/bin/env node
/**
 * Repeatable, read-only scenario runner that compares a local Mirage with a live
 * Power Pages reference portal. Live reads use either an owned tab in an attached
 * browser (signed-in identity) or a cookie-free request/owned headless browser
 * (anonymous). Every saved value passes through normalisation and redaction.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { validateLivePath, decodePagingCookie } from "./lib/live.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const SCENARIO_KINDS = Object.freeze([
  "page-dom",
  "page-text",
  "page-shell",
  "client-object",
  "api-json",
  "api-status",
  "liquid-probe",
  "anonymous",
  "error-page",
  "headers",
  "reference-contracts",
  "webfile-drift",
]);
export const IDENTITIES = Object.freeze(["signed-in", "anonymous"]);
export const DELTA_CLASSES = Object.freeze([
  "runtime-gap",
  "data-difference",
  "source-deployment",
  "hosted-infrastructure",
  "harness",
  "unclassified",
]);
/** Expected classes explain a delta without a Mirage defect: data, deployed-source drift, hosting. */
const EXPECTED_CLASSES = new Set(["data-difference", "source-deployment", "hosted-infrastructure"]);

/**
 * Paths whose load or intent can create, submit, sign out or export, on any portal. They are
 * never requested. A project's own routes of that kind belong in its plan's `deniedRoutes`
 * (a data pack ships them in its parity plan), which loading the plan adds to this list.
 */
export const DENIED_ROUTE_PATTERNS = Object.freeze([
  /(?:^|\/)(?:sign-?out|log-?off|logout)(?:[/?]|$)/i,
  /\/(?:signin|sign-in|login)(?:[/?]|$)/i,
  /\/Account\/Login\//i,
  /\/clearcache(?:\/|\?|$)/i,
  /\/_services\//i,
  /\/_portal\/modal-form-template-path\//i,
  /\/__?sim(?:\/|-|$)/i,
  /\/(?:delete|remove|deactivate|reopen|submit|approve|assign|upload)(?:[/?]|$)/i,
]);

/** `deniedRoutes` entries ({ pattern, reason }) as case-insensitive expressions. */
export function compileDeniedRoutes(entries = []) {
  if (!Array.isArray(entries)) throw new Error("deniedRoutes must be an array.");
  return entries.map((entry) => {
    if (typeof entry?.pattern !== "string" || !entry.pattern || typeof entry.reason !== "string" || entry.reason.trim().length < 10)
      throw new Error("Each denied route needs a pattern and a documented reason.");
    try {
      return new RegExp(entry.pattern, "i");
    } catch {
      throw new Error(`Denied route pattern ${entry.pattern} is not a valid regular expression.`);
    }
  });
}
/**
 * Denied routes of the plans validated in this process and of the data packs matching the run's
 * portal (activatePackDeniedRoutes). A route that any of them denies stays denied: the list only
 * grows, so validating another plan never lifts a denial.
 */
const planDeniedRoutes = new Map();
const rememberDeniedRoutes = (entries, compiled) => entries.forEach((entry, index) => planDeniedRoutes.set(entry.pattern, compiled[index]));
export const activePlanDeniedRoutes = () => [...planDeniedRoutes.values()];

const sha256 = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
const loopbackHost = (host) => ["127.0.0.1", "localhost", "[::1]", "::1"].includes(host);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Phase trace on stderr when PARITY_DEBUG is set (no values, only phase names and timings). */
const trace = (...parts) => {
  if (process.env.PARITY_DEBUG) process.stderr.write(`[parity ${new Date().toISOString().slice(11, 19)}] ${parts.join(" ")}\n`);
};
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

// ---------------------------------------------------------------------------
// Read-only guards
// ---------------------------------------------------------------------------

/** Validate a portal-relative scenario path before any request is formed. */
export function assertReadOnlyPath(value, { allowDenied = false, denied = activePlanDeniedRoutes() } = {}) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.length > 8192)
    throw new Error("Scenario paths must be portal-relative.");
  validateLivePath(value);
  if (!allowDenied) {
    const decodedPath = (() => {
      try {
        return decodeURIComponent(value.split("?")[0]);
      } catch {
        return value.split("?")[0];
      }
    })();
    for (const pattern of [...DENIED_ROUTE_PATTERNS, ...denied])
      if (pattern.test(decodedPath))
        throw new Error(`Scenario path is on the read-only deny list: ${decodedPath}`);
  }
  return value;
}

/**
 * Non-GET requests the suite lets reach the reference portal: none. No platform request other
 * than GET and HEAD is documented as read-only (the grid, lookup and subgrid data services are
 * internal POST endpoints without such documentation), so the list is empty and plans cannot add
 * to it. A page's writes are blocked, or answered locally by a plan's fulfilment rule without
 * reaching any server, so `/_api` writes never reach the reference.
 */
export const SAFE_REFERENCE_REQUESTS = Object.freeze([]);

/**
 * Decide whether an observed browser request may proceed: GET and HEAD, plus the fixed
 * SAFE_REFERENCE_REQUESTS list (empty). Nothing a plan says can widen this.
 */
export function isAllowedRequest(method, url, { origins = [] } = {}) {
  const verb = String(method || "").toUpperCase();
  if (verb === "GET" || verb === "HEAD") return { allowed: true };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: "invalid-url" };
  }
  for (const entry of SAFE_REFERENCE_REQUESTS)
    if (entry.method === verb && (!origins.length || origins.includes(parsed.origin)) && parsed.pathname.startsWith(entry.pathPrefix))
      return { allowed: true, allowListed: entry.pathPrefix };
  return { allowed: false, reason: "non-read-method" };
}

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;
const usesId = (scenario) => [scenario.path, scenario.fetchXml, ...Object.values(scenario.query ?? {})].some((value) => typeof value === "string" && /\{[A-Za-z][A-Za-z0-9_]*\}/.test(value));

/** Values `discover.from: "portal"` supplies, chosen from the exported portal and the local mappings. */
export const PORTAL_DISCOVERY = Object.freeze({
  protectedPage: "page that anonymous visitors may not read",
  publicWebFile: "stylesheet web file that anonymous visitors may read",
  enabledEntitySet: "table enabled for the Web API",
  enabledField: "column of a table enabled for the Web API",
  notEnabledEntitySet: "mapped table that is not enabled for the Web API",
  ambiguousPage: "URL shared by exported pages with different anonymous access",
});
const PORTAL_DISCOVERY_SAMPLE = Object.freeze({ protectedPage: "/sample/", publicWebFile: "/sample.css", enabledEntitySet: "samples", enabledField: "sampleid", notEnabledEntitySet: "others", ambiguousPage: "/shared/" });

/** Build the portal-relative request path; FetchXML and OData options are encoded here. */
export function scenarioPath(scenario, id) {
  // id is either one record identifier ({id}) or a map of named placeholders ({id}, {appTypeId}, ...).
  const values = id === undefined ? null : typeof id === "object" ? id : { id };
  const fill = (value) => (values ? String(value).replace(PLACEHOLDER, (match, name) => (Object.hasOwn(values, name) ? String(values[name]) : match)) : value);
  let target = fill(scenario.path);
  const params = [];
  for (const [name, value] of Object.entries(scenario.query ?? {})) params.push(`${encodeURIComponent(name)}=${encodeURIComponent(fill(value))}`);
  if (scenario.fetchXml) params.push(`fetchXml=${encodeURIComponent(fill(scenario.fetchXml.trim()))}`);
  if (params.length) target += (target.includes("?") ? "&" : "?") + params.join("&");
  return target;
}

const ALLOWED_PREFER = /^(?:odata\.maxpagesize=[1-9]\d{0,4}|odata\.include-annotations="(?:\*|[\w.*,-]+)"(?:\s*,\s*odata\.maxpagesize=[1-9]\d{0,4})?)$/i;

/** Validate the scenario plan. Unsafe or ambiguous definitions fail before any request. */
export function validatePlan(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw new Error("A parity plan object is required.");
  if (plan.version !== 1) throw new Error("Parity plan version 1 is required.");
  if (!Array.isArray(plan.scenarios) || !plan.scenarios.length || plan.scenarios.length > 300)
    throw new Error("Supply 1–300 parity scenarios.");
  // A project plan may deny its own state-changing routes ({ pattern, reason }).
  const denied = compileDeniedRoutes(plan.deniedRoutes ?? []);
  const ids = new Set();
  for (const scenario of plan.scenarios) {
    if (!scenario || typeof scenario.id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,80}$/i.test(scenario.id))
      throw new Error("Each scenario needs a short identifier.");
    if (ids.has(scenario.id)) throw new Error(`Duplicate scenario id: ${scenario.id}`);
    ids.add(scenario.id);
    if (!SCENARIO_KINDS.includes(scenario.kind)) throw new Error(`Scenario ${scenario.id} has an unsupported kind.`);
    if (scenario.method && !["GET", "HEAD"].includes(String(scenario.method).toUpperCase()))
      throw new Error(`Scenario ${scenario.id} must be a GET/HEAD read.`);
    if (scenario.identity && !IDENTITIES.includes(scenario.identity))
      throw new Error(`Scenario ${scenario.id} has an unsupported identity.`);
    if (scenario.kind === "anonymous" && scenario.identity && scenario.identity !== "anonymous")
      throw new Error(`Scenario ${scenario.id} is anonymous by definition.`);
    if (scenario.kind === "reference-contracts") {
      if (typeof scenario.plan !== "string" || !scenario.plan.endsWith(".json"))
        throw new Error(`Scenario ${scenario.id} must name a JSON contract plan.`);
      continue;
    }
    if (scenario.kind === "webfile-drift") {
      if (scenario.identity !== "anonymous") throw new Error(`Scenario ${scenario.id} reads deployed web files anonymously; set identity to anonymous.`);
      if (scenario.paths !== undefined && (!Array.isArray(scenario.paths) || scenario.paths.some((item) => typeof item !== "string")))
        throw new Error(`Scenario ${scenario.id} paths must be a string array.`);
      for (const item of scenario.paths ?? []) assertReadOnlyPath(item, { denied });
      if (!scenario.paths?.length && !scenario.fromPages) throw new Error(`Scenario ${scenario.id} needs paths or fromPages.`);
      continue;
    }
    if (typeof scenario.path !== "string") throw new Error(`Scenario ${scenario.id} needs a path.`);
    if (scenario.query !== undefined && (!scenario.query || typeof scenario.query !== "object" || Array.isArray(scenario.query) || Object.values(scenario.query).some((value) => typeof value !== "string")))
      throw new Error(`Scenario ${scenario.id} query must be a string map.`);
    if (scenario.fetchXml !== undefined && (typeof scenario.fetchXml !== "string" || !/^<fetch\b[\s\S]*<\/fetch>$/.test(scenario.fetchXml.trim())))
      throw new Error(`Scenario ${scenario.id} fetchXml must be one fetch document.`);
    assertReadOnlyPath(scenarioPath(scenario, scenario.discover?.from === "portal" ? PORTAL_DISCOVERY_SAMPLE : "00000000-0000-0000-0000-000000000000"), { denied });
    if (scenario.prefer !== undefined && (typeof scenario.prefer !== "string" || !ALLOWED_PREFER.test(scenario.prefer)))
      throw new Error(`Scenario ${scenario.id} has an unsupported Prefer header.`);
    if (scenario.discover) {
      const discover = scenario.discover;
      if (discover.from !== "ids" && discover.from !== "portal") {
        if (typeof discover.path !== "string") throw new Error(`Scenario ${scenario.id} discovery needs a path.`);
        assertReadOnlyPath(discover.path, { denied });
      }
      if (discover.from === "portal") {
        if (!Array.isArray(discover.keys) || !discover.keys.length || discover.keys.some((key) => !Object.hasOwn(PORTAL_DISCOVERY, key)))
          throw new Error(`Scenario ${scenario.id} portal discovery needs known keys.`);
        if (!usesId(scenario)) throw new Error(`Scenario ${scenario.id} portal discovery needs placeholders.`);
      } else if (discover.from === "ids") {
        if (typeof discover.key !== "string" || !/^[\w-]{1,80}$/.test(discover.key)) throw new Error(`Scenario ${scenario.id} id discovery needs a key.`);
        if (!usesId(scenario)) throw new Error(`Scenario ${scenario.id} id discovery needs placeholders.`);
      } else if (discover.from === "page") {
        if (typeof discover.selector !== "string" || !discover.selector.trim()) throw new Error(`Scenario ${scenario.id} page discovery needs a selector.`);
        if (discover.attribute !== undefined && !/^[\w:-]+$/.test(discover.attribute)) throw new Error(`Scenario ${scenario.id} discovery attribute is invalid.`);
        if (discover.pathPattern !== undefined) new RegExp(discover.pathPattern);
      } else {
        if (typeof discover.field !== "string") throw new Error(`Scenario ${scenario.id} discovery needs a field.`);
        if (!/^\/_api\//.test(discover.path)) throw new Error(`Scenario ${scenario.id} discovery must be a Web API read.`);
        if (!usesId(scenario)) throw new Error(`Scenario ${scenario.id} discovery needs an {id} placeholder.`);
      }
    } else if (usesId(scenario)) throw new Error(`Scenario ${scenario.id} uses {id} without discovery.`);
    for (const list of ["tags", "questions", "facts"])
      if (scenario[list] !== undefined && (!Array.isArray(scenario[list]) || scenario[list].some((item) => typeof item !== "string")))
        throw new Error(`Scenario ${scenario.id} ${list} must be a string array.`);
    if (scenario.via !== undefined && !["navigation", "fetch"].includes(scenario.via)) throw new Error(`Scenario ${scenario.id} via must be navigation or fetch.`);
    if (scenario.kind === "liquid-probe") {
      const probe = scenario.probe;
      if (!probe || (probe.source ?? "html") !== "html" && probe.source !== "dom")
        throw new Error(`Scenario ${scenario.id} needs an html or dom probe.`);
      if (probe.regex !== undefined) new RegExp(probe.regex, probe.flags ?? "");
      if ((probe.source ?? "html") === "html" && typeof probe.regex !== "string")
        throw new Error(`Scenario ${scenario.id} html probe needs a regex.`);
      if (probe.source === "dom" && typeof probe.selector !== "string")
        throw new Error(`Scenario ${scenario.id} dom probe needs a selector.`);
      if (probe.revealLive === true && (typeof probe.revealReason !== "string" || probe.revealReason.trim().length < 20))
        throw new Error(`Scenario ${scenario.id} keeps the live probe value; state why in revealReason.`);
    }
    if (scenario.followNextLink !== undefined && (!Number.isInteger(scenario.followNextLink) || scenario.followNextLink < 1 || scenario.followNextLink > 5))
      throw new Error(`Scenario ${scenario.id} may follow 1–5 next links.`);
    if (scenario.fetchXmlPaging !== undefined && (!Number.isInteger(scenario.fetchXmlPaging) || scenario.fetchXmlPaging < 2 || scenario.fetchXmlPaging > 5))
      throw new Error(`Scenario ${scenario.id} may follow FetchXML pages 2–5.`);
    for (const list of ["roots", "exclude", "dataSelectors", "opaque", "compareValues"])
      if (scenario[list] !== undefined && (!Array.isArray(scenario[list]) || scenario[list].some((item) => typeof item !== "string")))
        throw new Error(`Scenario ${scenario.id} ${list} must be a string array.`);
  }
  if (plan.allowPost !== undefined && (!Array.isArray(plan.allowPost) || plan.allowPost.length))
    throw new Error("Plans cannot allow non-GET requests: the suite sends only GET and HEAD to the reference. Answer a page's write locally with a fulfil rule instead.");
  for (const rule of plan.fulfil ?? []) {
    if (!rule?.method || ["GET", "HEAD"].includes(String(rule.method).toUpperCase()) || typeof rule.pathPattern !== "string" || !Number.isInteger(rule.status) || rule.status < 200 || rule.status > 299 || typeof rule.reason !== "string" || rule.reason.length < 10)
      throw new Error("Each fulfilment rule needs a non-read method, path pattern, 2xx status and a documented reason.");
    new RegExp(rule.pathPattern);
  }
  for (const item of plan.notObservable ?? [])
    if (typeof item?.id !== "string" || typeof item.reason !== "string") throw new Error("Each not-observable question needs an id and reason.");
  for (const rule of plan.classifications ?? [])
    if (!DELTA_CLASSES.includes(rule.class) || (rule.class === "runtime-gap" && !rule.owner) || typeof rule.note !== "string")
      throw new Error("Each classification needs a known class, a note, and an owner for runtime gaps.");
  // A run validates its plan before any request: its denied routes guard every later request.
  rememberDeniedRoutes(plan.deniedRoutes ?? [], denied);
  return plan;
}

// ---------------------------------------------------------------------------
// Normalisation and redaction
// ---------------------------------------------------------------------------

const GUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const ISO_DATETIME = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/g;
const NUMERIC_DATE = /\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/g;
const LONG_DATE = /\b\d{1,2}(?:st|nd|rd|th)? (?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec) \d{4}\b/gi;
const TIME = /\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AP]M)?\b/gi;
const TOKENISH = /\b[A-Za-z0-9_\-+/]{40,}={0,2}/g;
const LONG_NUMBER = /\b\d{5,}\b/g;

/** Normalise volatile and data-shaped substrings so equal structure compares equal. */
export function normalizeText(value, { origins = [] } = {}) {
  let text = String(value ?? "").replace(/\s+/g, " ").trim();
  for (const origin of origins) if (origin) text = text.split(origin).join("@portal");
  return text
    .replace(TOKENISH, "{token}")
    .replace(GUID, "{guid}")
    .replace(EMAIL, "{email}")
    .replace(ISO_DATETIME, "{datetime}")
    .replace(ISO_DATE, "{date}")
    .replace(LONG_DATE, "{date}")
    .replace(NUMERIC_DATE, "{date}")
    .replace(TIME, "{time}")
    .replace(LONG_NUMBER, "{n}");
}

const URL_ATTRIBUTES = new Set(["href", "src", "action", "formaction", "data-url", "data-src", "poster", "xlink:href", "data-href", "srcset"]);
const SENSITIVE_NAME = /(?:password|token|secret|nonce|cookie|credential|authorization|viewstate|eventvalidation|requestverification|antiforgery)/i;

/** Origin-relative URL with GUID/number path segments generalised and query values removed. */
/** Paging parameters whose small integer values carry no record data (kept for paging evidence). */
const PAGING_PARAMS = new Set(["count", "page", "top", "$top", "pagesize", "pageSize"]);

export function redactUrl(value, { origins = [], base, keepPaging = false } = {}) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (/^(?:javascript|data|blob|mailto|tel):/i.test(raw)) return raw.split(":")[0].toLowerCase() + ":";
  if (raw.startsWith("#")) return "#" + normalizeText(raw.slice(1));
  let parsed;
  try {
    parsed = new URL(raw, base ?? origins[0] ?? "https://portal.invalid");
  } catch {
    return "{invalid-url}";
  }
  const sameOrigin = origins.includes(parsed.origin) || (!/^[a-z][a-z\d+.-]*:/i.test(raw) && !raw.startsWith("//"));
  const pathname = parsed.pathname
    .split("/")
    .map((segment) => {
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        /* keep encoded segment */
      }
      return decoded.replace(GUID, "{guid}").replace(/^\d{3,}$/, "{n}").replace(TOKENISH, "{token}");
    })
    .join("/")
    .replace(/\(\{guid\}\)/g, "({guid})");
  const names = [...new Set([...parsed.searchParams.keys()])].sort();
  const shown = (name) => {
    const valueOf = parsed.searchParams.get(name);
    return keepPaging && PAGING_PARAMS.has(name) && /^\d{1,6}$/.test(valueOf ?? "") ? valueOf : "…";
  };
  const query = names.length ? "?" + names.map((name) => `${name}=${shown(name)}`).join("&") : "";
  const fragment = parsed.hash ? "#" + normalizeText(parsed.hash.slice(1)) : "";
  return (sameOrigin ? "" : parsed.origin) + pathname + query + fragment;
}

/**
 * Live strings are saved only when they are source-derived (present in the exported portal
 * sources), equal to a local synthetic rendering, or trivially short. Everything else becomes a
 * shape plus an HMAC digest under a per-run key that is never written.
 */
export function createRedactor({ corpus = null, key = randomBytes(32), revealShort = 3 } = {}) {
  const local = new Set();
  const cache = new Map();
  const digest = (value) => createHmac("sha256", key).update(String(value)).digest("hex").slice(0, 12);
  const sourceDerived = (text) => {
    if (cache.has(text)) return cache.get(text);
    const result = Boolean(corpus && text.length >= 2 && corpus.has(text));
    cache.set(text, result);
    return result;
  };
  return {
    rememberLocal(text) {
      if (typeof text === "string" && text) local.add(text);
    },
    reveal(text) {
      const value = String(text ?? "");
      const safe = (part) => {
        const residue = part.replace(/\{(?:guid|date|datetime|time|n|email|token|value|redacted|data|long:\d+)\}/g, "");
        return !part || part.length <= revealShort || !/[A-Za-z0-9]/.test(residue) || local.has(part) || sourceDerived(part);
      };
      if (safe(value)) return value;
      // Composed strings (for example "Page title · Site") are revealed when every part is.
      const parts = value.split(/\s+[·|–-]\s+|,\s+/).map((part) => part.trim()).filter(Boolean);
      if (parts.length > 1 && parts.every(safe)) return value;
      return { redacted: true, length: value.length, words: value.split(/\s+/).filter(Boolean).length, digest: digest(value) };
    },
    digest,
    sourceDerived,
  };
}

/** Exported source text index used by the reveal policy. */
export async function loadSourceCorpus(sourceDir, { maxFileBytes = 4 * 1024 * 1024 } = {}) {
  const parts = [];
  async function walk(directory) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || [".git", "node_modules", ".paqvilo", ".portalconfig"].includes(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && /\.(?:html?|ya?ml|js|json|xml|txt|liquid)$/i.test(entry.name)) {
        const stat = await fs.stat(file);
        if (stat.size <= maxFileBytes) parts.push(await fs.readFile(file, "utf8"));
      }
    }
  }
  if (sourceDir) await walk(sourceDir);
  const decode = (text) =>
    text
      .replace(/&nbsp;|&#160;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">");
  const corpus = decode(parts.join("\n")).replace(/\s+/g, " ");
  const lower = corpus.toLowerCase();
  return {
    size: corpus.length,
    files: parts.length,
    has(text) {
      const needle = String(text).replace(/\s+/g, " ").trim();
      if (!needle) return false;
      return corpus.includes(needle) || lower.includes(needle.toLowerCase());
    },
  };
}

// ---------------------------------------------------------------------------
// Semantic DOM capture (runs in the page) and comparison (runs in Node)
// ---------------------------------------------------------------------------

/**
 * In-page snapshot. Raw values return to the runner's memory only; they are normalised and
 * redacted before anything is written. Must stay self-contained (serialised to the browser).
 */
export function semanticSnapshot(options) {
  const roots = options.roots?.length ? options.roots : ["body"];
  const exclude = options.exclude ?? [];
  const opaque = options.opaque ?? [];
  const data = options.dataSelectors ?? [];
  const maxNodes = options.maxNodes ?? 25000;
  const matches = (element, selectors) =>
    selectors.some((selector) => {
      try {
        return element.matches(selector);
      } catch {
        return false;
      }
    });
  const hash = (text) => {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  };
  const visible = (element) => {
    if (!element.getClientRects().length) return 0;
    const style = getComputedStyle(element);
    return style.visibility === "hidden" || style.display === "none" ? 0 : 1;
  };
  let count = 0;
  let truncated = false;
  const visit = (node, inData) => {
    if (node.nodeType === 3) {
      const text = node.textContent.replace(/\s+/g, " ").trim();
      return text ? (inData ? { t: text, d: 1 } : { t: text }) : null;
    }
    if (node.nodeType !== 1 || matches(node, exclude)) return null;
    if (++count > maxNodes) {
      truncated = true;
      return null;
    }
    const tag = node.tagName.toLowerCase();
    const attributes = {};
    for (const attribute of node.attributes) attributes[attribute.name] = attribute.value;
    const out = { g: tag, a: attributes, v: visible(node) };
    const dataRegion = inData || matches(node, data);
    if (dataRegion) out.d = 1;
    if (["input", "select", "textarea"].includes(tag))
      out.p = { value: String(node.value ?? ""), checked: node.checked === true, disabled: node.disabled === true };
    if (matches(node, opaque)) {
      // Canonical form: tag, sorted attributes without inline style, normalised text, children.
      const canonical = (element) =>
        element.nodeType === 3
          ? element.textContent.replace(/\s+/g, " ").trim()
          : element.nodeType !== 1
            ? ""
            : `<${element.tagName.toLowerCase()}${[...element.attributes].filter((attribute) => attribute.name !== "style").map((attribute) => ` ${attribute.name}="${attribute.value}"`).sort().join("")}>${[...element.childNodes].map(canonical).join("")}`;
      out.o = hash(canonical(node));
      out.n = node.querySelectorAll("*").length;
      return out;
    }
    const children = [];
    for (const child of node.childNodes) {
      const value = visit(child, dataRegion);
      if (value) children.push(value);
    }
    if (node.shadowRoot) out.s = 1;
    if (children.length) out.c = children;
    return out;
  };
  const result = [];
  for (const selector of roots) {
    let nodes = [];
    try {
      nodes = [...document.querySelectorAll(selector)];
    } catch {
      nodes = [];
    }
    result.push({ selector, count: nodes.length, nodes: nodes.map((node) => visit(node, false)).filter(Boolean) });
  }
  // Power Pages names the signed-in contact in its client object on every page; anonymous visitors
  // get an empty contactId. null when the object is absent (not a Power Pages page).
  let portalUser = null;
  try {
    const user = window.Microsoft && window.Microsoft.Dynamic365 && window.Microsoft.Dynamic365.Portal && window.Microsoft.Dynamic365.Portal.User;
    if (user && typeof user === "object") portalUser = Boolean(user.contactId);
  } catch {
    portalUser = null;
  }
  const signInSignals = {
    passwordInputs: [...document.querySelectorAll("input[type=password]")].filter((input) => input.getClientRects().length).length,
    portalUser,
  };
  return {
    path: location.pathname,
    title: document.title,
    lang: document.documentElement.lang || null,
    roots: result,
    truncated,
    nodeCount: count,
    panel: Boolean(document.getElementById("paqvilo-panel")),
    signInSignals,
  };
}

const DEFAULT_EXCLUDE = Object.freeze([
  "script",
  "style",
  "link",
  "meta",
  "noscript",
  "template",
  "#paqvilo-panel",
  "[data-paqvilo-mirage-runtime]",
]);
const DEFAULT_OPAQUE = Object.freeze(["svg"]);
const IGNORED_ATTRIBUTES = new Set(["style", "nonce", "data-sim-trace", "data-paqvilo-mirage-runtime"]);

function attributeValue(name, value, element, origins) {
  if (URL_ATTRIBUTES.has(name)) return withoutContentHash(redactUrl(platformAsset(value), { origins }));
  if (name === "class") return undefined;
  const elementName = `${element.a?.name ?? ""} ${element.a?.id ?? ""}`;
  if (name === "value") {
    const type = String(element.a?.type ?? "").toLowerCase();
    if (SENSITIVE_NAME.test(elementName)) return value ? "{redacted}" : "";
    if (["submit", "button", "reset"].includes(type)) return normalizeText(value, { origins });
    return value ? "{value}" : "";
  }
  if (SENSITIVE_NAME.test(name)) return "{redacted}";
  const normalized = normalizeText(value, { origins });
  return normalized.length > 160 ? `{long:${Math.round(normalized.length / 50) * 50}}` : normalized;
}

/** Convert an in-page snapshot node into a normalised comparison tree (raw text kept in memory). */
export function prepareTree(node, options = {}) {
  const { origins = [], ignoreClasses = [], ignoreAttributes = [] } = options;
  const ignoredClass = ignoreClasses.map((pattern) => new RegExp(pattern));
  const ignoredAttribute = new Set([...IGNORED_ATTRIBUTES, ...ignoreAttributes]);
  const convert = (raw) => {
    if (raw.t !== undefined) {
      const text = raw.d ? "{data}" : normalizeText(raw.t, { origins });
      return { text, raw: raw.d ? null : raw.t, data: raw.d === 1 };
    }
    const classes = [...new Set(String(raw.a?.class ?? "").split(/\s+/).filter(Boolean))]
      .filter((name) => !ignoredClass.some((pattern) => pattern.test(name)))
      .map((name) => normalizeText(name))
      .sort();
    const attrs = {};
    for (const [name, value] of Object.entries(raw.a ?? {})) {
      if (ignoredAttribute.has(name) || name === "class" || name.startsWith("data-sim-") || name.startsWith("data-paqvilo-mirage")) continue;
      if (raw.d && !["id", "role", "type", "name"].includes(name) && !URL_ATTRIBUTES.has(name)) {
        attrs[name] = value ? "{data}" : "";
        continue;
      }
      attrs[name] = attributeValue(name, value, raw, origins);
    }
    const node = { tag: raw.g, id: attrs.id ?? null, classes, attrs, visible: raw.v === 1 };
    if (raw.d) node.data = true;
    if (raw.p) node.state = { checked: raw.p.checked, disabled: raw.p.disabled, hasValue: Boolean(raw.p.value) };
    if (raw.o) {
      node.opaque = raw.o;
      node.opaqueCount = raw.n;
    }
    const kids = (raw.c ?? []).map(convert);
    node.kids = collapseRepeats(kids);
    return node;
  };
  return convert(node);
}

const shapeOf = (node) => {
  if (node.text !== undefined) return "#text";
  return `${node.tag}#${node.id ?? ""}.${node.classes.join(".")}[${Object.keys(node.attrs).sort().join(",")}](${node.kids.map(shapeOf).join("|")})`;
};

/** Collapse consecutive siblings with identical structure (data rows) into one template with a count. */
export function collapseRepeats(kids) {
  const output = [];
  for (const kid of kids) {
    const previous = output[output.length - 1];
    if (previous && kid.text === undefined && previous.text === undefined && shapeOf(previous) === shapeOf(kid)) {
      previous.repeat = (previous.repeat ?? 1) + 1;
      continue;
    }
    output.push(kid);
  }
  return output;
}

const signatureOf = (node) => (node.text !== undefined ? "#text" : `${node.tag}#${node.id ?? ""}`);
const labelOf = (node) => {
  if (node.text !== undefined) return "#text";
  return node.tag + (node.id ? `#${node.id}` : "") + (node.classes.length ? "." + node.classes.slice(0, 3).join(".") : "");
};
const sizeOf = (node) => (node.text !== undefined ? 1 : 1 + node.kids.reduce((sum, kid) => sum + sizeOf(kid), 0));

function align(a, b, same) {
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) {
    // Bounded fallback: greedy pairing in order.
    const pairs = [];
    let j = 0;
    for (let i = 0; i < n; i++) {
      let k = j;
      while (k < m && !same(a[i], b[k])) k++;
      if (k < m) {
        pairs.push([i, k]);
        j = k + 1;
      }
    }
    return pairs;
  }
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      table[i][j] = same(a[i], b[j]) ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (same(a[i], b[j])) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

/** Structural deltas between a live (reference) tree and a local tree. */
export function compareTrees(live, local, { maxDeltas = 250, ignoreText = false } = {}) {
  const deltas = [];
  let total = 0;
  const push = (delta) => {
    total++;
    if (deltas.length < maxDeltas) deltas.push(delta);
  };
  const walk = (a, b, where) => {
    if (a.text !== undefined || b.text !== undefined) {
      if (a.text === undefined || b.text === undefined) {
        push({ kind: "node-type", path: where });
        return;
      }
      if (!ignoreText && a.text !== b.text && !(a.data && b.data))
        push({ kind: "text", path: where, live: a.text, local: b.text, liveRaw: a.raw, localRaw: b.raw });
      return;
    }
    if (a.tag !== b.tag) {
      push({ kind: "tag", path: where, live: a.tag, local: b.tag });
      return;
    }
    if (a.visible !== b.visible) push({ kind: "visibility", path: where, live: a.visible, local: b.visible });
    const liveClasses = new Set(a.classes);
    const localClasses = new Set(b.classes);
    const missingClasses = a.classes.filter((name) => !localClasses.has(name));
    const extraClasses = b.classes.filter((name) => !liveClasses.has(name));
    if (missingClasses.length || extraClasses.length)
      push({ kind: "class", path: where, missing: missingClasses, extra: extraClasses });
    for (const name of new Set([...Object.keys(a.attrs), ...Object.keys(b.attrs)])) {
      if (!(name in b.attrs)) push({ kind: "attribute-missing", path: where, attribute: name, live: a.attrs[name] });
      else if (!(name in a.attrs)) push({ kind: "attribute-extra", path: where, attribute: name, local: b.attrs[name] });
      else if (a.attrs[name] !== b.attrs[name] && !(a.data && b.data && a.attrs[name] === "{data}"))
        push({ kind: "attribute-value", path: where, attribute: name, live: a.attrs[name], local: b.attrs[name] });
    }
    if (a.state && b.state && JSON.stringify(a.state) !== JSON.stringify(b.state))
      push({ kind: "control-state", path: where, live: a.state, local: b.state });
    if (a.opaque !== undefined || b.opaque !== undefined) {
      if (a.opaque !== b.opaque) push({ kind: "opaque", path: where, live: a.opaqueCount, local: b.opaqueCount });
      return;
    }
    if ((a.repeat ?? 1) !== (b.repeat ?? 1))
      push({ kind: "repeat-count", path: where, live: a.repeat ?? 1, local: b.repeat ?? 1 });
    const pairs = align(a.kids, b.kids, (x, y) => signatureOf(x) === signatureOf(y));
    let i = 0;
    let j = 0;
    const index = new Map();
    const childPath = (node) => {
      const label = labelOf(node);
      const n = (index.get(label) ?? 0) + 1;
      index.set(label, n);
      return `${where}>${label}${n > 1 ? `[${n}]` : ""}`;
    };
    for (const [x, y] of [...pairs, [a.kids.length, b.kids.length]]) {
      for (; i < x; i++) {
        const node = a.kids[i];
        push({ kind: "missing", path: childPath(node), live: labelOf(node), size: sizeOf(node), text: node.text, raw: node.raw });
      }
      for (; j < y; j++) {
        const node = b.kids[j];
        push({ kind: "extra", path: `${where}>${labelOf(node)}(local)`, local: labelOf(node), size: sizeOf(node), text: node.text, raw: node.raw });
      }
      if (x < a.kids.length && y < b.kids.length) {
        walk(a.kids[x], b.kids[y], childPath(a.kids[x]));
        i = x + 1;
        j = y + 1;
      }
    }
  };
  walk(live, local, labelOf(live));
  return { deltas, total, truncated: total > deltas.length };
}

/** Readable text lines from a prepared tree (visible nodes only), used by page-text scenarios. */
export function treeText(node, lines = [], visibleAncestor = true) {
  if (node.text !== undefined) {
    if (visibleAncestor && node.text) lines.push({ text: node.text, raw: node.raw, data: node.data });
    return lines;
  }
  const visible = visibleAncestor && node.visible;
  for (const kid of node.kids) treeText(kid, lines, visible);
  return lines;
}

/** Line-level text deltas (order-preserving alignment). */
export function compareTextLines(liveLines, localLines, { maxDeltas = 250 } = {}) {
  const pairs = align(liveLines, localLines, (a, b) => a.text === b.text);
  const deltas = [];
  let total = 0;
  let i = 0;
  let j = 0;
  for (const [x, y] of [...pairs, [liveLines.length, localLines.length]]) {
    for (; i < x; i++) {
      total++;
      if (deltas.length < maxDeltas) deltas.push({ kind: "text-missing", path: `line ${i + 1}`, text: liveLines[i].text, raw: liveLines[i].raw });
    }
    for (; j < y; j++) {
      total++;
      if (deltas.length < maxDeltas) deltas.push({ kind: "text-extra", path: `local line ${j + 1}`, text: localLines[j].text, raw: localLines[j].raw, localSide: true });
    }
    i = x + 1;
    j = y + 1;
  }
  return { deltas, total, truncated: total > deltas.length };
}

// ---------------------------------------------------------------------------
// Web API projections
// ---------------------------------------------------------------------------

const valueType = (value) => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "string") {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return "guid";
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return "datetime";
    return "string";
  }
  if (typeof value === "object") return "object{" + Object.keys(value).filter((key) => !key.includes("@")).sort().join(",") + "}";
  return typeof value;
};

/** A continuation link reduced to its portal-relative shape (host and query values removed). */
function relativeLink(link) {
  try {
    const url = new URL(link, "https://portal.invalid");
    return redactUrl(url.pathname + url.search);
  } catch {
    return "{invalid-url}";
  }
}

/** Field/annotation/type/count/paging projection; never retains business values. */
export function projectJson(text, { collection = "value", compareValues = [], referenceData = false, maxValueRows = 6000 } = {}) {
  let body;
  try {
    body = typeof text === "string" ? JSON.parse(text) : text;
  } catch {
    return { kind: "not-json", length: String(text ?? "").length };
  }
  if (body && typeof body === "object" && body.error && typeof body.error === "object") {
    return {
      kind: "error",
      keys: Object.keys(body).sort(),
      error: {
        keys: Object.keys(body.error).sort(),
        code: typeof body.error.code === "string" || typeof body.error.code === "number" ? String(body.error.code) : null,
        // Power Pages Web API errors carry eight-digit hexadecimal codes such as 90040120.
        codeShape: /^[0-9a-f]{8}$/i.test(String(body.error.code ?? "")) ? "hex8" : typeof body.error.code === "string" ? (body.error.code ? "text" : "empty") : typeof body.error.code,
        message: typeof body.error.message === "string" ? body.error.message : null,
        innerKeys: body.error.innererror && typeof body.error.innererror === "object" ? Object.keys(body.error.innererror).sort() : null,
      },
    };
  }
  const rows = Array.isArray(body?.[collection]) ? body[collection] : null;
  const top = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const projection = {
    kind: rows ? "collection" : "object",
    topKeys: Object.keys(top).filter((key) => key !== collection).sort(),
    count: rows ? rows.length : null,
    odataCount: typeof top["@odata.count"] === "number" ? top["@odata.count"] : null,
    totalRecordCount: typeof top["@Microsoft.Dynamics.CRM.totalrecordcount"] === "number" ? top["@Microsoft.Dynamics.CRM.totalrecordcount"] : null,
    totalRecordCountLimitExceeded: top["@Microsoft.Dynamics.CRM.totalrecordcountlimitexceeded"] ?? null,
    moreRecords: top["@Microsoft.Dynamics.CRM.morerecords"] ?? null,
    pagingCookie: typeof top["@Microsoft.Dynamics.CRM.fetchxmlpagingcookie"] === "string",
    nextLink: typeof top["@odata.nextLink"] === "string" ? relativeLink(top["@odata.nextLink"]) : null,
    context: typeof top["@odata.context"] === "string" ? top["@odata.context"].replace(/^https?:\/\/[^/]+/i, "@portal") : null,
    fields: {},
    annotations: {},
  };
  const subject = rows ?? [top];
  for (const row of subject) {
    if (!row || typeof row !== "object") continue;
    for (const [key, value] of Object.entries(row)) {
      if (!rows && key.startsWith("@")) continue;
      if (key.includes("@")) {
        const [field, annotation] = [key.slice(0, key.indexOf("@")), key.slice(key.indexOf("@") + 1)];
        (projection.annotations[field || "(row)"] ??= new Set()).add(annotation);
        continue;
      }
      (projection.fields[key] ??= new Set()).add(valueType(value));
    }
  }
  projection.fields = Object.fromEntries(Object.entries(projection.fields).sort().map(([key, types]) => [key, [...types].sort()]));
  // Liquid JSON endpoints return objects with row arrays (for example changeRequests); record lengths only.
  if (!rows) {
    const arrays = Object.fromEntries(Object.entries(top).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, value.length]));
    if (Object.keys(arrays).length) projection.arrays = arrays;
  }
  projection.annotations = Object.fromEntries(Object.entries(projection.annotations).sort().map(([key, set]) => [key, [...set].sort()]));
  if (rows && (compareValues.length || referenceData)) {
    const fields = compareValues.length ? compareValues : Object.keys(projection.fields);
    projection.values = rows.slice(0, maxValueRows).map((row) => Object.fromEntries(fields.map((field) => [field, row?.[field] ?? null])));
  }
  return projection;
}

/** Compare two projections; returns deltas. Values only for explicitly reference-data scenarios. */
export function compareJson(live, local, { compareCount = false, compareValues = false, unordered = false, ignoreTopKeys = [] } = {}) {
  const deltas = [];
  if (live.kind !== local.kind) {
    deltas.push({ kind: "json-kind", live: live.kind, local: local.kind });
    return deltas;
  }
  if (live.kind === "error") {
    if (JSON.stringify(live.keys) !== JSON.stringify(local.keys)) deltas.push({ kind: "error-keys", live: live.keys, local: local.keys });
    if (JSON.stringify(live.error.keys) !== JSON.stringify(local.error.keys)) deltas.push({ kind: "error-body-keys", live: live.error.keys, local: local.error.keys });
    if (live.error.codeShape !== local.error.codeShape) deltas.push({ kind: "error-code-shape", live: live.error.codeShape, local: local.error.codeShape });
    else if (live.error.code !== local.error.code) deltas.push({ kind: "error-code", live: live.error.code, local: local.error.code });
    if (JSON.stringify(live.error.innerKeys) !== JSON.stringify(local.error.innerKeys)) deltas.push({ kind: "error-innererror", live: live.error.innerKeys, local: local.error.innerKeys });
    return deltas;
  }
  // "not-json" and "unavailable" bodies have no shape to compare beyond their kind.
  if (!["collection", "object"].includes(live.kind)) return deltas;
  const ignore = new Set(ignoreTopKeys);
  const liveTop = (live.topKeys ?? []).filter((key) => !ignore.has(key));
  const localTop = (local.topKeys ?? []).filter((key) => !ignore.has(key));
  for (const key of liveTop) if (!localTop.includes(key)) deltas.push({ kind: "top-key-missing", field: key });
  for (const key of localTop) if (!liveTop.includes(key)) deltas.push({ kind: "top-key-extra", field: key });
  if (Boolean(live.nextLink) !== Boolean(local.nextLink)) deltas.push({ kind: "next-link", live: live.nextLink, local: local.nextLink });
  else if (live.nextLink && local.nextLink) {
    const params = (link) => (link.split("?")[1] ?? "").split("&").filter(Boolean).sort().join("&");
    if (params(live.nextLink) !== params(local.nextLink)) deltas.push({ kind: "next-link-shape", live: live.nextLink, local: local.nextLink });
  }
  if (live.pagingCookie !== local.pagingCookie) deltas.push({ kind: "paging-cookie", live: live.pagingCookie, local: local.pagingCookie });
  if (live.moreRecords !== local.moreRecords) deltas.push({ kind: "more-records", live: live.moreRecords, local: local.moreRecords });
  if (compareCount) {
    if (live.count !== local.count) deltas.push({ kind: "count", live: live.count, local: local.count });
    if (live.odataCount !== local.odataCount) deltas.push({ kind: "odata-count", live: live.odataCount, local: local.odataCount });
    if (live.totalRecordCount !== local.totalRecordCount) deltas.push({ kind: "total-record-count", live: live.totalRecordCount, local: local.totalRecordCount });
  } else if ((live.count === 0) !== (local.count === 0)) deltas.push({ kind: "emptiness", live: live.count, local: local.count, dataDependent: true });
  const comparable = live.count !== 0 && local.count !== 0;
  if (comparable) {
    for (const [field, types] of Object.entries(live.fields)) {
      if (!(field in local.fields)) deltas.push({ kind: "field-missing", field, live: types });
      else {
        const liveTypes = types.filter((type) => type !== "null");
        const localTypes = local.fields[field].filter((type) => type !== "null");
        if (liveTypes.length && localTypes.length && JSON.stringify(liveTypes) !== JSON.stringify(localTypes))
          deltas.push({ kind: "field-type", field, live: types, local: local.fields[field] });
      }
    }
    for (const field of Object.keys(local.fields)) if (!(field in live.fields)) deltas.push({ kind: "field-extra", field, local: local.fields[field] });
    for (const field of new Set([...Object.keys(live.annotations), ...Object.keys(local.annotations)])) {
      const a = live.annotations[field] ?? [];
      const b = local.annotations[field] ?? [];
      const missing = a.filter((name) => !b.includes(name));
      const extra = b.filter((name) => !a.includes(name));
      if (missing.length || extra.length) deltas.push({ kind: "annotations", field, missing, extra });
    }
  }
  if (compareValues && live.values && local.values) {
    const key = (row) => JSON.stringify(row);
    const a = unordered ? [...live.values].map(key).sort() : live.values.map(key);
    const b = unordered ? [...local.values].map(key).sort() : local.values.map(key);
    if (a.length !== b.length || a.some((value, index) => value !== b[index])) {
      const liveSet = new Set(a);
      const localSet = new Set(b);
      const missing = a.filter((value) => !localSet.has(value));
      const extra = b.filter((value) => !liveSet.has(value));
      deltas.push({
        kind: missing.length || extra.length ? "values" : "value-order",
        missing: missing.slice(0, 20).map((value) => JSON.parse(value)),
        extra: extra.slice(0, 20).map((value) => JSON.parse(value)),
        missingCount: missing.length,
        extraCount: extra.length,
      });
    }
  }
  return deltas;
}

// ---------------------------------------------------------------------------
// HTTP shapes: redirects, headers, Liquid probes, persona derivation
// ---------------------------------------------------------------------------

/** Redirect target shape. ReturnUrl is reduced to its normalised path (it echoes the request). */
export function classifyLocation(location, { origin } = {}) {
  if (!location) return { kind: "none" };
  let target;
  try {
    target = new URL(location, origin ?? "https://portal.invalid");
  } catch {
    return { kind: "invalid" };
  }
  const external = origin && target.origin !== new URL(origin).origin;
  const params = [...new Set([...target.searchParams.keys()])].sort();
  const returnKey = params.find((name) => /^returnurl$/i.test(name));
  let returnPath = null;
  let returnQueryNames = null;
  let returnUrlEncoded = null;
  if (returnKey) {
    try {
      const inner = new URL(target.searchParams.get(returnKey), "https://portal.invalid");
      returnPath = inner.pathname.replace(GUID, "{guid}");
      returnQueryNames = [...new Set([...inner.searchParams.keys()])].sort();
    } catch {
      returnPath = "{invalid}";
    }
    // The raw encoding echoes only the requested path; query values inside it are generalised.
    const raw = /[?&]returnurl=([^&#]*)/i.exec(String(location))?.[1] ?? "";
    returnUrlEncoded = raw.replace(/(%3[dD])[^%&]*/g, "$1…").replace(GUID, "{guid}");
  }
  const escapes = String(location).match(/%[0-9a-f]{2}/gi) ?? [];
  const hexCase = !escapes.length ? "none" : escapes.every((item) => item === item.toUpperCase()) ? "upper" : escapes.every((item) => item === item.toLowerCase()) ? "lower" : "mixed";
  return {
    kind: external ? "external" : "same-origin",
    host: external ? target.host : null,
    absolute: /^[a-z][a-z\d+.-]*:\/\//i.test(String(location)),
    path: target.pathname.replace(GUID, "{guid}"),
    signIn: /\/(?:[a-z]{2}-[a-z]{2}\/)?(?:signin|sign-in|login|account\/login)/i.test(target.pathname) || /login\.microsoftonline|b2clogin|\/oauth2\//i.test(target.href),
    languagePrefix: /^\/[a-z]{2}-[a-z]{2}\//i.test(target.pathname) ? target.pathname.slice(1, 6) : null,
    params,
    returnKey: returnKey ?? null,
    returnPath,
    returnQueryNames,
    returnUrlEncoded,
    hexCase,
  };
}

/** Character-class mask of a rendered value (digits 9, letters A/a): formats without values. */
export function formatMask(value) {
  return String(value ?? "")
    .replace(/[0-9]/g, "9")
    .replace(/[A-Z]/g, "A")
    .replace(/[a-z]/g, "a")
    .replace(/a{2,}/g, (match) => `a{${match.length}}`)
    .replace(/A{2,}/g, (match) => `A{${match.length}}`)
    .slice(0, 160);
}

/** Case of the hexadecimal letters in a rendered identifier ("no-letters" when only digits occur). */
export function letterCase(value) {
  const letters = String(value ?? "").replace(/[^a-f]/gi, "");
  if (!letters) return "no-letters";
  return letters === letters.toLowerCase() ? "lower" : letters === letters.toUpperCase() ? "upper" : "mixed";
}

/** Element shape: tag, sorted class tokens and sorted attribute names; attribute values are dropped. */
export function tagShape(markup) {
  const match = /^\s*<([a-z][\w:-]*)\b([^>]*)>/i.exec(String(markup ?? ""));
  if (!match) return null;
  const attributes = [...match[2].matchAll(/([\w:-]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g)];
  const classes = [];
  const names = [];
  for (const [, name, quoted] of attributes) {
    if (name.toLowerCase() === "class") classes.push(...String(quoted ?? "").replace(/^["']|["']$/g, "").split(/\s+/).filter(Boolean));
    else names.push(name.toLowerCase());
  }
  return `${match[1].toLowerCase()}${classes.sort().map((name) => `.${name}`).join("")}${names.sort().map((name) => `[${name}]`).join("")}`;
}

/** ETag shape (quoted, weak, length, alphabet) without its value. */
export function etagShape(value) {
  if (!value) return null;
  const text = String(value);
  const weak = text.startsWith("W/");
  const core = weak ? text.slice(2) : text;
  const quoted = core.startsWith('"') && core.endsWith('"');
  const inner = quoted ? core.slice(1, -1) : core;
  return { weak, quoted, length: inner.length, alphabet: /^(?:0x)?[0-9a-f]+$/i.test(inner) ? "hex" : /^[A-Za-z0-9+/=]+$/.test(inner) ? "base64" : "other" };
}

/** Header projection: directive/token sets, never cookies. */
export function projectHeaders(headers = {}, names = ["content-type", "cache-control", "x-frame-options", "content-security-policy"]) {
  const lower = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  const result = {};
  for (const name of names) {
    const value = lower[name];
    if (name === "set-cookie" || value === undefined || value === null) {
      result[name] = null;
      continue;
    }
    if (name === "content-type") result[name] = String(value).toLowerCase().replace(/\s*;\s*/g, ";");
    else if (name === "cache-control") result[name] = String(value).toLowerCase().split(",").map((item) => item.trim()).filter(Boolean).sort();
    else if (name === "content-security-policy")
      result[name] = Object.fromEntries(
        String(value)
          .split(";")
          .map((directive) => directive.trim())
          .filter(Boolean)
          .map((directive) => {
            const [key, ...sources] = directive.split(/\s+/);
            return [key.toLowerCase(), sources.map((source) => source.replace(/'nonce-[^']+'/i, "'nonce-{redacted}'")).sort()];
          })
          .sort(([a], [b]) => a.localeCompare(b)),
      );
    else result[name] = String(value).trim();
  }
  return result;
}

export function compareHeaders(live, local) {
  const deltas = [];
  for (const name of new Set([...Object.keys(live), ...Object.keys(local)])) {
    const a = live[name];
    const b = local[name];
    if (name === "content-security-policy" && a && b) {
      for (const directive of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (!(directive in b)) deltas.push({ kind: "csp-directive-missing", field: directive, live: a[directive] });
        else if (!(directive in a)) deltas.push({ kind: "csp-directive-extra", field: directive, local: b[directive] });
        else if (JSON.stringify(a[directive]) !== JSON.stringify(b[directive]))
          deltas.push({ kind: "csp-sources", field: directive, live: a[directive], local: b[directive] });
      }
      continue;
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) deltas.push({ kind: "header", field: name, live: a, local: b });
  }
  return deltas;
}

/** Classify a captured Liquid output literal (e.g. the result of `| json`). */
export function classifyLiteral(token) {
  if (token === null || token === undefined) return { classification: "absent" };
  const trimmed = String(token).trim();
  if (!trimmed) return { classification: "empty" };
  let parsed;
  let valid = false;
  try {
    parsed = JSON.parse(trimmed);
    valid = true;
  } catch {
    /* not JSON */
  }
  if (valid) {
    const type = parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed;
    return { classification: `json-${type}`, jsonValid: true, length: trimmed.length, quoted: trimmed.startsWith('"') };
  }
  if (/^(?:True|False)$/.test(trimmed)) return { classification: "dotnet-boolean", jsonValid: false, length: trimmed.length };
  return { classification: "raw-text", jsonValid: false, length: trimmed.length };
}

const decodeEntities = (value) =>
  String(value)
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&");

/** Extract a probe value from raw HTML/text. */
export function extractProbe(text, probe) {
  const pattern = new RegExp(probe.regex, probe.flags ?? "");
  const match = pattern.exec(String(text ?? ""));
  if (!match) return { found: false };
  const value = match[probe.group ?? 1] ?? match[0];
  let output = probe.decode === false ? value : decodeEntities(value);
  for (const name of probe.redactAttributes ?? []) {
    if (!/^[\w:-]+$/.test(name)) throw new Error("Probe attribute names must be plain identifiers.");
    output = output.replace(new RegExp(`(\\s${name}\\s*=\\s*)("[^"]*"|'[^']*')`, "gi"), (match, prefix, quoted) => `${prefix}"${quoted.length > 2 ? "{redacted}" : ""}"`);
  }
  return { found: true, value: output };
}

/** Exact segmentation of a concatenated `{{ user.roles }}` rendering into exported role names. */
export function segmentRoles(value, roleNames) {
  const text = String(value ?? "");
  const names = [...new Set(roleNames.filter(Boolean))];
  const best = new Array(text.length + 1).fill(null);
  best[0] = [];
  for (let i = 0; i < text.length; i++) {
    if (!best[i]) continue;
    for (const name of names)
      if (text.startsWith(name, i) && (!best[i + name.length] || best[i + name.length].length > best[i].length + 1))
        best[i + name.length] = [...best[i], name];
  }
  return best[text.length];
}

/** Check derived roles against page-access observations: accessible iff a granting role is held. */
export function checkPersonaAccess(roles, observations) {
  const held = new Set(roles);
  return observations.map((observation) => {
    const expected = observation.rolesAny.some((role) => held.has(role));
    return { path: observation.path, accessible: observation.accessible, expected, consistent: expected === observation.accessible };
  });
}

// ---------------------------------------------------------------------------
// Delta classification
// ---------------------------------------------------------------------------

const ruleText = (pattern, value) => {
  if (pattern === undefined) return true;
  if (value === undefined || value === null) return false;
  // "/source/flags" is a regular expression; any other string (including paths) is a substring.
  if (typeof pattern === "string" && /^\/.+\/[dgimsuy]*$/.test(pattern) && !/^\/[\w.-]+\/[\w.-]+$/.test(pattern)) {
    const end = pattern.lastIndexOf("/");
    return new RegExp(pattern.slice(1, end), pattern.slice(end + 1)).test(String(value));
  }
  return String(value).includes(pattern);
};

/** First matching rule wins. A rule matches when every supplied criterion matches. */
export function classifyDelta(delta, scenarioId, rules = []) {
  for (const rule of rules) {
    if (
      ruleText(rule.scenario, scenarioId) &&
      ruleText(rule.kind, delta.kind) &&
      ruleText(rule.path, delta.path) &&
      ruleText(rule.attribute, delta.attribute) &&
      ruleText(rule.field, delta.field) &&
      ruleText(rule.text, typeof delta.text === "string" ? delta.text : undefined) &&
      (rule.dataDependent === undefined || Boolean(delta.dataDependent) === rule.dataDependent)
    )
      return { class: rule.class, owner: rule.owner ?? null, note: rule.note, rule: rule.id ?? null };
  }
  return { class: "unclassified", owner: null, note: "No classification rule matched this delta." };
}

// ---------------------------------------------------------------------------
// Report serialisation (redaction boundary)
// ---------------------------------------------------------------------------

/** Delta kinds whose live value is free page/probe text and therefore passes the reveal policy. */
const FREE_TEXT_DELTAS = new Set(["text", "attribute-value", "attribute-missing", "probe-text", "body-title"]);

function redactDelta(delta, redactor) {
  const out = { kind: delta.kind };
  for (const key of ["path", "attribute", "field", "size", "missingCount", "extraCount", "dataDependent"]) if (delta[key] !== undefined) out[key] = delta[key];
  if (delta.missing !== undefined) out.missing = delta.missing;
  if (delta.extra !== undefined) out.extra = delta.extra;
  if (FREE_TEXT_DELTAS.has(delta.kind)) {
    if (delta.local !== undefined) {
      out.local = delta.local;
      if (typeof delta.local === "string") redactor.rememberLocal(delta.local);
    }
    if (delta.live !== undefined) out.live = typeof delta.live === "string" ? redactor.reveal(delta.live) : delta.live;
  } else if (delta.kind === "missing" || delta.kind === "text-missing") {
    out.live = delta.live;
    if (delta.text !== undefined) out.text = redactor.reveal(delta.text);
  } else if (delta.kind === "extra" || delta.kind === "text-extra") {
    out.local = delta.local;
    if (delta.text !== undefined) out.text = delta.text;
  } else {
    // Structured values (statuses, codes, redirect shapes, header tokens, counts, reference rows
    // selected explicitly by the plan) are computed by the runner and carry no page text.
    if (delta.live !== undefined) out.live = delta.live;
    if (delta.local !== undefined) out.local = delta.local;
  }
  return out;
}

/** Redacted tree for saved artifacts. Live text that is not source-derived becomes a digest. */
export function redactTree(node, redactor, side) {
  if (node.text !== undefined) return { text: side === "live" ? redactor.reveal(node.text) : node.text, ...(node.data ? { data: true } : {}) };
  const attrs = {};
  for (const [name, value] of Object.entries(node.attrs))
    attrs[name] = side === "live" && typeof value === "string" && !URL_ATTRIBUTES.has(name) ? redactor.reveal(value) : value;
  const out = { tag: node.tag, classes: node.classes, attrs, visible: node.visible };
  if (node.data) out.data = true;
  if (node.repeat) out.repeat = node.repeat;
  if (node.state) out.state = node.state;
  if (node.opaque !== undefined) {
    out.opaque = node.opaque;
    out.opaqueCount = node.opaqueCount;
  }
  if (node.kids.length) out.kids = node.kids.map((kid) => redactTree(kid, redactor, side));
  return out;
}

function rememberLocalTree(node, redactor) {
  if (node.text !== undefined) {
    redactor.rememberLocal(node.text);
    return;
  }
  for (const value of Object.values(node.attrs)) if (typeof value === "string") redactor.rememberLocal(value);
  for (const kid of node.kids) rememberLocalTree(kid, redactor);
}

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

const LOADING_SELECTORS = [".overlay:not([style*='display: none'])", ".overlayUI", ".dataTables_processing", "[role=progressbar]", ".form-loading", ".loader"];
/** Same-origin platform paths inventoried from page traffic (question G-D13). */
export const PLATFORM_PREFIXES = Object.freeze(["/_api/", "/_services/", "/_layout/", "/_portal/", "/_resources/", "/_odata/", "/_webresource", "/WebResource.axd", "/ScriptResource.axd"]);

/**
 * Decide what happens to a request observed in a comparison page: GET and HEAD continue, a plan's
 * fulfilment rules are answered locally without reaching any server, everything else is blocked
 * (SAFE_REFERENCE_REQUESTS is empty).
 */
export function requestDecision(method, url, { fulfil = [], origins = [] } = {}) {
  const verb = String(method || "").toUpperCase();
  if (verb === "GET" || verb === "HEAD") return { action: "continue" };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { action: "block", reason: "invalid-url" };
  }
  for (const rule of fulfil) {
    if (
      String(rule.method).toUpperCase() === verb &&
      (!origins.length || origins.includes(parsed.origin)) &&
      new RegExp(rule.pathPattern).test(parsed.pathname) &&
      Number.isInteger(rule.status) &&
      rule.status >= 200 &&
      rule.status < 300
    )
      return { action: "fulfil", status: rule.status, rule: rule.pathPattern };
  }
  const allowed = isAllowedRequest(verb, url, { origins });
  return allowed.allowed ? { action: "continue", allowListed: allowed.allowListed } : { action: "block", reason: allowed.reason };
}

/** Page-side fetch used by the attached-browser driver. The token stays inside the page. */
function pageFetch(options) {
  return (async () => {
    const headers = { accept: options.accept || "*/*" };
    if (options.prefer) headers.Prefer = options.prefer;
    if (options.token) {
      const tokenResponse = await fetch("/_layout/tokenhtml", { cache: "no-store", credentials: "same-origin" });
      const html = await tokenResponse.text();
      const input = new DOMParser().parseFromString(html, "text/html").querySelector('input[name="__RequestVerificationToken"]');
      if (input && input.value) headers.__RequestVerificationToken = input.value;
    }
    const started = performance.now();
    const response = await fetch(options.path, { method: "GET", headers, credentials: "same-origin", cache: "no-store", redirect: options.redirect || "manual" });
    const body = response.type === "opaqueredirect" ? "" : await response.text();
    const out = {};
    for (const [name, value] of response.headers) out[name.toLowerCase()] = value;
    let finalPath = null;
    try {
      finalPath = new URL(response.url).pathname;
    } catch {
      finalPath = null;
    }
    return { status: response.status, type: response.type, redirected: response.redirected, finalPath, headers: out, body, ms: Math.round(performance.now() - started) };
  })();
}

/**
 * In-page read-only guard (document-start script). Non-GET XHR, fetch and beacon calls never
 * reach the network: explicit fulfilment rules answer them with an empty 2xx, everything else
 * fails like a blocked request. Synchronous XHR GETs run natively (request interception can
 * stall pages that use them). Must stay self-contained (serialised into every frame).
 */
export function writeGuard({ origin, fulfil = [] }) {
  const report = (entry) => {
    try {
      window.__parityGuard?.(entry);
    } catch {
      /* the binding is unavailable in some frames */
    }
  };
  const decide = (method, url) => {
    const verb = String(method || "GET").toUpperCase();
    if (verb === "GET" || verb === "HEAD") return { action: "continue" };
    let parsed;
    try {
      parsed = new URL(url, location.href);
    } catch {
      return { action: "block" };
    }
    for (const rule of fulfil) if (rule.method === verb && parsed.origin === origin && new RegExp(rule.pathPattern).test(parsed.pathname)) return { action: "fulfil", status: rule.status };
    return { action: "block" };
  };
  const proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (proto && !proto.__parityGuarded) {
    const open = proto.open;
    const send = proto.send;
    proto.open = function (method, url, async, ...rest) {
      this.__parity = { method, url: String(url), async: async !== false };
      return open.call(this, method, url, async === undefined ? true : async, ...rest);
    };
    proto.send = function (...args) {
      const info = this.__parity;
      const decision = info ? decide(info.method, info.url) : { action: "continue" };
      if (decision.action === "continue") return send.apply(this, args);
      let absolute = info.url;
      try {
        absolute = new URL(info.url, location.href).href;
      } catch {
        /* keep the raw value */
      }
      report({ action: decision.action, method: info.method, url: absolute, status: decision.status });
      const xhr = this;
      const define = (name, value) => Object.defineProperty(xhr, name, { configurable: true, get: () => value });
      define("readyState", 4);
      define("status", decision.action === "fulfil" ? decision.status : 0);
      define("statusText", decision.action === "fulfil" ? "No Content" : "");
      define("responseText", "");
      define("response", "");
      const finish = () => {
        for (const type of ["readystatechange", decision.action === "fulfil" ? "load" : "error", "loadend"]) {
          try {
            xhr.dispatchEvent(new ProgressEvent(type));
          } catch {
            /* ignore listener failures */
          }
        }
      };
      if (info.async) setTimeout(finish, 0);
      else finish();
    };
    Object.defineProperty(proto, "__parityGuarded", { value: true });
  }
  if (window.fetch && !window.fetch.__parityGuarded) {
    const originalFetch = window.fetch;
    const guarded = function (input, init) {
      const method = (init && init.method) || (input && typeof input === "object" && "method" in input ? input.method : "GET");
      const url = input && typeof input === "object" && "url" in input ? input.url : String(input);
      const decision = decide(method, url);
      if (decision.action === "continue") return originalFetch.apply(this, arguments);
      report({ action: decision.action, method, url: new URL(url, location.href).href, status: decision.status });
      return decision.action === "fulfil" ? Promise.resolve(new Response(null, { status: decision.status })) : Promise.reject(new TypeError("Blocked by the parity read-only guard."));
    };
    guarded.__parityGuarded = true;
    window.fetch = guarded;
  }
  if (navigator.sendBeacon) {
    navigator.sendBeacon = function (url) {
      report({ action: "block", method: "POST", url: new URL(url, location.href).href });
      return false;
    };
  }
}

/** In-page counts for structural facts (form controls, grids, notes, editable regions). */
export function pageFacts(selectors) {
  const out = {};
  for (const selector of selectors) {
    try {
      const nodes = [...document.querySelectorAll(selector)];
      out[selector] = { total: nodes.length, visible: nodes.filter((node) => node.getClientRects().length).length };
    } catch {
      out[selector] = { invalid: true };
    }
  }
  return out;
}

/** Bound a page evaluation: a busy renderer must not stall the whole suite. */
export function within(promise, ms, label = "Page evaluation") {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`${label} did not finish within ${Math.round(ms / 1000)} s (renderer busy or blocked).`), { code: "PAGE_UNRESPONSIVE" })), ms);
    }),
  ]);
}

function waitForQuiet({ inflight, lastActivity, isLoading, quietMs = 1000, timeout = 20000 }) {
  return (async () => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const loading = await isLoading().catch(() => false);
      if (!loading && inflight() === 0 && Date.now() - lastActivity() >= quietMs) return { settled: true, ms: Date.now() - started };
      await sleep(150);
    }
    return { settled: false, ms: Date.now() - started };
  })();
}

const loadingProbe = `(() => { const sel = ${JSON.stringify(LOADING_SELECTORS)}; return sel.some(s => { try { return [...document.querySelectorAll(s)].some(e => e.getClientRects().length && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden'); } catch { return false; } }); })()`;

const headerMap = (headers) => Object.fromEntries(Object.entries(headers ?? {}).map(([name, value]) => [name.toLowerCase(), Array.isArray(value) ? value.join(", ") : String(value)]));
const isJsonType = (contentType) => /json/i.test(String(contentType ?? ""));

/** Passive record of one same-origin request the page made by itself. */
function networkRecord({ method, url, type, status, contentType, origins, headers }) {
  const lower = headerMap(headers ?? {});
  const kept = {};
  for (const name of ["preference-applied", "odata-version", "odata-entityid", "entityid"]) if (lower[name] !== undefined) kept[name] = name.includes("entityid") ? "{present}" : lower[name];
  return { method, url: redactUrl(url, { origins, keepPaging: true }), type, status, contentType: contentType ? String(contentType).split(";")[0].trim().toLowerCase() : null, ...(Object.keys(kept).length ? { headers: kept } : {}) };
}

/** Same-origin web-file path (no query) for the source-versus-deployment drift inventory. */
function assetPath(url, origin, set) {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== origin || set.size >= 200) return;
    if (/^\/(?:_|__sim|WebResource\.axd|ScriptResource\.axd)/i.test(parsed.pathname)) return;
    set.add(parsed.pathname);
  } catch {
    /* ignore malformed URLs */
  }
}

/** Compare deployed bytes with local source bytes; line-ending-only differences are reported separately. */
export function compareBytes(live, local) {
  const a = Buffer.isBuffer(live) ? live : Buffer.from(String(live ?? ""));
  const b = Buffer.isBuffer(local) ? local : Buffer.from(String(local ?? ""));
  if (a.equals(b)) return "identical";
  const normalize = (buffer) => buffer.toString("utf8").replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n+$/, "");
  return normalize(a) === normalize(b) ? "line-endings" : "different";
}

function trackedRequest(url, type, origin) {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== origin) return false;
    return ["XHR", "Fetch", "xhr", "fetch"].includes(type) || PLATFORM_PREFIXES.some((prefix) => parsed.pathname.startsWith(prefix));
  } catch {
    return false;
  }
}

/**
 * Shape of a blocked request body: its top-level JSON keys and the GUIDs it names (for example a
 * lookup view), never any other value. Reports pass the GUIDs through the reveal policy.
 */
export function bodyShape(postData) {
  if (typeof postData !== "string" || !postData) return undefined;
  const guids = [...new Set((postData.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? []).map((guid) => guid.toLowerCase()))].slice(0, 20);
  let keys = null;
  try {
    const parsed = JSON.parse(postData);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) keys = Object.keys(parsed).sort();
  } catch {
    keys = null;
  }
  return { keys, guids };
}

/**
 * Attached-browser driver over raw CDP. It creates and attaches only to its own tabs in the
 * browser's default context, so foreign tabs (including stalled ones) never block it.
 */
export async function openCdpTabDriver({ cdpUrl, origin, timeout = 45000, fulfil = [], viewport = { width: 1440, height: 1000 }, allowLoopbackReference = false, isolated = false }) {
  const endpoint = new URL(cdpUrl);
  if (!["http:", "ws:"].includes(endpoint.protocol) || !loopbackHost(endpoint.hostname) || endpoint.username || endpoint.password)
    throw new Error("The browser debugging endpoint must be loopback without credentials.");
  const reference = new URL(origin);
  // Loopback HTTP references exist only for synthetic regression fixtures.
  const testReference = allowLoopbackReference && reference.protocol === "http:" && loopbackHost(reference.hostname);
  if ((reference.protocol !== "https:" && !testReference) || reference.pathname !== "/" || reference.search || reference.username)
    throw new Error("The reference origin must be a credential-free HTTPS origin.");
  let socketUrl = endpoint.href;
  if (endpoint.protocol === "http:") {
    const version = await (await fetch(new URL("/json/version", endpoint), { signal: AbortSignal.timeout(10000) })).json();
    socketUrl = version.webSocketDebuggerUrl;
  }
  const socketTarget = new URL(socketUrl);
  if (!loopbackHost(socketTarget.hostname)) throw new Error("The browser debugging socket must be loopback.");
  const socket = new WebSocket(socketUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error("Could not open the browser debugging socket."));
  });
  let nextId = 0;
  const pending = new Map();
  const listeners = new Set();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject, timer } = pending.get(message.id);
      clearTimeout(timer);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
      return;
    }
    for (const listener of listeners) listener(message);
  };
  const send = (method, params = {}, sessionId, ms = timeout) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP ${method} timed out.`));
      }, ms);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const owned = new Set();
  let browserContextId = null;
  const origins = [reference.origin];
  async function openTab() {
    // An isolated context has its own cookie jar, but the toolkit's Playwright adopts its pages into
    // the toolkit's persistent context (pages of an unknown context fall back to the default one),
    // so the toolkit overlay still serves them and fetches their documents with the toolkit
    // profile's cookies. Anonymous captures are therefore checked (captureProblem), and main()
    // refuses a toolkit profile that is signed in to the reference origin.
    if (isolated && !browserContextId) ({ browserContextId } = await send("Target.createBrowserContext", { disposeOnDetach: true }));
    const { targetId } = await send("Target.createTarget", { url: "about:blank", background: true, ...(browserContextId ? { browserContextId } : {}) });
    owned.add(targetId);
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const state = { targetId, sessionId, inflight: new Map(), lastActivity: Date.now(), blocked: [], fulfilled: [], consoleErrors: [], pageErrors: [], failedResponses: [], document: null, network: new Map(), bodies: [], assets: new Set() };
    const listener = (message) => {
      if (message.sessionId !== sessionId) return;
      const { method, params } = message;
      if (method === "Fetch.requestPaused") {
        const decision = requestDecision(params.request.method, params.request.url, { fulfil, origins });
        if (decision.action === "continue") send("Fetch.continueRequest", { requestId: params.requestId }, sessionId).catch(() => {});
        else if (decision.action === "fulfil") {
          state.fulfilled.push({ method: params.request.method, url: redactUrl(params.request.url, { origins }), status: decision.status });
          send("Fetch.fulfillRequest", { requestId: params.requestId, responseCode: decision.status, responseHeaders: [{ name: "cache-control", value: "no-store" }], body: "" }, sessionId).catch(() => {});
        } else {
          const body = bodyShape(params.request.postData);
          state.blocked.push({ method: params.request.method, url: redactUrl(params.request.url, { origins }), ...(body ? { body } : {}) });
          send("Fetch.failRequest", { requestId: params.requestId, errorReason: "BlockedByClient" }, sessionId).catch(() => {});
        }
      } else if (method === "Network.requestWillBeSent") {
        state.lastActivity = Date.now();
        if (params.type !== "EventSource") state.inflight.set(params.requestId, params.request.url);
        if (params.type === "Document" && params.frameId === state.frameId) state.document = { requestId: params.requestId };
        else if (trackedRequest(params.request.url, params.type, reference.origin) && state.network.size < 400)
          state.network.set(params.requestId, { method: params.request.method, url: params.request.url, type: params.type });
        else if (["Script", "Stylesheet"].includes(params.type)) assetPath(params.request.url, reference.origin, state.assets);
      } else if (method === "Network.responseReceived") {
        if (state.document?.requestId === params.requestId) {
          state.document.status = params.response.status;
          state.document.headers = headerMap(params.response.headers);
        }
        const tracked = state.network.get(params.requestId);
        if (tracked) {
          tracked.status = params.response.status;
          tracked.contentType = params.response.mimeType || params.response.headers?.["content-type"];
          tracked.headers = params.response.headers;
        }
        if (params.response.status >= 400) state.failedResponses.push({ status: params.response.status, url: redactUrl(params.response.url, { origins }) });
      } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
        state.lastActivity = Date.now();
        state.inflight.delete(params.requestId);
        const tracked = state.network.get(params.requestId);
        if (tracked && method === "Network.loadingFinished" && ["XHR", "Fetch"].includes(tracked.type) && isJsonType(tracked.contentType))
          state.bodies.push(
            send("Network.getResponseBody", { requestId: params.requestId }, sessionId)
              .then((result) => {
                const text = result.base64Encoded ? Buffer.from(result.body, "base64").toString("utf8") : result.body;
                tracked.projection = projectJson(text);
              })
              .catch(() => {
                tracked.projection = { kind: "unavailable" };
              }),
          );
        if (tracked && method === "Network.loadingFailed") tracked.failed = params.blockedReason || params.errorText || "failed";
      } else if (method === "Runtime.consoleAPICalled" && params.type === "error") {
        state.consoleErrors.push(normalizeText(params.args?.map((arg) => arg.value ?? arg.description ?? "").join(" ").slice(0, 300), { origins }));
      } else if (method === "Runtime.exceptionThrown") {
        state.pageErrors.push(normalizeText(String(params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? "").split("\n")[0].slice(0, 300), { origins }));
      } else if (method === "Page.frameNavigated" && params.frame && !params.frame.parentId) {
        // Requests of a replaced document can end without final events.
        state.inflight.clear();
      } else if (method === "Page.javascriptDialogOpening") {
        send("Page.handleJavaScriptDialog", { accept: false }, sessionId).catch(() => {});
      }
    };
    listeners.add(listener);
    await send("Page.enable", {}, sessionId);
    await send("Network.enable", {}, sessionId);
    await send("Runtime.enable", {}, sessionId);
    await send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, sessionId);
    // window.screen matches the viewport on both sides (portal scripts branch on screen.height).
    await send("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, screenWidth: viewport.width, screenHeight: viewport.height, deviceScaleFactor: 1, mobile: false }, sessionId);
    state.frameId = (await send("Page.getFrameTree", {}, sessionId)).frameTree.frame.id;
    const evaluate = async (expression, ms = 30000) => {
      let result;
      try {
        result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, timeout: ms }, sessionId, ms + 5000);
      } catch (error) {
        if (/timed out/i.test(error.message)) throw Object.assign(new Error(`Page evaluation did not finish within ${Math.round(ms / 1000)} s (renderer busy or blocked).`), { code: "PAGE_UNRESPONSIVE" });
        throw error;
      }
      if (result.exceptionDetails) throw new Error(normalizeText(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Page evaluation failed.").slice(0, 300));
      return result.result.value;
    };
    const close = async () => {
      listeners.delete(listener);
      await send("Target.closeTarget", { targetId }).catch(() => {});
      owned.delete(targetId);
    };
    const navigate = async (target) => {
      state.document = null;
      const result = await send("Page.navigate", { url: target }, sessionId);
      if (result.errorText) throw new Error(`Navigation failed: ${result.errorText}`);
      const started = Date.now();
      while (Date.now() - started < timeout) {
        const ready = await evaluate("document.readyState", 5000).catch(() => null);
        if (ready === "complete") break;
        await sleep(150);
      }
    };
    const documentBody = async () => {
      if (!state.document?.requestId) return null;
      const result = await send("Network.getResponseBody", { requestId: state.document.requestId }, sessionId).catch(() => null);
      if (!result) return null;
      return result.base64Encoded ? Buffer.from(result.body, "base64").toString("utf8") : result.body;
    };
    return { state, evaluate, close, navigate, documentBody };
  }
  let apiTab = null;
  const apiTabReady = async () => {
    if (apiTab) return apiTab;
    apiTab = await openTab();
    await apiTab.navigate(new URL("/_layout/tokenhtml", reference.origin).href);
    return apiTab;
  };
  const visit = async (target, options, extract) => {
    assertReadOnlyPath(target);
    const tab = await openTab();
    const started = Date.now();
    try {
      await tab.navigate(new URL(target, reference.origin).href);
      trace("cdp navigated", tab.state.document?.status ?? "");
      const settle = await waitForQuiet({
        inflight: () => tab.state.inflight.size,
        lastActivity: () => tab.state.lastActivity,
        isLoading: () => tab.evaluate(loadingProbe, 5000),
        quietMs: options.quietMs ?? 1000,
        timeout: options.settleTimeout ?? 20000,
      });
      if (options.settleMs) await sleep(Math.min(options.settleMs, 5000));
      trace("cdp settled", settle.settled, tab.state.inflight.size);
      await within(Promise.allSettled(tab.state.bodies), 5000, "Response bodies").catch(() => {});
      const finalUrl = (await tab.evaluate("location.href", 5000).catch(() => null)) ?? new URL(target, reference.origin).href;
      const base = {
        status: tab.state.document?.status ?? null,
        headers: tab.state.document?.headers ?? {},
        finalPath: redactUrl(finalUrl, { origins }),
        originChanged: new URL(finalUrl).origin !== reference.origin,
        settled: settle.settled,
        blockedWrites: tab.state.blocked,
        fulfilledWrites: tab.state.fulfilled,
        consoleErrors: tab.state.consoleErrors,
        pageErrors: tab.state.pageErrors,
        failedResponses: tab.state.failedResponses,
        pendingRequests: [...tab.state.inflight.values()].map((url) => redactUrl(url, { origins })),
        network: [...tab.state.network.values()].map((item) => ({ ...networkRecord({ ...item, origins }), ...(item.projection ? { projection: item.projection } : {}), ...(item.failed ? { failed: item.failed } : {}) })),
        assets: [...tab.state.assets],
      };
      let extracted;
      for (let attempt = 0; ; attempt++) {
        try {
          extracted = await extract(tab);
          break;
        } catch (error) {
          if (error.code === "PAGE_UNRESPONSIVE") {
            extracted = { unresponsive: error.message, snapshot: null };
            break;
          }
          if (!/context was destroyed|cannot find context|navigat/i.test(error.message) || attempt >= 2) throw error;
          base.navigatedDuringCapture = (base.navigatedDuringCapture ?? 0) + 1;
          const deadline = Date.now() + 15000;
          while (Date.now() < deadline && (await tab.evaluate("document.readyState", 3000).catch(() => null)) !== "complete") await sleep(250);
        }
      }
      return { ...base, ...extracted, ms: Date.now() - started };
    } finally {
      await tab.close();
    }
  };
  return {
    origin: reference.origin,
    identity: isolated ? "anonymous" : "signed-in",
    async http(target, { prefer, accept, token = target.startsWith("/_api/"), redirect = "manual" } = {}) {
      assertReadOnlyPath(target, { allowDenied: false });
      const expression = `(${pageFetch.toString()})(${JSON.stringify({ path: target, prefer, accept, token, redirect })})`;
      const started = Date.now();
      let result;
      try {
        result = await (await apiTabReady()).evaluate(expression);
      } catch (error) {
        // The API tab's own document can still be committing when the first read runs; reopen it once.
        if (!/navigated or closed|context was destroyed/i.test(String(error.message))) throw error;
        await apiTab?.close().catch(() => {});
        apiTab = null;
        await sleep(1000);
        result = await (await apiTabReady()).evaluate(expression);
      }
      return { ...result, ms: Date.now() - started, redirectObservable: false };
    },
    /** Raw served document of a real navigation (page scripts run; writes stay blocked or fulfilled). */
    async source(target, options = {}) {
      return visit(target, options, async (tab) => ({ body: (await tab.documentBody()) ?? "" }));
    },
    async page(target, options = {}) {
      return visit(target, options, async (tab) => ({
        snapshot: await tab.evaluate(`(${semanticSnapshot.toString()})(${JSON.stringify(snapshotOptions(options))})`),
        facts: options.facts?.length ? await tab.evaluate(`(${pageFacts.toString()})(${JSON.stringify(options.facts)})`) : undefined,
        probeValue: options.probeExpression ? await tab.evaluate(options.probeExpression) : undefined,
      }));
    },
    async close() {
      if (apiTab) await apiTab.close();
      for (const targetId of owned) await send("Target.closeTarget", { targetId }).catch(() => {});
      if (browserContextId) await send("Target.disposeBrowserContext", { browserContextId }).catch(() => {});
      socket.close();
    },
  };
}

function snapshotOptions(options) {
  return {
    roots: options.roots,
    exclude: [...DEFAULT_EXCLUDE, ...(options.exclude ?? [])],
    opaque: options.opaque ?? DEFAULT_OPAQUE,
    dataSelectors: options.dataSelectors ?? [],
    maxNodes: options.maxNodes ?? 25000,
  };
}

/** Cookie names and attributes only; values are never read into the report. */
export function cookieShapes(setCookies = []) {
  return setCookies
    .map((line) => {
      const [pair, ...attributes] = String(line).split(";");
      const name = pair.split("=")[0].trim();
      const flags = {};
      for (const attribute of attributes) {
        const [key, value] = attribute.split("=");
        const lower = key.trim().toLowerCase();
        if (["secure", "httponly"].includes(lower)) flags[lower] = true;
        else if (lower === "samesite") flags.samesite = String(value ?? "").trim().toLowerCase();
        else if (lower === "path") flags.path = String(value ?? "").trim();
        else if (lower === "max-age" || lower === "expires") flags.persistent = true;
        else if (lower === "domain") flags.domain = true;
      }
      return { name, ...flags };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * GET with up to three retries after a transient network failure (no response at all, for example a
 * connect timeout); responses, whatever their status, are never retried.
 */
async function readWithRetry(url, options, delays = [2000, 5000, 15000]) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, attempt ? { ...options, signal: AbortSignal.timeout(60000) } : options);
    } catch (error) {
      if (!(error instanceof TypeError) || attempt >= delays.length) {
        const code = error?.cause?.code ?? error?.cause?.name;
        throw code ? new Error(`${error.message} (${code})`, { cause: error }) : error;
      }
      await sleep(delays[attempt]);
    }
  }
}

/** Cookie request header for a local session (`cookie` returns { name, value } or null). */
function cookieHeader(cookie) {
  const session = typeof cookie === "function" ? cookie() : null;
  return session ? { cookie: `${session.name}=${session.value}` } : {};
}

/** Cookie-free HTTP reads for anonymous reference requests and local runtime reads. */
export function createHttpDriver({ origin, identity = "anonymous", cookie } = {}) {
  const base = new URL(origin);
  return {
    origin: base.origin,
    identity,
    async http(target, { prefer, accept, redirect = "manual", ifNoneMatch, ifModifiedSince, raw = false } = {}) {
      assertReadOnlyPath(target);
      const started = Date.now();
      const response = await readWithRetry(new URL(target, base.origin), {
        method: "GET",
        redirect,
        headers: { ...cookieHeader(cookie), accept: accept || "*/*", ...(prefer ? { Prefer: prefer } : {}), ...(ifNoneMatch ? { "if-none-match": ifNoneMatch } : {}), ...(ifModifiedSince ? { "if-modified-since": ifModifiedSince } : {}) },
        signal: AbortSignal.timeout(60000),
      });
      const body = raw ? Buffer.from(await response.arrayBuffer()) : await response.text();
      const headers = {};
      for (const [name, value] of response.headers) if (name.toLowerCase() !== "set-cookie") headers[name.toLowerCase()] = value;
      let finalPath = null;
      try {
        finalPath = new URL(response.url).pathname;
      } catch {
        finalPath = null;
      }
      return { status: response.status, type: response.type, redirected: response.redirected, finalPath, headers, cookies: cookieShapes(response.headers.getSetCookie?.() ?? []), body, ms: Date.now() - started, redirectObservable: redirect === "manual" };
    },
  };
}

/**
 * Owned headless browser for local pages and anonymous reference pages. Each capture uses a
 * fresh context; non-read requests are blocked or fulfilled locally and off-origin documents
 * (for example an identity provider) are aborted.
 */
export async function openOwnedBrowser({ channel, headless = true, fulfil = [] } = {}) {
  const { chromium } = await import("playwright-core");
  const { browserLaunchOptions } = await import("./lib/browser-launch.mjs");
  const browser = await chromium.launch(browserLaunchOptions({ channel, headless }));
  const pageDriver = (origin, identity, { guard: driverGuard = "route", cookie } = {}) => {
    const base = new URL(origin);
    const origins = [base.origin];
    const visit = async (target, options, extract) => {
      assertReadOnlyPath(target);
      const guard = options.guard ?? driverGuard;
      const viewport = options.viewport ?? { width: 1440, height: 1000 };
      const context = await browser.newContext({ viewport, screen: viewport, ...(guard === "route" ? { serviceWorkers: "block" } : {}) });
      const state = { blocked: [], fulfilled: [], consoleErrors: [], pageErrors: [], failedResponses: [], inflight: new Set(), lastActivity: Date.now(), offOrigin: [], network: [], bodies: [], document: null, assets: new Set() };
      try {
        // Local sessions are cookies; an anonymous visitor sends none.
        const session = typeof cookie === "function" ? cookie() : null;
        if (session) await context.addCookies([{ name: session.name, value: session.value, url: base.origin }]);
        if (guard === "script") {
          // Script guard: XHR/fetch/beacon writes are stopped in the page (synchronous XHR GETs are
          // never paused), while documents, fetches, pings and other requests stay intercepted.
          await context.exposeBinding("__parityGuard", (_source, entry) => {
            const item = { method: String(entry?.method ?? "").toUpperCase(), url: redactUrl(String(entry?.url ?? ""), { origins }) };
            if (entry?.action === "fulfil") state.fulfilled.push({ ...item, status: entry.status });
            else state.blocked.push(item);
          });
          await context.addInitScript(writeGuard, { origin: base.origin, fulfil: fulfil.map((rule) => ({ method: String(rule.method).toUpperCase(), pathPattern: rule.pathPattern, status: rule.status })) });
        } else await context.route("**/*", (route) => {
          const request = route.request();
          let url;
          try {
            url = new URL(request.url());
          } catch {
            return route.abort();
          }
          if (!["http:", "https:"].includes(url.protocol)) return route.continue();
          if (request.isNavigationRequest() && url.origin !== base.origin) {
            state.offOrigin.push(redactUrl(url.href, { origins }));
            return route.abort("blockedbyclient");
          }
          const decision = requestDecision(request.method(), url.href, { fulfil, origins });
          if (decision.action === "fulfil") {
            state.fulfilled.push({ method: request.method(), url: redactUrl(url.href, { origins }), status: decision.status });
            return route.fulfill({ status: decision.status, headers: { "cache-control": "no-store" }, body: "" });
          }
          if (decision.action === "block") {
            const body = bodyShape(request.postData());
            state.blocked.push({ method: request.method(), url: redactUrl(url.href, { origins }), ...(body ? { body } : {}) });
            return route.abort("blockedbyclient");
          }
          return route.continue();
        });
        const page = await context.newPage();
        if (guard === "script") {
          const cdp = await context.newCDPSession(page);
          const fail = (requestId) => cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }).catch(() => {});
          cdp.on("Fetch.requestPaused", (event) => {
            const { request, requestId, resourceType } = event;
            let url;
            try {
              url = new URL(request.url);
            } catch {
              return fail(requestId);
            }
            if (!["http:", "https:"].includes(url.protocol)) return cdp.send("Fetch.continueRequest", { requestId }).catch(() => {});
            if (resourceType === "Document" && url.origin !== base.origin) {
              state.offOrigin.push(redactUrl(url.href, { origins }));
              return fail(requestId);
            }
            const decision = requestDecision(request.method, url.href, { fulfil, origins });
            if (decision.action === "fulfil") {
              state.fulfilled.push({ method: request.method, url: redactUrl(url.href, { origins }), status: decision.status });
              return cdp.send("Fetch.fulfillRequest", { requestId, responseCode: decision.status, responseHeaders: [{ name: "cache-control", value: "no-store" }], body: "" }).catch(() => {});
            }
            if (decision.action === "block") {
              state.blocked.push({ method: request.method, url: redactUrl(url.href, { origins }) });
              return fail(requestId);
            }
            return cdp.send("Fetch.continueRequest", { requestId }).catch(() => {});
          });
          await cdp.send("Fetch.enable", { patterns: ["Document", "Fetch", "Ping", "Other"].map((resourceType) => ({ urlPattern: "*", resourceType, requestStage: "Request" })) });
        }
        page.on("dialog", (dialog) => dialog.dismiss().catch(() => {}));
        // Requests of a replaced document can end without final events; only the current
        // document's requests count towards settling.
        page.on("framenavigated", (frame) => {
          if (frame === page.mainFrame()) state.inflight.clear();
        });
        page.on("request", (request) => {
          state.lastActivity = Date.now();
          if (request.resourceType() !== "eventsource" && !request.url().endsWith("/__sim/events")) state.inflight.add(request);
          if (["script", "stylesheet"].includes(request.resourceType())) assetPath(request.url(), base.origin, state.assets);
        });
        const done = (request) => {
          state.inflight.delete(request);
          state.lastActivity = Date.now();
        };
        page.on("requestfinished", done);
        page.on("requestfailed", done);
        page.on("console", (message) => {
          if (message.type() === "error") state.consoleErrors.push(normalizeText(message.text().slice(0, 300), { origins }));
        });
        page.on("pageerror", (error) => state.pageErrors.push(normalizeText(String(error.message).split("\n")[0].slice(0, 300), { origins })));
        page.on("response", (response) => {
          if (response.status() >= 400) state.failedResponses.push({ status: response.status(), url: redactUrl(response.url(), { origins }) });
          const request = response.request();
          const type = request.resourceType();
          if (request.isNavigationRequest() && request.frame() === page.mainFrame()) return;
          // Redirect hops are not separate requests in the CDP driver; record final responses only.
          if (response.status() >= 300 && response.status() < 400) return;
          if (!trackedRequest(response.url(), type, base.origin) || state.network.length >= 400) return;
          const record = networkRecord({ method: request.method(), url: response.url(), type, status: response.status(), contentType: response.headers()["content-type"], origins, headers: response.headers() });
          state.network.push(record);
          if (["xhr", "fetch"].includes(type) && isJsonType(response.headers()["content-type"]))
            state.bodies.push(
              response
                .text()
                .then((text) => {
                  record.projection = projectJson(text);
                })
                .catch(() => {
                  record.projection = { kind: "unavailable" };
                }),
            );
        });
        const started = Date.now();
        let navigationError = null;
        let response = null;
        try {
          response = await page.goto(new URL(target, base.origin).href, { waitUntil: "load", timeout: options.timeout ?? 45000 });
          trace("owned navigated", response?.status() ?? "");
        } catch (error) {
          navigationError = normalizeText(error.message.split("\n")[0]);
        }
        const settle = await waitForQuiet({
          inflight: () => state.inflight.size,
          lastActivity: () => state.lastActivity,
          isLoading: () => within(page.evaluate(loadingProbe), 5000),
          quietMs: options.quietMs ?? 1000,
          timeout: options.settleTimeout ?? 20000,
        });
        if (options.settleMs) await page.waitForTimeout(Math.min(options.settleMs, 5000));
        trace("owned settled", settle.settled, state.inflight.size);
        await within(Promise.allSettled(state.bodies), 5000, "Response bodies").catch(() => {});
        const finalUrl = page.url();
        const base_ = {
          status: response?.status() ?? null,
          headers: response ? headerMap(await response.allHeaders().catch(() => response.headers())) : {},
          navigationError,
          finalPath: redactUrl(finalUrl, { origins }),
          originChanged: (() => {
            try {
              return new URL(finalUrl).origin !== base.origin;
            } catch {
              return true;
            }
          })(),
          offOriginNavigations: state.offOrigin,
          settled: settle.settled,
          blockedWrites: state.blocked,
          fulfilledWrites: state.fulfilled,
          consoleErrors: state.consoleErrors,
          pageErrors: state.pageErrors,
          failedResponses: state.failedResponses,
          pendingRequests: [...state.inflight].map((request) => redactUrl(request.url(), { origins })),
          network: state.network,
          assets: [...state.assets],
        };
        delete base_.headers["set-cookie"];
        let extracted;
        // A page script may navigate or reload while it is being captured; capture the document
        // it settles on (bounded retries) and record that it navigated.
        for (let attempt = 0; ; attempt++) {
          try {
            extracted = await extract(page, response);
            break;
          } catch (error) {
            if (error.code === "PAGE_UNRESPONSIVE") {
              extracted = { unresponsive: error.message, snapshot: null };
              break;
            }
            if (!/context was destroyed|navigat/i.test(error.message) || attempt >= 2) throw error;
            base_.navigatedDuringCapture = (base_.navigatedDuringCapture ?? 0) + 1;
            await page.waitForLoadState("load", { timeout: 15000 }).catch(() => {});
            await page.waitForTimeout(500);
          }
        }
        base_.finalPath = redactUrl(page.url(), { origins });
        return { ...base_, ...extracted, ms: Date.now() - started };
      } finally {
        await context.close().catch(() => {});
      }
    };
    return {
      origin: base.origin,
      identity,
      async source(target, options = {}) {
        return visit(target, options, async (_page, response) => ({ body: response ? await response.text().catch(() => "") : "" }));
      },
      async page(target, options = {}) {
        return visit(target, options, async (page) => ({
          snapshot: await within(page.evaluate(semanticSnapshot, snapshotOptions(options)), 30000, "Semantic snapshot"),
          facts: options.facts?.length ? await within(page.evaluate(pageFacts, options.facts), 10000, "Fact counts") : undefined,
          probeValue: options.probeExpression ? await within(page.evaluate(options.probeExpression), 10000, "Probe expression") : undefined,
        }));
      },
    };
  };
  return {
    pageDriver,
    async close() {
      await browser.close().catch(() => {});
    },
  };
}

// ---------------------------------------------------------------------------
// Local runtime helpers
// ---------------------------------------------------------------------------

async function localState(localUrl, { summary = true } = {}) {
  const response = await fetch(new URL(`/__sim/api/state${summary ? "?summary=1" : ""}`, localUrl), { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error("Local runtime state is unavailable.");
  return response.json();
}

async function localDataFingerprint(localUrl) {
  const state = await localState(localUrl, { summary: false });
  return sha256(state.data ?? {});
}

/** Start an isolated Mirage on a temporary copy of a baseline state. */
export async function startIsolatedMirage({ sourceDir, baselineState, solutionRoots, solutionOrder, observed, dataPacks = [], preset = null, origin, workDir, deploymentProfile }) {
  const { createSimulator } = await import("./server.mjs");
  const { discoverSolutionRoots } = await import("./lib/solution-roots.mjs");
  await fs.mkdir(workDir, { recursive: true });
  const workspace = await fs.mkdtemp(path.join(workDir, "local-"));
  const stateFile = path.join(workspace, "state.json");
  if (baselineState) {
    await fs.copyFile(baselineState, stateFile);
    try {
      await fs.cp(path.join(path.dirname(path.resolve(baselineState)), "assets"), path.join(workspace, "assets"), { recursive: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  solutionRoots ??= await discoverSolutionRoots(sourceDir);
  // Catalogue (--site/--env) runs pass the site's mirage settings like `mirage/cli.mjs serve`
  // does: its solution order and its observed behaviour (sign-in path, inner errors, ...).
  const app = await createSimulator({
    sourceDir,
    stateFile,
    solutionRoots,
    dataPacks,
    ...(solutionOrder ? { solutionOrder } : {}),
    ...(observed ? { observed } : {}),
    origin,
    watch: false,
    port: 0,
    ...(deploymentProfile ? { deploymentProfile } : {}),
  });
  try {
    if (preset) await app.applyPreset(preset);
    const response = await fetch(app.url + "/__sim/api/config", {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-sim-csrf": app.state().csrf },
      body: JSON.stringify({ mode: "local", pageMode: "local", live: { allowWrites: false } }),
    });
    if (!response.ok) throw new Error(`Local runtime configuration failed (${response.status}).`);
  } catch (error) {
    await app.close();
    throw error;
  }
  return { app, url: app.url, workspace, stateFile, solutionRoots, preset, deploymentProfile: deploymentProfile ?? null };
}

/**
 * Local identity for the run, as session cookies only: portal requests to the Mirage take
 * their identity from the `paqvilo-mirage-auth-<port>` cookie and are anonymous without one. Sign-in
 * goes through the session API and changes no runtime state. Mirroring a reference persona is
 * a role override with the persona's exported web-role names on the local synthetic contact.
 */
export function createIdentityController(localUrl, { fetchImpl = fetch } = {}) {
  const origin = new URL(localUrl).origin;
  if (!loopbackHost(new URL(origin).hostname)) throw new Error("Local sign-in is limited to a loopback runtime.");
  let persona = null;
  let session = null;
  let current = null;
  const signIn = async () => {
    const { csrf } = await localState(origin);
    const response = await fetchImpl(origin + "/__sim/api/session/sign-in", {
      method: "POST",
      headers: { "content-type": "application/json", "x-sim-csrf": csrf },
      body: JSON.stringify({ contactId: persona.contactId, ...(persona.roles ? { roles: persona.roles } : {}) }),
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error(`Local sign-in failed (${response.status}): ${normalizeText(await response.text()).slice(0, 200)}`);
    const body = await response.json();
    if (!body?.signedIn || typeof body.cookie?.name !== "string" || typeof body.cookie.value !== "string")
      throw new Error("Local sign-in returned no session cookie.");
    session = {
      cookie: { name: body.cookie.name, value: body.cookie.value },
      contactId: body.contactId ?? null,
      roles: Array.isArray(body.roles) ? [...body.roles] : [],
      roleSource: body.roleSource ?? null,
    };
  };
  const defaultPersona = async () => {
    const response = await fetchImpl(origin + "/__sim/api/session", { signal: AbortSignal.timeout(30000) });
    return response.ok ? ((await response.json())?.defaultPersona?.contactId ?? null) : null;
  };
  const controller = {
    /** Sign in as the local synthetic contact with the reference persona's web-role names. */
    async mirror({ contactId, roles }) {
      if (!contactId) throw new Error("Persona mirroring needs a local synthetic contact; set persona.contactId in the plan or pass --persona-contact.");
      const state = await localState(origin);
      const known = new Set((state.status?.webRoles ?? []).map((role) => role.name));
      const unresolved = roles.filter((role) => !known.has(role));
      persona = { contactId, roles: roles.filter((role) => known.has(role)) };
      await signIn();
      current = "signed-in";
      return { unresolved, effectiveRoles: [...session.roles].sort(), contactPresent: Boolean(session.contactId), session: session.roleSource };
    },
    /** Sign in as a local contact with its own memberships (the runtime's default persona when omitted). */
    async signInAs(contactId) {
      const id = contactId ?? (await defaultPersona());
      if (!id) throw new Error("The local runtime offers no default persona for signed-in scenarios; pass --persona-contact.");
      persona = { contactId: id };
      await signIn();
    },
    async use(identity) {
      if (identity === "signed-in" && !session) await controller.signInAs(persona?.contactId);
      current = identity;
    },
    /** The session cookie for the current identity; an anonymous visitor sends none. */
    cookie() {
      return current === "signed-in" ? (session?.cookie ?? null) : null;
    },
    /** Sessions exist only in this client, so nothing in the runtime needs to be undone. */
    async restore() {
      current = null;
    },
    describe() {
      const signedIn = current === "signed-in" && session;
      return {
        identity: current,
        roles: signedIn ? [...session.roles].sort() : [],
        contact: signedIn && session.contactId ? "local synthetic contact" : null,
        mirroredRoles: persona?.roles ?? null,
        session: signedIn ? session.roleSource : null,
      };
    },
  };
  return controller;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const statusClass = (status) => (status === null || status === undefined ? "none" : status === 0 ? "opaque-redirect" : `${String(status)[0]}xx`);

function pageDiagnostics(observation, reveal = (value) => value) {
  return {
    status: observation.status,
    finalPath: observation.finalPath,
    originChanged: observation.originChanged || undefined,
    settled: observation.settled,
    blockedWrites: observation.blockedWrites?.map((item) => (item.body ? { ...item, body: { keys: item.body.keys, guids: item.body.guids.map((guid) => reveal(guid)) } } : item)),
    fulfilledWrites: observation.fulfilledWrites?.length ? observation.fulfilledWrites : undefined,
    consoleErrors: observation.consoleErrors?.length ?? 0,
    pageErrors: observation.pageErrors?.length ?? 0,
    failedResponses: observation.failedResponses,
    pendingRequests: observation.pendingRequests?.length ? observation.pendingRequests.slice(0, 12) : undefined,
    offOriginNavigations: observation.offOriginNavigations?.length ? observation.offOriginNavigations : undefined,
    title: observation.snapshot?.title !== undefined ? reveal(normalizeText(observation.snapshot.title)) : undefined,
    toolkitPanel: observation.snapshot?.panel || undefined,
    portalUser: observation.snapshot?.signInSignals?.portalUser ?? undefined,
    nodeCount: observation.snapshot?.nodeCount,
    truncated: observation.snapshot?.truncated || undefined,
    navigationError: observation.navigationError || undefined,
    navigatedDuringCapture: observation.navigatedDuringCapture || undefined,
    unresponsive: observation.unresponsive || undefined,
    networkRequests: observation.network?.length ?? 0,
    ms: observation.ms,
  };
}

/**
 * Why a reference page capture cannot be compared, or null. Accepts a driver result (with its
 * snapshot) or saved page diagnostics. An unsettled capture without any node is no rendering; an
 * anonymous capture that names a signed-in portal contact is not anonymous: a context created over
 * CDP inside the toolkit browser is adopted by the toolkit's persistent context, whose overlay
 * fetches its documents with the toolkit profile's cookies.
 */
export function captureProblem(identity, observation) {
  if (!observation || typeof observation !== "object") return null;
  const nodeCount = observation.snapshot ? observation.snapshot.nodeCount : observation.nodeCount;
  if (observation.settled === false && !(nodeCount > 0)) return "The reference page neither settled nor produced a snapshot; rerun this scenario.";
  const portalUser = observation.snapshot ? observation.snapshot.signInSignals?.portalUser : observation.portalUser;
  if (identity === "anonymous" && portalUser === true)
    return "The anonymous reference page rendered a signed-in portal user (Microsoft.Dynamic365.Portal.User.contactId is set). A browser context created over CDP inside the toolkit browser is served by the toolkit overlay with the toolkit profile's cookies; use --anonymous-browser owned, or a toolkit profile without a session for this origin.";
  return null;
}

function signInObserved(observation) {
  return Boolean(
    observation?.originChanged ||
      /\/(?:[a-z]{2}-[a-z]{2}\/)?(?:signin|sign-in|login)(?:[/?]|$)/i.test(observation?.finalPath ?? "") ||
      observation?.snapshot?.signInSignals?.passwordInputs,
  );
}

const GUID_EXACT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Find a comparable record on one side: from a Web API read, or from a link the page renders. */
// ---------------------------------------------------------------------------
// Scenario sources: the portal-agnostic core set and data-pack plans
// ---------------------------------------------------------------------------

/** The portal-agnostic core scenario set shipped with the Mirage (anonymous, read-only). */
export const CORE_SCENARIOS_FILE = fileURLToPath(new URL("./lib/parity-core-scenarios.json", import.meta.url));

/** Plan files a data pack contributes through `parity: { scenarios: [...] }` (paths inside the pack). */
export function packScenarioFiles(pack, packDir) {
  const parity = pack?.parity;
  if (parity === undefined || parity === null) return [];
  if (typeof parity !== "object" || Array.isArray(parity) || !Array.isArray(parity.scenarios))
    throw new Error(`Data pack ${pack.id}: parity.scenarios must be an array of plan files.`);
  const root = path.resolve(packDir);
  return parity.scenarios.map((entry) => {
    if (typeof entry !== "string" || !entry.endsWith(".json") || path.isAbsolute(entry) || /^[a-z][a-z0-9+.-]*:/i.test(entry))
      throw new Error(`Data pack ${pack.id}: parity scenario files must be relative .json paths inside the pack.`);
    const file = path.resolve(root, entry);
    const relative = path.relative(root, file);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error(`Data pack ${pack.id}: parity scenario file ${entry} leaves the pack directory.`);
    return file;
  });
}

/**
 * Select scenario sources: the core set, data-pack plans (`auto`: packs whose matches({ portal })
 * accepts the imported portal; `all`; `none`; or a list of pack ids) and explicit plan files.
 */
export async function scenarioSources({ core = true, packs = "auto", portal = null, files = [], packsRoot, project, explicit = [] } = {}) {
  const sources = [];
  if (core) sources.push({ source: "core", file: CORE_SCENARIOS_FILE });
  if (packs && packs !== "none") {
    if (!Array.isArray(packs) && !["auto", "all"].includes(packs)) throw new Error("Pack selection must be auto, all, none or a list of pack ids.");
    const { packModules, loadPack, packMatches } = await import("./lib/preset-registry.mjs");
    const wanted = Array.isArray(packs) ? new Set(packs) : null;
    const found = new Set();
    for (const { module } of await packModules({ project, explicit, ...(packsRoot ? { root: packsRoot } : {}) })) {
      const pack = await loadPack(module);
      const selected = wanted ? wanted.has(pack.id) : packs === "all" || (portal != null && packMatches(pack, portal));
      if (!selected) continue;
      found.add(pack.id);
      for (const file of packScenarioFiles(pack, path.dirname(module))) sources.push({ source: `pack:${pack.id}`, file });
    }
    for (const id of wanted ?? []) if (!found.has(id)) throw new Error(`Data pack ${id} was not found.`);
  }
  for (const file of files) sources.push({ source: "file", file: path.resolve(file) });
  return sources;
}

/**
 * The denied routes of every data pack that matches the portal guard the run whatever scenarios
 * were selected (a custom --plan file included). They live in the packs' own parity plans.
 */
export async function activatePackDeniedRoutes(portal, options = {}) {
  for (const { file } of await scenarioSources({ core: false, packs: "auto", portal, ...options })) {
    const entries = JSON.parse(await fs.readFile(file, "utf8")).deniedRoutes ?? [];
    rememberDeniedRoutes(entries, compileDeniedRoutes(entries));
  }
  return activePlanDeniedRoutes();
}

/**
 * Merge validated plans. Scenario ids stay unique across sources, every scenario and rule keeps
 * its source so a plan's rules classify only its own scenarios, and later sources refine the
 * defaults of earlier ones. A single explicit plan file is returned unchanged.
 */
export function mergePlans(entries) {
  if (!entries.length) throw new Error("No parity scenario source was selected.");
  if (entries.length === 1 && entries[0].source === "file") return validatePlan(entries[0].plan);
  const merged = { version: 1, defaults: {}, conditions: [], fulfil: [], allowPost: [], notObservable: [], deniedRoutes: [], scenarios: [], classifications: [], sources: [] };
  const owner = new Map();
  for (const { source, file, plan } of entries) {
    validatePlan(plan);
    for (const scenario of plan.scenarios) {
      if (owner.has(scenario.id)) throw new Error(`Scenario id ${scenario.id} is defined by ${owner.get(scenario.id)} and ${source}.`);
      owner.set(scenario.id, source);
      merged.scenarios.push({ ...scenario, planSource: source });
    }
    merged.classifications.push(...(plan.classifications ?? []).map((rule) => ({ ...rule, planSource: source })));
    Object.assign(merged.defaults, plan.defaults ?? {});
    for (const key of ["conditions", "fulfil", "allowPost", "notObservable", "deniedRoutes"])
      for (const item of plan[key] ?? []) if (!merged[key].some((existing) => JSON.stringify(existing) === JSON.stringify(item))) merged[key].push(item);
    if (plan.persona && !merged.persona) merged.persona = plan.persona;
    merged.sources.push({ source, file: path.basename(file), scenarios: plan.scenarios.length, fingerprint: sha256(plan).slice(0, 16) });
  }
  return validatePlan(merged);
}

/** Load and merge the selected scenario sources. */
export async function loadScenarioPlans(options = {}) {
  const entries = [];
  for (const item of await scenarioSources(options)) entries.push({ ...item, plan: JSON.parse(await fs.readFile(item.file, "utf8")) });
  return mergePlans(entries);
}

/** Classification rules for one scenario: rules from a merged plan apply only to their own source. */
export function rulesFor(plan, scenario) {
  const rules = plan.classifications ?? [];
  const source = scenario?.planSource;
  return source ? rules.filter((rule) => !rule.planSource || rule.planSource === source) : rules;
}

/**
 * Values for `discover.from: "portal"`, chosen deterministically from the exported portal and the
 * local table mappings (shallowest, then alphabetical). A missing value makes a scenario not
 * applicable to that portal. `pageAccess` is lib/page-access.mjs's evaluator.
 */
export function portalDiscovery({ portal, mappings = {}, pageAccess }) {
  const facts = {};
  const depth = (url) => url.split("/").filter(Boolean).length;
  const byUrl = (a, b) => depth(a.url) - depth(b.url) || a.url.localeCompare(b.url);
  const anonymous = (target) => {
    try {
      return pageAccess(portal, target, {});
    } catch {
      return null;
    }
  };
  const pages = (portal?.pages ?? []).filter((page) => typeof page.url === "string" && page.url.startsWith("/") && page.url !== "/" && !/[?#]/.test(page.url));
  // Several exported pages can share one URL; the redirect checks use a URL with a single page.
  const byPath = new Map();
  for (const page of pages) byPath.set(page.url.toLowerCase(), [...(byPath.get(page.url.toLowerCase()) ?? []), page]);
  const deniedPage = (page) => {
    const access = anonymous(page);
    return access?.allowed === false && access.code === "PAGE_ACCESS_DENIED";
  };
  const denied = pages.filter((page) => byPath.get(page.url.toLowerCase()).length === 1 && deniedPage(page));
  if (denied.length) facts.protectedPage = denied.sort(byUrl)[0].url;
  const shared = [...byPath.values()].filter((group) => group.length > 1 && new Set(group.map(deniedPage)).size > 1).map((group) => group[0]);
  if (shared.length) facts.ambiguousPage = shared.sort(byUrl)[0].url;
  const stylesheets = (portal?.webFiles ?? []).filter((file) => typeof file.url === "string" && /^\/[^?#]*\.css$/i.test(file.url) && anonymous(file)?.allowed === true);
  if (stylesheets.length) {
    stylesheets.sort(byUrl);
    facts.publicWebFile = stylesheets[0].url;
    facts.publicWebFiles = stylesheets.slice(0, 40).map((file) => file.url);
  }
  // Tables whose entity set comes from solution metadata (not pluralised or inferred locally).
  const solutionBacked = (table) => [undefined, "solution"].includes(mappings[table]?.entitySetSource) && !table.includes("__");
  const settings = portal?.settings ?? {};
  const setting = (name) => {
    const entry = settings[name];
    return String(entry && typeof entry === "object" ? (entry.value ?? "") : (entry ?? ""));
  };
  const names = Object.keys(settings);
  const enabled = names
    .map((name) => /^webapi\/([^/]+)\/enabled$/i.exec(name))
    .filter((match) => match && setting(match[0]).trim().toLowerCase() === "true")
    .map((match) => match[1].toLowerCase())
    .filter((table) => typeof mappings[table]?.entitySet === "string")
    .sort((a, b) => Number(!solutionBacked(a)) - Number(!solutionBacked(b)) || a.localeCompare(b));
  if (enabled.length) {
    const table = enabled[0];
    const fieldsName = names.find((name) => name.toLowerCase() === `webapi/${table}/fields`);
    const fields = (fieldsName ? setting(fieldsName) : "").split(",").map((item) => item.trim()).filter(Boolean);
    const idColumn = mappings[table].idColumn;
    // The primary key when it is allowed (or every column is), otherwise the first listed column.
    const field = idColumn && (!fields.length || fields.includes("*") || fields.includes(idColumn)) ? idColumn : fields.find((item) => item !== "*");
    if (field) Object.assign(facts, { enabledEntitySet: mappings[table].entitySet, enabledField: field, enabledTable: table });
  }
  const prefix = enabled.map((table) => /^([a-z0-9]+_)/.exec(table)?.[1]).find(Boolean);
  const notEnabled = Object.keys(mappings)
    .filter((table) => prefix && table.startsWith(prefix) && !enabled.includes(table) && typeof mappings[table]?.entitySet === "string" && solutionBacked(table))
    .sort();
  if (notEnabled.length) Object.assign(facts, { notEnabledEntitySet: mappings[notEnabled[0]].entitySet, notEnabledTable: notEnabled[0] });
  return facts;
}

/** Document shell facts, evaluated in the page: title, html/body attributes and bundle order. */
/**
 * In-page: the platform client objects as key names and value types, in key order. User entries
 * also say whether a string or array value is empty. No value leaves the page.
 */
export function clientObjectFacts() {
  const kind = (value) => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value);
  const entries = (object, withEmpty) => {
    if (!object || typeof object !== "object") return null;
    return Object.keys(object).map((key) => {
      let value;
      try {
        value = object[key];
      } catch {
        return { key, type: "throws" };
      }
      const entry = { key, type: kind(value) };
      if (withEmpty && (typeof value === "string" || Array.isArray(value))) entry.empty = value.length === 0;
      return entry;
    });
  };
  const ms = window.Microsoft;
  const dynamic = ms && typeof ms === "object" ? ms.Dynamic365 : undefined;
  const portal = dynamic && typeof dynamic === "object" ? dynamic.Portal : undefined;
  return JSON.stringify({
    microsoft: entries(ms, false),
    dynamic365: entries(dynamic, false),
    portal: entries(portal, false),
    user: entries(portal && typeof portal === "object" ? portal.User : undefined, true),
    powerPages: entries(ms && typeof ms === "object" ? ms.PowerPages : undefined, false),
  });
}

const CLIENT_OBJECT_SCOPES = Object.freeze([
  ["Microsoft", "microsoft"],
  ["Microsoft.Dynamic365", "dynamic365"],
  ["Microsoft.Dynamic365.Portal", "portal"],
  ["Microsoft.Dynamic365.Portal.User", "user"],
  ["Microsoft.PowerPages", "powerPages"],
]);

/** Key presence, key order and value types of the platform client objects (names and types only). */
export function compareClientObject(live, local) {
  const deltas = [];
  for (const [scope, field] of CLIENT_OBJECT_SCOPES) {
    const a = live?.[field] ?? null;
    const b = local?.[field] ?? null;
    if (!a || !b) {
      if (Boolean(a) !== Boolean(b)) deltas.push({ kind: "client-object-missing", path: scope, live: Boolean(a), local: Boolean(b) });
      continue;
    }
    const liveKeys = a.map((entry) => entry.key);
    const localKeys = b.map((entry) => entry.key);
    for (const entry of a) if (!localKeys.includes(entry.key)) deltas.push({ kind: "client-key-missing", path: `${scope}.${entry.key}`, live: entry.type, local: null });
    for (const entry of b) if (!liveKeys.includes(entry.key)) deltas.push({ kind: "client-key-extra", path: `${scope}.${entry.key}`, live: null, local: entry.type });
    const sharedLive = liveKeys.filter((key) => localKeys.includes(key));
    const sharedLocal = localKeys.filter((key) => liveKeys.includes(key));
    if (sharedLive.join(",") !== sharedLocal.join(",")) deltas.push({ kind: "client-key-order", path: scope, live: sharedLive.join(","), local: sharedLocal.join(",") });
    for (const key of sharedLive) {
      const x = a.find((entry) => entry.key === key);
      const y = b.find((entry) => entry.key === key);
      if (x.type !== y.type) deltas.push({ kind: "client-key-type", path: `${scope}.${key}`, live: x.type, local: y.type });
      else if (typeof x.empty === "boolean" && typeof y.empty === "boolean" && x.empty !== y.empty)
        deltas.push({ kind: "client-value-empty", path: `${scope}.${key}`, live: x.empty, local: y.empty });
    }
  }
  return deltas;
}

/** Key lists per scope for the report (names and types). */
function clientObjectSummary(facts) {
  return Object.fromEntries(CLIENT_OBJECT_SCOPES.map(([scope, field]) => [scope, facts?.[field] ? facts[field].map((entry) => `${entry.key}:${entry.type}${entry.empty === true ? ":empty" : ""}`) : null]));
}

function shellFacts() {
  const attributes = (element) => (element ? [...element.attributes].map((attribute) => [attribute.name, attribute.value]) : []);
  const resources = [];
  for (const element of document.querySelectorAll("script[src], link[href]")) {
    const tag = element.tagName.toLowerCase();
    const rel = (element.getAttribute("rel") ?? "").toLowerCase().trim();
    if (tag === "link" && !/(^|\s)(stylesheet|preload|modulepreload)(\s|$)/.test(rel)) continue;
    let url;
    try {
      url = new URL(element.getAttribute(tag === "script" ? "src" : "href"), location.href);
    } catch {
      continue;
    }
    resources.push({ kind: tag === "script" ? "script" : rel.split(/\s+/)[0], path: url.origin === location.origin ? url.pathname : url.origin + url.pathname, head: Boolean(element.closest("head")) });
  }
  return JSON.stringify({ title: document.title, html: attributes(document.documentElement), body: attributes(document.body), resources });
}

/** The platform bundle CDN; the local runtime serves the same bundles under the same path. */
const PLATFORM_BUNDLE_CDN = "https://content.powerapps.com";
const PLATFORM_BUNDLE_PATH = "/resource/powerappsportal/";
/** Hosting and tenant services that portal pages load (Application Insights, Power BI embeds). */
export const HOSTED_RESOURCES = Object.freeze([/\/\/js\.monitor\.azure\.com\/.*\bai\.\d+(?:\.\d+)*\.min\.js$/i, /\/\/(?:[a-z0-9-]+\.)*powerbi\.com\//i, /\/powerbi(?:-client|loader)?(?:\.min)?\.js$/i]);

/**
 * Comparable key of a page resource: CDN platform bundles and the local copies share the
 * /resource/powerappsportal/ path, GUIDs and query values are generalised, and content hashes in
 * bundle names are deployment state (the name and position are compared, not the hash).
 */
export function resourceKey(item, { origins = [] } = {}) {
  return `${item.kind} ${withoutContentHash(redactUrl(platformAsset(item.path), { origins }))}`;
}

/** A platform bundle or asset URL on the CDN becomes the path the local runtime serves it under. */
function platformAsset(value) {
  const text = String(value ?? "");
  return text.toLowerCase().startsWith((PLATFORM_BUNDLE_CDN + PLATFORM_BUNDLE_PATH).toLowerCase()) ? text.slice(PLATFORM_BUNDLE_CDN.length) : text;
}

/** Content hashes in bundle file names are deployment state: `app.bundle-79acd4df74.js` -> `app.bundle-{hash}.js`. */
function withoutContentHash(text) {
  return String(text).replace(/([.-])[0-9a-f]{8,}(?=(?:\.chunk)?\.(?:js|css)$)/i, "$1{hash}");
}

/** Compare two document shells; resources are keyed by kind and normalised path, in document order. */
export function compareShell(live, local, { origins = [] } = {}) {
  const deltas = [];
  const text = (value) => normalizeText(String(value ?? ""), { origins });
  const key = (item) => resourceKey(item, { origins });
  const hosted = (item) => HOSTED_RESOURCES.some((pattern) => pattern.test(String(item.path ?? "")));
  const view = (shell) => ({ title: text(shell.title), html: shell.html.map(([name]) => name), body: shell.body.map(([name]) => name), resources: shell.resources.map(key) });
  if (text(live.title) !== text(local.title)) deltas.push({ kind: "body-title", path: "document.title", live: text(live.title), local: text(local.title) });
  for (const [element, a, b] of [["html", live.html, local.html], ["body", live.body, local.body]]) {
    const left = new Map(a.map(([name, value]) => [name.toLowerCase(), value]));
    const right = new Map(b.map(([name, value]) => [name.toLowerCase(), value]));
    for (const name of [...new Set([...left.keys(), ...right.keys()])].sort()) {
      if (name === "class") {
        const tokens = (value) => new Set(String(value ?? "").split(/\s+/).filter(Boolean));
        const x = tokens(left.get(name));
        const y = tokens(right.get(name));
        const missing = [...x].filter((token) => !y.has(token)).sort();
        const extra = [...y].filter((token) => !x.has(token)).sort();
        if (missing.length || extra.length) deltas.push({ kind: "class", path: element, live: missing.join(" ") || null, local: extra.join(" ") || null });
      } else if (!right.has(name)) deltas.push({ kind: "attribute-missing", path: element, attribute: name, live: text(left.get(name)) });
      else if (!left.has(name)) deltas.push({ kind: "attribute-extra", path: element, attribute: name, local: text(right.get(name)) });
      else if (text(left.get(name)) !== text(right.get(name))) deltas.push({ kind: "attribute-value", path: element, attribute: name, live: text(left.get(name)), local: text(right.get(name)) });
    }
  }
  const count = (list) => list.reduce((map, item) => map.set(item, (map.get(item) ?? 0) + 1), new Map());
  // Hosted services are reported on their own and take no part in the bundle order.
  const ha = count(live.resources.filter(hosted).map(key));
  const hb = count(local.resources.filter(hosted).map(key));
  for (const [item, n] of ha) for (let index = hb.get(item) ?? 0; index < n; index++) deltas.push({ kind: "hosted-resource-missing", path: item });
  for (const [item, n] of hb) for (let index = ha.get(item) ?? 0; index < n; index++) deltas.push({ kind: "hosted-resource-extra", path: item });
  const a = live.resources.filter((item) => !hosted(item)).map(key);
  const b = local.resources.filter((item) => !hosted(item)).map(key);
  const ca = count(a);
  const cb = count(b);
  for (const [item, n] of ca) for (let index = cb.get(item) ?? 0; index < n; index++) deltas.push({ kind: "bundle-missing", path: item });
  for (const [item, n] of cb) for (let index = ca.get(item) ?? 0; index < n; index++) deltas.push({ kind: "bundle-extra", path: item });
  const shared = (list, other) => {
    const budget = new Map(other);
    return list.filter((item) => {
      const left = budget.get(item) ?? 0;
      if (!left) return false;
      budget.set(item, left - 1);
      return true;
    });
  };
  const orderLive = shared(a, cb);
  const orderLocal = shared(b, ca);
  const first = orderLive.findIndex((item, index) => item !== orderLocal[index]);
  if (first >= 0) deltas.push({ kind: "bundle-order", path: `shared bundle ${first + 1} of ${orderLive.length}`, live: orderLive.slice(first, first + 3).join(" | "), local: orderLocal.slice(first, first + 3).join(" | ") });
  return { deltas, live: view(live), local: view(local) };
}

async function discoverTarget(driver, scenario, { side, ids, portal, liveAssets } = {}) {
  const discover = scenario.discover;
  if (discover.from === "portal") {
    // Chosen once from the exported portal and the local mappings: the same path on both sides.
    const values = {};
    for (const key of discover.keys) {
      if (portal?.[key] === undefined) return { error: `This portal has no ${PORTAL_DISCOVERY[key]}.`, notApplicable: true };
      values[key] = portal[key];
    }
    // A stylesheet the reference home page loaded is known to be deployed and public.
    const loaded = (portal?.publicWebFiles ?? []).find((url) => liveAssets?.has(url));
    if (discover.keys.includes("publicWebFile") && loaded) values.publicWebFile = loaded;
    const target = scenarioPath(scenario, values);
    try {
      assertReadOnlyPath(target);
    } catch {
      return { error: "The discovered path is on the read-only deny list." };
    }
    return { path: target };
  }
  if (discover.from === "ids") {
    // Identifiers supplied at run time from an ignored file; they never enter the tracked plan.
    const values = ids?.[discover.key]?.[side];
    if (!values || typeof values !== "object" || !Object.values(values).every((value) => typeof value === "string" && /^[\w-]{1,80}$/.test(value)))
      return { error: `No ${side} identifiers were supplied for '${discover.key}'.` };
    const target = scenarioPath(scenario, values);
    if (/\{[A-Za-z][A-Za-z0-9_]*\}/.test(target)) return { error: `The ${side} identifiers for '${discover.key}' do not fill every placeholder.` };
    try {
      assertReadOnlyPath(target);
    } catch {
      return { error: "The supplied record path is on the read-only deny list." };
    }
    return { path: target };
  }
  if (discover.from === "page") {
    if (!driver.page) return { error: "No page driver is available for discovery." };
    const expression = `(() => { const node = document.querySelector(${JSON.stringify(discover.selector)}); return node ? node.getAttribute(${JSON.stringify(discover.attribute ?? "href")}) : null; })()`;
    const observation = await driver.page(discover.path, { roots: ["head"], probeExpression: expression, settleMs: discover.settleMs ?? 1500, settleTimeout: discover.settleTimeout ?? 30000 });
    const value = observation.probeValue;
    if (typeof value !== "string" || !value) return { error: "The page rendered no matching record link." };
    let target;
    try {
      target = new URL(value, driver.origin ?? "https://portal.invalid");
    } catch {
      return { error: "The rendered record link is invalid." };
    }
    if (driver.origin && target.origin !== new URL(driver.origin).origin) return { error: "The rendered record link leaves the portal origin." };
    const relative = target.pathname + target.search;
    try {
      assertReadOnlyPath(relative);
    } catch {
      return { error: "The rendered record link is on the read-only deny list." };
    }
    if (discover.pathPattern && !new RegExp(discover.pathPattern, "i").test(target.pathname)) return { error: "The rendered record link has an unexpected path." };
    return { path: relative };
  }
  const response = await driver.http(discover.path, { accept: "application/json" });
  if (response.status !== 200) return { error: `Discovery read returned HTTP ${response.status}.` };
  let body;
  try {
    body = JSON.parse(response.body);
  } catch {
    return { error: "Discovery read did not return JSON." };
  }
  const value = (body.value ?? [])[0]?.[discover.field];
  if (typeof value !== "string" || !GUID_EXACT.test(value)) return { error: "Discovery read returned no record identifier." };
  return { path: scenarioPath(scenario, value) };
}

/** Compare the requests each page made by itself: presence, status and JSON projections. */
export function compareNetwork(live = [], local = [], { maxDeltas = 60 } = {}) {
  const key = (record) => `${record.method} ${record.url}`;
  const first = (records) => {
    const map = new Map();
    for (const record of records) if (!map.has(key(record))) map.set(key(record), { ...record, count: records.filter((item) => key(item) === key(record)).length });
    return map;
  };
  const a = first(live);
  const b = first(local);
  const deltas = [];
  for (const [name, record] of a) {
    if (!b.has(name)) {
      deltas.push({ kind: "network-missing", path: name, live: record.status });
      continue;
    }
    const other = b.get(name);
    if (record.status !== other.status) deltas.push({ kind: "network-status", path: name, live: record.status, local: other.status });
    if (record.projection && other.projection) for (const delta of compareJson(record.projection, other.projection)) deltas.push({ ...delta, kind: `network-${delta.kind}`, path: name });
  }
  for (const [name, record] of b) if (!a.has(name)) deltas.push({ kind: "network-extra", path: name, local: record.status });
  return deltas.slice(0, maxDeltas);
}

function inventory(records = []) {
  const groups = {};
  for (const record of records) {
    const prefix = PLATFORM_PREFIXES.find((item) => record.url.startsWith(item)) ?? (record.type ? `(${String(record.type).toLowerCase()})` : "(other)");
    (groups[prefix] ??= new Set()).add(`${record.method} ${record.url} → ${record.status ?? record.failed ?? "pending"}`);
  }
  return Object.fromEntries(Object.entries(groups).map(([prefix, set]) => [prefix, [...set].sort().slice(0, 60)]));
}

function summarizeNetwork(records = []) {
  return records.map((record) => ({
    method: record.method,
    url: record.url,
    type: record.type,
    status: record.status ?? null,
    contentType: record.contentType ?? null,
    ...(record.headers ? { headers: record.headers } : {}),
    ...(record.failed ? { failed: record.failed } : {}),
    ...(record.projection ? { projection: summarizeProjection(record.projection, {}) } : {}),
  }));
}

/** Run one scenario; returns a redacted result. */
async function runScenario(scenario, context) {
  const { sides, redactor, origin, localUrl, plan, outDir } = context;
  const identity = scenario.kind === "anonymous" ? "anonymous" : scenario.identity ?? "signed-in";
  const liveSide = identity === "anonymous" ? sides.anonymous : sides.live;
  const localSide = sides.local;
  const origins = [origin, localUrl];
  const result = { id: scenario.id, ...(scenario.planSource ? { planSource: scenario.planSource } : {}), kind: scenario.kind, identity, title: scenario.title, questions: scenario.questions ?? [], tags: scenario.tags ?? [], path: scenario.path ? redactUrl(scenarioPath(scenario), { origins }) : undefined, scenarioFingerprint: sha256(scenario).slice(0, 16) };
  if (!liveSide) return { ...result, verdict: "blocked", reason: `No ${identity} reference driver is available.` };
  // Local identity is a session cookie; an anonymous visitor simply sends none.
  if (context.identity) await context.identity.use(identity);
  else if (identity !== "anonymous") return { ...result, verdict: "blocked", reason: "No local sign-in is available for a signed-in comparison." };
  result.localIdentity = context.identity?.describe() ?? null;
  let livePath = scenario.path === undefined ? undefined : scenarioPath(scenario);
  let localPath = livePath;
  if (scenario.discover) {
    const liveDiscovery = await discoverTarget(liveSide, scenario, { side: "live", ids: context.ids, portal: context.portalFacts, liveAssets: context.liveShellAssets });
    if (scenario.discover.from !== "ids") await sleep(context.delayMs);
    const localDiscovery = await discoverTarget(localSide, scenario, { side: "local", ids: context.ids, portal: context.portalFacts, liveAssets: context.liveShellAssets });
    result.discovery = { live: liveDiscovery.error ?? "found", local: localDiscovery.error ?? "found" };
    // Portal-derived paths come from the export (not from live records), so the chosen path is kept.
    if (scenario.discover.from === "portal" && liveDiscovery.path) result.discovery.path = redactUrl(liveDiscovery.path, { origins });
    if (liveDiscovery.error || localDiscovery.error) return { ...result, verdict: "blocked", reason: liveDiscovery.notApplicable ? `Not applicable to this portal: ${liveDiscovery.error}` : "Record discovery did not find a comparable record on both sides." };
    livePath = liveDiscovery.path;
    localPath = localDiscovery.path;
    result.discoveredPath = { live: redactUrl(livePath, { origins }), local: redactUrl(localPath, { origins }) };
  }
  let deltas = [];
  const observations = {};
  const kind = scenario.kind;
  const pageOptions = {
    roots: scenario.roots,
    exclude: [...(plan.defaults?.exclude ?? []), ...(scenario.exclude ?? [])],
    opaque: scenario.opaque,
    dataSelectors: [...(plan.defaults?.dataSelectors ?? []), ...(scenario.dataSelectors ?? [])],
    settleMs: scenario.settleMs ?? plan.defaults?.settleMs,
    quietMs: scenario.quietMs ?? plan.defaults?.quietMs,
    settleTimeout: scenario.settleTimeout ?? plan.defaults?.settleTimeout,
    facts: scenario.facts ?? (scenario.defaultFacts === false ? [] : plan.defaults?.facts ?? []),
    probeExpression: scenario.probe?.expression,
  };
  if (["page-dom", "page-text", "error-page"].includes(kind) || (kind === "liquid-probe" && scenario.probe.source === "dom")) {
    if (!liveSide.page || !localSide.page) return { ...result, verdict: "blocked", reason: "A browser page driver is unavailable for this identity." };
    trace(scenario.id, "live page start");
    const live = await liveSide.page(livePath, pageOptions);
    trace(scenario.id, "live page done", live.status ?? "", live.unresponsive ? "unresponsive" : "");
    await sleep(context.delayMs);
    trace(scenario.id, "local page start");
    const local = await localSide.page(localPath, pageOptions);
    trace(scenario.id, "local page done", local.status ?? "", local.unresponsive ? "unresponsive" : "");
    // Live titles can name records: reveal only source-derived or local-equal titles.
    if (local.snapshot?.title) redactor.rememberLocal(normalizeText(local.snapshot.title));
    observations.live = pageDiagnostics(live, (value) => redactor.reveal(value));
    observations.local = pageDiagnostics(local);
    if (live.unresponsive || local.unresponsive) deltas.push({ kind: "page-unresponsive", live: Boolean(live.unresponsive), local: Boolean(local.unresponsive) });
    if (identity === "signed-in" && signInObserved(live)) return { ...result, observations, verdict: "blocked", reason: "The reference browser showed a sign-in page; this is not a signed-in comparison." };
    const captureIssue = captureProblem(identity, live);
    if (captureIssue) return { ...result, observations, verdict: "blocked", reason: captureIssue };
    const expectedLive = scenario.expect?.liveStatus;
    if (expectedLive !== undefined && live.status !== null && live.status !== expectedLive)
      deltas.push({ kind: "expected-live-status", live: live.status, local: expectedLive });
    if (live.status !== local.status) deltas.push({ kind: "status", live: live.status, local: local.status });
    if (live.blockedWrites.length || local.blockedWrites.length) result.blockedWrites = { live: live.blockedWrites, local: local.blockedWrites };
    if (live.facts || local.facts) {
      observations.facts = { live: live.facts, local: local.facts };
      for (const selector of new Set([...Object.keys(live.facts ?? {}), ...Object.keys(local.facts ?? {})])) {
        const a = live.facts?.[selector];
        const b = local.facts?.[selector];
        const presenceOnly = scenario.factsPresenceOnly ?? plan.defaults?.factsPresenceOnly ?? false;
        if (JSON.stringify(a) !== JSON.stringify(b) && !((a?.total ?? 0) > 0 && (b?.total ?? 0) > 0 && presenceOnly)) deltas.push({ kind: "fact", field: selector, live: a, local: b });
      }
    }
    if (scenario.network !== false && (live.network?.length || local.network?.length)) {
      observations.network = { live: summarizeNetwork(live.network), local: summarizeNetwork(local.network) };
      context.inventory.push(...(live.network ?? []).map((record) => ({ ...record, scenario: scenario.id })));
    }
    for (const asset of live.assets ?? []) context.assets.set(asset, [...new Set([...(context.assets.get(asset) ?? []), scenario.id])]);
    if (scenario.network !== false && (live.network?.length || local.network?.length)) {
      if (scenario.compareNetwork !== false) deltas.push(...compareNetwork(live.network, local.network));
    }
    const prepare = (observation) =>
      (observation.snapshot?.roots ?? []).map((root) => ({
        selector: root.selector,
        count: root.count,
        trees: root.nodes.map((node) => prepareTree(node, { origins, ignoreClasses: [...(plan.defaults?.ignoreClasses ?? []), ...(scenario.ignoreClasses ?? [])], ignoreAttributes: [...(plan.defaults?.ignoreAttributes ?? []), ...(scenario.ignoreAttributes ?? [])] })),
      }));
    const liveRoots = prepare(live);
    const localRoots = prepare(local);
    for (const root of localRoots) for (const tree of root.trees) rememberLocalTree(tree, redactor);
    if (kind === "liquid-probe") {
      const liveText = liveRoots[0]?.trees[0] ? treeText(liveRoots[0].trees[0]).map((line) => line.text).join(" ") : null;
      const localText = localRoots[0]?.trees[0] ? treeText(localRoots[0].trees[0]).map((line) => line.text).join(" ") : null;
      redactor.rememberLocal(localText ?? "");
      observations.probe = { live: liveText === null ? null : redactor.reveal(liveText), local: localText };
      if (liveText !== localText) deltas.push({ kind: "probe-text", live: liveText, local: localText });
    } else {
      for (let index = 0; index < Math.max(liveRoots.length, localRoots.length); index++) {
        const a = liveRoots[index];
        const b = localRoots[index];
        const selector = a?.selector ?? b?.selector;
        if ((a?.count ?? 0) !== (b?.count ?? 0)) deltas.push({ kind: "root-count", path: selector, live: a?.count ?? 0, local: b?.count ?? 0 });
        const pairs = Math.min(a?.trees.length ?? 0, b?.trees.length ?? 0);
        for (let i = 0; i < pairs; i++) {
          if (kind === "page-text") {
            const comparison = compareTextLines(treeText(a.trees[i]), treeText(b.trees[i]), { maxDeltas: scenario.maxDeltas ?? 250 });
            deltas.push(...comparison.deltas.map((delta) => ({ ...delta, path: `${selector} ${delta.path}` })));
            if (comparison.truncated) result.truncatedDeltas = (result.truncatedDeltas ?? 0) + comparison.total - comparison.deltas.length;
          } else {
            const comparison = compareTrees(a.trees[i], b.trees[i], { maxDeltas: scenario.maxDeltas ?? 250 });
            deltas.push(...comparison.deltas);
            if (comparison.truncated) result.truncatedDeltas = (result.truncatedDeltas ?? 0) + comparison.total - comparison.deltas.length;
          }
        }
        if (scenario.saveTrees !== false && outDir) {
          const directory = path.join(outDir, "scenarios", scenario.id);
          await fs.mkdir(directory, { recursive: true });
          await fs.writeFile(path.join(directory, `root-${index + 1}.live.json`), JSON.stringify((a?.trees ?? []).map((tree) => redactTree(tree, redactor, "live")), null, 1));
          await fs.writeFile(path.join(directory, `root-${index + 1}.local.json`), JSON.stringify((b?.trees ?? []).map((tree) => redactTree(tree, redactor, "local")), null, 1));
        }
      }
      // Text-free structural digests let later runs detect reference-page drift without values.
      result.structureFingerprint = {
        live: sha256(liveRoots.map((root) => root.trees.map(shapeOf))).slice(0, 16),
        local: sha256(localRoots.map((root) => root.trees.map(shapeOf))).slice(0, 16),
      };
    }
  } else if (kind === "page-shell") {
    // Document shell: title, html/body attributes and the order of script and stylesheet bundles.
    if (!liveSide.page || !localSide.page) return { ...result, verdict: "blocked", reason: "A browser page driver is unavailable for this identity." };
    const shellOptions = { ...pageOptions, roots: ["head"], facts: [], probeExpression: `(${shellFacts.toString()})()` };
    trace(scenario.id, "live shell start");
    const live = await liveSide.page(livePath, shellOptions);
    await sleep(context.delayMs);
    trace(scenario.id, "local shell start");
    const local = await localSide.page(localPath, shellOptions);
    const parse = (value) => {
      try {
        return typeof value === "string" ? JSON.parse(value) : null;
      } catch {
        return null;
      }
    };
    const a = parse(live.probeValue);
    const b = parse(local.probeValue);
    if (b?.title) redactor.rememberLocal(normalizeText(b.title));
    observations.live = pageDiagnostics(live, (value) => redactor.reveal(value));
    observations.local = pageDiagnostics(local);
    if (identity === "signed-in" && signInObserved(live)) return { ...result, observations, verdict: "blocked", reason: "The reference browser showed a sign-in page; this is not a signed-in comparison." };
    const captureIssue = captureProblem(identity, live);
    if (captureIssue) return { ...result, observations, verdict: "blocked", reason: captureIssue };
    if (live.status !== local.status) deltas.push({ kind: "status", live: live.status, local: local.status });
    if (!a || !b) deltas.push({ kind: "shell-unavailable", live: Boolean(a), local: Boolean(b) });
    else {
      const comparison = compareShell(a, b, { origins });
      deltas.push(...comparison.deltas);
      // Same-origin resources the reference page loaded (used to pick a deployed public web file).
      context.liveShellAssets ??= new Set(a.resources.map((item) => item.path).filter((item) => item.startsWith("/")));
      observations.shell = { live: { ...comparison.live, title: redactor.reveal(comparison.live.title) }, local: comparison.local };
    }
  } else if (kind === "client-object") {
    // Platform client objects: the same key sets, in the same order, with the same value types.
    if (!liveSide.page || !localSide.page) return { ...result, verdict: "blocked", reason: "A browser page driver is unavailable for this identity." };
    const objectOptions = { ...pageOptions, roots: ["head"], facts: [], probeExpression: `(${clientObjectFacts.toString()})()` };
    trace(scenario.id, "live client object start");
    const live = await liveSide.page(livePath, objectOptions);
    await sleep(context.delayMs);
    trace(scenario.id, "local client object start");
    const local = await localSide.page(localPath, objectOptions);
    const parse = (value) => {
      try {
        return typeof value === "string" ? JSON.parse(value) : null;
      } catch {
        return null;
      }
    };
    const a = parse(live.probeValue);
    const b = parse(local.probeValue);
    observations.live = pageDiagnostics(live, (value) => redactor.reveal(value));
    observations.local = pageDiagnostics(local);
    if (identity === "signed-in" && signInObserved(live)) return { ...result, observations, verdict: "blocked", reason: "The reference browser showed a sign-in page; this is not a signed-in comparison." };
    const captureIssue = captureProblem(identity, live);
    if (captureIssue) return { ...result, observations, verdict: "blocked", reason: captureIssue };
    if (live.status !== local.status) deltas.push({ kind: "status", live: live.status, local: local.status });
    if (!a || !b) deltas.push({ kind: "client-object-unavailable", live: Boolean(a), local: Boolean(b) });
    else {
      deltas.push(...compareClientObject(a, b));
      observations.clientObject = { live: clientObjectSummary(a), local: clientObjectSummary(b) };
    }
  } else if (kind === "webfile-drift") {
    // Source-versus-deployment signal: deployed web-file bytes (cookie-free reads) against the
    // bytes the local runtime serves from the export. Differences explain page deltas without
    // implying a runtime defect.
    const candidates = [...new Set([...(scenario.paths ?? []), ...(scenario.fromPages ? [...context.assets.keys()] : [])])].slice(0, scenario.max ?? 80);
    const files = [];
    for (const target of candidates) {
      try {
        assertReadOnlyPath(target);
      } catch {
        continue;
      }
      const deployed = await sides.anonymous.http(target, { accept: "*/*", raw: true, redirect: "manual" });
      await sleep(Math.min(context.delayMs, 250));
      const served = await localSide.http(target, { accept: "*/*", raw: true, redirect: "manual" });
      const verdict = deployed.status !== 200 ? `live-${deployed.status}` : served.status !== 200 ? `local-${served.status}` : compareBytes(deployed.body, served.body);
      files.push({ path: redactUrl(target), verdict, liveBytes: deployed.body?.length ?? 0, localBytes: served.body?.length ?? 0, usedBy: context.assets.get(target) ?? [] });
      if (verdict === "different") deltas.push({ kind: "webfile-drift", path: redactUrl(target), live: deployed.body.length, local: served.body.length });
      else if (verdict.startsWith("local-")) deltas.push({ kind: "webfile-local-status", path: redactUrl(target), live: deployed.status, local: served.status });
    }
    const counts = {};
    for (const file of files) counts[file.verdict] = (counts[file.verdict] ?? 0) + 1;
    observations.webFiles = { counts, files };
    context.drift = new Set(files.filter((file) => file.verdict === "different").map((file) => file.path));
  } else if (kind === "reference-contracts") {
    const { compareReferenceContracts } = await import("./reference-parity.mjs");
    const contracts = JSON.parse(await fs.readFile(path.resolve(ROOT, scenario.plan), "utf8"));
    if (!sides.live?.http) return { ...result, verdict: "blocked", reason: "The signed-in reference driver is unavailable." };
    const bridge = {
      request: async (target, { prefer } = {}) => {
        const response = await sides.live.http(target, { prefer, accept: "application/json" });
        await sleep(context.delayMs);
        return { status: response.status, body: Buffer.from(response.body ?? "") };
      },
    };
    const report = await compareReferenceContracts({ localUrl, origin, contracts, outputDir: path.join(outDir, "scenarios", scenario.id), bridge });
    observations.contracts = report.contracts.map((contract) => ({ id: contract.id, passed: contract.passed, referenceStatus: contract.referenceStatus, localStatus: contract.localStatus, referenceCount: contract.referenceCount, localCount: contract.localCount, error: contract.error }));
    observations.stateUnchanged = report.stateUnchanged;
    for (const contract of report.contracts) if (!contract.passed) deltas.push({ kind: "contract", field: contract.id, live: contract.referenceStatus, local: contract.localStatus, path: contract.error });
  } else {
    const request = { prefer: scenario.prefer, accept: scenario.accept ?? (kind === "api-json" || kind === "api-status" ? "application/json" : "text/html,application/xhtml+xml"), redirect: scenario.redirect ?? (kind === "anonymous" ? "manual" : undefined) };
    // Signed-in raw documents come from a real navigation when the driver supports it.
    const useSource = identity === "signed-in" && liveSide.source && (scenario.via === "navigation" || (kind === "liquid-probe" && scenario.via !== "fetch"));
    const live = useSource ? await liveSide.source(livePath, pageOptions) : await liveSide.http(livePath, request);
    await sleep(context.delayMs);
    const local = await localSide.http(localPath, request);
    const view = (response) => ({
      status: response.status,
      type: response.type,
      finalPath: response.finalPath ? redactUrl(response.finalPath, { origins }) : null,
      contentType: response.headers?.["content-type"] ?? null,
      ms: response.ms,
      bytes: response.body?.length ?? 0,
      ...(response.blockedWrites?.length ? { blockedWrites: response.blockedWrites } : {}),
      ...(response.fulfilledWrites?.length ? { fulfilledWrites: response.fulfilledWrites } : {}),
    });
    observations.live = view(live);
    observations.local = view(local);
    if (useSource) observations.live.via = "navigation";
    const expected = scenario.expect ?? {};
    if (expected.liveStatus !== undefined && live.status !== expected.liveStatus) deltas.push({ kind: "expected-live-status", live: live.status, local: expected.liveStatus });
    if (kind !== "anonymous" && live.status !== local.status) deltas.push({ kind: "status", live: live.status, local: local.status });
    if (scenario.headerNames) {
      const names = (headers) => Object.keys(headers ?? {}).map((name) => name.toLowerCase()).filter((name) => name !== "set-cookie").sort();
      observations.headerNames = { live: names(live.headers), local: names(local.headers) };
    }
    if (scenario.cookies && live.cookies) observations.cookies = { live: live.cookies, local: local.cookies ?? [] };
    if (scenario.conditional && live.headers?.etag !== undefined) {
      observations.etag = { live: etagShape(live.headers.etag), local: etagShape(local.headers?.etag) };
      const liveAgain = await liveSide.http(livePath, { ...request, ifNoneMatch: live.headers.etag });
      await sleep(context.delayMs);
      const localAgain = local.headers?.etag ? await localSide.http(localPath, { ...request, ifNoneMatch: local.headers.etag }) : { status: null };
      observations.conditional = { live: liveAgain.status, local: localAgain.status };
      if (liveAgain.status !== localAgain.status) deltas.push({ kind: "conditional-status", live: liveAgain.status, local: localAgain.status });
    }
    if (kind === "api-json") {
      const projectionOptions = { collection: scenario.collection ?? "value", compareValues: scenario.compareValues ?? [], referenceData: scenario.referenceData === true };
      const pages = [{ live: projectJson(live.body, projectionOptions), local: projectJson(local.body, projectionOptions) }];
      let liveBody = live.body;
      let localBody = local.body;
      for (let page = 2; page <= (scenario.followNextLink ? scenario.followNextLink + 1 : 0); page++) {
        const next = (text) => {
          try {
            return JSON.parse(text)["@odata.nextLink"] ?? null;
          } catch {
            return null;
          }
        };
        const liveNext = next(liveBody);
        const localNext = next(localBody);
        if (!liveNext || !localNext) {
          if (Boolean(liveNext) !== Boolean(localNext)) deltas.push({ kind: "next-link", path: `page ${page}`, live: Boolean(liveNext), local: Boolean(localNext) });
          break;
        }
        const relative = (link, base) => {
          const url = new URL(link, base);
          return url.pathname + url.search;
        };
        const livePage = await liveSide.http(relative(liveNext, origin), request);
        await sleep(context.delayMs);
        const localPage = await localSide.http(relative(localNext, localUrl), request);
        liveBody = livePage.body;
        localBody = localPage.body;
        if (livePage.status !== localPage.status) deltas.push({ kind: "status", path: `page ${page}`, live: livePage.status, local: localPage.status });
        pages.push({ live: projectJson(livePage.body, projectionOptions), local: projectJson(localPage.body, projectionOptions) });
      }
      if (scenario.fetchXmlPaging) {
        let liveCookie = pagingCookieOf(live.body);
        let localCookie = pagingCookieOf(local.body);
        for (let page = 2; page <= scenario.fetchXmlPaging; page++) {
          if (!liveCookie || !localCookie) {
            if (Boolean(liveCookie) !== Boolean(localCookie)) deltas.push({ kind: "paging-cookie", path: `page ${page}`, live: Boolean(liveCookie), local: Boolean(localCookie) });
            break;
          }
          const livePage = await liveSide.http(withFetchXmlPage(livePath, page, liveCookie), request);
          await sleep(context.delayMs);
          const localPage = await localSide.http(withFetchXmlPage(localPath, page, localCookie), request);
          if (livePage.status !== localPage.status) deltas.push({ kind: "status", path: `page ${page}`, live: livePage.status, local: localPage.status });
          pages.push({ live: projectJson(livePage.body, projectionOptions), local: projectJson(localPage.body, projectionOptions) });
          liveCookie = pagingCookieOf(livePage.body);
          localCookie = pagingCookieOf(localPage.body);
        }
      }
      pages.forEach((pair, index) => {
        const pageDeltas = compareJson(pair.live, pair.local, { compareCount: scenario.compareCount === true, compareValues: Boolean(scenario.compareValues?.length) || scenario.referenceData === true, unordered: scenario.unordered === true, ignoreTopKeys: scenario.ignoreTopKeys ?? [] });
        deltas.push(...pageDeltas.map((delta) => ({ ...delta, path: delta.path ?? (pages.length > 1 ? `page ${index + 1}` : undefined) })));
      });
      observations.projection = pages.map((pair) => ({ live: summarizeProjection(pair.live, scenario, redactor), local: summarizeProjection(pair.local, scenario) }));
      if (scenario.preferenceApplied) observations.preferenceApplied = { live: live.headers?.["preference-applied"] ?? null, local: local.headers?.["preference-applied"] ?? null };
    } else if (kind === "api-status") {
      const a = projectJson(live.body);
      const b = projectJson(local.body);
      observations.errorShape = { live: summarizeProjection(a, scenario, redactor), local: summarizeProjection(b, scenario) };
      if (scenario.compareBody !== false && (a.kind === "error" || b.kind === "error")) deltas.push(...compareJson(a, b));
    } else if (kind === "headers") {
      const names = scenario.headers ?? ["content-type", "cache-control", "x-frame-options", "content-security-policy"];
      const a = projectHeaders(live.headers, names);
      const b = projectHeaders(local.headers, names);
      observations.headers = { live: a, local: b };
      deltas.push(...compareHeaders(a, b));
    } else if (kind === "anonymous") {
      const a = { status: statusClass(live.status), exact: live.status, location: classifyLocation(live.headers?.location, { origin }) };
      const b = { status: statusClass(local.status), exact: local.status, location: classifyLocation(local.headers?.location, { origin: localUrl }) };
      observations.redirect = { live: a, local: b };
      if (live.status !== local.status) deltas.push({ kind: "status", live: live.status, local: local.status });
      for (const field of ["kind", "absolute", "signIn", "languagePrefix", "returnKey", "returnPath", "returnQueryNames", "hexCase", "path"])
        if (JSON.stringify(a.location[field] ?? null) !== JSON.stringify(b.location[field] ?? null))
          deltas.push({ kind: "redirect", field, live: a.location[field] ?? null, local: b.location[field] ?? null });
      if (scenario.bodyTitle) {
        const title = (html) => normalizeText(decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html ?? ""))?.[1] ?? ""));
        const liveTitle = title(live.body);
        const localTitle = title(local.body);
        redactor.rememberLocal(localTitle);
        observations.bodyTitle = { live: redactor.reveal(liveTitle), local: localTitle };
        if (liveTitle !== localTitle) deltas.push({ kind: "body-title", live: liveTitle, local: localTitle });
      }
    } else if (kind === "liquid-probe") {
      const probe = scenario.probe;
      const a = extractProbe(live.body, probe);
      const b = extractProbe(local.body, probe);
      const compare = probe.compare ?? "exact";
      let liveView;
      let localView;
      if (compare === "classification") {
        liveView = a.found ? classifyLiteral(a.value) : { classification: "absent" };
        localView = b.found ? classifyLiteral(b.value) : { classification: "absent" };
        if (liveView.classification !== localView.classification) deltas.push({ kind: "probe-classification", live: liveView.classification, local: localView.classification });
      } else if (compare === "mask") {
        liveView = { found: a.found, mask: a.found ? formatMask(a.value) : null };
        localView = { found: b.found, mask: b.found ? formatMask(b.value) : null };
        if (liveView.mask !== localView.mask) deltas.push({ kind: "probe-mask", live: liveView.mask, local: localView.mask });
      } else if (compare === "hex-case") {
        liveView = { found: a.found, case: a.found ? letterCase(a.value) : null };
        localView = { found: b.found, case: b.found ? letterCase(b.value) : null };
        if (liveView.case !== localView.case) deltas.push({ kind: "probe-case", live: liveView.case, local: localView.case });
      } else if (compare === "match-count") {
        // Number of occurrences only (for example rows returned by a Liquid JSON endpoint).
        const occurrences = (text) => [...String(text ?? "").matchAll(new RegExp(probe.regex, `${(probe.flags ?? "").replace("g", "")}g`))].length;
        liveView = { count: occurrences(live.body) };
        localView = { count: occurrences(local.body) };
        if (probe.atMost !== undefined) {
          liveView.withinLimit = liveView.count <= probe.atMost;
          localView.withinLimit = localView.count <= probe.atMost;
          if (liveView.withinLimit !== localView.withinLimit) deltas.push({ kind: "probe-limit", live: liveView.withinLimit, local: localView.withinLimit });
        }
      } else if (compare === "class-raw") {
        // Raw class attribute spelling: token list plus how separators were encoded (&#32; vs spaces).
        const classView = (value) => ({ tokens: String(value).split(/\s+|&#32;/).filter(Boolean).sort(), entitySpaces: (String(value).match(/&#32;/g) ?? []).length, plainSpaces: (String(value).match(/ /g) ?? []).length });
        liveView = { found: a.found, ...(a.found ? classView(a.value) : {}) };
        localView = { found: b.found, ...(b.found ? classView(b.value) : {}) };
        if (JSON.stringify(liveView) !== JSON.stringify(localView)) deltas.push({ kind: "probe-class", live: liveView, local: localView });
      } else if (compare === "tag-shape") {
        liveView = { found: a.found, shape: a.found ? tagShape(a.value) : null };
        localView = { found: b.found, shape: b.found ? tagShape(b.value) : null };
        if (liveView.shape !== localView.shape) deltas.push({ kind: "probe-shape", live: liveView.shape, local: localView.shape });
      } else if (compare === "roles") {
        const roleNames = (await localState(localUrl)).status.webRoles.map((role) => role.name);
        const liveRoles = a.found ? segmentRoles(a.value, roleNames) : null;
        const localRoles = b.found ? segmentRoles(b.value, roleNames) : null;
        liveView = { found: a.found, segmented: Boolean(liveRoles), roles: liveRoles ? [...liveRoles].sort() : null, order: liveRoles ?? null };
        localView = { found: b.found, segmented: Boolean(localRoles), roles: localRoles ? [...localRoles].sort() : null, order: localRoles ?? null };
        if (!liveRoles || !localRoles) deltas.push({ kind: "probe-format", live: liveView.segmented, local: localView.segmented });
        else if (JSON.stringify(liveView.roles) !== JSON.stringify(localView.roles)) deltas.push({ kind: "probe-roles", live: liveView.roles, local: localView.roles });
      } else {
        const normalizeProbe = (value) => (value === undefined ? null : normalizeText(value, { origins }));
        const liveText = a.found ? normalizeProbe(a.value) : null;
        const localText = b.found ? normalizeProbe(b.value) : null;
        if (localText) redactor.rememberLocal(localText);
        // Platform markup whose only variable attributes were replaced before storage may be kept.
        const sanitized = probe.revealSanitized === true && probe.redactAttributes?.length > 0;
        // A probe that only captures platform markup or an echo of the scenario's own synthetic input
        // may keep the live value; the plan states why (revealReason).
        if ((sanitized || probe.revealLive === true) && liveText) redactor.rememberLocal(liveText);
        liveView = { found: a.found, value: liveText === null ? null : redactor.reveal(liveText) };
        localView = { found: b.found, value: localText };
        if (liveText !== localText) deltas.push({ kind: "probe-text", live: liveText, local: localText });
      }
      observations.probe = { live: liveView, local: localView };
    }
  }
  const classified = deltas.map((delta) => {
    const classification = classifyDelta(delta, scenario.id, rulesFor(plan, scenario));
    return { ...redactDelta(delta, redactor), classification };
  });
  const byClass = {};
  for (const delta of classified) byClass[delta.classification.class] = (byClass[delta.classification.class] ?? 0) + 1;
  const unexpected = classified.filter((delta) => !EXPECTED_CLASSES.has(delta.classification.class));
  const verdict = !classified.length ? "pass" : !unexpected.length ? "pass-with-expected-deltas" : "delta";
  return { ...result, observations, deltas: classified, deltaCounts: byClass, verdict, owners: [...new Set(unexpected.map((delta) => delta.classification.owner).filter(Boolean))].sort() };
}

function pagingCookieOf(text) {
  try {
    const body = JSON.parse(text);
    const raw = body["@Microsoft.Dynamics.CRM.fetchxmlpagingcookie"];
    if (!raw || (body["@Microsoft.Dynamics.CRM.morerecords"] !== true && body["@Microsoft.Dynamics.CRM.morerecords"] !== "true")) return null;
    return decodePagingCookie(raw);
  } catch {
    return null;
  }
}

/** Rewrite a FetchXML query path to request another page with a paging cookie (never saved). */
export function withFetchXmlPage(target, page, cookie) {
  const url = new URL(target, "https://portal.invalid");
  const xml = url.searchParams.get("fetchXml");
  if (!xml) throw new Error("FetchXML paging requires a fetchXml query.");
  const escaped = String(cookie).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const updated = xml.replace(/<fetch\b([^>]*)>/i, (match, attrs) => {
    const cleaned = attrs.replace(/\s(?:page|paging-cookie)\s*=\s*(?:"[^"]*"|'[^']*')/gi, "");
    return `<fetch${cleaned} page="${page}" paging-cookie="${escaped}">`;
  });
  url.searchParams.set("fetchXml", updated);
  return url.pathname + url.search;
}

function summarizeProjection(projection, scenario, redactor) {
  if (!projection) return null;
  if (projection.kind === "error") {
    // Platform error messages describe the runner's own synthetic query (tables/columns), so they
    // are kept after normalisation; identifiers and numbers are generalised.
    return { kind: "error", keys: projection.keys, error: { keys: projection.error.keys, code: projection.error.code, codeShape: projection.error.codeShape, innerKeys: projection.error.innerKeys, message: projection.error.message === null ? null : normalizeText(projection.error.message).slice(0, 300) } };
  }
  const summary = { ...projection };
  if (summary.values && !(scenario.referenceData === true || scenario.compareValues?.length)) delete summary.values;
  if (summary.values) {
    summary.valueDigest = sha256(summary.values).slice(0, 16);
    summary.valueRows = summary.values.length;
    if (summary.values.length > 40) summary.values = summary.values.slice(0, 40);
  }
  return summary;
}

/**
 * Derive the signed-in reference user's web roles from the rendered `{{ user.roles }}` hidden
 * input (segmented against exported role names) and check them against page-access outcomes
 * observed through real navigations.
 */
export async function derivePersona({ live, roleNames, probe = {}, accessChecks = [], delayMs = 400 }) {
  const expression = `(() => { const node = document.querySelector(${JSON.stringify(probe.selector ?? "#userroles")}); return node ? node.value ?? node.getAttribute("value") : null; })()`;
  const home = await live.page(probe.path ?? "/", { roots: ["head"], probeExpression: expression, settleMs: 500 });
  const value = home.probeValue;
  const roles = typeof value === "string" ? segmentRoles(value, roleNames) : null;
  const evidence = { method: "Rendered {{ user.roles }} hidden input (#userroles) segmented against exported web-role names; cross-checked with page-access outcomes of restricted pages.", markupFound: typeof value === "string", segmented: Boolean(roles), roles: roles ? [...roles].sort() : null, renderedOrder: roles ?? null };
  const observations = [];
  for (const check of accessChecks) {
    await sleep(delayMs);
    const response = live.source ? await live.source(check.path, { settleMs: 200 }) : await live.http(check.path, { accept: "text/html", redirect: "follow" });
    const finalPath = response.finalPath ?? "";
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(response.body ?? ""))?.[1] ?? "";
    const accessible = response.status === 200 && !/access-denied|signin|login/i.test(finalPath) && !/Access Denied/i.test(title);
    observations.push({ path: check.path, rolesAny: check.rolesAny, accessible, status: response.status, finalPath: redactUrl(finalPath) });
  }
  evidence.accessChecks = roles ? checkPersonaAccess(roles, observations).map((item, index) => ({ ...item, status: observations[index].status })) : observations.map(({ path: checkPath, accessible, status }) => ({ path: checkPath, accessible, status }));
  evidence.consistent = Boolean(roles) && evidence.accessChecks.every((check) => check.consistent);
  return evidence;
}

/** Execute a validated plan against prepared drivers and write report.json + summary.md. */
export async function runParitySuite({ plan, localUrl, origin, sides, identity = null, localAnonymous = false, portalFacts = null, outDir, only, tags, excludeTags, delayMs = 400, corpus = null, persona = null, label = "run", conditions = [], ids = null }) {
  validatePlan(plan);
  if (!outDir) throw new Error("An ignored evidence output directory is required.");
  const local = new URL(localUrl);
  if (local.protocol !== "http:" || !loopbackHost(local.hostname)) throw new Error("The local runtime must be an HTTP loopback origin.");
  const reference = new URL(origin);
  if (reference.protocol !== "https:" && !loopbackHost(reference.hostname)) throw new Error("The reference origin must be HTTPS (loopback only in tests).");
  await fs.mkdir(outDir, { recursive: true });
  const redactor = createRedactor({ corpus });
  const before = await localState(local.origin);
  const dataBefore = await localDataFingerprint(local.origin);
  const report = {
    version: 1,
    label,
    time: new Date().toISOString(),
    referenceOrigin: reference.origin,
    localOrigin: local.origin,
    planFingerprint: sha256(plan).slice(0, 16),
    fingerprints: {
      source: before.status?.sourceFingerprint ?? null,
      implementation: before.status?.implementationFingerprint ?? null,
      loadedImplementation: before.status?.loadedImplementationFingerprint ?? null,
      dataBefore: dataBefore.slice(0, 16),
      configuration: sha256({ ...before.config, identity: undefined, contactRoles: undefined, live: undefined, mappings: undefined, presets: undefined, permissions: undefined }).slice(0, 16),
    },
    persona,
    conditions: [...(plan.conditions ?? []), ...conditions],
    localRuntime: {
      deploymentProfileApplied: (before.diagnostics ?? []).some((item) => String(item.code ?? "").startsWith("DEPLOYMENT_PROFILE")),
      solutionRoots: before.status?.bootstrap?.solutionRoots?.map?.((root) => path.basename(String(root))) ?? null,
      presets: (before.status?.availablePresets ?? []).map((preset) => preset.id ?? preset).filter((id) => typeof id === "string").slice(0, 20),
      pageCount: before.status?.pageCount ?? null,
    },
    ...(plan.sources ? { planSources: plan.sources } : {}),
    ...(portalFacts ? { portalDiscovery: portalFacts } : {}),
    scenarios: [],
  };
  let selected = only?.length ? plan.scenarios.filter((scenario) => only.includes(scenario.id)) : plan.scenarios;
  if (tags?.length) selected = selected.filter((scenario) => (scenario.tags ?? []).some((tag) => tags.includes(tag)));
  if (excludeTags?.length) selected = selected.filter((scenario) => !(scenario.tags ?? []).some((tag) => excludeTags.includes(tag)));
  // Signed-in scenarios first, then anonymous ones, to minimise local identity switches.
  // Web-file drift runs last so it can use every web file the compared pages loaded.
  const ordered = [
    ...selected.filter((scenario) => scenario.kind !== "anonymous" && scenario.kind !== "webfile-drift" && (scenario.identity ?? "signed-in") === "signed-in"),
    ...selected.filter((scenario) => scenario.kind !== "webfile-drift" && (scenario.kind === "anonymous" || scenario.identity === "anonymous")),
    ...selected.filter((scenario) => scenario.kind === "webfile-drift"),
  ];
  const context = { sides, redactor, origin: reference.origin, localUrl: local.origin, plan, outDir, delayMs, identity, localAnonymous, portalFacts, inventory: [], assets: new Map(), ids };
  const runOne = async (scenario) => {
    const started = Date.now();
    let result;
    try {
      // Each scenario has a wall-clock budget so one stalled page cannot hold the whole run.
      result = await within(runScenario(scenario, context), scenario.timeoutMs ?? plan.defaults?.scenarioTimeoutMs ?? 300000, `Scenario ${scenario.id}`);
    } catch (error) {
      result = { id: scenario.id, kind: scenario.kind, questions: scenario.questions ?? [], verdict: "error", error: normalizeText(String(error.message).split("\n")[0], { origins: [reference.origin, local.origin] }).slice(0, 400) };
      // Runner frames only (file/line), never values: helps locate harness defects.
      if (process.env.PARITY_DEBUG) result.stack = String(error.stack ?? "").split("\n").slice(1, 6).map((line) => line.trim().replace(/\(.*[\\/]/, "(")).join(" | ");
    }
    result.ms = Date.now() - started;
    return result;
  };
  for (const scenario of ordered) {
    report.scenarios.push(await runOne(scenario));
    await sleep(delayMs);
  }
  // A scenario that failed on a transient network error (no response at all) gets one more
  // attempt at the end of the run; the first error stays on the record.
  for (const [index, result] of report.scenarios.entries()) {
    if (result.verdict !== "error" || !/fetch failed|UND_ERR_|ECONNRESET|ETIMEDOUT|socket hang up/i.test(result.error ?? "")) continue;
    await sleep(Math.max(delayMs, 10000));
    const retried = await runOne(ordered.find((scenario) => scenario.id === result.id));
    report.scenarios[index] = { ...retried, retriedAfter: result.error };
  }
  const after = await localState(local.origin);
  const dataAfter = await localDataFingerprint(local.origin);
  report.fingerprints.dataAfter = dataAfter.slice(0, 16);
  report.localDataUnchanged = dataBefore === dataAfter;
  report.localSourceUnchanged = before.status?.sourceFingerprint === after.status?.sourceFingerprint && before.status?.implementationFingerprint === after.status?.implementationFingerprint;
  summarizeTotals(report, plan);
  report.networkInventory = inventory(context.inventory);
  report.report = path.join(path.resolve(outDir), "report.json");
  await fs.writeFile(report.report, JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(outDir, "summary.md"), summaryMarkdown(report));
  return report;
}

/** Verdict, class, owner and question totals derived from the scenario results. */
function summarizeTotals(report, plan) {
  report.totals = {};
  for (const scenario of report.scenarios) report.totals[scenario.verdict] = (report.totals[scenario.verdict] ?? 0) + 1;
  report.deltaClasses = {};
  report.owners = {};
  for (const scenario of report.scenarios)
    for (const delta of scenario.deltas ?? []) {
      report.deltaClasses[delta.classification.class] = (report.deltaClasses[delta.classification.class] ?? 0) + 1;
      if (delta.classification.owner) report.owners[delta.classification.owner] = (report.owners[delta.classification.owner] ?? 0) + 1;
    }
  report.questions = {};
  for (const scenario of report.scenarios)
    for (const question of scenario.questions ?? []) (report.questions[question] ??= []).push({ scenario: scenario.id, verdict: scenario.verdict });
  report.questionsNotObservable = plan.notObservable ?? [];
}

/**
 * Re-apply the plan's classification rules to a saved (already redacted) report without new
 * requests. Deltas keep their recorded values; only classes, owners and verdicts change.
 */
export function reclassifyReport(report, plan) {
  validatePlan(plan);
  for (const scenario of report.scenarios) {
    if (!scenario.deltas) continue;
    for (const delta of scenario.deltas) delta.classification = classifyDelta(delta, scenario.id, rulesFor(plan, scenario));
    const byClass = {};
    for (const delta of scenario.deltas) byClass[delta.classification.class] = (byClass[delta.classification.class] ?? 0) + 1;
    scenario.deltaCounts = byClass;
    const unexpected = scenario.deltas.filter((delta) => !EXPECTED_CLASSES.has(delta.classification.class));
    const captureIssue = scenario.verdict === "error" ? null : captureProblem(scenario.identity, scenario.observations?.live);
    if (captureIssue) {
      scenario.verdict = "blocked";
      scenario.reason = captureIssue;
    }
    if (!["blocked", "error"].includes(scenario.verdict)) scenario.verdict = !scenario.deltas.length ? "pass" : !unexpected.length ? "pass-with-expected-deltas" : "delta";
    scenario.owners = [...new Set(unexpected.map((delta) => delta.classification.owner).filter(Boolean))].sort();
  }
  summarizeTotals(report, plan);
  report.reclassifiedAt = new Date().toISOString();
  report.classificationPlanFingerprint = sha256(plan).slice(0, 16);
  return report;
}

/** Human-readable summary; contains only redacted content from the report. */
export function summaryMarkdown(report) {
  const lines = [];
  lines.push(`# Parity suite: ${report.label}`, "");
  lines.push(`- Time: ${report.time}`);
  lines.push(`- Reference: ${report.referenceOrigin}`);
  lines.push(`- Local: ${report.localOrigin}`);
  lines.push(`- Plan fingerprint: ${report.planFingerprint}`);
  lines.push(`- Source fingerprint: ${report.fingerprints.source ?? "unavailable"}`);
  lines.push(`- Implementation fingerprint: ${report.fingerprints.implementation ?? "unavailable"}`);
  lines.push(`- Local data unchanged during run: ${report.localDataUnchanged}`);
  if (report.persona) lines.push(`- Persona: ${report.persona.roles ? report.persona.roles.join(", ") : "not derived"} (consistent with access checks: ${report.persona.consistent})`);
  for (const condition of report.conditions ?? []) lines.push(`- Condition: ${condition}`);
  lines.push("", "## Totals", "");
  lines.push(Object.entries(report.totals).map(([verdict, count]) => `${verdict}: ${count}`).join(" · "));
  lines.push("", "Delta classes: " + (Object.entries(report.deltaClasses).map(([name, count]) => `${name} ${count}`).join(" · ") || "none"));
  lines.push("Runtime-gap owners: " + (Object.entries(report.owners).map(([owner, count]) => `${owner} ${count}`).join(" · ") || "none"));
  lines.push("", "## Scenarios", "", "| Scenario | Kind | Identity | Live | Local | Verdict | Deltas | ms |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const scenario of report.scenarios) {
    const live = scenario.observations?.live?.status ?? scenario.observations?.redirect?.live?.exact ?? "";
    const local = scenario.observations?.local?.status ?? scenario.observations?.redirect?.local?.exact ?? "";
    const deltas = Object.entries(scenario.deltaCounts ?? {}).map(([name, count]) => `${name}:${count}`).join(" ") || (scenario.reason ?? scenario.error ?? "");
    lines.push(`| ${scenario.id} | ${scenario.kind} | ${scenario.identity ?? ""} | ${live} | ${local} | ${scenario.verdict} | ${String(deltas).replace(/\|/g, "/")} | ${scenario.ms ?? ""} |`);
  }
  const notable = report.scenarios.flatMap((scenario) => (scenario.deltas ?? []).filter((delta) => delta.classification.class !== "data-difference").slice(0, 8).map((delta) => ({ scenario: scenario.id, delta })));
  if (notable.length) {
    lines.push("", "## Non-data deltas (first 8 per scenario)", "");
    for (const { scenario, delta } of notable) {
      const value = (side) => (delta[side] === undefined ? "" : typeof delta[side] === "string" ? delta[side] : JSON.stringify(delta[side]));
      lines.push(`- **${scenario}** ${delta.kind}${delta.field ? ` \`${delta.field}\`` : ""}${delta.attribute ? ` @${delta.attribute}` : ""}${delta.path ? ` at \`${String(delta.path).slice(0, 140)}\`` : ""}: live ${value("live").slice(0, 120)} / local ${value("local").slice(0, 120)} → ${delta.classification.class}${delta.classification.owner ? ` (${delta.classification.owner})` : ""}`);
    }
  }
  if (Object.keys(report.questions ?? {}).length) {
    lines.push("", "## Open-question evidence (platform-internals-reference section 11)", "");
    for (const [question, items] of Object.entries(report.questions).sort()) lines.push(`- ${question}: ${items.map((item) => `${item.scenario} (${item.verdict})`).join(", ")}`);
    for (const item of report.questionsNotObservable ?? []) lines.push(`- ${item.id}: not observable read-only — ${item.reason}`);
  }
  lines.push("", "Live text is shown only when it is present in the exported sources or equals local synthetic output; other live values are digests under a per-run key.", "");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const { values } = parseArgs({
    options: {
      local: { type: "string" },
      "local-owned": { type: "boolean" },
      source: { type: "string" },
      state: { type: "string" },
      preset: { type: "string" },
      site: { type: "string" },
      env: { type: "string" },
      repo: { type: "string" },
      config: { type: "string" },
      "pack-module": { type: "string", multiple: true },
      origin: { type: "string" },
      cdp: { type: "string" },
      "anonymous-browser": { type: "string" },
      scenarios: { type: "string" },
      core: { type: "boolean" },
      "no-core": { type: "boolean" },
      pack: { type: "string", multiple: true },
      packs: { type: "string" },
      out: { type: "string" },
      only: { type: "string" },
      tags: { type: "string" },
      "exclude-tags": { type: "string" },
      label: { type: "string" },
      "delay-ms": { type: "string" },
      "work-dir": { type: "string" },
      "persona-contact": { type: "string" },
      "no-persona": { type: "boolean" },
      browser: { type: "string" },
      ids: { type: "string" },
      "deployment-profile": { type: "string" },
      reclassify: { type: "string" },
    },
  });
  const list = (value) => (Array.isArray(value) ? value : value === undefined ? [] : [value]).flatMap((item) => String(item).split(",")).map((item) => item.trim()).filter(Boolean);
  const files = list(values.scenarios);
  let site = null;
  if (values.site) {
    const { loadConfig } = await import("../lense/config.mjs");
    site = await loadConfig({ site: values.site, env: values.env, ...(values.repo ? { repo: values.repo } : {}), ...(values.config ? { config: values.config } : {}) });
  }
  const explicit = [...(site?.mirageConfig?.dataPacks ?? []), ...list(values['pack-module']).map((module) => ({ module }))];
  // An explicit plan file keeps its earlier meaning (that plan alone). Otherwise the run uses the
  // portal-agnostic core set plus the plans of the data packs that match the portal.
  const sourceOptions = (portal, defaultPacks) => ({
    core: values["no-core"] ? false : values.core === true || !files.length,
    packs: values.pack?.length ? list(values.pack) : (values.packs ?? (files.length ? "none" : defaultPacks)),
    portal,
    files,
    explicit,
  });
  if (values.reclassify) {
    // Offline: apply the current classification rules to a saved report without new requests.
    const plan = await loadScenarioPlans(sourceOptions(null, "all"));
    const report = reclassifyReport(JSON.parse(await fs.readFile(values.reclassify, "utf8")), plan);
    await fs.writeFile(values.reclassify, JSON.stringify(report, null, 2));
    await fs.writeFile(path.join(path.dirname(values.reclassify), "summary.md"), summaryMarkdown(report));
    console.log(JSON.stringify({ report: path.resolve(values.reclassify), totals: report.totals, deltaClasses: report.deltaClasses, owners: report.owners }, null, 2));
    return;
  }
  const origin = values.origin ?? site?.origin;
  const sourceDir = values.source ?? (values.local ? undefined : site?.sourceDir);
  if (!origin || !values.out || (!values.local && !sourceDir))
    throw new Error(
      "Usage: node mirage/parity-suite.mjs (--local http://127.0.0.1:PORT | --source PORTAL_DIR | --site SITE --env ENV) [--state STATE] [--preset NAME|none] [--origin https://PORTAL] [--cdp http://127.0.0.1:PORT] [--anonymous-browser owned|cdp] [--scenarios FILE | --pack ID | --packs auto|all|none] [--no-core] --out DIR [--only IDS] [--tags T] [--exclude-tags T]",
    );
  const anonymousBrowser = values["anonymous-browser"] ?? "owned";
  if (!["owned", "cdp"].includes(anonymousBrowser)) throw new Error("--anonymous-browser must be owned or cdp.");
  if (anonymousBrowser === "cdp" && !values.cdp) throw new Error("--anonymous-browser cdp needs --cdp (the owned toolkit browser).");
  const { importPortal } = await import("./lib/importer.mjs");
  let owned = null;
  let browser = null;
  let live = null;
  let anonymousCdp = null;
  let identity = null;
  try {
    let portal = sourceDir ? await importPortal(path.resolve(sourceDir)) : null;
    let plan = portal ? await loadScenarioPlans(sourceOptions(portal, "auto")) : null;
    let catalogue = null;
    if (sourceDir) {
      const preset = values.preset ?? plan.defaults?.preset ?? null;
      const workDir = path.resolve(values["work-dir"] ?? path.join(values.out, "runtime"));
      // A catalogue site (--site/--env without --source) brings its mirage settings: solution
      // roots and order, and observed behaviour the export cannot express.
      const siteMirage = site && !values.source ? (site.mirageConfig ?? null) : null;
      let roots = null;
      if (siteMirage) {
        const { resolveSolutionRoots } = await import("./lib/solution-roots.mjs");
        roots = await resolveSolutionRoots({ sourceDir: path.resolve(sourceDir), catalogue: siteMirage, cacheFile: path.join(workDir, "cache", "solution-sources.json") });
        catalogue = { site: values.site, env: values.env ?? null, solutionRoots: roots.source, solutionOrder: roots.order, observed: siteMirage.observed ? Object.keys(siteMirage.observed).filter((key) => key !== "evidence").sort() : [] };
      }
      owned = await startIsolatedMirage({
        sourceDir: path.resolve(sourceDir),
        dataPacks: explicit,
        baselineState: values.state ? path.resolve(values.state) : undefined,
        ...(roots ? { solutionRoots: roots.roots, solutionOrder: roots.order } : {}),
        ...(siteMirage?.observed ? { observed: siteMirage.observed } : {}),
        preset: preset === "none" ? null : preset,
        origin,
        workDir,
        deploymentProfile: values["deployment-profile"] ?? plan.defaults?.deploymentProfile,
      });
    }
    // Live record identifiers stay in an ignored run-time file, never in the tracked plan.
    const ids = values.ids ? JSON.parse(await fs.readFile(values.ids, "utf8")) : null;
    const localUrl = owned?.url ?? values.local;
    const state = await localState(localUrl);
    if (state.config?.mode !== "local" || state.config?.pageMode !== "local" || (state.config?.endpoints ?? []).some((endpoint) => endpoint.mode === "live"))
      throw new Error("Parity requires exclusively local providers.");
    if (!portal) {
      portal = await importPortal(state.status.sourceDir);
      plan = await loadScenarioPlans(sourceOptions(portal, "auto"));
    }
    // A matching pack's denied routes apply even when its scenarios were not selected.
    await activatePackDeniedRoutes(portal, { explicit });
    const delayMs = values["delay-ms"] ? Number(values["delay-ms"]) : (plan.defaults?.delayMs ?? 400);
    const corpus = await loadSourceCorpus(state.status?.sourceDir);
    const full = await localState(localUrl, { summary: false });
    const { pageAccess } = await import("./lib/page-access.mjs");
    const mappings = Object.fromEntries((full.config?.mappings ?? []).map((mapping) => [mapping.logicalName ?? mapping.id, mapping]));
    const portalFacts = portalDiscovery({ portal, mappings, pageAccess });
    identity = createIdentityController(localUrl);
    browser = await openOwnedBrowser({ channel: values.browser, fulfil: plan.fulfil ?? [] });
    live = values.cdp ? await openCdpTabDriver({ cdpUrl: values.cdp, origin, fulfil: plan.fulfil ?? [] }) : null;
    // Anonymous reference pages: the runner's own headless browser, or (--anonymous-browser cdp) an
    // isolated context of the owned toolkit browser. The toolkit overlay serves that context with the
    // toolkit profile's cookies, so it is anonymous only while the profile holds no session for this
    // origin: check the home page once before the run.
    anonymousCdp = anonymousBrowser === "cdp" ? await openCdpTabDriver({ cdpUrl: values.cdp, origin, isolated: true, fulfil: plan.fulfil ?? [] }) : null;
    if (anonymousCdp) {
      const issue = captureProblem("anonymous", await anonymousCdp.page("/", { maxNodes: 400 }));
      if (issue) throw new Error(`--anonymous-browser cdp: ${issue}`);
    }
    const anonymousHttp = createHttpDriver({ origin, identity: "anonymous" });
    const anonymousPages = anonymousCdp ?? browser.pageDriver(origin, "anonymous");
    // Local requests carry the run's session cookie when signed in and no cookie when anonymous.
    const localHttp = createHttpDriver({ origin: localUrl, identity: "local", cookie: () => identity.cookie() });
    // The local runtime uses the script guard (no stalls with synchronous XHR); any write that
    // escaped it would change the local data fingerprint, which every report checks.
    const localPages = browser.pageDriver(localUrl, "local", { guard: "script", cookie: () => identity.cookie() });
    const sides = {
      live,
      anonymous: { http: anonymousHttp.http, page: anonymousPages.page, source: anonymousPages.source, origin, identity: "anonymous" },
      local: { http: localHttp.http, page: localPages.page, source: localPages.source, origin: localUrl, identity: "local" },
    };
    let persona = null;
    if (live && !values["no-persona"] && plan.persona) {
      const roleNames = state.status.webRoles.map((role) => role.name);
      persona = await derivePersona({ live, roleNames, probe: plan.persona.probe, accessChecks: plan.persona.accessChecks ?? [], delayMs });
      if (persona.roles) {
        const contactId = values["persona-contact"] ?? plan.persona.contactId ?? state.config.identity?.contactId ?? state.config.contactRoles?.[0]?.contactId;
        persona.local = await identity.mirror({ contactId, roles: persona.roles });
        persona.localContact = contactId ? "configured local synthetic contact" : null;
      }
    } else if (values["persona-contact"]) await identity.signInAs(values["persona-contact"]);
    const report = await runParitySuite({
      plan,
      localUrl,
      origin,
      sides,
      identity,
      outDir: path.resolve(values.out),
      only: values.only ? values.only.split(",").map((item) => item.trim()) : undefined,
      tags: values.tags ? values.tags.split(",").map((item) => item.trim()) : undefined,
      excludeTags: values["exclude-tags"] ? values["exclude-tags"].split(",").map((item) => item.trim()) : undefined,
      delayMs,
      corpus,
      persona,
      ids,
      portalFacts,
      conditions: anonymousCdp ? ["Anonymous reference pages were captured in an isolated browser context of the owned toolkit browser: no cookies, no overlay, writes blocked."] : [],
      label: values.label ?? path.basename(path.resolve(values.out)),
    });
    report.runtime = owned
      ? { owned: true, preset: owned.preset, deploymentProfile: owned.deploymentProfile, baselineStateFingerprint: values.state ? sha256(await fs.readFile(values.state)).slice(0, 16) : null, solutionRoots: owned.solutionRoots.map((root) => path.basename(root)) }
      : { owned: values["local-owned"] === true, attached: true };
    if (site) report.runtime.site = { site: values.site, env: values.env ?? null };
    if (catalogue) report.runtime.catalogue = catalogue;
    report.idsSupplied = ids ? Object.keys(ids).sort() : [];
    await fs.writeFile(report.report, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ report: report.report, totals: report.totals, deltaClasses: report.deltaClasses, owners: report.owners, localDataUnchanged: report.localDataUnchanged }, null, 2));
    process.exitCode = report.scenarios.some((scenario) => scenario.verdict === "error") ? 2 : 0;
  } finally {
    await identity?.restore().catch(() => {});
    await live?.close().catch(() => {});
    await anonymousCdp?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await owned?.app.close().catch(() => {});
    if (owned?.workspace) await fs.rm(owned.workspace, { recursive: true, force: true }).catch(() => {});
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(normalizeText(error.message));
    process.exitCode = 1;
  });
}

export const __testing = { pageFetch, signInObserved, discoverTarget, pagingCookieOf, snapshotOptions, DEFAULT_EXCLUDE, inventory };
