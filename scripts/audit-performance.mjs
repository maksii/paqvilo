// Repeatable, synthetic loopback measurements for the test-audit follow-up.
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { auditOutput, writeAuditOutput, auditDependencies, auditGit } from './audit-qualification.mjs';

const { values } = parseArgs({
  options: {
    baseline: { type: 'string' },
    samples: { type: 'string', default: '7' },
    output: { type: 'string' },
    probe: { type: 'string' },
  },
});
const root = process.cwd();
const target = (name) => pathToFileURL(path.join(root, name)).href;

async function importProbe(file) {
  const started = performance.now();
  await import(target(file));
  return { elapsedMs: performance.now() - started, rssBytes: process.memoryUsage().rss };
}

async function runtimeProbe() {
  const { DataStore, emptyState } = await import(target('mirage/lib/data.mjs'));
  const { dataverseSettings } = await import(target('mirage/lib/dataverse-settings.mjs'));
  const { startDataverseApi } = await import(target('mirage/lib/dataverse-api.mjs'));
  const store = await new DataStore({ state: emptyState() }).init();
  let started = performance.now();
  const api = await startDataverseApi({ store, settings: dataverseSettings({ enabled: true }) });
  const apiStartMs = performance.now() - started;
  await api.close();
  const { createSimulator } = await import(target('mirage/server.mjs'));
  const { performanceFixture } = await import(target('mirage/test/runtime-performance-fixture.mjs'));
  const fixture = await performanceFixture({ tables: 1, columns: 4, records: 1 });
  let sim;
  let result;
  try {
    started = performance.now();
    sim = await createSimulator({
      sourceDir: fixture.sourceDir,
      solutionRoots: fixture.solutionRoots,
      stateFile: path.join(fixture.root, 'state.json'),
      watch: false,
      packs: [fixture.pack],
      preset: 'invented-scale',
      presetMode: 'bootstrap',
    });
    const portalStartMs = performance.now() - started;
    started = performance.now();
    const response = await fetch(sim.url + '/_sim/api/state');
    if (!response.ok) throw new Error(`State request failed: ${response.status}`);
    const stateBytes = (await response.arrayBuffer()).byteLength;
    result = { apiStartMs, portalStartMs, firstStateMs: performance.now() - started, stateBytes };
  } finally {
    try {
      await sim?.close();
    } finally {
      await fixture.cleanup();
    }
  }
  const { chromium } = await import(target('node_modules/playwright-core/index.mjs'));
  const { browserLaunchOptions } = await import(target('mirage/lib/browser-launch.mjs'));
  started = performance.now();
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  result.browserLaunchMs = performance.now() - started;
  result.browserVersion = browser.version();
  try {
    const page = await browser.newPage();
    await page.setContent('<h1>Invented loopback benchmark</h1>');
  } finally {
    started = performance.now();
    await browser.close();
    result.browserCloseMs = performance.now() - started;
  }
  return result;
}

if (values.probe) {
  const probe = values.probe;
  if (!['config', 'server', 'runtime'].includes(probe)) throw new Error('Unknown probe.');
  console.log(
    JSON.stringify(
      probe === 'runtime'
        ? await runtimeProbe()
        : await importProbe(probe === 'config' ? 'lense/config.mjs' : 'mirage/server.mjs'),
    ),
  );
} else {
  if (!/^[1-9]\d*$/.test(values.samples) || Number(values.samples) > 20)
    throw new Error('--samples must be an integer from 1 to 20.');
  const samples = Number(values.samples);
  const output = values.output ? await auditOutput(root, values.output) : null;
  const roots = values.baseline ? { before: path.resolve(values.baseline), after: root } : { current: root };
  const git = (cwd, args) => {
    const result = auditGit(cwd, args, { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`Cannot read Git identity: ${result.stderr}`);
    return result.stdout.trim();
  };
  const sourceTree = (cwd) => {
    if (git(cwd, ['diff', '--name-only']) || git(cwd, ['ls-files', '--others', '--exclude-standard']))
      throw new Error(
        'Stage or commit the complete source tree before measuring; keep output under ignored .paqvilo/.',
      );
    return git(cwd, ['write-tree']);
  };
  const dependencies = Object.fromEntries(
    await Promise.all(Object.entries(roots).map(async ([label, cwd]) => [label, await auditDependencies(cwd)])),
  );
  const report = {
    version: 1,
    environment: {
      node: process.version,
      platform: process.platform,
      cpus: os.cpus().length,
      memoryBytes: os.totalmem(),
      browserSelection: process.env.PAQVILO_BROWSER ?? 'platform default',
    },
    methodology:
      'One warmup, then fresh child processes in alternating A/B order; warm filesystem cache. Run without concurrent test jobs. Timings describe this fixture and machine, not a universal budget.',
    fixture:
      'One invented table, four columns, one record; standalone API has no configured applications; browser renders inline invented HTML.',
    samples,
    runs: Object.fromEntries(
      Object.entries(roots).map(([label, cwd]) => [
        label,
        {
          head: git(cwd, ['rev-parse', 'HEAD']),
          sourceTree: sourceTree(cwd),
          diff: git(cwd, ['diff', 'HEAD', '--stat']),
          probes: {},
          dependencies: dependencies[label],
        },
      ]),
    ),
  };
  for (const probe of ['config', 'server', 'runtime']) {
    const collected = Object.fromEntries(Object.keys(roots).map((label) => [label, []]));
    for (let index = -1; index < samples; index++) {
      const order = Object.entries(roots);
      if (index % 2 === 1) order.reverse();
      for (const [label, cwd] of order) {
        const child = spawnSync(process.execPath, [import.meta.filename, '--probe', probe], {
          cwd,
          encoding: 'utf8',
          windowsHide: true,
          timeout: 120000,
        });
        if (child.status !== 0) throw new Error(child.stderr || child.stdout || String(child.error));
        const value = JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1));
        if (index >= 0) collected[label].push(value);
      }
    }
    for (const [label, rows] of Object.entries(collected)) {
      const median = Object.fromEntries(
        Object.keys(rows[0])
          .filter((key) => typeof rows[0][key] === 'number')
          .map((key) => {
            const sorted = rows.map((row) => row[key]).sort((a, b) => a - b);
            const middle = Math.floor(sorted.length / 2);
            return [key, sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2];
          }),
      );
      report.runs[label].probes[probe] = { samples: rows, median };
    }
    if (
      probe === 'runtime' &&
      new Set(
        Object.values(collected)
          .flat()
          .map((row) => row.browserVersion),
      ).size !== 1
    )
      throw new Error('Browser version changed between samples; the comparison is not qualified.');
  }
  for (const [label, cwd] of Object.entries(roots))
    if (
      sourceTree(cwd) !== report.runs[label].sourceTree ||
      JSON.stringify(await auditDependencies(cwd)) !== JSON.stringify(dependencies[label])
    )
      throw new Error('Source tree or installed dependencies changed during measurement.');
  const json = JSON.stringify(report, null, 2) + '\n';
  if (output) await writeAuditOutput(output, json);
  for (const [label, cwd] of Object.entries(roots))
    if (sourceTree(cwd) !== report.runs[label].sourceTree) throw new Error('Source tree changed while writing report.');
  console.log(json);
}
