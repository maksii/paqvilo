import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { pagedRecordsOf, rawRecordOf } from './record-tables.mjs';

// Common record/metadata leaves can use V8's encoder without allocating a whole
// document string. Inspect descriptors first so a fallback never reads a getter
// twice. Bound input first and check the native result against the remaining
// chunk budget; ordinary wide text need not pay a sixfold escape allowance.
function flatJsonKeys(item, budget) {
  let size = 2;
  const keys = Object.keys(item);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(item, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
    const value = descriptor.value;
    if ((value !== null && typeof value === 'object') || typeof value === 'bigint' || typeof value === 'function')
      return null;
    size += key.length + 4 + (typeof value === 'string' ? value.length + 2 : 32);
    if (size > budget) return null;
  }
  return keys;
}

function cachedShape(keys, shapes) {
  candidates: for (const entry of shapes.values()) {
    if (entry.keys.length !== keys.length) continue;
    for (let index = 0; index < keys.length; index++) if (entry.keys[index] !== keys[index]) continue candidates;
    return entry;
  }
  return null;
}

function createShape(keys, shapes) {
  const sorted = [...keys].sort((left, right) => Number(left > right) - Number(left < right));
  // Integer keys require lexical order rather than native numeric order.
  const numeric = sorted.some((key) => /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < 4294967295);
  const ordered = Object.create(null);
  for (const key of sorted) ordered[key] = null;
  const shape = { keys, sorted, numeric, ordered };
  if (shapes.size === 16) shapes.delete(shapes.keys().next().value);
  shapes.set(keys, shape);
  return shape;
}

function flatJson(item, budget, sortKeys, shapes) {
  if (budget < 256 || types.isProxy(item) || 'toJSON' in item) return null;
  const prototype = Object.getPrototypeOf(item);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = flatJsonKeys(item, budget);
  if (!keys) return null;
  if (!sortKeys) {
    const text = JSON.stringify(item);
    return text.length <= budget ? text : null;
  }
  const shape = cachedShape(keys, shapes) ?? createShape(keys, shapes);
  if (shape.numeric) {
    const text = JSON.stringify(item, shape.sorted);
    return text.length <= budget ? text : null;
  }
  // All descriptors were checked before any read. Reuse bounded scalar leaves
  // instead of allocating another ordered object for every persisted row.
  for (const key of keys) shape.ordered[key] = item[key];
  const text = JSON.stringify(shape.ordered);
  return text.length <= budget ? text : null;
}

// Bound intermediate strings to one JSON scalar, rather than the document size.
// Chunk boundaries may fall inside UTF-8, escapes, numbers or property names.
export async function parseJsonStream(chunks, { onObject } = {}) {
  // Most individual journal entries fit in a bounded native parse. Keep the
  // streaming fallback for documents larger than this fixed allocation budget.
  // `onObject` sees every completed object, children first: after a native
  // parse in document order, or while a larger document streams, so consumers
  // can coalesce immutable text before the rest of that document is resident.
  const iterator = chunks[Symbol.asyncIterator] ? chunks[Symbol.asyncIterator]() : chunks[Symbol.iterator]();
  const prefix = [];
  let length = 0;
  while (length <= 8 * 1024 * 1024) {
    const next = await iterator.next();
    if (next.done) {
      const value = JSON.parse(prefix.join(''));
      if (onObject) visitObjects(value, onObject);
      return value;
    }
    const chunk = String(next.value);
    prefix.push(chunk);
    length += chunk.length;
  }
  async function* remaining() {
    try {
      yield* prefix;
      while (true) {
        const next = await iterator.next();
        if (next.done) return;
        yield next.value;
      }
    } finally {
      await iterator.return?.();
    }
  }
  return parseLargeJsonStream(remaining(), onObject);
}

// Children before their parent, as the streaming parser completes them. An
// explicit stack keeps deeply nested documents off the call stack; arrays are
// walked by index rather than through a key list.
function visitObjects(root, onObject) {
  const enter = (value) => {
    const array = Array.isArray(value);
    return { value, array, keys: array ? null : Object.keys(value), length: array ? value.length : 0, index: 0 };
  };
  if (root === null || typeof root !== 'object') return;
  const stack = [enter(root)];
  while (stack.length) {
    const frame = stack.at(-1);
    if (frame.index < (frame.array ? frame.length : frame.keys.length)) {
      const item = frame.array ? frame.value[frame.index++] : frame.value[frame.keys[frame.index++]];
      if (item !== null && typeof item === 'object') stack.push(enter(item));
      continue;
    }
    stack.pop();
    if (!frame.array) onObject(frame.value);
  }
}

function streamedValue(item, state, fail) {
  const frame = state.stack.at(-1);
  if (!frame) {
    if (state.hasRoot) fail();
    state.root = item;
    state.hasRoot = true;
    return;
  }
  if (frame.array) {
    if (!['value', 'first'].includes(frame.next)) fail();
    frame.value.push(item);
    frame.next = 'comma';
    return;
  }
  if (frame.next !== 'value') fail();
  Object.defineProperty(frame.value, frame.key, {
    value: item,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  frame.next = 'comma';
}

function streamedScalar(state, fail) {
  if (!state.parts.length) return;
  const item = JSON.parse(state.parts.join('')),
    frame = state.stack.at(-1);
  if (frame && !frame.array && ['key', 'first'].includes(frame.next)) {
    if (typeof item !== 'string') fail();
    frame.key = item;
    frame.next = 'colon';
  } else streamedValue(item, state, fail);
  state.parts = [];
}

function consumeQuotedSegment(text, cursor, state, boundary) {
  const start = cursor;
  while (cursor < text.length) {
    if (state.escaped) {
      state.escaped = false;
      cursor++;
      continue;
    }
    boundary.lastIndex = cursor;
    const match = boundary.exec(text);
    if (!match) {
      cursor = text.length;
      break;
    }
    cursor = match.index + 1;
    if (match[0] === '\\') {
      if (cursor < text.length) cursor++;
      else state.escaped = true;
    } else {
      state.quoted = false;
      break;
    }
  }
  state.parts.push(text.slice(start, cursor));
  return cursor;
}

function openJsonContainer(char, state, fail) {
  const item = char === '[' ? [] : {};
  streamedValue(item, state, fail);
  state.stack.push({ value: item, array: Array.isArray(item), next: 'first' });
}

function closeJsonContainer(char, frame, state, onObject, fail) {
  if (frame?.array !== (char === ']') || !['first', 'comma'].includes(frame.next)) fail();
  if (!frame.array) onObject?.(frame.value);
  state.stack.pop();
}

function consumeJsonDelimiter(text, char, cursor, state, nonWhitespace, fail, onObject) {
  if (char === '"') {
    if (state.parts.length) fail();
    state.quoted = true;
    state.parts.push(char);
    return cursor;
  }
  streamedScalar(state, fail);
  if (char === ' ' || char === '\t' || char === '\r' || char === '\n') {
    nonWhitespace.lastIndex = cursor;
    return nonWhitespace.exec(text)?.index ?? text.length;
  }
  const frame = state.stack.at(-1);
  if (char === '{' || char === '[') openJsonContainer(char, state, fail);
  else if (char === '}' || char === ']') closeJsonContainer(char, frame, state, onObject, fail);
  else if (char === ':') {
    if (!frame || frame.array || frame.next !== 'colon') fail();
    frame.next = 'value';
  } else {
    if (frame?.next !== 'comma') fail();
    frame.next = frame.array ? 'value' : 'key';
  }
  return cursor;
}

function processJsonChunk(text, state, patterns, fail, onObject) {
  let cursor = 0;
  while (cursor < text.length) {
    if (state.quoted) {
      cursor = consumeQuotedSegment(text, cursor, state, patterns.quotedBoundary);
      if (!state.quoted) streamedScalar(state, fail);
      continue;
    }
    patterns.delimiter.lastIndex = cursor;
    const match = patterns.delimiter.exec(text),
      end = match?.index ?? text.length;
    if (end > cursor) state.parts.push(text.slice(cursor, end));
    cursor = end;
    if (!match) break;
    const char = text[cursor++];
    cursor = consumeJsonDelimiter(text, char, cursor, state, patterns.nonWhitespace, fail, onObject);
  }
}

async function parseLargeJsonStream(chunks, onObject) {
  const state = { hasRoot: false, parts: [], quoted: false, escaped: false, stack: [] };
  const fail = () => {
    throw new SyntaxError('Invalid streamed state JSON');
  };
  const patterns = {
    quotedBoundary: /["\\]/g,
    delimiter: /[ \t\r\n{}[\],:"]/g,
    nonWhitespace: /[^ \t\r\n]/g,
  };
  // Retain contiguous segments rather than allocating a cons string for every
  // character in source XML or a large row. Native parsing validates each scalar.
  for await (const chunk of chunks) processJsonChunk(String(chunk), state, patterns, fail, onObject);
  if (state.quoted || state.stack.length) fail();
  streamedScalar(state, fail);
  if (!state.hasRoot) fail();
  return state.root;
}

// One generator with an explicit container stack: nested `yield*` would pass every token through each enclosing level,
// which made hashing and writing deep state the dominant cost of a simulation-level save.
// JSON.stringify's member preparation: stored record views, toJSON(key) and boxed primitives.
function prepare(item, key) {
  item = rawRecordOf(item) ?? item;
  if (item !== null && (typeof item === 'object' || typeof item === 'function' || typeof item === 'bigint')) {
    const toJSON = item.toJSON;
    if (typeof toJSON === 'function') item = Reflect.apply(toJSON, item, [key]);
  }
  if (types.isNumberObject(item)) item = +item;
  else if (types.isStringObject(item)) item = String(item);
  else if (types.isBooleanObject(item)) item = Boolean.prototype.valueOf.call(item);
  else if (types.isBigIntObject(item)) item = BigInt.prototype.valueOf.call(item);
  return item;
}
const omitted = (item) => item === undefined || typeof item === 'function' || typeof item === 'symbol';

function* appendJsonParts(chunk, parts) {
  for (const part of parts) {
    chunk += part;
    if (chunk.length >= 65536) {
      yield chunk;
      chunk = '';
    }
  }
  return chunk;
}

function nextJsonArrayItem(frame) {
  const key = String(frame.index++),
    item = prepare(frame.records ? frame.records.raw(Number(key), { borrow: true }) : frame.item[key], key);
  return item;
}

function nextJsonObjectMember(frame) {
  while (frame.index < frame.keys.length) {
    const key = frame.keys[frame.index++],
      item = prepare(frame.item[key], key),
      type = typeof item;
    if (type !== 'undefined' && type !== 'function' && type !== 'symbol') return { key, item };
  }
  return null;
}

function jsonMemberParts(frame, key) {
  return frame.written ? [',', JSON.stringify(key), ':'] : [JSON.stringify(key), ':'];
}

function jsonObjectKeys(item, sortKeys) {
  return sortKeys
    ? Object.keys(item).sort((left, right) => Number(left > right) - Number(left < right))
    : Object.keys(item);
}

function closeJsonFrame(frame, stack, ancestors) {
  stack.pop();
  ancestors.delete(frame.item);
  return frame.list ? ']' : '}';
}

function enterJsonItem(item, { recordVersions, project, chunkLength, sortKeys, shapes, ancestors, stack }) {
  // Private comparison receipts use an impossible JSON token. A user-authored
  // marker-shaped object/string cannot collide with a record-table version.
  if (recordVersions) {
    const table = pagedRecordsOf(item);
    if (table) return '\u0000record-version:' + table.fingerprint() + '\u0000';
  }
  if (project) item = project(item);
  if (item === null || typeof item !== 'object') return JSON.stringify(item) ?? 'null';
  if (JSON.isRawJSON?.(item)) return JSON.stringify(item);
  const flat = flatJson(item, Math.min(16384, 65536 - chunkLength), sortKeys, shapes);
  if (flat !== null) return flat;
  if (ancestors.has(item)) throw new TypeError('Cannot persist circular state');
  ancestors.add(item);
  const list = Array.isArray(item);
  const keys = list ? null : jsonObjectKeys(item, sortKeys);
  stack.push({
    item,
    list,
    length: list ? item.length : undefined,
    records: list ? pagedRecordsOf(item) : null,
    keys: list ? null : keys,
    index: 0,
  });
  return list ? '[' : '{';
}

// `prepared` marks a value that prepare() already produced; it is not prepared twice.
/* NOSONAR */ export function* jsonChunks(
  value,
  { sortKeys = false, project, recordVersions = false, prepared = false } = {},
) {
  const ancestors = new Set(),
    stack = [],
    shapes = sortKeys ? new Map() : null;
  // Chunks end after the first token that reaches 64 KiB, so every token append is followed by this check.
  let chunk = '';
  if (!prepared) value = prepare(value, '');
  if (omitted(value)) return;
  let token = enterJsonItem(value, {
    recordVersions,
    project,
    chunkLength: chunk.length,
    sortKeys,
    shapes,
    ancestors,
    stack,
  });
  for (;;) {
    chunk = yield* appendJsonParts(chunk, [token]);
    const frame = stack.at(-1);
    if (!frame) break;
    if (frame.list && frame.index < frame.length) {
      if (frame.index) chunk = yield* appendJsonParts(chunk, [',']);
      token = enterJsonItem(nextJsonArrayItem(frame), {
        recordVersions,
        project,
        chunkLength: chunk.length,
        sortKeys,
        shapes,
        ancestors,
        stack,
      });
      continue;
    }
    if (!frame.list) {
      const next = nextJsonObjectMember(frame);
      if (next) {
        chunk = yield* appendJsonParts(chunk, jsonMemberParts(frame, next.key));
        frame.written = true;
        token = enterJsonItem(next.item, {
          recordVersions,
          project,
          chunkLength: chunk.length,
          sortKeys,
          shapes,
          ancestors,
          stack,
        });
        continue;
      }
    }
    token = closeJsonFrame(frame, stack, ancestors);
  }
  if (chunk) yield chunk;
}

// Fragment records of one large JSON value. Each line is itself JSON, so values
// are embedded as JSON text (never escaped into a string) and parse natively:
//   ["v",key,value]  a complete member: object key string, or null in an array
//   ["o",key] / ["a",key]  open an object or array member; ["c"] closes it
//   ["r",key], then ">"-prefixed JSON text lines, then ["e"]  one member too
//     large to split (a long string or a stored record table), as JSON text
// The root object itself is implicit: its members follow without an "o".
const FRAGMENT_VALUE_BUDGET = 1024 * 1024;
const splittable = (item) =>
  item !== null &&
  typeof item === 'object' &&
  !types.isProxy(item) &&
  !JSON.isRawJSON?.(item) &&
  (Array.isArray(item) || [Object.prototype, null].includes(Object.getPrototypeOf(item)));
function boundedJson(item, budget) {
  let text = '';
  for (const chunk of jsonChunks(item, { prepared: true })) {
    text += chunk;
    if (text.length > budget) return null;
  }
  return text;
}

function addValueFragment(record, onObject, attach) {
  if (record[0] !== 'v' || record.length !== 3) return false;
  const value = record[2];
  if (onObject && value !== null && typeof value === 'object') visitObjects(value, onObject);
  attach(record[1], value);
  return true;
}

function addContainerFragment(record, state, attach) {
  if ((record[0] !== 'o' && record[0] !== 'a') || record.length !== 2) return false;
  const container = record[0] === 'a' ? [] : {};
  attach(record[1], container);
  state.stack.push({ value: container, list: record[0] === 'a' });
  return true;
}

function addCloseFragment(record, state, onObject) {
  if (record[0] !== 'c' || record.length !== 1 || state.stack.length <= 1) return false;
  const closed = state.stack.pop();
  if (!closed.list) onObject?.(closed.value);
  return true;
}

function addRawFragment(record, state, invalid) {
  if (record[0] !== 'r' || record.length !== 2) return false;
  const key = record[1];
  if (key !== null && typeof key !== 'string') throw invalid();
  state.raw = { key, parts: [] };
  return true;
}

function addNormalFragment(record, state, onObject, attach, invalid) {
  if (addValueFragment(record, onObject, attach)) return;
  if (addContainerFragment(record, state, attach)) return;
  if (addCloseFragment(record, state, onObject)) return;
  if (addRawFragment(record, state, invalid)) return;
  throw invalid();
}

function nextFragmentMember(top) {
  if (top.list) {
    if (top.index >= top.length) return null;
    const key = String(top.index++);
    let item = prepare(top.item[key], key);
    if (omitted(item)) item = null;
    return { label: 'null', item };
  }
  while (top.index < top.keys.length) {
    const key = top.keys[top.index++],
      item = prepare(top.item[key], key);
    if (omitted(item)) continue;
    return { label: JSON.stringify(key), item };
  }
  return null;
}

function* emitFragmentMember({ label, item }, { budget, ancestors, stack, frame }) {
  if (splittable(item) && ancestors.has(item)) throw new TypeError('Cannot persist circular state');
  const text = boundedJson(item, budget);
  if (text !== null) {
    yield `["v",${label},${text}]`;
    return;
  }
  if (splittable(item)) {
    ancestors.add(item);
    stack.push(frame(item));
    yield `["${Array.isArray(item) ? 'a' : 'o'}",${label}]`;
    return;
  }
  yield `["r",${label}]`;
  for (const chunk of jsonChunks(item, { prepared: true })) yield '>' + chunk;
  yield '["e"]';
}

export function* jsonFragmentRecords(value, { budget = FRAGMENT_VALUE_BUDGET } = {}) {
  const root = prepare(value, '');
  if (!splittable(root) || Array.isArray(root)) throw new TypeError('Fragment records require an object root');
  const ancestors = new Set([root]);
  const frame = (item) => ({
    item,
    list: Array.isArray(item),
    keys: Array.isArray(item) ? null : Object.keys(item),
    length: item.length,
    index: 0,
  });
  const stack = [frame(root)];
  while (stack.length) {
    const top = stack.at(-1);
    const member = nextFragmentMember(top);
    if (!member) {
      stack.pop();
      ancestors.delete(top.item);
      if (stack.length) yield '["c"]';
      continue;
    }
    yield* emitFragmentMember(member, { budget, ancestors, stack, frame });
  }
}

/** Rebuild the value of jsonFragmentRecords() line by line. `onObject` sees
 * every completed object, children first, as parseJsonStream() reports them. */
export function createFragmentAssembler(onObject) {
  const root = {},
    stack = [{ value: root, list: false }],
    invalid = () => new SyntaxError('Invalid state JSON fragment record');
  const state = { stack, raw: null };
  const attach = (key, value) => {
    const top = stack.at(-1);
    if (top.list) {
      if (key !== null) throw invalid();
      top.value.push(value);
    } else {
      if (typeof key !== 'string') throw invalid();
      Object.defineProperty(top.value, key, { value, enumerable: true, configurable: true, writable: true });
    }
  };
  return {
    root,
    /** The root's members so far, while it is the open container. */
    get rootOpen() {
      return stack.length === 1 && state.raw === null;
    },
    async add(line) {
      if (state.raw !== null && line[0] === '>') {
        state.raw.parts.push(line.slice(1));
        return;
      }
      const record = JSON.parse(line);
      if (!Array.isArray(record)) throw invalid();
      if (state.raw !== null) {
        if (record[0] !== 'e' || record.length !== 1) throw invalid();
        const parsed = await parseJsonStream(state.raw.parts, { onObject });
        const target = state.raw.key;
        state.raw = null;
        attach(target, parsed);
      } else addNormalFragment(record, state, onObject, attach, invalid);
    },
    finish() {
      if (state.raw !== null || stack.length !== 1) throw invalid();
      onObject?.(root);
      return root;
    },
  };
}

export async function writeJsonStream(file, state, { stopAtBytes = Infinity } = {}) {
  const handle = await open(file, 'wx', 0o600),
    hash = createHash('sha256');
  let bytes = 0;
  try {
    for (const chunk of jsonChunks(state)) {
      hash.update(chunk);
      bytes += Buffer.byteLength(chunk);
      await handle.writeFile(chunk);
      if (bytes >= stopAtBytes) return { bytes, thresholdReached: true };
    }
    hash.update('\n');
    bytes++;
    await handle.writeFile('\n');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { digest: hash.digest('hex'), bytes };
}

export async function hashStateFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export function stateDigest(state, options) {
  const hash = createHash('sha256');
  for (const chunk of jsonChunks(state, options)) hash.update(chunk);
  return hash.digest('hex');
}
