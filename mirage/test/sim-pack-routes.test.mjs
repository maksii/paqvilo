// GET /_sim/api/packs: an invented pack with export counts, preset provenance, DATA ownership and relative module paths on
// the standalone host (no portal: matched null), and portal matching on the Power Pages host. Invented data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';

const PACK = `export default {
  id: 'invented-pack', name: 'Invented pack', description: 'Invented fixture pack',
  matches: () => true,
  presets: () => ({ 'invented-preset': { name: 'Invented preset', description: 'Invented', load: () => ({ tables: {} }) } }),
  pluginTypes: { 'Invented.Plugins.First': () => ({}), 'Invented.Plugins.Second': () => ({}) },
  dataFiles: [{ file: 'data/widgets.json', tables: { x_widget: { path: ['records'], idColumn: 'x_widgetid' } } }],
  inventedUnknownExport: true,
};`;
const OTHER = `export default { id: 'invented-other', name: 'Invented other', description: 'Never matches', matches: () => false, presets: () => ({}) };`;

async function writeFiles(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
}

async function json(response, status = 200) {
  const text = await response.text();
  assert.equal(response.status, status, text);
  return JSON.parse(text);
}

test('standalone /packs lists an invented pack with exports, presets provenance and DATA ownership', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sim-packs-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeFiles(root, {
    'solution/Other/Solution.xml': '<ImportExportXml><SolutionManifest><UniqueName>InventedPacks</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'solution/Entities/x_widget/Entity.xml': '<Entity><Name>x_widget</Name><EntityInfo><entity Name="x_widget"><EntitySetName>x_widgets</EntitySetName><PrimaryIdAttribute>x_widgetid</PrimaryIdAttribute><PrimaryNameAttribute>x_name</PrimaryNameAttribute><attributes><attribute PhysicalName="x_widgetid"><Name>x_widgetid</Name><Type>primarykey</Type></attribute><attribute PhysicalName="x_name"><Name>x_name</Name><Type>nvarchar</Type></attribute></attributes></entity></EntityInfo></Entity>',
    'packs/invented/pack.mjs': PACK,
    'packs/invented/data/widgets.json': JSON.stringify({ records: [] }),
  });
  const sim = await createSimulator({ runtime: { kind: 'dataverse-api' }, solutionRoots: [path.join(root, 'solution')], projectRoot: root, port: 0, watch: false,
    stateFile: path.join(root, 'state', 'state.json'), simulation: { level: 'simulation' }, dataverse: { enabled: true, tls: false, tds: { enabled: false } },
    dataPacks: [{ module: path.join(root, 'packs', 'invented', 'pack.mjs') }] });
  t.after(() => sim.close());

  const body = await json(await fetch(`${sim.url}/_sim/api/packs`));
  assert.equal(body.packs.length, 1);
  const [pack] = body.packs;
  assert.equal(pack.id, 'invented-pack');
  assert.equal(pack.module, 'packs/invented/pack.mjs');
  assert.deepEqual(pack.registration, { source: 'explicit', setupLink: '/_setup/#packs' });
  assert.equal(pack.matched, null);
  assert.equal(pack.matchReason, 'no portal context');
  assert.deepEqual(pack.exports, { pluginTypes: 2 });
  assert.deepEqual(pack.presets, [{ id: 'invented-preset', name: 'Invented preset' }]);
  assert.deepEqual(pack.dataFiles, [{ file: 'data/widgets.json', tables: ['x_widget'], writable: true, ownedTables: ['x_widget'] }]);
  assert.ok(pack.diagnostics.some(item => item.code === 'PACK_EXPORT_UNKNOWN' && item.key === 'inventedUnknownExport'));
  assert.deepEqual(pack.personaCatalog, { groups: 0, personas: 0, contexts: 0, scenarios: 0 });
  assert.deepEqual(body.library.find(item => item.id === 'invented-preset'), { id: 'invented-preset', name: 'Invented preset', pack: 'invented-pack', source: 'builtin' });
  assert.ok(body.library.some(item => item.pack === null), 'generic presets have no pack');
  assert.ok(!JSON.stringify(body).includes(root.replaceAll('\\', '\\\\')) && !JSON.stringify(body).includes(root), 'no absolute project paths');
  const refused = await fetch(`${sim.url}/_sim/api/packs`, { method: 'DELETE', headers: { 'x-sim-csrf': sim.state().csrf } });
  assert.equal(refused.status, 405);
  assert.equal(refused.headers.get('allow'), 'GET, HEAD');
  const head = await fetch(`${sim.url}/_sim/api/packs`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('cache-control'), 'no-store');
  assert.equal(await head.text(), '');
});

test('Power Pages /packs reports the portal match of every registered pack', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sim-packs-pp-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await writeFiles(dir, {
    'portal/website.yml': 'adx_name: Invented Site\nadx_websiteid: site\nadx_defaultlanguage: lang-en\nadx_website_language: 1033',
    'portal/websitelanguage.yml': '- adx_websitelanguageid: lang-en\n  adx_name: English',
    'portal/web-pages/home/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main',
    'portal/page-templates/Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main',
    'portal/web-templates/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'portal/web-templates/Main.webtemplate.source.html': '<p>Invented</p>',
    'packs/match/pack.mjs': PACK.replace(/\n  dataFiles:.*\n/, '\n'),
    'packs/other/pack.mjs': OTHER,
  });
  const sim = await createSimulator({ sourceDir: path.join(dir, 'portal'), stateFile: path.join(dir, 'state.json'), port: 0, watch: false, projectRoot: dir,
    dataPacks: [{ module: path.join(dir, 'packs', 'match', 'pack.mjs') }, { module: path.join(dir, 'packs', 'other', 'pack.mjs') }],
    initial: { version: 1, mappings: {}, tables: {}, permissions: [], simulator: { mode: 'local', pageMode: 'local', permissionSource: 'configured', live: { allowWrites: false }, endpoints: [] } } });
  t.after(() => sim.close());
  const body = await json(await fetch(`${sim.url}/_sim/api/packs`));
  const byId = Object.fromEntries(body.packs.map(item => [item.id, item]));
  assert.deepEqual([byId['invented-pack'].matched, byId['invented-other'].matched], [true, false]);
  assert.equal(byId['invented-other'].module, 'packs/other/pack.mjs');
  assert.deepEqual(byId['invented-pack'].presets, [{ id: 'invented-preset', name: 'Invented preset' }]);
});
