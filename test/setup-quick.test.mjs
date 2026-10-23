// Quick setup (lense/setup/quick.mjs, preview.mjs): export detection, the documents and edits it writes, and the guards of
// the preview operation endpoint. Invented folders and names only.
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exportCandidates, freePort, listFolders } from '../lense/setup/preview.mjs';
import { createDocument, dataEdits, filesEdits, partsEdits, quickSteps, targetOf } from '../lense/setup/quick.mjs';
import { startSetupServer } from '../lense/setup/server.mjs';

async function folder(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-quick-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  for (const [name, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), text);
  }
  return root;
}
const EXPORTS = {
  'exports/site/website.yml': 'adx_websiteid: invented\nadx_name: Invented Site\n',
  'exports/site/web-pages/home/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\n',
  'exports/core/Other/Solution.xml': '<ImportExportXml><SolutionManifest><UniqueName>InventedCore</UniqueName></SolutionManifest></ImportExportXml>',
  'data/pack.mjs': 'export default {};\n',
  'node_modules/other/website.yml': 'adx_name: Not a project export\n',
  '.hidden/core/Other/Solution.xml': '<UniqueName>Hidden</UniqueName>',
};

test('quick setup finds portal exports, Solutions and pack modules, written as the configuration resolves them', async t => {
  const root = await folder(t, EXPORTS);
  const found = await exportCandidates({ directory: root, sourceRoot: path.join(root, 'exports') });
  assert.deepEqual(found.portals.map(item => [item.name, item.path, item.value]), [['Invented Site', './exports/site', 'site']]);
  assert.deepEqual(found.solutions.map(item => [item.name, item.path, item.value]), [['InventedCore', './exports/core', 'core']]);
  assert.deepEqual(found.packs.map(item => item.value), ['./data/pack.mjs'], 'node_modules and dot folders are not searched');
  assert.ok(Number.isInteger(await freePort()));
  // The folder picker lists visible folders with what each holds, and writes the chosen folder from the source root.
  const top = await listFolders({ directory: root, sourceRoot: path.join(root, 'exports') });
  assert.deepEqual(top.folders.map(item => item.name), ['data', 'exports'], 'dot folders and node_modules are hidden');
  const exports = await listFolders({ directory: root, sourceRoot: path.join(root, 'exports'), folder: 'exports' });
  assert.deepEqual(exports.folders.map(item => [item.name, item.kind?.type, item.kind?.name]), [['core', 'solution', 'InventedCore'], ['site', 'website', 'Invented Site']]);
  const site = await listFolders({ directory: root, sourceRoot: path.join(root, 'exports'), folder: exports.folders[1].path });
  assert.deepEqual([site.kind.type, site.value, site.shown], ['website', 'site', './exports/site']);
  await assert.rejects(listFolders({ directory: root, folder: 'missing' }), /cannot be opened/);
});

test('a created project and quick edits use the found exports, a local address and dry run', async () => {
  const candidates = { portals: [{ value: 'exports/site' }], solutions: [{ value: 'exports/core' }], packs: [{ value: './data/pack.mjs' }] };
  const all = { website: true, modelDriven: true, canvas: true, api: false };
  const catalogue = createDocument({ parts: all, name: 'invented', candidates, port: 8801 });
  assert.deepEqual(catalogue.sites.invented, { source: 'exports/site', defaultEnv: 'local', environments: { local: 'http://127.0.0.1:8801' },
    mirage: { port: 8801, runtime: { kind: 'power-pages' }, simulation: { level: 'dry-run' }, solutionRoots: ['exports/core'], dataPacks: ['./data/pack.mjs'] } });
  assert.deepEqual(createDocument({ parts: { api: true }, name: 'invented', project: true, candidates: { solutions: candidates.solutions } }),
    { version: 2, runtime: { kind: 'dataverse-api' }, simulation: { level: 'dry-run' }, solutions: [{ id: 'solution-1', path: 'exports/core' }], dataverse: { enabled: true } });
  // Parts combine: a website with the API and without model-driven or canvas apps switches those surfaces off.
  assert.deepEqual(createDocument({ parts: { website: true, api: true }, name: 'invented', candidates, port: 8801 }).sites.invented.mirage,
    { port: 8801, runtime: { kind: 'power-pages' }, simulation: { level: 'dry-run' }, solutionRoots: ['exports/core'], dataPacks: ['./data/pack.mjs'], dataverse: { enabled: true }, modelDriven: { enabled: false }, canvas: { enabled: false } });
  assert.equal(createDocument({ parts: { canvas: true, api: true }, name: 'invented', candidates }).sites.invented.mirage.runtime.kind, 'model-driven', 'apps without a website run on the app host');

  const state = { kind: 'catalogue', layers: { shared: { exists: true } }, findings: [], settings: { defaultSite: 'invented' },
    sites: [{ id: 'invented', source: 'exports/site', sourceStatus: { format: 'yaml' }, runtime: { kind: 'power-pages' }, environments: { local: {} }, solutions: [{ exists: true }], packs: [],
      mirage: { solutionRoots: ['exports/core'], port: 8801 } }] };
  const target = targetOf(state, 'invented');
  assert.deepEqual(quickSteps(state, target, null).map(step => step.status), ['done', 'done', 'done', 'current', 'todo']);
  assert.deepEqual(quickSteps(state, target, { ready: true }).map(step => step.status), ['done', 'done', 'done', 'done', 'done']);
  assert.deepEqual(filesEdits(target, { website: './exports/site', solutions: ['exports/core'] }), [], 'equal paths in another spelling are unchanged');
  assert.deepEqual(filesEdits(target, { website: 'exports/other', solutions: [] }), [{ op: 'set', path: ['sites', 'invented', 'source'], value: 'exports/other' }, { op: 'delete', path: ['sites', 'invented', 'mirage', 'solutionRoots'] }]);
  assert.deepEqual(dataEdits(target, { preset: 'invented-start', level: 'simulation' }), [{ op: 'set', path: ['sites', 'invented', 'mirage', 'preset'], value: 'invented-start' },
    { op: 'set', path: ['sites', 'invented', 'mirage', 'presetMode'], value: 'bootstrap' }, { op: 'set', path: ['sites', 'invented', 'mirage', 'simulation'], value: { level: 'simulation' } }]);
  assert.deepEqual(target.parts, all);
  assert.deepEqual(partsEdits(target, { api: true }), [{ op: 'set', path: ['sites', 'invented', 'mirage', 'runtime', 'kind'], value: 'dataverse-api' }, { op: 'set', path: ['sites', 'invented', 'mirage', 'dataverse', 'enabled'], value: true }]);
  assert.deepEqual(partsEdits(target, { ...all, modelDriven: false }), [{ op: 'set', path: ['sites', 'invented', 'mirage', 'modelDriven', 'enabled'], value: false }]);
  const off = targetOf({ ...state, sites: [{ ...state.sites[0], mirage: { ...state.sites[0].mirage, modelDriven: { enabled: false }, dataverse: { enabled: true } } }] }, 'invented');
  assert.deepEqual(off.parts, { website: true, modelDriven: false, canvas: true, api: true });
  assert.deepEqual(partsEdits(off, all), [{ op: 'set', path: ['sites', 'invented', 'mirage', 'dataverse', 'enabled'], value: false }, { op: 'delete', path: ['sites', 'invented', 'mirage', 'modelDriven', 'enabled'] }]);
});

test('preview operations need the setup token, a known action and a configured target', async t => {
  const directory = await folder(t, { 'paqvilo.config.yml': 'sourceRoot: .\ndefaultSite: invented\nsites:\n  invented:\n    source: .\n    environments: { local: http://127.0.0.1:8801 }\n    mirage: { port: 0 }\n' });
  const server = await startSetupServer({ directory, processEnv: {} }); ownedFixture(t).add(() => server.close());
  const { csrf } = await (await fetch(new URL('api/status', server.url))).json();
  const post = (body, token = csrf) => fetch(new URL('api/preview', server.url), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: new URL(server.url).origin, ...(token ? { 'X-Paqvilo-Setup-CSRF': token } : {}) }, body: JSON.stringify(body) });
  assert.equal((await post({ action: 'start', site: 'invented' }, null)).status, 403);
  assert.equal((await post({ action: 'deploy', site: 'invented' })).status, 400);
  assert.equal((await post({ action: 'start', site: 'other' })).status, 400);
  const status = await (await fetch(new URL('api/preview', server.url))).json();
  assert.deepEqual(status, { sessions: [], operation: null });
  assert.equal((await fetch(new URL('api/folders', server.url))).status, 200, 'the folder picker lists the project folder');
  await assert.rejects(fs.stat(path.join(directory, '.paqvilo', 'setup', 'preview-operation.json')), 'a refused request starts nothing');
});
