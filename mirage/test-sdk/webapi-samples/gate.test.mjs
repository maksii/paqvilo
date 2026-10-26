// SDK verification gate: Microsoft's PowerApps-Samples WebAPIService library (pinned in PINNED_COMMIT.txt,
// cloned outside the repo under .paqvilo/sdk-gates/) replaying its request shapes against the simulated Dataverse API.
// Opt-in (`node --test mirage/test-sdk/webapi-samples/gate.test.mjs`); never part of `npm run validate`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startGate, clientCredentialsToken } from '../harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.join(here, 'Gate', 'Gate.csproj');
const samples = path.resolve(here, '../../../.paqvilo/sdk-gates/PowerApps-Samples');
const exe = path.join(here, 'Gate', 'bin', 'Release', 'net10.0', process.platform === 'win32' ? 'Gate.exe' : 'Gate');
const REQUIRED = ['construct', 'whoami', 'create', 'retrieve', 'update', 'retrieveMultiple', 'delete', 'batch'];

const dotnet = spawnSync('dotnet', ['--version'], { encoding: 'utf8' });
const skip = dotnet.status === 0 ? false : 'dotnet is not installed: WebAPIService gate skipped';

test('PowerApps-Samples WebAPIService replays against the simulator', { timeout: 600_000, skip }, async (t) => {
  // The clone follows the default branch; refuse any checkout other than the reviewed commit.
  const pinned = /^Commit:\s*([0-9a-f]{40})$/m.exec(fs.readFileSync(path.join(here, 'PINNED_COMMIT.txt'), 'utf8'))[1];
  const head = spawnSync('git', ['-C', samples, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  assert.equal(head.stdout?.trim(), pinned, `${samples} must be checked out at ${pinned}; see PINNED_COMMIT.txt`);
  const build = spawnSync('dotnet', ['build', project, '-c', 'Release', '-nologo'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(build.status, 0, `dotnet build failed:\n${`${build.stdout}${build.stderr}`.slice(-4000)}`);
  assert.ok(fs.existsSync(exe), `built executable not found: ${exe}`);

  const gate = await startGate();
  t.after(() => gate.close());
  const token = await clientCredentialsToken(gate);

  // Async spawn: spawnSync would block this event loop and starve the in-process simulator.
  const run = await new Promise((resolve, reject) => {
    const child = spawn(exe, [], {
      env: { ...process.env, SIM_ORG: gate.origin, SIM_TOKEN: token },
      windowsHide: true,
    });
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
  const steps = run.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line));
  t.diagnostic(steps.map((s) => `${s.step}: ${s.ok ? 'ok' : 'FAIL'} ${s.detail}`).join('\n'));

  for (const name of REQUIRED)
    assert.ok(
      steps.some((s) => s.step === name),
      `step "${name}" missing; exit ${run.status}\n${run.stderr.slice(-2000)}`,
    );
  const failed = steps.filter((s) => !s.ok);
  assert.deepEqual(failed, [], 'every WebAPIService step must succeed, including the $batch change set');
  assert.equal(run.status, 0, `Gate exit code ${run.status}\n${run.stderr.slice(-2000)}`);
  assert.ok(
    JSON.stringify(gate.requests()).includes('/api/data/v9.2/WhoAmI'),
    'simulator should record the WhoAmI request',
  );
});
