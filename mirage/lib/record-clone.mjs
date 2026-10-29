import { types } from 'node:util';
import { pagedRecordsOf, rawRecordOf, recordTablesCreated } from './record-tables.mjs';
import { isDeepStrictEqual } from 'node:util';
const recordVersion = Symbol('record version');

export function hasRecordGraph(value) {
  if (!recordTablesCreated) return false;
  const pending = [value],
    seen = new WeakSet();
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== 'object' || seen.has(item)) continue;
    if (pagedRecordsOf(item) || rawRecordOf(item)) return true;
    if (types.isProxy(item)) continue;
    seen.add(item);
    // State tables are the common large case; inspect them before metadata.
    const tables = Object.getOwnPropertyDescriptor(item, 'tables')?.value;
    if (tables && typeof tables === 'object' && !types.isProxy(tables))
      for (const key of Object.keys(tables))
        if (pagedRecordsOf(Object.getOwnPropertyDescriptor(tables, key)?.value)) return true;
    if (types.isMap(item)) {
      for (const [key, value] of item) pending.push(key, value);
    } else if (types.isSet(item)) {
      for (const value of item) pending.push(value);
    } else
      for (const key of Object.keys(item)) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (
          descriptor &&
          Object.hasOwn(descriptor, 'value') &&
          descriptor.value &&
          typeof descriptor.value === 'object'
        )
          pending.push(descriptor.value);
      }
  }
  return false;
}

// Internal state copies fork immutable pages. Public values remain ordinary
// structured-clone data, including array holes, aliases, cycles and native types.
export function cloneRecordGraph(value, { forkTables = false, recordVersions = false } = {}) {
  const memo = new Map(),
    frames = [];
  const define = (target, key, item) =>
    Object.defineProperty(target, key, { value: item, enumerable: true, configurable: true, writable: true });
  const make = (source) => {
    if (source === null || typeof source !== 'object')
      return typeof source === 'function' || typeof source === 'symbol' ? structuredClone(source) : source;
    if (memo.has(source)) return memo.get(source);
    const paged = pagedRecordsOf(source);
    if (paged && recordVersions) {
      const version = { [recordVersion]: paged.fingerprint() };
      memo.set(source, version);
      return version;
    }
    if (paged && forkTables) {
      const target = paged.fork();
      memo.set(source, target);
      return target;
    }
    const raw = rawRecordOf(source);
    if (raw) {
      const target = make(raw);
      memo.set(source, target);
      return target;
    }
    if (paged) {
      const target = new Array(paged.length),
        rows = new Map();
      memo.set(source, target);
      frames.push({
        next: 0,
        run() {
          if (this.next === paged.length) return false;
          const index = this.next++,
            id = paged.id(index);
          if (id) {
            let row = rows.get(id);
            if (!row) {
              row = make(paged.raw(index, { borrow: true }));
              rows.set(id, row);
            }
            define(target, index, row);
          }
          return true;
        },
      });
      return target;
    }
    if (types.isProxy(source)) return structuredClone(source);
    if (types.isMap(source) || types.isSet(source)) {
      const map = types.isMap(source),
        target = map ? new Map() : new Set();
      memo.set(source, target);
      const iterator = map ? source.entries() : source.values();
      frames.push({
        run() {
          const next = iterator.next();
          if (next.done) return false;
          if (map) target.set(make(next.value[0]), make(next.value[1]));
          else target.add(make(next.value));
          return true;
        },
      });
      return target;
    }
    if (ArrayBuffer.isView(source)) {
      const native = structuredClone(source),
        buffer = make(source.buffer);
      const target = types.isDataView(source)
        ? new DataView(buffer, source.byteOffset, source.byteLength)
        : new native.constructor(buffer, source.byteOffset, source.length);
      memo.set(source, target);
      return target;
    }
    if (
      types.isAnyArrayBuffer(source) ||
      types.isDate(source) ||
      types.isRegExp(source) ||
      types.isBoxedPrimitive(source) ||
      types.isNativeError(source) ||
      types.isWeakMap(source) ||
      types.isWeakSet(source) ||
      types.isPromise(source) ||
      types.isKeyObject(source) ||
      types.isCryptoKey(source) ||
      source instanceof URL ||
      source instanceof URLSearchParams ||
      source instanceof WeakRef ||
      source instanceof FinalizationRegistry ||
      (typeof Blob !== 'undefined' && source instanceof Blob) ||
      JSON.isRawJSON?.(source)
    ) {
      const target = structuredClone(source);
      memo.set(source, target);
      return target;
    }
    const target = Array.isArray(source) ? new Array(source.length) : {};
    memo.set(source, target);
    const keys = Object.keys(source);
    frames.push({
      next: 0,
      run() {
        if (this.next === keys.length) return false;
        const key = keys[this.next++];
        define(target, key, make(source[key]));
        return true;
      },
    });
    return target;
  };
  const result = make(value);
  while (frames.length) {
    const frame = frames.at(-1);
    if (!frame.run()) frames.pop();
  }
  return result;
}

export function privateRecordEqual(left, right) {
  if (!hasRecordGraph(left) && !hasRecordGraph(right)) return isDeepStrictEqual(left, right);
  const project = (value) => {
    const memo = new Map(),
      frames = [];
    const make = (source) => {
      if (!source || typeof source !== 'object' || !hasRecordGraph(source)) return source;
      if (memo.has(source)) return memo.get(source);
      const table = pagedRecordsOf(source);
      if (table) {
        const version = { [recordVersion]: table.fingerprint() };
        memo.set(source, version);
        return version;
      }
      const prototype = Object.getPrototypeOf(source);
      if (types.isProxy(source) || (!Array.isArray(source) && prototype !== Object.prototype && prototype !== null))
        return cloneRecordGraph(source, { recordVersions: true });
      const target = Array.isArray(source) ? new Array(source.length) : Object.create(prototype);
      memo.set(source, target);
      frames.push({
        source,
        target,
        keys: Reflect.ownKeys(source).filter((key) => Object.prototype.propertyIsEnumerable.call(source, key)),
        index: 0,
      });
      return target;
    };
    const result = make(value);
    while (frames.length) {
      const frame = frames.at(-1);
      if (frame.index === frame.keys.length) {
        frames.pop();
        continue;
      }
      const key = frame.keys[frame.index++];
      Object.defineProperty(frame.target, key, {
        value: make(frame.source[key]),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  };
  return isDeepStrictEqual(project(left), project(right));
}
