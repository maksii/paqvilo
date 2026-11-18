// @test-kind tooling: the performance probe's heartbeat pauses are at least the probe duration before them, so probes take at most half of the server's time
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  budgetedText,
  heartbeatsWhile,
  performanceOptionsFromArgs,
  runPerformanceCli,
  runtimePerformance,
} from '../scripts/runtime-performance.mjs';

test('heartbeat pauses are at least the probe before them, so the probes never take more than half of the wait', async () => {
  const durations = [40, 7, 3];
  const pauses = [];
  let complete = false;
  await heartbeatsWhile(
    () => complete,
    async () => durations.shift(),
    {
      pause: async (ms) => {
        pauses.push(ms);
        if (pauses.length === 3) complete = true;
      },
    },
  );
  assert.deepEqual(pauses, [40, 7, 5]);
});

test('a heartbeat pause ends when the watched request completes', async () => {
  let complete = false,
    done;
  const completed = new Promise((resolve) => (done = resolve));
  const probes = [];
  const run = heartbeatsWhile(
    () => complete,
    async () => (probes.push(1), 40),
    { pause: () => new Promise(() => {}), completed },
  );
  await Promise.resolve();
  complete = true;
  done();
  assert.equal(
    await Promise.race([run.then(() => 'returned'), new Promise((resolve) => setImmediate(() => resolve('pending')))]),
    'returned',
  );
  assert.equal(probes.length, 1);
});

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

// @test-kind tooling: a repeated value option and too few records for the largest table count are invalid invocations
test('the script prints its usage for --help and one line with exit code 2 for an invalid invocation', async () => {
  const { spawnSync } = await import('node:child_process');
  const script = new URL('../scripts/runtime-performance.mjs', import.meta.url);
  const run = (...args) =>
    spawnSync(process.execPath, [script.pathname.replace(/^\/([A-Za-z]:)/, '$1'), ...args], {
      encoding: 'utf8',
    });
  const help = run('--help');
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^Usage: node scripts\/runtime-performance\.mjs \[--quick \| --large\]/);
  for (const [args, message] of [
    [['--quick', '--large'], 'Choose --quick or --large, not both.'],
    [['--bogus'], "Unknown option '--bogus'. Run with --help to see supported options."],
    [['--records', '-1'], '--records must be a positive safe integer.'],
    [['--records', '10', '--records', '20'], '--records may be given only once'],
    [['--records', '10'], '--records must be at least 64, the largest --tables value: one record per table.'],
    [
      ['--tables', '2,4', '--records', '3'],
      '--records must be at least 4, the largest --tables value: one record per table.',
    ],
  ]) {
    const result = run(...args);
    assert.equal(result.status, 2, args.join(' '));
    assert.equal(result.stderr, `${message}\n`, args.join(' '));
    assert.equal(result.stdout, '');
  }
});

// A loopback stub that answers at once, or holds every response until the client aborts the request.
async function stubServer(t, { answer }) {
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    if (answer) res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return `http://127.0.0.1:${server.address().port}/`;
}

const cliRun = async (run) => {
  const out = [],
    err = [];
  const code = await runPerformanceCli(['--quick'], {
    run,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, out, err };
};

// @test-kind tooling: a missed budget in the default (strict) matrix ends the command with one line and exit code 1
test('the default matrix stops at its first missed budget with one line naming the stage, never a stack trace', async (t) => {
  // The stub never answers, so the budgeted read is aborted at its budget however fast the host is.
  const url = await stubServer(t, { answer: false });
  const result = await cliRun(() => budgetedText(url, 50, 'catalogue request'));
  assert.equal(result.code, 1);
  assert.deepEqual(result.out, []);
  assert.deepEqual(result.err, ['Stopped: catalogue request exceeded declared 50 ms budget.']);
});

// @test-kind tooling: a budgeted read that is answered is no budget miss
test('a budgeted read that the server answers is returned and the command exits 0', async (t) => {
  const url = await stubServer(t, { answer: true });
  const result = await cliRun(async () => ({
    body: await budgetedText(url, 600000, 'catalogue request'),
    findings: [],
  }));
  assert.equal(result.code, 0, result.err.join('\n'));
  assert.deepEqual(result.err, []);
  assert.deepEqual(JSON.parse(result.out[0]), { body: '{}', findings: [] });
});
