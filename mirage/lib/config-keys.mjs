// One registration point for Mirage settings. Every key that a catalogue site
// (`sites.<id>.mirage` / `defaults.mirage`), a project file or a project portal entry accepts has one
// row here. `MIRAGE_KEYS` (lense/config-schema.mjs) and `KNOWN_KEYS` (project-config.mjs) derive from
// it, and every createSimulator option assembly resolves the rows through `runtimeOptions()`.
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runtimeSettings } from './runtime-config.mjs';
import { simulationSettings } from './simulation-settings.mjs';
import { dataverseSettings } from './dataverse-settings.mjs';
import { modelDrivenSettings } from './model-driven-settings.mjs';
import { platformConfig } from './platform-config.mjs';
import { renderSettings } from './render-settings.mjs';
import { traceSettings } from './trace-settings.mjs';
import { personaContextSettings } from './persona-context-settings.mjs';
import { identityProviderSettings } from './identity-provider-settings.mjs';
import { resolveDeploymentProfiles } from './deployment-profiles.mjs';
import { contentPolicyDefaults } from './content-policy-defaults.mjs';
import { validateLocalOverrides } from './local-overrides.mjs';

const PACK_ID = /^[a-z0-9][a-z0-9._-]*$/;
const PRESET_ID = /^[\w.-]+$/;
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function text(value, label) {
  // eslint-disable-next-line no-control-regex -- This parser intentionally recognizes control bytes in untrusted text.
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f]/.test(value))
    throw new Error(`${label} must be a non-empty string without control characters`);
}
function choice(choices, message) {
  return (value, label) => {
    if (value != null && !choices.includes(value)) throw new Error(`${label} ${message}`);
    return value;
  };
}
/** mirage.logs.retain when unset: the log lines the runtime keeps for GET /_sim/api/logs. */
export const LOG_RETAIN_DEFAULT = 2000;
const LOG_RETAIN_MAX = 50_000;
/** mirage.logs: { retain } (0..50000, default 2000; 0 keeps no history); unknown members are refused. */
export function logSettings(value, label = 'logs') {
  if (value == null) return { retain: LOG_RETAIN_DEFAULT };
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) if (key !== 'retain') throw new Error(`${label}.${key} is not a setting`);
  const retain = value.retain ?? LOG_RETAIN_DEFAULT;
  if (!Number.isInteger(retain) || retain < 0 || retain > LOG_RETAIN_MAX)
    throw new Error(`${label}.retain must be an integer from 0 to ${LOG_RETAIN_MAX}`);
  return { retain };
}
const policyKey = (key) => (value) => contentPolicyDefaults({ [key]: value })[key];
const overrideKey = (key) => (value) => validateLocalOverrides({ [key]: value })[key];

// Parsers that other modules register when they load (registerSettingParser). A key without one is
// accepted as a plain object (or an array for array-valued keys) and reported as CONFIG_KEY_PARSER_PENDING.
const parsers = new Map();

/** Called by the module that owns a setting's contract, e.g. `registerSettingParser('connections', connectionSettings)`. */
export function registerSettingParser(key, parse) {
  if (typeof key !== 'string' || !key) throw new TypeError('registerSettingParser needs a setting key');
  if (typeof parse !== 'function')
    throw new TypeError(`registerSettingParser('${key}') needs a parse(value, label, base) function`);
  parsers.set(key, parse);
}

/** Test seam: runs fn with `key`'s registered parser removed (the pending path), then restores it; fn may be async. */
export function withoutSettingParser(key, fn) {
  const parse = parsers.get(key);
  parsers.delete(key);
  const restore = () => {
    if (parse) parsers.set(key, parse);
    else parsers.delete(key);
  };
  let result;
  try {
    result = fn();
  } catch (error) {
    restore();
    throw error;
  }
  if (typeof result?.then === 'function') return result.finally(restore);
  restore();
  return result;
}

function pendingParse(key, module, shape, value, label, diagnostics) {
  if (value == null) return value;
  if (shape === 'array' ? !Array.isArray(value) : !isPlainObject(value))
    throw new Error(`${label} must be ${shape === 'array' ? 'an array' : 'an object'}`);
  diagnostics?.push({
    code: 'CONFIG_KEY_PARSER_PENDING',
    severity: 'warning',
    key,
    module,
    message: `${label} is accepted as ${shape === 'array' ? 'an array' : 'an object'} without its contract validation: ${module} has not registered a parser.`,
  });
  return structuredClone(value);
}

function lazy(key, module, shape = 'object') {
  return (value, label, base, diagnostics) => {
    const parse = parsers.get(key);
    return parse ? parse(value, label, base) : pendingParse(key, module, shape, value, label, diagnostics);
  };
}

// `providers` combines the storage router and the messaging/outbox contracts.
function providersParse(value, label, base, diagnostics) {
  if (value == null) return value;
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  for (const member of Object.keys(value))
    if (!['storage', 'routes', 'messaging', 'outbox'].includes(member))
      throw new Error(`Unknown ${label} key '${member}'; expected storage, routes, messaging or outbox`);
  const { storage, routes, messaging, outbox } = value;
  const stored =
    storage === undefined && routes === undefined
      ? {}
      : lazy('providers.storage', 'storage-provider.mjs')(
          { ...(storage !== undefined ? { storage } : {}), ...(routes !== undefined ? { routes } : {}) },
          label,
          base,
          diagnostics,
        );
  return {
    ...(stored.storage !== undefined ? { storage: stored.storage } : {}),
    ...(stored.routes !== undefined ? { routes: stored.routes } : {}),
    ...(messaging !== undefined
      ? {
          messaging: lazy('providers.messaging', 'message-bus.mjs')(messaging, `${label}.messaging`, base, diagnostics),
        }
      : {}),
    ...(outbox !== undefined
      ? { outbox: lazy('providers.outbox', 'outbox.mjs')(outbox, `${label}.outbox`, base, diagnostics) }
      : {}),
  };
}

/**
 * One row per setting.
 * - scopes: where it may appear: catalogue (site mirage mapping), project (top level), portal (project portal entry).
 * - parse(value, label, base?): the validator (throws; returns the normalised value).
 * - option: the createSimulator option it feeds (dotted for a member of an object option), or null.
 * - from: the precedence runtimeOptions applies (default portal > project > catalogue).
 * - resolve(value, where): catalogue resolution (paths, defaults) when it differs from parse; fallback when absent.
 * - identity: decides whether a running runtime can be reused; redact: hashed in runtimeIdentity().
 * - doc: one line of purpose; contract: the document of a contract-level key.
 */
export const MIRAGE_SETTINGS = Object.freeze({
  project: {
    scopes: ['catalogue'],
    option: null,
    doc: 'Project file of this site, relative to the catalogue folder.',
    parse: (value, label) => {
      if (value != null) text(value, label);
      return value;
    },
    resolve: (value, { configDir }) => (value ? path.resolve(configDir, value) : null),
    fallback: null,
  },
  solutionRoots: {
    scopes: ['catalogue'],
    option: null,
    doc: 'Solution folders, relative to the portal checkout root.',
    parse: (value, label) => {
      if (!Array.isArray(value)) throw new Error(`${label} must be an array of folders`);
      value.forEach((root, index) => text(root, `${label}[${index}]`));
      return value;
    },
    resolve: (value, { sourceRoot }) => value.map((root) => path.resolve(sourceRoot, root)),
    fallback: [],
  },
  solutionOrder: {
    scopes: ['catalogue', 'project'],
    option: 'solutionOrder',
    doc: 'derived (Solution dependency order, default) or explicit (listed order).',
    parse: choice(
      ['derived', 'explicit'],
      'must be derived (Solution dependency order, the default) or explicit (the listed solutionRoots order)',
    ),
    resolve: (value) => (value === 'explicit' ? 'explicit' : 'derived'),
    fallback: 'derived',
  },
  dataPacks: {
    scopes: ['catalogue', 'project'],
    option: 'dataPacks',
    from: ['catalogue'],
    doc: 'Trusted pack modules ({ id, module } or a path). Project packs reach the runtime through the project summary.',
    parse: (value, label) => {
      if (!Array.isArray(value)) throw new Error(`${label} must be an array of module paths or {id, module} objects`);
      value.forEach((entry, index) => {
        const at = `${label}[${index}]`;
        if (typeof entry === 'string') return text(entry, at);
        if (!isPlainObject(entry)) throw new Error(`${at} must be a mapping`);
        for (const key of Object.keys(entry))
          if (!['id', 'module'].includes(key)) throw new Error(`Unknown setting ${at}.${key}`);
        text(entry.module, `${at}.module`);
        if (entry.id !== undefined && (typeof entry.id !== 'string' || !PACK_ID.test(entry.id)))
          throw new Error(`${at}.id must match ${PACK_ID}`);
      });
      return value;
    },
    resolve: (value, { configDir }) =>
      value.map((entry) =>
        typeof entry === 'string'
          ? { id: null, module: path.resolve(configDir, entry) }
          : { id: entry.id ?? null, module: path.resolve(configDir, entry.module) },
      ),
    fallback: [],
  },
  // Trusted project code, as dataPacks are: a custom connector's C# script runs only when this list names its connector
  // and the SHA-256 of its script.csx text (custom-connector-script.mjs scriptHash); any other script is refused.
  connectorScripts: {
    scopes: ['catalogue', 'project'],
    option: 'connectorScripts',
    identity: true,
    doc: 'Trusted custom connector C# scripts ({ connector, sha256 }); any other script.csx is refused.',
    parse: (value, label) => {
      if (value == null) return [];
      if (!Array.isArray(value)) throw new Error(`${label} must be an array of { connector, sha256 } entries`);
      return value.map((entry, index) => {
        const at = `${label}[${index}]`;
        if (!isPlainObject(entry)) throw new Error(`${at} must be a mapping`);
        for (const key of Object.keys(entry))
          if (!['connector', 'sha256'].includes(key)) throw new Error(`Unknown setting ${at}.${key}`);
        text(entry.connector, `${at}.connector`);
        if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(entry.sha256))
          throw new Error(`${at}.sha256 must be the 64 hex digit SHA-256 of the script.csx text`);
        return { connector: entry.connector, sha256: entry.sha256.toLowerCase() };
      });
    },
  },
  port: {
    scopes: ['catalogue'],
    option: null,
    doc: 'Local port (0 chooses a free port).',
    parse: (value, label) => {
      if (value != null && (!Number.isInteger(value) || value < 0 || value > 65535))
        throw new Error(`${label} must be an integer from 0 to 65535 (0 chooses a free port)`);
      return value;
    },
    resolve: (value) => (Number.isInteger(value) ? value : null),
    fallback: null,
  },
  preset: {
    scopes: ['catalogue'],
    option: null,
    doc: 'Startup data preset ID.',
    parse: (value, label) => {
      if (value != null && (typeof value !== 'string' || !PRESET_ID.test(value)))
        throw new Error(`${label} must be a preset ID (letters, numbers, underscores, dots or hyphens)`);
      return value;
    },
    resolve: (value) => value ?? null,
    fallback: null,
  },
  presetMode: {
    scopes: ['catalogue'],
    option: null,
    doc: 'bootstrap or always.',
    parse: choice(['bootstrap', 'always'], 'must be bootstrap or always'),
    resolve: (value) => value || undefined,
  },
  presetConfiguration: {
    scopes: ['catalogue'],
    option: null,
    doc: 'data-only or apply.',
    parse: choice(['data-only', 'apply'], 'must be data-only or apply'),
    resolve: (value) => value || undefined,
  },
  confinePortalPages: {
    scopes: ['catalogue', 'project', 'portal'],
    option: 'contentPolicyDefaults.confinePortalPages',
    from: ['catalogue', 'portal', 'project'],
    doc: 'Confine portal pages with a content security policy.',
    parse: policyKey('confinePortalPages'),
  },
  externalAssets: {
    scopes: ['catalogue', 'project', 'portal'],
    option: 'contentPolicyDefaults.externalAssets',
    from: ['catalogue', 'portal', 'project'],
    doc: 'Allow external assets in confined pages.',
    parse: policyKey('externalAssets'),
  },
  externalFrameOrigins: {
    scopes: ['catalogue', 'project', 'portal'],
    option: 'contentPolicyDefaults.externalFrameOrigins',
    from: ['catalogue', 'portal', 'project'],
    doc: 'Origins confined pages may frame.',
    parse: policyKey('externalFrameOrigins'),
  },
  observed: {
    scopes: ['catalogue', 'portal'],
    option: 'observed',
    doc: 'Observed platform behaviour with its evidence (validated by observedConfig).',
    parse: (value, label) => {
      if (value != null && !isPlainObject(value))
        throw new Error(`${label} must be an object such as { loginPath: /SignIn, evidence: <where it was observed> }`);
      return value;
    },
    resolve: (value, { sourceRoot }) =>
      isPlainObject(value)
        ? {
            ...structuredClone(value),
            ...(isPlainObject(value.pluginSources)
              ? {
                  pluginSources: Object.fromEntries(
                    Object.entries(value.pluginSources).map(([name, source]) => [
                      name,
                      isPlainObject(source) ? { ...structuredClone(source), root: source.root ?? sourceRoot } : source,
                    ]),
                  ),
                }
              : {}),
          }
        : null,
    fallback: null,
  },
  dataModel: {
    scopes: ['catalogue', 'portal'],
    option: 'dataModel',
    doc: 'The Power Pages data model of the website export (standard or enhanced), only when the export does not record it. Unrelated to deployment profiles that share these names.',
    parse: choice(['standard', 'enhanced'], 'must be standard or enhanced'),
    resolve: (value) => value || undefined,
  },
  compat: {
    scopes: ['catalogue'],
    option: 'localOverrides',
    resolved: 'localOverrides',
    doc: 'Local compatibility adapters.',
    parse: overrideKey('compat'),
    resolve: null,
  },
  head: {
    scopes: ['catalogue'],
    option: 'localOverrides',
    resolved: 'localOverrides',
    doc: 'Local head stylesheets and scripts.',
    parse: overrideKey('head'),
    resolve: null,
  },
  render: {
    scopes: ['catalogue'],
    option: 'render',
    identity: true,
    doc: 'Liquid render limits.',
    parse: (value) => renderSettings(value),
  },
  // No identity: the level and caps change at run time (`_sim` trace settings), so a running runtime is reused.
  trace: {
    scopes: ['catalogue', 'project'],
    option: 'trace',
    doc: 'Local request tracing: level (off, summary or full), retained traces, spans per trace, payload bytes, persist.',
    parse: (value, label) => traceSettings(value, label),
  },
  // No identity: the history size never changes what a runtime serves.
  logs: {
    scopes: ['catalogue', 'project'],
    option: 'logs',
    doc: 'Runtime log stream history: retain (log lines kept for the _sim Activity log stream and GET /_sim/api/logs, default 2000; 0 keeps none).',
    parse: (value, label) => logSettings(value, label),
  },
  sourceMaps: {
    scopes: ['catalogue', 'project', 'portal'],
    option: 'sourceMaps',
    identity: true,
    doc: 'Append local file-backed debugger metadata to scripts and stylesheets (default true). Set false for original asset bytes.',
    parse: (value, label) => {
      if (value != null && typeof value !== 'boolean') throw new Error(`${label} must be true or false`);
      return value;
    },
  },
  personaContexts: {
    scopes: ['catalogue'],
    option: 'personaContexts',
    doc: 'Persona context runtimes.',
    parse: (value) => personaContextSettings(value),
  },
  identityProvider: {
    scopes: ['catalogue'],
    option: 'identityProvider',
    doc: 'Local external identity provider.',
    parse: (value) => identityProviderSettings(value),
  },
  deploymentProfiles: {
    scopes: ['catalogue', 'project', 'portal'],
    option: 'deploymentProfiles',
    from: ['catalogue', 'portal', 'project'],
    identity: true,
    doc: 'Deployment profile files.',
    parse: (value, label, base) => resolveDeploymentProfiles(value, base),
    resolve: (value, { configDir, sourceRoot, sourceDir }) =>
      resolveDeploymentProfiles(value, configDir, { sourceRoot, sourceDir }),
  },
  platform: {
    scopes: ['catalogue', 'project', 'portal'],
    option: 'platform',
    from: ['catalogue', 'portal', 'project'],
    identity: true,
    doc: 'Platform settings with their evidence.',
    parse: (value, label) => platformConfig(value, label),
  },
  dataverse: {
    scopes: ['catalogue', 'project'],
    option: 'dataverse',
    identity: true,
    doc: 'Simulated Dataverse API.',
    parse: (value, label) => dataverseSettings(value, label),
  },
  runtime: {
    scopes: ['catalogue', 'project'],
    option: 'runtime',
    identity: true,
    doc: 'power-pages, model-driven or dataverse-api.',
    parse: (value, label) => runtimeSettings(value, label),
  },
  simulation: {
    scopes: ['catalogue', 'project'],
    option: 'simulation',
    identity: true,
    doc: 'dry-run, simulation or deep.',
    parse: (value, label) => simulationSettings(value, label),
  },
  modelDriven: {
    scopes: ['catalogue', 'project'],
    option: 'modelDriven',
    identity: true,
    doc: 'Model-driven host settings.',
    parse: (value, label, base) => modelDrivenSettings(value, label, base),
  },
  environmentVariables: {
    scopes: ['project'],
    option: 'environmentVariables',
    doc: 'Local environment-variable values by schema name.',
    parse: (value) => value,
  },
  // Contract keys whose validators live in their owning modules (registered when those modules load).
  connections: {
    scopes: ['catalogue', 'project'],
    option: 'connections',
    identity: true,
    pending: 'connector-runtime.mjs',
    contract: 'mirage/docs/operations.md',
    doc: 'Local connections by connection id.',
    parse: lazy('connections', 'connector-runtime.mjs'),
  },
  secrets: {
    scopes: ['catalogue', 'project'],
    option: 'secrets',
    identity: true,
    redact: true,
    pending: 'secret-resolver.mjs',
    doc: 'Secrets by <vault>/<secret>: an environment variable or a DPAPI-protected value, never a literal.',
    parse: lazy('secrets', 'secret-resolver.mjs'),
  },
  localServices: {
    scopes: ['catalogue', 'project'],
    option: 'localServices',
    identity: true,
    pending: 'local-services.mjs',
    doc: 'Declared local services that are probed, never started.',
    parse: lazy('localServices', 'local-services.mjs'),
  },
  providers: {
    scopes: ['catalogue', 'project'],
    option: 'providers',
    identity: true,
    pending: 'storage-provider.mjs, message-bus.mjs, outbox.mjs',
    contract: 'mirage/docs/storage-providers.md, mirage/docs/messaging-and-outbox.md',
    doc: 'Storage routes, messaging providers and the outbox.',
    parse: providersParse,
  },
  canvas: {
    scopes: ['catalogue', 'project'],
    option: 'canvas',
    identity: true,
    pending: 'canvas-source.mjs',
    contract: 'mirage/docs/canvas-apps.md',
    doc: 'Canvas surface switch (enabled) and project canvas app sources (sources).',
    parse: lazy('canvas', 'canvas-source.mjs'),
  },
  codeApps: {
    scopes: ['project'],
    option: 'codeApps',
    identity: true,
    pending: 'code-apps-config.mjs',
    contract: 'mirage/docs/code-apps.md',
    doc: 'Code apps served under /_apps/code/.',
    parse: lazy('codeApps', 'code-apps-config.mjs', 'array'),
  },
});
for (const row of Object.values(MIRAGE_SETTINGS)) Object.freeze(row.scopes) && Object.freeze(row);

const inScope = (scope) => Object.keys(MIRAGE_SETTINGS).filter((key) => MIRAGE_SETTINGS[key].scopes.includes(scope));
/** Keys a catalogue site's `mirage` mapping (and `defaults.mirage`) accepts. */
export const catalogueKeys = () => inScope('catalogue');
/** Top-level project keys that are settings (structural project keys stay in project-config.mjs). */
export const projectKeys = () => inScope('project');
/** Keys a project portal entry may set. */
export const portalKeys = () => inScope('portal');
/** Contract keys whose owning module has not registered its parser yet. */
export const pendingSettingParsers = () =>
  Object.keys(MIRAGE_SETTINGS).filter(
    (key) =>
      MIRAGE_SETTINGS[key].pending &&
      !(key === 'providers'
        ? ['providers.storage', 'providers.messaging', 'providers.outbox'].every((part) => parsers.has(part))
        : parsers.has(key)),
  );

/** Validates one setting through its row; pending parsers append CONFIG_KEY_PARSER_PENDING to `diagnostics`. */
export function parseSetting(key, value, { label = key, base, diagnostics } = {}) {
  const row = MIRAGE_SETTINGS[key];
  if (!row) throw new Error(`Unknown Mirage setting ${label}`);
  return row.parse(value, label, base, diagnostics);
}

/**
 * Catalogue resolution of a site's mirage mapping: every row that is set resolves (paths against
 * the catalogue folder or the portal checkout), and rows with a fallback appear even when unset.
 * compat/head resolve together into localOverrides in lense/config.mjs.
 */
export function resolveCatalogueSettings(value, where) {
  const result = {};
  for (const [key, row] of Object.entries(MIRAGE_SETTINGS)) {
    if (!row.scopes.includes('catalogue') || row.resolve === null) continue;
    const resolved =
      value[key] === undefined || (row.resolve && value[key] === null)
        ? row.fallback
        : row.resolve
          ? row.resolve(value[key], where)
          : row.parse(value[key], `mirage.${key}`, where.configDir);
    if (resolved !== undefined) result[key] = resolved;
  }
  return result;
}

const lookup = (source, row, key) => source?.[row.resolved ?? key];
function assign(options, option, value) {
  const [name, member] = option.split('.');
  if (!member) options[name] = value;
  else options[name] = { ...options[name], [member]: value };
}

/**
 * createSimulator options of every registered key. Each argument is a resolved shape: `project` from
 * resolveProjectConfig, `portal` one of its `portals`, `catalogue` from resolveMirageConfig. The first
 * set value (not null/undefined) wins in the row's precedence, by default portal > project > catalogue.
 */
export function runtimeOptions({ project = null, portal = null, catalogue = null } = {}) {
  const options = {};
  const sources = { portal, project, catalogue };
  for (const [key, row] of Object.entries(MIRAGE_SETTINGS)) {
    if (!row.option) continue;
    const order = (row.from ?? ['portal', 'project', 'catalogue']).filter((scope) => row.scopes.includes(scope));
    for (const scope of order) {
      const value = lookup(sources[scope], row, key);
      if (value == null) continue;
      assign(options, row.option, value);
      break;
    }
  }
  return options;
}

/**
 * Names of the registered settings authored in the given resolved sources (same shapes as runtimeOptions), sorted; values
 * are only compared with the row's fallback and with an empty list or map, which resolution fills in for an unset key. compat and head resolve together
 * into localOverrides, so each is found by its own member there.
 */
export function configuredSettingKeys({ project = null, portal = null, catalogue = null } = {}) {
  const sources = { portal, project, catalogue };
  const member = {
    compat: (value) => Object.keys(value?.compat ?? {}).length > 0,
    head: (value) => (value?.assets?.length ?? 0) > 0,
  };
  const present = (source, row, key) =>
    member[key]
      ? member[key](source?.[row.resolved])
      : source?.[key] != null &&
        ![JSON.stringify(row.fallback ?? null), '{}', '[]'].includes(JSON.stringify(source[key]));
  return Object.keys(MIRAGE_SETTINGS)
    .filter((key) => MIRAGE_SETTINGS[key].scopes.some((scope) => present(sources[scope], MIRAGE_SETTINGS[key], key)))
    .sort();
}

/** The registered options found in an options object (for runtimes that forward their settings). */
export function settingOptions(options = {}, { exclude = [] } = {}) {
  const names = new Set(
    Object.values(MIRAGE_SETTINGS)
      .map((row) => row.option?.split('.')[0])
      .filter(Boolean),
  );
  return Object.fromEntries(
    Object.entries(options).filter(
      ([name, value]) => names.has(name) && !exclude.includes(name) && value !== undefined,
    ),
  );
}

const stable = (value) =>
  Array.isArray(value)
    ? value.map(stable)
    : isPlainObject(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, stable(value[key])]),
        )
      : value;

/** The options that decide whether a running runtime can be reused; secret-bearing ones are hashed. */
export function runtimeIdentity(options = {}) {
  const identity = {};
  for (const [key, row] of Object.entries(MIRAGE_SETTINGS)) {
    if (!row.identity || !row.option) continue;
    const value = stable(options[row.option] ?? null);
    identity[key] =
      row.redact && value !== null
        ? `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
        : value;
  }
  return identity;
}
