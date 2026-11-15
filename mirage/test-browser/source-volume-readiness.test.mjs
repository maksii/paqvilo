// @test-kind contract: usable grid search and refresh after fresh/restarted source loading preserve the complete invented dataset and local edits.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { performanceFixture } from '../test/runtime-performance-fixture.mjs';
import { sharedBrowser } from './shared-browser.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';

const browser = sharedBrowser();
test('source-volume startup reaches a usable search, refreshes and preserves local edits on restart', async (t) => {
  const fixture = await performanceFixture({ tables: 64, formsPerTable: 4, records: 4096, columns: 8 });
  ownedFixture(t).remove(() => fixture.cleanup());
  const page = await browser.page(t),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  for (const run of ['fresh', 'restart']) {
    const start = performance.now(),
      phases = [];
    const sim = await createSimulator({
      sourceDir: fixture.sourceDir,
      solutionRoots: fixture.solutionRoots,
      packs: [fixture.pack],
      preset: 'invented-scale',
      presetMode: 'bootstrap',
      stateFile: path.join(fixture.root, 'state.json'),
      watch: false,
      onStartup: (entry) => phases.push(entry.phase),
    });
    ownedFixture(t).add(() => sim.close());
    const startupMs = performance.now() - start;
    assert.ok(phases.includes('listener-ready'));
    assert.equal(Object.keys(sim.store.state.mappings).filter((name) => /^x_scale\d+$/.test(name)).length, 64);
    assert.equal(
      Object.entries(sim.store.state.tables)
        .filter(([name]) => /^x_scale\d+$/.test(name))
        .reduce((sum, [, rows]) => sum + rows.length, 0),
      4096,
    );
    const navigation = performance.now();
    await page.goto(sim.url + '/main.aspx?appname=x_scale&pagetype=entitylist&etn=x_scale0', {
      waitUntil: 'domcontentloaded',
    });
    const search = page.getByRole('searchbox', { name: 'Filter by keyword' });
    await search.waitFor();
    assert.equal(await search.isEnabled(), true);
    await search.fill('');
    await page
      .getByRole('button', { name: run === 'fresh' ? 'Invented 0/0' : 'Invented 0/0 preserved', exact: true })
      .waitFor();
    const usableMs = performance.now() - navigation;
    await search.fill('Invented 0/63');
    await page.getByRole('button', { name: 'Invented 0/63', exact: true }).waitFor();
    const refreshed = performance.now();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await search.waitFor();
    await page.getByRole('button', { name: 'Invented 0/63', exact: true }).waitFor();
    t.diagnostic(
      JSON.stringify({
        run,
        startupMs,
        usableMs,
        refreshMs: performance.now() - refreshed,
        peakRssMiB: process.resourceUsage().maxRSS / 1024,
      }),
    );
    if (run === 'fresh') {
      const row = sim.store.tableRows('x_scale0')[0];
      await sim.store.update('x_scale0', row.x_scale0id, { x_value0: 'Invented 0/0 preserved' }, { admin: true });
    } else assert.equal(sim.store.tableRows('x_scale0')[0].x_value0, 'Invented 0/0 preserved');
    await sim.close();
  }
  assert.deepEqual(errors, []);
  assert.equal(fixture.generated(), 1, 'restart does not reapply the data preset');
});
