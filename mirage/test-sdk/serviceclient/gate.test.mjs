// SDK verification gate: Microsoft.PowerPlatform.Dataverse.Client 1.2.27 (ServiceClient) against the simulated
// Dataverse API. ServiceClient drops the port from the URL, so the simulator listens on loopback :80.
// Two passes over one simulator: "soap" (UseWebApi=false, CRUD and messages on /XRMServices/2011/Organization.svc/web)
// and "webapi" (UseWebApi=true, CRUD on the Web API, RetrieveEntityRequest still on SOAP).
// Runs in the full Windows verification gate (`node scripts/ci.mjs sdk`), or alone with
// `node --test --test-timeout=600000 mirage/test-sdk/serviceclient/gate.test.mjs`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startGate, clientCredentialsToken } from '../harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.join(here, 'Gate', 'Gate.csproj');
const exe = path.join(here, 'Gate', 'bin', 'Release', 'net10.0', process.platform === 'win32' ? 'Gate.exe' : 'Gate');
const ORG_CURRENT = [
  "/api/data/v9.0/RetrieveCurrentOrganization(AccessType='Default')",
  '/api/data/v9.0/RetrieveCurrentOrganization(AccessType=%27Default%27)',
];
const SOAP_PATH = '/XRMServices/2011/Organization.svc/web';
const WIDGET_WEB_API = /^(POST|PATCH|DELETE|GET) \/api\/data\/v9\.\d+\/widgets/;

// Steps that must report ok in each pass. The raw Web API probes run only in the soap pass.
const SOAP_STEPS = [
  'construct',
  'org',
  'create',
  'retrieve',
  'update',
  'query',
  'delete',
  'whoami_webapi',
  'soap_crud',
  'soap_query_paging',
  'soap_fetch',
  'soap_associate',
  'soap_execute_multiple',
  'soap_execute_transaction',
  'soap_whoami',
  'soap_callerid',
  'soap_fault_missing',
];
const WEBAPI_STEPS = ['construct', 'org', 'webapi_crud', 'soap_retrieve_entity', 'soap_retrieve_entity_attributes'];

const PASSES = [
  { name: 'soap', useWebApi: 'false', steps: SOAP_STEPS },
  { name: 'webapi', useWebApi: 'true', steps: WEBAPI_STEPS },
];

const dotnet = spawnSync('dotnet', ['--version'], { encoding: 'utf8' });
const dotnetSkip = dotnet.status === 0 ? false : 'dotnet is not installed: ServiceClient gate skipped';

// ServiceClient drops ports, but it retains the IPv4 host. Bind the actual gate on a
// random loopback address before building so another listener cannot claim its socket.
const loopbackHost = () => `127.0.${randomInt(1, 255)}.${randomInt(1, 255)}`;

/** Runs the built gate executable with the given env; async spawn, since spawnSync would starve the in-process simulator. */
function runGate(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, [], { env: { ...process.env, ...env }, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill(), 300_000);
    child.on('error', reject);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

test('SDK gate binds an alternate loopback address while the default address is occupied', async (t) => {
  const listener = net.createServer((socket) => socket.end('default-listener'));
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => listener.close(resolve)));
  const host = loopbackHost();
  const gate = await startGate({ host, port: listener.address().port });
  t.after(() => gate.close());
  assert.equal(new URL(gate.origin).hostname, host);
  assert.equal(new URL(gate.origin).port, String(listener.address().port));
  const response = await fetch(`${gate.origin}/${gate.tenantId}/.well-known/openid-configuration`);
  assert.equal(response.status, 200);
  const received = await new Promise((resolve, reject) => {
    const socket = net.connect(listener.address().port, '127.0.0.1');
    socket.once('data', (chunk) => resolve(chunk.toString()));
    socket.once('error', reject);
  });
  assert.equal(received, 'default-listener');
});

test(
  'Microsoft.PowerPlatform.Dataverse.Client (ServiceClient) gate against the simulator',
  { timeout: 600_000, skip: dotnetSkip },
  async (t) => {
    const host = loopbackHost();
    let gate;
    try {
      gate = await startGate({ port: 80, host });
    } catch (error) {
      if (process.env.PAQ_TEST_REQUIRE_SDK_GATES === '1') throw error;
      if (!['EADDRINUSE', 'EACCES', 'EADDRNOTAVAIL'].includes(error.code)) throw error;
      t.skip(`loopback port 80 is unavailable (${error.code}): ServiceClient requires :80`);
      return;
    }
    t.after(() => gate.close());
    assert.equal(gate.origin, `http://${host}`, `simulator origin must carry no port, got ${gate.origin}`);

    const buildStarted = Date.now();
    const build = spawnSync('dotnet', ['build', project, '-c', 'Release', '-nologo'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    const buildMs = Date.now() - buildStarted;
    assert.equal(build.status, 0, `dotnet build failed:\n${`${build.stdout}${build.stderr}`.slice(-4000)}`);
    assert.ok(fs.existsSync(exe), `built executable not found: ${exe}`);
    t.diagnostic(`dotnet build: ${buildMs} ms`);

    const token = await clientCredentialsToken(gate);

    // CallerId target: an extra systemuser beside the application user the simulator already holds, so impersonation resolves a real principal.
    const impersonatedId = randomUUID();
    await gate.store.transact(() => {
      (gate.store.state.tables.systemuser ??= []).push({
        systemuserid: impersonatedId,
        fullname: 'Gate Impersonated User',
        domainname: 'impersonated@sdkgate.test',
        isdisabled: false,
      });
    });

    const failures = [];
    for (const pass of PASSES) {
      const before = gate.requests().length;
      const runStarted = Date.now();
      const run = await runGate({
        SIM_ORG: gate.origin,
        SIM_ORG_ID: gate.organizationId,
        SIM_TOKEN: token,
        SIM_IMPERSONATE_ID: impersonatedId,
        SIM_USE_WEBAPI: pass.useWebApi,
      });
      t.diagnostic(`${pass.name} pass: ${Date.now() - runStarted} ms, exit ${run.status}`);

      const steps = run.stdout
        .split(/\r?\n/)
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line));
      t.diagnostic(
        `${pass.name} pass steps:\n${steps.map((s) => `${s.step}: ${s.ok ? 'ok' : 'FAIL'} ${s.detail}`).join('\n')}`,
      );

      const passRequests = gate
        .requests()
        .slice(before)
        .map((entry) => `${entry.method} ${entry.path} ${entry.status}`);
      t.diagnostic(`${pass.name} pass simulator requests (${passRequests.length}):\n${passRequests.join('\n')}`);

      for (const name of pass.steps)
        assert.ok(
          steps.some((s) => s.step === name && s.pass === pass.name),
          `${pass.name}: step "${name}" missing; exit ${run.status}\n${run.stderr.slice(-2000)}`,
        );

      for (const step of steps.filter((s) => !s.ok)) failures.push({ pass: pass.name, ...step });

      const paths = passRequests.map((line) => line.split(' ')[1]);
      assert.ok(
        paths.includes(SOAP_PATH),
        `${pass.name}: simulator should record the SOAP request ${SOAP_PATH}; saw ${JSON.stringify(paths)}`,
      );
      if (pass.useWebApi === 'true') {
        assert.ok(
          passRequests.some((line) => WIDGET_WEB_API.test(line)),
          `webapi pass: CRUD should reach the Web API for widgets; saw ${JSON.stringify(passRequests)}`,
        );
      }
      // The executable exits 1 when any step reports a failure.
      assert.equal(
        run.status,
        steps.some((s) => !s.ok) ? 1 : 0,
        `${pass.name}: Gate exit code ${run.status}\n${run.stderr.slice(-2000)}`,
      );
    }

    assert.deepEqual(failures, [], 'every ServiceClient step must succeed');
    const paths = gate.requests().map((entry) => entry.path);
    assert.ok(
      paths.some((p) => ORG_CURRENT.includes(p)),
      `simulator should record RetrieveCurrentOrganization; saw ${JSON.stringify(paths)}`,
    );
  },
);
