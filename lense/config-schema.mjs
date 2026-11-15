// Validate configuration before it can become a browser URL, path, or routing rule.
import { catalogueKeys, parseSetting } from '../mirage/lib/config-keys.mjs';
const BLOCK_KINDS = ['page-js', 'page-css', 'basic-form-js', 'advanced-form-step-js', 'list-js'];
const MARKUP_KINDS = ['web-template', 'content-snippet', 'page-copy', 'page-summary', 'metadata-markup'];
const chooseLazily = (condition, yes, no) => {
  if (condition()) return yes();
  return no();
};
const SITE_KEYS = [
  'source',
  'defaultEnv',
  'environments',
  'startPath',
  'webFiles',
  'inline',
  'markup',
  'scope',
  'routes',
  'mirage',
];
// Every catalogue mirage key is a row of mirage/lib/config-keys.mjs (the one registration point).
const MIRAGE_KEYS = catalogueKeys();

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be a mapping`);
}

function keys(value, allowed, name) {
  object(value, name);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown setting ${name}.${key}`);
}

function string(value, name) {
  // eslint-disable-next-line no-control-regex -- Control-character matching is deliberate validation or redaction at this boundary.
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f]/.test(value))
    throw new Error(`${name} must be a non-empty string without control characters`);
}

function boolean(value, name) {
  if (typeof value !== 'boolean') throw new Error(`${name} must be true or false`);
}

export function identifier(value, name) {
  if (
    typeof value !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value) ||
    /^(?:constructor|prototype|__proto__)$/i.test(value)
  ) {
    throw new Error(
      `${name} must contain only letters, numbers, underscores or hyphens, starting with a letter or number`,
    );
  }
}

const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;

export function browserProfile(value, name = 'browser.profile') {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value) || WINDOWS_DEVICE.test(value)) {
    throw new Error(
      `${name} must contain 1 to 64 letters, numbers, underscores or hyphens and cannot be a Windows device name`,
    );
  }
}

export function browserProfileDirectory(value, name = 'browser.profileDirectory') {
  string(value, name);
  if (
    value.length > 255 ||
    /[\\/<>:"|?*]/.test(value) ||
    /[. ]$/.test(value) ||
    value === '.' ||
    value === '..' ||
    WINDOWS_DEVICE.test(value)
  ) {
    throw new Error(
      `${name} must be one safe directory name, such as Default or Profile 1, without paths or Windows device names`,
    );
  }
}

export function browserUserDataDir(value, name = 'browser.userDataDir') {
  string(value, name);
}

export function httpUrl(value, name, protocols = ['http:', 'https:']) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a URL`);
  }
  if (!protocols.includes(url.protocol) || !url.hostname || url.username || url.password || /[\s\\]/.test(value)) {
    throw new Error(`${name} must be an ${protocols.join('/')} URL without credentials or whitespace`);
  }
  return url;
}

export function startPath(value, name = 'startPath') {
  string(value, name);
  if (!value.startsWith('/') || value.startsWith('//') || /[\\\r\n]/.test(value))
    throw new Error(`${name} must be a same-origin path starting with a single /`);
}

export function debugPort(value) {
  if (value === null || value === 0) return null;
  if (!Number.isInteger(value) || value < 1 || value > 65535)
    throw new Error('browser.debugPort must be an integer from 0 to 65535 (0 or null = off)');
  return value;
}

function array(value, name, allowed) {
  if (!Array.isArray(value) || value.some((x) => typeof x !== 'string' || (allowed && !allowed.includes(x)))) {
    throw new Error(`${name} must be an array of ${allowed ? allowed.join(', ') : 'strings'}`);
  }
}

/**
 * Local Mirage runtime settings of a site (or of `defaults`). Paths stay strings here; config.mjs
 * resolves `project` and `dataPacks` modules from the catalogue folder and `solutionRoots` from the
 * portal checkout root. `null` clears an inherited project, port or preset in a personal override.
 * Each key is validated by its row in mirage/lib/config-keys.mjs; observed values are validated in full
 * by the Mirage's observedConfig (mirage/lib/project-config.mjs).
 */
export function mirageSettings(value, name) {
  keys(value, MIRAGE_KEYS, name);
  for (const key of MIRAGE_KEYS)
    if (value[key] !== undefined) parseSetting(key, value[key], { label: `${name}.${key}` });
}

function siteSettings(site, name) {
  if (site.startPath !== undefined) startPath(site.startPath, `${name}.startPath`);
  if (site.mirage != null) mirageSettings(site.mirage, `${name}.mirage`);
  if (site.scope !== undefined && !['all', 'changed'].includes(site.scope))
    throw new Error(`${name}.scope must be 'all' or 'changed'`);
  for (const field of ['webFiles', 'inline', 'markup']) {
    if (site[field] === undefined) continue;
    const allowed = chooseLazily(
      () => field === 'webFiles',
      () => ['enabled', 'exclude'],
      () =>
        chooseLazily(
          () => field === 'inline',
          () => ['enabled', 'kinds', 'minSimilarity', 'injectMissingPageBlocks'],
          () => ['enabled', 'kinds', 'baseline'],
        ),
    );
    keys(site[field], allowed, `${name}.${field}`);
    if (site[field].enabled !== undefined) boolean(site[field].enabled, `${name}.${field}.enabled`);
  }
  validateSiteOptions(site, name);
  if (site.routes !== undefined) validateRoutes(site, name);
}

function validateSiteOptions(site, name) {
  if (site.webFiles?.exclude !== undefined) array(site.webFiles.exclude, `${name}.webFiles.exclude`);
  if (site.inline?.kinds !== undefined) array(site.inline.kinds, `${name}.inline.kinds`, BLOCK_KINDS);
  if (site.markup?.kinds !== undefined) array(site.markup.kinds, `${name}.markup.kinds`, MARKUP_KINDS);
  if (
    site.inline?.minSimilarity !== undefined &&
    (typeof site.inline.minSimilarity !== 'number' ||
      !Number.isFinite(site.inline.minSimilarity) ||
      site.inline.minSimilarity < 0 ||
      site.inline.minSimilarity > 1)
  )
    throw new Error(`${name}.inline.minSimilarity must be between 0 and 1`);
  if (site.inline?.injectMissingPageBlocks !== undefined)
    boolean(site.inline.injectMissingPageBlocks, `${name}.inline.injectMissingPageBlocks`);
  if (site.markup?.baseline !== undefined) string(site.markup.baseline, `${name}.markup.baseline`);
}

function validateRoutes(site, name) {
  if (!Array.isArray(site.routes)) throw new Error(`${name}.routes must be an array`);
  for (const [i, rule] of site.routes.entries()) validateRoute(rule, `${name}.routes[${i}]`);
}

function validateRoute(rule, at) {
  keys(rule, ['url', 'file', 'dir', 'passthrough'], at);
  string(rule.url, `${at}.url`);
  if (!rule.url.startsWith('/') || rule.url.startsWith('//') || rule.url.includes('\\'))
    throw new Error(`${at}.url must be a URL path starting with a single /`);
  if (rule.passthrough !== undefined) boolean(rule.passthrough, `${at}.passthrough`);
  if (Number(rule.file !== undefined) + Number(rule.dir !== undefined) + Number(rule.passthrough === true) !== 1)
    throw new Error(`${at} must select exactly one of file, dir or passthrough: true`);
  for (const field of ['file', 'dir']) if (rule[field] !== undefined) string(rule[field], `${at}.${field}`);
}

function validateBrowser(browser) {
  keys(
    browser,
    [
      'channel',
      'headless',
      'profileDir',
      'profile',
      'userDataDir',
      'profileDirectory',
      'cdpUrl',
      'debugPort',
      'bypassCSP',
    ],
    'browser',
  );
  string(browser.channel, 'browser.channel');
  boolean(browser.headless, 'browser.headless');
  boolean(browser.bypassCSP, 'browser.bypassCSP');
  string(browser.profileDir, 'browser.profileDir');
  if (browser.profile !== null) browserProfile(browser.profile);
  if (browser.userDataDir !== null) browserUserDataDir(browser.userDataDir);
  if (browser.profileDirectory !== null) browserProfileDirectory(browser.profileDirectory);
  debugPort(browser.debugPort);
  if (browser.cdpUrl !== null) httpUrl(browser.cdpUrl, 'browser.cdpUrl', ['http:', 'https:', 'ws:', 'wss:']);
}

function validateSites(sites) {
  object(sites ?? {}, 'sites');
  for (const [name, site] of Object.entries(sites ?? {})) {
    identifier(name, 'site name');
    keys(site, SITE_KEYS, `sites.${name}`);
    siteSettings(site, `sites.${name}`);
    if (site.source !== undefined) string(site.source, `sites.${name}.source`);
    if (site.defaultEnv !== undefined) identifier(site.defaultEnv, `sites.${name}.defaultEnv`);
    object(site.environments ?? {}, `sites.${name}.environments`);
    for (const [envName, env] of Object.entries(site.environments ?? {})) {
      identifier(envName, 'environment name');
      const at = `sites.${name}.environments.${envName}`;
      keys(env, ['url', 'baseline', 'scope', 'startPath', 'caution'], at);
      httpUrl(env.url, `${at}.url`);
      if (env.caution !== undefined) boolean(env.caution, `${at}.caution`);
      if (env.baseline !== undefined) string(env.baseline, `${at}.baseline`);
      siteSettings({ scope: env.scope, startPath: env.startPath }, at);
    }
  }
}

export function validateCatalogue(root) {
  keys(
    root,
    [
      'defaultSite',
      'sourceRoot',
      'portals',
      'includeCaution',
      'sites',
      'defaults',
      'browser',
      'agent',
      'liveReload',
      'panel',
      'editor',
      'sourceMaps',
    ],
    'config',
  );
  if (root.includeCaution !== undefined) boolean(root.includeCaution, 'includeCaution');
  if (!['selected', 'all'].includes(root.portals)) throw new Error("portals must be 'selected' or 'all'");
  if (root.sourceRoot !== undefined) string(root.sourceRoot, 'sourceRoot');
  keys(root.agent, ['enabled'], 'agent');
  boolean(root.agent.enabled, 'agent.enabled');
  if (root.defaultSite !== undefined) identifier(root.defaultSite, 'defaultSite');
  for (const field of ['liveReload', 'panel', 'sourceMaps']) boolean(root[field], field);
  string(root.editor, 'editor');
  validateBrowser(root.browser);
  if (root.defaults !== undefined) {
    keys(
      root.defaults,
      SITE_KEYS.filter((x) => !['source', 'defaultEnv', 'environments'].includes(x)),
      'defaults',
    );
    siteSettings(root.defaults, 'defaults');
  }
  validateSites(root.sites);
}

// Normalize shorthand before merging, so a personal baseline override retains the shared URL.
export function normalizeCatalogue(value, name) {
  object(value, name);
  const out = structuredClone(value);
  if (out.sites && typeof out.sites === 'object') {
    for (const site of Object.values(out.sites)) {
      if (!site?.environments || typeof site.environments !== 'object') continue;
      for (const [env, settings] of Object.entries(site.environments)) {
        if (typeof settings === 'string') site.environments[env] = { url: settings };
      }
    }
  }
  return out;
}
