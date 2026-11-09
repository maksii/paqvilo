// @test-kind tooling: verified tool downloads reject unsafe content and bound transient retries.
import { makeTemporaryDirectory } from '../mirage/testing/owned-fixture.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { downloadVerifiedArchive } from '../scripts/verified-download.mjs';

const payload = Buffer.from('Invented verified archive bytes');
const expected = createHash('sha256').update(payload).digest('hex');
async function fixture(t) {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-verified-download-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const requests = new Map();
  const server = http.createServer((request, response) => {
    requests.set(request.url, (requests.get(request.url) ?? 0) + 1);
    if (request.headers.accept !== 'application/octet-stream') {
      response.writeHead(406, { 'content-type': 'application/json' });
      response.end('{"error":"binary accept required"}');
    } else if (request.url === '/unavailable') {
      response.writeHead(503);
      response.end('unavailable');
    } else if (request.url === '/transient' && requests.get(request.url) === 1) {
      response.writeHead(504);
      response.end('upstream diagnostic must not escape');
    } else if (request.url === '/permanent') {
      response.writeHead(404);
      response.end('private error body');
    } else if (request.url === '/oversized-header') {
      response.writeHead(200, { 'content-length': '10000' });
      response.end('short');
    } else if (request.url === '/oversized-stream') {
      response.write(payload);
      response.end(payload);
    } else response.end(payload);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return {
    directory,
    target: path.join(directory, 'archive.zip'),
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
  };
}

test('a transient gateway error retries and publishes only the verified response', async (t) => {
  const { directory, target, url, requests } = await fixture(t);
  await downloadVerifiedArchive(url + '/transient', target, expected);
  assert.equal(requests.get('/transient'), 2);
  assert.deepEqual(await fs.readFile(target), payload);
  assert.deepEqual(await fs.readdir(directory), ['archive.zip']);
});

test('permanent HTTP errors fail once and transient failures stop after three attempts', async (t) => {
  const { directory, target, url, requests } = await fixture(t);
  await assert.rejects(downloadVerifiedArchive(url + '/permanent', target, expected), {
    message: 'Archive download failed: HTTP 404 (attempt 1).',
  });
  await assert.rejects(downloadVerifiedArchive(url + '/unavailable', target, expected), {
    message: 'Archive download failed: HTTP 503 (attempt 3).',
  });
  assert.equal(requests.get('/permanent'), 1);
  assert.equal(requests.get('/unavailable'), 3);
  assert.deepEqual(await fs.readdir(directory), []);
});

test('only complete digest-verified archives are published, with no temporary files left', async (t) => {
  const { directory, target, url } = await fixture(t);
  await downloadVerifiedArchive(url, target, expected);
  assert.deepEqual(await fs.readFile(target), payload);
  assert.deepEqual(await fs.readdir(directory), ['archive.zip']);
});

test('a bad digest leaves existing cache bytes intact and never persists the response', async (t) => {
  const { directory, target, url, requests } = await fixture(t);
  await fs.writeFile(target, 'previous cache');
  await assert.rejects(downloadVerifiedArchive(url, target, '0'.repeat(64)), /digest mismatch/);
  assert.equal(await fs.readFile(target, 'utf8'), 'previous cache');
  assert.deepEqual(await fs.readdir(directory), ['archive.zip']);
  assert.equal(requests.get('/'), 1);
});

test('HTTP failures and both advertised and streamed size limits leave no cache artifact', async (t) => {
  const { directory, target, url, requests } = await fixture(t);
  for (const route of ['/unavailable', '/oversized-header', '/oversized-stream']) {
    await assert.rejects(
      downloadVerifiedArchive(url + route, target, expected, { maxBytes: payload.length }),
      /download/,
    );
    assert.deepEqual(await fs.readdir(directory), [], route);
    assert.equal(requests.get(route), route === '/unavailable' ? 3 : 1);
  }
});
