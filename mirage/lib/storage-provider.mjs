// Storage provider contract: errors, key validation, provider shape check, config validation and route selection.
// Implementations: storage-local-disk.mjs (default, behaviour) and storage-azurite.mjs (Blob REST with Shared Key:
// behaviour with a usable connection string, declared only (contract) without one).
// The shared contract suite is mirage/testing/storage-contract.mjs. See mirage/docs/storage-providers.md.
import path from 'node:path';
import { DataError } from './data-error.mjs';
import { registerSettingParser } from './config-keys.mjs';
import { packCheck, registerPackExport } from './pack-exports.mjs';

const STATUS = Object.freeze({
  NotFound: 404,
  PreconditionFailed: 412,
  Conflict: 409,
  TooLarge: 413,
  InvalidKey: 400,
  InvalidRange: 416,
  Unavailable: 503,
  Unauthorized: 401,
  Unsupported: 501,
});
export const STORAGE_OPERATIONS = Object.freeze(['put', 'commit', 'get', 'head', 'delete', 'list', 'sas']);
const STORAGE_ROUTES = Object.freeze([
  'dataverseFiles',
  'annotations',
  'portalWebFiles',
  'portalCloudAttachments',
  'sharepointDocuments',
]);
const DEFAULT_STORAGE_ROUTES = Object.freeze({
  dataverseFiles: 'local',
  annotations: 'local',
  portalWebFiles: 'export',
  sharepointDocuments: 'local',
});
const LEVELS = ['inventory', 'contract', 'behaviour', 'native-qualified'];

/** A storage failure. `code` is a recognized provider status name; `provider` names the provider id.
 * Messages never carry a URL query, SAS signature or connection string. `diagnostic` is an optional stable id. */
export class ProviderError extends DataError {
  constructor(code, message, { provider = null, diagnostic } = {}) {
    if (!Object.hasOwn(STATUS, code)) throw new TypeError(`Unknown provider error code '${code}'`);
    super(message, STATUS[code], code, diagnostic ? { innerCode: diagnostic } : undefined);
    this.name = 'ProviderError';
    this.provider = provider;
    if (diagnostic) this.diagnostic = diagnostic;
  }
}

const KEY = /^[a-z0-9][a-z0-9\-_./]{0,1023}$/;
/** Returns the lower-case key or throws ProviderError InvalidKey. The rejected key is never echoed. */
// A list prefix may end with the separator ({ prefix: true }); every other empty or . segment would alias a key after URL normalisation.
export function validateKey(key, provider = null, { prefix = false } = {}) {
  const invalid = (reason) => new ProviderError('InvalidKey', `Storage key is invalid: ${reason}.`, { provider });
  if (typeof key !== 'string') throw invalid('it must be a string');
  if (key.includes('\0')) throw invalid('it contains NUL');
  if (key.includes('\\')) throw invalid('it contains a backslash');
  if (key.startsWith('/')) throw invalid('it starts with /');
  const normal = key.toLowerCase();
  if (!KEY.test(normal)) throw invalid('it must match [a-z0-9][a-z0-9-_./]{0,1023}');
  const segments = (prefix && normal.endsWith('/') ? normal.slice(0, -1) : normal).split('/');
  if (segments.includes('..')) throw invalid('it contains a .. segment');
  if (segments.some((segment) => segment === '' || segment === '.')) throw invalid('it contains an empty or . segment');
  return normal;
}

/** Shape check: a descriptor plus a function for every operation it declares. Returns the provider. */
export function assertProvider(provider) {
  const d = provider?.descriptor;
  const fail = (reason) => {
    throw new TypeError(`Storage provider ${d?.id ? `'${d.id}' ` : ''}is invalid: ${reason}`);
  };
  if (!d || typeof d !== 'object') fail('descriptor is missing');
  for (const field of ['id', 'kind'])
    if (typeof d[field] !== 'string' || !d[field]) fail(`descriptor.${field} must be a non-empty string`);
  if (!LEVELS.includes(d.level)) fail(`descriptor.level must be ${LEVELS.join(', ')}`);
  if (!Array.isArray(d.operations)) fail('descriptor.operations must be an array');
  if (!Array.isArray(d.requires ?? [])) fail('descriptor.requires must be an array');
  for (const operation of d.operations) {
    if (!STORAGE_OPERATIONS.includes(operation)) fail(`unknown operation '${operation}'`);
    if (typeof provider[operation] !== 'function') fail(`declared operation '${operation}' is not a function`);
  }
  if (d.operations.includes('sas') && typeof provider.verifySas !== 'function')
    fail("operation 'sas' needs verifySas(url)");
  if (provider.preflight !== undefined && typeof provider.preflight !== 'function')
    fail('preflight must be a function when present');
  return provider;
}

/**
 * Readiness of an instantiated storage provider or message bus through its optional preflight() → { ready, reason? }, bounded
 * by timeoutMs (2 s, as local-service probes). null when the instance has no preflight(): it is declared, never probed.
 */
export async function preflightProvider(instance, { timeoutMs = 2000 } = {}) {
  if (typeof instance?.preflight !== 'function') return null;
  let timer;
  // A CLI may have no other active handles while awaiting a provider. Keep its
  // deadline alive until an answer is delivered, then release it in finally.
  const timeout = new Promise((resolve) => {
    timer = setTimeout(
      () => resolve({ ready: false, reason: `No preflight answer within ${timeoutMs} ms.` }),
      timeoutMs,
    );
  });
  try {
    const result = await Promise.race([Promise.resolve().then(() => instance.preflight()), timeout]);
    return result?.ready === true
      ? { ready: true, reason: null }
      : { ready: false, reason: String(result?.reason ?? 'The provider reported it is not ready.') };
  } catch (error) {
    return { ready: false, reason: error?.message ?? String(error) };
  } finally {
    clearTimeout(timer);
  }
}

const UNAVAILABLE = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);
function mapError(error, id) {
  if (error instanceof ProviderError) {
    error.provider ??= id;
    return error;
  }
  const code = error?.code ?? error?.cause?.code;
  if (UNAVAILABLE.has(code) || error?.name === 'TimeoutError')
    return Object.assign(
      new ProviderError('Unavailable', `Storage provider '${id}' is unavailable (${code ?? error.name}).`, {
        provider: id,
      }),
      { cause: error },
    );
  return error;
}

/** Wraps a provider so keys are validated before the implementation sees them, undeclared operations answer
 * Unsupported, and connection failures map to Unavailable. The router and the contract suite use it. */
export function guardProvider(provider, { counters = () => null } = {}) {
  assertProvider(provider);
  const { id, operations } = provider.descriptor;
  const call = async (operation, args) => {
    if (!operations.includes(operation))
      throw new ProviderError('Unsupported', `Storage provider '${id}' does not support ${operation}.`, {
        provider: id,
      });
    try {
      return await provider[operation](...args);
    } catch (error) {
      throw mapError(error, id);
    }
  };
  const keyed =
    (operation) =>
    async (key, ...rest) =>
      call(operation, [validateKey(key, id), ...rest]);
  const guarded = { descriptor: provider.descriptor };
  for (const operation of ['put', 'commit', 'get', 'head', 'delete', 'sas']) guarded[operation] = keyed(operation);
  // Dashboard counters (runtime-counters.mjs), monotonic since start: storage.<id>.writes (an overwrite is a write),
  // storage.<id>.deletes and storage.<id>.bytesWritten. They count operations, not what the store holds.
  const count = (name, by = 1) => {
    if (Number.isFinite(by) && by > 0) counters()?.increment(`storage.${id}.${name}`, by);
  };
  const written = (size) => {
    count('writes');
    count('bytesWritten', size);
  };
  const { put, commit, delete: remove } = guarded;
  guarded.put = async (key, body, options = {}) => {
    const result = await put(key, body, options);
    if (options?.blockId === undefined) written(result?.size);
    return result;
  };
  guarded.commit = async (...args) => {
    const result = await commit(...args);
    written(result?.size);
    return result;
  };
  guarded.delete = async (...args) => {
    const result = await remove(...args);
    if (result) count('deletes');
    return result;
  };
  guarded.list = async (prefix = '', options) =>
    call('list', [prefix === '' ? '' : validateKey(prefix, id, { prefix: true }), options]);
  guarded.verifySas = async (url, options) => {
    if (typeof provider.verifySas !== 'function')
      throw new ProviderError('Unsupported', `Storage provider '${id}' does not verify SAS URLs.`, { provider: id });
    try {
      return await provider.verifySas(url, options);
    } catch (error) {
      throw mapError(error, id);
    }
  };
  if (typeof provider.compact === 'function') guarded.compact = () => provider.compact();
  if (typeof provider.preflight === 'function') guarded.preflight = () => provider.preflight();
  guarded.close = async () => {
    await provider.close?.();
  };
  return guarded;
}

const ID = /^[a-z][a-z0-9-]{0,63}$/;
const ENV_REFERENCE = /^env:[A-Za-z_][A-Za-z0-9_]*$/;
const CONTAINER = /^(?=.{3,63}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PACK_KIND = /^pack:[a-z0-9][a-z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const KIND_KEYS = {
  'local-disk': ['kind', 'root'],
  azurite: ['kind', 'connectionString', 'container', 'start', 'timeoutMs'],
  pack: ['kind', 'connectionString', 'container', 'options'],
};
const plain = (value) => value && typeof value === 'object' && !Array.isArray(value);
const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

function storageEntry(id, value, label, stateDirectory) {
  if (!ID.test(id)) throw new Error(`${label} id '${id}' must match ${ID.source}`);
  if (!plain(value)) throw new Error(`${label}.${id} must be an object`);
  const kind = value.kind ?? (id === 'local' ? 'local-disk' : undefined);
  const family = kind === 'local-disk' || kind === 'azurite' ? kind : PACK_KIND.test(kind ?? '') ? 'pack' : null;
  if (!family) throw new Error(`${label}.${id}.kind must be local-disk, azurite or pack:<packId>/<name>`);
  for (const key of Object.keys(value))
    if (!KIND_KEYS[family].includes(key)) throw new Error(`Unknown ${label}.${id} key '${key}' for kind ${kind}`);
  const entry = { kind };
  if (value.root !== undefined) {
    if (typeof value.root !== 'string' || !value.root) throw new Error(`${label}.${id}.root must be a path`);
    // One rule for every caller: the root resolves under the state directory. A caller without one (config load, dry-run, the
    // offline preflight description) checks that a relative root does not escape and leaves an absolute root to the host, which
    // knows the state directory; it keeps no root, so the host gives that id in-memory storage.
    const base = path.resolve(stateDirectory ?? ROOT_PROBE),
      root = path.resolve(base, value.root);
    if ((stateDirectory || !path.isAbsolute(value.root)) && !inside(base, root))
      throw new Error(`${label}.${id}.root must resolve under the state directory`);
    if (stateDirectory) entry.root = root;
  }
  if (value.connectionString !== undefined) {
    // The value is never echoed: a literal here is usually a real secret.
    if (typeof value.connectionString !== 'string' || !ENV_REFERENCE.test(value.connectionString))
      throw new Error(
        `${label}.${id}.connectionString must be an env:NAME reference; literal connection strings are rejected`,
      );
    entry.connectionString = value.connectionString;
  }
  if (family === 'azurite') {
    if (entry.connectionString === undefined)
      throw new Error(`${label}.${id}.connectionString is required for kind azurite`);
    entry.container = value.container ?? 'paqvilo';
    if (value.start !== undefined && value.start !== 'external')
      throw new Error(`${label}.${id}.start must be external; Paqvilo never starts Azurite`);
    entry.start = 'external';
    // Per-request bound until the response headers arrive (storage-azurite.mjs, default 30000).
    if (value.timeoutMs !== undefined) {
      if (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 100 || value.timeoutMs > 600_000)
        throw new Error(`${label}.${id}.timeoutMs must be an integer from 100 to 600000`);
      entry.timeoutMs = value.timeoutMs;
    }
  } else if (value.container !== undefined) entry.container = value.container;
  if (entry.container !== undefined && (typeof entry.container !== 'string' || !CONTAINER.test(entry.container)))
    throw new Error(
      `${label}.${id}.container must be a Blob container name (3-63 lower-case letters, digits and single hyphens)`,
    );
  if (value.options !== undefined) {
    if (!plain(value.options)) throw new Error(`${label}.${id}.options must be an object`);
    entry.options = value.options;
  }
  return entry;
}

/** Validates the `providers.storage` and `providers.routes` keys of a `providers` config object.
 * Other `providers` keys are returned unchanged for their own validators. `stateDirectory` anchors local-disk roots. */
export function storageSettings(value, label = 'providers', { stateDirectory } = {}) {
  if (value == null) value = {};
  if (!plain(value)) throw new Error(`${label} must be an object`);
  const rawStorage = value.storage ?? {};
  if (!plain(rawStorage)) throw new Error(`${label}.storage must be an object`);
  const storage = { local: { kind: 'local-disk' } };
  for (const [id, entry] of Object.entries(rawStorage))
    storage[id] = storageEntry(id, entry, `${label}.storage`, stateDirectory);
  const rawRoutes = value.routes ?? {};
  if (!plain(rawRoutes)) throw new Error(`${label}.routes must be an object`);
  const routes = { ...DEFAULT_STORAGE_ROUTES };
  for (const [route, target] of Object.entries(rawRoutes)) {
    if (!STORAGE_ROUTES.includes(route))
      throw new Error(`Unknown ${label}.routes key '${route}'; expected ${STORAGE_ROUTES.join(', ')}`);
    if (target === 'export' && route !== 'portalWebFiles') throw new Error(`${label}.routes.${route} cannot be export`);
    if (target !== 'export' && !Object.hasOwn(storage, target))
      throw new Error(`${label}.routes.${route} names unknown storage id '${target}'`);
    routes[route] = target;
  }
  return { ...value, storage, routes };
}

/** Route selection over created providers. `config` is storageSettings() output; `providers` maps id → provider.
 * forRoute returns a guarded provider, `null` for the `export` route (serve from the export directory),
 * and throws ProviderError for an unset route or a declared provider that was not created. */
export function createStorageRouter({ config, providers = {}, counters = () => null } = {}) {
  const settings = config?.routes && config?.storage ? config : storageSettings(config);
  const instances = providers instanceof Map ? Object.fromEntries(providers) : { ...providers };
  for (const [id, provider] of Object.entries(instances)) {
    assertProvider(provider);
    if (provider.descriptor.id !== id)
      throw new TypeError(`Storage provider registered as '${id}' declares id '${provider.descriptor.id}'`);
  }
  const guarded = new Map();
  const forRoute = (name) => {
    if (!STORAGE_ROUTES.includes(name))
      throw new ProviderError('Unsupported', `Unknown storage route '${name}'.`, {
        diagnostic: 'PROVIDER_ROUTE_UNKNOWN',
      });
    const target = settings.routes[name];
    if (target === undefined)
      throw new ProviderError(
        'Unsupported',
        `Storage route '${name}' is not configured; set providers.routes.${name}.`,
        { diagnostic: 'PROVIDER_ROUTE_MISSING' },
      );
    if (target === 'export') return null;
    const provider = instances[target];
    if (!provider)
      throw new ProviderError(
        'Unavailable',
        `Storage provider '${target}' for route '${name}' is declared but not available.`,
        { provider: target, diagnostic: 'PROVIDER_NOT_READY' },
      );
    if (!guarded.has(target)) guarded.set(target, guardProvider(provider, { counters }));
    return guarded.get(target);
  };
  const routes = () => ({ ...settings.routes });
  const describe = () => ({
    routes: routes(),
    providers: Object.entries(settings.storage).map(([id, entry]) => {
      const routeNames = STORAGE_ROUTES.filter((route) => settings.routes[route] === id);
      const provider = instances[id];
      // health: a provider's optional health() → { ready: true | false | null, reason } (last observed endpoint state).
      return provider
        ? {
            ...provider.descriptor,
            ready: true,
            routes: routeNames,
            ...(typeof provider.health === 'function' ? { health: provider.health() } : {}),
          }
        : { id, kind: entry.kind, ready: false, routes: routeNames };
    }),
  });
  // Readiness of one created provider (preflightProvider); null when it was not created or has no preflight().
  const preflight = (id) => preflightProvider(instances[id]);
  return { forRoute, routes, describe, preflight };
}

/** Pack `storageProviders`: provider ids mapping to factory functions. */
function validateStorageProviders(map) {
  if (!plain(map) || Object.values(map).some((factory) => typeof factory !== 'function'))
    throw new TypeError('storageProviders must map provider names to factory functions');
}
registerPackExport('storageProviders', { check: packCheck(validateStorageProviders) });

// Config-keys parsers receive no state directory, so a local-disk `root` is checked without one (a relative root must not
// escape; an absolute root is checked by the host) and returned as written. The host calls
// storageSettings(providers, label, { stateDirectory }) again to anchor roots and refuse an absolute root outside it.
const ROOT_PROBE = path.resolve('/paqvilo-state-probe');
registerSettingParser('providers.storage', (value, label) => {
  const settings = storageSettings(value, label);
  for (const [id, entry] of Object.entries(value?.storage ?? {}))
    if (entry?.root !== undefined) settings.storage[id].root = entry.root;
  return settings;
});
