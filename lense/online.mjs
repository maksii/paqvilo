// Plain (anonymous) HTTP access to the online site, used by `map --check`, `status` and the dev panel.
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const MAX_COMPARISON_BYTES = 32 * 1024 * 1024;

/** Metadata stores URL paths, sometimes already percent-encoded. Never let them change authority. */
export function portalResourceUrl(origin, urlPath) {
  const base = new URL(origin);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('Expected an HTTP(S) portal origin');
  if (typeof urlPath !== 'string' || !urlPath.startsWith('/') || urlPath.startsWith('//') || /[\\\x00-\x1f]/.test(urlPath)) throw new Error('Expected a same-origin resource path');
  const encoded = urlPath.split('/').map((segment) => {
    let decoded = segment;
    try { decoded = decodeURIComponent(segment); } catch { /* literal percent */ }
    if (decoded === '.' || decoded === '..' || /[\\\x00-\x1f]/.test(decoded)) throw new Error('Invalid resource path segment');
    return encodeURIComponent(decoded);
  }).join('/');
  return base.origin + encoded;
}

/** Runs `fn` over `items` with at most `limit` in flight. Results keep the order of `items`. */
export async function mapLimit(items, limit, fn) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Concurrency limit must be a positive integer');
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** One attempt through a Playwright request context: the browser's own sign-in, no redirects followed. */
async function fetchWithRequest(request, url, { timeout, readBody }) {
  const res = await request.fetch(url, { method: 'GET', maxRedirects: 0, timeout, failOnStatusCode: false });
  try {
    const status = res.status();
    if (!readBody || status !== 200) return { status, body: null };
    if (Number(res.headers()['content-length']) > MAX_COMPARISON_BYTES) return { status: 0, body: null, error: 'Comparison exceeds 32 MiB' };
    const body = await res.body();
    if (body.length > MAX_COMPARISON_BYTES) return { status: 0, body: null, error: 'Comparison exceeds 32 MiB' };
    return { status, body };
  } finally {
    await res.dispose?.().catch(() => {});
  }
}

/**
 * `request`: an optional Playwright APIRequestContext; with it the comparison runs with the
 * browser's sign-in (a signed-in portal serves its web files only to that session).
 * @returns {Promise<{status: number, body: Buffer|null, error?: string}>} status 0 on network failure
 */
export async function fetchOnline(origin, urlPath, attempts = 3, { signal, timeout = 15_000, readBody = true, request = null } = {}) {
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error('Attempts must be a positive integer');
  const url = portalResourceUrl(origin, urlPath);
  let error;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      if (signal?.aborted) break;
      if (attempt) await delay(400 * attempt, undefined, { signal });
      if (request) {
        const result = await fetchWithRequest(request, url, { timeout, readBody });
        if (signal?.aborted) break;
        if ((result.status >= 500 || result.status === 429) && attempt < attempts - 1) { error = `HTTP ${result.status}`; continue; }
        return result;
      }
      const timed = AbortSignal.timeout(timeout);
      const res = await fetch(url, { redirect: 'manual', signal: signal ? AbortSignal.any([signal, timed]) : timed });
      // the portal answers 5xx/429 under load; those are worth another try
      if (res.status >= 500 || res.status === 429) {
        error = `HTTP ${res.status}`;
        if (attempt < attempts - 1) { await res.body?.cancel(); continue; }
      }
      if (!readBody || res.status !== 200) {
        await res.body?.cancel();
        return { status: res.status, body: null };
      }
      const parts = [];
      let size = 0;
      const limit = MAX_COMPARISON_BYTES;
      if (Number(res.headers.get('content-length')) > limit) { await res.body?.cancel(); return { status: 0, body: null, error: 'Comparison exceeds 32 MiB' }; }
      for await (const part of res.body ?? []) {
        size += part.length;
        if (size > limit) return { status: 0, body: null, error: 'Comparison exceeds 32 MiB' };
        parts.push(part);
      }
      const body = parts.length === 1 ? Buffer.from(parts[0].buffer, parts[0].byteOffset, parts[0].byteLength) : Buffer.concat(parts, size);
      return { status: res.status, body };
    } catch (err) {
      error = err.cause?.message ?? err.message;
    }
  }
  return { status: 0, body: null, error };
}

const TEXT_EXT = /\.(?:js|mjs|css|html?|json|svg|xml|txt|map)$/i;

function sameContent(file, local, online) {
  if (local.equals(online)) return true;
  if (!TEXT_EXT.test(file)) return false;
  // line endings change on checkout (core.autocrlf), that is not a real difference
  const norm = (b) => b.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  return norm(local) === norm(online);
}

/**
 * Compares one local web file with the copy the environment serves (anonymously, unless
 * `options.request` supplies the browser's own request context).
 * @param {string} origin
 * @param {{url: string, file: string}} webFile
 * @returns {Promise<{state: string, detail?: string}>} state is 'same', 'different' or what describeStatus says
 */
export async function compareWebFile(origin, webFile, options = {}) {
  let local;
  let handle;
  try {
    if (options.signal?.aborted) return { state: 'cancelled' };
    handle = await fs.promises.open(webFile.file, 'r');
    const info = await handle.stat();
    if (!info.isFile()) return { state: 'unreadable', detail: 'local source is not a regular file' };
    if (info.size > MAX_COMPARISON_BYTES) return { state: 'too large', detail: 'Local comparison exceeds 32 MiB' };
    // One extra byte detects growth while reading, without ever buffering an unbounded save.
    const buffer = Buffer.allocUnsafe(info.size + 1);
    let size = 0;
    while (size < buffer.length) {
      if (options.signal?.aborted) return { state: 'cancelled' };
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > info.size) return { state: 'unreadable', detail: 'Local file changed during comparison; save again to retry' };
    local = buffer.subarray(0, size);
  } catch (err) {
    return { state: 'unreadable', detail: err.message };
  } finally {
    await handle?.close().catch(() => {});
  }
  const online = await fetchOnline(origin, webFile.url, 3, { ...options, readBody: true });
  if (online.status !== 200) return { state: describeStatus(online.status), ...(online.error ? { detail: online.error } : {}) };
  if (sameContent(webFile.file, local, online.body)) return { state: 'same' };
  return { state: 'different', detail: `local ${local.length} bytes, online ${online.body.length} bytes` };
}

export function describeStatus(status) {
  if (status === 200) return 'online';
  if (status === 404) return 'not online (local only)';
  if (status === 401) return 'authentication required';
  if (status === 403) return 'forbidden';
  if (status >= 300 && status < 400) return `redirect (HTTP ${status})`;
  if (status === 0) return 'unreachable';
  return `HTTP ${status}`;
}
