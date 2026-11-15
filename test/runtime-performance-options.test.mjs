import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { performanceOptionsFromArgs, runtimePerformance } from '../scripts/runtime-performance.mjs';

test('performance workload and per-phase budgets reach the measured report without changing default qualification', async () => {
  // Budgets sit far above any runner's timings: this checks that they reach the report, not this machine's speed.
  const options = performanceOptionsFromArgs([
    '--standalone',
    '--tables',
    '2',
    '--records',
    '20',
    '--forms-per-table',
    '2',
    '--startup-budget',
    '300000',
    '--restart-budget',
    '310000',
    '--journal-budget',
    '320000',
    '--catalogue-budget',
    '330000',
    '--heartbeat-budget',
    '60000',
    '--data-budget',
    '61000',
  ]);
  const report = await runtimePerformance(options);
  assert.equal(report.portal, false);
  assert.equal(report.records, 20);
  assert.equal(report.formsPerTable, 2);
  assert.deepEqual(
    report.results.map((row) => row.startupBudgetMs),
    [300000, 310000, 320000],
  );
  assert.deepEqual([report.catalogueBudgetMs, report.heartbeatBudgetMs, report.dataBudgetMs], [330000, 60000, 61000]);
  assert.equal(report.strictBudgets, true, 'declared budgets keep the default strict qualification');
  assert.deepEqual(report.findings, []);
  for (const row of report.results) {
    assert.equal(row.actualRecords, 20);
    assert.equal(row.inventory.forms, 4);
    assert.ok(row.firstStatusMs >= 0);
    assert.ok(row.eventLoop.maxMs >= 0);
    assert.ok(row.processPeakRssBytes >= row.memory.rss);
  }
  assert.match(report.readiness, /API payload checks only/);
});

test('performance CLI rejects unknown options and invalid budgets before creating fixtures', () => {
  for (const args of [
    ['--unknown'],
    ['--quick', '--large'],
    ['--startup-budget', '0'],
    ['--heartbeat-budget', '-1'],
    ['--data-budget', 'NaN'],
    ['--tables', '2,0'],
    ['--tables', ''],
    ['--records', '1e4'],
  ])
    assert.throws(() => performanceOptionsFromArgs(args), undefined, JSON.stringify(args));
});

test('the --large workload is the one the runtime performance guide documents', () => {
  const options = performanceOptionsFromArgs(['--large']);
  const guide = fs.readFileSync(new URL('../mirage/docs/runtime-performance.md', import.meta.url), 'utf8');
  const [, tables, forms, xmlFiles, records] = guide.match(
    /runtime-performance\.mjs --large +# ([\d,]+) tables x ([\d,]+) forms \(([\d,]+) XML files\), ([\d,]+) records/,
  );
  const number = (text) => Number(text.replaceAll(',', ''));
  assert.deepEqual(options.scales, [number(tables)]);
  assert.equal(options.formsPerTable, number(forms));
  assert.equal(options.records, number(records));
  // One Entity.xml and the forms per table, plus the Solution manifest and app module.
  assert.equal(options.scales[0] * (1 + options.formsPerTable) + 2, number(xmlFiles));
});
