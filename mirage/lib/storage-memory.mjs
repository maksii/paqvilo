// In-memory storage provider: the default for runtimes without a state directory (dry-run and in-memory runtimes), so the
// storage routes are always ready. Bytes live in this process only and are lost on restart. It passes the shared contract
// suite (mirage/testing/storage-contract.mjs). See mirage/docs/storage-providers.md.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ProviderError, STORAGE_OPERATIONS } from './storage-provider.mjs';
import { clockFunction, systemClock, systemIds } from './runtime-clock.mjs';

/** createMemoryStorage({ id, clock, ids }): clock is a function or { now() } in epoch milliseconds; ids is accepted for the
 * provider-factory shape (etags are a per-provider sequence). */
export function createMemoryStorage({ id = 'memory', clock = systemClock, ids = systemIds } = {}) {
  void ids; // NOSONAR: void is intentional here
  const now = clockFunction(clock);
  const objects = new Map(),
    staged = new Map(),
    secret = randomBytes(16);
  let sequence = 0,
    closed = false;
  const fail = (code, message) => new ProviderError(code, message, { provider: id });
  const alive = () => {
    if (closed) throw fail('Unavailable', `Storage provider '${id}' is closed.`);
  };
  const sign = (key, se, sp) => createHmac('sha256', secret).update(`${key}\n${se}\n${sp}`).digest('base64url');
  const meta = (key, o) => ({
    key,
    size: o.bytes.length,
    sha256: o.sha256,
    etag: o.etag,
    version: o.version,
    lastModified: o.lastModified,
    contentType: o.contentType,
    metadata: { ...o.metadata },
  });
  // A Buffer, Uint8Array or string is one chunk; any other body is an AsyncIterable of chunks.
  const collect = async (body) => {
    if (typeof body === 'string' || body instanceof Uint8Array) return Buffer.from(body);
    const parts = [];
    for await (const chunk of body) parts.push(Buffer.from(chunk)); // copies: the caller may reuse its buffer
    return Buffer.concat(parts);
  };
  const conditions = (current, { ifMatch, ifNoneMatch } = {}) => {
    if (ifMatch !== undefined && (!current || (ifMatch !== '*' && ifMatch !== current.etag)))
      throw fail('PreconditionFailed', 'The If-Match condition does not hold.');
    if (ifNoneMatch === '*' && current) throw fail('Conflict', 'The object already exists.');
    if (ifNoneMatch !== undefined && ifNoneMatch !== '*' && current?.etag === ifNoneMatch)
      throw fail('PreconditionFailed', 'The If-None-Match condition does not hold.');
  };
  // The inclusive byte window of a range over an object of `size` bytes; anything unsatisfiable is InvalidRange.
  const byteWindow = (size, range) => {
    const start = range.start ?? 0,
      end = Math.min(range.end ?? size - 1, size - 1);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || start >= size)
      throw fail('InvalidRange', 'The range is not satisfiable.');
    return { start, end };
  };
  const store = (key, bytes, options = {}) => {
    conditions(objects.get(key), options);
    sequence += 1;
    const entry = {
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      etag: `"m${sequence}"`,
      version: sequence,
      lastModified: new Date(now()).toISOString(),
      contentType: options.contentType ?? 'application/octet-stream',
      metadata: options.metadata ?? {},
    };
    objects.set(key, entry);
    return meta(key, entry);
  };
  return {
    descriptor: {
      id,
      name: `storage:${id}`,
      kind: 'memory',
      version: '1',
      level: 'behaviour',
      operations: [...STORAGE_OPERATIONS],
      requires: [],
      principal: 'runtime',
      stateOwner: 'memory',
      lifecycle: 'in-process',
      fidelity: { notes: ['In-process memory: lost on restart.'] },
    },
    async put(key, body, options = {}) {
      alive();
      const bytes = await collect(body);
      if (options.blockId === undefined) return store(key, bytes, options);
      if (!staged.has(key)) staged.set(key, new Map());
      staged.get(key).set(options.blockId, bytes);
      return { key, blockId: options.blockId, size: bytes.length };
    },
    async commit(key, blockIds, options) {
      alive();
      const blocks = staged.get(key);
      if (!blocks || blockIds.some((block) => !blocks.has(block)))
        throw fail('NotFound', 'A committed block was not staged.');
      staged.delete(key);
      return store(key, Buffer.concat(blockIds.map((block) => blocks.get(block))), options);
    },
    async get(key, { range, ifNoneMatch } = {}) {
      alive();
      const o = objects.get(key);
      if (!o) throw fail('NotFound', 'The object does not exist.');
      if (ifNoneMatch !== undefined && (ifNoneMatch === '*' || ifNoneMatch === o.etag))
        return { ...meta(key, o), notModified: true, body: null };
      const { start, end } = range ? byteWindow(o.bytes.length, range) : { start: 0, end: o.bytes.length - 1 };
      const slice = o.bytes.subarray(start, end + 1);
      async function* body() {
        for (let i = 0; i < slice.length; i += 65536) yield slice.subarray(i, i + 65536);
      }
      return { ...meta(key, o), body: body(), range: range ? { start, end } : null };
    },
    // Readiness (provider contract preflight()): in process, ready while open.
    async preflight() {
      return closed ? { ready: false, reason: 'The provider is closed.' } : { ready: true };
    },
    async head(key) {
      alive();
      const o = objects.get(key);
      return o ? meta(key, o) : null;
    },
    async delete(key, { ifMatch } = {}) {
      alive();
      conditions(objects.get(key), { ifMatch });
      staged.delete(key);
      return objects.delete(key);
    },
    async list(prefix, { pageSize = 1000, continuation } = {}) {
      alive();
      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 5000)
        throw fail('InvalidKey', 'pageSize must be an integer from 1 to 5000.');
      const keys = [...objects.keys()]
        .filter((k) => k.startsWith(prefix) && (!continuation || k > continuation))
        .sort(/* NOSONAR: preserve default string coercion */);
      const page = keys.slice(0, pageSize);
      return {
        items: page.map((k) => ({
          key: k,
          size: objects.get(k).bytes.length,
          etag: objects.get(k).etag,
          lastModified: objects.get(k).lastModified,
        })),
        continuation: keys.length > pageSize ? page.at(-1) : null,
      };
    },
    async sas(key, { permission = 'r', expiresOn }) {
      const se = new Date(expiresOn).toISOString();
      return `memory:/${key}?${new URLSearchParams({ se, sp: permission, sig: sign(key, se, permission) })}`;
    },
    verifySas(url, { permission } = {}) {
      const parsed = new URL(url);
      const key = parsed.pathname.slice(1),
        se = parsed.searchParams.get('se'),
        sp = parsed.searchParams.get('sp') ?? '';
      const a = Buffer.from(sign(key, se, sp)),
        b = Buffer.from(parsed.searchParams.get('sig') ?? '');
      if (
        a.length !== b.length ||
        !timingSafeEqual(a, b) ||
        Date.parse(se) <= now() ||
        (permission && !sp.includes(permission))
      )
        throw fail('Unauthorized', 'The SAS URL is not valid.');
      return { key, permission: sp, expiresOn: se };
    },
    async close() {
      closed = true;
      objects.clear();
      staged.clear();
    },
  };
}
