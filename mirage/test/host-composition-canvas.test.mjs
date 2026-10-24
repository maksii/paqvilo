// Project `canvas` configuration (canvas-source.mjs canvasSettings): enabled false unmounts the /_apps/canvas/ surface and
// reports it disabled; canvas.sources adds project apps to the inventory; a missing path is CANVAS_SOURCE_MISSING.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator, preflight } from '../api.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';
import { writeSolutionAssetEntries } from '../lib/dataverse-solution-assets.mjs';

const HOME = 'Screens:\n  HomeScreen:\n    Properties:\n      Fill: =RGBA(255, 255, 255, 1)\n';

test('Solution canvas metadata, payload and metadata-only overlay agree between host and both preflights', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-fidelity-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const payload = writeSolutionAssetEntries([{ name: 'Src/HomeScreen.pa.yaml', data: Buffer.from(HOME) }]);
  for (const [relative, bytes] of Object.entries({
    'first/Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>First</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'first/CanvasApps/x_app.meta.xml':
      '<CanvasApp><Name>x_app</Name><CanvasAppId>77777777-7777-4777-8777-777777777777</CanvasAppId></CanvasApp>',
    'first/CanvasApps/x_app_DocumentUri.msapp': payload,
    'later/Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>Later</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'later/CanvasApps/x_app.meta.xml':
      '<CanvasApp><Name>x_app</Name><CanvasAppId>77777777-7777-4777-8777-777777777777</CanvasAppId></CanvasApp>',
  })) {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
  }
  const options = {
    runtime: { kind: 'dataverse-api' },
    solutionRoots: [path.join(root, 'first'), path.join(root, 'later')],
    solutionOrder: 'explicit',
    projectRoot: root,
    port: 0,
    watch: false,
    simulation: { level: 'dry-run' },
    dataverse: { enabled: true, tls: false, tds: { enabled: false } },
  };
  const offline = await preflight({
    ...options,
    strict: true,
    scenario: { id: 'logic', requires: ['canvas:app/x_app'] },
  });
  const sim = await createSimulator(options);
  ownedFixture(t).add(() => sim.close());
  const listing = await (await fetch(sim.url + '/_apps/canvas/', { headers: { accept: 'application/json' } })).json();
  assert.equal(listing.apps.length, 1);
  assert.equal(listing.apps[0].screens, 1);
  assert.equal(listing.apps[0].level, 'behaviour');
  const running = await sim.preflight({ strict: true, scenario: { id: 'logic', requires: ['canvas:app/x_app'] } });
  for (const report of [offline, running]) {
    assert.ok(report.requirements.some((row) => row.id === 'canvas:app/x_app' && row.status === 'satisfied'));
    assert.ok(report.requirements.some((row) => row.id === 'canvas:rendering' && row.status === 'placeholder'));
    assert.ok(!report.requirements.some((row) => row.reason === 'CANVAS_HOST_NOT_IMPLEMENTED'));
  }
});

async function start(t, canvas, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'host-canvas-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  for (const [relative, content] of Object.entries({
    'solution/Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>InventedCanvas</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'apps/fx_invented/Src/HomeScreen.pa.yaml': HOME,
    ...options.files,
  })) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), content);
  }
  const sim = await createSimulator({
    runtime: { kind: 'dataverse-api' },
    solutionRoots: [path.join(root, 'solution')],
    projectRoot: root,
    port: 0,
    watch: false,
    simulation: { level: 'dry-run' },
    canvas,
    dataverse: { enabled: true, tls: false, tds: { enabled: false } },
    connections: options.connections,
  });
  ownedFixture(t).add(() => sim.close());
  return sim;
}

test('canvas.enabled false unmounts /_apps/canvas/ and reports the surface disabled', async (t) => {
  const sim = await start(t, { enabled: false });
  const response = await fetch(sim.url + '/_apps/canvas/', { headers: { accept: 'application/json' } });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, 'CanvasAppsDisabled');
  assert.equal(sim.state().capabilities.canvas, 'disabled');
  assert.ok(sim.state().diagnostics.some((entry) => entry.code === 'CANVAS_DISABLED'));
});

test('canvas.sources adds a project canvas app to the inventory', async (t) => {
  const sim = await start(t, { sources: ['apps/fx_invented'] });
  const listing = await (await fetch(sim.url + '/_apps/canvas/', { headers: { accept: 'application/json' } })).json();
  assert.deepEqual(
    listing.apps.map((app) => [app.uniqueName, app.screens]),
    [['fx_invented', 1]],
  );
  assert.equal(sim.state().capabilities.canvas, 'behaviour');
  const report = await sim.preflight();
  assert.ok(report.modules.some((record) => record.name === 'canvasapp:fx_invented' && record.level === 'behaviour'));
  // A project canvas app gets the canvas:app row a Solution app gets, and the rendering boundary row.
  const rows = Object.fromEntries(
    report.requirements.filter((row) => row.kind === 'canvas').map((row) => [row.id, row.status]),
  );
  assert.deepEqual(rows, { 'canvas:app/fx_invented': 'satisfied', 'canvas:rendering': 'placeholder' });
  // The runtime is wired: the driver API asks for a principal instead of answering CanvasRuntimeUnavailable.
  const driver = await fetch(sim.url + '/_apps/api/canvas/fx_invented');
  assert.deepEqual([driver.status, (await driver.json()).error.code], [401, 'CanvasPrincipalRequired']);
});

test('the system map connects a canvas app to staff, records, Power Fx, connectors and its connection, and security to the store', async (t) => {
  const sim = await start(
    t,
    { sources: ['apps/fx_invented'] },
    {
      connections: { Svc: { provider: 'fixture' } },
      files: {
        'apps/fx_invented/Src/App.pa.yaml': [
          'App:',
          '  Properties: {}',
          'DataSources:',
          '  Widgets:',
          '    Type: Table',
          '    Parameters:',
          '      TableLogicalName: x_widget',
          '  Svc:',
          '    Type: Actions',
          '    ConnectorId: shared_fxinvented',
          '',
        ].join('\n'),
      },
    },
  );
  const dashboard = await (await fetch(sim.url + '/_sim/api/dashboard')).json();
  const ids = new Set(dashboard.nodes.map((node) => node.id)),
    pairs = dashboard.edges.map((edge) => `${edge.from}>${edge.to}`);
  for (const pair of [
    'client:staff>app:canvas',
    'app:canvas>org:store',
    'app:canvas>provider:powerfx',
    'app:canvas>provider:connectors',
    'app:canvas>connection:Svc',
    'org:store>org:security',
  ])
    assert.ok(pairs.includes(pair), pair);
  assert.equal(dashboard.nodes.find((node) => node.id === 'org:security')?.status, 'ready');
  for (const edge of dashboard.edges)
    assert.ok(ids.has(edge.from) && ids.has(edge.to), `${edge.from}>${edge.to} has both ends`);
});

test('a missing canvas source reports CANVAS_SOURCE_MISSING and a missing preflight requirement', async (t) => {
  const sim = await start(t, { sources: ['apps/does-not-exist.msapp'] });
  assert.ok(
    sim
      .state()
      .diagnostics.some(
        (entry) => entry.code === 'CANVAS_SOURCE_MISSING' && entry.source === 'apps/does-not-exist.msapp',
      ),
  );
  const report = await sim.preflight({ scenario: { id: 'fx-canvas', requires: ['canvas-source:*'] } });
  const row = report.requirements.find((item) => item.id === 'canvas-source:apps/does-not-exist.msapp');
  assert.equal(row.status, 'missing');
  assert.equal(row.reason, 'CANVAS_SOURCE_MISSING');
  assert.equal(row.blocking, true);
});

test('canvas.enabled false unmounts /_apps/canvas/ on the Power Pages host too', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'host-canvas-pp-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  for (const [relative, content] of Object.entries({
    'solution/Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>InventedCanvas</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'portal/website.yml': 'adx_websiteid: fixture\nadx_name: Invented site',
    'portal/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true',
  })) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), content);
  }
  const sim = await createSimulator({
    sourceDir: path.join(root, 'portal'),
    solutionRoots: [path.join(root, 'solution')],
    projectRoot: root,
    port: 0,
    watch: false,
    simulation: { level: 'dry-run' },
    canvas: { enabled: false },
  });
  ownedFixture(t).add(() => sim.close());
  for (const suffix of ['/_apps/canvas/', '/_apps/canvas/x_app']) {
    const response = await fetch(sim.url + suffix, { headers: { accept: 'application/json' } });
    assert.equal(response.status, 404, suffix);
    assert.equal((await response.json()).error.code, 'CanvasAppsDisabled');
  }
  const status = await (await fetch(sim.url + '/_sim/api/status')).json();
  assert.equal(status.capabilities.canvas, 'disabled');
  const dashboard = await (await fetch(sim.url + '/_sim/api/dashboard')).json();
  assert.equal(dashboard.nodes.find((node) => node.id === 'app:canvas')?.status, 'disabled');
});
