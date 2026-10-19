// SDK verification gate: Microsoft.PowerPlatform.Dataverse.Client 1.2.27 (ServiceClient) against the simulated
// Dataverse API. ServiceClient drops the port from the URL, so the simulator listens on loopback :80.
// Opt-in (`node --test --test-timeout=600000 mirage/test-sdk/serviceclient/gate.test.mjs`); never part of `npm run validate`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startGate, clientCredentialsToken } from '../harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.join(here, 'Gate', 'Gate.csproj');
const exe = path.join(here, 'Gate', 'bin', 'Release', 'net10.0', process.platform === 'win32' ? 'Gate.exe' : 'Gate');
const REQUIRED = ['construct', 'org', 'create', 'retrieve', 'update', 'query', 'delete', 'whoami_webapi', 'soap_whoami'];
const ORG_CURRENT = ["/api/data/v9.0/RetrieveCurrentOrganization(AccessType='Default')", '/api/data/v9.0/RetrieveCurrentOrganization(AccessType=%27Default%27)'];
const SOAP_PATH = '/XRMServices/2011/Organization.svc/web';

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

test('Microsoft.PowerPlatform.Dataverse.Client (ServiceClient) gate against the simulator', { timeout: 600_000, skip: dotnetSkip }, async (t) => {
  const port = await probePort80();
  if (!port.free) {
    t.skip(`port 80 is unavailable (${port.reason}): ServiceClient drops the port, so the simulator must bind :80`);
    return;
  }

  const buildStarted = Date.now();
  const build = spawnSync('dotnet', ['build', project, '-c', 'Release', '-nologo'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const buildMs = Date.now() - buildStarted;
  assert.equal(build.status, 0, `dotnet build failed:\n${`${build.stdout}${build.stderr}`.slice(-4000)}`);
  assert.ok(fs.existsSync(exe), `built executable not found: ${exe}`);
  t.diagnostic(`dotnet build: ${buildMs} ms`);

  const gate = await startGate({ port: 80 });
  t.after(() => gate.close());
  assert.equal(gate.origin, 'http://127.0.0.1', `simulator origin must carry no port, got ${gate.origin}`);
  const token = await clientCredentialsToken(gate);

  // Async spawn: spawnSync would block this event loop and starve the in-process simulator.
  const runStarted = Date.now();
  const run = await new Promise((resolve, reject) => {
    const child = spawn(exe, [], {
      env: { ...process.env, SIM_ORG: gate.origin, SIM_ORG_ID: gate.organizationId, SIM_TOKEN: token },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill(), 300_000);
    child.on('error', reject);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
  t.diagnostic(`Gate run: ${Date.now() - runStarted} ms`);

  const steps = run.stdout.split(/\r?\n/).filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
  t.diagnostic(steps.map((s) => `${s.step}: ${s.ok ? 'ok' : 'FAIL'} ${s.detail}`).join('\n'));

  const recorded = gate.requests().map((entry) => `${entry.method} ${entry.path} ${entry.status}`);
  t.diagnostic(`simulator requests (${recorded.length}):\n${recorded.join('\n')}`);

  for (const name of REQUIRED) assert.ok(steps.some((s) => s.step === name), `step "${name}" missing; exit ${run.status}\n${run.stderr.slice(-2000)}`);
  assert.deepEqual(steps.filter((s) => !s.ok), [], 'every ServiceClient step must succeed');
  assert.equal(run.status, 0, `Gate exit code ${run.status}\n${run.stderr.slice(-2000)}`);

  const paths = gate.requests().map((entry) => entry.path);
  assert.ok(paths.some((p) => ORG_CURRENT.includes(p)), `simulator should record RetrieveCurrentOrganization; saw ${JSON.stringify(paths)}`);
  assert.ok(paths.includes(SOAP_PATH), `simulator should record the SOAP request ${SOAP_PATH}`);
});
