// SDK verification gate: Microsoft.PowerPlatform.Dataverse.Client 1.2.27 (ServiceClient) against the simulated
// Dataverse API. ServiceClient drops the port from the URL, so the simulator listens on a per-run loopback address at :80.
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
import { createInterface } from 'node:readline';
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
const dotnetSkip =
  dotnet.status === 0 || process.env.PAQ_TEST_REQUIRE_SDK_GATES === '1'
    ? false
    : 'dotnet is not installed: ServiceClient gate skipped';

// The SDK drops ports but retains the host; bind the actual gate before building.
const gateHost = () => `127.${randomInt(16, 240)}.${randomInt(1, 255)}.${randomInt(1, 255)}`;

/** Who listens on TCP port 80, for a failure that must name what blocks the gate (Windows only; empty elsewhere). */
function port80Owners() {
  if (process.platform !== 'win32') return '';
  const listening = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true });
  const pids = new Set(
    (listening.stdout ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/))
      .filter((cols) => cols[3] === 'LISTENING' && /:80$/.test(cols[1]))
      .map((cols) => cols[4]),
  );
  const owners = [...pids].map((pid) => {
    const task = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const name = /^"([^"]+)"/.exec(task.stdout?.trim() ?? '')?.[1] ?? 'unknown';
    // PID 4 is the kernel HTTP service (http.sys), shared by IIS, WinRM and other URL reservations.
    return pid === '4' ? 'PID 4 (http.sys)' : `PID ${pid} (${name})`;
  });
  return owners.length ? `; listening on port 80: ${owners.join(', ')}` : '; nothing listens on port 80';
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

test('SDK gate binds an alternate loopback address while the default address is occupied', async (t) => {
  const listener = net.createServer((socket) => socket.end('default-listener'));
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => listener.close(resolve)));
  const host = '127.0.0.2';
  const gate = await startGate({ host, port: listener.address().port });
  t.after(() => gate.close());
  assert.equal(new URL(gate.origin).hostname, host);
  assert.equal(new URL(gate.origin).port, String(listener.address().port));
  const response = await fetch(`${gate.origin}/${gate.tenantId}/.well-known/openid-configuration`);
  assert.equal(response.status, 200);
  assert.equal(typeof (await clientCredentialsToken(gate)), 'string');
  const received = await new Promise((resolve, reject) => {
    const socket = net.connect(listener.address().port, '127.0.0.1');
    socket.once('data', (chunk) => resolve(chunk.toString()));
    socket.once('error', reject);
  });
  assert.equal(received, 'default-listener');
});

test(
  'an exclusive Windows wildcard listener blocks SDK loopback until its owner releases it',
  { skip: process.platform !== 'win32' },
  async (t) => {
    // Node's Windows sockets use SO_REUSEADDR; use an owned .NET exclusive socket
    // to reproduce HTTP.sys-style ownership without changing services or occupying :80.
    const blocker = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Any, 0); $listener.ExclusiveAddressUse = $true; $listener.Start(); try { [Console]::WriteLine($listener.LocalEndpoint.Port); [Console]::ReadLine() | Out-Null } finally { $listener.Stop() }',
      ],
      { windowsHide: true },
    );
    let launchError;
    blocker.once('error', (error) => {
      launchError = error;
    });
    const closed = new Promise((resolve) => blocker.once('close', resolve));
    t.after(() => {
      blocker.kill();
      return closed;
    });
    const lines = createInterface({ input: blocker.stdout });
    t.after(() => lines.close());
    const { value } = await lines[Symbol.asyncIterator]().next();
    assert.ifError(launchError);
    const port = Number(value);
    assert.ok(Number.isInteger(port) && port > 0, 'exclusive listener must report its bound port');
    const host = '127.0.0.2';
    // Register unexpected success for cleanup before asserting, so a regression cannot leak a server.
    await assert.rejects(
      async () => {
        const unexpected = await startGate({ host, port });
        t.after(() => unexpected.close());
      },
      { code: 'EACCES' },
    );
    blocker.stdin.end('\n');
    assert.equal(await closed, 0);
    const gate = await startGate({ host, port });
    t.after(() => gate.close());
    const response = await fetch(`${gate.origin}/${gate.tenantId}/.well-known/openid-configuration`);
    assert.equal(response.status, 200);
  },
);

test(
  'Microsoft.PowerPlatform.Dataverse.Client (ServiceClient) gate against the simulator',
  { timeout: 600_000, skip: dotnetSkip },
  async (t) => {
    const host = gateHost();
    let gate;
    try {
      gate = await startGate({ host, port: 80 });
    } catch (error) {
      if (!['EADDRINUSE', 'EACCES', 'EADDRNOTAVAIL'].includes(error.code)) throw error;
      if (process.env.PAQ_TEST_REQUIRE_SDK_GATES === '1')
        throw new Error(
          `port 80 on ${host} is unavailable (${error.code})${port80Owners()}; the required ServiceClient gate cannot run`,
          {
            cause: error,
          },
        );
      t.skip(`port 80 on ${host} is unavailable (${error.code}): ServiceClient drops the port`);
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
      const noProxy = [process.env.no_proxy ?? process.env.NO_PROXY, host].filter(Boolean).join(',');
      const run = await runGate({
        no_proxy: noProxy,
        NO_PROXY: noProxy,
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
