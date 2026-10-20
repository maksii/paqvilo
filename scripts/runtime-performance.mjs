import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSimulator } from '../mirage/server.mjs';
import { performanceFixture } from '../mirage/test/runtime-performance-fixture.mjs';

// Opt-in source-volume investigation, deliberately absent from ordinary CI.
export const LARGE_PERFORMANCE_OPTIONS = Object.freeze({ scales: [256], formsPerTable: 40, records: 20000,
  startupBudgets: { fresh: 30000, unchanged: 30000, 'journal-grown': 30000 }, budgetMs: 30000,
  catalogueBudgetMs: 30000, heartbeatBudgetMs: 1000, strictBudgets: false });

/** Sequential loopback probe: never consumes an external portal or business data. */
export async function runtimePerformance({ scales = [16, 32, 64], records = 10000, formsPerTable = 1, columns = 24, portal = true,
  budgetMs = 30000, catalogueBudgetMs = budgetMs, heartbeatBudgetMs = 1000, dataBudgetMs = heartbeatBudgetMs, startupBudgets = {}, strictBudgets = true, onProgress = () => {},
  phases = ['fresh', 'unchanged', 'journal-grown'] } = {}) {
  const results = [], findings = [];
  const checkBudget = (durationMs, limitMs, finding) => {
    if (durationMs <= limitMs) return;
    findings.push({ ...finding, durationMs: Math.round(durationMs), budgetMs: limitMs });
    if (strictBudgets) throw Error(`${finding.stage} exceeded declared ${limitMs} ms budget`);
  };
  for (const tables of scales) {
    const fixtureStarted = performance.now();
    const fixture = await performanceFixture({ tables, records, formsPerTable, columns });
    const fixtureMs = Math.round(performance.now() - fixtureStarted);
    onProgress({ tables, phase: 'fixture-created', fixtureMs, inventory: fixture.inventory });
    let sim;
    try {
      const stateFile = path.join(fixture.root, 'state.json');
      const options = { ...(portal ? { sourceDir: fixture.sourceDir } : { runtime: { kind: 'model-driven' } }), solutionRoots: fixture.solutionRoots,
        stateFile, watch: false, packs: [fixture.pack], preset: 'invented-scale', presetMode: 'bootstrap', persistence: { journalThresholdBytes: 0 } };
      for (const phase of phases) {
        const before = fixture.generated(), started = performance.now(), memoryBefore = process.memoryUsage();
        const progress = [];
        sim = await createSimulator({ ...options, onStartup: entry => { progress.push(entry); onProgress({ tables, run: phase, ...entry }); } });
        const startupMs = performance.now() - started;
        onProgress({ tables, run: phase, phase: 'startup-complete', elapsedMs: Math.round(startupMs) });
        const catalogue = [];
        for (const warmth of ['cold', 'warm']) {
          const started = performance.now();
          let complete = false;
          const pending = fetch(sim.url + '/_apps/api', { signal: AbortSignal.timeout(catalogueBudgetMs) }).then(async response => { if (!response.ok) throw Error(`Catalogue ${response.status}`); return response.json(); }).finally(() => { complete = true; });
          // Status failure/timeout may reach cleanup before this request settles.
          pending.catch(() => {});
          const heartbeat = [], heartbeatErrors = [];
          do {
            const at = performance.now();
            try {
              const response = await fetch(sim.url + '/_sim/api/status', { signal: AbortSignal.timeout(heartbeatBudgetMs) });
              if (!response.ok) throw Error(`Status ${response.status}`); await response.arrayBuffer();
            } catch (error) {
              if (strictBudgets) throw error;
              heartbeatErrors.push({ name: error.name, message: error.message });
              findings.push({ tables, phase, warmth, stage: 'status request', error: error.name, budgetMs: heartbeatBudgetMs });
            }
            const durationMs = performance.now() - at; heartbeat.push(durationMs);
            checkBudget(durationMs, heartbeatBudgetMs, { tables, phase, warmth, stage: 'status heartbeat' });
            if (!complete) await new Promise(resolve => setTimeout(resolve, 5));
          } while (!complete);
          let value;
          try { value = await pending; }
          catch (error) {
            if (strictBudgets) throw error;
            findings.push({ tables, phase, warmth, stage: 'catalogue request', error: error.name, budgetMs: catalogueBudgetMs });
            catalogue.push({ warmth, durationMs: Math.round(performance.now() - started), error: { name: error.name, message: error.message },
              maxHeartbeatMs: Math.round(Math.max(...heartbeat)), heartbeats: heartbeat.length, heartbeatErrors });
            continue;
          }
          if (!value.tables.x_scale0?.fields.x_value1?.isSecured) throw Error('Missing secured imported field');
          for (let i = 0; i < tables; i++) if (value.tables[`x_scale${i}`]?.forms.length !== formsPerTable) throw Error(`Imported forms are incomplete for x_scale${i}`);
          const durationMs = performance.now() - started;
          checkBudget(durationMs, catalogueBudgetMs, { tables, phase, warmth, stage: 'catalogue response' });
          catalogue.push({ warmth, durationMs: Math.round(durationMs), maxHeartbeatMs: Math.round(Math.max(...heartbeat)), heartbeats: heartbeat.length, heartbeatErrors });
          onProgress({ tables, run: phase, phase: 'catalogue-complete', ...catalogue.at(-1) });
        }
        const dataReads = [];
        const recordId = sim.store.tableRows('x_scale0')[0].x_scale0id;
        for (const [kind, route] of [['first-grid', '/_apps/api/tables/x_scale0'], ['first-record', '/_apps/api/tables/x_scale0/' + recordId]]) {
          const at = performance.now();
          const response = await fetch(sim.url + route, { signal: AbortSignal.timeout(catalogueBudgetMs) });
          if (!response.ok) throw Error(`${kind} response ${response.status}`);
          const value = await response.json();
          if (kind === 'first-grid' && (!value.rows.length || value.rows.length > 50)) throw Error('First grid did not return its populated bounded page');
          if (kind === 'first-record' && value.row.x_scale0id !== recordId) throw Error('First record read did not retain its record identity');
          const durationMs = performance.now() - at;
          checkBudget(durationMs, dataBudgetMs, { tables, phase, stage: kind });
          dataReads.push({ kind, durationMs: Math.round(durationMs), ...(value.rows ? { rows: value.rows.length } : {}) });
          onProgress({ tables, run: phase, phase: 'data-read-complete', ...dataReads.at(-1) });
        }
        const status = portal ? sim.state({ summary: true }).status : sim.status();
        const actualRecords = Object.entries(sim.store.state.tables).filter(([name]) => /^x_scale\d+$/.test(name)).reduce((total, [, rows]) => total + rows.length, 0);
        if (actualRecords !== records) throw Error('Imported fixture record count changed');
        const startupBudgetMs = startupBudgets[phase] ?? budgetMs;
        results.push({ tables, formsPerTable, phase, startupMs: Math.round(startupMs), startupBudgetMs, generated: fixture.generated() - before,
          preset: status.startupPreset, timings: status.bootstrap?.timings, progress, catalogue, dataReads, stateBytes: (await fs.stat(stateFile)).size,
          rows: sim.store.tableRows('x_scale0').length, actualRecords, inventory: fixture.inventory, fixtureMs, memoryBefore, memory: process.memoryUsage() });
        checkBudget(startupMs, startupBudgetMs, { tables, phase, stage: 'startup' });
        if (phase === 'unchanged') for (let i = 0; i < 25; i++) await sim.store.update('x_scale0', sim.store.tableRows('x_scale0')[0].x_scale0id, { x_value0: `Local journal edit ${i}` }, { admin: true });
        if (phase === 'journal-grown' && sim.store.tableRows('x_scale0')[0].x_value0 !== 'Local journal edit 24') throw Error('Restart lost a local edit');
        await sim.close(); sim = null;
      }
    } finally { await sim?.close(); await fixture.cleanup(); }
  }
  return { version: 1, dataset: 'invented loopback fixture', budgetMs, startupBudgets, catalogueBudgetMs, heartbeatBudgetMs, dataBudgetMs, strictBudgets,
    startupBudget: 'post-completion elapsed assertion; embedding caller owns startup cancellation', records, columns, formsPerTable, portal, findings, results };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--quick') && process.argv.includes('--large')) throw Error('Choose --quick or --large, not both.');
  const report = await runtimePerformance({ portal: !process.argv.includes('--standalone'),
    onProgress: entry => console.error(JSON.stringify({ type: 'performance-progress', ...entry })),
    ...(process.argv.includes('--quick') ? { scales: [16], records: 1000 } : {}),
    ...(process.argv.includes('--large') ? LARGE_PERFORMANCE_OPTIONS : {}) });
  console.log(JSON.stringify(report, null, 2));
  if (report.findings.length) process.exitCode = 1;
}
