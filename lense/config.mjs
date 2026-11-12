import { identityProviderSettings, identityProviderAssets } from '../mirage/lib/identity-provider-settings.mjs';
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
import { resolveLocalOverrides } from '../mirage/lib/local-overrides.mjs';
import { detectFormat, portalSourceDir, unsupportedSourceLayout } from './portal-model.mjs';
import { validateDebuggerMode } from './browser-profile.mjs';
import {
  validateCatalogue,
  normalizeCatalogue,
  httpUrl,
  startPath,
  debugPort,
  browserProfile,
  browserProfileDirectory,
  browserUserDataDir,
} from './config-schema.mjs';
import { resolveCatalogueSettings } from '../mirage/lib/config-keys.mjs';
import '../mirage/lib/provider-modules.mjs';

/** A deliberate configuration error with a stable `code`; scripts match on it and analyze reports it. */
const configurationError = (message, code = 'configuration_error') => Object.assign(new Error(message), { code });

/** The codes of the errors above and of the existing ones that analyze reports with their own message. */
export const CONFIGURATION_ERROR_CODES = new Set([
  'CONFIG_NOT_FOUND',
  'configuration_error',
  'invalid_argument',
  'mirage_only_site',
  'source_not_configured',
  'source_unsupported_layout',
  'source_not_portal_extract',
]);

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
  browser: {
    channel: 'msedge',
    headless: false,
    profileDir: '.paqvilo/profiles',
    profile: null,
    userDataDir: null,
    profileDirectory: null,
    cdpUrl: null,
    debugPort: null,
    bypassCSP: false,
  },
  liveReload: true,
  panel: true,
  editor: 'code',
  sourceMaps: true,
};

/** Settings a developer can put in .env (or the shell). Shown by `paqvilo list --settings`. */
export const ENV_SETTINGS = {
  PAQVILO_REPO: 'portal checkout/worktree root; shared relative site sources resolve below it (CLI: --repo)',
  PAQVILO_AGENT: 'false = disable the authenticated local agent API for the dedicated dev browser',
  PAQVILO_PORTALS:
    "'all' = configured origins in one browser; 'selected' = one origin; default comes from the catalogue",
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
  PAQVILO_PROFILE:
    'named toolkit browser profile, case-insensitive (letters, numbers, underscores or hyphens; up to 64 characters)',
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
    if (['__proto__', 'prototype', 'constructor'].includes(k))
      throw configurationError(`Invalid configuration key: ${k}`);
    out[k] = deepMerge(Object.hasOwn(base, k) ? base[k] : undefined, v);
  }
  return out;
}

function readYamlFile(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return YAML.parse(fs.readFileSync(file, 'utf8')) ?? {};
  } catch (err) {
    // YAML errors can contain private values, so only the bounded first line is exposed and the cause is not chained.
    throw configurationError(`${path.basename(file)} is not valid YAML: ${err.message.split('\n')[0]}`);
  }
}

// Read directly by tools, scripts, Mirage and Code Apps, so they are not catalogue settings.
const TOOL_VARIABLES = new Set([
  'PAQVILO_DEBUG',
  'PAQVILO_KEEP_TEMP',
  'PAQVILO_XRM_SDK',
  'PAQVILO_PAC_EXECUTABLE',
  'PAQVILO_GIT_EXECUTABLE',
  'PAQVILO_TOOL_CACHE',
  'PAQVILO_MIRAGE_URL',
  'PAQVILO_CODE_APP',
  'PAQVILO_ACTIVITY_SCREENSHOTS',
  'PAQVILO_EVIDENCE_DIR',
  'PAQVILO_MIRAGE_ADMIN_EVIDENCE',
  'PAQVILO_MIRAGE_EVIDENCE_DIR',
  'PAQVILO_REVIEW_SCOPE',
  'PAQVILO_UI_SCREENSHOTS',
]);

/** The .env next to the config file, with the shell's PAQVILO_* variables laid over it. */
export function readEnvSettings(configDir, processEnv = process.env) {
  const file = path.join(configDir, '.env');
  const fromFile = fs.existsSync(file) ? parseEnv(fs.readFileSync(file, 'utf8')) : {};
  const out = {};
  const origin = {};
  for (const [source, vars] of [
    ['.env', fromFile],
    ['shell', processEnv],
  ]) {
    for (const [key, value] of Object.entries(vars)) {
      if (!key.startsWith('PAQVILO_') || value === undefined || String(value).trim() === '') continue;
      if (TOOL_VARIABLES.has(key)) continue;
      // Profile identity/path spelling is significant. In particular, trimming a quoted
      // directory ending in a space could silently select a different existing profile.
      out[key] = ['PAQVILO_PROFILE', 'PAQVILO_USER_DATA_DIR', 'PAQVILO_PROFILE_DIRECTORY'].includes(key)
        ? String(value)
        : String(value).trim();
      origin[key] = source;
    }
  }
  return { values: out, origin, file };
}

function bool(value, name) {
  if (/^(?:1|true|yes|on)$/i.test(value)) return true;
  if (/^(?:0|false|no|off)$/i.test(value)) return false;
  throw configurationError(`${name} must be true or false, not "${value}"`);
}

function siteFromSettings(sites, siteName) {
  let site = sites[siteName];
  if (site == null) {
    site = {};
    sites[siteName] = site;
  }
  return site;
}

/** How a site name is written in its variables: upper case, with "-" written as "_". */
const envSegment = (siteName) => siteName.toUpperCase().replaceAll('-', '_');

/** The segment and environment (null for a source) of PAQVILO_<SEGMENT>_SOURCE or PAQVILO_<SEGMENT>_ENV_<NAME>. */
function parseSiteVariable(key) {
  const source = /^PAQVILO_([A-Z0-9_]+)_SOURCE$/.exec(key);
  if (source) return { segment: source[1], environment: null };
  const environment = /^PAQVILO_([A-Z0-9_]+?)_ENV_([A-Z0-9_]+)$/.exec(key);
  return environment ? { segment: environment[1], environment: environment[2] } : null;
}

/** The declared site a segment names; only a segment that names no declared site names a new one. */
function siteForSegment(segment, declared) {
  const matches = declared.filter((name) => envSegment(name) === segment);
  if (matches.length > 1)
    throw configurationError(
      `${segment} matches more than one site (${matches.join(', ')}), so PAQVILO_${segment}_* is ambiguous`,
    );
  return matches[0] ?? segment.toLowerCase();
}

function addSiteVariable(sites, siteName, variable, value) {
  const site = siteFromSettings(sites, siteName);
  if (variable.environment === null) {
    site.source = value;
    return;
  }
  if (site.environments == null) site.environments = {};
  site.environments[variable.environment.toLowerCase().replaceAll('_', '-')] = { url: value };
}

/**
 * Sites and environments declared through variables, so a developer can add a sandbox or point a
 * site at another checkout without touching the shared catalogue:
 *   PAQVILO_<SITE>_SOURCE=<folder>        PAQVILO_<SITE>_ENV_<NAME>=<url>
 * <SITE> is a declared site's name in upper case with "_" for "-"; only an unmatched name adds a site.
 */
function sitesFromEnv(values, declared) {
  const sites = Object.create(null);
  const known = new Set(Object.keys(ENV_SETTINGS));
  for (const [key, value] of Object.entries(values)) {
    if (known.has(key)) continue;
    const variable = parseSiteVariable(key);
    if (!variable)
      throw configurationError(
        `Unknown setting ${key}. Known: ${[...known].join(', ')}, PAQVILO_<SITE>_SOURCE, PAQVILO_<SITE>_ENV_<NAME>`,
      );
    addSiteVariable(sites, siteForSegment(variable.segment, declared), variable, value);
  }
  return sites;
}

function resolvedCatalogueSite(name, raw, root, settings, sourceRoot, configDir) {
  if (!isPlainObject(raw)) return null;
  const site = deepMerge(deepMerge(SITE_DEFAULTS, root.defaults ?? {}), raw);
  site.environments = Object.fromEntries(
    Object.entries(site.environments ?? {})
      // "example-site: https://..." is short for "example-site: { url: https://... }"
      .map(([env, value]) => [env, typeof value === 'string' ? { url: value } : value])
      .filter(([, value]) => isPlainObject(value) && value.url),
  );
  // Named personal overrides retain their existing catalogue-relative path semantics.
  const personalSource = settings.values[`PAQVILO_${envSegment(name)}_SOURCE`];
  if (site.source) {
    const sourceBase = personalSource ? configDir : sourceRoot;
    site.sourceDir = path.resolve(sourceBase, site.source);
  } else site.sourceDir = null;
  return site;
}

function catalogueFieldOrigin(name, field, local) {
  return local?.sites?.[name]?.mirage?.[field] !== undefined || local?.defaults?.mirage?.[field] !== undefined
    ? 'local config'
    : 'catalogue';
}

function catalogueSiteSourceOrigin(name, settings, local) {
  if (settings.values[`PAQVILO_${envSegment(name)}_SOURCE`])
    return settings.origin[`PAQVILO_${envSegment(name)}_SOURCE`];
  if (local?.sites?.[name]?.source !== undefined) return 'local config';
  return 'catalogue';
}

function catalogueProvenance(sites, opts, settings, local) {
  let sourceRootOrigin;
  if (opts.repo !== undefined) sourceRootOrigin = 'command line';
  else if (settings.values.PAQVILO_REPO) sourceRootOrigin = settings.origin.PAQVILO_REPO;
  else if (local?.sourceRoot !== undefined) sourceRootOrigin = 'local config';
  else sourceRootOrigin = 'catalogue';
  return {
    sourceRoot: sourceRootOrigin,
    sites: Object.fromEntries(
      Object.keys(sites).map((name) => [
        name,
        {
          sourceDir: catalogueSiteSourceOrigin(name, settings, local),
          solutionRoots: catalogueFieldOrigin(name, 'solutionRoots', local),
          port: catalogueFieldOrigin(name, 'port', local),
          stateFile: catalogueFieldOrigin(name, 'project', local),
        },
      ]),
    ),
  };
}

/**
 * Reads the catalogue (all sites and environments) without selecting one.
 * @param {{config?: string}} opts
 */
export function loadCatalogue(opts = {}, processEnv = process.env) {
  const localConfig = path.join(process.cwd(), 'paqvilo.config.yml');
  const configFile = path.resolve(
    opts.config ?? (fs.existsSync(localConfig) ? localConfig : path.join(TOOL_ROOT, 'paqvilo.config.yml')),
  );
  const base = readYamlFile(configFile);
  if (!base) throw Object.assign(new Error(`Config file not found: ${configFile}`), { code: 'CONFIG_NOT_FOUND' });
  const configDir = path.dirname(configFile);
  const local = readYamlFile(path.join(configDir, 'paqvilo.config.local.yml'));
  const settings = readEnvSettings(configDir, processEnv);
  const root = catalogueRoot(base, local ?? {}, settings.values);

  const sourceRootSetting = opts.repo ?? settings.values.PAQVILO_REPO ?? root.sourceRoot ?? '.';
  // eslint-disable-next-line no-control-regex -- Control-character matching is deliberate validation or redaction at this boundary.
  if (typeof sourceRootSetting !== 'string' || !sourceRootSetting.trim() || /[\x00-\x1f\x7f]/.test(sourceRootSetting))
    throw configurationError('Portal repository root must be a non-empty path without control characters');
  const sourceRoot = path.resolve(opts.repo !== undefined ? process.cwd() : configDir, sourceRootSetting);

  const sites = {};
  for (const [name, raw] of Object.entries(root.sites ?? {})) {
    const site = resolvedCatalogueSite(name, raw, root, settings, sourceRoot, configDir);
    if (site) sites[name] = site;
  }
  const provenance = catalogueProvenance(sites, opts, settings, local);
  return { configFile, configDir, sourceRoot, root, sites, settings, provenance };
}

/** Shared parsing/validation for file loading and setup edits; never executes project modules. */
export function catalogueRoot(base, local = {}, settings = {}) {
  let root = deepMerge(
    deepMerge(ROOT_DEFAULTS, normalizeCatalogue(base, 'catalogue')),
    normalizeCatalogue(local, 'personal config'),
  );
  root = deepMerge(root, { sites: sitesFromEnv(settings, Object.keys(root.sites ?? {})) });
  validateCatalogue(root);
  return root;
}

/**
 * A site whose Mirage runtime is standalone (model-driven, dataverse-api) and that names no portal export and no environment:
 * it runs only as a local Mirage (mirage dev/start --site), never as a Lense target, so it needs neither.
 */
export const mirageOnlySite = (site) =>
  !site?.source &&
  !Object.keys(site?.environments ?? {}).length &&
  typeof site?.mirage?.runtime?.kind === 'string' &&
  site.mirage.runtime.kind !== 'power-pages';

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
export function resolveMirageConfig(raw, { configDir, sourceRoot, sourceDir = sourceRoot }) {
  const value = isPlainObject(raw) ? raw : {};
  if (value.presetConfiguration !== undefined && !['data-only', 'apply'].includes(value.presetConfiguration))
    throw configurationError('mirage.presetConfiguration must be data-only or apply');
  if (value.presetMode !== undefined && !['bootstrap', 'always'].includes(value.presetMode))
    throw configurationError('mirage.presetMode must be bootstrap or always');
  if (value.identityProvider !== undefined)
    identityProviderAssets(identityProviderSettings(value.identityProvider), configDir);
  // Every key resolves through its row in mirage/lib/config-keys.mjs; compat and head become localOverrides.
  return {
    ...resolveCatalogueSettings(value, { configDir, sourceRoot, sourceDir }),
    ...(value.compat !== undefined || value.head !== undefined
      ? { localOverrides: resolveLocalOverrides(value, configDir) }
      : {}),
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

function selectedConfigSite(catalogue, opts, initial) {
  const { configFile, root, sites, settings } = catalogue,
    s = settings.values;
  const portals = opts.portals ?? s.PAQVILO_PORTALS ?? root.portals;
  if (!['selected', 'all'].includes(portals))
    throw configurationError(`portals must be 'selected' or 'all', not "${portals}"`);
  const names = Object.keys(sites);
  if (!names.length) throw configurationError(`No sites in ${path.basename(configFile)}. Add one under "sites:".`);
  const siteName = opts.site ?? s.PAQVILO_SITE ?? root.defaultSite ?? names[0];
  const site = Object.hasOwn(sites, siteName) ? sites[siteName] : null;
  if (!site)
    throw Object.assign(
      new Error(`Unknown site "${siteName}". Known sites: ${names.join(', ')}. Run "npm run list" to see them.`),
      { code: initial && opts.site !== undefined ? 'invalid_argument' : 'configuration_error' },
    );
  let siteFrom;
  if (opts.site) siteFrom = 'command line';
  else if (s.PAQVILO_SITE) siteFrom = settings.origin.PAQVILO_SITE;
  else siteFrom = path.basename(configFile);
  if (mirageOnlySite(site))
    throw Object.assign(
      new Error(
        `Site "${siteName}" is a ${site.mirage.runtime.kind} Mirage site without a portal: it is not a Lense target. Start it with "npx paqvilo mirage dev --site ${siteName}".`,
      ),
      { code: 'mirage_only_site' },
    );
  return { portals, siteName, site, siteFrom };
}

function chooseConfigEnvironment(siteName, site, opts, settings, configFile, root) {
  const s = settings.values,
    envNames = Object.keys(site.environments),
    url = opts.url ?? (!opts.site && !opts.env ? s.PAQVILO_URL : undefined),
    notes = [];
  let envName;
  let envFrom;
  if (s.PAQVILO_URL && !url)
    notes.push('PAQVILO_URL is ignored because --site or --env explicitly selects a catalogue environment');
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
    if (s.PAQVILO_ENV)
      notes.push(
        `PAQVILO_ENV=${s.PAQVILO_ENV} was chosen for site "${s.PAQVILO_SITE ?? root.defaultSite}"; for "${siteName}" its default "${envName}" is used (add --env to choose)`,
      );
  }
  return { envNames, url, envName, envFrom, notes };
}

function selectedConfigEnvironment(siteName, site, opts, settings, configFile, root, initial) {
  const { envNames, url, envName, envFrom, notes } = chooseConfigEnvironment(
    siteName,
    site,
    opts,
    settings,
    configFile,
    root,
  );
  let env;
  if (url) env = { url };
  else if (Object.hasOwn(site.environments, envName)) env = site.environments[envName];
  else env = null;
  if (!env?.url)
    throw Object.assign(
      new Error(
        `Unknown environment "${envName}" for site "${siteName}". Known: ${envNames.join(', ') || '(none)'}. Run "npm run list" to see them.`,
      ),
      { code: initial && opts.env !== undefined ? 'invalid_argument' : 'configuration_error' },
    );
  return { envName, env, envFrom, notes };
}

function selectedConfigSource(siteName, site, opts, settings, configDir, { validSources, checkSource, notes }) {
  const s = settings.values,
    sourceSetting = opts.source ?? (!opts.site ? s.PAQVILO_SOURCE : undefined);
  if (s.PAQVILO_SOURCE && !sourceSetting)
    notes.push(
      'PAQVILO_SOURCE is ignored because --site explicitly selects the catalogue source (use --source to override it)',
    );
  // A code-site project folder is read through its .powerpages-site/ folder (short-key YAML).
  let configuredSourceDir;
  if (sourceSetting) {
    const baseDirectory = opts.source ? process.cwd() : configDir;
    configuredSourceDir = path.resolve(baseDirectory, sourceSetting);
  } else configuredSourceDir = site.sourceDir;
  const sourceDir = portalSourceDir(configuredSourceDir);
  if (!sourceDir)
    throw configurationError(`Site "${siteName}" has no "source" folder configured`, 'source_not_configured');
  if (checkSource && !validSources.has(sourceDir) && !isExtract(sourceDir)) {
    // A layout the toolkit cannot read is named, so it is never treated as an empty portal.
    const layout = unsupportedSourceLayout(sourceDir);
    if (layout)
      throw configurationError(
        `"${sourceDir}" (source of site "${siteName}") is ${layout.label}, which the toolkit does not treat as a portal: use a PAC YAML export with adx_ keys, a .powerpages-site export or the site's unpacked Solution (powerpagecomponents/)`,
        'source_unsupported_layout',
      );
    throw configurationError(
      `"${sourceDir}" (source of site "${siteName}") does not look like a portal extract: it has no web-files/, web-pages/ or powerpagecomponents/ folder`,
      'source_not_portal_extract',
    );
  }
  if (checkSource) validSources.add(sourceDir);
  return sourceDir;
}

function resolvedConfigSite(site, opts, settings, env, initial) {
  const s = settings.values,
    scope = opts.scope ?? s.PAQVILO_SCOPE ?? env.scope ?? site.scope;
  if (!['all', 'changed'].includes(scope)) throw configurationError(`scope must be 'all' or 'changed', not "${scope}"`);
  const resolvedSite = {
    ...structuredClone(site),
    scope,
    startPath: (initial ? (opts.path ?? s.PAQVILO_START_PATH) : undefined) ?? env.startPath ?? site.startPath,
    markup: { ...site.markup, baseline: opts.baseline ?? s.PAQVILO_BASELINE ?? env.baseline ?? site.markup.baseline },
  };
  startPath(resolvedSite.startPath);
  if (
    typeof resolvedSite.markup.baseline !== 'string' ||
    !resolvedSite.markup.baseline.trim() ||
    // eslint-disable-next-line no-control-regex -- Control-character matching is deliberate validation or redaction at this boundary.
    /[\x00-\x1f]/.test(resolvedSite.markup.baseline)
  )
    throw configurationError('baseline must be a non-empty git ref');
  return resolvedSite;
}

function resolveConfig(catalogue, opts, { initial = true, validSources = new Set(), checkSource = true } = {}) {
  const { configFile, configDir, root, settings } = catalogue;
  const s = settings.values;
  const { portals, siteName, site, siteFrom } = selectedConfigSite(catalogue, opts, initial);
  const { envName, env, envFrom, notes } = selectedConfigEnvironment(
    siteName,
    site,
    opts,
    settings,
    configFile,
    root,
    initial,
  );
  const origin = httpUrl(env.url, `URL for site "${siteName}", environment "${envName}"`).origin;
  const sourceDir = selectedConfigSource(siteName, site, opts, settings, configDir, {
    validSources,
    checkSource,
    notes,
  });
  const resolvedSite = resolvedConfigSite(site, opts, settings, env, initial);

  const browser = browserSettings({ browser: root.browser, options: opts, settings: s, configDir });

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
    mirageConfig: resolveMirageConfig(site.mirage, { configDir, sourceRoot: catalogue.sourceRoot, sourceDir }),
    /** where the choice of site and environment came from, for the summary */
    chosen: { site: siteFrom, env: envFrom },
    notes,
  };
}

function validatePortalsAllOptions(opts, catalogue) {
  if ((opts.portals ?? catalogue.settings.values.PAQVILO_PORTALS ?? catalogue.root.portals) !== 'all') return;
  const s = catalogue.settings.values;
  const conflicts = [
    opts.url !== undefined && '--url',
    opts.source !== undefined && '--source',
    s.PAQVILO_URL && 'PAQVILO_URL',
    s.PAQVILO_SOURCE && 'PAQVILO_SOURCE',
  ].filter(Boolean);
  if (conflicts.length)
    throw configurationError(
      `portals=all cannot be combined with ${conflicts.join(', ')}. Configure each portal with sites or PAQVILO_<SITE>_SOURCE / PAQVILO_<SITE>_ENV_<NAME>, or use --portals selected.`,
    );
}

function resolveInitialDevTarget(catalogue, opts, validSources) {
  try {
    return resolveConfig(catalogue, opts, { validSources });
  } catch (error) {
    // portals=all covers the portal sites; a Mirage-only default site does not select a Lense target.
    if (
      error.code !== 'mirage_only_site' ||
      opts.site !== undefined ||
      (opts.portals ?? catalogue.settings.values.PAQVILO_PORTALS ?? catalogue.root.portals) !== 'all'
    )
      throw error;
    return null;
  }
}

function addEnvironmentTarget(catalogue, opts, initial, validSources, targets, byOrigin, { site, env }) {
  const target =
    site === initial?.siteName && env === initial?.envName
      ? initial
      : resolveConfig(catalogue, { ...opts, site, env }, { initial: false, validSources, checkSource: false });
  if (target.caution && !catalogue.root.includeCaution && !(site === initial?.siteName && opts.env === env)) return;
  if (target !== initial) target.chosen = { site: 'configured portal coverage', env: 'configured portal coverage' };
  const previous = byOrigin.get(target.origin);
  if (previous)
    throw configurationError(
      `Duplicate portal origin ${target.origin}: "${previous.siteName} @ ${previous.envName}" and "${site} @ ${env}". Each origin must identify exactly one portal/environment in portals=all.`,
    );
  byOrigin.set(target.origin, target);
  targets.push(target);
}

function collectAllDevTargets(catalogue, opts, initial, validSources) {
  const targets = [],
    byOrigin = new Map();
  for (const [site, entry] of Object.entries(catalogue.sites)) {
    if (mirageOnlySite(entry)) continue;
    const environments = Object.keys(entry.environments);
    if (!environments.length) throw configurationError(`Site "${site}" has no environments configured for portals=all`);
    for (const env of environments)
      addEnvironmentTarget(catalogue, opts, initial, validSources, targets, byOrigin, { site, env });
  }
  return targets;
}

function chooseAllDevInitial(catalogue, initial, targets) {
  if (!targets.includes(initial)) initial = targets[0];
  // Every site is a Mirage-only site: a valid catalogue with no Lense target (list succeeds and names them; dev refuses).
  const mirageOnly = Object.entries(catalogue.sites)
    .filter(([, entry]) => mirageOnlySite(entry))
    .map(([site]) => site);
  if (!initial && mirageOnly.length === Object.keys(catalogue.sites).length && mirageOnly.length)
    throw Object.assign(
      new Error(
        `Every configured site is a Mirage site without a portal (${mirageOnly.join(', ')}): there is no Lense target. Start one with "npx paqvilo mirage dev --site <site>".`,
      ),
      { code: 'mirage_only_site' },
    );
  if (!initial)
    throw configurationError(
      'No non-caution targets are configured; select an environment explicitly or set includeCaution: true.',
    );
  return initial;
}

/** Resolve all dev origins once, before any browser or source model is created. */
export async function loadDevTargets(opts = {}, processEnv = process.env) {
  const catalogue = loadCatalogue(opts, processEnv);
  validatePortalsAllOptions(opts, catalogue);
  const validSources = new Set();
  let initial = resolveInitialDevTarget(catalogue, opts, validSources);
  if (initial?.portals === 'selected') return { mode: 'selected', initial, targets: [initial] };
  const targets = collectAllDevTargets(catalogue, opts, initial, validSources);
  initial = chooseAllDevInitial(catalogue, initial, targets);
  return { mode: 'all', initial, targets };
}

function resolveBrowserProfilePaths(browser, opts, configDir) {
  if (browser.profile !== null) {
    browserProfile(browser.profile);
    browser.profile = browser.profile.toLowerCase();
  }
  if (browser.userDataDir !== null) {
    browserUserDataDir(browser.userDataDir);
    browser.userDataDir = path.resolve(
      opts['user-data-dir'] !== undefined ? process.cwd() : configDir,
      browser.userDataDir,
    );
  }
  if (browser.profileDirectory !== null) browserProfileDirectory(browser.profileDirectory);
}

function setBrowserChannel(browser, opts, settings) {
  browser.channel = opts.browser ?? settings.PAQVILO_BROWSER ?? browser.channel;
  if (!['msedge', 'chrome', 'chromium'].includes(browser.channel))
    throw configurationError(`browser must be 'msedge', 'chrome' or 'chromium', not "${browser.channel}"`);
}

function setBrowserMode(browser, opts, settings) {
  if (settings.PAQVILO_HEADLESS) browser.headless = bool(settings.PAQVILO_HEADLESS, 'PAQVILO_HEADLESS');
  if (opts.headless) browser.headless = true;
  if (opts.headed) browser.headless = false;
  if (opts.headless && opts.headed) throw configurationError('--headless and --headed cannot be used together');
}

function validateBrowserProfileCombination(browser) {
  if (browser.profile !== null && browser.userDataDir !== null)
    throw configurationError(
      'browser.profile (--profile / PAQVILO_PROFILE) cannot be combined with browser.userDataDir (--user-data-dir / PAQVILO_USER_DATA_DIR); choose a named toolkit profile or an existing browser root',
    );
  if (browser.profileDirectory !== null && browser.userDataDir === null)
    throw configurationError(
      'browser.profileDirectory (--profile-directory / PAQVILO_PROFILE_DIRECTORY) requires browser.userDataDir (--user-data-dir / PAQVILO_USER_DATA_DIR)',
    );
  if (
    browser.cdpUrl &&
    [browser.profile, browser.userDataDir, browser.profileDirectory].some((value) => value !== null)
  )
    throw configurationError(
      'browser.cdpUrl (--cdp-url / PAQVILO_CDP_URL) cannot be combined with browser.profile, browser.userDataDir or browser.profileDirectory; an attached browser already owns its profile',
    );
}

function resolveBrowserDebugPort(browser, opts, settings) {
  const port = opts['debug-port'] ?? settings.PAQVILO_DEBUG_PORT;
  if (port != null) {
    if (!/^\d+$/.test(String(port))) throw configurationError(`debug port must be a number, not "${port}"`);
    browser.debugPort = Number(port) || null;
  }
  browser.debugPort = debugPort(browser.debugPort);
}

/** Browser selection independent of a portal/site catalogue, shared by standalone Mirage. */
export function browserSettings({
  browser: input,
  options: opts = {},
  settings: s = {},
  configDir = process.cwd(),
} = {}) {
  const browser = { ...(input ?? ROOT_DEFAULTS.browser) };
  setBrowserChannel(browser, opts, s);
  setBrowserMode(browser, opts, s);
  browser.cdpUrl = opts['cdp-url'] ?? s.PAQVILO_CDP_URL ?? browser.cdpUrl;
  if (s.PAQVILO_BYPASS_CSP) browser.bypassCSP = bool(s.PAQVILO_BYPASS_CSP, 'PAQVILO_BYPASS_CSP');
  if (s.PAQVILO_PROFILE_DIR) browser.profileDir = s.PAQVILO_PROFILE_DIR;
  browser.profile = opts.profile ?? s.PAQVILO_PROFILE ?? browser.profile;
  browser.userDataDir = opts['user-data-dir'] ?? s.PAQVILO_USER_DATA_DIR ?? browser.userDataDir;
  browser.profileDirectory = opts['profile-directory'] ?? s.PAQVILO_PROFILE_DIRECTORY ?? browser.profileDirectory;
  resolveBrowserProfilePaths(browser, opts, configDir);
  validateBrowserProfileCombination(browser);
  resolveBrowserDebugPort(browser, opts, s);
  if (browser.cdpUrl) httpUrl(browser.cdpUrl, 'browser.cdpUrl', ['http:', 'https:', 'ws:', 'wss:']);
  validateDebuggerMode(browser.cdpUrl, browser.debugPort);
  return browser;
}
