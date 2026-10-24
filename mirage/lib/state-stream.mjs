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

function* tokens(value, ancestors = new Set(), array = false) {
  if (typeof value?.toJSON === 'function') value = value.toJSON();
  if (value instanceof Number || value instanceof String || value instanceof Boolean) value = value.valueOf();
  if (value === null || typeof value !== 'object') {
    yield JSON.stringify(value) ?? (array ? 'null' : 'null');
    return;
  }
  if (ancestors.has(value)) throw new TypeError('Cannot persist circular state');
  ancestors.add(value);
  const list = Array.isArray(value);
  yield list ? '[' : '{';
  let first = true;
  if (list) {
    for (const item of value) {
      if (!first) yield ',';
      first = false;
      yield* tokens(item, ancestors, true);
    }
  } else {
    for (const key of Object.keys(value)) {
      const item = value[key];
      if (['undefined', 'function', 'symbol'].includes(typeof item)) continue;
      if (!first) yield ',';
      first = false;
      yield JSON.stringify(key);
      yield ':';
      yield* tokens(item, ancestors);
    }
  }
  yield list ? ']' : '}';
  ancestors.delete(value);
}

export function* jsonChunks(value) {
  let chunk = '';
  for (const token of tokens(value)) {
    chunk += token;
    if (chunk.length >= 65536) {
      yield chunk;
      chunk = '';
    }
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
