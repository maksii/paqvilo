// @test-kind unproven: the checks in this file exercise dataverse connection loopback with local fixtures; no native capture establishes the behaviour they assert.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerApplication, tokenProvider } from '../lense/dataverse/connection.mjs';
import { DataverseClient, connectedClient, isLoopbackOrigin } from '../lense/dataverse/client.mjs';
import { loopbackServer } from './fixture.mjs';

const TENANT = '11111111-1111-1111-1111-111111111111';
const CLIENT = '44444444-4444-4444-4444-444444444444';
const LOOPBACK_ENV = 'http://127.0.0.1:9';
const PRODUCTION_ENV = 'https://orgsim.example.test';
process.env.PAQVILO_TEST_LOOPBACK_SECRET = 'invented-test-secret';

const connection = (environmentUrl, extra = {}) => ({
  schemaVersion: 1,
  environmentUrl,
  tenantId: TENANT,
  clientId: CLIENT,
  credentialSource: 'environment',
  secretEnvironmentVariable: 'PAQVILO_TEST_LOOPBACK_SECRET',
  ...extra,
});

function recordingFetch(calls) {
  return async (url, init) => {
    calls.push({ url, scope: String(init.body.get('scope')) });
    return { ok: true, json: async () => ({ access_token: 'x', expires_in: 3600 }) };
  };
}

// @test-kind security+contract: a loopback authorityHost is used only when loopback is allowed
test('a loopback authorityHost is used only when loopback is allowed', async () => {
  const calls = [];
  const token = tokenProvider(connection(LOOPBACK_ENV, { authorityHost: 'http://127.0.0.1:4010' }), {
    fetchImpl: recordingFetch(calls),
    allowLoopback: true,
  });
  assert.equal(await token(), 'x');
  assert.equal(calls[0].url, `http://127.0.0.1:4010/${TENANT}/oauth2/v2.0/token`);
  assert.equal(calls[0].scope, `${LOOPBACK_ENV}/.default`, 'the scope resource stays the environment origin');
});

// @test-kind security+contract: a loopback authorityHost is ignored, and a loopback environment rejected, without allowLoopback
test('a loopback authorityHost is ignored, and a loopback environment rejected, without allowLoopback', async () => {
  const calls = [];
  const token = tokenProvider(connection(PRODUCTION_ENV, { authorityHost: 'http://127.0.0.1:4010' }), {
    fetchImpl: recordingFetch(calls),
  });
  await token();
  assert.equal(calls[0].url, `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
  assert.throws(
    () => tokenProvider(connection(LOOPBACK_ENV), { fetchImpl: recordingFetch([]) }),
    /Environment must be an HTTPS organisation origin/,
  );
});

// @test-kind security+contract: a non-loopback authorityHost is rejected even when loopback is allowed
test('a non-loopback authorityHost is rejected even when loopback is allowed', () => {
  for (const authorityHost of [
    'https://evil.example',
    'http://localhost.evil.example',
    'https://127.0.0.1:4010/path',
    'not a url',
  ]) {
    assert.throws(
      () =>
        tokenProvider(connection(LOOPBACK_ENV, { authorityHost }), {
          fetchImpl: recordingFetch([]),
          allowLoopback: true,
        }),
      /authorityHost must be a loopback origin/,
      authorityHost,
    );
  }
});

test('the default authority is the Microsoft login host', async () => {
  const calls = [];
  const token = tokenProvider(connection(PRODUCTION_ENV), { fetchImpl: recordingFetch(calls) });
  assert.equal(await token(), 'x');
  assert.equal(calls[0].url, `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
  assert.equal(calls[0].scope, `${PRODUCTION_ENV}/.default`);
});

// @test-kind security+contract: connectedClient passes allowLoopback to the client and the token provider
test('connectedClient passes allowLoopback to the client and the token provider', () => {
  assert.equal(connectedClient(connection(LOOPBACK_ENV), { allowLoopback: true }).origin, LOOPBACK_ENV);
  assert.throws(() => connectedClient(connection(LOOPBACK_ENV)), /Environment must be an HTTPS organisation origin/);
  assert.equal(isLoopbackOrigin('http://[::1]:8080'), true);
  assert.equal(isLoopbackOrigin('https://orgsim.example.test'), false);
});

function throttledClient(url, waits) {
  return new DataverseClient({
    environmentUrl: url,
    allowLoopback: true,
    token: async () => 'invented-token',
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
}

// @test-kind contract: a throttled read waits for its Retry-After header and then succeeds, because reads are idempotent
test('a throttled read waits for Retry-After and then succeeds', async (t) => {
  let calls = 0;
  const url = await loopbackServer(t, async (req, res) => {
    calls++;
    await req.toArray();
    res.writeHead(calls === 1 ? 429 : 200, { 'Retry-After': '1', 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const waits = [];
  assert.deepEqual(await throttledClient(url, waits).get('WhoAmI'), { ok: true });
  assert.equal(calls, 2);
  assert.deepEqual(waits, [1000]);
});

// @test-kind contract: a read that stays unavailable gives up after three retries with a growing wait when no Retry-After is sent
test('a persistently unavailable read stops after three retries with a growing wait', async (t) => {
  let calls = 0;
  const url = await loopbackServer(t, async (req, res) => {
    calls++;
    await req.toArray();
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  const waits = [];
  await assert.rejects(throttledClient(url, waits).get('WhoAmI'), (error) => error.status === 503);
  assert.equal(calls, 4);
  assert.deepEqual(waits, [1000, 2000, 4000]);
});

// @test-kind contract: a throttled mutation surfaces its error at once, because a repeated write may apply twice
test('a throttled POST is not retried', async (t) => {
  let calls = 0;
  const url = await loopbackServer(t, async (req, res) => {
    calls++;
    await req.toArray();
    res.writeHead(429, { 'Retry-After': '1', 'Content-Type': 'application/json' });
    res.end('{}');
  });
  const waits = [];
  await assert.rejects(
    throttledClient(url, waits).request('EntityDefinitions', { method: 'POST', body: {} }),
    (error) => error.status === 429,
  );
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
});

// @test-kind contract: an abort during a Retry-After wait rejects with the caller's reason and sends no further request
test('an abort during a Retry-After wait rejects with the reason and sends no further request', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  const reason = new Error('invented caller cancellation');
  let requests = 0;
  const fetchImpl = async () => {
    requests++;
    // The 429 resolves first and the retry wait starts in the same microtask run, so the abort lands during the wait.
    setImmediate(() => controller.abort(reason));
    return new Response('{}', { status: 429, headers: { 'Retry-After': '30' } });
  };
  const client = new DataverseClient({
    environmentUrl: 'https://org.example.test',
    token: async () => 'invented-token',
    fetchImpl,
    signal: controller.signal,
  });
  await assert.rejects(client.get('WhoAmI'), (error) => error === reason);
  t.mock.timers.tick(30_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests, 1, 'the aborted wait never sends the retry');
});

// @test-kind security: a second application for an environment or name already recorded beside the connection is refused before any PAC call
test('register refuses a second application for an environment or name recorded beside the connection', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-registration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, '.paqvilo', 'dataverse');
  const target = path.join(directory, 'second.json');
  const sibling = path.join(directory, 'provisioning.connection.json');
  const log = path.join(root, 'pac-invocations.log');
  const invocations = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    sibling,
    JSON.stringify({
      schemaVersion: 1,
      environmentUrl: 'https://org.example.test',
      applicationName: 'Invented Provisioning',
      state: 'Connected',
    }),
  );
  fs.writeFileSync(path.join(directory, 'broken.connection.json'), '{ not json');
  // The PAC executable is this Node binary; a preload records each child invocation and exits with a failure status.
  const preload = path.join(root, 'pac-double.mjs');
  fs.writeFileSync(
    preload,
    `import fs from 'node:fs';\nfs.appendFileSync(process.env.PAQVILO_TEST_PAC_LOG, 'invoked\\n');\nprocess.exit(1);\n`,
  );
  const saved = { ...process.env };
  t.after(() => {
    for (const key of ['NODE_OPTIONS', 'PAQVILO_PAC_EXECUTABLE', 'PAQVILO_TEST_PAC_LOG']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  process.env.NODE_OPTIONS = [saved.NODE_OPTIONS, `--import=${pathToFileURL(preload).href}`].filter(Boolean).join(' ');
  process.env.PAQVILO_PAC_EXECUTABLE = process.execPath;
  process.env.PAQVILO_TEST_PAC_LOG = log;
  for (const [environment, applicationName] of [
    ['https://ORG.example.test', 'Another Application'],
    ['https://other.example.test', 'Invented Provisioning'],
  ]) {
    await assert.rejects(
      registerApplication({ connectionFile: target, environment, applicationName }),
      (error) => error.code === 'REGISTRATION_EXISTS' && error.message.includes(sibling),
    );
  }
  assert.equal(invocations(), 0, 'a refused registration never starts PAC');
  await assert.rejects(
    registerApplication({
      connectionFile: target,
      environment: 'https://org.example.test',
      applicationName: 'Invented Provisioning',
      allowAdditionalApplication: true,
    }),
    (error) => error.code !== 'REGISTRATION_EXISTS',
  );
  assert.equal(invocations(), 1, 'the override reaches PAC exactly once');
});

// The PAC executable is this Node binary. The preload logs the verb of each child invocation and answers the
// verbs this test chooses through environment variables; any other verb exits with a failure status.
const PAC_VERB_DOUBLE = [
  "import fs from 'node:fs';",
  'const words = process.argv.slice(1);',
  "const verb = ['who', 'list-service-principal', 'create-service-principal'].find((name) => words.includes(name)) ?? 'other';",
  "fs.appendFileSync(process.env.PAQVILO_TEST_PAC_LOG, verb + '\\n');",
  'const reply = (text, code) => {',
  '  fs.writeSync(1, text);',
  '  process.exit(code);',
  '};',
  "if (verb === 'who' && process.env.PAQVILO_TEST_PAC_WHO === 'ok')",
  "  reply('Org URL: https://org.example.test\\nEnvironment ID: 22222222-2222-4222-8222-222222222222\\nOrg ID: 33333333-3333-4333-8333-333333333333\\nUnique Name: invented\\nFriendly Name: Invented\\n', 0);",
  "if (verb === 'list-service-principal' && process.env.PAQVILO_TEST_PAC_LIST === 'same')",
  "  reply('Application ID  Display Name  Role\\n11111111-1111-4111-8111-111111111111  Invented Provisioning  System Customizer\\n', 0);",
  "if (verb === 'list-service-principal' && process.env.PAQVILO_TEST_PAC_LIST === 'longer')",
  "  reply('11111111-1111-4111-8111-111111111111  Invented Provisioning Extended  System Customizer\\n', 0);",
  'process.exit(1);',
].join('\n');

function installPacDouble(t, root, { who = false, list = 'fail' }) {
  const log = path.join(root, 'pac-verbs.log');
  const preload = path.join(root, 'pac-verb-double.mjs');
  fs.writeFileSync(preload, PAC_VERB_DOUBLE);
  const keys = [
    'NODE_OPTIONS',
    'PAQVILO_PAC_EXECUTABLE',
    'PAQVILO_TEST_PAC_LOG',
    'PAQVILO_TEST_PAC_WHO',
    'PAQVILO_TEST_PAC_LIST',
  ];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  process.env.NODE_OPTIONS = [saved.NODE_OPTIONS, `--import=${pathToFileURL(preload).href}`].filter(Boolean).join(' ');
  process.env.PAQVILO_PAC_EXECUTABLE = process.execPath;
  process.env.PAQVILO_TEST_PAC_LOG = log;
  process.env.PAQVILO_TEST_PAC_WHO = who ? 'ok' : 'fail';
  process.env.PAQVILO_TEST_PAC_LIST = list;
  return () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
}

function registrationRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-listed-registration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const listedName = {
  connectionFile: path.join('.paqvilo', 'dataverse', 'new.json'),
  environment: 'https://org.example.test',
  applicationName: 'Invented Provisioning',
};

// @test-kind security: an application the environment already lists under the requested name is refused before any create call
test('register refuses a name the environment already lists, before creating an application', async (t) => {
  const root = registrationRoot(t);
  const verbs = installPacDouble(t, root, { who: true, list: 'same' });
  await assert.rejects(
    registerApplication({ ...listedName, connectionFile: path.join(root, listedName.connectionFile) }),
    (error) =>
      error.code === 'REGISTRATION_EXISTS' &&
      /inspect or verify/.test(error.message) &&
      /--allow-additional-application/.test(error.message),
  );
  assert.deepEqual(verbs(), ['who', 'list-service-principal']);
});

// @test-kind security: a failed listing stops registration without creating an application, and names the override
test('register stops when PAC cannot list existing applications', async (t) => {
  const root = registrationRoot(t);
  const verbs = installPacDouble(t, root, { who: true, list: 'fail' });
  await assert.rejects(
    registerApplication({ ...listedName, connectionFile: path.join(root, listedName.connectionFile) }),
    (error) =>
      error.code === undefined &&
      /could not be checked/.test(error.message) &&
      /--allow-additional-application/.test(error.message),
  );
  assert.deepEqual(verbs(), ['who', 'list-service-principal']);
});

// @test-kind security: a longer listed name that only starts with the requested name does not refuse the registration
test('a longer listed application name does not block registration', async (t) => {
  const root = registrationRoot(t);
  const verbs = installPacDouble(t, root, { who: true, list: 'longer' });
  await assert.rejects(
    registerApplication({ ...listedName, connectionFile: path.join(root, listedName.connectionFile) }),
    (error) => error.code !== 'REGISTRATION_EXISTS' && !/could not be checked/.test(error.message),
  );
  // Creation needs Windows DPAPI for the preflight, so off Windows the run stops after the listing.
  const expected =
    process.platform === 'win32'
      ? ['who', 'list-service-principal', 'create-service-principal']
      : ['who', 'list-service-principal'];
  assert.deepEqual(verbs(), expected);
});

// @test-kind security: the override skips the listing, so a listed name reaches creation exactly once
test('the override skips the listing and reaches creation once', async (t) => {
  const root = registrationRoot(t);
  const verbs = installPacDouble(t, root, { who: true, list: 'same' });
  await assert.rejects(
    registerApplication({
      ...listedName,
      connectionFile: path.join(root, listedName.connectionFile),
      allowAdditionalApplication: true,
    }),
    (error) => error.code !== 'REGISTRATION_EXISTS' && !/could not be checked/.test(error.message),
  );
  const expected = process.platform === 'win32' ? ['who', 'create-service-principal'] : ['who'];
  assert.deepEqual(verbs(), expected);
});

// @test-kind security: any json record beside the connection blocks a second application for its environment before PAC
test('register refuses an environment recorded by any json file beside the connection, before PAC', async (t) => {
  const root = registrationRoot(t);
  const directory = path.join(root, '.paqvilo', 'dataverse');
  fs.mkdirSync(directory, { recursive: true });
  const verbs = installPacDouble(t, root, { who: true, list: 'same' });
  for (const name of ['connection.json', 'prod.json', 'x.connection.json']) {
    const sibling = path.join(directory, name);
    fs.writeFileSync(
      sibling,
      JSON.stringify({
        schemaVersion: 1,
        environmentUrl: 'https://org.example.test',
        applicationName: 'Another Application',
        state: 'Connected',
      }),
    );
    await assert.rejects(
      registerApplication({
        connectionFile: path.join(directory, 'new.json'),
        environment: 'https://ORG.example.test',
        applicationName: 'Invented Provisioning',
      }),
      (error) => error.code === 'REGISTRATION_EXISTS' && error.message.includes(sibling),
      name,
    );
    fs.rmSync(sibling);
  }
  assert.deepEqual(verbs(), [], 'a refused registration never starts PAC');
});

// @test-kind security: a json file without an environment, or one that cannot be parsed, does not block registration
test('json files that are not connection records do not block registration', async (t) => {
  const root = registrationRoot(t);
  const directory = path.join(root, '.paqvilo', 'dataverse');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({ name: 'invented-package', version: '1.0.0' }),
  );
  fs.writeFileSync(path.join(directory, 'unscoped.json'), JSON.stringify({ applicationName: 'Invented Provisioning' }));
  fs.writeFileSync(path.join(directory, 'malformed.json'), '{ not json');
  const verbs = installPacDouble(t, root, { who: true, list: 'fail' });
  await assert.rejects(
    registerApplication({
      connectionFile: path.join(directory, 'new.json'),
      environment: 'https://org.example.test',
      applicationName: 'Invented Provisioning',
    }),
    (error) => error.code !== 'REGISTRATION_EXISTS' && /could not be checked/.test(error.message),
  );
  assert.deepEqual(verbs(), ['who', 'list-service-principal']);
});

// @test-kind contract: the listed-name refusal says the check covers the tenant and matches by application name
test('a listed-name refusal names the tenant and says the check matches by application name', async (t) => {
  const root = registrationRoot(t);
  installPacDouble(t, root, { who: true, list: 'same' });
  await assert.rejects(
    registerApplication({ ...listedName, connectionFile: path.join(root, listedName.connectionFile) }),
    (error) =>
      error.code === 'REGISTRATION_EXISTS' &&
      /already registered in this tenant/.test(error.message) &&
      /matches by application name/.test(error.message) &&
      !/this environment/.test(error.message),
  );
});
