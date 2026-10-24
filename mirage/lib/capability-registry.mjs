// One capability registry: every organization module, host surface, provider, service fixture,
// operation and inventory component is one normalised record with a fidelity level. Consumers: runtime status
// (summary()), `mirage preflight` / GET /_sim/api/preflight (capability-report.mjs) and strict acceptance
// (assertExecutable()). Records never carry configuration values, only names, levels and prerequisites.
import fs from 'node:fs';
import { DataError } from './data-error.mjs';
import { runtimeCapabilities } from './runtime-config.mjs';

export const CAPABILITY_LEVELS = Object.freeze(['inventory', 'contract', 'behaviour', 'native-qualified']);
export const CAPABILITY_KINDS = Object.freeze(['organization-module', 'host-surface', 'operation', 'provider', 'identity', 'service', 'inventory']);
const LEVEL_ALIASES = Object.freeze({ disabled: 'inventory', placeholder: 'inventory', fixture: 'contract', mock: 'contract' });
const KIND_ALIASES = Object.freeze({ 'dataverse-extension': 'organization-module' });
// operation-catalogue / plugin-catalogue `mode` → level.
const MODE_LEVELS = Object.freeze({ placeholder: 'inventory', disabled: 'inventory', mock: 'contract', exported: 'behaviour', handler: 'behaviour', clr: 'behaviour', webhook: 'behaviour' });
// Optional record fields kept by the normaliser; everything else (functions, fidelity notes, settings) is dropped.
const KEPT = ['principal', 'stateOwner', 'lifecycle', 'seams', 'reason', 'mode', 'enabled', 'source', 'providerKind', 'component', 'required'];

let packageVersion;
const defaultVersion = () => (packageVersion ??= JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version);
const rank = level => CAPABILITY_LEVELS.indexOf(level);
const lowest = levels => levels.reduce((low, level) => (rank(level) < rank(low) ? level : low));
const isMap = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function levelOf(value, label) {
  const level = LEVEL_ALIASES[value] ?? value;
  if (!CAPABILITY_LEVELS.includes(level)) throw new TypeError(`${label} must be one of ${CAPABILITY_LEVELS.join(', ')} (got ${JSON.stringify(value)})`);
  return level;
}

/** Glob over capability and requirement ids: `*` matches any run of characters; case-insensitive. */
export function globMatcher(pattern) {
  if (typeof pattern !== 'string' || !pattern.trim()) throw new TypeError('A capability pattern must be non-empty text');
  const source = pattern.trim().split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  const expression = new RegExp(`^${source}$`, 'i');
  return value => expression.test(String(value));
}

/**
 * The one normaliser. Accepts the shapes modules declare in describe():
 * - `operations` as strings (each takes the record's `level`) or `{ name, level, reason? }`;
 * - `contractOperations: [names]` (operations at `contract`) and `operationLevels: { name: level }` (per-operation levels);
 * - `seams` kept as given; kind `dataverse-extension` read as `organization-module`; levels `fixture`/`mock` read as
 *   `contract`, `disabled`/`placeholder` as `inventory`.
 * Level rule: the record's level is the LOWEST level among its operations, unless the record states a level and no
 * operation is below it, in which case the stated level is kept. Without operations the stated level is required.
 * `native-qualified` (record or operation) requires `evidence` naming at least one compared scenario `{ scenario: id }`.
 */
export function normalizeCapabilityRecord(record) {
  if (!isMap(record)) throw new TypeError('A capability record must be an object');
  const name = record.name;
  if (typeof name !== 'string' || !name.trim()) throw new TypeError('A capability record needs a name');
  const label = `Capability ${name}`;
  const kind = KIND_ALIASES[record.kind] ?? record.kind;
  if (!CAPABILITY_KINDS.includes(kind)) throw new TypeError(`${label}: kind must be one of ${CAPABILITY_KINDS.join(', ')} (got ${JSON.stringify(record.kind)})`);
  const stated = record.level === undefined ? null : levelOf(record.level, `${label}: level`);
  const overrides = record.operationLevels ?? {};
  if (!isMap(overrides)) throw new TypeError(`${label}: operationLevels must map operation names to levels`);
  const operations = new Map();
  const put = (operation, fallback) => {
    const entry = typeof operation === 'string' ? { name: operation } : operation;
    if (!isMap(entry) || typeof entry.name !== 'string' || !entry.name) throw new TypeError(`${label}: operations are names or { name, level }`);
    const given = overrides[entry.name] ?? entry.level ?? fallback;
    if (given == null) throw new TypeError(`${label}: operation ${entry.name} has no level and the record states none`);
    operations.set(entry.name, { name: entry.name, level: levelOf(given, `${label}: operation ${entry.name} level`), ...(entry.reason != null ? { reason: String(entry.reason) } : {}) });
  };
  if (record.operations !== undefined && !Array.isArray(record.operations)) throw new TypeError(`${label}: operations must be an array`);
  for (const operation of record.operations ?? []) put(operation, stated);
  if (record.contractOperations !== undefined && !Array.isArray(record.contractOperations)) throw new TypeError(`${label}: contractOperations must be an array of names`);
  for (const operation of record.contractOperations ?? []) put(operation, 'contract');
  for (const operation of Object.keys(overrides)) if (!operations.has(operation)) put(operation, null);
  const list = [...operations.values()];
  const low = list.length ? lowest(list.map(operation => operation.level)) : null;
  const level = stated && (!low || rank(low) >= rank(stated)) ? stated : low;
  if (!level) throw new TypeError(`${label}: level is required (one of ${CAPABILITY_LEVELS.join(', ')})`);
  const evidence = record.evidence ?? [];
  if (!Array.isArray(evidence)) throw new TypeError(`${label}: evidence must be an array`);
  if ((level === 'native-qualified' || list.some(operation => operation.level === 'native-qualified'))
    && !evidence.some(entry => typeof entry?.scenario === 'string' && entry.scenario.trim()))
    throw new TypeError(`${label}: native-qualified requires evidence with at least one compared scenario id ({ scenario: '<id>' })`);
  const requires = record.requires ?? [];
  if (!Array.isArray(requires) || requires.some(entry => typeof entry !== 'string' || !entry)) throw new TypeError(`${label}: requires must be an array of names`);
  const result = { name, version: String(record.version ?? defaultVersion()), kind, level, operations: list, requires: [...requires] };
  for (const key of KEPT) if (record[key] !== undefined) result[key] = structuredClone(record[key]);
  if (evidence.length) result.evidence = structuredClone(evidence);
  return result;
}

/** Records a pack declares through its `capabilities` export (pack-exports.mjs: an array, or a map by name), attributed to the pack. */
export const packCapabilityRecords = (packs = []) => packs.flatMap(pack => {
  const value = pack?.capabilities ?? [];
  return (Array.isArray(value) ? value : Object.entries(value).map(([name, record]) => ({ ...record, name }))).map(record => ({ ...record, source: `pack:${pack.id}` }));
});

export function createCapabilityRegistry({ runtime } = {}) {
  const records = new Map();
  const candidates = () => [...records.values()].flatMap(record => [
    { id: record.name, record: record.name, level: record.level, reason: record.reason ?? null },
    ...record.operations.map(operation => ({ id: `${record.name}/${operation.name}`, record: record.name, operation: operation.name, level: operation.level, reason: operation.reason ?? null })),
  ]);
  const registry = {
    add(record) {
      const normal = normalizeCapabilityRecord(record);
      const existing = records.get(normal.name);
      if (existing) throw new Error(`Capability ${normal.name} is already registered (kind ${existing.kind}); capability names must be unique`);
      records.set(normal.name, normal);
      return normal;
    },
    addAll(list = []) { return list.map(record => registry.add(record)); },
    /** EXTENSIONS entries: describe() when present, else an honest inventory-level record. */
    fromExtensions(list = []) {
      return list.map(entry => registry.add(entry.describe?.() ?? { name: entry.name, kind: 'organization-module', level: 'inventory', operations: [], requires: [],
        principal: 'none', stateOwner: 'unknown', lifecycle: { install: true, reset: Boolean(entry.reset), close: Boolean(entry.close) } }));
    },
    /** operation-catalogue and plugin-catalogue items; an unsupported item stays at inventory with its reason. */
    fromOperations(items = []) {
      return items.map(item => registry.add({ name: item.key, kind: 'operation', mode: item.mode,
        level: item.unsupported ? 'inventory' : MODE_LEVELS[item.mode] ?? 'inventory',
        ...(item.unsupported ? { reason: String(item.unsupported) } : item.mode in MODE_LEVELS ? {} : { reason: `Unknown operation mode ${item.mode}` }) }));
    },
    /** Storage, messaging, connector or local-service descriptors; the descriptor kind is kept as providerKind. */
    fromProviders(descriptors = []) {
      return descriptors.map(descriptor => registry.add({ ...descriptor, kind: 'provider',
        ...(descriptor.kind && descriptor.kind !== 'provider' ? { providerKind: descriptor.kind } : {}) }));
    },
    /** Solution inventory records (solution-inventory.mjs); the later record of one component name wins. */
    fromInventory(list = []) {
      const byName = new Map(list.map(item => [`${item.component}:${item.name}`, item]));
      return [...byName].map(([name, item]) => registry.add({ name, kind: 'inventory', component: item.component, level: item.level ?? 'inventory',
        ...(item.reason ? { reason: item.reason } : {}) }));
    },
    /** A service-fixture registry (service-fixtures.mjs) or any object with describe() → records. */
    fromServices(services) {
      return registry.addAll((services?.describe?.() ?? []).map(record => ({ ...record, kind: 'service' })));
    },
    get: name => (records.has(name) ? structuredClone(records.get(name)) : null),
    list({ kind, level } = {}) {
      return [...records.values()].filter(record => (!kind || record.kind === kind) && (!level || record.level === level)).map(record => structuredClone(record));
    },
    /**
     * Legacy boolean capabilities: runtimeCapabilities(runtime) plus one key per host-surface record
     * (`enabled`, default true). Host surfaces are registered by the hosts under their legacy key names.
     */
    summary() {
      const summary = runtime === undefined ? {} : runtimeCapabilities(runtime);
      for (const record of records.values()) if (record.kind === 'host-surface') summary[record.name] = record.enabled !== false;
      return summary;
    },
    /**
     * `{ modules, missing, unsupported }`. `missing`: plain (un-prefixed) `requires` names no record provides;
     * prefixed ones (`table:`, `metadata:`, `secret:`, ...) are prerequisites the source graph and preflight resolve.
     * `unsupported`: capabilities below behaviour, limited to those matching `scenario.requires` when a scenario is given.
     */
    report({ scenario } = {}) {
      const missing = [];
      for (const record of records.values()) for (const name of record.requires)
        if (!name.includes(':') && !records.has(name)) missing.push({ module: record.name, requires: name });
      const matchers = scenario?.requires?.map(globMatcher);
      const unsupported = candidates().filter(item => rank(item.level) < rank('behaviour') && (!matchers || matchers.some(match => match(item.id))));
      return { modules: registry.list(), missing, unsupported };
    },
    /** Strict acceptance: every pattern must match a capability at behaviour or above. Throws CapabilityUnavailable. */
    assertExecutable(required = []) {
      const all = candidates(), gaps = [];
      for (const pattern of required) {
        const matched = all.filter(item => globMatcher(pattern)(item.id));
        if (!matched.length) gaps.push({ requirement: pattern, name: null, level: null, reason: 'Not registered' });
        for (const item of matched) if (rank(item.level) < rank('behaviour')) gaps.push({ requirement: pattern, name: item.id, level: item.level, reason: item.reason });
      }
      if (gaps.length) throw new DataError(`Capabilities unavailable: ${gaps.map(gap => gap.name ? `${gap.name} is ${gap.level}` : `${gap.requirement} is not registered`).join('; ')}`,
        501, 'CapabilityUnavailable', { gaps });
      return true;
    },
  };
  return registry;
}
