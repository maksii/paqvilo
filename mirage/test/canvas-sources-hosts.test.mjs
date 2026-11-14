// @test-kind contract: configured Canvas source folders are de-duplicated, watched and revisioned on both hosts
// A Solution canvas app that is also a configured canvas.sources folder is listed once (the folder replaces the packed app),
// and edits in that folder reach the app's revision on the Power Pages host and on the standalone host.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { writeSolutionAssetEntries } from '../lib/dataverse-solution-assets.mjs';

const APP = 'inv_inventedapp_1a2b3';
const screen = (name, text) =>
  `Screens:\n  ${name}:\n    Children:\n      - ${name}Label:\n          Control: Label\n          Properties:\n            Text: ="${text}"\n`;

const portalFiles = {
  'portal/website.yml':
    'adx_name: Invented Site\nadx_websiteid: site\nadx_defaultlanguage: lang-en\nadx_website_language: 1033',
  'portal/websitelanguage.yml': '- adx_websitelanguageid: lang-en\n  adx_name: English',
  'portal/web-pages/home/Home.webpage.yml':
    'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main',
  'portal/page-templates/Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main',
  'portal/web-templates/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
  'portal/web-templates/Main.webtemplate.source.html': '<p>Invented</p>',
};

async function fixture(t, { portal }) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'canvas-sources-hosts-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const packed = writeSolutionAssetEntries([
    { name: 'Src/PackedScreen.pa.yaml', data: Buffer.from(screen('PackedScreen', 'Invented packed')) },
  ]);
  const files = {
    'solution/Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>InventedApps</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'solution/CanvasApps/inv_inventedapp_1a2b3.meta.xml': `<CanvasApp><Name>${APP}</Name><DisplayName>Invented app</DisplayName><CanvasAppId>77777777-7777-4777-8777-777777777778</CanvasAppId></CanvasApp>`,
    'solution/CanvasApps/inv_inventedapp_1a2b3.msapp': packed,
    [`apps/${APP}/Src/HomeScreen.pa.yaml`]: screen('HomeScreen', 'Invented first'),
    ...(portal ? portalFiles : {}),
  };
  for (const [relative, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), content);
  }
  return root;
}

function options(root) {
  return {
    solutionRoots: [path.join(root, 'solution')],
    projectRoot: root,
    canvas: { sources: [`apps/${APP}`] },
    port: 0,
    watch: true,
  };
}

async function startStandalone(t, root) {
  const sim = await createSimulator({
    ...options(root),
    runtime: { kind: 'dataverse-api' },
    simulation: { level: 'dry-run' },
    dataverse: { enabled: true, tls: false, tds: { enabled: false } },
  });
  ownedFixture(t).add(() => sim.close());
  return sim;
}

async function startPortal(t, root) {
  const sim = await createSimulator({
    ...options(root),
    sourceDir: path.join(root, 'portal'),
    stateFile: path.join(root, 'state.json'),
    initial: {
      version: 1,
      mappings: {},
      tables: {},
      permissions: [],
      simulator: {
        mode: 'local',
        pageMode: 'local',
        permissionSource: 'configured',
        live: { allowWrites: false },
        endpoints: [],
      },
    },
  });
  ownedFixture(t).add(() => sim.close());
  return sim;
}

const getJson = async (url) => {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  assert.equal(response.status, 200, url);
  return response.json();
};

// The shared body: one listed app, the folder's screens and label, watch facts, and a revision that follows an edit.
async function assertFolderIsSourceAndWatched(sim, root) {
  const listed = await getJson(`${sim.url}/_apps/canvas/`);
  assert.deepEqual(
    listed.apps.map((app) => app.uniqueName),
    [APP],
  );
  assert.equal(listed.apps[0].name, 'Invented app');
  const inspected = await getJson(`${sim.url}/_apps/canvas/api/${APP}`);
  assert.deepEqual(
    inspected.screens.map((item) => item.name),
    ['HomeScreen'],
  );
  assert.equal(inspected.watch, true);
  assert.equal(typeof inspected.revision, 'string');
  const before = inspected.revision;
  await fs.writeFile(path.join(root, `apps/${APP}/Src/HomeScreen.pa.yaml`), screen('HomeScreen', 'Invented second'));
  // Each response is awaited before the next probe; the test runner's timeout bounds the wait.
  let revision = before;
  while (revision === before) {
    // a pause between probes, not a deadline: the watcher's debounce timer needs the event loop
    await new Promise((resolve) => setTimeout(resolve, 50));
    revision = (await getJson(`${sim.url}/_apps/canvas/api/${APP}?revision=1`)).revision;
  }
  const reloaded = await getJson(`${sim.url}/_apps/canvas/api/${APP}`);
  assert.equal(reloaded.revision, revision);
  assert.equal(reloaded.watch, true);
  assert.deepEqual(
    reloaded.screens.map((item) => item.name),
    ['HomeScreen'],
  );
  assert.match(JSON.stringify(reloaded), /Invented second/);
  assert.doesNotMatch(JSON.stringify(reloaded), /Invented packed/);
}

test('the standalone host lists a configured Canvas folder once, watches it and revisions its edits', async (t) => {
  const root = await fixture(t, { portal: false });
  const sim = await startStandalone(t, root);
  await assertFolderIsSourceAndWatched(sim, root);
});

test('the Power Pages host lists a configured Canvas folder once, watches it and revisions its edits', async (t) => {
  const root = await fixture(t, { portal: true });
  const sim = await startPortal(t, root);
  await assertFolderIsSourceAndWatched(sim, root);
});
