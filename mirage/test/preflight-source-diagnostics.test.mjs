// Loader failures reach the preflight graph: a missing root, an unsupported file and a corrupt ZIP are blocking
// solution-source rows, never an apparently valid empty inventory. Inventory notes stay out of the rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { preflight, preflightExitCode } from '../lib/capability-report.mjs';
import { buildSourceGraph } from '../lib/source-graph.mjs';
import { zipOf } from '../lib/dataverse-solutions.mjs';

async function tempDir(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'preflight-source-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('strict preflight over a missing root, an unsupported file and a corrupt ZIP exits 1 with a solution-source row', async t => {
  const root = await tempDir(t);
  const marker = 'INVENTED-CONTENT-4d1e';
  await fs.writeFile(path.join(root, 'fx.txt'), marker);
  await fs.writeFile(path.join(root, 'fx_broken.zip'), `PK${marker}`);
  for (const [input, reason] of [['does-not-exist', 'SOLUTION_ROOT_READ_FAILED'], ['fx.txt', 'SOLUTION_ROOT_UNSUPPORTED'], ['fx_broken.zip', 'SOLUTION_XML_INVALID']]) {
    const report = await preflight({ solutionRoots: [path.join(root, input)], strict: true, packs: [], env: {} });
    const rows = report.requirements.filter(row => row.kind === 'solution-source');
    assert.equal(rows.length, 1, input);
    assert.match(rows[0].id, /^solution-source:[0-9a-f]{12}$/);
    assert.equal(rows[0].status, 'missing');
    assert.equal(rows[0].reason, reason);
    assert.equal(rows[0].blocking, true);
    assert.equal(preflightExitCode(report), 1, input);
    assert.ok(report.diagnostics.some(item => item.code === reason), 'the report explains the row');
    assert.ok(!JSON.stringify(report).includes(marker), 'no file contents appear');
  }
});

test('an empty directory and a directory holding only a ZIP that is not a Solution block strict preflight with SOLUTION_ROOT_EMPTY', async t => {
  const root = await tempDir(t);
  await fs.mkdir(path.join(root, 'empty'));
  await fs.mkdir(path.join(root, 'zipped'));
  await fs.writeFile(path.join(root, 'zipped', 'fx_notes.zip'), zipOf([{ name: 'readme.txt', data: Buffer.from('invented') }]));
  for (const input of ['empty', 'zipped']) {
    const report = await preflight({ solutionRoots: [path.join(root, input)], strict: true, packs: [], env: {} });
    const rows = report.requirements.filter(row => row.kind === 'solution-source');
    assert.deepEqual(rows.map(row => [row.reason, row.blocking]), [['SOLUTION_ROOT_EMPTY', true]], input);
    assert.ok(report.diagnostics.some(item => item.code === 'SOLUTION_ROOT_EMPTY' && item.severity === 'error'), input);
    assert.equal(preflightExitCode(report), 1, input);
  }
});

test('without strict or a scenario a loader failure is reported but does not block', async t => {
  const root = await tempDir(t);
  const report = await preflight({ solutionRoots: [path.join(root, 'absent')], packs: [], env: {} });
  assert.equal(report.requirements.find(row => row.kind === 'solution-source').blocking, false);
  assert.equal(preflightExitCode(report), 0);
});

test('scan error diagnostics become missing requirements; inventory notes do not', () => {
  const graph = buildSourceGraph({ scan: { layers: [], inventory: [], diagnostics: [
    { code: 'SOLUTION_FOLDER_READ_FAILED', severity: 'error', source: 'C:/fx/locked' },
    { code: 'SOLUTION_DASHBOARD_INVENTORY', inventory: true, component: 'dashboard' },
    { code: 'SOLUTION_INVENTORY_READ_FAILED', severity: 'error', inventory: true, name: 'fx_app' },
    { code: 'SOLUTION_ORDER_CYCLE', source: 'C:/fx' },
  ] } });
  assert.deepEqual(graph.requirements().map(row => [row.kind, row.status, row.reason]), [['solution-source', 'missing', 'SOLUTION_FOLDER_READ_FAILED']]);
  assert.deepEqual(graph.diagnostics().map(item => item.code), ['SOLUTION_FOLDER_READ_FAILED']);
});
