#!/usr/bin/env node
/**
 * Render sweep: request every exported page of a portal from an isolated, local-only Mirage
 * simulator and report Liquid diagnostics.
 *
 *   node mirage/render-sweep.mjs (--site NAME [--env NAME] | --source DIR [--portal ID]
 *        [--solution-root DIR]... | --project FILE [--portal ID])
 *        [--persona anonymous|authenticated|all-roles|configured|both|all] [--preset NAME] [--state FILE]
 *        [--json] [--ci] [--out DIR] [--path PREFIX] [--limit N] [--strict] [--repo DIR]
 *
 * The portal comes from paqvilo.config.yml (--site, as for `mirage dev`), from an export
 * directory (--source, Solution roots discovered next to it unless --solution-root is given) or
 * from a Mirage project (--project, --portal selects the project portal). The selected state
 * file (default for --site: .paqvilo/simulator/<site>/state.json; for --project: the project
 * state) is copied into a temporary directory together with its Solution cache, so the sweep
 * never changes the developer's state. --preset is applied to that copy only. The simulator runs
 * with watch:false and never connects to a live environment.
 *
 * Personas change identity only, never the state's rows: `anonymous` sends Fetch Metadata without
 * a paqvilo-mirage-auth session; `configured` signs in as the state's or preset's configured contact;
 * `authenticated` signs in a synthetic contact with the exported Authenticated Users role;
 * `all-roles` (coverage) holds every active exported role except Anonymous Users. `both` runs
 * anonymous and authenticated, `all` the three, each on a separate copy of the state.
 *
 * Each page is requested as-is; pages hosting an edit or read-only basic/advanced form whose
 * record comes from the query string are also requested with the first local record of the
 * form's table (?id=... or the configured parameter name), and so are pages whose template,
 * copy or statically included templates read request.params.id through entities[table][...]
 * or a FetchXML primary-key condition on <table>id. For each response the report
 * records status, content type, the Liquid diagnostics the renderer emitted for that path
 * (syntax errors, runtime errors, unknown filters, missing templates, ...), inline
 * "Liquid error:" text and, for responses that are not HTML documents, any local runtime
 * injection (/__sim-static/, data-paqvilo-mirage-runtime, sim-trace-id), which would corrupt JSON or
 * fragment consumers. The static Liquid inventory of the same export is attached, so the
 * per-portal summary (--ci prints one JSON line per persona) also counts unsupported constructs.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSimulator } from "./server.mjs";
import { portalField } from "./lib/importer.mjs";
import { isHtmlDocument } from "./lib/source-dependencies.mjs";
import { inventoryPortal } from "./liquid-inventory.mjs";

const TOOLKIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Diagnostics that mean Power Pages would also print an error into the page. */
export const LIQUID_ERROR_CODES = new Set(["liquid-syntax-error", "liquid-error", "liquid-runtime-error"]);
/** Diagnostics that describe Liquid behaviour worth reviewing but rendered as Power Pages does. */
export const LIQUID_NOTICE_CODES = new Set([
  "liquid-unknown-filter",
  "liquid-template-not-found",
  "liquid-managed-template-source",
  "liquid-entity-non-guid-key",
]);
const PERSONAS = ["anonymous", "authenticated"];
/** Coverage persona: a synthetic contact holding every exported web role except Anonymous Users. */
const COVERAGE_PERSONA = "all-roles";
const INJECTION_MARKERS = [
  { name: "sim-static", pattern: /\/__sim-static\// },
  { name: "sim-runtime", pattern: /data-paqvilo-mirage-runtime/ },
  { name: "sim-trace", pattern: /<meta name="sim-trace-id"/ },
];
const INLINE_ERROR = /Liquid (?:syntax )?error: [^<\r\n]{0,200}/g;

function parseArgs(argv) {
  const options = { json: false, ci: false, strict: false, solutionRoots: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next == null) throw new Error(`${arg} requires a value`);
      return next;
    };
    if (arg === "--site") options.site = value();
    else if (arg === "--env") options.env = value();
    else if (arg === "--source") options.source = value();
    else if (arg === "--solution-root") options.solutionRoots.push(value());
    else if (arg === "--project") options.project = value();
    else if (arg === "--portal") options.portal = value();
    else if (arg === "--persona") options.persona = value();
    else if (arg === "--preset") options.preset = value();
    else if (arg === "--state") options.state = value();
    else if (arg === "--out") options.out = value();
    else if (arg === "--path") options.pathPrefix = value();
    else if (arg === "--limit") options.limit = Number(value());
    else if (arg === "--repo") options.repo = value();
    else if (arg === "--config") options.config = value();
    else if (arg === "--json") options.json = true;
    else if (arg === "--ci") options.ci = true;
    else if (arg === "--strict") options.strict = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument ${arg}`);
  }
  const sources = [options.site, options.source, options.project].filter(Boolean).length;
  if (sources > 1) throw new Error("Use one of --site, --source or --project.");
  if (options.solutionRoots.length && !options.source) throw new Error("--solution-root applies to --source only.");
  if (options.persona && !["both", "all", "configured", COVERAGE_PERSONA, ...PERSONAS].includes(options.persona))
    throw new Error("--persona must be anonymous, authenticated, all-roles, configured, both or all.");
  return options;
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** Copy the selected state (and its Solution cache) into a private temporary directory. */
async function isolatedState(stateFile) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pp-render-sweep-"));
  const target = path.join(directory, "state.json");
  const source = stateFile ? path.resolve(stateFile) : null;
  if (source && (await exists(source))) {
    await fs.copyFile(source, target);
    const cache = path.join(path.dirname(source), "cache");
    if (await exists(cache)) await fs.cp(cache, path.join(directory, "cache"), { recursive: true });
  }
  return { directory, stateFile: target, copied: Boolean(source && (await exists(target))) };
}

/** The query-string record a form page needs, or null. */
export function formRecordTarget(portal, store, page) {
  const pick = (entity, parameter) => {
    if (!entity) return null;
    let mapping;
    try {
      mapping = store.resolveMapping(entity);
    } catch {
      return null;
    }
    const logicalName = mapping?.logicalName ?? entity;
    const rows = store.snapshot({ tables: [logicalName] }).tables?.[logicalName] ?? [];
    const row = rows.find((candidate) => candidate?.[mapping.idColumn]);
    return row ? { parameter: parameter || "id", id: String(row[mapping.idColumn]), entity: logicalName } : null;
  };
  const queryRecord = (mode, sourceType, querySource) => [100000001, 100000002].includes(mode) && sourceType === querySource;
  if (page.formId) {
    const form = portal.forms?.find((candidate) => candidate.id === page.formId);
    if (form) {
      const metadata = form.metadata ?? {};
      const mode = Number(portalField(metadata, "mode") ?? 100000000);
      const sourceType = Number(portalField(metadata, "entitysourcetype") ?? 756150001);
      if (queryRecord(mode, sourceType, 756150000))
        return pick(form.entityName, portalField(metadata, "recordidquerystringparametername"));
    }
  }
  if (page.advancedFormId) {
    const form = portal.advancedForms?.find((candidate) => candidate.id === page.advancedFormId);
    const startId = String(portalField(form?.metadata ?? {}, "startstep") ?? "").toLowerCase();
    const step = (portal.records ?? []).find((record) => record.kind === "advancedformstep" && String(record.id).toLowerCase() === startId);
    if (step) {
      const mode = Number(portalField(step, "mode") ?? 100000000);
      const sourceType = Number(portalField(step, "entitysourcetype") ?? 100000001);
      if (queryRecord(mode, sourceType, 100000001))
        return pick(portalField(step, "targetentitylogicalname"), portalField(step, "primarykeyquerystringparametername"));
    }
  }
  const table = idParameterTable(pageSources(portal, page));
  return table ? pick(table, "id") : null;
}

const STATIC_INCLUDE = /\{%-?\s*include\s+(['"])([^'"]+)\1/g;
const ID_PARAMETER = String.raw`(?:request\s*\.\s*params|params)\s*(?:\.\s*id\b|\[\s*['"]id['"]\s*\])`;
const ENTITIES_BY_ID = new RegExp(String.raw`entities\s*(?:\[\s*['"]([A-Za-z_]\w*)['"]\s*\]|\.\s*([A-Za-z_]\w*))\s*\[\s*${ID_PARAMETER}\s*\]`, "i");
const FETCH_BY_ID = new RegExp(
  String.raw`<entity\s+name=["']([A-Za-z_]\w*)["'][\s\S]{0,4000}?<condition\s+attribute=["']([A-Za-z_]\w*)["']\s+operator=["']eq["']\s+value=["']\{\{\s*${ID_PARAMETER}\s*\}\}["']`,
  "i",
);

/** Sources rendered for a page: its web template, copy and statically included templates. */
function pageSources(portal, page) {
  const byName = new Map();
  for (const template of Object.values(portal.templates ?? {})) if (template?.name) byName.set(template.name.toLowerCase(), template);
  const pageTemplate = portal.pageTemplates?.find((candidate) => candidate.id === page.pageTemplateId);
  const queue = [portal.templates?.[pageTemplate?.webTemplateId]?.source, page.html, page.js].filter(Boolean);
  const sources = [];
  const seen = new Set();
  while (queue.length && sources.length < 200) {
    const source = queue.shift();
    sources.push(source);
    for (const match of source.matchAll(STATIC_INCLUDE)) {
      const name = match[2].toLowerCase();
      if (seen.has(name)) continue;
      seen.add(name);
      const template = byName.get(name);
      if (template?.source) queue.push(template.source);
    }
  }
  return sources;
}

/** The table a page reads with request.params.id (entities[...] or a FetchXML primary-key condition). */
export function idParameterTable(sources) {
  for (const source of sources) {
    const direct = ENTITIES_BY_ID.exec(source);
    if (direct) return direct[1] ?? direct[2];
    const fetch = FETCH_BY_ID.exec(source);
    if (fetch && fetch[2].toLowerCase() === `${fetch[1].toLowerCase()}id`) return fetch[1];
  }
  return null;
}

/** Classify one HTTP response and the diagnostics recorded for its path. */
export function classifyResponse({ status, contentType, body, diagnostics }) {
  const html = String(body ?? "");
  const isHtml = /text\/html/i.test(contentType ?? "");
  const document = isHtml && isHtmlDocument(html);
  const injected = document ? [] : INJECTION_MARKERS.filter((marker) => marker.pattern.test(html)).map((marker) => marker.name);
  const liquid = diagnostics.filter((diagnostic) => String(diagnostic.code ?? "").startsWith("liquid-"));
  return {
    status,
    contentType,
    bytes: Buffer.byteLength(html),
    document,
    injected,
    inlineErrors: [...new Set(html.match(INLINE_ERROR) ?? [])].slice(0, 10),
    liquidErrors: liquid.filter((diagnostic) => LIQUID_ERROR_CODES.has(diagnostic.code)),
    liquidNotices: liquid.filter((diagnostic) => !LIQUID_ERROR_CODES.has(diagnostic.code)),
    otherDiagnostics: diagnostics.filter((diagnostic) => !String(diagnostic.code ?? "").startsWith("liquid-")).map((diagnostic) => diagnostic.code),
  };
}

const compactDiagnostic = ({ code, message, filter, template, table }) => ({
  code,
  message: String(message ?? "").replace(/\s+/g, " ").slice(0, 300),
  ...(filter ? { filter } : {}),
  ...(template ? { template } : {}),
  ...(table ? { table } : {}),
});

/** Resolve the portal under test from --site, --source or --project. */
export async function resolveTarget(options) {
  if (options.project) {
    const { loadProjectConfig, projectOrigin, projectStateFile, projectSummary } = await import("./lib/project-config.mjs");
    const project = await loadProjectConfig(options.project);
    const portal = project.portals.find((candidate) => candidate.id === (options.portal ?? project.defaultPortal));
    if (!portal) throw new Error(`Portal '${options.portal ?? project.defaultPortal}' is not configured in ${project.configFile}`);
    return {
      id: portal.id,
      env: null,
      sourceDir: portal.sourceDir,
      solutionRoots: portal.solutionRoots ?? [],
      origin: projectOrigin(project, portal),
      deploymentProfile: portal.deploymentProfile,
      stateFile: options.state ?? projectStateFile(project, portal.id, path.join(TOOLKIT_ROOT, ".paqvilo", "simulator", "projects")),
      preset: options.preset ?? null,
      simulatorOptions: {
        project: projectSummary(project, portal.id),
        solutionOrder: project.solutionOrder,
        environmentVariables: project.environmentVariables,
        // Observed platform behaviour recorded for the portal (lib/project-config.mjs).
        observed: portal.observed ?? null,
      },
    };
  }
  if (options.source) {
    const sourceDir = path.resolve(options.source);
    const solutionRoots = options.solutionRoots.length
      ? options.solutionRoots.map((root) => path.resolve(root))
      : await (await import("./lib/solution-roots.mjs")).discoverSolutionRoots(sourceDir);
    return {
      id: options.portal ?? path.basename(sourceDir),
      env: null,
      sourceDir,
      solutionRoots,
      origin: null,
      stateFile: options.state ?? null,
      preset: options.preset ?? null,
      simulatorOptions: {},
    };
  }
  const { loadConfig } = await import("../lense/config.mjs");
  const cfg = await loadConfig({ site: options.site, env: options.env, ...(options.repo ? { repo: options.repo } : {}), ...(options.config ? { config: options.config } : {}) });
  const configuredRoots = cfg.mirageConfig?.solutionRoots ?? [];
  return {
    id: cfg.siteName,
    env: cfg.envName,
    sourceDir: cfg.sourceDir,
    solutionRoots: configuredRoots.length ? configuredRoots : await (await import("./lib/solution-roots.mjs")).discoverSolutionRoots(cfg.sourceDir),
    origin: cfg.origin,
    stateFile: options.state ?? path.join(TOOLKIT_ROOT, ".paqvilo", "simulator", cfg.siteName, "state.json"),
    preset: options.preset ?? cfg.mirageConfig?.preset ?? null,
    // Observed platform behaviour from the site's mirage settings (paqvilo.config.yml).
    simulatorOptions: { observed: cfg.mirageConfig?.observed ?? null, dataPacks: cfg.mirageConfig?.dataPacks ?? [] },
  };
}

/** Contact id of the synthetic signed-in personas (a role-override session, no contact row). */
export const SYNTHETIC_CONTACT_ID = "00000000-0000-4000-8000-00000000a11e";

/**
 * Web-role names a persona signs in with: the exported Authenticated Users role (the flagged
 * role, else the role with that name) or, for the coverage persona, every active exported
 * role except Anonymous Users.
 */
export function personaRoleNames(portal, { allRoles = false } = {}) {
  const truthy = (value) => value === true || String(value).toLowerCase() === "true";
  const roles = (portal.records ?? []).filter((record) => record.kind === "webrole" && Number(record.statecode ?? 0) === 0);
  const named = (role) => String(role.name ?? "").trim().toLowerCase();
  const flagged = roles.filter((role) => truthy(portalField(role, "authenticatedusersrole")));
  const selected = allRoles
    ? roles.filter((role) => !truthy(portalField(role, "anonymoususersrole")) && named(role) !== "anonymous users")
    : flagged.length
      ? flagged
      : roles.filter((role) => named(role) === "authenticated users");
  return [...new Set(selected.map((role) => String(role.name)))];
}

/**
 * Request headers that give portal requests the persona's identity. Personas change identity
 * only: the state's rows are never touched. Anonymous requests carry Fetch Metadata without a
 * session; signed-in personas carry the paqvilo-mirage-auth cookie of simulator.signIn().
 */
export function personaSession(simulator, persona) {
  if (persona === "anonymous") return { headers: { "sec-fetch-site": "none" }, identity: null, note: null };
  if (typeof simulator.signIn !== "function") return { headers: {}, identity: null, note: "runtime has no signIn; script requests keep the configured identity" };
  if (persona === "configured") {
    const configured = simulator.store.snapshot({ sections: ["simulator"] }).simulator?.identity ?? null;
    const contactId = configured?.contactId ?? configured?.id ?? null;
    if (!contactId) return { headers: { "sec-fetch-site": "none" }, identity: null, note: "no configured contact; requests are anonymous" };
    const session = simulator.signIn(contactId);
    return { headers: { cookie: session.cookieHeader }, identity: session.identity ?? configured, note: null };
  }
  const roles = personaRoleNames(simulator.portal, { allRoles: persona === COVERAGE_PERSONA });
  const session = simulator.signIn(SYNTHETIC_CONTACT_ID, { roles });
  return {
    headers: { cookie: session.cookieHeader },
    identity: session.identity ?? { contactId: SYNTHETIC_CONTACT_ID, roles },
    note: roles.length ? null : "no exported Authenticated Users role",
  };
}

async function sweepPersona(target, persona, options) {
  const isolated = await isolatedState(target.stateFile);
  let simulator;
  const started = Date.now();
  try {
    simulator = await createSimulator({
      sourceDir: target.sourceDir,
      stateFile: isolated.stateFile,
      origin: target.origin,
      solutionRoots: target.solutionRoots,
      deploymentProfile: target.deploymentProfile,
      watch: false,
      port: 0,
      ...target.simulatorOptions,
    });
    // Personas change identity only; a preset is applied when --preset (or the site) asks for it.
    const preset = target.preset ?? null;
    if (preset) await simulator.applyPreset(preset);
    const session = await personaSession(simulator, persona);
    const requestHeaders = session.headers;
    const identity = session.identity;
    const personaNote = session.note;
    const portal = simulator.portal;
    const pages = portal.pages
      .filter((page) => page.url && (!options.pathPrefix || page.url.toLowerCase().startsWith(options.pathPrefix.toLowerCase())))
      .sort((a, b) => a.url.localeCompare(b.url));
    const targets = [];
    for (const page of pages) {
      targets.push({ page, url: page.url, derived: null });
      const record = formRecordTarget(portal, simulator.store, page);
      if (record)
        targets.push({ page, url: `${page.url}?${encodeURIComponent(record.parameter)}=${encodeURIComponent(record.id)}`, derived: record });
    }
    const limited = Number.isInteger(options.limit) && options.limit > 0 ? targets.slice(0, options.limit) : targets;
    const results = [];
    for (const request of limited) {
      const requestStarted = new Date().toISOString();
      let status = 0;
      let contentType = null;
      let body = "";
      let failure = null;
      try {
        const response = await fetch(simulator.url + request.url, {
          redirect: "manual",
          headers: requestHeaders,
          signal: AbortSignal.timeout(180_000),
        });
        status = response.status;
        contentType = response.headers.get("content-type");
        body = await response.text();
      } catch (error) {
        failure = error.message;
      }
      const pathname = new URL(request.url, "http://local.invalid").pathname;
      const recorded = await (await fetch(`${simulator.url}/__sim/api/diagnostics`)).json();
      const diagnostics = (recorded.diagnostics ?? []).filter((diagnostic) => diagnostic.path === pathname && diagnostic.time >= requestStarted);
      const classified = classifyResponse({ status, contentType, body, diagnostics });
      results.push({
        url: request.url,
        page: request.page.name,
        pageId: request.page.id,
        derivedRecord: request.derived,
        ...(failure ? { failure } : {}),
        ...(options.keepBodies ? { body: body.slice(0, 20_000) } : {}),
        ...classified,
        liquidErrors: classified.liquidErrors.map(compactDiagnostic),
        liquidNotices: classified.liquidNotices.map(compactDiagnostic),
      });
    }
    const byStatus = {};
    for (const result of results) byStatus[result.status] = (byStatus[result.status] ?? 0) + 1;
    const codeCounts = {};
    for (const result of results)
      for (const diagnostic of [...result.liquidErrors, ...result.liquidNotices]) codeCounts[diagnostic.code] = (codeCounts[diagnostic.code] ?? 0) + 1;
    return {
      persona,
      personaNote,
      state: { source: target.stateFile ? path.resolve(target.stateFile) : null, copied: isolated.copied, preset },
      identity: identity ? { authenticated: Boolean(identity.id || identity.contactId), roles: identity.roles ?? [] } : null,
      durationMs: Date.now() - started,
      pages: pages.length,
      requests: results.length,
      byStatus,
      liquidDiagnosticCounts: codeCounts,
      liquidErrorPages: results.filter((result) => result.liquidErrors.length || result.inlineErrors.length).map((result) => result.url),
      injectedNonDocuments: results.filter((result) => result.injected.length).map((result) => ({ url: result.url, markers: result.injected })),
      failures: results.filter((result) => result.failure || result.status >= 500).map((result) => ({ url: result.url, status: result.status, failure: result.failure ?? null })),
      inventory: persona === personasToRun(options)[0] ? await inventoryPortal(portal) : null,
      results,
    };
  } finally {
    await simulator?.close();
    await fs.rm(isolated.directory, { recursive: true, force: true });
  }
}

const personasToRun = (options) =>
  options.persona === "both" ? PERSONAS : options.persona === "all" ? [...PERSONAS, COVERAGE_PERSONA] : [options.persona ?? "anonymous"];

export async function renderSweep(options) {
  const target = await resolveTarget(options);
  const personas = personasToRun(options);
  const runs = [];
  for (const persona of personas) runs.push(await sweepPersona(target, persona, options));
  const inventory = runs.find((run) => run.inventory)?.inventory ?? null;
  for (const run of runs) delete run.inventory;
  const report = {
    portal: target.id,
    env: target.env,
    sourceDir: target.sourceDir,
    solutionRoots: target.solutionRoots,
    inventory: inventory && {
      sources: inventory.sources,
      unsupported: inventory.unsupported,
      unknownFilters: inventory.unknownFilters,
      unknownTags: inventory.unknownTags,
      missingIncludes: inventory.missingIncludes,
      syntaxErrors: inventory.syntaxErrors,
    },
    runs,
  };
  report.summary = runs.map((run) => ciSummary(report, run));
  return report;
}

/** One CI line per persona: request and status counts, Liquid errors and unsupported constructs. */
export function ciSummary(report, run) {
  return {
    portal: report.portal,
    persona: run.persona,
    ...(run.personaNote ? { note: run.personaNote } : {}),
    pages: run.pages,
    requests: run.requests,
    statuses: run.byStatus,
    liquidErrorPages: run.liquidErrorPages.length,
    liquidErrors: Object.entries(run.liquidDiagnosticCounts)
      .filter(([code]) => LIQUID_ERROR_CODES.has(code))
      .reduce((sum, [, count]) => sum + count, 0),
    unknownFilterUses: run.liquidDiagnosticCounts["liquid-unknown-filter"] ?? 0,
    missingTemplateUses: run.liquidDiagnosticCounts["liquid-template-not-found"] ?? 0,
    unsupported: report.inventory?.unsupported.length ?? null,
    authoredSyntaxErrors: report.inventory?.syntaxErrors.length ?? null,
    injectedNonDocuments: run.injectedNonDocuments.length,
    failures: run.failures.length,
  };
}

function summarize(report) {
  const lines = [];
  lines.push(`Render sweep: ${report.portal}${report.env ? `/${report.env}` : ""} (${report.sourceDir})`);
  if (report.inventory)
    lines.push(
      `Inventory: ${report.inventory.sources.total} Liquid sources, unsupported ${report.inventory.unsupported.length}, unknown filters ${report.inventory.unknownFilters.join(", ") || "none"}, missing includes ${report.inventory.missingIncludes.length}, authored syntax errors ${report.inventory.syntaxErrors.length}`,
    );
  for (const run of report.runs) {
    lines.push(`-- persona ${run.persona}${run.personaNote ? ` (${run.personaNote})` : ""}`);
    lines.push(
      `State: ${run.state.copied ? `copy of ${run.state.source}` : "fresh"}${run.state.preset ? `, preset ${run.state.preset}` : ""}; identity ${run.identity?.authenticated ? `contact with roles ${run.identity.roles.join(", ") || "from memberships"}` : "anonymous"}`,
    );
    lines.push(`Pages: ${run.pages}, requests: ${run.requests}, ${(run.durationMs / 1000).toFixed(1)} s`);
    lines.push(`Status: ${Object.entries(run.byStatus).map(([status, count]) => `${status} x${count}`).join(", ")}`);
    lines.push(`Liquid diagnostics: ${Object.entries(run.liquidDiagnosticCounts).map(([code, count]) => `${code} x${count}`).join(", ") || "none"}`);
    lines.push(`Pages with Liquid errors: ${run.liquidErrorPages.length}`);
    for (const url of run.liquidErrorPages.slice(0, 40)) {
      const result = run.results.find((entry) => entry.url === url);
      const messages = [...result.liquidErrors.map((diagnostic) => diagnostic.message), ...result.inlineErrors];
      lines.push(`  ${url}: ${[...new Set(messages)].slice(0, 3).join(" | ")}`);
    }
    lines.push(`Non-document responses with local injection: ${run.injectedNonDocuments.length}`);
    for (const entry of run.injectedNonDocuments) lines.push(`  ${entry.url}: ${entry.markers.join(", ")}`);
    lines.push(`Failures (5xx or request errors): ${run.failures.length}`);
    for (const entry of run.failures.slice(0, 40)) lines.push(`  ${entry.url}: ${entry.failure ?? `HTTP ${entry.status}`}`);
  }
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help || (!options.site && !options.source && !options.project)) {
    console.log(
      "Usage: node mirage/render-sweep.mjs (--site NAME [--env NAME] | --source DIR [--portal ID] [--solution-root DIR]... | --project FILE [--portal ID]) [--persona anonymous|authenticated|all-roles|configured|both|all] [--preset NAME] [--state FILE] [--json] [--ci] [--out DIR] [--path PREFIX] [--limit N] [--strict] [--repo DIR]",
    );
    return options.help ? 0 : 2;
  }
  const report = await renderSweep(options);
  const summary = summarize(report);
  if (options.out) {
    await fs.mkdir(options.out, { recursive: true });
    await fs.writeFile(path.join(options.out, "render-sweep.json"), JSON.stringify(report, null, 2));
    await fs.writeFile(path.join(options.out, "render-sweep.txt"), `${summary}\n`);
    await fs.writeFile(path.join(options.out, "summary.json"), JSON.stringify(report.summary, null, 2));
  }
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else if (options.ci) for (const line of report.summary) console.log(JSON.stringify(line));
  else console.log(summary);
  const failed = report.runs.some((run) => run.liquidErrorPages.length || run.injectedNonDocuments.length || run.failures.length) || report.inventory?.unsupported.length;
  return options.strict && failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error.stack ?? String(error));
      process.exitCode = 2;
    },
  );
