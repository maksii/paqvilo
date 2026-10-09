import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { importPortal } from "./importer.mjs";
import { importSolutionMetadata } from "./solution-metadata.mjs";
import { importSolutionData } from "./solution-data.mjs";
import { scanSolutionSources, buildSolutionSchema } from "./solution-schema.mjs";
import { SolutionFileCache } from "./solution-cache.mjs";
import { applyObserved } from "./redirects.mjs";
import { isTenantAuthority } from "./external-login.mjs";

const VERSIONS = [1, 2];
const idPattern = /^[a-z0-9][a-z0-9._-]*$/i;
const KNOWN_KEYS = new Set([
  "version", "defaultPortal", "default_portal", "portals", "solutions", "references", "referenceEnvironments",
  "dataPacks", "presets", "lcid", "watch", "stateDirectory", "state_directory", "solutionOrder", "environmentVariables",
]);

function list(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function validateOrigin(value, label) {
  let url;
  try { url = new URL(String(value)); }
  catch { throw new Error(`${label} must be an HTTPS origin`); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw new Error(`${label} must be an HTTPS origin without credentials, path, query, or fragment`);
  return url.origin;
}

/** Observed values that are a choice between documented behaviours (B: Web API, data). */
const OBSERVED_CHOICES = {
  webApiInnerError: ["all-errors", "dataverse-errors"],
  anonymousDataAccess: ["allowed", "blocked"],
  // Which Bootstrap stylesheet the layout links: the platform's /css/bootstrap.min.css or the
  // site's bootstrap.min.css web file (read by lib/liquid.mjs; default from the export).
  bootstrapStylesheet: ["platform", "web-file"],
  // Webapi/<table>/fields = "*": "enforced" (the hosted default; read by the Web API policy)
  // or "exempt" (the site was observed exposing every column for such a table).
  webApiWildcard: ["enforced", "exempt"],
};

/**
 * Observed platform behaviour that the export cannot express, recorded per site with the
 * evidence for it: `{ loginPath?, headers?, webApiInnerError?, anonymousDataAccess?, bootstrapStylesheet?, evidence }`.
 * loginPath is the sign-in path the platform redirects to when the export sets no
 * Authentication/ApplicationCookie/LoginPath (sites without it answer /signin or /SignIn
 * online); webApiInnerError and anonymousDataAccess are read by the Web API and data
 * layers. Keys that are not given stay absent so each consumer applies its own default.
 * Any observation requires evidence naming where it was observed.
 */
export function observedConfig(value, label = "observed") {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value))
    if (!["evidence", "loginPath", "headers", "azureAdAuthority"].includes(key) && !Object.hasOwn(OBSERVED_CHOICES, key))
      throw new Error(`Unknown ${label} key '${key}'`);
  const observed = {};
  if (value.loginPath != null) {
    const loginPath = String(value.loginPath).trim();
    if (!/^\/(?!\/)[^?#\s]*$/.test(loginPath))
      throw new Error(`${label}.loginPath must be a site-relative path such as /SignIn`);
    observed.loginPath = loginPath;
  }
  // headers: { page?: { <name>: <value> }, webFile?: { <name>: <value> } }, the response
  // headers the platform sends on that kind of response although no exported site setting
  // defines them (lib/response-headers.mjs siteHeaders).
  if (value.headers != null) {
    if (typeof value.headers !== "object" || Array.isArray(value.headers)) throw new Error(`${label}.headers must map page and webFile to headers`);
    const headers = {};
    for (const [kind, entries] of Object.entries(value.headers)) {
      if (!["page", "webFile"].includes(kind)) throw new Error(`${label}.headers.${kind} must be page or webFile`);
      if (!entries || typeof entries !== "object" || Array.isArray(entries)) throw new Error(`${label}.headers.${kind} must map header names to values`);
      headers[kind] = {};
      for (const [name, raw] of Object.entries(entries)) {
        const header = String(raw ?? "").trim();
        if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(name) || !header || /[\r\n]/.test(header))
          throw new Error(`${label}.headers.${kind}.${name} must be a header name with a one-line value`);
        headers[kind][name.toLowerCase()] = header;
      }
    }
    if (Object.values(headers).some((entries) => Object.keys(entries).length)) observed.headers = headers;
  }
  // azureAdAuthority: the authority the built-in Microsoft Entra provider posts on the site
  // when the export carries no Authentication/OpenIdConnect/AzureAD/Authority (lib/external-login.mjs).
  // An observation names one tenant: a placeholder is never recorded as observed.
  if (value.azureAdAuthority != null) {
    const authority = String(value.azureAdAuthority).trim();
    if (!isTenantAuthority(authority))
      throw new Error(`${label}.azureAdAuthority must be the observed Microsoft Entra authority of one tenant, https://login.windows.net/<tenant>/ with the tenant's directory ID or domain name (not a placeholder, common or organizations)`);
    observed.azureAdAuthority = authority;
  }
  for (const [key, choices] of Object.entries(OBSERVED_CHOICES)) {
    if (value[key] == null) continue;
    if (!choices.includes(value[key])) throw new Error(`${label}.${key} must be ${choices.join(" or ")}`);
    observed[key] = value[key];
  }
  if (!Object.keys(observed).length) return null;
  const evidence = typeof value.evidence === "string" ? value.evidence.trim() : "";
  if (!evidence) throw new Error(`${label}.evidence must name the observation behind ${Object.keys(observed).join(", ")}`);
  return { ...observed, evidence };
}
function normalizePortal(entry, index) {
  if (typeof entry === "string") entry = { path: entry };
  if (!entry || typeof entry !== "object" || Array.isArray(entry))
    throw new Error(`portals[${index}] must be a path or object`);
  const sourcePath = entry.path ?? entry.source ?? entry.sourceDir;
  if (typeof sourcePath !== "string" || !sourcePath.trim())
    throw new Error(`portals[${index}].path is required`);
  const id = String(entry.id ?? `portal-${index + 1}`);
  if (!idPattern.test(id)) throw new Error(`Invalid portal id '${id}'`);
  const solutions = entry.solutions == null ? null : list(entry.solutions, `portals[${index}].solutions`).map(String);
  return {
    id,
    sourcePath,
    origin: entry.origin == null ? null : validateOrigin(entry.origin, `portals[${index}].origin`),
    deploymentProfile: entry.deploymentProfile ?? entry.deployment_profile ?? null,
    solutionIds: solutions,
    reference: entry.reference == null ? null : String(entry.reference),
    observed: observedConfig(entry.observed, `portals[${index}].observed`),
    // The site's data model when the source does not record it (lib/importer.mjs dataModel).
    dataModel: dataModelOf(entry.dataModel, `portals[${index}].dataModel`),
  };
}
function dataModelOf(value, label) {
  if (value == null) return null;
  if (!["standard", "enhanced"].includes(value)) throw new Error(`${label} must be standard or enhanced`);
  return value;
}

function normalizeSolution(entry, index) {
  if (typeof entry === "string") entry = { path: entry };
  if (!entry || typeof entry !== "object" || Array.isArray(entry))
    throw new Error(`solutions[${index}] must be a path or object`);
  const sourcePath = entry.path ?? entry.source ?? entry.root;
  if (typeof sourcePath !== "string" || !sourcePath.trim())
    throw new Error(`solutions[${index}].path is required`);
  const id = String(entry.id ?? `solution-${index + 1}`);
  if (!idPattern.test(id)) throw new Error(`Invalid solution id '${id}'`);
  return { id, sourcePath };
}

function normalizeReference(ref, index) {
  if (!ref || typeof ref !== "object" || Array.isArray(ref))
    throw new Error(`references[${index}] must be an object`);
  const id = String(ref.id ?? `reference-${index + 1}`);
  if (!idPattern.test(id)) throw new Error(`Invalid reference id '${id}'`);
  if (typeof ref.origin !== "string")
    throw new Error(`references[${index}].origin must be an HTTPS origin`);
  if (ref.default !== undefined && typeof ref.default !== "boolean")
    throw new Error(`references[${index}].default must be a boolean`);
  return {
    id,
    origin: validateOrigin(ref.origin, `references[${index}].origin`),
    ...(ref.name ? { name: String(ref.name) } : {}),
    ...(ref.environment ? { environment: String(ref.environment) } : {}),
    default: ref.default === true,
  };
}

function normalizeDataPack(entry, index) {
  if (typeof entry === "string") entry = { module: entry };
  if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.module !== "string" || !entry.module.trim())
    throw new Error(`dataPacks[${index}] must be a module path or { id, module }`);
  const id = String(entry.id ?? path.basename(entry.module).replace(/\.[cm]?js$/i, "").replace(/^index$/i, path.basename(path.dirname(entry.module))));
  if (!idPattern.test(id)) throw new Error(`Invalid data pack id '${id}'`);
  return { id, modulePath: entry.module };
}

/**
 * Parse and validate a source-only Mirage project file (YAML or JSON).
 * Version 1 files keep loading unchanged; version 2 adds per-portal solution
 * selection, references with a default, data packs, lcid, watch, a state
 * directory override, solution order and local environment-variable values.
 */
export async function loadProjectConfig(configFile) {
  const absoluteConfig = path.resolve(configFile);
  const source = await fs.readFile(absoluteConfig, "utf8");
  const raw = /\.json$/i.test(absoluteConfig) ? JSON.parse(source) : YAML.parse(source);
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Project configuration must be an object");
  if (!VERSIONS.includes(raw.version))
    throw new Error(`Project configuration version must be ${VERSIONS.join(" or ")}`);
  if (raw.version >= 2)
    for (const key of Object.keys(raw))
      if (!KNOWN_KEYS.has(key)) throw new Error(`Unknown project configuration key '${key}'`);
  const portalEntries = list(raw.portals, "portals").map(normalizePortal);
  if (!portalEntries.length) throw new Error("At least one portal source is required");
  const solutionEntries = list(raw.solutions, "solutions").map(normalizeSolution);
  const unique = (entries, kind) => {
    const seen = new Set();
    for (const entry of entries) {
      if (seen.has(entry.id)) throw new Error(`Duplicate ${kind} id '${entry.id}'`);
      seen.add(entry.id);
    }
  };
  unique(portalEntries, "portal");
  unique(solutionEntries, "solution");
  const base = path.dirname(absoluteConfig);
  const resolveSource = async (sourcePath, kind, id) => {
    const resolved = path.resolve(base, sourcePath);
    let stat;
    try { stat = await fs.stat(resolved); }
    catch { throw new Error(`${kind} '${id}' source directory does not exist: ${resolved}`); }
    if (!stat.isDirectory()) throw new Error(`${kind} '${id}' source is not a directory: ${resolved}`);
    return fs.realpath(resolved);
  };
  const solutions = await Promise.all(solutionEntries.map(async (solution) => ({
    ...solution,
    root: await resolveSource(solution.sourcePath, "Solution", solution.id),
  })));
  const byId = new Map(solutions.map((solution) => [solution.id, solution]));
  const references = list(raw.references ?? raw.referenceEnvironments, "references").map(normalizeReference);
  unique(references, "reference");
  if (references.filter((ref) => ref.default).length > 1)
    throw new Error("Only one reference can be the default");
  const defaultReference = references.find((ref) => ref.default) ?? (references.length === 1 ? references[0] : null);
  const portals = await Promise.all(portalEntries.map(async ({ solutionIds, ...portal }) => {
    for (const solutionId of solutionIds ?? [])
      if (!byId.has(solutionId)) throw new Error(`Portal '${portal.id}' selects unknown solution '${solutionId}'`);
    if (portal.reference && !references.some((ref) => ref.id === portal.reference))
      throw new Error(`Portal '${portal.id}' selects unknown reference '${portal.reference}'`);
    const selected = (solutionIds ?? solutions.map((solution) => solution.id)).map((solutionId) => byId.get(solutionId));
    return {
      ...portal,
      sourceDir: await resolveSource(portal.sourcePath, "Portal", portal.id),
      solutions: selected.map((solution) => solution.id),
      solutionRoots: selected.map((solution) => solution.root),
    };
  }));
  const defaultPortal = raw.defaultPortal ?? raw.default_portal ?? portals[0].id;
  if (!portals.some((portal) => portal.id === defaultPortal))
    throw new Error(`defaultPortal '${defaultPortal}' is not configured`);
  const dataPacks = await Promise.all(list(raw.dataPacks ?? raw.presets, "dataPacks").map(normalizeDataPack).map(async (pack) => {
    const module = path.resolve(base, pack.modulePath);
    try {
      if (!(await fs.stat(module)).isFile()) throw new Error();
    } catch {
      throw new Error(`Data pack '${pack.id}' module does not exist: ${module}`);
    }
    return { id: pack.id, module };
  }));
  unique(dataPacks, "data pack");
  const lcid = raw.lcid ?? 1033;
  if (!Number.isInteger(lcid) || lcid <= 0) throw new Error("lcid must be a positive integer");
  if (raw.watch !== undefined && typeof raw.watch !== "boolean") throw new Error("watch must be a boolean");
  // Solution roots are a set layered in dependency order; "explicit" keeps the listed order.
  const solutionOrder = raw.solutionOrder ?? "derived";
  if (!["explicit", "derived"].includes(solutionOrder)) throw new Error("solutionOrder must be explicit or derived");
  const stateDirectoryValue = raw.stateDirectory ?? raw.state_directory;
  if (stateDirectoryValue !== undefined && (typeof stateDirectoryValue !== "string" || !stateDirectoryValue.trim()))
    throw new Error("stateDirectory must be a path");
  const environmentVariables = raw.environmentVariables ?? {};
  if (!environmentVariables || typeof environmentVariables !== "object" || Array.isArray(environmentVariables))
    throw new Error("environmentVariables must map schema names to values");
  for (const [name, value] of Object.entries(environmentVariables))
    if (!/^[a-z][\w.]*$/i.test(name) || !["string", "number", "boolean"].includes(typeof value))
      throw new Error(`environmentVariables.${name} must be a string, number or boolean value`);
  return {
    configFile: absoluteConfig,
    stateNamespace: createHash("sha256").update(absoluteConfig).update("\0").update(portals.map((p) => p.sourceDir).join("\0")).digest("hex").slice(0, 16),
    version: raw.version,
    defaultPortal,
    lcid,
    watch: raw.watch ?? null,
    stateDirectory: stateDirectoryValue ? path.resolve(base, stateDirectoryValue) : null,
    solutionOrder,
    portals,
    solutions,
    solutionRoots: solutions.map((solution) => solution.root),
    references,
    defaultReference,
    dataPacks,
    environmentVariables: Object.fromEntries(Object.entries(environmentVariables).map(([name, value]) => [name, String(value)])),
  };
}

/** Live origin for a portal: its own origin, else its selected or the default reference. */
export function projectOrigin(project, portal) {
  if (portal.origin) return portal.origin;
  const reference = portal.reference
    ? project.references.find((ref) => ref.id === portal.reference)
    : project.defaultReference;
  return reference?.origin ?? null;
}

/** State file for a project portal (state directory override, else the project namespace). */
export function projectStateFile(project, portalId, defaultRoot) {
  return path.join(project.stateDirectory ?? path.join(defaultRoot, project.stateNamespace), portalId, "state.json");
}

/** JSON-safe project summary exposed by the runtime status (status.project). */
export function projectSummary(project, portalId = null) {
  return {
    configFile: project.configFile,
    version: project.version,
    portal: portalId,
    defaultPortal: project.defaultPortal,
    lcid: project.lcid,
    watch: project.watch,
    solutionOrder: project.solutionOrder,
    stateDirectory: project.stateDirectory,
    portals: project.portals.map(({ id, sourceDir, origin, deploymentProfile, solutions, reference, observed, dataModel }) => ({
      id, sourceDir, origin: origin ?? projectOrigin(project, { origin, reference }), deploymentProfile, solutions, reference, observed: observed ?? null, dataModel: dataModel ?? null,
    })),
    solutions: project.solutions.map(({ id, root }) => ({ id, root })),
    references: project.references,
    defaultReference: project.defaultReference?.id ?? null,
    dataPacks: project.dataPacks,
    environmentVariables: Object.keys(project.environmentVariables ?? {}),
  };
}

/** Import all configured sources locally and deterministically; this performs no network access. */
export async function bootstrapProject(project, { lcid = project.lcid ?? 1033, cacheFile } = {}) {
  const cache = await SolutionFileCache.open(cacheFile ?? null);
  // Duplicate-copy commit lookups of the portal exports, cached beside the solution cache.
  const portalCache = await SolutionFileCache.open(cacheFile ? path.join(path.dirname(cacheFile), "portal-sources.json") : null);
  const scans = new Map();
  const loadLayers = async (roots) => {
    const key = JSON.stringify(roots);
    if (!scans.has(key)) {
      const scan = await scanSolutionSources(roots, { cache, order: project.solutionOrder ?? "derived" });
      scans.set(key, { scan, schema: buildSolutionSchema(scan, { lcid }) });
    }
    return scans.get(key);
  };
  const portals = [];
  for (const source of project.portals) {
    const portal = applyObserved(await importPortal(source.sourceDir, {
      lcid,
      cache: portalCache,
      ...(source.deploymentProfile ? { deploymentProfile: source.deploymentProfile } : {}),
      ...(source.dataModel ? { dataModel: source.dataModel } : {}),
    }), source.observed);
    const roots = source.solutionRoots ?? project.solutionRoots;
    const { scan, schema } = await loadLayers(roots);
    const metadata = await importSolutionMetadata(roots, { portal, lcid, scan, schema });
    const solutionData = await importSolutionData(roots, { scan, schema, lcid });
    portals.push({ ...source, portal, metadata, solutionData });
  }
  const shared = await loadLayers(project.solutionRoots);
  const solutionData = await importSolutionData(project.solutionRoots, { ...shared, lcid });
  await cache.save();
  await portalCache.save();
  return { project, portals, solutionData };
}
