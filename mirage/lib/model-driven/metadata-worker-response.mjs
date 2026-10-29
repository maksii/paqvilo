import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { metadataResponseChunks } from './metadata-response.mjs';
import { plainDataObject } from '../state-clone.mjs';

/** A lazy catalogue table's index fields as field objects: the input of its capability checks. */
export function indexFields(source, name) {
  const fields = plainDataObject(),
    property = { value: undefined, writable: true, enumerable: true, configurable: true };
  for (const [key, field] of Object.entries(source.tableIndex[name].fields)) {
    property.value = field && typeof field === 'object' ? field : { name: key, dataverseType: field };
    Object.defineProperty(fields, key, property);
  }
  return fields;
}

/** Metadata compiler threads. A response checks one out exclusively; after a
 * complete response one thread stays warm for idleMs (unref'd, so it never keeps
 * the process alive) and a surplus, failed or cancelled one is terminated.
 * `events` emits 'exit' with { code, reason, error } whenever a thread stops. */
export function createMetadataWorkers({ idleMs = 30_000 } = {}) {
  const events = new EventEmitter();
  let idle = null,
    closed = false;
  const stop = (entry, reason) => {
    entry.reason ??= reason;
    return entry.worker.terminate();
  };
  const start = () => {
    const entry = { worker: new Worker(new URL('./metadata-worker.mjs', import.meta.url)), failure: null };
    // The first real failure (for example ERR_WORKER_OUT_OF_MEMORY) is kept for
    // the response using the thread and reported when the thread exits.
    entry.worker.on('error', (error) => {
      entry.failure ??= error;
    });
    entry.worker.on('exit', (code) => {
      entry.failure ??= new Error(`Metadata compiler stopped (${code}).`);
      entry.exited = true;
      if (idle?.entry === entry) {
        clearTimeout(idle.timer);
        idle = null;
      }
      events.emit('exit', { code, reason: entry.reason ?? 'failed', error: entry.reason ? null : entry.failure });
    });
    return entry;
  };
  return {
    events,
    acquire() {
      if (closed) throw new Error('Metadata compilers are closed.');
      const warm = idle;
      idle = null;
      if (!warm) return start();
      clearTimeout(warm.timer);
      warm.entry.worker.ref();
      return warm.entry;
    },
    /** reason: null keeps a healthy thread warm; any other reason terminates it. */
    release(entry, reason = null) {
      if (entry.exited) return;
      if (reason || entry.failure || idle || closed) return stop(entry, reason ?? (closed ? 'closed' : 'surplus'));
      entry.worker.postMessage({ context: null });
      entry.worker.unref();
      idle = {
        entry,
        timer: setTimeout(() => {
          if (idle?.entry !== entry) return;
          idle = null;
          void stop(entry, 'idle');
        }, idleMs).unref(),
      };
    },
    async close() {
      closed = true;
      const warm = idle;
      idle = null;
      if (!warm) return;
      clearTimeout(warm.timer);
      await stop(warm.entry, 'closed');
    },
  };
}

// One gzip member for the whole representation; compression runs on the zlib
// thread pool, and backpressure from the consumer pauses the source.
async function* gzipStream(source) {
  const gzip = createGzip({ level: 1 });
  const piped = pipeline(Readable.from(source), gzip).then(
    () => null,
    (error) => error,
  );
  try {
    for await (const chunk of gzip) yield chunk;
    const error = await piped;
    if (error) throw error;
  } finally {
    gzip.destroy();
    await piped;
  }
}

/** Compile/encode one table at a time outside the large record heap and
 * transfer its UTF-8 bytes. The host evaluated every table's rights (`rights(name)`)
 * under its read; `check()` throws when the catalogue changed since then. */
export async function* metadataWorkerResponseChunks(
  source,
  root,
  rights,
  res,
  { wire = false, gzip = false, workers, check = () => {} } = {},
) {
  const chunks = compiledChunks(source, root, rights, res, { wire, workers, check });
  if (gzip) yield* gzipStream(chunks);
  else yield* chunks;
}

async function* compiledChunks(source, root, rights, res, { wire, workers, check }) {
  // Without a host pool the response owns one thread for its duration.
  const pool = workers ?? createMetadataWorkers();
  const entry = pool.acquire(),
    { worker } = entry;
  let pending = null,
    disconnected = false;
  const settle = () => {
    const request = pending;
    pending = null;
    request?.reject(entry.failure);
  };
  const onMessage = (value) => {
    const request = pending;
    pending = null;
    if (value.error) request?.reject(Object.assign(new Error(value.error.message), { stack: value.error.stack }));
    else request?.resolve(Buffer.from(value.bytes));
  };
  const close = () => {
    disconnected = true;
    pending?.reject(new Error('Metadata response reader disconnected.'));
    pending = null;
  };
  worker.on('message', onMessage);
  worker.on('error', settle);
  worker.on('exit', settle);
  res.once('close', close);
  worker.postMessage({ context: source.compilationContext });
  const compile = (name) =>
    new Promise((resolve, reject) => {
      if (entry.failure) return reject(entry.failure);
      if (disconnected || res.destroyed) return reject(new Error('Metadata response reader disconnected.'));
      try {
        check();
        const message = { name, input: source.tableInput(name), capabilities: rights(name), wire };
        pending = { resolve, reject };
        worker.postMessage(message);
      } catch (error) {
        pending = null;
        reject(error);
      }
    });
  let reason = 'cancelled';
  try {
    for (const chunk of metadataResponseChunks(root, { tableChunk: compile })) yield await chunk;
    reason = null;
  } catch (error) {
    reason = disconnected || res.destroyed ? 'cancelled' : 'failed';
    throw error;
  } finally {
    res.off('close', close);
    worker.off('message', onMessage);
    worker.off('error', settle);
    worker.off('exit', settle);
    // A compilation still running for a disconnected or failed response stops
    // with its thread; a completed response returns the thread warm.
    await pool.release(entry, reason ?? (workers ? null : 'closed'));
  }
}
