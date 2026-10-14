// Baseline capture: one self-contained page runner executes a scripted scenario on a Playwright
// page and collects raw evidence (ordered requests and responses, settled DOM, element inventory,
// console, screenshot). The runner has no imports so the same source can run inside a browser
// bridge sandbox (the user's signed-in profile) or in-process against a local Mirage. Redaction
// and file writing happen in this process: tokens are never written, query values are redacted.
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { redactUrl, normalizeText } from "./parity-suite.mjs";

export const SIGN_IN_MARKERS = Object.freeze(["form#loginForm", "form[action*='/SignIn']", "[action*='login.microsoftonline']", ".login-heading-section", "#SubmitButton[value='Sign in']"]);
const TOKEN_HEADERS = new Set(["cookie", "set-cookie", "authorization", "proxy-authorization", "x-csrf-token", "__requestverificationtoken", "x-ms-request-id", "x-request-id", "request-id", "x-azure-ref", "x-cache"]);
const TOKEN_FIELDS = /(__RequestVerificationToken|__VIEWSTATE(?:GENERATOR)?|__EVENTVALIDATION|__CMSCsrfToken|__RequestVerificationToken_[\w-]+)=[^&]*/g;
const TOKEN_ATTRIBUTES = /(name="?(?:__RequestVerificationToken|__VIEWSTATE(?:GENERATOR)?|__EVENTVALIDATION)"?[^>]*value=")[^"]*(")/g;
const sha = (value) => createHash("sha256").update(value).digest("hex");

/** Replace per-session tokens in text bodies and markup with a stable placeholder. */
export function redactTokens(text) {
  return String(text ?? "")
    .replace(TOKEN_FIELDS, "$1={token}")
    .replace(TOKEN_ATTRIBUTES, "$1{token}$2")
    .replace(/("__RequestVerificationToken"\s*:\s*")[^"]*(")/g, "$1{token}$2")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{20,}/g, "$1{token}");
}

function redactHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const key = name.toLowerCase();
    if (TOKEN_HEADERS.has(key)) {
      out[key] = key === "cookie" || key === "set-cookie" ? String(value).split(/,(?=\s*\w+=)|;/).map((part) => part.split("=")[0].trim()).filter(Boolean).sort().join(";") : "{token}";
    } else out[key] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/** Resolve `{id:alias}` placeholders from the run's private id map. */
export function resolvePlaceholders(text, ids = {}) {
  return String(text ?? "").replace(/\{id:([\w.-]+)\}/g, (_, alias) => {
    if (!Object.hasOwn(ids, alias)) throw new Error(`Unknown record alias {id:${alias}}`);
    return String(ids[alias]);
  });
}

/**
 * Self-contained runner. `page` is any Playwright page of the target browser context; the runner
 * opens its own page in that context, guards writes, runs the steps, collects raw evidence, closes
 * its page and returns { summary, raw }. It must not reference module scope (it is stringified).
 * options: { origin, scenario, ids, allowWrites, allowPaths, allowEntitySets, readPosts, signInMarkers, settle, textTypes, maxBody }
 */
export async function pageRunner(page, options) {
  const { origin, scenario, ids = {}, allowWrites = false, allowPaths = [], allowEntitySets = [], signInMarkers = [], settle: settleDefaults = {}, maxBody = 2 * 1024 * 1024, readPosts = ["^/_services/entity-(?:grid|subgrid)-data\.json(?:/|$)", "^/_services/entity-notes/[^/]+$"] } = options;
  const textTypes = new RegExp(options.textTypes ?? "^(?:text/|application/(?:json|xml|x-www-form-urlencoded|javascript|problem\\+json)|.*\\+json|.*\\+xml)", "i");
  const sleep = (ms) => page.waitForTimeout(ms);
  const resolve = (text) => String(text ?? "").replace(/\{id:([\w.-]+)\}/g, (_, alias) => {
    if (!Object.prototype.hasOwnProperty.call(ids, alias)) throw new Error(`Unknown record alias {id:${alias}}`);
    return String(ids[alias]);
  });
  const context = page.context();
  const loopback = /^(?:127\.0\.0\.1|localhost|\[::1\])$/.test(new URL(origin).hostname);
  const allowWrite = (method, pathname) => {
    // A local runtime's own instrumentation endpoints are not scenario writes.
    if (loopback && /^\/__sim\//.test(pathname)) return true;
    // Portal list/grid data is fetched with POST but reads only (entity-grid-data.json and friends).
    if (readPosts.some((pattern) => new RegExp(pattern).test(pathname))) return true;
    if (!allowWrites) return false;
    if (allowPaths.some((pattern) => new RegExp(pattern).test(pathname))) return true;
    const api = /^\/_api\/([^/(]+)/.exec(pathname);
    return Boolean(api && allowEntitySets.includes(api[1]));
  };
  const raw = { requests: [], console: [], pageErrors: [], blockedWrites: [], identityTraffic: [], dialogs: [] };
  const summary = { id: scenario.id, status: "captured", problems: [], steps: 0, startedAt: new Date().toISOString() };
  const owned = await context.newPage();
  await owned.setViewportSize({ width: 1440, height: 1000 });
  const inflight = new Set();
  let lastActivity = Date.now();
  let seq = 0;
  const entries = new Map();
  const sameOrigin = (url) => {
    try {
      return new URL(url).origin === origin;
    } catch {
      return false;
    }
  };
  const identityHosts = /(?:^|\.)login\.microsoftonline\.com$|(?:^|\.)login\.live\.com$|(?:^|\.)b2clogin\.com$/i;
  const guard = async (route) => {
    const request = route.request();
    const method = request.method().toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return route.fallback();
    const pathname = new URL(request.url()).pathname;
    // The browser's own sign-in completion (an identity provider's form_post back to the portal)
    // is identity traffic, not a scenario write: let it through and record it.
    const headers = request.headers();
    let referrer = "";
    try {
      referrer = new URL(headers.referer || headers.origin || "").hostname;
    } catch {
      /* no referrer */
    }
    if (request.isNavigationRequest() && (identityHosts.test(referrer) || /^\/signin(?:-|\/|$|\?)/i.test(pathname) || /^\/Account\/Login\//i.test(pathname))) {
      raw.identityTraffic.push({ method, path: pathname, from: referrer });
      return route.fallback();
    }
    if (allowWrite(method, pathname)) return route.fallback();
    raw.blockedWrites.push({ method, path: pathname });
    return route.abort("blockedbyclient");
  };
  await owned.route((url) => url.origin === origin, guard);
  owned.on("request", (request) => {
    lastActivity = Date.now();
    if (!sameOrigin(request.url())) return;
    const method = request.method().toUpperCase();
    const entry = { seq: ++seq, method, url: request.url(), resourceType: request.resourceType(), headers: request.headers(), body: method === "GET" || method === "HEAD" ? null : request.postData() ?? "", response: null };
    entries.set(request, entry);
    raw.requests.push(entry);
    inflight.add(request);
  });
  owned.on("requestfailed", (request) => {
    inflight.delete(request);
    const entry = entries.get(request);
    if (entry) entry.response = { status: 0, failure: (request.failure() && request.failure().errorText) || "failed" };
  });
  owned.on("requestfinished", (request) => inflight.delete(request));
  owned.on("response", async (response) => {
    lastActivity = Date.now();
    const entry = entries.get(response.request());
    if (!entry) return;
    const headers = response.headers();
    const contentType = headers["content-type"] || "";
    entry.response = { status: response.status(), headers, body: null, bodyBytes: null, bodySha256: null, binary: !textTypes.test(contentType) };
    try {
      const buffer = await response.body();
      entry.response.bodyBytes = buffer.length;
      if (entry.response.binary) entry.response.base64 = buffer.toString("base64").slice(0, 64) + (buffer.length > 48 ? "…" : "");
      else entry.response.body = buffer.length > maxBody ? null : buffer.toString("utf8");
      if (entry.response.binary || buffer.length > maxBody) entry.response.bodyHashInput = buffer.toString("base64");
    } catch {
      /* redirects and aborted responses expose no body */
    }
  });
  owned.on("console", (message) => {
    const location = message.location();
    raw.console.push({ type: message.type(), text: String(message.text()).slice(0, 2000), url: location && location.url, line: location && location.lineNumber });
  });
  owned.on("pageerror", (error) => raw.pageErrors.push(String((error && error.message) || error).slice(0, 2000)));
  owned.on("dialog", async (dialog) => {
    raw.dialogs.push({ type: dialog.type(), message: String(dialog.message()).slice(0, 500) });
    await dialog.accept().catch(() => {});
  });
  const loadingProbe = () => {
    const selectors = ["[role=progressbar]", ".form-loading", ".loader", ".dataTables_processing", ".overlay:not([style*='display: none'])", ".modal.in .loading", ".modal.show .loading"];
    return selectors.some((selector) => {
      try {
        return [...document.querySelectorAll(selector)].some((element) => element.getClientRects().length && getComputedStyle(element).display !== "none" && getComputedStyle(element).visibility !== "hidden");
      } catch {
        return false;
      }
    });
  };
  const settle = async (opts = {}) => {
    const quietMs = opts.quietMs ?? settleDefaults.quietMs ?? 1000;
    const timeout = opts.timeout ?? settleDefaults.timeout ?? 20000;
    const settleMs = opts.settleMs ?? settleDefaults.settleMs ?? 0;
    const started = Date.now();
    let settled = false;
    while (Date.now() - started < timeout) {
      const loading = await owned.evaluate(loadingProbe).catch(() => false);
      if (!loading && inflight.size === 0 && Date.now() - lastActivity >= quietMs) {
        settled = true;
        break;
      }
      await sleep(150);
    }
    if (settleMs) await sleep(Math.min(settleMs, 10000));
    return settled;
  };
  const runStep = async (step) => {
    const timeout = step.timeout ?? 20000;
    const q = (selector, scope = owned) => scope.locator(resolve(selector)).first();
    if (step.goto !== undefined) {
      const target = new URL(resolve(step.goto), origin);
      if (target.origin !== origin) throw new Error("Step navigates outside the portal origin");
      // Commit the document, then let the quiet-network settle decide: a browser bridge can hold the
      // window load event open on third-party telemetry long after the portal page is complete.
      await owned.goto(target.href, { waitUntil: "domcontentloaded", timeout: Math.max(timeout, 45000) });
      await owned.waitForLoadState("load", { timeout: 15000 }).catch(() => {});
    } else if (step.fill !== undefined) await q(step.fill).fill(resolve(step.value ?? ""), { timeout });
    else if (step.type !== undefined) await q(step.type).pressSequentially(resolve(step.value ?? ""), { timeout });
    else if (step.select !== undefined) await q(step.select).selectOption(step.label !== undefined ? { label: resolve(step.label) } : resolve(step.value ?? ""), { timeout });
    else if (step.check !== undefined) await q(step.check).setChecked(step.value !== false, { timeout });
    else if (step.click !== undefined) await q(step.click).click({ timeout });
    else if (step.press !== undefined) await q(step.press).press(step.key ?? "Enter", { timeout });
    else if (step.upload !== undefined) await q(step.upload).setInputFiles(step.files, { timeout });
    else if (step.clear !== undefined) await q(step.clear).fill("", { timeout });
    else if (step.wait !== undefined) {
      if (typeof step.wait === "number") await sleep(Math.min(step.wait, 15000));
      else if (step.wait.selector) await q(step.wait.selector).waitFor({ state: step.wait.state ?? "visible", timeout });
      else if (step.wait.url) await owned.waitForURL((url) => new RegExp(step.wait.url).test(url.pathname + url.search), { timeout });
      else if (step.wait.navigation) await owned.waitForLoadState("load", { timeout });
    } else if (step.frame !== undefined) {
      const frame = owned.frameLocator(resolve(step.frame));
      for (const inner of step.steps ?? []) {
        if (inner.fill !== undefined) await q(inner.fill, frame).fill(resolve(inner.value ?? ""), { timeout });
        else if (inner.click !== undefined) await q(inner.click, frame).click({ timeout });
        else if (inner.select !== undefined) await q(inner.select, frame).selectOption(inner.label !== undefined ? { label: resolve(inner.label) } : resolve(inner.value ?? ""), { timeout });
        else if (inner.check !== undefined) await q(inner.check, frame).setChecked(inner.value !== false, { timeout });
        else if (inner.wait && inner.wait.selector) await q(inner.wait.selector, frame).waitFor({ state: inner.wait.state ?? "visible", timeout });
        else throw new Error("Unsupported frame step: " + Object.keys(inner).join(","));
      }
    } else throw new Error("Unsupported step: " + Object.keys(step).join(","));
    if (step.settle !== false) await settle(step.settleOptions ?? {});
  };
  const elementInventory = () => {
    const selectorOf = (element) => {
      const parts = [];
      for (let node = element; node && node.nodeType === 1 && node !== document.documentElement; node = node.parentElement) {
        let part = node.tagName.toLowerCase();
        if (node.id) part += "#" + CSS.escape(node.id);
        else {
          const siblings = [...((node.parentElement && node.parentElement.children) || [])].filter((item) => item.tagName === node.tagName);
          if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(node) + 1) + ")";
        }
        parts.unshift(part);
        if (node.id) break;
      }
      return parts.join(">");
    };
    const secret = /__RequestVerificationToken|__VIEWSTATE|__EVENTVALIDATION/;
    const out = [];
    for (const element of document.body ? document.body.querySelectorAll("*") : []) {
      if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(element.tagName)) continue;
      const style = getComputedStyle(element);
      const attributes = {};
      for (const attribute of element.attributes) {
        if (attribute.name === "nonce") continue;
        attributes[attribute.name] = secret.test(element.getAttribute("name") || "") && attribute.name === "value" ? "{token}" : attribute.value;
      }
      const formControl = ["INPUT", "SELECT", "TEXTAREA"].includes(element.tagName) && element.type !== "password";
      out.push({
        selector: selectorOf(element),
        tag: element.tagName.toLowerCase(),
        classes: [...element.classList],
        attributes,
        visible: Boolean(element.getClientRects().length) && style.display !== "none" && style.visibility !== "hidden",
        disabled: Boolean(element.disabled) || element.getAttribute("aria-disabled") === "true",
        readonly: Boolean(element.readOnly) || element.getAttribute("aria-readonly") === "true",
        required: Boolean(element.required) || element.getAttribute("aria-required") === "true",
        ...(formControl ? { value: element.type === "checkbox" || element.type === "radio" ? element.checked : secret.test(element.name) ? "{token}" : String(element.value ?? "") } : {}),
      });
      if (out.length >= 20000) break;
    }
    return out;
  };
  try {
    for (const step of scenario.steps ?? []) {
      await runStep(step);
      summary.steps++;
    }
    await settle();
    const url = new URL(owned.url());
    if (url.origin !== origin) summary.problems.push("page left the portal origin (" + url.hostname + ")");
    for (const marker of signInMarkers) if (await owned.locator(marker).count().catch(() => 0)) summary.problems.push("sign-in marker present: " + marker);
    const expect = scenario.expect || {};
    for (const selector of expect.present || []) if (!(await owned.locator(selector).count().catch(() => 0))) summary.problems.push("expected element missing: " + selector);
    for (const selector of expect.absent || []) if (await owned.locator(selector).count().catch(() => 0)) summary.problems.push("unexpected element present: " + selector);
    for (const text of expect.text || []) if (!(await owned.locator("body").innerText().catch(() => "")).includes(text)) summary.problems.push("expected text missing: " + JSON.stringify(text));
    if (expect.urlPattern && !new RegExp(expect.urlPattern).test(url.pathname + url.search)) summary.problems.push("url does not match expectation");
  } catch (error) {
    summary.status = "error";
    summary.problems.push(String((error && error.message) || error).slice(0, 500));
  }
  if (summary.problems.length && summary.status === "captured") summary.status = "failed";
  raw.dom = await owned.evaluate(() => document.documentElement.outerHTML).catch(() => "");
  raw.elements = await owned.evaluate(elementInventory).catch(() => []);
  raw.title = await owned.title().catch(() => "");
  raw.finalUrl = owned.url();
  try {
    raw.screenshot = (await owned.screenshot({ fullPage: true, timeout: 30000 })).toString("base64");
  } catch (error) {
    summary.problems.push("screenshot: " + String(error && error.message).slice(0, 200));
  }
  await owned.unroute((url) => url.origin === origin, guard).catch(() => {});
  await owned.close().catch(() => {});
  summary.finishedAt = new Date().toISOString();
  return { summary, raw };
}

/** Source of the runner for a sandbox that cannot import modules. */
export const pageRunnerSource = () => pageRunner.toString();

/** Redact raw evidence and write the scenario folder. Returns the capture meta. */
export async function writeCapture({ summary, raw }, { outDir, origin, side, meta = {} }) {
  await fs.mkdir(outDir, { recursive: true });
  const origins = [origin];
  const requests = raw.requests.map((entry) => {
    const response = entry.response
      ? {
          status: entry.response.status,
          ...(entry.response.failure ? { failure: entry.response.failure } : {}),
          headers: redactHeaders(entry.response.headers),
          body: entry.response.body === null || entry.response.body === undefined ? null : redactTokens(entry.response.body),
          bodyBytes: entry.response.bodyBytes ?? null,
          bodySha256: entry.response.bodyHashInput ? sha(Buffer.from(entry.response.bodyHashInput, "base64")) : entry.response.body ? sha(redactTokens(entry.response.body)) : null,
        }
      : null;
    return {
      seq: entry.seq,
      method: entry.method,
      url: redactUrl(entry.url, { origins, keepPaging: true }),
      path: (() => {
        try {
          return new URL(entry.url).pathname;
        } catch {
          return entry.url;
        }
      })(),
      resourceType: entry.resourceType,
      headers: redactHeaders(entry.headers),
      body: entry.body === null || entry.body === undefined ? null : redactTokens(entry.body),
      response,
    };
  });
  const consoleEntries = raw.console.map((entry) => ({ type: entry.type, text: normalizeText(redactTokens(entry.text), { origins }).slice(0, 2000), ...(entry.url ? { url: redactUrl(entry.url, { origins }), line: entry.line } : {}) }));
  const pageErrors = raw.pageErrors.map((text) => normalizeText(text, { origins }).slice(0, 2000));
  await fs.writeFile(path.join(outDir, "requests.json"), JSON.stringify(requests, null, 2));
  await fs.writeFile(path.join(outDir, "dom.html"), redactTokens(raw.dom ?? ""));
  await fs.writeFile(path.join(outDir, "elements.json"), JSON.stringify(raw.elements ?? [], null, 2));
  await fs.writeFile(path.join(outDir, "console.json"), JSON.stringify({ console: consoleEntries, pageErrors, dialogs: raw.dialogs ?? [] }, null, 2));
  if (raw.screenshot) await fs.writeFile(path.join(outDir, "screenshot.png"), Buffer.from(raw.screenshot, "base64"));
  const capture = {
    version: 1,
    scenario: summary.id,
    side,
    ...meta,
    capturedAt: summary.finishedAt ?? new Date().toISOString(),
    startedAt: summary.startedAt,
    status: summary.status,
    problems: summary.problems,
    title: normalizeText(raw.title ?? ""),
    finalUrl: redactUrl(raw.finalUrl ?? "", { origins, keepPaging: true }),
    requests: requests.length,
    elements: (raw.elements ?? []).length,
    blockedWrites: raw.blockedWrites ?? [],
    identityTraffic: raw.identityTraffic ?? [],
  };
  await fs.writeFile(path.join(outDir, "meta.json"), JSON.stringify(capture, null, 2));
  return capture;
}

/** Runner options shared by every side, from the matrix and the run. */
export function runnerOptions({ scenario, origin, ids, matrix, allowWrites }) {
  return {
    origin,
    scenario: { id: scenario.id, steps: scenario.steps, expect: scenario.expect ?? {} },
    ids,
    allowWrites: Boolean(allowWrites),
    ...(matrix.readPosts ? { readPosts: matrix.readPosts } : {}),
    allowPaths: matrix.writeScope?.paths ?? [],
    allowEntitySets: matrix.writeScope?.entitySets ?? [],
    signInMarkers: [...SIGN_IN_MARKERS],
    settle: matrix.settle ?? {},
  };
}

/** In-process capture (local Mirage): run the runner on `page`'s context and write the folder. */
export async function captureScenario(page, scenario, { origin, outDir, ids = {}, side, meta = {}, matrix = {}, allowWrites = true }) {
  const result = await pageRunner(page, runnerOptions({ scenario, origin, ids, matrix, allowWrites }));
  return writeCapture(result, { outDir, origin, side, meta });
}
