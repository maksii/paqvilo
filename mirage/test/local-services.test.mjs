// localServices: loopback-only validation, probes against a loopback stub, a closed port and a redirect, the
// Service Bus declaration without printing its connection string, and the capability records.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { localServiceSettings, preflightLocalServices, describeLocalServices } from '../lib/local-services.mjs';

async function stub(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
async function closedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

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

test('preflight reports a loopback stub, a closed port and a refused redirect without throwing', async (t) => {
  const origin = await stub(t, (req, res) => {
    if (req.url === '/moved') {
      res.writeHead(302, { location: 'http://fx.example.test/' });
      return res.end();
    }
    res.writeHead(200);
    res.end('ok');
  });
  const port = await closedPort();
  const results = await preflightLocalServices(
    {
      functions: { kind: 'http', baseUrl: origin, probe: '/admin/host/status?code=fx-function-key', required: true },
      gone: { kind: 'http', baseUrl: `http://127.0.0.1:${port}` },
      moved: { kind: 'http', baseUrl: origin, probe: '/moved' },
    },
    { timeoutMs: 2000 },
  );
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));
  assert.deepEqual([byId.functions.reachable, byId.functions.status, byId.functions.required], [true, 200, true]);
  assert.doesNotMatch(byId.functions.message, /fx-function-key/);
  assert.equal(byId.gone.reachable, false);
  assert.equal(byId.moved.reachable, false);
  assert.match(byId.moved.message, /redirect/);
});

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
