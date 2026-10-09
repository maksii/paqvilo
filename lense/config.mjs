// Configuration, from the most general to the most specific:
//
//   paqvilo.config.yml        the team's catalogue: every portal, its source folder, its
//                              environments, and how sources map to the site        (committed)
//   paqvilo.config.local.yml  optional personal additions in the same format       (git-ignored)
//   .env                       personal choices: which site/environment, browser... (git-ignored)
//   PAQVILO_* environment variables of the shell
//   command line options
//
// Later ones win. Nothing in lense/ needs to change to add a portal or an environment.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import YAML from 'yaml';
import { detectFormat, portalSourceDir, unsupportedSourceLayout } from './portal-model.mjs';
import { validateCatalogue, normalizeCatalogue, httpUrl, startPath, debugPort, browserProfile, browserProfileDirectory, browserUserDataDir } from './config-schema.mjs';

/**
 * @typedef {object} RouteRule
 * @property {string} url glob on the URL path (`*` = one segment, `**` = any depth)
 * @property {string} [file] local file, relative to the site source
 * @property {string} [dir] local folder the `**` part is resolved in, relative to the site source
 * @property {boolean} [passthrough] keep serving this URL from the online site
 *
 * @typedef {object} SiteConfig
 * @property {string} source
 * @property {string} [defaultEnv]
 * @property {Record<string, {url: string, baseline?: string, scope?: string, startPath?: string, caution?: boolean}>} environments
 * @property {string} startPath
 * @property {{enabled: boolean, exclude: string[]}} webFiles
 * @property {{enabled: boolean, kinds: string[], minSimilarity: number, injectMissingPageBlocks: boolean}} inline
 * @property {{enabled: boolean, kinds: string[], baseline: string}} markup
 * @property {'all'|'changed'} scope
 * @property {RouteRule[]} routes
 * @property {{project?: string|null, solutionRoots?: string[], dataPacks?: Array<string|{id?: string, module: string}>, port?: number|null, preset?: string|null}|null} [mirage]
 *   local Mirage runtime settings; see resolveMirageConfig
 */

export const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SITE_DEFAULTS = {
  startPath: '/',
  webFiles: { enabled: true, exclude: [] },
  inline: {
    enabled: true,
    kinds: ['page-js', 'page-css', 'basic-form-js', 'advanced-form-step-js', 'list-js'],
    minSimilarity: 0.5,
    injectMissingPageBlocks: true,
  },
  markup: {
    enabled: true,
    kinds: ['web-template', 'content-snippet', 'page-copy', 'page-summary', 'metadata-markup'],
    baseline: 'HEAD',
  },
  scope: 'all',
  routes: [],
};

const ROOT_DEFAULTS = {
  portals: 'selected',
  agent: { enabled: true },
  browser: { channel: 'msedge', headless: false, profileDir: '.paqvilo/profiles', profile: null, userDataDir: null, profileDirectory: null, cdpUrl: null, debugPort: null, bypassCSP: false },
  liveReload: true,
  panel: true,
  editor: 'code',
  sourceMaps: true,
};

/** Settings a developer can put in .env (or the shell). Shown by `paqvilo list --settings`. */
export const ENV_SETTINGS = {
  PAQVILO_REPO: 'portal checkout/worktree root; shared relative site sources resolve below it (CLI: --repo)',
  PAQVILO_AGENT: 'false = disable the authenticated local agent API for the dedicated dev browser',
  PAQVILO_PORTALS: "'all' = configured origins in one browser; 'selected' = one origin; default comes from the catalogue",
  PAQVILO_SITE: 'site (portal) to work on',
  PAQVILO_ENV: 'environment of that site',
  PAQVILO_URL: 'site URL to use instead of a configured environment',
  PAQVILO_SOURCE: 'extract folder to use instead of the configured one',
  PAQVILO_SCOPE: "'all' or 'changed'",
  PAQVILO_BASELINE: 'git ref that stands for what is deployed',
  PAQVILO_START_PATH: 'optional first tab only; navigation and new tabs are always overlaid automatically',
  PAQVILO_BROWSER: "'msedge', 'chrome' or 'chromium'",
  PAQVILO_HEADLESS: 'true = no browser window',
  PAQVILO_DEBUG_PORT: 'debugger port, 0 = off',
  PAQVILO_CDP_URL: 'attach to a browser you started yourself',
  PAQVILO_BYPASS_CSP: 'true = explicitly bypass Content-Security-Policy in this dev browser (default false)',
  PAQVILO_PROFILE_DIR: 'where browser profiles are kept',
  PAQVILO_PROFILE: 'named toolkit browser profile, case-insensitive (letters, numbers, underscores or hyphens; up to 64 characters)',
  PAQVILO_USER_DATA_DIR: 'explicit existing browser user-data root (relative to the catalogue directory)',
  PAQVILO_PROFILE_DIRECTORY: 'profile folder inside PAQVILO_USER_DATA_DIR, such as Default or Profile 1',
  PAQVILO_LIVE_RELOAD: 'false = do not reload tabs on save',
  PAQVILO_PANEL: 'false = no dev panel on the page',
  PAQVILO_EDITOR: "command that opens a file from the dev panel as '<command> -g file:line' (default: code)",
  PAQVILO_SOURCE_MAPS: 'false = serve scripts without debugger support',
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, over) {
  if (!isPlainObject(base) || !isPlainObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (['__proto__', 'prototype', 'constructor'].includes(k)) throw new Error(`Invalid configuration key: ${k}`);
    out[k] = deepMerge(Object.hasOwn(base, k) ? base[k] : undefined, v);
  }
  return out;
}

function readYamlFile(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return YAML.parse(fs.readFileSync(file, 'utf8')) ?? {};
  } catch (err) {
    throw new Error(`${path.basename(file)} is not valid YAML: ${err.message.split('\n')[0]}`);
  }
}

/** The .env next to the config file, with the shell's PAQVILO_* variables laid over it. */
export function readEnvSettings(configDir, processEnv = process.env) {
  const file = path.join(configDir, '.env');
  const fromFile = fs.existsSync(file) ? parseEnv(fs.readFileSync(file, 'utf8')) : {};
  const out = {};
  const origin = {};
  for (const [source, vars] of [['.env', fromFile], ['shell', processEnv]]) {
    for (const [key, value] of Object.entries(vars)) {
      if (!key.startsWith('PAQVILO_') || value === undefined || String(value).trim() === '') continue;
      if (key === 'PAQVILO_DEBUG' || key === 'PAQVILO_KEEP_TEMP') continue; // diagnostics switches, not settings
      // Profile identity/path spelling is significant. In particular, trimming a quoted
      // directory ending in a space could silently select a different existing profile.
      out[key] = ['PAQVILO_PROFILE', 'PAQVILO_USER_DATA_DIR', 'PAQVILO_PROFILE_DIRECTORY'].includes(key) ? String(value) : String(value).trim();
      origin[key] = source;
    }
  }
  return { values: out, origin, file };
}

function bool(value, name) {
  if (/^(?:1|true|yes|on)$/i.test(value)) return true;
  if (/^(?:0|false|no|off)$/i.test(value)) return false;
  throw new Error(`${name} must be true or false, not "${value}"`);
}

/**
 * Sites and environments declared through variables, so a developer can add a sandbox or point a
 * site at another checkout without touching the shared catalogue:
 *   PAQVILO_<SITE>_SOURCE=<folder>        PAQVILO_<SITE>_ENV_<NAME>=<url>
 */
function sitesFromEnv(values) {
  const sites = Object.create(null);
  const known = new Set(Object.keys(ENV_SETTINGS));
  for (const [key, value] of Object.entries(values)) {
    if (known.has(key)) continue;
    let m;
    if ((m = /^PAQVILO_([A-Z0-9]+)_ENV_([A-Z0-9_]+)$/.exec(key))) {
      const site = (sites[m[1].toLowerCase()] ??= {});
      (site.environments ??= {})[m[2].toLowerCase().replace(/_/g, '-')] = { url: value };
    } else if ((m = /^PAQVILO_([A-Z0-9]+)_SOURCE$/.exec(key))) {
      (sites[m[1].toLowerCase()] ??= {}).source = value;
    } else {
      throw new Error(`Unknown setting ${key}. Known: ${[...known].join(', ')}, PAQVILO_<SITE>_SOURCE, PAQVILO_<SITE>_ENV_<NAME>`);
    }
  }
  return sites;
}

/**
 * Reads the catalogue (all sites and environments) without selecting one.
 * @param {{config?: string}} opts
 */
export function loadCatalogue(opts = {}, processEnv = process.env) {
  const localConfig = path.join(process.cwd(), 'paqvilo.config.yml');
  const configFile = path.resolve(opts.config ?? (fs.existsSync(localConfig) ? localConfig : path.join(TOOL_ROOT, 'paqvilo.config.yml')));
  const base = readYamlFile(configFile);
  if (!base) throw new Error(`Config file not found: ${configFile}`);
  const configDir = path.dirname(configFile);
  const local = readYamlFile(path.join(configDir, 'paqvilo.config.local.yml'));
  const settings = readEnvSettings(configDir, processEnv);
  let root = deepMerge(deepMerge(ROOT_DEFAULTS, normalizeCatalogue(base, path.basename(configFile))), normalizeCatalogue(local ?? {}, 'personal config'));
  root = deepMerge(root, { sites: sitesFromEnv(settings.values) });
  validateCatalogue(root);

  const sourceRootSetting = opts.repo ?? settings.values.PAQVILO_REPO ?? root.sourceRoot ?? '.';
  if (typeof sourceRootSetting !== 'string' || !sourceRootSetting.trim() || /[\x00-\x1f\x7f]/.test(sourceRootSetting)) throw new Error('Portal repository root must be a non-empty path without control characters');
  const sourceRoot = path.resolve(opts.repo !== undefined ? process.cwd() : configDir, sourceRootSetting);

  const sites = {};
  for (const [name, raw] of Object.entries(root.sites ?? {})) {
    if (!isPlainObject(raw)) continue;
    const site = deepMerge(deepMerge(SITE_DEFAULTS, root.defaults ?? {}), raw);
    site.environments = Object.fromEntries(
      Object.entries(site.environments ?? {})
        // "reference-portal: https://..." is short for "reference-portal: { url: https://... }"
        .map(([env, value]) => [env, typeof value === 'string' ? { url: value } : value])
        .filter(([, value]) => isPlainObject(value) && value.url),
    );
    // Named personal overrides retain their existing catalogue-relative path semantics.
    const personalSource = settings.values[`PAQVILO_${name.toUpperCase()}_SOURCE`];
    site.sourceDir = site.source ? path.resolve(personalSource ? configDir : sourceRoot, site.source) : null;
    sites[name] = site;
  }
  return { configFile, configDir, sourceRoot, root, sites, settings };
}

export function isExtract(dir) {
  return detectFormat(dir) !== null;
}

/**
 * Absolute Mirage settings of a site: `project` and `dataPacks` modules resolve from the catalogue
 * folder, `solutionRoots` from the portal checkout root (like `source`). Nothing is read or checked
 * here; the mirage and doctor commands report missing files.
 * @param {object|null|undefined} raw the site's `mirage` mapping merged over `defaults.mirage`
 * @param {{configDir: string, sourceRoot: string}} where
 */
export function resolveMirageConfig(raw, { configDir, sourceRoot }) {
  const value = isPlainObject(raw) ? raw : {};
  return {
    project: value.project ? path.resolve(configDir, value.project) : null,
    solutionRoots: (value.solutionRoots ?? []).map((root) => path.resolve(sourceRoot, root)),
    // Solution roots are a set layered in their dependency order; explicit keeps the listed order.
    solutionOrder: value.solutionOrder === 'explicit' ? 'explicit' : 'derived',
    dataPacks: (value.dataPacks ?? []).map((entry) => (typeof entry === 'string'
      ? { id: null, module: path.resolve(configDir, entry) }
      : { id: entry.id ?? null, module: path.resolve(configDir, entry.module) })),
    port: Number.isInteger(value.port) ? value.port : null,
    preset: value.preset ?? null,
    // Passed through as configured; the Mirage validates it (observedConfig).
    observed: isPlainObject(value.observed) ? structuredClone(value.observed) : null,
    // standard or enhanced, only when configured; otherwise the source decides (lib/importer.mjs dataModel).
    ...(value.dataModel ? { dataModel: value.dataModel } : {}),
  };
}

/**
 * Resolves one site + environment into the settings a session runs with.
 * @param {{config?: string, site?: string, env?: string, url?: string, source?: string, scope?: string,
 *          baseline?: string, path?: string, headless?: boolean, 'debug-port'?: string}} opts command line options
 */
export async function loadConfig(opts = {}, processEnv = process.env, { checkSource = true } = {}) {
  return resolveConfig(loadCatalogue(opts, processEnv), opts, { checkSource });
}

function resolveConfig(catalogue, opts, { initial = true, validSources = new Set(), checkSource = true } = {}) {
  const { configFile, configDir, root, sites, settings } = catalogue;
  const s = settings.values;
  const portals = opts.portals ?? s.PAQVILO_PORTALS ?? root.portals;
  if (!['selected', 'all'].includes(portals)) throw new Error(`portals must be 'selected' or 'all', not "${portals}"`);
  const names = Object.keys(sites);
  if (!names.length) throw new Error(`No sites in ${path.basename(configFile)}. Add one under "sites:".`);

  // --- which site
  const siteName = opts.site ?? s.PAQVILO_SITE ?? root.defaultSite ?? names[0];
  const site = Object.hasOwn(sites, siteName) ? sites[siteName] : null;
  if (!site) throw new Error(`Unknown site "${siteName}". Known sites: ${names.join(', ')}. Run "npm run list" to see them.`);
  const siteFrom = opts.site ? 'command line' : s.PAQVILO_SITE ? settings.origin.PAQVILO_SITE : path.basename(configFile);

  // --- which environment
  const envNames = Object.keys(site.environments);
  const url = opts.url ?? ((!opts.site && !opts.env) ? s.PAQVILO_URL : undefined);
  let envName;
  let envFrom;
  const notes = [];
  if (s.PAQVILO_URL && !url) notes.push('PAQVILO_URL is ignored because --site or --env explicitly selects a catalogue environment');
  if (url) {
    envName = 'custom';
    envFrom = opts.url ? 'command line' : settings.origin.PAQVILO_URL;
  } else if (opts.env) {
    envName = opts.env;
    envFrom = 'command line';
  } else if (s.PAQVILO_ENV && (!opts.site || opts.site === s.PAQVILO_SITE)) {
    envName = s.PAQVILO_ENV;
    envFrom = settings.origin.PAQVILO_ENV;
  } else {
    envName = site.defaultEnv ?? envNames[0];
    envFrom = path.basename(configFile);
    // The remembered environment was chosen for another site. Even if this site has one of the
    // same name, "--site x" alone should not silently land on, say, its TEST.
    if (s.PAQVILO_ENV) notes.push(`PAQVILO_ENV=${s.PAQVILO_ENV} was chosen for site "${s.PAQVILO_SITE ?? root.defaultSite}"; for "${siteName}" its default "${envName}" is used (add --env to choose)`);
  }
  const env = url ? { url } : Object.hasOwn(site.environments, envName) ? site.environments[envName] : null;
  if (!env?.url) {
    throw new Error(`Unknown environment "${envName}" for site "${siteName}". Known: ${envNames.join(', ') || '(none)'}. Run "npm run list" to see them.`);
  }
  const origin = httpUrl(env.url, `URL for site "${siteName}", environment "${envName}"`).origin;

  // --- where the sources are
  const sourceSetting = opts.source ?? (!opts.site ? s.PAQVILO_SOURCE : undefined);
  if (s.PAQVILO_SOURCE && !sourceSetting) notes.push('PAQVILO_SOURCE is ignored because --site explicitly selects the catalogue source (use --source to override it)');
  // A code-site project folder is read through its .powerpages-site/ folder (short-key YAML).
  const sourceDir = portalSourceDir(sourceSetting ? path.resolve(opts.source ? process.cwd() : configDir, sourceSetting) : site.sourceDir);
  if (!sourceDir) throw new Error(`Site "${siteName}" has no "source" folder configured`);
  if (checkSource && !validSources.has(sourceDir) && !isExtract(sourceDir)) {
    // A layout the toolkit cannot read is named, so it is never treated as an empty portal.
    const layout = unsupportedSourceLayout(sourceDir);
    if (layout) throw new Error(`"${sourceDir}" (source of site "${siteName}") is ${layout.label}, which the toolkit does not treat as a portal: use a PAC YAML export with adx_ keys, a .powerpages-site export or the site's unpacked Solution (powerpagecomponents/)`);
    throw new Error(`"${sourceDir}" (source of site "${siteName}") does not look like a portal extract: it has no web-files/, web-pages/ or powerpagecomponents/ folder`);
  }
  if (checkSource) validSources.add(sourceDir);

  // --- how to overlay: site settings, then the environment's own, then personal ones
  const scope = opts.scope ?? s.PAQVILO_SCOPE ?? env.scope ?? site.scope;
  if (!['all', 'changed'].includes(scope)) throw new Error(`scope must be 'all' or 'changed', not "${scope}"`);
  const resolvedSite = {
    ...structuredClone(site),
    scope,
    startPath: (initial ? opts.path ?? s.PAQVILO_START_PATH : undefined) ?? env.startPath ?? site.startPath,
    markup: { ...site.markup, baseline: opts.baseline ?? s.PAQVILO_BASELINE ?? env.baseline ?? site.markup.baseline },
  };
  startPath(resolvedSite.startPath);
  if (typeof resolvedSite.markup.baseline !== 'string' || !resolvedSite.markup.baseline.trim() || /[\x00-\x1f]/.test(resolvedSite.markup.baseline)) throw new Error('baseline must be a non-empty git ref');

  const browser = { ...root.browser };
  browser.channel = opts.browser ?? s.PAQVILO_BROWSER ?? browser.channel;
  if (!['msedge', 'chrome', 'chromium'].includes(browser.channel)) throw new Error(`browser must be 'msedge', 'chrome' or 'chromium', not "${browser.channel}"`);
  if (s.PAQVILO_HEADLESS) browser.headless = bool(s.PAQVILO_HEADLESS, 'PAQVILO_HEADLESS');
  if (opts.headless) browser.headless = true;
  if (opts.headed) browser.headless = false;
  if (opts.headless && opts.headed) throw new Error('--headless and --headed cannot be used together');
  browser.cdpUrl = opts['cdp-url'] ?? s.PAQVILO_CDP_URL ?? browser.cdpUrl;
  if (s.PAQVILO_BYPASS_CSP) browser.bypassCSP = bool(s.PAQVILO_BYPASS_CSP, 'PAQVILO_BYPASS_CSP');
  if (s.PAQVILO_PROFILE_DIR) browser.profileDir = s.PAQVILO_PROFILE_DIR;
  browser.profile = opts.profile ?? s.PAQVILO_PROFILE ?? browser.profile;
  browser.userDataDir = opts['user-data-dir'] ?? s.PAQVILO_USER_DATA_DIR ?? browser.userDataDir;
  browser.profileDirectory = opts['profile-directory'] ?? s.PAQVILO_PROFILE_DIRECTORY ?? browser.profileDirectory;
  if (browser.profile !== null) { browserProfile(browser.profile); browser.profile = browser.profile.toLowerCase(); }
  if (browser.userDataDir !== null) {
    browserUserDataDir(browser.userDataDir);
    browser.userDataDir = path.resolve(opts['user-data-dir'] !== undefined ? process.cwd() : configDir, browser.userDataDir);
  }
  if (browser.profileDirectory !== null) browserProfileDirectory(browser.profileDirectory);
  if (browser.profile !== null && browser.userDataDir !== null) throw new Error('browser.profile (--profile / PAQVILO_PROFILE) cannot be combined with browser.userDataDir (--user-data-dir / PAQVILO_USER_DATA_DIR); choose a named toolkit profile or an existing browser root');
  if (browser.profileDirectory !== null && browser.userDataDir === null) throw new Error('browser.profileDirectory (--profile-directory / PAQVILO_PROFILE_DIRECTORY) requires browser.userDataDir (--user-data-dir / PAQVILO_USER_DATA_DIR)');
  if (browser.cdpUrl && [browser.profile, browser.userDataDir, browser.profileDirectory].some((value) => value !== null)) throw new Error('browser.cdpUrl (--cdp-url / PAQVILO_CDP_URL) cannot be combined with browser.profile, browser.userDataDir or browser.profileDirectory; an attached browser already owns its profile');
  const port = opts['debug-port'] ?? s.PAQVILO_DEBUG_PORT;
  if (port != null) {
    if (!/^\d+$/.test(String(port))) throw new Error(`debug port must be a number, not "${port}"`);
    browser.debugPort = Number(port) || null;
  }
  browser.debugPort = debugPort(browser.debugPort);
  if (browser.cdpUrl) httpUrl(browser.cdpUrl, 'browser.cdpUrl', ['http:', 'https:', 'ws:', 'wss:']);

  return {
    configFile,
    configDir,
    sourceRoot: catalogue.sourceRoot,
    siteName,
    envName,
    origin,
    sourceDir,
    portals,
    site: resolvedSite,
    // a real system with real users' data: the summary and the dev panel say so
    caution: Boolean(env.caution),
    browser,
    agent: { enabled: s.PAQVILO_AGENT ? bool(s.PAQVILO_AGENT, 'PAQVILO_AGENT') : root.agent.enabled },
    liveReload: s.PAQVILO_LIVE_RELOAD ? bool(s.PAQVILO_LIVE_RELOAD, 'PAQVILO_LIVE_RELOAD') : root.liveReload,
    panel: s.PAQVILO_PANEL ? bool(s.PAQVILO_PANEL, 'PAQVILO_PANEL') : root.panel,
    editor: s.PAQVILO_EDITOR ?? root.editor,
    sourceMaps: s.PAQVILO_SOURCE_MAPS ? bool(s.PAQVILO_SOURCE_MAPS, 'PAQVILO_SOURCE_MAPS') : root.sourceMaps,
    stateDir: path.join(configDir, '.paqvilo'),
    /** local Mirage runtime settings (`sites.<id>.mirage` over `defaults.mirage`), absolute */
    mirageConfig: resolveMirageConfig(site.mirage, { configDir, sourceRoot: catalogue.sourceRoot }),
    /** where the choice of site and environment came from, for the summary */
    chosen: { site: siteFrom, env: envFrom },
    notes,
  };
}

/** Resolve all dev origins once, before any browser or source model is created. */
export async function loadDevTargets(opts = {}, processEnv = process.env) {
  const catalogue = loadCatalogue(opts, processEnv);
  if ((opts.portals ?? catalogue.settings.values.PAQVILO_PORTALS ?? catalogue.root.portals) === 'all') {
    const s = catalogue.settings.values;
    const conflicts = [opts.url !== undefined && '--url', opts.source !== undefined && '--source', s.PAQVILO_URL && 'PAQVILO_URL', s.PAQVILO_SOURCE && 'PAQVILO_SOURCE'].filter(Boolean);
    if (conflicts.length) throw new Error(`portals=all cannot be combined with ${conflicts.join(', ')}. Configure each portal with sites or PAQVILO_<SITE>_SOURCE / PAQVILO_<SITE>_ENV_<NAME>, or use --portals selected.`);
  }
  const validSources = new Set();
  const initial = resolveConfig(catalogue, opts, { validSources });
  if (initial.portals === 'selected') return { mode: 'selected', initial, targets: [initial] };
  const targets = [];
  const byOrigin = new Map();
  for (const [site, entry] of Object.entries(catalogue.sites)) {
    const environments = Object.keys(entry.environments);
    if (!environments.length) throw new Error(`Site "${site}" has no environments configured for portals=all`);
    for (const env of environments) {
      const target = site === initial.siteName && env === initial.envName ? initial
        : resolveConfig(catalogue, { ...opts, site, env }, { initial: false, validSources, checkSource: false });
      if (target !== initial) target.chosen = { site: 'configured portal coverage', env: 'configured portal coverage' };
      const previous = byOrigin.get(target.origin);
      if (previous) throw new Error(`Duplicate portal origin ${target.origin}: "${previous.siteName} @ ${previous.envName}" and "${site} @ ${env}". Each origin must identify exactly one portal/environment in portals=all.`);
      byOrigin.set(target.origin, target);
      targets.push(target);
    }
  }
  return { mode: 'all', initial, targets };
}
