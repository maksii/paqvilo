// @test-kind security: HEAD mirrors GET on the administration API of both hosts, so it must never reveal or spend a one-time value (the App Service identity header) or change runtime state on any mirrored route
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { TRACE_HOSTS } from '../lib/trace-store.mjs';
import { makeTemporaryDirectory, ownedFixture } from '../testing/owned-fixture.mjs';

const ENTITY =
  '<Entity><Name>x_item</Name><EntityInfo><entity Name="x_item"><EntitySetName>x_items</EntitySetName><PrimaryIdAttribute>x_itemid</PrimaryIdAttribute><PrimaryNameAttribute>x_name</PrimaryNameAttribute><attributes><attribute PhysicalName="x_itemid"><Name>x_itemid</Name><Type>primarykey</Type></attribute><attribute PhysicalName="x_name"><Name>x_name</Name><Type>nvarchar</Type></attribute></attributes></entity></EntityInfo></Entity>';

// The Power Pages host over a portal source, or the standalone host over an invented Solution.
async function start(t, host = 'power-pages') {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'mirage-head-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  let options;
  if (host === 'power-pages') {
    await fs.writeFile(path.join(dir, 'website.yml'), 'adx_websiteid: site\nadx_name: Invented head site\n');
    options = { sourceDir: dir, dataverse: { enabled: true } };
  } else {
    const solution = path.join(dir, 'solution');
    await fs.mkdir(path.join(solution, 'Entities', 'x_item'), { recursive: true });
    await fs.mkdir(path.join(solution, 'Other'), { recursive: true });
    await fs.writeFile(
      path.join(solution, 'Other', 'Solution.xml'),
      '<ImportExportXml><SolutionManifest><UniqueName>InventedHead</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    );
    await fs.writeFile(path.join(solution, 'Entities', 'x_item', 'Entity.xml'), ENTITY);
    options = {
      solutionRoots: [solution],
      projectRoot: dir,
      stateFile: path.join(dir, 'state.json'),
      simulation: { level: 'dry-run' },
      runtime: { kind: 'dataverse-api' },
      dataverse: { enabled: true, tls: false, tds: { enabled: false } },
    };
  }
  const sim = await createSimulator({ ...options, watch: false });
  ownedFixture(t).add(() => sim.close());
  return sim;
}
const digest = (sim) =>
  createHash('sha256')
    .update(JSON.stringify([sim.store.revision, sim.store.state]))
    .digest('hex');
const status = async (sim) =>
  (await fetch(`${sim.url}/_sim/api/dataverse`, { headers: { 'x-sim-csrf': sim.csrf } })).json();

for (const host of ['power-pages', 'standalone']) {
  test(`${host}: HEAD of the Dataverse status leaves the App Service identity header to be revealed exactly once by GET`, async (t) => {
    const sim = await start(t, host);
    const head = await fetch(`${sim.url}/_sim/api/dataverse`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    const first = await status(sim);
    assert.equal(typeof first.managedIdentity.header, 'string');
    assert.ok(first.managedIdentity.header.length > 0);
    assert.equal((await status(sim)).managedIdentity.header, null, 'the header is shown once');
  });

  test(`${host}: HEAD on every mirrored administration route answers as GET and leaves the runtime state unchanged`, async (t) => {
    const sim = await start(t, host);
    const routes = (await (await fetch(`${sim.url}/_sim/api/status`)).json()).routes;
    assert.ok(routes.includes('/dataverse') && routes.length > 10, JSON.stringify(routes));
    const before = digest(sim);
    const heads = new Map();
    for (const route of routes) {
      const head = await fetch(`${sim.url}/_sim/api${route}`, { method: 'HEAD' });
      assert.equal((await head.arrayBuffer()).byteLength, 0, route);
      heads.set(route, head.status);
      assert.equal(digest(sim), before, route);
    }
    assert.equal(typeof (await status(sim)).managedIdentity.header, 'string', 'no HEAD spent the identity header');
    for (const route of routes) {
      const get = await fetch(`${sim.url}/_sim/api${route}`);
      await get.arrayBuffer();
      assert.equal(heads.get(route), get.status, `${route}: HEAD answers as GET`);
    }
  });
}

// @test-kind contract: the status payload publishes the trace hosts the `host` filter accepts, so the Activity view lists the runtime's own set.
test('status publishes the trace hosts the host filter accepts', async (t) => {
  const sim = await start(t);
  const status = await (await fetch(`${sim.url}/_sim/api/status`)).json();
  assert.deepEqual(status.traceHosts, [...TRACE_HOSTS]);
});
