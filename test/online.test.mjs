import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchOnline, mapLimit, portalResourceUrl, compareWebFile } from '../lense/online.mjs';

test('resource paths keep their origin and encode literal reserved filename characters once', () => {
  assert.equal(portalResourceUrl('https://portal.example', '/files/a b#c?.js'), 'https://portal.example/files/a%20b%23c%3F.js');
  assert.equal(portalResourceUrl('https://portal.example', '/files/a%20b.js'), 'https://portal.example/files/a%20b.js');
  for (const value of ['//evil.example/x', '@evil.example', '/a/../x', '/a/%2e%2e/x', '/\\evil', '/a\n']) assert.throws(() => portalResourceUrl('https://portal.example', value));
});

test('browser-authenticated comparisons keep redirects confined and dispose every response', async (t) => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('signed-in comparison must use the supplied request context'));
  const options = [];
  let disposed = 0;
  let bodies = 0;
  const statuses = [503, 302, 200, 200];
  const request = { fetch: async (url, opts) => {
    assert.equal(url, 'https://portal.example/app.js');
    options.push(opts);
    const status = statuses.shift();
    return { status: () => status, headers: () => ({ 'content-length': statuses.length === 0 ? String(33 * 1024 * 1024) : '2' }), body: async () => { bodies++; return Buffer.from('ok'); }, dispose: async () => { disposed++; } };
  } };
  assert.equal((await fetchOnline('https://portal.example', '/app.js', 2, { request })).status, 302);
  assert.equal((await fetchOnline('https://portal.example', '/app.js', 1, { request })).body.toString(), 'ok');
  assert.match((await fetchOnline('https://portal.example', '/app.js', 1, { request })).error, /32 MiB/);
  assert.equal(disposed, 4);
  assert.equal(bodies, 1);
  assert.ok(options.every((opts) => opts.maxRedirects === 0 && opts.timeout > 0 && opts.method === 'GET'));
});

test('bounded mapping preserves order and rejects a limit that would silently omit work', async () => {
  let active = 0, peak = 0;
  const result = await mapLimit([3, 1, 2, 4], 2, async (value) => {
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, value));
    active--;
    return value * 2;
  });
  assert.deepEqual(result, [6, 2, 4, 8]);
  assert.equal(peak, 2);
  await assert.rejects(mapLimit([1], 0, () => 1), /positive integer/);
});

test('online comparison follows no redirects and uses a bounded, cancellable request', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options });
    return new Response('login', { status: 302, headers: { location: 'https://other.example' } });
  });
  const result = await fetchOnline('https://portal.example', '/a%20b.js');
  assert.equal(result.status, 302);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.redirect, 'manual');
  assert.equal(requests[0].url, 'https://portal.example/a%20b.js');
  assert.ok(requests[0].options.signal instanceof AbortSignal);
  const signal = AbortSignal.abort();
  assert.equal((await fetchOnline('https://portal.example', '/x', 3, { signal })).status, 0);
  assert.equal(requests.length, 1);
});

test('oversized comparison responses are rejected before buffering their bodies', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('small', { headers: { 'content-length': String(33 * 1024 * 1024) } }));
  const result = await fetchOnline('https://portal.example', '/huge.bin');
  assert.equal(result.status, 0);
  assert.match(result.error, /32 MiB/);
});

test('status-only checks and non-200 responses cancel the body without buffering it', async (t) => {
  let cancelled = 0;
  let pulled = 0;
  t.mock.method(globalThis, 'fetch', async () => ({ status: 403, headers: new Headers(), body: { cancel: async () => { cancelled++; }, async *[Symbol.asyncIterator]() { pulled++; yield Buffer.alloc(1024); } } }));
  assert.equal((await fetchOnline('https://portal.example', '/restricted')).body, null);
  assert.equal(cancelled, 1);
  assert.equal(pulled, 0);
  t.mock.method(globalThis, 'fetch', async () => ({ status: 200, headers: new Headers(), body: { cancel: async () => { cancelled++; }, async *[Symbol.asyncIterator]() { pulled++; yield Buffer.alloc(1024); } } }));
  assert.equal((await fetchOnline('https://portal.example', '/large', 1, { readBody: false })).body, null);
  assert.equal(cancelled, 2);
  assert.equal(pulled, 0);
});

test('local oversize, missing, and cancelled comparisons do no HTTP work', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-online-limit-'));
  const file = path.join(dir, 'large.js');
  const handle = fs.openSync(file, 'w');
  fs.ftruncateSync(handle, 33 * 1024 * 1024);
  fs.closeSync(handle);
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not fetch'); });
  try {
    assert.equal((await compareWebFile('https://portal.example', { url: '/large.js', file })).state, 'too large');
    assert.equal((await compareWebFile('https://portal.example', { url: '/missing.js', file: path.join(dir, 'missing.js') })).state, 'unreadable');
    assert.equal((await compareWebFile('https://portal.example', { url: '/large.js', file }, { signal: AbortSignal.abort() })).state, 'cancelled');
    assert.equal(fetch.mock.callCount(), 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('async local comparison preserves newline normalization and releases the file handle', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-online-text-'));
  const file = path.join(dir, 'source.js');
  fs.writeFileSync(file, '\uFEFFone\r\ntwo\r\n');
  t.mock.method(globalThis, 'fetch', async () => new Response('one\ntwo\n'));
  try {
    assert.equal((await compareWebFile('https://portal.example', { url: '/source.js', file })).state, 'same');
    fs.renameSync(file, path.join(dir, 'moved.js'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
