import { Worker } from 'node:worker_threads';
import { metadataResponseChunks } from './metadata-response.mjs';
import { gzipSync } from 'node:zlib';
import { plainDataObject } from '../state-clone.mjs';

/** Compile/encode one table outside the large record heap. Transfer UTF-8
 * buffers rather than rebuilding the compiled object graph on the main thread.
 * The host retains its security read epoch and evaluates all capabilities. */
export async function* metadataWorkerResponseChunks(
  source,
  root,
  capabilities,
  res,
  { wire = false, gzip = false } = {},
) {
  const worker = new Worker(new URL('./metadata-worker.mjs', import.meta.url), {
    workerData: source.compilationContext,
  });
  let pending,
    closed = false;
  const fail = (error) => {
    closed = true;
    pending?.reject(error);
    pending = null;
  };
  worker.on('error', fail);
  worker.on('exit', (code) => fail(new Error(`Metadata compiler stopped (${code}).`)));
  worker.on('message', (value) => {
    const request = pending;
    pending = null;
    if (value.error) request?.reject(Object.assign(new Error(value.error.message), { stack: value.error.stack }));
    else request?.resolve(Buffer.from(value.bytes));
  });
  const close = () => {
    fail(new Error('Metadata response reader disconnected.'));
    void worker.terminate();
  };
  res.once('close', close);
  const compile = (name) =>
    new Promise((resolve, reject) => {
      if (closed || res.destroyed) {
        reject(new Error('Metadata response reader disconnected.'));
        return;
      }
      pending = { resolve, reject };
      try {
        const fields = plainDataObject(),
          property = { value: undefined, writable: true, enumerable: true, configurable: true };
        for (const [key, field] of Object.entries(source.tableIndex[name].fields)) {
          property.value = field && typeof field === 'object' ? field : { name: key, dataverseType: field };
          Object.defineProperty(fields, key, property);
        }
        const input = source.tableInput(name),
          rights = capabilities(name, fields);
        if (closed || res.destroyed) return;
        worker.postMessage({ name, input, capabilities: rights, wire, gzip });
      } catch (error) {
        pending = null;
        reject(error);
      }
    });
  try {
    for (const chunk of metadataResponseChunks(root, { tableChunk: compile })) {
      const value = await chunk;
      // Concatenated gzip members form one representation. Large table
      // buffers stay compressed across isolates and the HTTP transport.
      yield gzip && typeof value === 'string'
        ? gzipSync(value, { level: 1, chunkSize: Math.min(16384, Math.max(64, Buffer.byteLength(value) + 64)) })
        : value;
    }
  } finally {
    res.off('close', close);
    closed = true;
    await worker.terminate();
  }
}
