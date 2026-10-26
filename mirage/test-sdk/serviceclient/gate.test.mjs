// SDK verification gate: Microsoft.PowerPlatform.Dataverse.Client 1.2.27 (ServiceClient) against the simulated
// Dataverse API. ServiceClient drops the port from the URL, so the simulator listens on loopback :80.
// Two passes over one simulator: "soap" (UseWebApi=false, CRUD and messages on /XRMServices/2011/Organization.svc/web)
// and "webapi" (UseWebApi=true, CRUD on the Web API, RetrieveEntityRequest still on SOAP).
// Runs in the full Windows verification gate (`node scripts/ci.mjs sdk`), or alone with
// `node --test --test-timeout=600000 mirage/test-sdk/serviceclient/gate.test.mjs`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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

/** Resolves { free: true } when loopback port 80 can be bound, otherwise the bind error code. */
function probePort80() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', (error) => resolve({ free: false, reason: error.code ?? error.message }));
    probe.listen(80, () => probe.close(() => resolve({ free: true })));
  });
}

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

test(
  'Microsoft.PowerPlatform.Dataverse.Client (ServiceClient) gate against the simulator',
  { timeout: 600_000, skip: dotnetSkip },
  async (t) => {
    const port = await probePort80();
    if (!port.free) {
      // The CI SDK gate (scripts/ci.mjs sdk) requires this client, so an occupied port fails there instead of skipping.
      if (process.env.PAQ_TEST_REQUIRE_SDK_GATES === '1')
        throw new Error(`port 80 is unavailable (${port.reason}); the required ServiceClient gate cannot run`);
      t.skip(`port 80 is unavailable (${port.reason}): ServiceClient drops the port, so the simulator must bind :80`);
      return;
    }

    const buildStarted = Date.now();
    const build = spawnSync('dotnet', ['build', project, '-c', 'Release', '-nologo'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    const buildMs = Date.now() - buildStarted;
    assert.equal(build.status, 0, `dotnet build failed:\n${`${build.stdout}${build.stderr}`.slice(-4000)}`);
    assert.ok(fs.existsSync(exe), `built executable not found: ${exe}`);
    t.diagnostic(`dotnet build: ${buildMs} ms`);

    const gate = await startGate({ port: 80 });
    t.after(() => gate.close());
    assert.equal(gate.origin, 'http://127.0.0.1', `simulator origin must carry no port, got ${gate.origin}`);
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
