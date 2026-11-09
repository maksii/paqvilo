// @test-kind tooling: Invented loopback qualification checks source and runtime guard preservation.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  describeParitySource,
  parityHash,
  qualifyParityManifest,
  writeParityQualification,
  assertParityBindings,
} from '../scripts/qualify-parity.mjs';
const { parse } = createRequire(import.meta.url)('espree');
const tests = readFileSync(new URL('./parity-loopback-fixture-slice.test.mjs', import.meta.url), 'utf8');
const ast = parse(tests, { ecmaVersion: 'latest', sourceType: 'module', range: true });
let transport;
function walk(n) {
  if (!n?.type) return;
  if (n.type === 'VariableDeclarator' && n.id?.name === 'transport' && n.init?.type === 'Literal')
    transport = n.init.value;
  for (const v of Object.values(n)) for (const c of Array.isArray(v) ? v : [v]) if (c?.type) walk(c);
}
walk(ast);
assert.ok(transport);
const lines = [
  '// @test-kind unproven: Invented fixture for qualifier tooling.',
  "import { describe, it, before, after } from 'node:test'; import assert from 'node:assert/strict'; import { request } from 'node:http'; import { emptyState, start } from './sut.mjs';",
  "const SECRET_VAR = 'INVENTED_FIXTURE_SECRET'; const APP_ID = 'invented-client'; const API = '/api'; const ID = '11111111-1111-4111-8111-111111111111';",
  'function schema() { const state = emptyState(); state.tables = {}; return state; }',
  "describe('invented routing', () => { let api; let token;",
  "before(async () => { process.env[SECRET_VAR] = 'synthetic-secret'; const state = schema(); const store = state; const settings = {}; api = await start({ store, settings });",
  'const form = new URLSearchParams({ grant_type: "client_credentials", client_id: APP_ID, client_secret: process.env[SECRET_VAR], scope: `${api.origin}/.default` });',
  'const response = await fetch(`${api.origin}/${api.tenantId}/oauth2/v2.0/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });',
  'token = (await response.json()).access_token; });',
  'after(async () => { delete process.env[SECRET_VAR]; await api?.close(); });',
  transport,
  'const record = (id = ID) => `${API}/rows(${id})`;',
  "it('example', async () => { const result = await send('HEAD', record()); assert.equal(result.status, 200); });",
  "it('sibling', async () => { assert.equal(2, 2); });",
  '});',
];
const baseline = lines.join('\n');
const current = baseline
  .replace('let api; let token;', 'let api; let token; let previous;')
  .replace(
    "process.env[SECRET_VAR] = 'synthetic-secret';",
    "previous = process.env[SECRET_VAR]; process.env[SECRET_VAR] = 'synthetic-secret';",
  )
  .replace('start({ store, settings })', "start({ store, settings, host: '127.0.0.1' })")
  .replace(
    'after(async () => { delete process.env[SECRET_VAR]; await api?.close(); });',
    'after(async () => { try { await api?.close(); } finally { if (previous === undefined) delete process.env[SECRET_VAR]; else process.env[SECRET_VAR] = previous; } });',
  );
test('routing qualification pins the complete owned suite and rejects changed inputs', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'routing-qualifier-private-'));
  try {
    writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    writeFileSync(path.join(root, 'sample.test.mjs'), current);
    writeFileSync(
      path.join(root, 'sut.mjs'),
      `import http from 'node:http'; export const emptyState = () => ({ tables: {} }); export const start = async ({host}) => { const server = http.createServer((request, response) => { if (request.url.includes('/oauth2/')) { response.setHeader('content-type','application/json'); response.end(JSON.stringify({access_token:'invented'})); } else { response.statusCode = 200; response.end(); } }); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); }); return { origin: 'http://127.0.0.1:' + server.address().port, tenantId: 'invented', close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }; };`,
    );
    const proof = {
      captures: [
        { runSha256: '1'.repeat(64), status: 200 },
        { runSha256: '2'.repeat(64), status: 200 },
      ],
      facts: { status: 200 },
    };
    writeFileSync(path.join(root, 'proof.json'), JSON.stringify(proof));
    const row = describeParitySource(baseline, 'sample.test.mjs').registrations.find((r) => r.title === 'example');
    const spec = {
      baselineId: row.id,
      titleExpressionSha256: row.titleExpressionSha256,
      assertions: row.assertions.map((a) => ({ sha256: a.sha256, factIds: ['status'] })),
      caseUniverse: {
        count: 1,
        cases: ['example'],
        casesSha256: parityHash(JSON.stringify(['example'])),
        sourceBindings: [],
        ancestorLoops: [],
      },
    };
    const manifest = {
      version: 1,
      baseline: 'a'.repeat(40),
      files: [
        {
          path: 'sample.test.mjs',
          baselineSha256: parityHash(baseline),
          currentSha256: parityHash(current),
          importRoles: [
            {
              source: './sut.mjs',
              role: 'implementation-under-test',
              reviewedBy: 'tooling-author',
              reason: 'Invented runtime is the implementation under test.',
            },
          ],
          guarantees: [
            {
              id: 'invented-status',
              reason: 'Invented status for a strict qualification tooling fixture.',
              context: {
                reviewedBy: 'tooling-author',
                authorResponsibility: true,
                summary: 'Invented local fixture only; no platform claim.',
              },
              proofs: [
                {
                  path: 'proof.json',
                  sha256: parityHash(readFileSync(path.join(root, 'proof.json'))),
                  mode: 'reproduced-native',
                  capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
                  facts: [
                    {
                      id: 'status',
                      pointer: '/facts/status',
                      sha256: parityHash(JSON.stringify(200)),
                      replicatedPointers: ['/captures/0/status', '/captures/1/status'],
                    },
                  ],
                },
              ],
              tests: [spec],
            },
          ],
        },
      ],
    };
    const report = qualifyParityManifest(manifest, { root, readBaseline: () => baseline });
    assert.deepEqual(report.pending, []);
    assert.equal(report.changes.length, 1);
    writeParityQualification(report, { root });
    const target = path.join(root, 'sample.test.mjs'),
      guarded = readFileSync(target, 'utf8'),
      bindings = report.changes[0].bindings;
    assertParityBindings(pathToFileURL(target), bindings);
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    const actualRun = spawnSync(process.execPath, ['--test', target], {
      encoding: 'utf8',
      windowsHide: true,
      env: childEnv,
    });
    assert.equal(actualRun.status, 0, actualRun.stdout + actualRun.stderr);
    const alteredSibling = guarded.replace('assert.equal(2, 2)', 'assert.equal(3, 3)');
    writeFileSync(target, alteredSibling);
    const alteredRun = spawnSync(process.execPath, ['--test', target], {
      encoding: 'utf8',
      windowsHide: true,
      env: childEnv,
    });
    assert.notEqual(alteredRun.status, 0);
    assert.match(alteredRun.stdout + alteredRun.stderr, /changed-(isolation-registrations|routing|module-context)/u);
    writeFileSync(target, guarded);
    for (const [label, mutated] of [
      ['hook', guarded.replace("host: '127.0.0.1'", "host: '0.0.0.0'")],
      ['input', guarded.replace("const API = '/api'", "const API = '/elsewhere'")],
      ['sibling', guarded.replace('assert.equal(2, 2)', 'assert.equal(3, 3)')],
      ['hook-added', guarded.replace("it('sibling'", "before(async () => {}); it('sibling'")],
    ]) {
      assert.notEqual(mutated, guarded, label);
      writeFileSync(target, mutated);
      assert.throws(() => assertParityBindings(pathToFileURL(target), bindings), undefined, label);
    }
    const qualificationRejections = {};
    for (const [label, altered] of [
      ['hook', current.replace("host: '127.0.0.1'", "host: '0.0.0.0'")],
      ['input', current.replace("const API = '/api'", "const API = '/elsewhere'")],
      ['hook-added', current.replace("it('sibling'", "before(async () => {}); it('sibling'")],
    ]) {
      assert.notEqual(altered, current);
      writeFileSync(target, altered);
      manifest.files[0].currentSha256 = parityHash(altered);
      const retry = qualifyParityManifest(manifest, { root, readBaseline: () => baseline });
      assert.ok(retry.pending.length, label);
      qualificationRejections[label] = retry.pending[0].reason;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
