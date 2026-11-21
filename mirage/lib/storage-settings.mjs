// The `providers.storage` and `providers.routes` settings contract: validation only, no provider. storage-provider.mjs
// re-exports storageSettings; settings-contracts.mjs registers the parser on the config-load path.
import path from 'node:path';

/** The storage routes a runtime resolves. */
export const STORAGE_ROUTES = Object.freeze([
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

const ID = /^[a-z][a-z0-9-]{0,63}$/;
const ENV_REFERENCE = /^env:[A-Za-z_]\w*$/;
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
// Config-keys parsers receive no state directory, so a local-disk `root` is checked without one (a relative root must not
// escape; an absolute root is checked by the host) and returned as written. The host calls
// storageSettings(providers, label, { stateDirectory }) again to anchor roots and refuse an absolute root outside it.
const ROOT_PROBE = path.resolve('/paqvilo-state-probe');

function storageRoot(entry, value, label, id, stateDirectory) {
  if (value.root === undefined) return;
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

function storageConnectionString(entry, value, label, id) {
  if (value.connectionString === undefined) return;
  // The value is never echoed: a literal here is usually a real secret.
  if (typeof value.connectionString !== 'string' || !ENV_REFERENCE.test(value.connectionString))
    throw new Error(
      `${label}.${id}.connectionString must be an env:NAME reference; literal connection strings are rejected`,
    );
  entry.connectionString = value.connectionString;
}

function configureAzurite(entry, value, label, id) {
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
}

/* NOSONAR */ function storageEntry(id, value, label, stateDirectory) {
  if (!ID.test(id)) throw new Error(`${label} id '${id}' must match ${ID.source}`);
  if (!plain(value)) throw new Error(`${label}.${id} must be an object`);
  const kind = value.kind ?? (id === 'local' ? 'local-disk' : undefined);
  let family = null;
  if (kind === 'local-disk' || kind === 'azurite') family = kind;
  else if (PACK_KIND.test(kind ?? '')) family = 'pack';
  if (!family) throw new Error(`${label}.${id}.kind must be local-disk, azurite or pack:<packId>/<name>`);
  for (const key of Object.keys(value))
    if (!KIND_KEYS[family].includes(key)) throw new Error(`Unknown ${label}.${id} key '${key}' for kind ${kind}`);
  const entry = { kind };
  storageRoot(entry, value, label, id, stateDirectory);
  storageConnectionString(entry, value, label, id);
  if (family === 'azurite') configureAzurite(entry, value, label, id);
  else if (value.container !== undefined) entry.container = value.container;
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

/** The parser the config-key registry holds for `providers.storage`: a local-disk `root` is returned as written. */
export const storageSettingParser = (value, label) => {
  const settings = storageSettings(value, label);
  for (const [id, entry] of Object.entries(value?.storage ?? {}))
    if (entry?.root !== undefined) settings.storage[id].root = entry.root;
  return settings;
};
