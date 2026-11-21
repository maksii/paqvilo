import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import { parseOptions } from '../lense/cli-options.mjs';
import { joinNegativeValues } from '../mirage/tool-options.mjs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { createSimulator } from '../mirage/server.mjs';
import { performanceFixture } from '../mirage/test/runtime-performance-fixture.mjs';

// Opt-in source-volume investigation, deliberately absent from ordinary CI.
export const LARGE_PERFORMANCE_OPTIONS = Object.freeze({
  scales: [256],
  formsPerTable: 40,
  records: 20000,
  startupBudgets: { fresh: 30000, unchanged: 30000, 'journal-grown': 30000 },
  budgetMs: 30000,
  catalogueBudgetMs: 30000,
  heartbeatBudgetMs: 1000,
  strictBudgets: false,
});

export const PERFORMANCE_USAGE = `Usage: node scripts/runtime-performance.mjs [--quick | --large] [--standalone]
  [--tables N[,N...]] [--forms-per-table N] [--records N]
  [--startup-budget MS] [--restart-budget MS] [--journal-budget MS] [--catalogue-budget MS] [--heartbeat-budget MS]
  [--data-budget MS]

Measures Mirage startup, restart and read latency against a generated synthetic source (mirage/docs/runtime-performance.md).
--quick runs one 16-table, 1,000-record case; --large runs 256 tables x 40 forms with 20,000 records and reports every
missed budget; --standalone measures the runtime without a portal. Exits 1 when a budget is missed, 2 for an invalid
invocation.`;

const DEFAULT_SCALES = [16, 32, 64];
const DEFAULT_RECORDS = 10000;

/** Budgets belong to the selected synthetic workload and machine, not every exported organization. */
export function performanceOptionsFromArgs(args) {
  const { values } = parseOptions({
    args: joinNegativeValues(args, PERFORMANCE_OPTION_TABLE),
    options: PERFORMANCE_OPTION_TABLE,
  });
  if (values.help) return { help: true };
  return optionsFromValues(values);
}

const PERFORMANCE_OPTION_TABLE = {
  quick: { type: 'boolean' },
  large: { type: 'boolean' },
  standalone: { type: 'boolean' },
  tables: { type: 'string' },
  records: { type: 'string' },
  'forms-per-table': { type: 'string' },
  'startup-budget': { type: 'string' },
  'restart-budget': { type: 'string' },
  'journal-budget': { type: 'string' },
  'catalogue-budget': { type: 'string' },
  'heartbeat-budget': { type: 'string' },
  'data-budget': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

function optionsFromValues(values) {
  if (values.quick && values.large) throw new Error('Choose --quick or --large, not both.');
  const positive = (value, name) => {
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
      throw new Error(`--${name} must be a positive safe integer.`);
    return Number(value);
  };
  const options = {
    portal: !values.standalone,
    ...(values.quick ? { scales: [16], records: 1000 } : {}),
    ...(values.large ? LARGE_PERFORMANCE_OPTIONS : {}),
  };
  if (values.tables !== undefined) options.scales = values.tables.split(',').map((value) => positive(value, 'tables'));
  for (const [flag, property] of Object.entries({
    records: 'records',
    'forms-per-table': 'formsPerTable',
    'catalogue-budget': 'catalogueBudgetMs',
    'heartbeat-budget': 'heartbeatBudgetMs',
    'data-budget': 'dataBudgetMs',
  }))
    if (values[flag] !== undefined) options[property] = positive(values[flag], flag);
  options.startupBudgets = { ...options.startupBudgets };
  for (const [flag, phase] of Object.entries({
    'startup-budget': 'fresh',
    'restart-budget': 'unchanged',
    'journal-budget': 'journal-grown',
  }))
    if (values[flag] !== undefined) options.startupBudgets[phase] = positive(values[flag], flag);
  // The fixture needs one record per table; the fallbacks are runtimePerformance's defaults.
  const largest = Math.max(...(options.scales ?? DEFAULT_SCALES));
  if ((options.records ?? DEFAULT_RECORDS) < largest)
    throw new Error(`--records must be at least ${largest}, the largest --tables value: one record per table.`);
  return options;
}

// Pause before status heartbeat `index` of a request, at least `budgetMs / 10` once the pause has grown that far.
// ponytail: a block shorter than the current pause can fall between two heartbeats; a block longer than a tenth of the
// budget is always seen.
export const heartbeatPause = (index, budgetMs) => Math.min(5 * 2 ** index, Math.max(5, Math.floor(budgetMs / 10)));

/**
 * Runs `probe()` (a heartbeat, resolving to its duration in ms) while the request it watches is incomplete. Each pause
 * is at least as long as the probe that preceded it, so probes take at most half of the server's time whatever its speed.
 * A pause ends early when `completed` resolves, so the caller's measured duration does not include the rest of the pause.
 */
export async function heartbeatsWhile(
  isComplete,
  probe,
  { pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), completed = null } = {},
) {
  let duration;
  do {
    duration = await probe();
    if (!isComplete()) {
      const wait = pause(Math.max(5, duration));
      await (completed ? Promise.race([Promise.resolve(wait), Promise.resolve(completed)]) : wait);
    }
  } while (!isComplete());
}

/** A strict-mode budget miss: code BUDGET_EXCEEDED, the stage and its budget in the message. */
const budgetExceeded = (stage, limitMs, cause) =>
  Object.assign(new Error(`${stage} exceeded declared ${limitMs} ms budget`, cause ? { cause } : undefined), {
    code: 'BUDGET_EXCEEDED',
  });

// A request aborted at its budget is that stage's budget miss; any other error passes through unchanged.
const budgetMiss = (error, stage, limitMs) =>
  error?.name === 'TimeoutError' ? budgetExceeded(stage, limitMs, error) : error;

/**
 * The body of a successful GET. With `strict`, the request is aborted at `limitMs` and the abort is that stage's
 * BUDGET_EXCEEDED miss; a non-2xx answer names the stage and status.
 */
export async function budgetedText(url, limitMs, stage, { strict = true } = {}) {
  try {
    const response = await fetch(url, { signal: strict ? AbortSignal.timeout(limitMs) : undefined });
    if (!response.ok) throw new Error(`${stage} response ${response.status}`);
    return await response.text();
  } catch (error) {
    throw budgetMiss(error, stage, limitMs);
  }
}

/** Sequential loopback probe: never consumes an external portal or business data. */
/* NOSONAR: single-pass routine, splitting it would change shared state */ export async function runtimePerformance({
  scales = DEFAULT_SCALES,
  records = DEFAULT_RECORDS,
  formsPerTable = 1,
  columns = 24,
  portal = true,
  budgetMs = 30000,
  catalogueBudgetMs = budgetMs,
  heartbeatBudgetMs = 1000,
  dataBudgetMs = heartbeatBudgetMs,
  startupBudgets = {},
  strictBudgets = true,
  onProgress = () => {},
  phases = ['fresh', 'unchanged', 'journal-grown'],
} = {}) {
  const results = [],
    findings = [];
  const checkBudget = (durationMs, limitMs, finding) => {
    if (durationMs <= limitMs) return;
    findings.push({ ...finding, durationMs: Math.round(durationMs), budgetMs: limitMs });
    if (strictBudgets) throw budgetExceeded(finding.stage, limitMs);
  };
  // Strict mode enforces the budgets: a request is aborted at its budget. Recording mode measures every request to its
  // end and reports a budget miss as a finding.
  const budgetSignal = (limitMs) => (strictBudgets ? AbortSignal.timeout(limitMs) : undefined);
  const budgetedRead = (url, limitMs, stage) => budgetedText(url, limitMs, stage, { strict: strictBudgets });
  for (const tables of scales) {
    const fixtureStarted = performance.now();
    const fixture = await performanceFixture({ tables, records, formsPerTable, columns });
    const fixtureMs = Math.round(performance.now() - fixtureStarted);
    onProgress({ tables, phase: 'fixture-created', fixtureMs, inventory: fixture.inventory });
    let sim, loopDelay;
    try {
      const stateFile = path.join(fixture.root, 'state.json');
      const options = {
        ...(portal ? { sourceDir: fixture.sourceDir } : { runtime: { kind: 'model-driven' } }),
        solutionRoots: fixture.solutionRoots,
        stateFile,
        watch: false,
        packs: [fixture.pack],
        preset: 'invented-scale',
        presetMode: 'bootstrap',
        persistence: { journalThresholdBytes: 0 },
      };
      for (const phase of phases) {
        loopDelay = monitorEventLoopDelay({ resolution: 10 });
        loopDelay.enable();
        const before = fixture.generated(),
          started = performance.now(),
          memoryBefore = process.memoryUsage();
        const progress = [];
        sim = await createSimulator({
          ...options,
          onStartup: (entry) => {
            progress.push(entry);
            onProgress({ tables, run: phase, ...entry });
          },
        });
        const startupMs = performance.now() - started;
        onProgress({ tables, run: phase, phase: 'startup-complete', elapsedMs: Math.round(startupMs) });
        const statusStarted = performance.now();
        let firstStatusError;
        try {
          const firstStatus = await fetch(sim.url + '/_sim/api/status', {
            signal: budgetSignal(catalogueBudgetMs),
          });
          if (!firstStatus.ok) throw new Error(`Status ${firstStatus.status}`);
          await firstStatus.arrayBuffer();
        } catch (error) {
          if (strictBudgets) throw budgetMiss(error, 'first status request', catalogueBudgetMs);
          firstStatusError = { name: error.name, message: error.message };
          findings.push({
            tables,
            phase,
            stage: 'first status request',
            error: error.name,
            budgetMs: catalogueBudgetMs,
          });
        }
        const firstStatusMs = performance.now() - statusStarted;
        checkBudget(firstStatusMs, heartbeatBudgetMs, { tables, phase, stage: 'first status response' });
        const catalogue = [];
        for (const warmth of ['cold', 'warm']) {
          const started = performance.now();
          let complete = false;
          const pending = fetch(sim.url + '/_apps/api', { signal: budgetSignal(catalogueBudgetMs) })
            .then(async (response) => {
              if (!response.ok) throw new Error(`Catalogue ${response.status}`);
              return response.text();
            })
            .finally(() => {
              complete = true;
            });
          // Status failure/timeout may reach cleanup before this request settles.
          pending.catch(() => {});
          const heartbeat = [],
            heartbeatErrors = [];
          await heartbeatsWhile(
            () => complete,
            async () => {
              const at = performance.now();
              try {
                const response = await fetch(sim.url + '/_sim/api/status', {
                  signal: budgetSignal(heartbeatBudgetMs),
                });
                if (!response.ok) throw new Error(`Status ${response.status}`);
                await response.arrayBuffer();
              } catch (error) {
                if (strictBudgets) throw budgetMiss(error, 'status request', heartbeatBudgetMs);
                heartbeatErrors.push({ name: error.name, message: error.message });
                findings.push({
                  tables,
                  phase,
                  warmth,
                  stage: 'status request',
                  error: error.name,
                  budgetMs: heartbeatBudgetMs,
                });
              }
              const durationMs = performance.now() - at;
              heartbeat.push(durationMs);
              checkBudget(durationMs, heartbeatBudgetMs, { tables, phase, warmth, stage: 'status heartbeat' });
              return durationMs;
            },
            {
              // The pause never shrinks below the count-bounded heartbeatPause, so the number of probes stays bounded too.
              pause: (ms) =>
                new Promise((resolve) =>
                  setTimeout(resolve, Math.max(ms, heartbeatPause(heartbeat.length - 1, heartbeatBudgetMs))),
                ),
              completed: pending.then(
                () => {},
                () => {},
              ),
            },
          );
          let value, catalogueParseMs;
          try {
            // Finish server heartbeats before parsing the response in this same
            // Node process. Consumer JSON.parse must not be attributed to a
            // blocked server; its cost remains in the total response duration.
            const text = await pending,
              parseAt = performance.now();
            value = JSON.parse(text);
            catalogueParseMs = performance.now() - parseAt;
          } catch (error) {
            if (strictBudgets) throw budgetMiss(error, 'catalogue request', catalogueBudgetMs);
            findings.push({
              tables,
              phase,
              warmth,
              stage: 'catalogue request',
              error: error.name,
              budgetMs: catalogueBudgetMs,
            });
            catalogue.push({
              warmth,
              durationMs: Math.round(performance.now() - started),
              error: { name: error.name, message: error.message },
              maxHeartbeatMs: Math.round(Math.max(...heartbeat)),
              heartbeats: heartbeat.length,
              heartbeatErrors,
            });
            continue;
          }
          if (!value.tables.x_scale0?.fields.x_value1?.isSecured) throw new Error('Missing secured imported field');
          for (let i = 0; i < tables; i++)
            if (value.tables[`x_scale${i}`]?.forms.length !== formsPerTable)
              throw new Error(`Imported forms are incomplete for x_scale${i}`);
          const durationMs = performance.now() - started;
          checkBudget(durationMs, catalogueBudgetMs, { tables, phase, warmth, stage: 'catalogue response' });
          catalogue.push({
            warmth,
            durationMs: Math.round(durationMs),
            parseMs: Math.round(catalogueParseMs),
            maxHeartbeatMs: Math.round(Math.max(...heartbeat)),
            heartbeats: heartbeat.length,
            heartbeatErrors,
          });
          onProgress({ tables, run: phase, phase: 'catalogue-complete', ...catalogue.at(-1) });
        }
        const metadataTransport = [];
        for (const attempt of ['first', 'repeat'])
          for (const route of ['index', 'metadata/x_scale0']) {
            const at = performance.now();
            const text = await budgetedRead(sim.url + '/_apps/api/' + route, catalogueBudgetMs, `metadata ${route}`),
              transferredMs = performance.now() - at,
              parseAt = performance.now();
            const value = JSON.parse(text),
              parseMs = performance.now() - parseAt;
            if (
              route === 'index' &&
              Object.values(value.tables).some((table) => table.forms || table.fields || table.views)
            )
              throw new Error('Index includes unrelated table bodies');
            if (route !== 'index' && value.forms.length !== formsPerTable)
              throw new Error('Selected-table forms are incomplete');
            metadataTransport.push({
              attempt,
              catalogueState: 'already constructed',
              route,
              bytes: Buffer.byteLength(text),
              transferredMs: Math.round(transferredMs),
              parseMs: Math.round(parseMs * 100) / 100,
            });
          }
        const dataReads = [];
        const recordId = sim.store.tableRows('x_scale0')[0].x_scale0id;
        for (const [kind, route] of [
          ['first-grid', '/_apps/api/tables/x_scale0'],
          ['first-record', '/_apps/api/tables/x_scale0/' + recordId],
        ]) {
          const at = performance.now();
          const value = JSON.parse(await budgetedRead(sim.url + route, catalogueBudgetMs, kind));
          if (kind === 'first-grid' && (!value.rows.length || value.rows.length > 50))
            throw new Error('First grid did not return its populated bounded page');
          if (kind === 'first-record' && value.row.x_scale0id !== recordId)
            throw new Error('First record read did not retain its record identity');
          const durationMs = performance.now() - at;
          checkBudget(durationMs, dataBudgetMs, { tables, phase, stage: kind });
          dataReads.push({
            kind,
            durationMs: Math.round(durationMs),
            ...(value.rows ? { rows: value.rows.length } : {}),
          });
          onProgress({ tables, run: phase, phase: 'data-read-complete', ...dataReads.at(-1) });
        }
        const status = portal ? sim.state({ summary: true }).status : sim.status();
        const actualRecords = Object.entries(sim.store.state.tables)
          .filter(([name]) => /^x_scale\d+$/.test(name))
          .reduce((total, [, rows]) => total + rows.length, 0);
        if (actualRecords !== records) throw new Error('Imported fixture record count changed');
        const startupBudgetMs = startupBudgets[phase] ?? budgetMs;
        const memoryAfter = process.memoryUsage(),
          peakRssBytes = process.resourceUsage().maxRSS * 1024;
        results.push({
          tables,
          formsPerTable,
          phase,
          startupMs: Math.round(startupMs),
          startupBudgetMs,
          firstStatusMs: Math.round(firstStatusMs),
          ...(firstStatusError ? { firstStatusError } : {}),
          eventLoop: {
            maxMs: loopDelay.max / 1e6,
            p99Ms: loopDelay.percentile(99) / 1e6,
            meanMs: Number.isFinite(loopDelay.mean) ? loopDelay.mean / 1e6 : null,
          },
          processPeakRssBytes: peakRssBytes,
          generated: fixture.generated() - before,
          preset: status.startupPreset,
          timings: status.bootstrap?.timings,
          progress,
          catalogue,
          metadataTransport,
          dataReads,
          stateBytes: (await fs.stat(stateFile)).size,
          rows: sim.store.tableRows('x_scale0').length,
          actualRecords,
          inventory: fixture.inventory,
          fixtureMs,
          memoryBefore,
          memory: memoryAfter,
        });
        loopDelay.disable();
        loopDelay = null;
        checkBudget(startupMs, startupBudgetMs, { tables, phase, stage: 'startup' });
        if (phase === 'unchanged')
          for (let i = 0; i < 25; i++)
            await sim.store.update(
              'x_scale0',
              sim.store.tableRows('x_scale0')[0].x_scale0id,
              { x_value0: `Local journal edit ${i}` },
              { admin: true },
            );
        if (phase === 'journal-grown' && sim.store.tableRows('x_scale0')[0].x_value0 !== 'Local journal edit 24')
          throw new Error('Restart lost a local edit');
        await sim.close();
        sim = null;
      }
    } finally {
      loopDelay?.disable();
      await sim?.close();
      await fixture.cleanup();
    }
  }
  return {
    version: 1,
    dataset: 'invented loopback fixture',
    readiness: 'API payload checks only; visible browser controls and application usability are measured separately.',
    budgetMs,
    startupBudgets,
    catalogueBudgetMs,
    heartbeatBudgetMs,
    dataBudgetMs,
    strictBudgets,
    execution: 'sequential same-process starts; filesystem warmth is not controlled',
    environment: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      logicalCpus: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
    },
    startupBudget: 'post-completion elapsed assertion; embedding caller owns startup cancellation',
    records,
    columns,
    formsPerTable,
    portal,
    findings,
    results,
  };
}
/**
 * The command: parses `args`, runs `run` (runtimePerformance) and writes the report to `out`, progress and messages to
 * `err`. Resolves to the exit code: 0, 1 for a missed budget, 2 for an invalid invocation.
 */
export async function runPerformanceCli(
  args,
  { run = runtimePerformance, out = console.log, err = console.error } = {},
) {
  let options;
  try {
    options = performanceOptionsFromArgs(args);
  } catch (error) {
    // An invalid invocation is one line naming the problem, never a stack trace.
    err(error.message);
    return 2;
  }
  if (options.help) {
    out(PERFORMANCE_USAGE);
    return 0;
  }
  try {
    const report = await run({
      ...options,
      onProgress: (entry) => err(JSON.stringify({ type: 'performance-progress', ...entry })),
    });
    out(JSON.stringify(report, null, 2));
    return report.findings.length ? 1 : 0;
  } catch (error) {
    // The default matrix stops at its first missed budget: one line naming the stage and budget, never a stack trace.
    if (error?.code !== 'BUDGET_EXCEEDED') throw error;
    err(`Stopped: ${error.message}.`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await runPerformanceCli(process.argv.slice(2));
