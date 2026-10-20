import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importModelDrivenResources, clientExtensionCatalogue } from '../lib/model-driven-resources.mjs';
import { modelDrivenSettings } from '../lib/model-driven-settings.mjs';
import { writeSolutionAssetEntries } from '../lib/dataverse-solution-assets.mjs';
import { createSimulator } from '../server.mjs';
import { loadOrganizationSources } from '../lib/solution-runtime-source.mjs';
import { validateValues } from '../lib/model-driven/data.mjs';

const descriptor = (name, file) => `<WebResource><Name>${name}</Name><WebResourceType>3</WebResourceType><FileName>${file}</FileName></WebResource>`;
async function fixture(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mirage-client-resources-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [name, data] of Object.entries(files)) { const file = path.join(root, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, data); }
  return root;
}

test('selected unpacked and ZIP WebResources resolve declared filenames, layers and packed entity ribbons', async t => {
  const root = await fixture(t, {
    'WebResources/x_events.js': 'window.Example = {};',
    'WebResources/x_events.js.data.xml': descriptor('x_/events.js', 'WebResources/x_events.js'),
    'Other/Customizations.xml': '<ImportExportXml><Entities><Entity><Name>x_first</Name><RibbonDiffXml><CustomActions/></RibbonDiffXml></Entity><Entity><Name>x_second</Name><RibbonDiffXml><CustomActions/></RibbonDiffXml></Entity></Entities></ImportExportXml>',
    'WebResources/x_invalid.js.data.xml': descriptor('x_/invalid.js', '../secret.js'),
  });
  const imported = await importModelDrivenResources([{ type: 'directory', dir: root }]);
  assert.equal(imported.resources.length, 1);
  assert.equal(imported.assets.get(imported.resources[0].url).data.toString(), 'window.Example = {};');
  assert.deepEqual(imported.ribbonDocuments.map(item => item.entity), ['x_first', 'x_second']);
  assert.equal(imported.diagnostics.some(item => item.code === 'MODEL_WEBRESOURCE_UNRESOLVED'), true);
  const archive = path.join(root, 'extension.zip');
  await fs.writeFile(archive, writeSolutionAssetEntries([
    { name: 'customizations.xml', data: Buffer.from(`<ImportExportXml><WebResources>${descriptor('x_/events.js', 'WebResources/blob')}</WebResources></ImportExportXml>`) },
    { name: 'WebResources/blob', data: Buffer.from('window.Example = {version:2};') },
  ]));
  const merged = await importModelDrivenResources([{ type: 'directory', dir: root }, { type: 'zip', dir: archive }]);
  assert.equal(merged.resources.length, 1);
  assert.equal(merged.assets.get(merged.resources[0].url).data.toString(), 'window.Example = {version:2};');
  const broken = path.join(root, 'broken.zip');
  await fs.writeFile(broken, writeSolutionAssetEntries([{ name: 'customizations.xml', data: Buffer.from(`<ImportExportXml><WebResources>${descriptor('x_/events.js', 'WebResources/missing')}</WebResources></ImportExportXml>`) }]));
  const replaced = await importModelDrivenResources([{ type: 'directory', dir: root }, { type: 'zip', dir: broken }]);
  assert.equal(replaced.resources.length, 0, 'A broken overriding layer cannot execute an older script silently.');
  assert.equal(replaced.assets.has(imported.resources[0].url), false);
});

test('client extension trust is explicit, validated and cannot be inferred from imported metadata', () => {
  assert.deepEqual(modelDrivenSettings(), { trustedExtensions: false });
  for (const input of [true, [], { trustedExtensions: 'true' }, { trusted: true }]) assert.throws(() => modelDrivenSettings(input));
  assert.equal(clientExtensionCatalogue({ resources: [] }, modelDrivenSettings()).trusted, false);
});

test('PAC unpack pairs WebResource metadata with source and keeps apps distinct when GUIDs are omitted', async t => {
  const root = await fixture(t, {
    'Other/Solution.xml': '<ImportExportXml><SolutionManifest><UniqueName>Example</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'AppModules/x_first/AppModule.xml': '<AppModule><UniqueName>x_first</UniqueName><LocalizedNames><LocalizedName description="First" languagecode="1033"/></LocalizedNames></AppModule>',
    'AppModules/x_second/AppModule.xml': '<AppModule><UniqueName>x_second</UniqueName><LocalizedNames><LocalizedName description="Second" languagecode="1033"/></LocalizedNames></AppModule>',
    'AppModuleSiteMaps/x_first/AppModuleSiteMap.xml': '<AppModuleSiteMap><SiteMapUniqueName>x_first</SiteMapUniqueName><SiteMap><Area Id="work"><Group Id="items"><Titles><Title LCID="1033" Title="Work management"/></Titles><SubArea Id="all" Entity="x_item"><Titles><Title LCID="1033" Title="All items"/></Titles></SubArea></Group></Area></SiteMap></AppModuleSiteMap>',
    'WebResources/x_/events.js': 'window.Example = {};',
    'WebResources/x_/events.js.data.xml': '<WebResource><WebResourceId>{aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa}</WebResourceId><Name>x_/events.js</Name><WebResourceType>3</WebResourceType><FileName>/WebResources/packedblob</FileName></WebResource>',
    'appactions/x_review/appaction.xml': '<appaction uniquename="x_review"><context>1</context><contextentity><logicalname>x_item</logicalname></contextentity><buttonlabeltext default="Review"/><location>0</location><type>0</type><onclickeventtype>2</onclickeventtype><onclickeventjavascriptfunctionname>Example.review</onclickeventjavascriptfunctionname><onclickeventjavascriptwebresourceid><webresourceid>aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa</webresourceid></onclickeventjavascriptwebresourceid><onclickeventjavascriptparameters>[{"type":5}]</onclickeventjavascriptparameters></appaction>',
  });
  const first = await loadOrganizationSources({ solutionRoots: [root] }), second = await loadOrganizationSources({ solutionRoots: [root] });
  assert.equal(first.metadata.modelDrivenApps.length, 2);
  assert.equal(new Set(first.metadata.modelDrivenApps.map(app => app.id)).size, 2);
  assert.deepEqual(first.metadata.modelDrivenApps.map(app => app.id), second.metadata.modelDrivenApps.map(app => app.id));
  assert.ok(first.metadata.modelDrivenApps.every(app => app.idSource === 'derived-local'));
  assert.equal(first.metadata.modelDrivenApps.find(app => app.uniqueName === 'x_first').navigation[0].groups[0].title, 'Work management');
  const records = first.scan.layers.flatMap(layer => layer.documents.flatMap(document => document.facts.recordComponents ?? [])).filter(component => component.kind === 'appmodule');
  assert.deepEqual(records.map(component => component.id).sort(), first.metadata.modelDrivenApps.map(app => app.id).sort());
  assert.equal(first.clientResources.resources[0].name, 'x_/events.js');
  assert.equal(first.clientResources.appActions[0].supported, true);
  assert.equal(first.clientResources.appActions[0].actions[0].library, 'x_/events.js');
  assert.deepEqual(first.clientResources.diagnostics, []);
});

test('create defers omitted platform-required columns without relaxing explicit nulls or business requirements', () => {
  const table = { fields: {
    x_name: { name: 'x_name', label: 'Name', type: 'text', required: true, requiredLevel: 'applicationrequired' },
    ownerid: { name: 'ownerid', label: 'Owner', type: 'lookup', dataverseType: 'owner', required: true, requiredLevel: 'systemrequired' },
  } };
  assert.deepEqual(validateValues(table, { x_name: 'Example' }, 'create'), { x_name: 'Example' });
  assert.throws(() => validateValues(table, { x_name: 'Example', ownerid: null }, 'create'), /Owner is required/);
  assert.throws(() => validateValues(table, {}, 'create'), /Name is required/);
});

test('standalone HTTP denies untrusted code and only serves declared assets after opt-in', async t => {
  const root = await fixture(t, {
    'WebResources/x_events.js': 'window.Example = {};',
    'WebResources/x_events.js.data.xml': descriptor('x_/events.js', 'WebResources/x_events.js'),
  });
  for (const trusted of [false, true]) {
    const sim = await createSimulator({ runtime: { kind: 'model-driven' }, simulation: { level: 'dry-run' }, solutionRoots: [root],
      modelDriven: { trustedExtensions: trusted }, watch: false });
    try {
      const catalogue = await (await fetch(sim.url + '/_apps/api')).json();
      assert.equal(catalogue.clientExtensions.trusted, trusted);
      const url = sim.url + catalogue.clientExtensions.resources[0].url;
      const response = await fetch(url);
      assert.equal(response.status, trusted ? 200 : 404);
      if (trusted) { assert.match(response.headers.get('content-type'), /javascript/); assert.equal(await response.text(), 'window.Example = {};'); }
      assert.equal((await fetch(url + '?unlisted=1')).status, 404);
      assert.equal((await fetch(sim.url + '/_apps/resources/undeclared')).status, 404);
      assert.equal((await fetch(url, { method: 'POST' })).status, 405);
    } finally { await sim.close(); }
  }
});
