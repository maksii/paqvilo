// Default storage provider: content-addressed files under a root directory (normally <stateDirectory>/blobs).
// Layout: objects/<sha256> (immutable bytes), index.json (key → entry), staging/<sha256(key)>/<sha256(blockId)>, tmp/.
// Every path is derived from hex digests or generated ids and checked against the root before use.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ProviderError, STORAGE_OPERATIONS, validateKey } from './storage-provider.mjs';
import { systemClock, systemIds } from './runtime-clock.mjs';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const INDEX_VERSION = 1;

/** createLocalDiskStorage({ root, id, clock, ids, maxBytes, sasBaseUrl, sasSecret }) → storage provider. */
export function createLocalDiskStorage({
  root,
  id = 'local',
  clock = systemClock.now,
  ids = systemIds.uuid,
  maxBytes = Infinity,
  sasBaseUrl,
  sasSecret = randomBytes(32),
} = {}) {
  if (typeof root !== 'string' || !root) throw new TypeError('createLocalDiskStorage needs a root directory');
  root = path.resolve(root);
  const sasBase = sasBaseUrl ?? `/_sas/storage/${encodeURIComponent(id)}/`;
  const error = (code, message, diagnostic) => new ProviderError(code, message, { provider: id, diagnostic });
  const within = (...parts) => {
    const file = path.resolve(root, ...parts);
    const relative = path.relative(root, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
      throw error('InvalidKey', 'Storage path escapes the provider root.');
    return file;
  };
  const objectFile = (digest) => within('objects', digest);
  const stagingDir = (key) => within('staging', sha256(key));

  let index = null; // Map key → entry
  let sequence = 0;
  let closed = false;
  const writingTemps = new Set();
  let ready;
  const load = () =>
    (ready ??= (async () => {
      for (const dir of ['objects', 'staging', 'tmp']) await fs.mkdir(within(dir), { recursive: true });
      let text = null;
      try {
        text = await fs.readFile(within('index.json'), 'utf8');
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      let parsed = { version: INDEX_VERSION, sequence: 0, entries: {} };
      if (text !== null) {
        try {
          parsed = JSON.parse(text);
        } catch {
          throw error('Unavailable', 'Storage index is unreadable.', 'PROVIDER_INDEX_CORRUPT');
        }
        if (parsed?.version !== INDEX_VERSION || typeof parsed.entries !== 'object')
          throw error('Unavailable', 'Storage index has an unknown format.', 'PROVIDER_INDEX_CORRUPT');
      }
      index = new Map(Object.entries(parsed.entries));
      sequence = Number(parsed.sequence) || 0;
    })());

  // One writer at a time for the index; reads see the in-memory map.
  let queue = Promise.resolve();
  const exclusive = (fn) => {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  };
  const open = async () => {
    if (closed) throw error('Unavailable', `Storage provider '${id}' is closed.`);
    await load();
  };

  const durable = async (file, data) => {
    const handle = await fs.open(file, 'wx', 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
  };
  const persist = async () => {
    const temp = within('tmp', `index-${ids()}.json`);
    await durable(temp, JSON.stringify({ version: INDEX_VERSION, sequence, entries: Object.fromEntries(index) }));
    await fs.rename(temp, within('index.json'));
  };
  const referenced = (digest) => {
    for (const entry of index.values()) if (entry.sha256 === digest) return true;
    return false;
  };
  // ponytail: reference check scans the index (O(keys)); keep a refcount map if key counts grow past ~100k.
  const release = async (digest) => {
    if (!referenced(digest)) await fs.rm(objectFile(digest), { force: true }).catch(() => {});
  };

  // Streams any body to a temp file, hashing as it goes; never holds more than one chunk.
  const streamToTemp = async (body, signal) => {
    const temp = within('tmp', `put-${ids()}`);
    writingTemps.add(temp);
    const hash = createHash('sha256');
    let size = 0;
    const handle = await fs.open(temp, 'wx', 0o600);
    try {
      const chunks = Buffer.isBuffer(body) || body instanceof Uint8Array || typeof body === 'string' ? [body] : body;
      if (
        !chunks ||
        (typeof chunks[Symbol.asyncIterator] !== 'function' && typeof chunks[Symbol.iterator] !== 'function')
      )
        throw error('InvalidKey', 'Storage body must be a Buffer or an AsyncIterable of Buffers.');
      for await (const part of chunks) {
        signal?.throwIfAborted();
        const chunk = typeof part === 'string' ? Buffer.from(part) : part;
        size += chunk.length;
        if (size > maxBytes) throw error('TooLarge', `Storage object exceeds ${maxBytes} bytes.`);
        hash.update(chunk);
        await handle.write(chunk);
      }
      await handle.sync();
    } catch (e) {
      await handle.close();
      await fs.rm(temp, { force: true });
      writingTemps.delete(temp);
      throw e;
    }
    await handle.close();
    return { temp, size, digest: hash.digest('hex') };
  };
  const discard = async (temp) => {
    await fs.rm(temp, { force: true });
    writingTemps.delete(temp);
  };

  const checkConditions = (current, { ifMatch, ifNoneMatch } = {}) => {
    if (ifMatch !== undefined && (!current || (ifMatch !== '*' && ifMatch !== current.etag)))
      throw error('PreconditionFailed', 'Storage object ETag does not match If-Match.');
    if (ifNoneMatch === '*' && current) throw error('Conflict', 'Storage object already exists.');
    if (ifNoneMatch !== undefined && ifNoneMatch !== '*' && current?.etag === ifNoneMatch)
      throw error('PreconditionFailed', 'Storage object ETag matches If-None-Match.');
  };
  const publicEntry = (key, entry) => ({
    key,
    size: entry.size,
    sha256: entry.sha256,
    etag: entry.etag,
    version: entry.version,
    lastModified: entry.lastModified,
    contentType: entry.contentType,
    metadata: { ...entry.metadata },
  });

  const storeObject = async (key, body, options = {}) => {
    const { temp, size, digest } = await streamToTemp(body, options.signal);
    return exclusive(async () => {
      try {
        const current = index.get(key);
        checkConditions(current, options);
        const target = objectFile(digest);
        try {
          await fs.access(target);
          await discard(temp);
        } catch {
          await fs.rename(temp, target);
          writingTemps.delete(temp);
        }
        sequence += 1;
        const entry = {
          sha256: digest,
          size,
          etag: `"${digest.slice(0, 16)}-${sequence}"`,
          version: sequence,
          contentType: options.contentType ?? current?.contentType ?? 'application/octet-stream',
          metadata: { ...(options.metadata ?? {}) },
          lastModified: new Date(clock()).toISOString(),
        };
        index.set(key, entry);
        await persist();
        if (current && current.sha256 !== digest) await release(current.sha256);
        return publicEntry(key, entry);
      } finally {
        if (writingTemps.has(temp)) await discard(temp);
      }
    });
  };

  const blockName = (blockId) => {
    if (typeof blockId !== 'string' || !blockId || blockId.length > 1024)
      throw error('InvalidKey', 'Block id must be a non-empty string up to 1024 characters.');
    return sha256(blockId);
  };

  const signature = (key, expiry, permission) =>
    createHmac('sha256', sasSecret).update(`${key}\n${expiry}\n${permission}`).digest('base64url');

  const provider = {
    descriptor: Object.freeze({
      id,
      name: 'storage:local-disk',
      kind: 'local-disk',
      version: '1',
      level: 'behaviour',
      operations: Object.freeze([...STORAGE_OPERATIONS]),
      requires: Object.freeze([]),
      principal: 'runtime',
      stateOwner: 'owned',
      lifecycle: 'in-process',
      fidelity: Object.freeze({
        notes: Object.freeze([
          'Bytes live under the provider root, normally <stateDirectory>/blobs; state keeps keys and metadata only.',
          'ETags are opaque and change on every write; SAS URLs are HMAC-signed with a per-process secret.',
          'Blob service features beyond put/get/head/delete/list/block commit/SAS (leases, snapshots, tiers, CORS) are not modelled.',
        ]),
      }),
    }),

    async put(key, body, options = {}) {
      key = validateKey(key, id);
      await open();
      if (options.blockId === undefined) return storeObject(key, body, options);
      const dir = stagingDir(key),
        name = blockName(options.blockId);
      const { temp, size } = await streamToTemp(body, options.signal);
      await fs.mkdir(dir, { recursive: true });
      await fs.rename(temp, within('staging', path.basename(dir), name));
      writingTemps.delete(temp);
      return { key, blockId: options.blockId, size };
    },

    async commit(key, blockIds, options = {}) {
      key = validateKey(key, id);
      await open();
      if (!Array.isArray(blockIds) || !blockIds.length)
        throw error('InvalidKey', 'commit needs a non-empty block id list.');
      const dir = stagingDir(key);
      const files = blockIds.map((blockId) => within('staging', path.basename(dir), blockName(blockId)));
      for (const file of files) {
        try {
          await fs.access(file);
        } catch {
          throw error('NotFound', 'A committed block was not staged for this key.');
        }
      }
      async function* blocks() {
        for (const file of files) yield* (await fs.open(file, constants.O_RDONLY)).createReadStream();
      }
      const result = await storeObject(key, blocks(), options);
      await fs.rm(dir, { recursive: true, force: true });
      return result;
    },

    async get(key, { range, ifNoneMatch, signal } = {}) {
      key = validateKey(key, id);
      await open();
      const entry = index.get(key);
      if (!entry) throw error('NotFound', 'Storage object does not exist.');
      const meta = publicEntry(key, entry);
      if (ifNoneMatch !== undefined && (ifNoneMatch === '*' || ifNoneMatch === entry.etag))
        return { ...meta, notModified: true, body: null };
      let start = 0,
        end = entry.size - 1;
      if (range) {
        start = range.start ?? 0;
        end = Math.min(range.end ?? entry.size - 1, entry.size - 1);
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || start >= entry.size)
          throw error('InvalidRange', 'Requested range is not satisfiable.');
      }
      const file = objectFile(entry.sha256);
      const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      if (!(await handle.stat()).isFile() || (await fs.lstat(file)).isSymbolicLink()) {
        await handle.close();
        throw error('Unavailable', 'Storage object is not a regular file.', 'PROVIDER_OBJECT_INVALID');
      }
      const body = entry.size === 0 ? (async function* () {})() : handle.createReadStream({ start, end, signal });
      if (entry.size === 0) await handle.close();
      return {
        ...meta,
        body,
        range: range ? { start, end } : null,
        contentLength: entry.size === 0 ? 0 : end - start + 1,
      };
    },

    async head(key) {
      key = validateKey(key, id);
      await open();
      const entry = index.get(key);
      return entry ? publicEntry(key, entry) : null;
    },

    async delete(key, { ifMatch } = {}) {
      key = validateKey(key, id);
      await open();
      return exclusive(async () => {
        const current = index.get(key);
        checkConditions(current, { ifMatch });
        if (!current) return false;
        index.delete(key);
        await persist();
        await release(current.sha256);
        return true;
      });
    },

    async list(prefix = '', { pageSize = 1000, continuation } = {}) {
      if (prefix) prefix = validateKey(prefix, id, { prefix: true });
      await open();
      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 5000)
        throw error('InvalidKey', 'pageSize must be an integer from 1 to 5000.');
      let after = null;
      if (continuation) {
        try {
          after = Buffer.from(continuation, 'base64url').toString('utf8');
          validateKey(after, id);
        } catch {
          throw error('InvalidKey', 'Continuation token is invalid.');
        }
      }
      const keys = [...index.keys()].filter((key) => key.startsWith(prefix) && (after === null || key > after)).sort();
      const page = keys.slice(0, pageSize);
      const items = page.map((key) => {
        const e = index.get(key);
        return { key, size: e.size, etag: e.etag, lastModified: e.lastModified };
      });
      return { items, continuation: keys.length > pageSize ? Buffer.from(page.at(-1)).toString('base64url') : null };
    },

    async sas(key, { permission = 'r', expiresOn } = {}) {
      key = validateKey(key, id);
      if (!['r', 'w', 'rw'].includes(permission)) throw error('InvalidKey', "SAS permission must be 'r', 'w' or 'rw'.");
      const expiry = new Date(expiresOn ?? clock() + 3600_000).toISOString();
      const query = new URLSearchParams({ se: expiry, sp: permission, sig: signature(key, expiry, permission) });
      return `${sasBase}${key.split('/').map(encodeURIComponent).join('/')}?${query}`;
    },

    /** Server side of sas(): returns { key, permission, expiresOn } or throws Unauthorized. */
    verifySas(url, { permission } = {}) {
      const denied = () => error('Unauthorized', 'Shared access signature is invalid or expired.');
      let parsed;
      try {
        parsed = new URL(url, 'http://localhost');
      } catch {
        throw denied();
      }
      const base = new URL(sasBase, 'http://localhost').pathname;
      if (!parsed.pathname.startsWith(base)) throw denied();
      let key;
      try {
        key = validateKey(parsed.pathname.slice(base.length).split('/').map(decodeURIComponent).join('/'), id);
      } catch {
        throw denied();
      }
      const se = parsed.searchParams.get('se') ?? '',
        sp = parsed.searchParams.get('sp') ?? '',
        sig = parsed.searchParams.get('sig') ?? '';
      const expected = Buffer.from(signature(key, se, sp)),
        given = Buffer.from(sig);
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw denied();
      const expiresOn = Date.parse(se);
      if (!Number.isFinite(expiresOn) || expiresOn <= clock()) throw denied();
      if (permission && ![...permission].every((p) => sp.includes(p))) throw denied();
      return { key, permission: sp, expiresOn: se };
    },

    /** Removes unreferenced objects and abandoned temp files. Returns { removed, bytes }. */
    async compact() {
      await open();
      return exclusive(async () => {
        const live = new Set([...index.values()].map((entry) => entry.sha256));
        let removed = 0,
          bytes = 0;
        for (const name of await fs.readdir(within('objects'))) {
          if (live.has(name)) continue;
          const file = within('objects', name);
          try {
            const { size } = await fs.stat(file);
            await fs.rm(file, { force: true });
            removed += 1;
            bytes += size;
          } catch {
            /* in use on Windows; next compact */
          }
        }
        for (const name of await fs.readdir(within('tmp'))) {
          const file = within('tmp', name);
          if (!writingTemps.has(file)) await fs.rm(file, { force: true }).catch(() => {});
        }
        return { removed, bytes };
      });
    },

    // Readiness (provider contract preflight()): the root opens (created, index read) or the reason it does not.
    async preflight() {
      if (closed) return { ready: false, reason: 'The provider is closed.' };
      try {
        await open();
        return { ready: true };
      } catch (error) {
        return { ready: false, reason: error.message };
      }
    },

    async close() {
      closed = true;
      await queue;
    },
  };
  return provider;
}
