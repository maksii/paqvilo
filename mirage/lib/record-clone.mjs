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

// The general comparison: native deep equality, or the same comparison over
// copies in which every paged table is replaced by its content fingerprint.
function projectedEqual(left, right) {
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

const PENDING = 2,
  GENERAL = 3,
  MAX_DEPTH = 1000;
const { hasOwnProperty } = Object.prototype;
const keysOf = Object.keys,
  symbolsOf = Object.getOwnPropertySymbols,
  prototypeOf = Object.getPrototypeOf;
// true for an ordinary array, false for an ordinary object, otherwise undefined.
const ordinaryKind = (value, prototype) =>
  prototype === Object.prototype || prototype === null
    ? false
    : prototype === Array.prototype && Array.isArray(value)
      ? true
      : undefined;
// With these built-in values, a constructor or tag comparison of ordinary
// objects and arrays is exactly a prototype comparison.
const ordinaryPrototypes = () =>
  Object.prototype.constructor === Object &&
  Array.prototype.constructor === Array &&
  Object.prototype[Symbol.toStringTag] === undefined &&
  Array.prototype[Symbol.toStringTag] === undefined;

/** One resumable pass. Ordinary objects and arrays (Object.prototype, null or
 * Array.prototype, ordered string keys, no symbols, no own `constructor`) are
 * compared here with isDeepStrictEqual's rules; paged tables compare by content
 * fingerprint and record facades by their raw value. Any other pair is compared
 * by isDeepStrictEqual when its subtree holds no records, ancestors or shared
 * objects; otherwise, and for very deep or cyclic graphs, the whole comparison
 * falls back to projectedEqual. `symbolFreeRight` states that every ordinary
 * object on the right was created by a copy that never defines symbol keys. */
class Comparison {
  constructor(left, right, { symbolFreeRight = false } = {}) {
    this.left = left;
    this.right = right;
    this.symbolFreeRight = symbolFreeRight;
    this.as = [];
    this.bs = [];
    this.keys = [];
    this.next = [];
    this.top = -1;
    this.visited = 0;
    this.started = false;
    this.result = undefined;
  }
  // 1 equal, 0 different, PENDING frame pushed, GENERAL fall back.
  pair(a, b) {
    if (a === b) return a !== 0 || Object.is(a, b) ? 1 : 0;
    if (typeof a !== 'object' || typeof b !== 'object') return typeof a === 'number' && a !== a && b !== b ? 1 : 0;
    if (a === null || b === null) return 0;
    this.visited++;
    if (types.isProxy(a) || types.isProxy(b)) {
      const tableA = pagedRecordsOf(a),
        tableB = pagedRecordsOf(b);
      if (tableA || tableB) return tableA && tableB && tableA.fingerprint() === tableB.fingerprint() ? 1 : 0;
      const rawA = rawRecordOf(a),
        rawB = rawRecordOf(b);
      if (rawA || rawB) return this.pair(rawA ?? a, rawB ?? b);
      return this.delegate(a, b);
    }
    const prototype = prototypeOf(a),
      other = prototypeOf(b),
      array = ordinaryKind(a, prototype);
    if (array === undefined || ordinaryKind(b, other) === undefined) return this.delegate(a, b);
    if (hasOwnProperty.call(a, 'constructor') || hasOwnProperty.call(b, 'constructor')) return this.delegate(a, b);
    if (other !== prototype) return 0;
    if (symbolsOf(a).length || (!this.symbolFreeRight && symbolsOf(b).length)) return this.delegate(a, b);
    let keys = null;
    if (array) {
      if (a.length !== b.length) return 0;
      // Non-index keys or holes use the exact array key comparison.
      if (keysOf(a).length !== a.length || keysOf(b).length !== b.length) return this.delegate(a, b);
      if (!a.length) return 1;
    } else {
      keys = keysOf(a);
      const others = keysOf(b);
      if (keys.length !== others.length) return 0;
      for (let i = 0; i < keys.length; i++) if (keys[i] !== others[i]) return this.delegate(a, b);
      if (!keys.length) return 1;
    }
    if (this.top + 1 >= MAX_DEPTH) return GENERAL;
    const top = ++this.top;
    this.as[top] = a;
    this.bs[top] = b;
    this.keys[top] = keys;
    this.next[top] = 0;
    return PENDING;
  }
  delegate(a, b) {
    return this.isolated(a) && this.isolated(b) ? (isDeepStrictEqual(a, b) ? 1 : 0) : GENERAL;
  }
  // A delegated subtree must hold no record, no current ancestor and no object twice.
  isolated(value) {
    const ancestors = new Set(),
      seen = new Set(),
      pending = [value];
    for (let top = 0; top <= this.top; top++) ancestors.add(this.as[top]).add(this.bs[top]);
    while (pending.length) {
      const item = pending.pop();
      if (!item || typeof item !== 'object') continue;
      if (seen.has(item) || ancestors.has(item) || pagedRecordsOf(item) || rawRecordOf(item)) return false;
      seen.add(item);
      if (types.isProxy(item)) continue;
      if (types.isMap(item)) for (const [key, entry] of item) pending.push(key, entry);
      else if (types.isSet(item)) for (const entry of item) pending.push(entry);
      else
        for (const key of keysOf(item)) {
          const descriptor = Object.getOwnPropertyDescriptor(item, key);
          if (descriptor && Object.hasOwn(descriptor, 'value')) pending.push(descriptor.value);
        }
    }
    return true;
  }
  finish(outcome) {
    this.as.length = this.bs.length = this.keys.length = this.next.length = 0;
    this.top = -1;
    this.result = outcome === GENERAL ? projectedEqual(this.left, this.right) : outcome === 1;
    return this.result;
  }
  /** Compare until `budget` more objects have been visited; undefined while unfinished. */
  run(budget) {
    if (this.result !== undefined) return this.result;
    if (!this.started) {
      this.started = true;
      if (!ordinaryPrototypes()) return this.finish(GENERAL);
      const outcome = this.pair(this.left, this.right);
      if (outcome !== PENDING) return this.finish(outcome);
    }
    const limit = this.visited + budget;
    while (this.top >= 0) {
      if (this.visited >= limit) return undefined;
      const top = this.top,
        a = this.as[top],
        b = this.bs[top],
        keys = this.keys[top],
        index = this.next[top];
      let outcome;
      if (keys) {
        if (index === keys.length) {
          this.top--;
          continue;
        }
        this.next[top] = index + 1;
        outcome = this.pair(a[keys[index]], b[keys[index]]);
      } else {
        if (index === a.length) {
          this.top--;
          continue;
        }
        this.next[top] = index + 1;
        const x = a[index],
          y = b[index];
        if (
          (x === undefined && !hasOwnProperty.call(a, index)) ||
          (y === undefined && !hasOwnProperty.call(b, index))
        ) {
          this.top--;
          outcome = this.delegate(a, b);
        } else outcome = this.pair(x, y);
      }
      if (outcome === 0 || outcome === GENERAL) return this.finish(outcome);
    }
    return this.finish(1);
  }
}

/** isDeepStrictEqual, except that paged tables compare by their immutable
 * content fingerprint and record facades by their raw JSON value. */
export function privateRecordEqual(left, right, options) {
  return new Comparison(left, right, options).run(Infinity);
}

/** The same comparison, yielding to the event loop after each `quantum` visited
 * objects. `stats.visited` and `stats.pauses` accumulate the work performed. */
export async function privateRecordEqualAsync(
  left,
  right,
  { quantum = 8192, pause = () => new Promise((resolve) => setImmediate(resolve)), stats, ...options } = {},
) {
  if (!Number.isSafeInteger(quantum) || quantum < 1) throw TypeError('Invalid comparison quantum');
  const comparison = new Comparison(left, right, options);
  try {
    for (;;) {
      const result = comparison.run(quantum);
      if (result !== undefined) return result;
      if (stats) stats.pauses = (stats.pauses ?? 0) + 1;
      await pause();
    }
  } finally {
    if (stats) stats.visited = (stats.visited ?? 0) + comparison.visited;
  }
}
