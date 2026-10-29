import { runtimeHeartbeat } from './runtime-heartbeat.mjs';
// Opt-in invented, loopback-only browser qualification. Each start has its own
// server process so RSS and lazy catalogue costs cannot inherit previous runs.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { performanceFixture, performanceId } from '../mirage/test/runtime-performance-fixture.mjs';
import { createSimulator } from '../mirage/server.mjs';
import { complexPerformanceFixture } from '../mirage/test/complex-performance-fixture.mjs';
import { consumeCatalogue } from './catalogue-stream.mjs';
import { appendFileSync } from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { setImmediate } from 'node:timers/promises';

const makeFixture = (options) => (options.complex ? complexPerformanceFixture(options) : performanceFixture(options));
const progressFile = process.env.PAQVILO_QUALIFICATION_PROGRESS;
const maxRssMiB = Number(process.env.PAQVILO_QUALIFICATION_MAX_RSS_MIB ?? 8192);
if (!Number.isFinite(maxRssMiB) || maxRssMiB <= 0) throw Error('Invalid qualification RSS budget');
const maxRssBytes = maxRssMiB * 1024 * 1024;
const progress = (value) => {
  if (progressFile) appendFileSync(progressFile, JSON.stringify(value) + '\n');
  console.error(JSON.stringify(value));
};

if (process.argv[2] === '--worker') {
  process.once('message', async ({ options, phase }) => {
    let sim, sampling;
    try {
      const fixture = await makeFixture({
        ...options,
        onProgress: (entry) => {
          if (entry.phase === 'fixture-records')
            process.send({ progress: { run: phase, ...entry, peakRssBytes: process.resourceUsage().maxRSS * 1024 } });
        },
      });
      const at = performance.now();
      sim = await createSimulator({
        sourceDir: fixture.sourceDir,
        solutionRoots: fixture.solutionRoots,
        stateFile: path.join(fixture.root, (options.stateGroup ?? 'state') + '.json'),
        watch: false,
        packs: [fixture.pack],
        preset: 'invented-scale',
        presetMode: 'bootstrap',
        persistence: { journalThresholdBytes: 0 },
        ...(options.complex ? { modelDriven: { trustedExtensions: true } } : {}),
        onStartup: (entry) =>
          process.send({
            progress: {
              run: phase,
              ...entry,
              memory: process.memoryUsage(),
              peakRssBytes: process.resourceUsage().maxRSS * 1024,
            },
          }),
      });
      process.send({
        ready: {
          pid: process.pid,
          url: sim.url,
          csrf: sim.csrf,
          startupMs: Math.round(performance.now() - at),
          generated: fixture.generated(),
          memory: process.memoryUsage(),
          peakRssBytes: process.resourceUsage().maxRSS * 1024,
        },
      });
      const delay = monitorEventLoopDelay({ resolution: 20 });
      delay.enable();
      let samples = 0;
      sampling = setInterval(() => {
        const maxEventLoopDelayMs = Math.round(delay.max / 1e6);
        if (++samples % 10 === 0 || maxEventLoopDelayMs >= 250)
          process.send({
            progress: {
              run: phase,
              phase: 'resource-sample',
              maxEventLoopDelayMs,
              memory: process.memoryUsage(),
              peakRssBytes: process.resourceUsage().maxRSS * 1024,
            },
          });
        delay.reset();
      }, 1000);
      sampling.unref();
      process.once('message', async ({ abort = false }) => {
        try {
          if (abort) return;
          process.send({ progress: { run: phase, phase: 'record-integrity-verification' } });
          assert.equal(
            Object.entries(sim.store.state.tables)
              .filter(([key]) => /^x_scale\d+$/.test(key))
              .reduce((sum, [, rows]) => sum + rows.length, 0),
            options.records,
          );
          if (options.complex) {
            const wide = Math.ceil(options.tables / 2);
            let wideRecords = 0;
            let yieldedAt = performance.now();
            for (let table = 0; table < wide; table++) {
              const rows = sim.store.state.tables['x_scale' + table];
              wideRecords += rows.length;
              assert.ok(Object.keys(rows[0]).length >= 257, 'Every wide table has populated dense rows');
              for (let link = 0; link < 200; link++) {
                const target = 'x_scale' + ((table + link + 1) % options.tables);
                assert.equal(rows[0]['x_link' + link], sim.store.state.tables[target][0][target + 'id']);
              }
              if (performance.now() - yieldedAt >= 8) {
                await setImmediate();
                yieldedAt = performance.now();
              }
            }
            assert.equal(wideRecords, fixture.inventory.complexRecords);
          }
          if (['journal-grown', 'source-changed'].includes(phase))
            assert.equal(sim.store.tableRows('x_scale0')[0].x_value0, 'Local edit 24');
          if (phase === 'unchanged')
            for (let i = 0; i < 25; i++)
              await sim.store.update(
                'x_scale0',
                sim.store.tableRows('x_scale0')[0].x_scale0id,
                { x_value0: 'Local edit ' + i },
                { admin: true },
              );
          process.send({
            result: {
              peakRssBytes: process.resourceUsage().maxRSS * 1024,
              memory: process.memoryUsage(),
              generated: fixture.generated(),
            },
          });
        } catch (error) {
          process.send({ error: error.stack });
          process.exitCode = 1;
        } finally {
          clearInterval(sampling);
          delay.disable();
          await sim.close();
          process.disconnect();
        }
      });
    } catch (error) {
      clearInterval(sampling);
      process.send({ error: error.stack });
      await sim?.close();
      process.exitCode = 1;
      process.disconnect();
    }
  });
} else {
  const args = process.argv.slice(2);
  for (const flag of args.filter((value) => value.startsWith('--')))
    if (!['--simple', '--complex', '--fresh-only'].includes(flag)) throw Error('Unknown qualification flag ' + flag);
  const positional = args.filter((value) => !value.startsWith('--'));
  const tables = Number(positional[0] ?? 2000),
    records = Number(positional[1] ?? 10000000);
  const sourceRoot = process.env.PAQVILO_QUALIFICATION_SOURCE_ROOT;
  const stateGroup = process.env.PAQVILO_QUALIFICATION_STATE_GROUP ?? 'state';
  if (!/^[a-z\d-]+$/i.test(stateGroup)) throw Error('Invalid qualification state group');
  const options = {
    tables,
    records,
    formsPerTable: 8,
    columns: args.includes('--simple') ? 24 : undefined,
    roots: Math.min(3, tables),
    shape: positional[2] ?? 'uniform',
    complex: !args.includes('--simple'),
    stateGroup,
  };
  const fixture = await makeFixture({
      ...options,
      ...(sourceRoot ? { existingRoot: sourceRoot } : {}),
      onProgress: progress,
    }),
    results = [];
  progress({ phase: 'fixture-created', root: fixture.root, options, inventory: fixture.inventory });
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  let child, fullAbort, heartbeat;
  try {
    const requestedPhases = process.env.PAQVILO_QUALIFICATION_PHASES?.split(',');
    if (requestedPhases?.some((phase) => !['fresh', 'unchanged', 'journal-grown', 'source-changed'].includes(phase)))
      throw Error('Invalid qualification phase');
    for (const phase of requestedPhases ??
      (args.includes('--fresh-only') ? ['fresh'] : ['fresh', 'unchanged', 'journal-grown', 'source-changed'])) {
      if (phase === 'source-changed') {
        const source = path.join(fixture.solutionRoots[0], 'Entities/x_scale0/Entity.xml');
        await fs.writeFile(
          source,
          (await fs.readFile(source, 'utf8')).replace('<IsSecured>1</IsSecured>', '<IsSecured>0</IsSecured>'),
        );
      }
      const serverStartedAt = performance.now();
      child = fork(fileURLToPath(import.meta.url), ['--worker'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      const messages = [],
        waiters = new Set();
      const wait = (key) =>
        new Promise((resolve, reject) => {
          const check = () => {
            const error = messages.find((message) => message.error);
            const value = messages.find((message) => key in message);
            if (error || value) {
              waiters.delete(check);
              error ? reject(Error(error.error)) : resolve(value[key]);
            }
          };
          waiters.add(check);
          check();
        });
      const exited = new Promise((resolve, reject) =>
        child.once('exit', (code) => {
          if (code !== 0) {
            messages.push({ error: 'Worker exited ' + code });
            for (const wake of waiters) wake();
            reject(Error('Worker exited ' + code));
          } else resolve();
        }),
      );
      exited.catch(() => {});
      child.on('message', (message) => {
        if (message.result) void heartbeat?.stop();
        const peak = message.progress?.peakRssBytes ?? message.ready?.peakRssBytes ?? message.result?.peakRssBytes;
        if (peak > maxRssBytes) {
          const error = `Server peak RSS ${Math.ceil(peak / 1024 / 1024)} MiB exceeds ${maxRssMiB} MiB budget`;
          progress({ phase: 'resource-budget-failed', run: phase, peakRssBytes: peak, maxRssBytes });
          messages.push({ error });
          child.kill();
          for (const wake of waiters) wake();
          return;
        }
        messages.push(message);
        if (message.progress) progress(message.progress);
        for (const wake of waiters) wake();
      });
      child.send({ options: { ...options, existingRoot: fixture.root }, phase });
      const ready = await wait('ready');
      const processStartupMs = Math.round(performance.now() - serverStartedAt);
      progress({ phase: 'listener-ready', run: phase, ...ready, processStartupMs, url: undefined, csrf: undefined });
      heartbeat = runtimeHeartbeat(ready.url, {
        onFailure: (failure) => progress({ phase: 'heartbeat-failed', run: phase, ...failure }),
      });
      const executePhase = async () => {
        const timings = {},
          read = async (route) => {
            const at = performance.now(),
              response = await fetch(ready.url + route, {
                signal: AbortSignal.timeout(options.complex ? 300000 : 30000),
              });
            assert.equal(response.status, 200, route);
            const text = await response.text();
            timings[route] = { ms: Math.round(performance.now() - at), bytes: Buffer.byteLength(text) };
            return JSON.parse(text);
          };
        await read('/_sim/api/status');
        const context = await browser.newContext(),
          page = await context.newPage(),
          errors = [],
          requests = [],
          pendingRequests = new Map();
        page.on('pageerror', (error) => {
          errors.push(error.message);
          progress({ phase: 'browser-error', run: phase, message: error.message });
        });
        page.on('response', (response) => {
          if (response.status() >= 400)
            progress({
              phase: 'browser-http-failure',
              run: phase,
              path: new URL(response.url()).pathname,
              status: response.status(),
            });
        });
        page.on('console', (message) => {
          if (message.type() === 'error')
            progress({ phase: 'browser-console-error', run: phase, message: message.text() });
        });
        page.on('request', (request) => {
          const route = new URL(request.url()).pathname;
          requests.push(route);
          pendingRequests.set(request, route);
        });
        page.on('requestfinished', (request) => pendingRequests.delete(request));
        page.on('requestfailed', (request) => pendingRequests.delete(request));
        page.setDefaultTimeout(30000);
        const at = performance.now();
        await page.goto(ready.url + '/main.aspx?appname=x_scale&pagetype=entitylist&etn=x_scale0', {
          waitUntil: 'domcontentloaded',
        });
        const firstName = ['journal-grown', 'source-changed'].includes(phase) ? 'Local edit 24' : 'Invented 0/0';
        await page
          .getByRole('button', { name: firstName === 'Local edit 24' ? 'Invented 0/1' : firstName, exact: true })
          .waitFor();
        await page.waitForFunction(() => document.documentElement.dataset.mirageAppState === 'ready');
        const firstUsableMs = Math.round(performance.now() - at);
        progress({ phase: 'grid-usable', run: phase, ms: firstUsableMs });
        assert.ok(
          !requests.includes('/_apps/api'),
          'First usable page uses selected-table metadata without fetching every form',
        );
        const searchAt = performance.now();
        await page.getByRole('searchbox', { name: 'Filter by keyword' }).fill(firstName);
        const searched = page.waitForResponse(
          (response) => new URL(response.url()).pathname === '/_apps/api/tables/x_scale0',
        );
        await page.getByRole('searchbox', { name: 'Filter by keyword' }).press('Enter');
        await (await searched).finished();
        await page.getByRole('button', { name: firstName, exact: true }).waitFor();
        await page.waitForFunction(() => document.documentElement.dataset.mirageAppState === 'ready');
        const searchMs = Math.round(performance.now() - searchAt);
        progress({ phase: 'search-usable', run: phase, ms: searchMs });
        const recordAt = performance.now();
        const recordRemaining = () => Math.max(1, 30000 - (performance.now() - recordAt));
        await page.getByRole('button', { name: firstName, exact: true }).click();
        await page
          .locator('input[name="x_value0"]')
          .waitFor({ timeout: recordRemaining() })
          .then(() =>
            page.waitForFunction(() => document.documentElement.dataset.mirageAppState === 'ready', undefined, {
              timeout: recordRemaining(),
            }),
          )
          .catch(async (error) => {
            progress({
              phase: 'record-read-failed',
              run: phase,
              pending: [...pendingRequests.values()],
              message: error.message,
            });
            if (progressFile)
              await page.screenshot({ path: progressFile + '.' + phase + '.png', fullPage: true }).catch(() => {});
            throw error;
          });
        const recordOpenMs = Math.round(performance.now() - recordAt);
        progress({ phase: 'record-usable', run: phase, ms: recordOpenMs });
        await page.locator('input[name="x_value0"]').fill('Review draft');
        assert.equal(await page.locator('input[name="x_value0"]').inputValue(), 'Review draft');
        if (options.complex) {
          await page.locator('input[name="x_value0"]').press('Tab');
          await page.waitForFunction(() => window.scaleChanges > 0);
          await page.getByLabel('Scale custom input', { exact: true }).waitFor();
          await page.getByLabel('Scale custom input', { exact: true }).fill('PCF review draft');
          assert.equal(
            await page.evaluate(() => globalThis.Xrm.Page.getAttribute('x_value2').getValue()),
            'PCF review draft',
          );
          const custom = await page.evaluate(() => ({
            loads: window.scaleLoads,
            mounts: window.scaleControlMounts,
            changes: window.scaleChanges,
          }));
          assert.ok(custom.loads > 0 && custom.mounts > 0, 'Imported scripts and PCF execute through the real shell');
          progress({ phase: 'customizations-exercised', run: phase, ...custom });
        }
        assert.deepEqual(errors, []);
        await context.close();
        const index = await read('/_apps/api/index');
        assert.equal(Object.keys(index.tables).filter((name) => /^x_scale\d+$/.test(name)).length, tables);
        const selected = await read('/_apps/api/metadata/x_scale0');
        assert.equal(selected.forms.length, options.formsPerTable);
        assert.equal(Boolean(selected.fields.x_value1.isSecured), phase !== 'source-changed');
        if (options.complex) assert.ok(Object.keys(selected.fields).length >= 257);
        if (options.complex) {
          const persisted = await read('/_apps/api/tables/x_scale0/' + performanceId(10000));
          assert.equal(persisted.row.x_value0, firstName, 'Unsaved authored-script draft does not alter stored data');
          assert.notEqual(persisted.row.x_value2, 'PCF review draft', 'PCF draft remains local until save');
          const wide = Math.ceil(tables / 2);
          const countFor = (table) => {
            const first = table < wide ? 0 : wide,
              size = table < wide ? wide : tables - wide;
            const total = table < wide ? fixture.inventory.complexRecords : records - fixture.inventory.complexRecords;
            return Math.floor(total / size) + (table - first < total % size ? 1 : 0);
          };
          for (const table of new Set([0, wide - 1, wide, tables - 1].filter((table) => table < tables))) {
            const name = 'x_scale' + table,
              count = countFor(table);
            for (let view = 0; view < 4; view++) {
              const query = {
                view: performanceId(2000000 + table * 4 + view),
                pageSize: 25,
                columns: ['x_value0', 'x_quantity', 'x_choice0', 'x_link0'],
                sort: name + 'id',
                direction: 'asc',
              };
              const result = await read(
                '/_apps/api/tables/' + name + '?query=' + encodeURIComponent(JSON.stringify(query)),
              );
              const total =
                view === 1
                  ? Math.floor(count / 1000) * 500 + Math.max(0, (count % 1000) - 500)
                  : view === 2
                    ? Math.floor((count + 1) / 3)
                    : count;
              assert.equal(result.total, Math.min(total, 5000), name + ' view ' + view);
              assert.equal(Boolean(result.totalLimitExceeded), total > 5000, 'Native count cap remains explicit');
              assert.equal(result.rows.length, Math.min(25, total));
              for (const row of result.rows) {
                if (view === 1) assert.ok(row.x_quantity >= 500);
                if (view === 2) assert.equal(row.x_choice0, 2);
                if (view === 3) {
                  if (row.x_link0) assert.equal(typeof row['related.x_value0'], 'string');
                  else assert.ok(row['related.x_value0'] == null, 'Outer join retains rows without a lookup');
                }
              }
            }
          }
          progress({ phase: 'saved-views-exercised', run: phase });
        }
        const fullAt = performance.now();
        let completeTables = 0,
          completeWideTables = 0;
        fullAbort = new AbortController();
        const fullRequest = fetch(ready.url + '/_apps/api', {
          signal: AbortSignal.any([fullAbort.signal, AbortSignal.timeout(options.complex ? 600000 : 30000)]),
        }).then(async (response) => {
          assert.equal(response.status, 200);
          const result = await consumeCatalogue(response.body, (name, value) => {
            if (!/^x_scale\d+$/.test(name)) return;
            completeTables++;
            if (completeTables % 64 === 0) progress({ phase: 'catalogue-tables', run: phase, completeTables, tables });
            assert.equal(value.forms.length, options.formsPerTable, name);
            if (options.complex) {
              assert.equal(value.views.length, 4, name);
              const table = Number(name.slice('x_scale'.length));
              if (table < Math.ceil(tables / 2)) {
                completeWideTables++;
                assert.ok(Object.keys(value.fields).length >= 257, name);
                for (let link = 0; link < 200; link++)
                  assert.deepEqual(
                    value.fields['x_link' + link].targets,
                    ['x_scale' + ((table + link + 1) % tables)],
                    name,
                  );
              }
            }
          });
          timings['/_apps/api'] = { ms: Math.round(performance.now() - fullAt), bytes: result.bytes };
          return result;
        });
        fullRequest.catch(() => {});
        await fullRequest;
        assert.equal(completeTables, tables, 'Complete catalogue retains every business table');
        if (options.complex) assert.equal(completeWideTables, Math.ceil(tables / 2));
        child.send({ finish: true });
        const finished = await wait('result');
        const result = {
          phase,
          ...ready,
          processStartupMs,
          url: undefined,
          csrf: undefined,
          firstUsableMs,
          searchMs,
          recordOpenMs,
          ...heartbeat.metrics(),
          heartbeatScope:
            'listener readiness through browser interactions, saved views, complete metadata and journal edits',
          timings,
          ...finished,
        };
        await exited;
        child = undefined;
        return result;
      };
      try {
        const result = await Promise.race([executePhase(), heartbeat.failure]);
        results.push(result);
        progress({ phase, ...result, memory: undefined });
      } finally {
        await heartbeat.stop();
      }
    }
    console.log(
      JSON.stringify(
        {
          dataset: 'invented loopback only',
          options,
          inventory: fixture.inventory,
          executionArgs: process.execArgv,
          clientPeakRssBytes: process.resourceUsage().maxRSS * 1024,
          maxServerRssBytes: maxRssBytes,
          execution:
            'separate server process per start; startupMs measures createSimulator initialization; processStartupMs includes worker launch, module imports and fixture setup through readiness; filesystem warmth uncontrolled; RSS excludes browser and parent client',
          results,
        },
        null,
        2,
      ),
    );
  } finally {
    await heartbeat?.stop();
    fullAbort?.abort();
    if (child && child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise((resolve) => child.once('exit', resolve));
      if (child.connected) child.send({ abort: true });
      else child.kill();
      const killTimer = setTimeout(() => child.kill(), 5000);
      try {
        await stopped;
      } finally {
        clearTimeout(killTimer);
      }
    }
    await browser.close();
    if (!sourceRoot && process.env.PAQVILO_KEEP_QUALIFICATION !== '1') await fixture.cleanup();
    else progress({ phase: 'fixture-retained', root: fixture.root });
  }
}
