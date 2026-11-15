// @test-kind tooling: verified tool downloads reject unsafe content and bound transient retries.
import { ownedFixture, makeTemporaryDirectory } from '../mirage/testing/owned-fixture.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { downloadVerifiedArchive, ensureVerifiedArchive } from '../scripts/verified-download.mjs';
import { calledFrom } from '../mirage/test/support/timer-origin.mjs';

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
  ownedFixture(t).add(
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
  const host = new URL(url).host;
  await assert.rejects(downloadVerifiedArchive(url + '/permanent', target, expected), {
    message: `Archive download failed from ${host}: HTTP 404 (attempt 1).`,
  });
  await assert.rejects(downloadVerifiedArchive(url + '/unavailable', target, expected), {
    message: `Archive download failed from ${host}: HTTP 503 (attempt 3).`,
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
// A timer armed by other code in the process, such as a fetch connection of an earlier test, is not the download's.
const DOWNLOAD = new URL('../scripts/verified-download.mjs', import.meta.url).href;
function armedTimers(t) {
  const mocked = globalThis.setTimeout;
  let waiting = [];
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...rest) => {
    const timer = mocked(callback, delay, ...rest);
    if (calledFrom(DOWNLOAD, import.meta.url)) {
      const resolvers = waiting;
      waiting = [];
      for (const resolve of resolvers) resolve(delay);
    }
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

const token = 'invented-test-token';
const apiUrl = 'https://api.github.com/repos/owner/tool/releases/assets/1';

// Records every request and answers each one with the next reply; the last reply repeats.
function scriptedFetch(...replies) {
  const calls = [];
  return {
    calls,
    async fetchImpl(url, init) {
      calls.push({ url, authorization: new Headers(init.headers).get('authorization') });
      const [status, headers] = replies[Math.min(calls.length, replies.length) - 1];
      return status === 200 ? new Response(payload) : new Response(null, { status, headers });
    },
  };
}

// Each call of the returned function resolves with the delay of the next timer the code under test arms after that call
// that is not the idle watch, which is the wait before the next attempt. Install it after enabling the mock timers and
// before starting the download.
const idleTimeoutMs = 300;
function retryWaits(t) {
  const mocked = globalThis.setTimeout;
  let waiting = [];
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...rest) => {
    const timer = mocked(callback, ms, ...rest);
    if (ms !== idleTimeoutMs && calledFrom(DOWNLOAD, import.meta.url)) {
      const resolvers = waiting;
      waiting = [];
      for (const resolve of resolvers) resolve(ms);
    }
    return timer;
  });
  return () => new Promise((resolve) => waiting.push(resolve));
}
const retryArmed = (t) => retryWaits(t)();

// Fails the test if the download arms a wait instead of failing at once.
const noWait = (armed) => armed.then((delay) => assert.fail(`armed a ${delay} ms wait instead of failing`));

// A throttled reply, then a 200: the download arms exactly `wait` ms, sends nothing more until the wait has passed,
// then retries once and publishes the verified archive. `now` also mocks Date at that instant.
async function retriedAfterWait(t, { reply, wait, now, token: sent }) {
  const { directory, target } = await scratchTarget(t);
  t.mock.timers.enable(now === undefined ? { apis: ['setTimeout'] } : { apis: ['setTimeout', 'Date'], now });
  const armed = retryArmed(t);
  const remote = scriptedFetch(reply, [200]);
  const download = downloadVerifiedArchive(apiUrl, target, expected, {
    token: sent,
    idleTimeoutMs,
    fetchImpl: remote.fetchImpl,
  });
  assert.equal(await armedOrSettled(armed, download), wait);
  if (wait > 0) {
    t.mock.timers.tick(wait - 1);
    assert.equal(remote.calls.length, 1);
  }
  t.mock.timers.tick(Math.min(wait, 1));
  await download;
  assert.equal(remote.calls.length, 2);
  assert.deepEqual(await fs.readFile(target), payload);
  assert.deepEqual(await fs.readdir(directory), ['archive.zip']);
  return remote;
}

test('the token is sent only to the GitHub API origin', async (t) => {
  const { target } = await scratchTarget(t);
  const remote = scriptedFetch([200]);
  const others = [
    'https://github.com/owner/tool/releases/download/v1/tool.zip',
    'https://codeload.github.com/owner/tool/tar.gz/0123456789abcdef',
    apiUrl.replace('https:', 'http:'), // the API host over plain HTTP is another origin
    'https://api.github.com.example.test/repos/owner/tool/releases/assets/1',
    'https://api.github.com:8443/repos/owner/tool/releases/assets/1',
  ];
  for (const url of [apiUrl, ...others])
    await downloadVerifiedArchive(url, target, expected, { token, fetchImpl: remote.fetchImpl });
  assert.deepEqual(
    remote.calls.map((call) => call.authorization),
    [`Bearer ${token}`, ...others.map(() => null)],
  );
  await downloadVerifiedArchive(apiUrl, target, expected, { fetchImpl: remote.fetchImpl });
  assert.equal(remote.calls.at(-1).authorization, null, 'no token, no authorization header');
});

test('fetch drops the authorization header on a cross-origin redirect', async (t) => {
  const seen = [];
  const listen = async (handler) => {
    const server = http.createServer((request, response) => {
      seen.push({ url: request.url, authorization: request.headers.authorization ?? null });
      handler(request, response);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    ownedFixture(t).add(
      () =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(resolve);
        }),
    );
    return `http://127.0.0.1:${server.address().port}`;
  };
  // A different port is a different origin, as the asset host is for the API host.
  const assetHost = await listen((request, response) => response.end(payload));
  const apiHost = await listen((request, response) => {
    if (request.url === '/same') response.writeHead(302, { location: '/landed' }).end();
    else if (request.url === '/landed') response.end(payload);
    else response.writeHead(302, { location: `${assetHost}/asset` }).end();
  });
  const headers = { accept: 'application/octet-stream', authorization: `Bearer ${token}` };
  for (const route of ['/cross', '/same']) {
    const response = await fetch(apiHost + route, { headers });
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), payload, route);
  }
  assert.deepEqual(seen, [
    { url: '/cross', authorization: `Bearer ${token}` },
    { url: '/asset', authorization: null },
    { url: '/same', authorization: `Bearer ${token}` },
    { url: '/landed', authorization: `Bearer ${token}` },
  ]);
});

test('a 403 with retry-after waits as instructed and then publishes the verified archive', async (t) => {
  const remote = await retriedAfterWait(t, { reply: [403, { 'retry-after': '1' }], wait: 1000, token });
  assert.ok(remote.calls.every((call) => call.authorization === `Bearer ${token}`));
});

test('a 403 with remaining 0 waits until the reset', async (t) => {
  const now = 1_800_000_000_000;
  const throttled = { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 2) };
  await retriedAfterWait(t, { reply: [403, throttled], wait: 2000, now });
});

test('a 401 to a request with a token is repeated once without it and publishes the verified archive', async (t) => {
  const { directory, target } = await scratchTarget(t);
  const remote = scriptedFetch([401], [200]);
  await downloadVerifiedArchive(apiUrl, target, expected, { token, fetchImpl: remote.fetchImpl });
  assert.deepEqual(
    remote.calls.map((call) => call.authorization),
    [`Bearer ${token}`, null],
  );
  assert.deepEqual(await fs.readFile(target), payload);
  assert.deepEqual(await fs.readdir(directory), ['archive.zip']);
});

test('a 401 to a request without a token, or to the anonymous repeat, fails at once and names the host', async (t) => {
  const { directory, target } = await scratchTarget(t);
  for (const sent of [undefined, token]) {
    const remote = scriptedFetch([401]);
    await assert.rejects(
      downloadVerifiedArchive(apiUrl, target, expected, { token: sent, fetchImpl: remote.fetchImpl }),
      {
        message: 'Archive download failed from api.github.com: HTTP 401 (attempt 1).',
      },
    );
    assert.deepEqual(
      remote.calls.map((call) => call.authorization),
      sent ? [`Bearer ${token}`, null] : [null],
    );
  }
  assert.deepEqual(await fs.readdir(directory), []);
});

test('a 403 without throttle headers fails at once and names the host', async (t) => {
  const { directory, target } = await scratchTarget(t);
  const remote = scriptedFetch([403]);
  await assert.rejects(downloadVerifiedArchive(apiUrl, target, expected, { token, fetchImpl: remote.fetchImpl }), {
    message: 'Archive download failed from api.github.com: HTTP 403 (attempt 1).',
  });
  assert.equal(remote.calls.length, 1);
  assert.deepEqual(await fs.readdir(directory), []);
});

test('a throttle beyond the bound fails at once with the header values', async (t) => {
  const { directory, target } = await scratchTarget(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const armed = retryArmed(t);
  const remote = scriptedFetch([403, { 'retry-after': '3600' }]);
  const download = downloadVerifiedArchive(apiUrl, target, expected, { idleTimeoutMs, fetchImpl: remote.fetchImpl });
  const waited = armed.then((delay) => assert.fail(`armed a ${delay} ms wait instead of failing`));
  await Promise.race([
    assert.rejects(download, {
      message:
        'Archive download throttled by api.github.com: HTTP 403 (retry-after=3600, x-ratelimit-remaining=absent, ' +
        'x-ratelimit-reset=absent); the requested wait of 3600 s exceeds the 60 s bound.',
    }),
    waited,
  ]);
  assert.equal(remote.calls.length, 1);
  assert.deepEqual(await fs.readdir(directory), []);
});

test('a 429 without headers waits one minute', async (t) => {
  await retriedAfterWait(t, { reply: [429], wait: 60_000 });
});

test('no error message, thrown or logged, contains the token', async (t) => {
  const { target } = await scratchTarget(t);
  const logged = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'])
    t.mock.method(console, method, (...args) => logged.push(args.join(' ')));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const failures = [
    scriptedFetch([403]),
    scriptedFetch([404]),
    scriptedFetch([403, { 'retry-after': '3600' }]),
    scriptedFetch([403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '99999999999' }]),
  ];
  const messages = [];
  for (const remote of failures)
    await downloadVerifiedArchive(apiUrl, target, expected, { token, fetchImpl: remote.fetchImpl }).catch((error) =>
      messages.push(error.message),
    );
  await downloadVerifiedArchive(apiUrl, target, '0'.repeat(64), {
    token,
    fetchImpl: scriptedFetch([200]).fetchImpl,
  }).catch((error) => messages.push(error.message));
  for (const invalid of ['', 42])
    await downloadVerifiedArchive(apiUrl, target, expected, {
      token: invalid,
      fetchImpl: scriptedFetch([200]).fetchImpl,
    }).catch((error) => messages.push(error.message));
  assert.equal(messages.length, 7, 'every case fails');
  assert.ok(failures.every((remote) => remote.calls[0].authorization === `Bearer ${token}`));
  for (const text of [...messages, ...logged]) assert.ok(!text.includes(token), text);
  assert.equal(messages.at(-1), 'Expected a non-empty token string.');
});

// GitHub's reset is an instant on GitHub's clock, so the wait is measured from the response's own date.
const served = 1_800_000_000_000;
for (const [clock, offset] of [
  ['ahead', 3_600_000],
  ['behind', -3_600_000],
])
  test(`the wait until the reset follows the response date with the local clock an hour ${clock}`, async (t) => {
    const throttled = {
      date: new Date(served).toUTCString(),
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(served / 1000 + 2),
    };
    await retriedAfterWait(t, { reply: [403, throttled], wait: 2000, now: served + offset });
  });

test('a reset already past by the response date retries without a wait', async (t) => {
  const throttled = {
    date: new Date(served).toUTCString(),
    'x-ratelimit-remaining': '0',
    'x-ratelimit-reset': String(served / 1000 - 2),
  };
  await retriedAfterWait(t, { reply: [403, throttled], wait: 0, now: served });
});

test('an unparseable response date measures the wait until the reset by the local clock', async (t) => {
  const throttled = {
    date: 'not a date',
    'x-ratelimit-remaining': '0',
    'x-ratelimit-reset': String(served / 1000 + 2),
  };
  await retriedAfterWait(t, { reply: [403, throttled], wait: 2000, now: served });
});

test('a 403 with rate-limit headers and requests remaining is a refusal that fails at once', async (t) => {
  const { directory, target } = await scratchTarget(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: served });
  const armed = retryArmed(t);
  const limited = { 'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': String(served / 1000 + 5) };
  const remote = scriptedFetch([403, limited]);
  const download = downloadVerifiedArchive(apiUrl, target, expected, { idleTimeoutMs, fetchImpl: remote.fetchImpl });
  await Promise.race([
    assert.rejects(download, { message: 'Archive download failed from api.github.com: HTTP 403 (attempt 1).' }),
    noWait(armed),
  ]);
  assert.equal(remote.calls.length, 1);
  assert.deepEqual(await fs.readdir(directory), []);
});

test('three throttled replies in a row end the download as still throttled after three requests', async (t) => {
  const { directory, target } = await scratchTarget(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const nextWait = retryWaits(t);
  let armed = nextWait();
  const remote = scriptedFetch([403, { 'retry-after': '1' }]);
  const download = downloadVerifiedArchive(apiUrl, target, expected, { idleTimeoutMs, fetchImpl: remote.fetchImpl });
  for (let wait = 0; wait < 2; wait++) {
    assert.equal(await armedOrSettled(armed, download), 1000);
    armed = nextWait();
    t.mock.timers.tick(1000);
  }
  await Promise.race([
    assert.rejects(download, {
      message:
        'Archive download throttled by api.github.com: HTTP 403 (retry-after=1, x-ratelimit-remaining=absent, ' +
        'x-ratelimit-reset=absent); still throttled after 3 attempts.',
    }),
    noWait(armed),
  ]);
  assert.equal(remote.calls.length, 3);
  assert.deepEqual(await fs.readdir(directory), []);
});

// A retry-after that is not whole seconds is ignored: each reply is decided as if it carried no retry-after.
const notSeconds = ['Wed, 21 Oct 2026 07:28:00 GMT', '-1'];
for (const retryAfter of notSeconds) {
  test(`a 403 with retry-after ${retryAfter} and no other header fails at once`, async (t) => {
    const { target } = await scratchTarget(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const armed = retryArmed(t);
    const remote = scriptedFetch([403, { 'retry-after': retryAfter }]);
    const download = downloadVerifiedArchive(apiUrl, target, expected, { idleTimeoutMs, fetchImpl: remote.fetchImpl });
    await Promise.race([
      assert.rejects(download, { message: 'Archive download failed from api.github.com: HTTP 403 (attempt 1).' }),
      noWait(armed),
    ]);
    assert.equal(remote.calls.length, 1);
  });

  test(`a 403 with retry-after ${retryAfter} and an exhausted limit waits until the reset`, async (t) => {
    const throttled = {
      'retry-after': retryAfter,
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(served / 1000 + 2),
    };
    await retriedAfterWait(t, { reply: [403, throttled], wait: 2000, now: served });
  });

  test(`a 429 with retry-after ${retryAfter} waits one minute`, async (t) => {
    await retriedAfterWait(t, { reply: [429, { 'retry-after': retryAfter }], wait: 60_000 });
  });
}

test('transient HTTP errors wait 250 ms and then 500 ms between the three attempts', async (t) => {
  const { directory, target } = await scratchTarget(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const nextWait = retryWaits(t);
  let armed = nextWait();
  const remote = scriptedFetch([503]);
  const download = downloadVerifiedArchive(apiUrl, target, expected, { idleTimeoutMs, fetchImpl: remote.fetchImpl });
  for (const delay of [250, 500]) {
    assert.equal(await armedOrSettled(armed, download), delay);
    armed = nextWait();
    assert.equal(remote.calls.length, delay / 250);
    t.mock.timers.tick(delay);
  }
  await Promise.race([
    assert.rejects(download, { message: 'Archive download failed from api.github.com: HTTP 503 (attempt 3).' }),
    noWait(armed),
  ]);
  assert.equal(remote.calls.length, 3);
  assert.deepEqual(await fs.readdir(directory), []);
});

test('a cached archive that matches its pin is used without a request', async (t) => {
  const { directory, target } = await scratchTarget(t);
  await fs.writeFile(target, payload);
  const remote = scriptedFetch([500]);
  await ensureVerifiedArchive(apiUrl, target, expected, { fetchImpl: remote.fetchImpl });
  assert.equal(remote.calls.length, 0);
  assert.deepEqual(await fs.readFile(target), payload);
  assert.deepEqual(await fs.readdir(directory), ['archive.zip']);
});

test('a cached archive that fails its pin is removed and replaced by one verified download', async (t) => {
  const { directory, target } = await scratchTarget(t);
  await fs.writeFile(target, 'tampered cache');
  const remote = scriptedFetch([200]);
  await ensureVerifiedArchive(apiUrl, target, expected, { token, fetchImpl: remote.fetchImpl });
  assert.deepEqual(remote.calls, [{ url: apiUrl, authorization: `Bearer ${token}` }]);
  assert.deepEqual(await fs.readFile(target), payload);
  assert.deepEqual(await fs.readdir(directory), ['archive.zip']);
});

test('a tampered cache and a tampered download fail and leave no archive behind', async (t) => {
  const { directory, target } = await scratchTarget(t);
  await fs.writeFile(target, 'tampered cache');
  const fetchImpl = async () => new Response('tampered download');
  await assert.rejects(ensureVerifiedArchive(apiUrl, target, expected, { fetchImpl }), {
    message: 'Archive digest mismatch; no unverified content was saved.',
  });
  assert.deepEqual(await fs.readdir(directory), []);
});
