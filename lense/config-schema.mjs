// Validate configuration before it can become a browser URL, path, or routing rule.
const BLOCK_KINDS = ['page-js', 'page-css', 'basic-form-js', 'advanced-form-step-js', 'list-js'];
const MARKUP_KINDS = ['web-template', 'content-snippet', 'page-copy', 'page-summary', 'metadata-markup'];
const SITE_KEYS = ['source', 'defaultEnv', 'environments', 'startPath', 'webFiles', 'inline', 'markup', 'scope', 'routes', 'mirage'];
const MIRAGE_KEYS = ['project', 'solutionRoots', 'solutionOrder', 'dataPacks', 'port', 'preset', 'observed', 'dataModel'];
const PACK_ID = /^[a-z0-9][a-z0-9._-]*$/;
const PRESET_ID = /^[\w.-]+$/;

export function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be a mapping`);
}

function keys(value, allowed, name) {
  object(value, name);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown setting ${name}.${key}`);
}

function string(value, name) {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${name} must be a non-empty string without control characters`);
}

function boolean(value, name) {
  if (typeof value !== 'boolean') throw new Error(`${name} must be true or false`);
}

export function identifier(value, name) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value) || /^(?:constructor|prototype|__proto__)$/i.test(value)) {
    throw new Error(`${name} must contain only letters, numbers, underscores or hyphens, starting with a letter or number`);
  }
}

const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;

export function browserProfile(value, name = 'browser.profile') {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value) || WINDOWS_DEVICE.test(value)) {
    throw new Error(`${name} must contain 1 to 64 letters, numbers, underscores or hyphens and cannot be a Windows device name`);
  }
}

export function browserProfileDirectory(value, name = 'browser.profileDirectory') {
  string(value, name);
  if (value.length > 255 || /[\\/<>:"|?*]/.test(value) || /[. ]$/.test(value) || value === '.' || value === '..' || WINDOWS_DEVICE.test(value)) {
    throw new Error(`${name} must be one safe directory name, such as Default or Profile 1, without paths or Windows device names`);
  }
}

export function browserUserDataDir(value, name = 'browser.userDataDir') {
  string(value, name);
}

export function httpUrl(value, name, protocols = ['http:', 'https:']) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} is not a URL`); }
  if (!protocols.includes(url.protocol) || !url.hostname || url.username || url.password || /[\s\\]/.test(value)) {
    throw new Error(`${name} must be an ${protocols.join('/')} URL without credentials or whitespace`);
  }
  return url;
}

export function startPath(value, name = 'startPath') {
  string(value, name);
  if (!value.startsWith('/') || value.startsWith('//') || /[\\\r\n]/.test(value)) throw new Error(`${name} must be a same-origin path starting with a single /`);
}

export function debugPort(value) {
  if (value === null || value === 0) return null;
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('browser.debugPort must be an integer from 0 to 65535 (0 or null = off)');
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
 */
export function mirageSettings(value, name) {
  keys(value, MIRAGE_KEYS, name);
  if (value.project != null) string(value.project, `${name}.project`);
  if (value.solutionRoots !== undefined) {
    if (!Array.isArray(value.solutionRoots)) throw new Error(`${name}.solutionRoots must be an array of folders`);
    value.solutionRoots.forEach((root, index) => string(root, `${name}.solutionRoots[${index}]`));
  }
  if (value.dataPacks !== undefined) {
    if (!Array.isArray(value.dataPacks)) throw new Error(`${name}.dataPacks must be an array of module paths or {id, module} objects`);
    value.dataPacks.forEach((entry, index) => {
      const at = `${name}.dataPacks[${index}]`;
      if (typeof entry === 'string') return string(entry, at);
      keys(entry, ['id', 'module'], at);
      string(entry.module, `${at}.module`);
      if (entry.id !== undefined && (typeof entry.id !== 'string' || !PACK_ID.test(entry.id))) throw new Error(`${at}.id must match ${PACK_ID}`);
    });
  }
  // Observed platform behaviour of this portal's environment, with its evidence; the keys and
  // values are validated by the Mirage's observedConfig (mirage/lib/project-config.mjs).
  if (value.observed != null && (typeof value.observed !== 'object' || Array.isArray(value.observed))) throw new Error(`${name}.observed must be an object such as { loginPath: /SignIn, evidence: <where it was observed> }`);
  if (value.solutionOrder != null && !['derived', 'explicit'].includes(value.solutionOrder)) throw new Error(`${name}.solutionOrder must be derived (Solution dependency order, the default) or explicit (the listed solutionRoots order)`);
  if (value.port != null && (!Number.isInteger(value.port) || value.port < 0 || value.port > 65535)) throw new Error(`${name}.port must be an integer from 0 to 65535 (0 chooses a free port)`);
  if (value.preset != null && (typeof value.preset !== 'string' || !PRESET_ID.test(value.preset))) throw new Error(`${name}.preset must be a preset ID (letters, numbers, underscores, dots or hyphens)`);
  // The site's data model when the source does not record it (a .powerpages-site export defaults to enhanced).
  if (value.dataModel != null && !['standard', 'enhanced'].includes(value.dataModel)) throw new Error(`${name}.dataModel must be standard or enhanced`);
}

function siteSettings(site, name) {
  if (site.startPath !== undefined) startPath(site.startPath, `${name}.startPath`);
  if (site.mirage != null) mirageSettings(site.mirage, `${name}.mirage`);
  if (site.scope !== undefined && !['all', 'changed'].includes(site.scope)) throw new Error(`${name}.scope must be 'all' or 'changed'`);
  for (const field of ['webFiles', 'inline', 'markup']) {
    if (site[field] === undefined) continue;
    const allowed = field === 'webFiles' ? ['enabled', 'exclude'] : field === 'inline' ? ['enabled', 'kinds', 'minSimilarity', 'injectMissingPageBlocks'] : ['enabled', 'kinds', 'baseline'];
    keys(site[field], allowed, `${name}.${field}`);
    if (site[field].enabled !== undefined) boolean(site[field].enabled, `${name}.${field}.enabled`);
  }
  if (site.webFiles?.exclude !== undefined) array(site.webFiles.exclude, `${name}.webFiles.exclude`);
  if (site.inline?.kinds !== undefined) array(site.inline.kinds, `${name}.inline.kinds`, BLOCK_KINDS);
  if (site.markup?.kinds !== undefined) array(site.markup.kinds, `${name}.markup.kinds`, MARKUP_KINDS);
  if (site.inline?.minSimilarity !== undefined && (typeof site.inline.minSimilarity !== 'number' || !Number.isFinite(site.inline.minSimilarity) || site.inline.minSimilarity < 0 || site.inline.minSimilarity > 1)) throw new Error(`${name}.inline.minSimilarity must be between 0 and 1`);
  if (site.inline?.injectMissingPageBlocks !== undefined) boolean(site.inline.injectMissingPageBlocks, `${name}.inline.injectMissingPageBlocks`);
  if (site.markup?.baseline !== undefined) string(site.markup.baseline, `${name}.markup.baseline`);
  if (site.routes !== undefined) {
    if (!Array.isArray(site.routes)) throw new Error(`${name}.routes must be an array`);
    for (const [i, rule] of site.routes.entries()) {
      const at = `${name}.routes[${i}]`;
      keys(rule, ['url', 'file', 'dir', 'passthrough'], at);
      string(rule.url, `${at}.url`);
      if (!rule.url.startsWith('/') || rule.url.startsWith('//') || rule.url.includes('\\')) throw new Error(`${at}.url must be a URL path starting with a single /`);
      if (rule.passthrough !== undefined) boolean(rule.passthrough, `${at}.passthrough`);
      if (Number(rule.file !== undefined) + Number(rule.dir !== undefined) + Number(rule.passthrough === true) !== 1) throw new Error(`${at} must select exactly one of file, dir or passthrough: true`);
      for (const field of ['file', 'dir']) if (rule[field] !== undefined) string(rule[field], `${at}.${field}`);
    }
  }
}

export function validateCatalogue(root) {
  keys(root, ['defaultSite', 'sourceRoot', 'portals', 'sites', 'defaults', 'browser', 'agent', 'liveReload', 'panel', 'editor', 'sourceMaps'], 'config');
  if (!['selected', 'all'].includes(root.portals)) throw new Error("portals must be 'selected' or 'all'");
  if (root.sourceRoot !== undefined) string(root.sourceRoot, 'sourceRoot');
  keys(root.agent, ['enabled'], 'agent');
  boolean(root.agent.enabled, 'agent.enabled');
  if (root.defaultSite !== undefined) identifier(root.defaultSite, 'defaultSite');
  for (const field of ['liveReload', 'panel', 'sourceMaps']) boolean(root[field], field);
  string(root.editor, 'editor');
  keys(root.browser, ['channel', 'headless', 'profileDir', 'profile', 'userDataDir', 'profileDirectory', 'cdpUrl', 'debugPort', 'bypassCSP'], 'browser');
  string(root.browser.channel, 'browser.channel');
  boolean(root.browser.headless, 'browser.headless');
  boolean(root.browser.bypassCSP, 'browser.bypassCSP');
  string(root.browser.profileDir, 'browser.profileDir');
  if (root.browser.profile !== null) browserProfile(root.browser.profile);
  if (root.browser.userDataDir !== null) browserUserDataDir(root.browser.userDataDir);
  if (root.browser.profileDirectory !== null) browserProfileDirectory(root.browser.profileDirectory);
  debugPort(root.browser.debugPort);
  if (root.browser.cdpUrl !== null) httpUrl(root.browser.cdpUrl, 'browser.cdpUrl', ['http:', 'https:', 'ws:', 'wss:']);
  if (root.defaults !== undefined) {
    keys(root.defaults, SITE_KEYS.filter((x) => !['source', 'defaultEnv', 'environments'].includes(x)), 'defaults');
    siteSettings(root.defaults, 'defaults');
  }
  object(root.sites ?? {}, 'sites');
  for (const [name, site] of Object.entries(root.sites ?? {})) {
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
