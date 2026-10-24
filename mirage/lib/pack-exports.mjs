// One registry of recognised data-pack exports. Each row says how an export is shaped
// (kind), how its keys are normalised (key), how its value is validated (check, throws) and what happens
// when two packs register the same key (collide). Unknown pack keys produce PACK_EXPORT_UNKNOWN.
import { validateEndpoints } from './extensions.mjs';

const GUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const isMap = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const fail = (packId, message) => { throw new Error(`Data pack ${packId}: ${message}`); };
const exact = key => key;
const lower = key => String(key).toLowerCase();
const canonicalGuid = key => String(key ?? '').replace(/[{}]/g, '').toLowerCase();
const bareKey = key => canonicalGuid(key).trim();
const isSync = handler => typeof handler === 'function' && handler.constructor?.name !== 'AsyncFunction';

const mapOf = (test, message) => (value, packId) => {
  if (!isMap(value) || Object.entries(value).some(([key, entry]) => !test(key, entry))) fail(packId, message);
};
const named = (key, handler) => Boolean(key.trim()) && typeof handler === 'function';
const descriptor = (key, entry) => GUID.test(key.replace(/[{}]/g, '')) && isMap(entry);

function checkOperators(value, packId) {
  if (!isMap(value) || Object.values(value).some(entry => typeof entry !== 'function')) fail(packId, 'expressionOperators must be an object of functions');
  for (const name of Object.keys(value))
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) throw new TypeError(`Pack ${packId}: expression operator ${name} must be a named function`);
}

function checkShell(value, packId) {
  if (!isMap(value)) throw new TypeError(`Pack ${packId}: shell must be { footerLogoClass?, headerNotificationQuery? }`);
  const { footerLogoClass: className, headerNotificationQuery: query } = value;
  if (className != null && (typeof className !== 'string' || !/^[A-Za-z_][\w-]*$/.test(className)))
    throw new TypeError(`Pack ${packId}: shell.footerLogoClass must be a CSS class name`);
  if (query != null && (typeof query !== 'string' || !query.trim() || query.length > 256))
    throw new TypeError(`Pack ${packId}: shell.headerNotificationQuery must name a web template`);
}
const shellEntries = value => [
  ...(value.footerLogoClass != null ? [[`footerLogoClass:${value.footerLogoClass}`, value.footerLogoClass]] : []),
  ...(value.headerNotificationQuery != null ? [[`headerNotificationQuery:${value.headerNotificationQuery}`, value.headerNotificationQuery]] : []),
];

function checkCustomApis(value, packId) {
  if (!isMap(value)) fail(packId, 'customApis must map custom API unique names to functions');
  for (const [name, entry] of Object.entries(value)) {
    const handler = typeof entry === 'function' ? entry : entry?.handler;
    if (!name.trim() || typeof handler !== 'function') fail(packId, `invalid customApis handler for ${name}`);
    const pluginType = typeof entry === 'function' ? undefined : entry?.pluginType;
    if (pluginType !== undefined && (typeof pluginType !== 'string' || !pluginType.trim())) fail(packId, `customApis pluginType for ${name} must be non-empty text`);
  }
}

// Default check of an export whose owning module has not registered its real one yet.
function pendingCheck(name, shape) {
  return (value, packId) => {
    if (shape === 'array') {
      if (!Array.isArray(value) || value.some(entry => !isMap(entry))) fail(packId, `${name} must be an array of objects`);
      return;
    }
    if (!isMap(value) || Object.values(value).some(entry => typeof entry !== 'function' && !isMap(entry))) fail(packId, `${name} must be an object of functions or objects`);
  };
}

const row = spec => Object.freeze({ kind: 'map', key: exact, collide: 'error', pending: null, ...spec });

/** Recognised exports. Provider modules replace their pending rows with registerPackExport(). */
export const PACK_EXPORTS = {
  serverLogics: row({ key: lower, check: mapOf(named, 'serverLogics must map exported names to functions') }),
  cloudFlows: row({ key: lower, check: mapOf(named, 'cloudFlows must map exported names to functions') }),
  // Any key (a GUID or a unique name, brace-stripped and lowercased) and a null export.
  flowIdentities: row({ key: canonicalGuid, entries: value => Object.entries(value ?? {}),
    check: (value, packId) => { if (value !== null) mapOf((key, entry) => Boolean(canonicalGuid(key).trim()) && isMap(entry), 'flowIdentities must map flow IDs or names to explicit trusted descriptors')(value, packId); } }),
  pluginSteps: row({ key: canonicalGuid, check: mapOf((id, handler) => GUID.test(id.replace(/[{}]/g, '')) && isSync(handler), 'pluginSteps must map exported step IDs to synchronous functions') }),
  pluginTypes: row({ key: exact, check: mapOf((type, handler) => /^[_a-z][\w.+`]{0,249}$/i.test(type) && isSync(handler), 'pluginTypes must map plug-in type names to synchronous functions') }),
  pluginRuntimes: row({ key: canonicalGuid, check: mapOf(descriptor, 'pluginRuntimes must map exact exported IDs to explicit trusted descriptors') }),
  customApis: row({ key: lower, check: checkCustomApis }),
  workflows: row({ key: bareKey, check: mapOf((key, handler) => Boolean(bareKey(key)) && typeof handler === 'function', 'workflows must map workflow ids or unique names to functions') }),
  dataverseMessages: row({ key: exact, check: mapOf(named, 'dataverseMessages must map message names to functions') }),
  expressionOperators: row({ key: exact, check: checkOperators }),
  endpoints: row({ kind: 'value', entries: value => value.map(endpoint => [endpoint.id, endpoint]), check: (value, packId) => { validateEndpoints(packId, value); }, collide: 'none' }),
  shell: row({ kind: 'value', entries: shellEntries, check: checkShell }),
};

// Provider exports whose modules register their real rows when they load.
const PENDING = {
  connectors: 'connector-runtime.mjs', httpFixtures: 'connector-runtime.mjs', connectionPrincipals: 'connector-runtime.mjs',
  storageProviders: 'storage-provider.mjs', messageProviders: 'message-bus.mjs', virtualTableProviders: 'dataverse-virtual-providers.mjs',
  outboxHandlers: 'outbox.mjs', serviceFixtures: 'service-fixtures.mjs', powerFx: 'canvas-power-fx.mjs',
  calculatedColumns: 'dataverse-calculated.mjs', businessRules: 'dataverse-business-rules.mjs', rollups: 'dataverse-rollup.mjs',
  formulaColumns: 'dataverse-formula.mjs', hierarchies: 'dataverse-hierarchy.mjs', transitions: 'dataverse-state-transitions.mjs',
  flowActions: 'flow-actions.mjs', flowTriggers: 'flow-triggers.mjs',
};
for (const [name, module] of Object.entries(PENDING)) {
  const array = name === 'httpFixtures';
  PACK_EXPORTS[name] = row({ pending: module, check: pendingCheck(name, array ? 'array' : 'object'),
    ...(array ? { kind: 'value', entries: value => value.map((entry, index) => [entry.id ?? String(index), entry]) } : {}) });
}

/** Pack keys that are not registry exports: identity, matching, presets and data helpers. */
export const CORE = Object.freeze(['id', 'name', 'description', 'matches', 'presets', 'configurationPresets', 'personaCatalog', 'dataFiles',
  'webApiErrorTemplates', 'dataset', 'profiles', 'parity', 'generators', 'personas', 'plugins']);

/**
 * Called by the module that owns an export, e.g. `registerPackExport('connectors', CONNECTOR_PACK_EXPORTS.connectors)`.
 * spec: { check(value, packId), kind?, key?, entries?, collide? }. Replaces a pending row; a registered row is final.
 */
export function registerPackExport(name, spec) {
  if (typeof name !== 'string' || !/^[a-z][A-Za-z0-9]*$/.test(name) || CORE.includes(name)) throw new TypeError(`Invalid pack export name ${name}`);
  if (!spec || typeof spec.check !== 'function') throw new TypeError(`registerPackExport('${name}') needs check(value, packId)`);
  const existing = PACK_EXPORTS[name];
  if (existing && !existing.pending && existing.check !== spec.check) throw new Error(`Pack export ${name} is already registered`);
  PACK_EXPORTS[name] = row({ ...(existing ?? {}), ...spec, pending: null });
  return PACK_EXPORTS[name];
}

/** Adapts a module validator `validate(value)` (throws without a pack id) to a registry check that names the pack. */
export const packCheck = validate => (value, packId) => {
  try { validate(value); } catch (error) { throw new TypeError(`Data pack ${packId}: ${error.message}`); }
};

const CAPABILITY_LEVELS = ['inventory', 'contract', 'behaviour', 'native-qualified'];
/** Pack `capabilities`: an array (or a map by name) of capability records with at least { name, kind, level }. */
export function validatePackCapabilities(value) {
  if (!Array.isArray(value) && !isMap(value)) throw new TypeError('capabilities must be an array or a map of capability records');
  for (const record of Array.isArray(value) ? value : Object.values(value)) {
    if (!isMap(record) || typeof record.name !== 'string' || !record.name.trim() || typeof record.kind !== 'string' || !record.kind.trim())
      throw new TypeError('capabilities records need a name and a kind');
    if (!CAPABILITY_LEVELS.includes(record.level)) throw new TypeError(`capability ${record.name} level must be ${CAPABILITY_LEVELS.join(', ')}`);
  }
}
registerPackExport('capabilities', { kind: 'value', check: packCheck(validatePackCapabilities),
  entries: value => (Array.isArray(value) ? value.map(record => [record.name, record]) : Object.entries(value)) });

// A recognised export is a plain data property: a getter could answer differently after validation, so it is refused.
const dataValue = (pack, name) => {
  const property = Object.getOwnPropertyDescriptor(pack, name);
  if (property && !('value' in property)) throw new TypeError(`Data pack ${pack.id}: export ${name} must be a plain data property, not a getter`);
  return property?.value;
};
const entriesOf = (spec, value) => (spec.entries ? spec.entries(value) : Object.entries(value));

/**
 * Validates every recognised export the pack declares (throws on an invalid value) and returns diagnostics:
 * PACK_EXPORT_UNKNOWN for keys no row recognises (strict: throws) and PACK_EXPORT_PENDING for exports
 * still checked by the default shape check.
 */
export function validatePackExports(pack, { strict = false } = {}) {
  const unknown = Object.keys(pack).filter(key => !CORE.includes(key) && !Object.hasOwn(PACK_EXPORTS, key));
  if (unknown.length && strict) throw new Error(`Data pack ${pack.id}: unknown exports ${unknown.join(', ')}`);
  const diagnostics = unknown.map(key => ({ code: 'PACK_EXPORT_UNKNOWN', severity: 'warning', pack: pack.id, key,
    message: `Data pack ${pack.id} exports ${key}, which no recognised export reads; it is ignored.` }));
  for (const [name, spec] of Object.entries(PACK_EXPORTS)) {
    const value = dataValue(pack, name);
    if (value === undefined) continue;
    spec.check(value, pack.id);
    if (spec.pending) diagnostics.push({ code: 'PACK_EXPORT_PENDING', severity: 'info', pack: pack.id, key: name,
      message: `Data pack ${pack.id} export ${name} is shape-checked only until ${spec.pending} registers its contract.` });
  }
  return diagnostics;
}

/**
 * A frozen copy of the pack's own property descriptors (lazy getters of core keys stay getters, unevaluated). Validate the
 * snapshot, not the pack: its recognised exports are then the data values validatePackExports() checked, so a Proxy pack
 * or a later change cannot hand a direct reader something else.
 */
export function snapshotPackExports(pack) {
  const snapshot = Object.create(Object.getPrototypeOf(pack));
  for (const key of Reflect.ownKeys(pack)) {
    const property = Object.getOwnPropertyDescriptor(pack, key);
    if (property) Object.defineProperty(snapshot, key, property);
  }
  return Object.freeze(snapshot);
}

/** Map normalisedKey → { value, pack } across packs, in pack order, with one collision message for every export. */
export function collectPackExport(packs = [], name) {
  const spec = PACK_EXPORTS[name];
  if (!spec) throw new Error(`Unknown pack export ${name}`);
  const result = new Map();
  for (const pack of packs) {
    const value = pack?.[name];
    if (value === undefined) continue;
    spec.check(value, pack.id);
    for (const [rawKey, entry] of entriesOf(spec, value)) {
      const key = spec.key(rawKey);
      const previous = result.get(key);
      if (!previous) { result.set(key, { value: entry, pack: pack.id }); continue; }
      if (spec.collide === 'error') throw new Error(`Ambiguous ${name} registration for ${key} in packs ${previous.pack} and ${pack.id}`);
    }
  }
  return result;
}

/** What each pack provides, for preflight and the source graph: [{ pack, export, key }]. */
export function packProvides(packs = []) {
  const provided = [];
  for (const pack of packs) for (const [name, spec] of Object.entries(PACK_EXPORTS)) {
    const value = dataValue(pack, name);
    if (value === undefined) continue;
    for (const [key] of entriesOf(spec, value)) provided.push({ pack: pack.id, export: name, key: spec.key(key) });
  }
  return provided;
}
