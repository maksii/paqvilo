import { once } from 'node:events';
import { setImmediate } from 'node:timers/promises';

/** Stream already encoded JSON pieces without retaining a second full response
 * string. Respect backpressure and release work when the reader disconnects. */
export async function writeJsonChunks(res, chunks) {
  const abort = new AbortController();
  const close = () => abort.abort();
  res.once('close', close);
  let yieldedAt = performance.now();
  const asynchronous = Boolean(chunks[Symbol.asyncIterator]);
  const iterator = asynchronous ? chunks[Symbol.asyncIterator]() : chunks[Symbol.iterator]();
  let complete = false;
  try {
    while (true) {
      // Keep synchronous admission synchronous: a reader can release its first
      // backpressure gate immediately after this function returns its promise.
      const next = asynchronous ? await iterator.next() : iterator.next();
      if (next.done) {
        complete = true;
        break;
      }
      const chunk = next.value;
      if (res.destroyed) throw Error('JSON response reader disconnected.');
      if (!res.write(chunk)) await once(res, 'drain', { signal: abort.signal });
      if (performance.now() - yieldedAt >= 8) {
        await setImmediate(undefined, { signal: abort.signal });
        yieldedAt = performance.now();
      }
    }
    res.end();
  } finally {
    try {
      if (!complete) {
        const closed = iterator.return?.();
        if (asynchronous) await closed;
      }
    } finally {
      res.off('close', close);
    }
  }
}
