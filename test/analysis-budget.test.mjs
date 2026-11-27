// @test-kind contract: the static analysis budget: default ceilings, raising them (--analysis-limit, sites.<id>.analysis.limits) up to a fixed maximum, and reporting both
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyzeProject } from '../lense/analysis/index.mjs';
import { ANALYSIS_LIMITS, ANALYSIS_LIMIT_MAXIMUMS } from '../lense/analysis/limits.mjs';
import { createFixture, tempDirSync } from './fixture.mjs';
import { withProcessSlot } from '../mirage/test/process-slots.mjs';

const cli = fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PAQVILO_')));
const run = (cwd, ...args) =>
  withProcessSlot(
    () =>
      new Promise((resolve) => {
        execFile(
          process.execPath,
          [cli, ...args],
          { cwd, env, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
          (error, stdout, stderr) => resolve({ status: error?.code ?? 0, stdout, stderr }),
        );
      }),
  );

/** An invented source with `count` small pages, one more than the default files ceiling by default. */
function pages(t, count = ANALYSIS_LIMITS.files + 1) {
  const root = tempDirSync('paq-analysis-budget-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (let index = 0; index < count; index++) fs.writeFileSync(path.join(root, `p${index}.html`), '<p>invented</p>');
  return root;
}

test('a source over the default files ceiling is incomplete and names it; a raised ceiling completes and is reported', (t) => {
  const root = pages(t);
  const bounded = analyzeProject(root);
  assert.equal(bounded.complete, false);
  assert.equal(bounded.verdict, 'incomplete');
  assert.equal(bounded.coverage.files, ANALYSIS_LIMITS.files);
  assert.deepEqual(bounded.coverage.exhaustedLimits, ['files']);
  assert.deepEqual(bounded.coverage.limitOverrides, []);
  const raised = analyzeProject(root, {
    limits: { files: ANALYSIS_LIMITS.files + 1 },
    limitSources: { files: '--analysis-limit' },
  });
  assert.equal(raised.complete, true);
  assert.equal(raised.coverage.files, ANALYSIS_LIMITS.files + 1);
  assert.deepEqual(raised.coverage.exhaustedLimits, []);
  assert.deepEqual(raised.coverage.limitOverrides, [
    { limit: 'files', value: ANALYSIS_LIMITS.files + 1, default: ANALYSIS_LIMITS.files, source: '--analysis-limit' },
  ]);
});

test('a raised ceiling that the source still exceeds is incomplete and names it', (t) => {
  const root = pages(t, 12);
  const analysis = analyzeProject(root, { limits: { files: 11 } });
  assert.equal(analysis.complete, false);
  assert.deepEqual(analysis.coverage.exhaustedLimits, ['files']);
  assert.equal(analysis.coverage.limitOverrides[0].source, 'caller');
});

test('no ceiling can be raised past its maximum, through the API, the command line or the catalogue', async (t) => {
  const root = pages(t, 1);
  for (const [key, maximum] of Object.entries(ANALYSIS_LIMIT_MAXIMUMS)) {
    assert.equal(analyzeProject(root, { limits: { [key]: maximum } }).coverage.limits[key], maximum);
    assert.throws(() => analyzeProject(root, { limits: { [key]: maximum + 1 } }), /Invalid static analysis limit/);
  }
  // The catalogue's site budget is checked when the catalogue loads, before any source is read.
  const config = path.join(root, 'paqvilo.config.yml');
  fs.writeFileSync(
    config,
    `sites:\n  example:\n    source: .\n    environments:\n      local:\n        url: http://127.0.0.1:9\n    analysis:\n      limits:\n        files: ${ANALYSIS_LIMIT_MAXIMUMS.files + 1}\n`,
  );
  const catalogue = await run(root, 'analyze', '--config', config, '--json');
  assert.equal(catalogue.status, 1, catalogue.stdout);
  assert.match(
    catalogue.stdout,
    new RegExp(
      `sites\\.example\\.analysis\\.limits files must be an integer from 1 to ${ANALYSIS_LIMIT_MAXIMUMS.files}`,
    ),
  );
  const refused = await run(
    root,
    'analyze',
    '--source',
    root,
    '--analysis-limit',
    `files=${ANALYSIS_LIMIT_MAXIMUMS.files + 1}`,
    '--json',
  );
  assert.equal(refused.status, 1, refused.stderr);
  assert.equal(JSON.parse(refused.stdout).error.code, 'invalid_argument');
  for (const value of ['files', 'files=', 'files=0', 'unknown=5', 'files=1.5']) {
    const result = await run(root, 'analyze', '--source', root, '--analysis-limit', value, '--json');
    assert.equal(result.status, 1, `${value}: ${result.stdout}`);
    assert.equal(JSON.parse(result.stdout).error.code, 'invalid_argument', value);
  }
});

test('analyze and doctor take the budget from the catalogue site, and --analysis-limit over it', async (t) => {
  const fx = createFixture();
  t.after(() => fx.cleanup());
  const config = path.join(fx.dir, 'paqvilo.config.yml');
  fs.writeFileSync(
    config,
    'sites:\n  example:\n    source: .\n    environments:\n      local:\n        url: http://127.0.0.1:9\n    analysis:\n      limits:\n        directories: 20000\n        totalBytes: 134217728\n',
  );
  const analyzed = await run(
    fx.dir,
    'analyze',
    '--config',
    config,
    '--analysis-limit',
    'totalBytes=268435456',
    '--fail-on',
    'none',
    '--json',
  );
  const overrides = JSON.parse(analyzed.stdout).reports[0].analysis.coverage.limitOverrides;
  assert.deepEqual(overrides, [
    { limit: 'directories', value: 20000, default: 10000, source: 'sites.example.analysis.limits' },
    { limit: 'totalBytes', value: 268435456, default: ANALYSIS_LIMITS.totalBytes, source: '--analysis-limit' },
  ]);
  const doctor = await run(fx.dir, 'lense', 'doctor', '--config', config, '--analysis-limit', 'files=20000', '--json');
  const report = JSON.parse(doctor.stdout);
  const reported = (report.reports?.[0] ?? report).analysis.coverage.limitOverrides;
  assert.deepEqual(
    reported.map(({ limit, source }) => [limit, source]),
    [
      ['files', '--analysis-limit'],
      ['directories', 'sites.example.analysis.limits'],
      ['totalBytes', 'sites.example.analysis.limits'],
    ],
  );
});
