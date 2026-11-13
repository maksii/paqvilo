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

async function scratchTarget(t) {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-verified-download-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, target: path.join(directory, 'archive.zip') };
}

async function streamingServer(t, respond) {
  let attempts = 0;
  const server = http.createServer((request, response) => {
    attempts += 1;
    respond(attempts, response);
  });
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/archive`, attempts: () => attempts };
}

// The fake fetch hands out one body per call. The test drives each body, and every clock advance waits for the timer
// the product arms for that step, so the test never guesses when the product has reached its next wait.
const remoteUrl = 'https://archive.invalid/archive.zip';
const stallLimitMs = 200;

function eventQueue() {
  let available = 0;
  let waiting = null;
  return {
    emit() {
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve();
      } else available += 1;
    },
    next() {
      return new Promise((resolve) => {
        if (available > 0) {
          available -= 1;
          resolve();
        } else {
          waiting = resolve;
        }
      });
    },
  };
}

function drivenBody(signal) {
  const requests = eventQueue();
  let streamController;
  const stream = new ReadableStream(
    {
      start(controller) {
        streamController = controller;
      },
      pull() {
        requests.emit();
      },
    },
    { highWaterMark: 0 },
  );
  signal.addEventListener('abort', () => streamController.error(new Error('aborted')), { once: true });
  return {
    stream,
    nextRequest: () => requests.next(),
    push: (bytes) => streamController.enqueue(bytes),
    end: () => streamController.close(),
  };
}

function drivenFetch() {
  const bodies = [];
  const started = eventQueue();
  return {
    calls: () => bodies.length,
    async fetchImpl(url, { signal }) {
      const body = drivenBody(signal);
      bodies.push(body);
      started.emit();
      return new Response(body.stream, { headers: { 'content-type': 'application/octet-stream' } });
    },
    async nextBody(index) {
      while (bodies.length <= index) await started.next();
      return bodies[index];
    },
  };
}

// Resolves with the delay of the next timer the code under test arms. Take the promise before the action that arms it.
function armedTimers(t) {
  const mocked = globalThis.setTimeout;
  let waiting = [];
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...rest) => {
    const timer = mocked(callback, delay, ...rest);
    const resolvers = waiting;
    waiting = [];
    for (const resolve of resolvers) resolve(delay);
    return timer;
  });
  return () => new Promise((resolve) => waiting.push(resolve));
}

// Waits for the timer the product arms next. Fails with a named assertion if `download` settles first, so a product that
// stops arming timers fails here instead of waiting until the test timeout. The settled branch is handled here, so it
// never surfaces as an unhandled rejection: the test awaits `download` itself for its real outcome.
function armedOrSettled(armed, download) {
  const settled = download.then(
    () => assert.fail('the download settled before arming its next timer'),
    (error) => {
      throw error;
    },
  );
  settled.catch(() => {});
  return Promise.race([armed, settled]);
}

// Sends `bytes` on attempt `index` and lets the idle limit abort that attempt. `retryDelay` is the delay of the retry
// wait the abort arms, or null when no attempt follows.
async function stallAttempt(t, download, remote, nextArmed, index, bytes, retryDelay) {
  const body = await remote.nextBody(index);
  // The first read is issued after the idle watch is armed: the watch is touched right before the body is read.
  await body.nextRequest();
  const idleArmed = nextArmed();
  body.push(bytes);
  assert.equal(await armedOrSettled(idleArmed, download), stallLimitMs);
  const retryArmed = retryDelay === null ? null : nextArmed();
  t.mock.timers.tick(stallLimitMs);
  if (retryDelay === null) return;
  assert.equal(await armedOrSettled(retryArmed, download), retryDelay);
  t.mock.timers.tick(retryDelay);
}

test('a slow but steady body completes when the transfer takes several idle limits', async (t) => {
  const { directory, target } = await scratchTarget(t);
  const pieces = Array.from({ length: 40 }, (_, index) => Buffer.from(String(index % 10)));
  const whole = Buffer.concat(pieces);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const nextArmed = armedTimers(t);
  const remote = drivenFetch();
  const download = downloadVerifiedArchive(remoteUrl, target, createHash('sha256').update(whole).digest('hex'), {
    idleTimeoutMs: 300,
    fetchImpl: remote.fetchImpl,
  });
  const body = await remote.nextBody(0);
  await body.nextRequest();
  for (const piece of pieces) {
    const idleArmed = nextArmed();
    body.push(piece);
    assert.equal(await armedOrSettled(idleArmed, download), 300);
    t.mock.timers.tick(250);
  }
  body.end();
  await download;
  assert.deepEqual(await fs.readFile(target), whole);
  assert.equal(remote.calls(), 1);
  assert.deepEqual(await fs.readdir(directory), ['archive.zip']);
});

test('a body that stalls mid-transfer is restarted and only the complete retry is published', async (t) => {
  const { directory, target } = await scratchTarget(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const nextArmed = armedTimers(t);
  const remote = drivenFetch();
  const download = downloadVerifiedArchive(remoteUrl, target, expected, {
    idleTimeoutMs: stallLimitMs,
    fetchImpl: remote.fetchImpl,
  });
  await stallAttempt(t, download, remote, nextArmed, 0, payload.subarray(0, 10), 250);
  const retry = await remote.nextBody(1);
  retry.push(payload);
  retry.end();
  await download;
  assert.deepEqual(await fs.readFile(target), payload);
  assert.equal(remote.calls(), 2);
  assert.deepEqual(await fs.readdir(directory), ['archive.zip']);
});

test('a body that stalls on every attempt fails with the stall, the host and the attempt count', async (t) => {
  const { directory, target } = await scratchTarget(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const nextArmed = armedTimers(t);
  const remote = drivenFetch();
  const download = downloadVerifiedArchive(remoteUrl, target, expected, {
    idleTimeoutMs: stallLimitMs,
    fetchImpl: remote.fetchImpl,
  });
  const failure = assert.rejects(download, {
    message: 'Archive download stalled from archive.invalid: no bytes for 0.2 s after 3 attempts.',
  });
  await stallAttempt(t, download, remote, nextArmed, 0, payload.subarray(0, 10), 250);
  await stallAttempt(t, download, remote, nextArmed, 1, payload.subarray(0, 10), 500);
  await stallAttempt(t, download, remote, nextArmed, 2, payload.subarray(0, 10), null);
  await failure;
  assert.equal(remote.calls(), 3);
  assert.deepEqual(await fs.readdir(directory), []);
});

test('a digest mismatch on a steadily streamed body is reported once and never retried', async (t) => {
  const { directory, target } = await scratchTarget(t);
  const { url, attempts } = await streamingServer(t, (attempt, response) => {
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    response.end(payload);
  });
  await assert.rejects(downloadVerifiedArchive(url, target, '0'.repeat(64)), /digest mismatch/);
  assert.equal(attempts(), 1);
  assert.deepEqual(await fs.readdir(directory), []);
});

test('an idle limit that a timer cannot hold is refused before any request', async (t) => {
  const { target } = await scratchTarget(t);
  for (const idleTimeoutMs of [Infinity, 0, -1, 2 ** 31]) {
    let requests = 0;
    const fetchImpl = async () => {
      requests += 1;
      return new Response(payload);
    };
    await assert.rejects(
      downloadVerifiedArchive('https://downloads.invalid/archive.zip', target, expected, { idleTimeoutMs, fetchImpl }),
      /Expected an idle timeout from 1 to 2147483647 milliseconds/,
      `idle limit ${idleTimeoutMs} must be refused`,
    );
    assert.equal(requests, 0, `idle limit ${idleTimeoutMs} must not reach the network`);
  }
});

test('the largest idle limit a timer holds is accepted and the verified archive is published', async (t) => {
  const { target } = await scratchTarget(t);
  let requests = 0;
  await downloadVerifiedArchive('https://downloads.invalid/archive.zip', target, expected, {
    idleTimeoutMs: 2 ** 31 - 1,
    fetchImpl: async () => {
      requests += 1;
      return new Response(payload);
    },
  });
  assert.equal(requests, 1);
  assert.deepEqual(await fs.readFile(target), payload);
});
