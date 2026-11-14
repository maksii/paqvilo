// Reload guard (solution-schema.mjs assertReloadableScan): a reload whose scan carries an error diagnostic the last accepted scan did
// not have (a Solution root renamed mid-checkout) is rejected before any state changes, on both hosts.
// @test-kind contract: a reused Solution scan carries the fingerprint of the side files this load read, as the designed reload contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { createMirageContext } from '../lib/mirage-context.mjs';
import { importSolutionData } from '../lib/solution-data.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { modelDrivenFixture } from './model-driven-fixture.mjs';
import { settleFileTimes } from './support/file-times.mjs';

const SOLUTION = {
  'Other/Solution.xml':
    '<ImportExportXml><SolutionManifest><UniqueName>InventedReload</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
  'customapis/x_Echo/customapi.xml':
    '<customapi uniquename="x_Echo"><bindingtype>0</bindingtype><isfunction>0</isfunction><name>x_Echo</name></customapi>',
};
const write = async (dir, entries) => {
  for (const [name, body] of Object.entries(entries)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), body);
  }
};
const apis = (sim) => (sim.store.state.tables.customapi ?? []).map((row) => row.uniquename);

async function renameBetweenReloads(t, portal) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'source-reload-rejected-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const solution = path.join(root, 'solution');
  await write(solution, SOLUTION);
  if (portal)
    await write(path.join(root, 'portal'), {
      'website.yml': 'adx_websiteid: fixture\nadx_name: Invented site',
      'Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true',
    });
  const sim = await createSimulator({
    ...(portal ? { sourceDir: path.join(root, 'portal') } : { runtime: { kind: 'dataverse-api' } }),
    solutionRoots: [solution],
    projectRoot: root,
    port: 0,
    watch: false,
    simulation: { level: 'dry-run' },
    dataverse: { enabled: true, tls: false, tds: { enabled: false } },
  });
  ownedFixture(t).add(() => sim.close());
  assert.deepEqual(apis(sim), ['x_Echo']);
  await fs.rename(solution, `${solution}-moved`);
  await assert.rejects(
    sim.reload(),
    (error) =>
      error.code === 'SOURCE_RELOAD_REJECTED' &&
      error.details.diagnostics.some((d) => d.code === 'SOLUTION_ROOT_READ_FAILED'),
  );
  assert.deepEqual(apis(sim), ['x_Echo']);
  assert.ok(
    !sim
      .state()
      .diagnostics.some((entry) => entry.code === 'SOURCE_EXTENSIONS_REFRESHED' || entry.code === 'SOURCES_RELOADED'),
  );
  await fs.rename(`${solution}-moved`, solution);
  await sim.reload();
  assert.deepEqual(apis(sim), ['x_Echo']);
}

test('a deployment profile change with a renamed Solution root is rejected and keeps the definitions (Power Pages host)', async (t) => {
  const { createSimulator: createPowerPages } = await import('../server.mjs');
  const { profileFixture } = await import('./fixtures/deployment-profiles.mjs');
  // The profile fixture removes its directory only after the runtime below has closed.
  const fixture = await profileFixture({ after: (fn) => ownedFixture(t).remove(fn) });
  const solution = fixture.solutionRoots[0];
  const app = await createPowerPages({ ...fixture, watch: false });
  ownedFixture(t).add(() => app.close());
  const definitions = () => (app.state().data.environmentvariabledefinition ?? []).map((row) => row.schemaname).sort();
  const before = definitions();
  assert.ok(before.length);
  await fs.rename(solution, `${solution}-moved`);
  const response = await fetch(`${app.url}/__sim/api/environment/profiles`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-sim-csrf': app.csrf },
    body: JSON.stringify({ profile: 'test' }),
  });
  assert.equal(response.status, 409);
  assert.match(await response.text(), /SOURCE_RELOAD_REJECTED/);
  assert.deepEqual(definitions(), before);
  await assert.rejects(app.reload(), { code: 'SOURCE_RELOAD_REJECTED' }, 'the rejected scan never became the baseline');
  await fs.rename(`${solution}-moved`, solution);
  await app.reload();
  assert.deepEqual(definitions(), before);
});

test('a reload with a renamed Solution root is rejected and keeps registrations (Dataverse host)', (t) =>
  renameBetweenReloads(t, false));
test('a reload with a renamed Solution root is rejected and keeps registrations (Power Pages host)', (t) =>
  renameBetweenReloads(t, true));

test('a reload that reuses the unchanged scan stamps this load fingerprint on its solution data after a side-file edit', async (t) => {
  // The reused scan is judged as an unchanged tree once the racy window has passed; the shifted clock stays in place
  // for the whole test, so the second load reuses the scan and only the side file has changed.
  settleFileTimes(t);
  const fixture = await modelDrivenFixture(t, { defer: true });
  const script = path.join(fixture.solutionDir, 'WebResources/x_/script.js');
  await fs.mkdir(path.dirname(script), { recursive: true });
  await fs.writeFile(script, 'invented();');
  const config = path.join(fixture.root, 'catalogue.json');
  const settings = {
    source: fixture.sourceDir,
    environments: { local: 'http://127.0.0.1:8787' },
    mirage: { solutionRoots: [fixture.solutionDir] },
  };
  await fs.writeFile(config, JSON.stringify({ sites: { invented: settings } }));
  const context = await createMirageContext({ config, site: 'invented', env: 'local' });
  const first = await context.createSimulator({ stateFile: null, watch: false });
  const firstFingerprint = first.store.state.simulator.solutionData.contentFingerprint;
  await first.close();
  await fs.writeFile(script, 'invented(); // edited');
  const second = await context.createSimulator({ stateFile: null, watch: false });
  ownedFixture(t).add(() => second.close());
  assert.equal(second.state({ summary: true }).status.bootstrap.timings.solutionReuse.scan, true, 'the scan is reused');
  const fresh = (await importSolutionData([fixture.solutionDir])).contentFingerprint;
  assert.notEqual(fresh, firstFingerprint, 'the side-file edit changes the fingerprint of a fresh load');
  assert.equal(second.store.state.simulator.solutionData.contentFingerprint, fresh);
});
