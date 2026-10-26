// SDK verification gate: PowerPlatform-Dataverse-Client 1.1.0 + msal 1.39.0 (Python) against the Mirage Dataverse simulator over TLS.
// Opt-in only (`node --test mirage/test-sdk/python-dataverse/gate.test.mjs`); not part of `npm run validate`.
// Needs the venv at .paqvilo/sdk-gates/python-dataverse/.venv; the test skips with a message when it is missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startGate } from '../harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const VENV = path.join(REPO, '.paqvilo', 'sdk-gates', 'python-dataverse', '.venv');
const PYTHON = [path.join(VENV, 'Scripts', 'python.exe'), path.join(VENV, 'bin', 'python')].find((file) =>
  existsSync(file),
);
const REQUIRED = [
  'token',
  'whoami',
  'retrieve',
  'update',
  'query',
  'create_multiple',
  'batch',
  'error_400',
  'delete',
  'retrieve_missing',
  'error_404',
];

// Runs gate.py asynchronously: the simulator lives in this process, so a synchronous spawn would deadlock it.
function runGate(gate) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, ['-I', 'gate.py'], {
      cwd: HERE,
      env: {
        ...process.env,
        SIM_TLS_ORIGIN: gate.tlsOrigin,
        SIM_TENANT: gate.tenantId,
        SIM_CLIENT_ID: gate.clientId,
        SIM_CLIENT_SECRET: gate.clientSecret,
        REQUESTS_CA_BUNDLE: gate.caFile,
        PYTHONUTF8: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      const steps = stdout
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line));
      resolve({ code, steps, stderr });
    });
  });
}

test(
  'Python Dataverse SDK gate: msal token, CRUD, query, bulk, batch and errors over TLS',
  { timeout: 120_000 },
  async (t) => {
    if (!PYTHON) {
      t.skip(`SDK venv missing at ${VENV}; create it with msal==1.39.0 and PowerPlatform-Dataverse-Client==1.1.0`);
      return;
    }
    const gate = await startGate({ tls: true });
    t.after(() => gate.close());

    const { code, steps, stderr } = await runGate(gate);
    const trace = steps.find((step) => step.step === 'trace')?.detail ?? [];
    const failed = steps.filter((step) => !step.ok && !step.optional);
    assert.deepEqual(
      failed.map((step) => step.step),
      [],
      `failed steps:\n${JSON.stringify(failed, null, 2)}\nstderr:\n${stderr}`,
    );
    for (const name of REQUIRED) {
      const found = steps.find((step) => step.step === name);
      assert.ok(found?.ok, `required step ${name} missing or not ok`);
    }
    assert.equal(code, 0, `gate exited ${code}; stderr:\n${stderr}`);
    // The venv is created by hand, so prove it holds the pinned clients rather than whatever pip resolved.
    const pins = Object.fromEntries(
      readFileSync(path.join(HERE, 'requirements.txt'), 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => line.split('==')),
    );
    assert.deepEqual(steps.find((step) => step.step === 'versions')?.detail, pins);

    const requests = gate.requests();
    const url = (entry) => decodeURIComponent(entry.url);
    assert.ok(
      trace.some(
        (entry) =>
          entry.method === 'GET' && url(entry).endsWith(`/${gate.tenantId}/v2.0/.well-known/openid-configuration`),
      ),
      'OIDC discovery GET missing',
    );
    assert.ok(
      trace.some((entry) => entry.method === 'POST' && url(entry).endsWith(`/${gate.tenantId}/oauth2/v2.0/token`)),
      'token POST missing',
    );
    assert.ok(
      trace.some(
        (entry) =>
          entry.method === 'GET' &&
          url(entry).includes('/api/data/v9.2/EntityDefinitions') &&
          url(entry).includes('$filter='),
      ),
      'EntityDefinitions GET with $filter missing',
    );
    assert.ok(
      requests.some((entry) => entry.path === '/api/data/v9.2/widgets' && entry.method === 'POST'),
      'POST /api/data/v9.2/widgets missing',
    );
    assert.ok(
      requests.some((entry) => entry.path === `/${gate.tenantId}/oauth2/v2.0/token` && entry.method === 'POST'),
      'token POST missing from simulator requests',
    );
  },
);
