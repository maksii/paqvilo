// @test-kind contract: Paqvilo's own local-service declarations, probe bounds (the shared idle window, or the caller's timeoutMs) and capability records.
// localServices: loopback-only validation, probes against a loopback stub, a refusing port and a redirect, the
// Service Bus declaration without printing its connection string, and the capability records.
import { ownedFixture } from '../testing/owned-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { localServiceSettings, preflightLocalServices, describeLocalServices } from '../lib/local-services.mjs';
import { PREFLIGHT_IDLE_TIMEOUT_MS } from '../lib/storage-provider.mjs';

async function stub(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  ownedFixture(t).add(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}
// A port this test owns that refuses every request: each connection is closed unanswered.
async function refusingPort(t) {
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  ownedFixture(t).add(() => new Promise((resolve) => server.close(resolve)));
  return server.address().port;
}

// @test-kind security: local services must be loopback and cannot carry connection strings
test('the validator accepts loopback services and rejects other hosts, connection strings and unknown keys', () => {
  const settings = localServiceSettings({
    functions: { kind: 'http', baseUrl: 'http://localhost:7071', probe: '/admin/host/status', required: true },
    azurite: {
      kind: 'azure-storage',
      blob: 'http://127.0.0.1:10000/devstoreaccount1',
      probe: '/devstoreaccount1?comp=list',
    },
    servicebus: { kind: 'service-bus', connectionStringVariable: 'FX_SB_EMULATOR' },
    'fx-api': { kind: 'http', baseUrl: 'http://[::1]:5000' },
  });
  assert.equal(settings.functions.required, true);
  assert.equal(settings.azurite.required, false);
  assert.throws(
    () => localServiceSettings({ functions: { kind: 'http', baseUrl: 'https://fx.example.test' } }),
    /localhost/,
  );
  assert.throws(
    () =>
      localServiceSettings({
        functions: { kind: 'http', baseUrl: 'http://127.0.0.1:7071', probe: '//fx.example.test/x' },
      }),
    /probe/,
  );
  assert.throws(
    () => localServiceSettings({ azurite: { kind: 'azure-storage', blob: 'http://fx.example.test:10000' } }),
    /localhost/,
  );
  assert.throws(
    () =>
      localServiceSettings({
        servicebus: { kind: 'service-bus', connectionString: 'Endpoint=sb://localhost;SharedAccessKey=x' },
      }),
    /never live in config/,
  );
  assert.throws(() => localServiceSettings({ functions: { kind: 'ftp' } }), /kind/);
  assert.throws(
    () => localServiceSettings({ functions: { kind: 'http', baseUrl: 'http://localhost:7071', extra: 1 } }),
    /Unknown/,
  );
});

// @test-kind security: a service URL cannot carry credentials
test('baseUrl and blob reject credentials, query strings and fragments', () => {
  for (const baseUrl of [
    'http://u:p@localhost:7071',
    'http://u@localhost:7071',
    'http://localhost:7071/?code=k',
    'http://localhost:7071/#k',
  ]) {
    assert.throws(
      () => localServiceSettings({ functions: { kind: 'http', baseUrl } }),
      /plain http\(s\) URL without credentials, query or fragment/,
    );
  }
  assert.throws(
    () =>
      localServiceSettings({
        azurite: { kind: 'azure-storage', blob: 'http://127.0.0.1:10000/devstoreaccount1?sv=k' },
      }),
    /without credentials/,
  );
  assert.equal(
    localServiceSettings({ functions: { kind: 'http', baseUrl: 'http://localhost:7071/' } }).functions.baseUrl,
    'http://localhost:7071/',
  );
});

test('preflight reports a loopback stub, a refusing port and a refused redirect without throwing', async (t) => {
  const origin = await stub(t, (req, res) => {
    if (req.url === '/moved') {
      res.writeHead(302, { location: 'http://fx.example.test/' });
      return res.end();
    }
    res.writeHead(200);
    res.end('ok');
  });
  const port = await refusingPort(t);
  const results = await preflightLocalServices(
    {
      functions: { kind: 'http', baseUrl: origin, probe: '/admin/host/status?code=fx-function-key', required: true },
      gone: { kind: 'http', baseUrl: `http://127.0.0.1:${port}` },
      moved: { kind: 'http', baseUrl: origin, probe: '/moved' },
    },
    { timeoutMs: 30_000 },
  );
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));
  assert.deepEqual([byId.functions.reachable, byId.functions.status, byId.functions.required], [true, 200, true]);
  assert.doesNotMatch(byId.functions.message, /fx-function-key/);
  assert.equal(byId.gone.reachable, false);
  assert.equal(byId.moved.reachable, false);
  assert.match(byId.moved.message, /redirect/);
});

// @test-kind security: a redirect away from the loopback service is refused
test('an injected fetch that returns a redirect response is still refused', async () => {
  const [result] = await preflightLocalServices(
    { fx: { kind: 'http', baseUrl: 'http://localhost:9' } },
    { fetch: async () => new Response(null, { status: 301 }) },
  );
  assert.deepEqual([result.reachable, result.status], [false, 301]);
});

test('invalid settings answer one result instead of throwing', async () => {
  const [result] = await preflightLocalServices({ fx: { kind: 'http', baseUrl: 'http://fx.example.test' } });
  assert.equal(result.reachable, false);
  assert.match(result.message, /localhost/);
});

// @test-kind security: a declaration never reports its connection string
test('a Service Bus declaration never reports its connection string', async () => {
  const secret =
    'Endpoint=sb://fx.example.test;SharedAccessKeyName=k;SharedAccessKey=fx-sb-key;UseDevelopmentEmulator=true';
  const results = await preflightLocalServices(
    { servicebus: { kind: 'service-bus', connectionStringVariable: 'FX_SB' } },
    { env: { FX_SB: secret } },
  );
  assert.equal(results[0].reachable, false);
  assert.doesNotMatch(JSON.stringify(results), /fx-sb-key|SharedAccessKey/);
  const unset = await preflightLocalServices(
    { servicebus: { kind: 'service-bus', connectionStringVariable: 'FX_SB' } },
    { env: {} },
  );
  assert.match(unset[0].message, /FX_SB is not set/);
});

test('describeLocalServices answers contract-level external-process capability records', () => {
  assert.deepEqual(
    describeLocalServices({ functions: { kind: 'http', baseUrl: 'http://localhost:7071', required: true } }),
    [
      {
        name: 'local-service:functions',
        version: '1',
        kind: 'provider',
        level: 'contract',
        operations: ['probe'],
        requires: ['external-process:functions'],
        principal: 'none',
        stateOwner: 'external:functions',
        lifecycle: 'external-process',
        service: 'http',
        required: true,
      },
    ],
  );
});

// A fetch that answers after delayMs on the mocked clock, or never when delayMs is null; an abort ends it with the signal's reason.
// `arrived` resolves with the request's signal when the probe calls fetch, which is after the probe armed its bound: a test
// ticks the mocked clock only after awaiting it.
function mockedFetch(delayMs) {
  let arrive;
  const arrived = new Promise((resolve) => {
    arrive = resolve;
  });
  const fetch = (href, { signal }) =>
    new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      if (delayMs !== null) setTimeout(() => resolve(new Response(null, { status: 200 })), delayMs);
      arrive(signal);
    });
  return { fetch, arrived };
}

test('a local service that answers after 10 mocked seconds is ready under the default idle window', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { fetch, arrived } = mockedFetch(10_000);
  const probe = preflightLocalServices({ slow: { kind: 'http', baseUrl: 'http://127.0.0.1:7071' } }, { fetch });
  await arrived;
  t.mock.timers.tick(10_000);
  const [result] = await probe;
  assert.deepEqual([result.reachable, result.status], [true, 200], result.message);
});

test('a silent local service is reported not ready when the default idle window ends, not at a fixed 2 s bound', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let settled = false;
  const { fetch, arrived } = mockedFetch(null);
  const probe = preflightLocalServices({ silent: { kind: 'http', baseUrl: 'http://127.0.0.1:7071' } }, { fetch }).then(
    (results) => {
      settled = true;
      return results;
    },
  );
  const signal = await arrived;
  t.mock.timers.tick(PREFLIGHT_IDLE_TIMEOUT_MS - 1);
  assert.equal(signal.aborted, false, 'the idle window has not ended one millisecond early');
  assert.equal(settled, false, 'the probe has not settled one millisecond early');
  t.mock.timers.tick(1);
  const [result] = await probe;
  assert.equal(result.reachable, false);
  assert.match(result.message, /no answer within 30000 ms/);
});

test('an explicit timeoutMs still bounds the probe of a silent local service', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let settled = false;
  const { fetch, arrived } = mockedFetch(null);
  const probe = preflightLocalServices(
    { silent: { kind: 'http', baseUrl: 'http://127.0.0.1:7071' } },
    { fetch, timeoutMs: 50 },
  ).then((results) => {
    settled = true;
    return results;
  });
  const signal = await arrived;
  t.mock.timers.tick(49);
  assert.equal(signal.aborted, false, 'the 50 ms bound has not ended one millisecond early');
  assert.equal(settled, false, 'the probe has not settled one millisecond early');
  t.mock.timers.tick(1);
  assert.equal(signal.aborted, true, 'the 50 ms bound aborts the request at its own tick');
  const [result] = await probe;
  assert.equal(result.reachable, false);
  assert.match(result.message, /no answer within 50 ms/);
});
