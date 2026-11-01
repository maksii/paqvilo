import { types } from 'node:util';
import { pagedRecordsOf, recordTablesCreated } from './record-tables.mjs';
import { cloneRecordGraph } from './record-clone.mjs';

const BULK_ROWS = 100000;
const MEMO_PARTITION_LIMIT = 4000000;
const own = (value, name) => Object.prototype.hasOwnProperty.call(value, name);

/** Wide heterogeneous metadata maps need dictionary storage without changing
 * their public Object prototype or the data-property semantics of object spread.
 * Starting with null-prototype storage avoids a separate descriptor transition
 * chain for every table's distinct primary-key column. */
export function plainDataObject(...sources) {
  const result = Object.setPrototypeOf(Object.create(null), Object.prototype),
    property = { value: undefined, writable: true, enumerable: true, configurable: true };
  for (const source of sources) {
    if (source == null) continue;
    for (const key of Reflect.ownKeys(Object(source))) {
      if (!Object.getOwnPropertyDescriptor(source, key)?.enumerable) continue;
      property.value = source[key];
      Object.defineProperty(result, key, property);
    }
  }
  return result;
}
const descriptorValue = (value, key) => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && own(descriptor, 'value') ? descriptor.value : undefined;
};

const bulkRows = (value) => {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return false;
  if (Array.isArray(value)) return value.length >= BULK_ROWS;
  const tables = descriptorValue(value, 'tables') ?? value;
  if (!tables || typeof tables !== 'object' || types.isProxy(tables)) return false;
  let count = 0;
  for (const key of Object.keys(tables)) {
    const rows = descriptorValue(tables, key);
    if (!Array.isArray(rows) || types.isProxy(rows)) return false;
    count += rows.length;
  }
  return count >= BULK_ROWS;
};
const bulkMetadata = (value) => {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return false;
  const entities = descriptorValue(value, 'mappings') ?? descriptorValue(value, 'tables') ?? value;
  if (!entities || typeof entities !== 'object' || types.isProxy(entities)) return false;
  let fields = 0;
  for (const key of Object.keys(entities)) {
    const table = descriptorValue(entities, key);
    if (!table || typeof table !== 'object' || types.isProxy(table)) continue;
    for (const section of ['fields', 'fieldMetadata', 'attributes', 'relationships']) {
      const values = descriptorValue(table, section);
      if (values && typeof values === 'object' && !types.isProxy(values)) fields += Object.keys(values).length;
    }
    if (fields >= BULK_ROWS) return true;
  }
  return false;
};

const bulkSourceComponents = (value) => {
  const member = (object, key) =>
    object && typeof object === 'object' && !types.isProxy(object) ? descriptorValue(object, key) : undefined;
  const dataverse = member(value, 'dataverse') ?? value;
  const components = member(dataverse, 'sourceSolutionComponents');
  const baseline = member(components, 'baseline');
  return baseline && typeof baseline === 'object' && !types.isProxy(baseline) && Object.keys(baseline).length >= 1000;
};

// Assignment is safe for ordinary keys. Inherited setters/read-only properties
// require CreateDataProperty semantics, including customized array prototypes.
function guardedKeys() {
  const blocked = new Set();
  for (const base of [Object.prototype, Array.prototype]) {
    for (let current = base; current; current = Object.getPrototypeOf(current)) {
      if (types.isProxy(current)) return null;
      for (const key of Object.getOwnPropertyNames(current)) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!own(descriptor, 'value') || !descriptor.writable) blocked.add(key);
      }
    }
  }
  return blocked;
}

/** Copy ordinary data graphs without a complete serialization buffer. Aliases,
 * cycles, sparse arrays and native data-property semantics remain intact.
 * Special types/accessors/proxies use structuredClone without invoking a getter
 * first. Memo partitions also avoid one collection's entry limit at high volume. */
export function copyPlainGraph(value) {
  if (value === null || typeof value !== 'object')
    return typeof value === 'function' || typeof value === 'symbol' ? structuredClone(value) : value;
  const blocked = guardedKeys();
  if (!blocked) return structuredClone(value);
  const notPlain = Symbol('native clone required');
  let memos = Object.create(null),
    top = null,
    result;
  const property = { value: undefined, enumerable: true, writable: true, configurable: true };
  const make = (source) => {
    if (types.isProxy(source) || JSON.isRawJSON?.(source)) throw notPlain;
    const array = Array.isArray(source),
      prototype = Object.getPrototypeOf(source);
    if (!array && prototype !== Object.prototype && prototype !== null) throw notPlain;
    const keys = Object.keys(source);
    let bucket = 0;
    const sample = keys.length ? descriptorValue(source, keys[0]) : undefined;
    if (typeof sample === 'string')
      for (let i = 0; i < Math.min(64, sample.length); i++) bucket = (bucket * 31 + sample.charCodeAt(i)) & 255;
    else if (typeof sample === 'number') bucket = sample & 255;
    for (let memo = memos[bucket]; memo; memo = memo.previous) {
      const target = memo.values.get(source);
      if (target !== undefined) return target;
    }
    if (!memos[bucket] || memos[bucket].count >= MEMO_PARTITION_LIMIT)
      memos[bucket] = { values: new Map(), count: 0, previous: memos[bucket] ?? null };
    const target = array ? new Array(source.length) : {};
    memos[bucket].values.set(source, target);
    memos[bucket].count++;
    top = { source, target, keys, index: 0, parent: top };
    return target;
  };
  try {
    result = make(value);
    while (top) {
      const frame = top;
      if (frame.index === frame.keys.length) {
        top = frame.parent;
        continue;
      }
      const key = frame.keys[frame.index++],
        descriptor = Object.getOwnPropertyDescriptor(frame.source, key);
      if (!descriptor || !own(descriptor, 'value')) throw notPlain;
      const item = descriptor.value;
      if (typeof item === 'function' || typeof item === 'symbol') throw notPlain;
      const copied = item !== null && typeof item === 'object' ? make(item) : item;
      if (blocked.has(key)) {
        property.value = copied;
        Object.defineProperty(frame.target, key, property);
      } else frame.target[key] = copied;
    }
    return result;
  } catch (error) {
    if (error !== notPlain) throw error;
    memos = null;
    top = null;
    property.value = undefined;
    return structuredClone(value);
  }
}

// Runtime state keeps paged tables in `tables`; checking those members is not a graph walk.
const stateTables = (value) => {
  const tables =
    value && typeof value === 'object' && !types.isProxy(value) ? descriptorValue(value, 'tables') : undefined;
  if (!tables || typeof tables !== 'object' || types.isProxy(tables)) return false;
  for (const key of Object.keys(tables)) if (pagedRecordsOf(descriptorValue(tables, key))) return true;
  return false;
};

// Native cloning is fast for small values. Large JSON state/metadata needs no
// duplicated scalar strings or deserialized wire buffer. Record proxies are not
// structured-cloneable: a graph holding one elsewhere is detected by that clone
// failing, and is then copied by the record-aware cloner (which reports every
// other unsupported value with the same DataCloneError).
export const cloneStateData = (value, options) => {
  if (recordTablesCreated && (pagedRecordsOf(value) || stateTables(value))) return cloneRecordGraph(value, options);
  try {
    return bulkRows(value) || bulkMetadata(value) || bulkSourceComponents(value)
      ? copyPlainGraph(value)
      : structuredClone(value);
  } catch (error) {
    if (!recordTablesCreated || error?.name !== 'DataCloneError') throw error;
    return cloneRecordGraph(value, options);
  }
};
