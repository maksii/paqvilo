// Core Azurite transport (storage-azurite.mjs): Shared Key signing, connection strings, loopback-only endpoints,
// error mapping with the Azure code, authenticated preflight, SAS URLs the endpoint accepts, and the key kept out of output.
// @test-kind contract: the Azurite fake is a shipped test double whose request handling this file pins, including aborted uploads
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { startAzuriteFake, FAKE_ACCOUNT_KEY } from '../testing/azurite-fake.mjs';
import {
  BLOB_API_VERSION,
  azuriteDescriptor,
  createAzuriteStorage,
  parseConnectionString,
  preflight,
  sharedKeyStringToSign,
} from '../lib/storage-azurite.mjs';
import {
  PREFLIGHT_IDLE_TIMEOUT_MS,
  ProviderError,
  guardProvider,
  preflightProvider,
} from '../lib/storage-provider.mjs';
import { silentEndpointPort } from './support/emulator-transport.mjs';

const fake = await startAzuriteFake();
test.after(() => fake.close());
let containers = 0;
const azurite = (connectionString = fake.connectionString(), extra = {}) =>
  guardProvider(
    createAzuriteStorage({
      id: 'fxblob',
      settings: { connectionString: 'env:FX_AZURITE', container: `fx-transport-${++containers}` },
      env: { FX_AZURITE: connectionString },
      ...extra,
    }),
  );
const code = (expected, diagnostic) => (error) => {
  assert.ok(error instanceof ProviderError, error?.message);
  assert.equal(error.code, expected);
  if (diagnostic) assert.equal(error.diagnostic, diagnostic);
  return true;
};

// @test-kind security: a request with an invalid signature is refused with 403 and cannot crash the fake
test('prototype-shaped query names are signed as data and an invalid signature cannot crash the loopback fake', async () => {
  const response = await fetch(fake.blobEndpoint + '/invented?__proto__=x&constructor=y&toString=z', {
    headers: {
      authorization: `SharedKey ${fake.accountName}:invalid`,
      'x-ms-date': new Date().toUTCString(),
      'x-ms-version': BLOB_API_VERSION,
    },
  });
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('x-ms-error-code'), 'AuthenticationFailed');
  assert.equal((await azurite().preflight()).ready, true);
});

test('the Shared Key string-to-sign matches the Get Container Metadata example on Learn', () => {
  const text = sharedKeyStringToSign({
    method: 'GET',
    accountName: 'myaccount',
    url: 'http://myaccount.blob.core.windows.net/mycontainer?restype=container&comp=metadata&timeout=20',
    headers: { 'x-ms-date': 'Fri, 26 Jun 2015 23:39:12 GMT', 'x-ms-version': '2015-02-21' },
  });
  assert.equal(
    text,
    'GET\n\n\n\n\n\n\n\n\n\n\n\nx-ms-date:Fri, 26 Jun 2015 23:39:12 GMT\nx-ms-version:2015-02-21\n/myaccount/mycontainer\ncomp:metadata\nrestype:container\ntimeout:20',
  );
  // Content-Length is an empty line when zero (2015-02-21 and later).
  const zero = sharedKeyStringToSign({
    method: 'put',
    accountName: 'a',
    url: 'http://127.0.0.1/a/c?restype=container',
    headers: { 'content-length': '0' },
  });
  assert.ok(zero.startsWith('PUT\n\n\n\n\n'));
});

// @test-kind security: the storage endpoint must be loopback and key values are never echoed
test('connection strings: development shortcut, explicit form, loopback only, values never echoed', () => {
  const dev = parseConnectionString('UseDevelopmentStorage=true');
  assert.equal(dev.accountName, 'devstoreaccount1');
  assert.equal(dev.blobEndpoint, 'http://127.0.0.1:10000/devstoreaccount1');
  const explicit = parseConnectionString(
    `AccountName=fxaccount;AccountKey=${FAKE_ACCOUNT_KEY};BlobEndpoint=http://localhost:10000/fxaccount/`,
  );
  assert.deepEqual(explicit, {
    accountName: 'fxaccount',
    accountKey: FAKE_ACCOUNT_KEY,
    blobEndpoint: 'http://localhost:10000/fxaccount',
  });
  const remote = parseConnectionString(
    `AccountName=fx;AccountKey=${FAKE_ACCOUNT_KEY};BlobEndpoint=https://fxstore.example.test`,
    'FX_VAR',
  );
  assert.equal(remote.error.diagnostic, 'PROVIDER_NOT_LOOPBACK');
  assert.doesNotMatch(remote.error.message, /example\.test|AccountKey=/);
  assert.match(remote.error.message, /FX_VAR/);
  assert.equal(
    parseConnectionString('AccountName=fx;BlobEndpoint=http://127.0.0.1:1/fx').error.message,
    'AccountKey in the connection string is missing or not base64.',
  );
});

test('every request carries the pinned x-ms-version and the container is created once, on first write', async () => {
  const s = azurite();
  const before = fake.requests.length;
  await s.put('fx/a.txt', Buffer.from('a'));
  await s.put('fx/b.txt', Buffer.from('b'));
  const seen = fake.requests.slice(before);
  assert.ok(seen.every((request) => request.version === BLOB_API_VERSION));
  assert.equal(
    seen.filter(
      (request) => request.method === 'PUT' && request.query.includes('restype') && !request.query.includes('comp'),
    ).length,
    1,
  );
  assert.equal(s.descriptor.level, 'behaviour');
});

test('a missing blob is NotFound with the Azure code; an ETag mismatch is PreconditionFailed; a range is honoured', async () => {
  const s = azurite();
  await s.put('fx/seed', Buffer.from('0123456789'));
  await assert.rejects(s.get('fx/missing'), code('NotFound', 'BlobNotFound'));
  await assert.rejects(
    s.put('fx/seed', Buffer.from('x'), { ifMatch: '"0x0"' }),
    code('PreconditionFailed', 'ConditionNotMet'),
  );
  const chunks = [];
  for await (const chunk of (await s.get('fx/seed', { range: { start: 3, end: 4 } })).body)
    chunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(chunks).toString(), '34');
});

// @test-kind security: a wrong account key is refused and never echoed
test('a wrong account key is refused with 403 by the endpoint and maps to Unauthorized without the key', async () => {
  const wrong = Buffer.from('fx-a-different-invented-key').toString('base64');
  const s = azurite(fake.connectionString(wrong));
  const error = await s.put('fx/denied', Buffer.from('x')).catch((e) => e);
  assert.ok(code('Unauthorized', 'AuthenticationFailed')(error));
  for (const text of [error.message, JSON.stringify(error), JSON.stringify(s.descriptor)]) {
    assert.ok(!text.includes(wrong) && !text.includes(FAKE_ACCOUNT_KEY));
  }
  const probe = await s.preflight();
  assert.equal(probe.ready, false);
  assert.match(probe.reason, /403 AuthenticationFailed/);
  assert.ok(!probe.reason.includes(wrong));
});

test('preflight runs an authorized List Containers: ready against the endpoint, the reason otherwise', async () => {
  assert.deepEqual(await azurite().preflight(), { ready: true });
  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const { port } = closed.address();
  await new Promise((resolve) => closed.close(resolve));
  const down = azurite(`AccountName=fx;AccountKey=${FAKE_ACCOUNT_KEY};BlobEndpoint=http://127.0.0.1:${port}/fx`);
  const probe = await down.preflight();
  assert.equal(probe.ready, false);
  assert.match(probe.reason, /not reachable .*npx azurite/);
  await assert.rejects(down.head('fx/x'), code('Unavailable', 'PROVIDER_UNREACHABLE'));
});

// @test-kind security: a non-loopback connection string never produces a live endpoint
test('an unset, invalid or non-loopback connection string leaves a contract-level instance that answers Unavailable', async () => {
  const unset = guardProvider(
    createAzuriteStorage({ id: 'fxblob', settings: { connectionString: 'env:FX_UNSET_AZURITE' }, env: {} }),
  );
  assert.equal(unset.descriptor.level, 'contract');
  assert.deepEqual(await unset.preflight(), {
    ready: false,
    reason: 'Environment variable FX_UNSET_AZURITE is not set.',
  });
  await assert.rejects(unset.put('fx/x', Buffer.from('x')), code('Unavailable', 'PROVIDER_SECRET_MISSING'));
  const remote = azurite(`AccountName=fx;AccountKey=${FAKE_ACCOUNT_KEY};BlobEndpoint=https://fxstore.example.test/fx`);
  await assert.rejects(
    remote.get('fx/x'),
    (error) => code('Unavailable', 'PROVIDER_NOT_LOOPBACK')(error) && !error.message.includes('example.test'),
  );
  assert.equal(azuriteDescriptor.level, 'contract');
});

test('a SAS URL from sas() downloads the blob from the endpoint, which verifies it independently', async () => {
  const s = azurite();
  await s.put('fx/shared.txt', Buffer.from('shared bytes'), { contentType: 'text/plain' });
  const url = await s.sas('fx/shared.txt', { permission: 'r', expiresOn: Date.now() + 60_000 });
  assert.ok(url.startsWith(`${fake.blobEndpoint}/`));
  assert.match(url, /[?&]sv=2021-08-06&sr=b&sp=r&se=/);
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'shared bytes');
  const tampered = new URL(url);
  tampered.searchParams.set('sp', 'rw');
  assert.equal((await fetch(tampered)).status, 403);
});

test('a data operation against an endpoint that never answers is Unavailable once timeoutMs fires', async (t) => {
  const net = await import('node:net');
  const sockets = new Set();
  const silent = net.createServer((socket) => sockets.add(socket)); // accepts, never answers
  await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => silent.close(resolve));
  });
  const s = guardProvider(
    createAzuriteStorage({
      id: 'fxblob',
      settings: { connectionString: 'env:FX_AZURITE', timeoutMs: 300 },
      env: {
        FX_AZURITE: `AccountName=fx;AccountKey=${FAKE_ACCOUNT_KEY};BlobEndpoint=http://127.0.0.1:${silent.address().port}/fx`,
      },
    }),
  );
  // The message carries the configured limit, so the 30 s default cannot pass for it.
  await assert.rejects(
    s.head('fx/slow'),
    (error) => code('Unavailable', 'PROVIDER_UNREACHABLE')(error) && /no answer within 300 ms/.test(error.message),
  );
  assert.deepEqual(s.descriptor.level, 'behaviour');
});

test('a 9 MiB upload is three 4 MiB-or-less Put Block calls and one Put Block List', async () => {
  const s = azurite();
  await s.put('fx/warm', Buffer.from('x')); // creates the container first
  const before = fake.requests.length;
  const body = Buffer.alloc(9 * 1024 * 1024, 7);
  const put = await s.put('fx/nine.bin', body);
  const seen = fake.requests.slice(before).filter((request) => request.method === 'PUT');
  assert.equal(seen.filter((request) => request.query.includes('blockid')).length, 3);
  assert.equal(
    seen.filter((request) => request.query.includes('comp') && !request.query.includes('blockid')).length,
    1,
  );
  assert.equal(put.size, body.length);
  const blocks = [...fake.containers.values()]
    .find((container) => container.has('fx/nine.bin'))
    .get('fx/nine.bin').committedBlocks;
  assert.deepEqual(
    [...blocks.values()].map((block) => block.length),
    [4 * 1024 * 1024, 4 * 1024 * 1024, 1024 * 1024],
  );
});

test('a container removed after start is created again and the write retried once', async () => {
  const name = `fx-transport-${containers + 1}`;
  const s = azurite();
  await s.put('fx/first', Buffer.from('1'));
  fake.containers.delete(name); // as an in-memory Azurite restart
  const put = await s.put('fx/second', Buffer.from('2'));
  assert.equal(put.size, 1);
  assert.ok(fake.containers.get(name).has('fx/second'));
});

test('health() reports the last observed endpoint state without the key', async () => {
  const raw = createAzuriteStorage({
    id: 'fxblob',
    settings: { connectionString: 'env:FX_AZURITE', container: `fx-health-${++containers}` },
    env: { FX_AZURITE: fake.connectionString() },
  });
  assert.deepEqual(raw.health(), { ready: null, reason: 'Not contacted yet.' });
  await raw.put('fx/h', Buffer.from('h'));
  assert.deepEqual(raw.health(), { ready: true, reason: null });
  const wrong = Buffer.from('fx-a-different-invented-key').toString('base64');
  const denied = createAzuriteStorage({
    id: 'fxblob',
    settings: { connectionString: 'env:FX_AZURITE' },
    env: { FX_AZURITE: fake.connectionString(wrong) },
  });
  await denied.head('fx/h').catch(() => {});
  assert.equal(denied.health().ready, false);
  assert.match(denied.health().reason, /403 AuthenticationFailed/);
  assert.ok(!JSON.stringify(denied.health()).includes(wrong));
  assert.equal(
    createAzuriteStorage({ id: 'fxblob', settings: { connectionString: 'env:FX_UNSET' }, env: {} }).health().ready,
    false,
  );
});

const watchUnhandledRejections = () => {
  const reasons = [];
  let notify;
  const first = new Promise((resolve) => {
    notify = resolve;
  });
  const listener = (reason) => {
    reasons.push(reason);
    notify(reasons);
  };
  process.on('unhandledRejection', listener);
  return { reasons, first, stop: () => process.off('unhandledRejection', listener) };
};

const readUntil = (socket, text) =>
  new Promise((resolve) => {
    let seen = '';
    const onData = (chunk) => {
      seen += chunk;
      if (seen.includes(text)) {
        socket.off('data', onData);
        resolve();
      }
    };
    socket.setEncoding('latin1');
    socket.on('data', onData);
  });

test('a client that aborts an upload mid-body leaves no unhandled rejection and the fake keeps answering', async () => {
  const unhandled = watchUnhandledRejections();
  let markAborted;
  const aborted = new Promise((resolve) => {
    markAborted = resolve;
  });
  const server = await startAzuriteFake({ onBodyAbort: () => markAborted('body aborted') });
  try {
    const socket = net.connect(Number(new URL(server.blobEndpoint).port), '127.0.0.1');
    socket.on('error', () => socket.destroy());
    socket.write(
      'PUT /devstoreaccount1/c/b HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100\r\nExpect: 100-continue\r\n\r\n',
    );
    await readUntil(socket, 'HTTP/1.1 100 Continue');
    socket.write('0123456789');
    socket.destroy();
    const outcome = await Promise.race([aborted, unhandled.first]);
    assert.equal(outcome, 'body aborted', `unhandled rejection: ${unhandled.reasons[0]?.message}`);
    const reply = await fetch(`${server.blobEndpoint}/after-abort`);
    assert.equal(reply.status, 403);
    assert.deepEqual(unhandled.reasons, []);
  } finally {
    unhandled.stop();
    await server.close();
  }
});

test('a request path that is not valid percent-encoding is answered 400 InvalidUri', async () => {
  const unhandled = watchUnhandledRejections();
  try {
    const reply = await Promise.race([
      fetch(`${fake.blobEndpoint}/%zz`),
      unhandled.first.then((reasons) => assert.fail(`unhandled rejection: ${reasons[0]?.message}`)),
    ]);
    assert.equal(reply.status, 400);
    assert.equal(reply.headers.get('x-ms-error-code'), 'InvalidUri');
    assert.match(await reply.text(), /<Code>InvalidUri<\/Code>/);
    assert.deepEqual(unhandled.reasons, []);
  } finally {
    unhandled.stop();
  }
});

test('the List Containers preflight of an endpoint that never answers is ended by the idle guard, not a fixed 2 s bound', async (t) => {
  const port = await silentEndpointPort(t);
  const s = azurite(`AccountName=fx;AccountKey=${FAKE_ACCOUNT_KEY};BlobEndpoint=http://127.0.0.1:${port}/fx`);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const probe = preflightProvider(s);
  // The probe starts on the next microtask turn; its idle guard exists from the call, and the clock advances only here.
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(PREFLIGHT_IDLE_TIMEOUT_MS - 1);
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(1);
  assert.deepEqual(await probe, { ready: false, reason: 'The provider gave no answer for 30000 ms.' });
});

// Resolves to a loopback URL of a relay in front of the fake. The relay holds each answer of the fake for 10 mocked seconds;
// 'held' is emitted when an answer is held, so the test ticks the clock only after the answer exists.
async function slowFakeEndpoint(t, fakeEndpoint) {
  const events = new EventEmitter();
  const fakePort = new URL(fakeEndpoint).port;
  const relay = http.createServer((request, response) => {
    const upstream = http.request(
      { host: '127.0.0.1', port: fakePort, path: request.url, method: request.method, headers: request.headers },
      (answer) => {
        events.emit('held');
        setTimeout(() => {
          response.writeHead(answer.statusCode, answer.headers);
          answer.pipe(response);
        }, 10_000);
      },
    );
    upstream.end();
  });
  await new Promise((resolve) => relay.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    relay.closeAllConnections();
    await new Promise((resolve) => relay.close(resolve));
  });
  return { url: `http://127.0.0.1:${relay.address().port}/devstoreaccount1`, events };
}

test('the exported preflight answers within the idle window: an endpoint that answers after 10 mocked seconds is ready by default', async (t) => {
  const { url, events } = await slowFakeEndpoint(t, fake.blobEndpoint);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const held = once(events, 'held');
  const probe = preflight({ blobEndpoint: url });
  await held;
  t.mock.timers.tick(10_000);
  const result = await probe;
  assert.equal(result.reachable, true, result.message);
});

test('the exported preflight with the default is ended by the idle window at 30 s, not by a 2 s bound', async (t) => {
  const port = await silentEndpointPort(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let settled = false;
  const probe = preflight({ blobEndpoint: `http://127.0.0.1:${port}/devstoreaccount1` }).then((result) => {
    settled = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(PREFLIGHT_IDLE_TIMEOUT_MS - 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'the idle window has not ended one millisecond early');
  t.mock.timers.tick(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, true, 'the idle window ended the probe at 30 s');
  const result = await probe;
  assert.equal(result.reachable, false);
  assert.match(result.message, /no answer within 30000 ms/);
});
