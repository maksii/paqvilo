import { once } from 'node:events';
import { setImmediate } from 'node:timers/promises';

/** Stream already encoded JSON pieces without retaining a second full response
 * string. Respect backpressure and release work when the reader disconnects. */
export async function writeJsonChunks(res, chunks) {
  const abort = new AbortController();
  const close = () => abort.abort();
  res.once('close', close);
  let yieldedAt = performance.now();
  try {
    for (const chunk of chunks) {
      if (res.destroyed) throw Error('JSON response reader disconnected.');
      if (!res.write(chunk)) await once(res, 'drain', { signal: abort.signal });
      if (performance.now() - yieldedAt >= 8) {
        await setImmediate(undefined, { signal: abort.signal });
        yieldedAt = performance.now();
      }
    }
    res.end();
  } finally {
    res.off('close', close);
  }
}
