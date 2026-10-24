import test from 'node:test';
import assert from 'node:assert/strict';
import { performanceOptionsFromArgs, runtimePerformance } from '../scripts/runtime-performance.mjs';

test('performance workload and per-phase budgets reach the measured report without changing default qualification', async () => {
  const options = performanceOptionsFromArgs([
    '--standalone',
    '--tables',
    '2',
    '--records',
    '20',
    '--forms-per-table',
    '2',
    '--startup-budget',
    '10000',
    '--restart-budget',
    '11000',
    '--journal-budget',
    '12000',
    '--catalogue-budget',
    '10000',
    '--heartbeat-budget',
    '5000',
    '--data-budget',
    '5000',
  ]);
  const report = await runtimePerformance(options);
  assert.equal(report.portal, false);
  assert.equal(report.records, 20);
  assert.equal(report.formsPerTable, 2);
  assert.deepEqual(
    report.results.map((row) => row.startupBudgetMs),
    [10000, 11000, 12000],
  );
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
