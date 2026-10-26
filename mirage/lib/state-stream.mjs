import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Bound intermediate strings to one JSON scalar, rather than the document size.
// Chunk boundaries may fall inside UTF-8, escapes, numbers or property names.
export async function parseJsonStream(chunks) {
  // Most individual journal entries fit in a bounded native parse. Keep the
  // streaming fallback for documents larger than this fixed allocation budget.
  const iterator = chunks[Symbol.asyncIterator] ? chunks[Symbol.asyncIterator]() : chunks[Symbol.iterator]();
  const prefix = [];
  let length = 0;
  while (length <= 8 * 1024 * 1024) {
    const next = await iterator.next();
    if (next.done) return JSON.parse(prefix.join(''));
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
  return parseLargeJsonStream(remaining());
}

async function parseLargeJsonStream(chunks) {
  let root,
    hasRoot = false,
    token = '',
    quoted = false,
    escaped = false;
  const stack = [];
  const fail = () => {
    throw new SyntaxError('Invalid streamed state JSON');
  };
  const value = (item) => {
    const frame = stack.at(-1);
    if (!frame) {
      if (hasRoot) fail();
      root = item;
      hasRoot = true;
      return;
    }
    if (frame.array) {
      if (!['value', 'first'].includes(frame.next)) fail();
      frame.value.push(item);
      frame.next = 'comma';
    } else {
      if (frame.next !== 'value') fail();
      Object.defineProperty(frame.value, frame.key, {
        value: item,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      frame.next = 'comma';
    }
  };
  const scalar = () => {
    if (!token) return;
    const item = JSON.parse(token),
      frame = stack.at(-1);
    if (frame && !frame.array && ['key', 'first'].includes(frame.next)) {
      if (typeof item !== 'string') fail();
      frame.key = item;
      frame.next = 'colon';
    } else value(item);
    token = '';
  };
  for await (const chunk of chunks) {
    for (const char of String(chunk)) {
      if (quoted) {
        token += char;
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') {
          quoted = false;
          scalar();
        }
        continue;
      }
      if (char === '"') {
        if (token) fail();
        quoted = true;
        token = char;
        continue;
      }
      if (!/[\s{}[\],:]/.test(char)) {
        token += char;
        continue;
      }
      scalar();
      if (/\s/.test(char)) continue;
      const frame = stack.at(-1);
      if (char === '{' || char === '[') {
        const item = char === '[' ? [] : {};
        value(item);
        stack.push({ value: item, array: Array.isArray(item), next: 'first' });
      } else if (char === '}' || char === ']') {
        if (!frame || frame.array !== (char === ']') || !['first', 'comma'].includes(frame.next)) fail();
        stack.pop();
      } else if (char === ':') {
        if (!frame || frame.array || frame.next !== 'colon') fail();
        frame.next = 'value';
      } else {
        if (!frame || frame.next !== 'comma') fail();
        frame.next = frame.array ? 'value' : 'key';
      }
    }
  }
  if (quoted || stack.length) fail();
  scalar();
  if (!hasRoot) fail();
  return root;
}

// One generator with an explicit container stack: nested `yield*` would pass every token through each enclosing level,
// which made hashing and writing deep state the dominant cost of a simulation-level save.
export function* jsonChunks(value) {
  const ancestors = new Set(),
    stack = [];
  // A scalar's JSON text, or the opening bracket of a container pushed onto the stack.
  const enter = (item) => {
    if (typeof item?.toJSON === 'function') item = item.toJSON();
    if (item instanceof Number || item instanceof String || item instanceof Boolean) item = item.valueOf();
    if (item === null || typeof item !== 'object') return JSON.stringify(item) ?? 'null';
    if (ancestors.has(item)) throw new TypeError('Cannot persist circular state');
    ancestors.add(item);
    const list = Array.isArray(item);
    stack.push({ item, list, keys: list ? null : Object.keys(item), index: 0 });
    return list ? '[' : '{';
  };
  // Chunks end after the first token that reaches 64 KiB, so every token append is followed by this check.
  let chunk = '';
  for (let token = enter(value); ;) {
    chunk += token;
    if (chunk.length >= 65536) {
      yield chunk;
      chunk = '';
    }
    const frame = stack.at(-1);
    if (!frame) break;
    if (frame.list) {
      if (frame.index < frame.item.length) {
        if (frame.index) {
          chunk += ',';
          if (chunk.length >= 65536) {
            yield chunk;
            chunk = '';
          }
        }
        token = enter(frame.item[frame.index++]);
        continue;
      }
    } else {
      let key, item;
      while (frame.index < frame.keys.length) {
        key = frame.keys[frame.index++];
        item = frame.item[key];
        const type = typeof item;
        if (type !== 'undefined' && type !== 'function' && type !== 'symbol') break;
        key = undefined;
      }
      if (key !== undefined) {
        for (const part of frame.written ? [',', JSON.stringify(key), ':'] : [JSON.stringify(key), ':']) {
          chunk += part;
          if (chunk.length >= 65536) {
            yield chunk;
            chunk = '';
          }
        }
        frame.written = true;
        token = enter(item);
        continue;
      }
    }
    stack.pop();
    ancestors.delete(frame.item);
    token = frame.list ? ']' : '}';
  }
  if (chunk) yield chunk;
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

export function stateDigest(state) {
  const hash = createHash('sha256');
  for (const chunk of jsonChunks(state)) hash.update(chunk);
  return hash.digest('hex');
}
