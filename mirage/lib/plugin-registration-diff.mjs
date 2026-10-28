// Compare two explicit, parsed local export inventories. A catalogue's adapter
// mode is deliberately not a registration execution mode. Never emit config.
import { isDeepStrictEqual } from 'node:util';
import { guidKey } from './dataverse-values.mjs';
import { inspectionBudget } from './inspection-budget.mjs';

const plain = (value) => value && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const normalized = (value) => {
  if (value == null) return null;
  if (typeof value !== 'string') throw new TypeError('Registration names must be primitive strings.');
  return value.trim().toLowerCase();
};
const identity = (value) => (typeof value === 'string' ? guidKey(value) : null);
const text = (value) => (typeof value === 'string' ? value : null);
const scalar = (value, charge) => {
  if (value == null) return null;
  if (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value)))
    throw new TypeError('Registration facts must contain finite primitive values.');
  if (typeof value === 'string') charge(value.length);
  return value;
};
const reference = (value, charge) => {
  if (value == null || value === '') return null;
  charge(typeof value === 'string' ? value.length : 1);
  const id = identity(value);
  if (!id) throw new TypeError('Registration references must be GUID identities.');
  return id;
};
const attributes = (value, charge) => {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 10000 || value.some((item) => typeof item !== 'string'))
    throw new Error('Registration attributes must be a bounded string array.');
  charge(value.length);
  for (const item of value) charge(item.length);
  return [...new Set(value.map(normalized).filter(Boolean))].sort();
};
function facts(kind, row, charge) {
  charge();
  for (const key of [
    'name',
    'fullName',
    'version',
    'culture',
    'publicKeyToken',
    'typeName',
    'assemblyName',
    'entity',
    'message',
    'sourceFile',
  ])
    if (typeof row[key] === 'string') charge(row[key].length);
  if (kind === 'assemblies')
    return Object.fromEntries(
      ['name', 'fullName', 'version', 'culture', 'publicKeyToken', 'isolationMode', 'sourceType'].map((key) => [
        key,
        scalar(row[key], charge),
      ]),
    );
  if (kind === 'types') return { name: text(row.name), assemblyId: reference(row.assemblyId, charge) };
  if (
    row.images != null &&
    (!Array.isArray(row.images) || row.images.length > 1000 || row.images.some((image) => !plain(image)))
  )
    throw new Error('Registration images must be a bounded object array.');
  charge(row.images?.length ?? 0);
  const images = (row.images ?? []).map((image) => {
    charge(
      (typeof image.name === 'string' ? image.name.length : 0) +
        (typeof image.alias === 'string' ? image.alias.length : 0),
    );
    return {
      name: text(image.name),
      alias: text(image.alias),
      type: scalar(image.type, charge),
      attributes: attributes(image.attributes, charge),
    };
  });
  images.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));
  return {
    name: text(row.name),
    typeId: reference(row.typeId, charge),
    typeName: text(row.typeName),
    assemblyId: reference(row.assemblyId, charge),
    assemblyName: text(row.assemblyName),
    entity: normalized(row.entity),
    message: normalized(row.message),
    messageId: reference(row.messageId, charge),
    messageFilterId: reference(row.messageFilterId, charge),
    eventHandlerId: reference(row.eventHandlerId, charge),
    stage: scalar(row.stage, charge),
    rank: scalar(row.rank, charge),
    mode: scalar(row.mode, charge),
    enabled: scalar(row.enabled, charge),
    supportedDeployment: scalar(row.supportedDeployment, charge),
    unfiltered: scalar(row.unfiltered, charge),
    filteringAttributes: attributes(row.filteringAttributes, charge),
    impersonatingUserId: reference(row.impersonatingUserId, charge),
    serviceEndpointId: reference(row.serviceEndpointId, charge),
    images,
  };
}
const evidence = (kind, id, row) => ({ kind, id, name: text(row.name), sourceFile: text(row.sourceFile) });

/** Compare importSolutionPlugins inventories by stable IDs; ambiguity stays explicit. No runtime or remote writes. */
export function comparePluginRegistrations(before, after) {
  if (!plain(before) || !plain(after)) throw new Error('Two parsed registration inventories are required.');
  const diagnostics = [],
    added = [],
    removed = [],
    changed = [],
    unchanged = { assemblies: 0, types: 0, steps: 0 };
  let count = 0;
  const charge = inspectionBudget(2000000, 'Registration comparison');
  for (const kind of ['assemblies', 'types', 'steps']) {
    const maps = [],
      ambiguous = new Set();
    for (const [side, inventory] of [
      ['before', before],
      ['after', after],
    ]) {
      const rows = inventory[kind] ?? [];
      if (!Array.isArray(rows) || (count += rows.length) > 20000)
        throw new Error('Registration comparison exceeds its record limit.');
      const map = new Map();
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index];
        if (!plain(row)) throw new Error('Registration records must be plain objects.');
        charge(typeof row.id === 'string' ? row.id.length : 1);
        const id = identity(row.id);
        if (!id) {
          diagnostics.push({ code: 'REGISTRATION_ID_UNRESOLVED', side, kind, index });
          continue;
        }
        if (map.has(id)) {
          ambiguous.add(id);
          diagnostics.push({ code: 'REGISTRATION_ID_AMBIGUOUS', side, kind, id });
        } else map.set(id, row);
      }
      maps.push(map);
    }
    const [left, right] = maps;
    for (const id of [...new Set([...left.keys(), ...right.keys()])].sort()) {
      if (ambiguous.has(id)) continue;
      const a = left.get(id),
        b = right.get(id);
      if (!a) {
        added.push({ ...evidence(kind, id, b), facts: facts(kind, b, charge) });
        continue;
      }
      if (!b) {
        removed.push({ ...evidence(kind, id, a), facts: facts(kind, a, charge) });
        continue;
      }
      const original = facts(kind, a, charge),
        next = facts(kind, b, charge);
      const fields = Object.keys(original)
        .filter((key) => !isDeepStrictEqual(original[key], next[key]))
        .map((field) => ({ field, before: original[field], after: next[field] }));
      if (fields.length) changed.push({ ...evidence(kind, id, b), beforeSourceFile: text(a.sourceFile), fields });
      else unchanged[kind]++;
    }
  }
  return { schemaVersion: 1, complete: diagnostics.length === 0, added, removed, changed, unchanged, diagnostics };
}
