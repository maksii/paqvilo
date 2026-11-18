// Storage provider contract: errors, key validation, provider shape check, config validation and route selection.
// Implementations: storage-local-disk.mjs (default, behaviour) and storage-azurite.mjs (Blob REST with Shared Key:
// behaviour with a usable connection string, declared only (contract) without one).
// The shared contract suite is mirage/testing/storage-contract.mjs. See mirage/docs/storage-providers.md.
import { DataError } from './data-error.mjs';
import { registerSettingParser } from './config-keys.mjs';
import { STORAGE_ROUTES, storageSettings, storageSettingParser } from './storage-settings.mjs';
import { packCheck, registerPackExport } from './pack-exports.mjs';
import { choiceMessage } from './runtime-config.mjs';

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
    throw new TypeError(`Storage provider ${d?.id ? "'" + d.id + "' " : ''}is invalid: ${reason}`);
  };
  assertProviderDescriptor(provider, d, fail);
  return provider;
}

/* NOSONAR */ function assertProviderDescriptor(provider, d, fail) {
  if (!d || typeof d !== 'object') fail('descriptor is missing');
  for (const field of ['id', 'kind'])
    if (typeof d[field] !== 'string' || !d[field]) fail(`descriptor.${field} must be a non-empty string`);
  if (!LEVELS.includes(d.level)) fail(choiceMessage('descriptor.level', LEVELS, d.level));
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
}

/** The default idle bound of a readiness probe: a provider that makes no progress for this long has given no answer. */
export const PREFLIGHT_IDLE_TIMEOUT_MS = 30000;

// The longest delay a Node timer accepts; a longer one fires after 1 ms.
const MAX_TIMER_DELAY_MS = 2147483647;

/**
 * Arms a timer for ms, clamped to MAX_TIMER_DELAY_MS. A non-finite ms (Infinity, or null for no bound) arms nothing and
 * returns null, so that bound never ends by itself. clearTimeout(null) is a no-op.
 */
function armTimer(ms, callback) {
  return Number.isFinite(ms) ? setTimeout(callback, Math.min(ms, MAX_TIMER_DELAY_MS)) : null;
}

/**
 * The bounds of a one-request probe, shared by requestBound and preflightProvider: an explicit timeoutMs is the only bound
 * (deadlineMs, with no idle window: idleMs null). Without it the idle window applies and no deadline does.
 */
function probeBounds(timeoutMs, idleTimeoutMs) {
  return timeoutMs != null ? { deadlineMs: timeoutMs, idleMs: null } : { deadlineMs: null, idleMs: idleTimeoutMs };
}

/**
 * An idle guard: onIdle runs once when idleMs pass without a progress() call. Each progress() restarts that window, and
 * stop() ends the guard for good (a late progress() after stop() re-arms nothing). A null or non-finite idleMs never fires.
 */
function startIdleGuard(idleMs, onIdle) {
  let timer = null;
  let done = false;
  const progress = () => {
    if (done) return;
    clearTimeout(timer);
    timer = armTimer(idleMs, () => {
      done = true;
      onIdle();
    });
  };
  progress();
  return {
    progress,
    stop() {
      done = true;
      clearTimeout(timer);
    },
  };
}

/**
 * The bound of a one-request probe: the caller's timeoutMs when it gives one, else the idle window (no answer within
 * PREFLIGHT_IDLE_TIMEOUT_MS). signal aborts with a TimeoutError when the bound ends; limitMs names the bound in a message;
 * done() releases the deadline and the idle guard once the answer is in.
 */
export function requestBound(timeoutMs) {
  const { deadlineMs, idleMs } = probeBounds(timeoutMs, PREFLIGHT_IDLE_TIMEOUT_MS);
  if (deadlineMs != null) return { ...deadlineBound(deadlineMs), limitMs: deadlineMs };
  const controller = new AbortController();
  const guard = startIdleGuard(idleMs, () =>
    controller.abort(new DOMException(`no answer within ${PREFLIGHT_IDLE_TIMEOUT_MS} ms`, 'TimeoutError')),
  );
  return { signal: controller.signal, limitMs: PREFLIGHT_IDLE_TIMEOUT_MS, done: () => guard.stop() };
}

/**
 * The bound of an explicit request deadline: signal aborts with a TimeoutError when the delay ends, on the same timer clock as
 * the rest of the probe. done() releases the timer. A non-finite deadline arms nothing, so its signal never aborts.
 */
function deadlineBound(ms) {
  const controller = new AbortController();
  const timer = armTimer(ms, () =>
    controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
  );
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

/**
 * Readiness of an instantiated storage provider or message bus through its optional preflight() → { ready, reason? }. The probe
 * ends at the first of: the provider's answer, a caller's timeoutMs (when given, and then the only bound), or idleTimeoutMs
 * (30 s by default) without progress. Either bound answers ready: false and calls onTimeout. preflight() receives
 * { signal, progress }: the signal aborts when the probe ends, and each progress() call restarts the idle window, so a
 * provider that keeps signalling is never cut off. null when the instance has no preflight(): it is declared, never probed.
 */
export async function preflightProvider(
  instance,
  { timeoutMs, idleTimeoutMs = PREFLIGHT_IDLE_TIMEOUT_MS, onTimeout } = {},
) {
  if (typeof instance?.preflight !== 'function') return null;
  const controller = new AbortController();
  const bounds = probeBounds(timeoutMs, idleTimeoutMs);
  let deadline = null;
  let guard = null;
  // A CLI may have no other active handles while awaiting a provider. The deadline and the idle guard stay alive until an
  // answer is delivered, then both are released in finally.
  const ended = new Promise((resolve) => {
    const expire = (reason) => {
      onTimeout?.();
      controller.abort();
      resolve({ ready: false, reason });
    };
    deadline = armTimer(bounds.deadlineMs, () => expire(`No preflight answer within ${timeoutMs} ms.`));
    guard = startIdleGuard(bounds.idleMs, () => expire(`The provider gave no answer for ${idleTimeoutMs} ms.`));
  });
  const context = { signal: controller.signal, progress: () => guard.progress() };
  try {
    const result = await Promise.race([Promise.resolve().then(() => instance.preflight(context)), ended]);
    return result?.ready === true
      ? { ready: true, reason: null }
      : { ready: false, reason: String(result?.reason ?? 'The provider reported it is not ready.') };
  } catch (error) {
    return { ready: false, reason: error?.message ?? String(error) };
  } finally {
    clearTimeout(deadline);
    guard.stop();
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
  // A probe the bound aborted can still be in its cleanup: close waits for each probe started through this wrapper that
  // has not settled yet.
  const probes = new Set();
  const track = (probe) => {
    const forget = () => probes.delete(settled);
    const settled = probe.then(forget, forget);
    probes.add(settled);
    return probe;
  };
  if (typeof provider.preflight === 'function')
    guarded.preflight = (context) => track(Promise.resolve().then(() => provider.preflight(context)));
  guarded.close = async () => {
    await Promise.all(probes);
    await provider.close?.();
  };
  return guarded;
}

const plain = (value) => value && typeof value === 'object' && !Array.isArray(value);
// The `providers.storage` and `providers.routes` contract lives in storage-settings.mjs, so the config-load path validates it
// without this module.
export { storageSettings };

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
  const preflight = (id, options) => preflightProvider(instances[id], options);
  return { forRoute, routes, describe, preflight };
}

/** Pack `storageProviders`: provider ids mapping to factory functions. */
function validateStorageProviders(map) {
  if (!plain(map) || Object.values(map).some((factory) => typeof factory !== 'function'))
    throw new TypeError('storageProviders must map provider names to factory functions');
}
registerPackExport('storageProviders', { check: packCheck(validateStorageProviders) });

registerSettingParser('providers.storage', storageSettingParser);
