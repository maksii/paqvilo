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
import { importModelDrivenProject } from '../../lense/model-driven.mjs';

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
    { name: 'appactions/x_zip/appaction.xml', data: Buffer.from('<appaction uniquename="x_zip"><contextentity><logicalname>x_first</logicalname></contextentity></appaction>') },
  ]));
  const merged = await importModelDrivenResources([{ type: 'directory', dir: root }, { type: 'zip', dir: archive }]);
  assert.equal(merged.resources.length, 1);
  assert.equal(merged.assets.get(merged.resources[0].url).data.toString(), 'window.Example = {version:2};');
  assert.equal(merged.appActions[0].source, `${archive}!/appactions/x_zip/appaction.xml`);
  assert.equal(merged.appActions[0].sourceKind, 'appaction');
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

test('client import reads declared assets lazily and fails closed at aggregate layer, byte and traversal limits', async t => {
  const root = await fixture(t, {
    'WebResources/events.js': 'window.Example = {};',
    'WebResources/events.js.data.xml': descriptor('x_/events.js', 'WebResources/events.js'),
    'WebResources/unrelated.png': Buffer.alloc(4096),
  });
  const layer = { type: 'directory', dir: root };
  const selected = await importModelDrivenResources([layer], { limits: { bytes: 512 } });
  assert.equal(selected.resources.length, 1, 'unreferenced binary data does not consume the client asset budget');
  assert.deepEqual(selected.diagnostics, []);
  for (const [layers, limits] of [[[layer], { bytes: 16 }], [[layer], { entries: 2 }], [[layer, layer], { layers: 1 }], [[layer, layer], { bytes: 256 }]]) {
    const limited = await importModelDrivenResources(layers, { limits });
    assert.equal(limited.resources.length, 0); assert.equal(limited.assets.size, 0);
    assert.equal(limited.diagnostics.some(item => item.code === 'MODEL_CLIENT_IMPORT_LIMIT'), true);
  }
  await assert.rejects(importModelDrivenResources([layer], { limits: { bytes: Number.MAX_SAFE_INTEGER } }), /Invalid.*limit/);
  const zip = path.join(root, 'assets.zip');
  await fs.writeFile(zip, writeSolutionAssetEntries([{ name: 'WebResources/events.js', data: Buffer.alloc(512) }]));
  const zipped = await importModelDrivenResources([{ type: 'zip', dir: zip }], { limits: { bytes: 256 } });
  assert.equal(zipped.diagnostics[0].code, 'MODEL_CLIENT_IMPORT_LIMIT');
});

test('explicit client sources are independent of metadata, ordered, confined and fail closed at their own budget', async t => {
  const metadata = await fixture(t, { 'Other/Solution.xml': '<ImportExportXml><SolutionManifest><UniqueName>Complete</UniqueName><Version>1.0</Version></SolutionManifest></ImportExportXml>',
    'Entities/x_item/Entity.xml': '<Entity><Name>x_item</Name><EntityInfo><entity Name="x_item"><attributes><attribute PhysicalName="x_name"><Name>x_name</Name><Type>nvarchar</Type></attribute></attributes></entity></EntityInfo></Entity>',
    ...Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`WebResources/unrelated${i}.png`, 'unrelated'])) });
  const selected = await fixture(t, { 'WebResources/events.js': 'window.Selected = 1;', 'WebResources/events.js.data.xml': descriptor('x_/events.js', 'WebResources/events.js'),
    'WebResources/missing.js.data.xml': descriptor('x_/missing.js', '../outside.js') });
  const override = await fixture(t, { 'WebResources/events.js': 'window.Selected = 2;', 'WebResources/events.js.data.xml': descriptor('x_/events.js', 'WebResources/events.js') });
  const settings = modelDrivenSettings({ clientSources: [selected, override] });
  const organization = await loadOrganizationSources({ solutionRoots: [metadata], modelDriven: settings });
  const overlay = await importModelDrivenProject({ solutionRoots: [metadata], solutionOrder: 'explicit', modelDriven: settings });
  assert.ok(organization.metadata.entities.x_item); assert.equal(organization.clientResources.resources.length, 1);
  assert.deepEqual(overlay.resources, organization.clientResources.resources);
  assert.equal(organization.clientResources.assets.get(organization.clientResources.resources[0].url).data.toString(), 'window.Selected = 2;');
  assert.equal(organization.clientResources.resources[0].source, path.join(override, 'WebResources/events.js'));
  assert.ok(organization.clientResources.diagnostics.some(item => item.code === 'MODEL_WEBRESOURCE_UNRESOLVED'));
  const layers = [{ type: 'directory', dir: metadata }];
  assert.equal((await importModelDrivenResources(layers, { limits: { entries: 8 } })).diagnostics[0].code, 'MODEL_CLIENT_IMPORT_LIMIT');
  const admitted = await importModelDrivenResources(layers, { clientSources: [override], limits: { entries: 3 } });
  assert.equal(admitted.resources.length, 1, 'three entries exactly fit the independent source budget');
  const rejected = await importModelDrivenResources(layers, { clientSources: [override], limits: { entries: 2 } });
  assert.equal(rejected.resources.length, 0); assert.equal(rejected.assets.size, 0); assert.equal(rejected.diagnostics[0].code, 'MODEL_CLIENT_IMPORT_LIMIT');
  const absent = await importModelDrivenResources(layers, { clientSources: [override, path.join(metadata, 'absent')] });
  assert.equal(absent.assets.size, 0); assert.equal(absent.diagnostics[0].code, 'MODEL_CLIENT_SOURCE_INVALID');
  assert.equal((await importModelDrivenResources(layers, { clientSources: [] })).resources.length, 0);
  assert.deepEqual(modelDrivenSettings({ clientSources: ['./local'] }, 'modelDriven', metadata).clientSources, [path.join(metadata, 'local')]);
  for (const clientSources of [true, [null], Array(129).fill(selected)]) assert.throws(() => modelDrivenSettings({ clientSources }));
});

test('PCF client budgets include manifests, RESX and images and reuse the admitted JS snapshot', async t => {
  const files = {
    'Controls/Budget/ControlManifest.xml': '<manifest><control namespace="fx" constructor="Budget" control-type="standard"><resources><code path="bundle.js"/><resx path="strings.1033.resx"/><img path="icon.png"/></resources></control></manifest>',
    'Controls/Budget/ControlManifest.xml.data.xml': '<CustomControl><Name>fx.Budget</Name></CustomControl>',
    'Controls/Budget/bundle.js': 'var Budget;',
    'Controls/Budget/strings.1033.resx': '<root><data name="large"><value>' + 'x'.repeat(20000) + '</value></data></root>',
    'Controls/Budget/icon.png': Buffer.alloc(1024),
  };
  const root = await fixture(t, files), bytes = Object.values(files).reduce((sum, data) => sum + Buffer.byteLength(data), 0);
  const exact = await importModelDrivenResources([], { clientSources: [root], limits: { bytes } });
  assert.equal(exact.pcf.controls.length, 1); assert.deepEqual(exact.diagnostics, []);
  assert.equal(exact.pcf.controls[0].resources.resx.large.length, 20000);
  assert.equal(exact.assets.size, 1, 'only executable JS/CSS are served even though every imported resource consumes budget');
  assert.equal([...exact.assets.values()][0].data.toString(), 'var Budget;');
  for (const budget of [512, bytes - 1]) {
    const rejected = await importModelDrivenResources([], { clientSources: [root], limits: { bytes: budget } });
    assert.equal(rejected.pcf.controls.length, 0); assert.equal(rejected.assets.size, 0);
    assert.equal(rejected.diagnostics.some(item => item.code === 'MODEL_CLIENT_IMPORT_LIMIT'), true);
  }
  await fs.writeFile(path.join(root, 'Controls/Budget/ControlManifest.xml'), files['Controls/Budget/ControlManifest.xml'] + ' '.repeat(20000));
  const manifest = await importModelDrivenResources([], { clientSources: [root], limits: { bytes: 1024 } });
  assert.equal(manifest.assets.size, 0); assert.equal(manifest.diagnostics[0].code, 'MODEL_CLIENT_IMPORT_LIMIT');
});

test('a changed PCF resource is reported without rejecting organization import or exposing a partial control', async t => {
  const root = await fixture(t, { 'WebResources/events.js': 'window.Example = {};', 'WebResources/events.js.data.xml': descriptor('x_/events.js', 'WebResources/events.js'), 'bundle.js': 'window.Input = class {};' });
  const resource = name => ({ kind: 'code', path: name, url: `/__sim-static/pcf/control/${name}` });
  const resources = [resource('bundle.js'), resource('missing.js')];
  const codeComponents = { controls: new Map([['example.Input', { schemaName: 'example.Input', constructor: 'Input', type: 'standard', properties: [], resources }]]),
    assets: new Map(resources.map(item => [item.url, { file: path.join(root, item.path), root }])), diagnostics: [] };
  const imported = await importModelDrivenResources([{ type: 'directory', dir: root }], { codeComponents });
  assert.equal(imported.resources.length, 1); assert.equal(imported.pcf.controls.length, 0);
  assert.equal(imported.assets.size, 1, 'the earlier control bundle is never exposed after a later resource fails');
  assert.equal(imported.diagnostics.some(item => item.code === 'MODEL_PCF_RESOURCE_UNRESOLVED'), true);
  const limited = await importModelDrivenResources([], { codeComponents: { ...codeComponents, controls: new Map([['example.Input', { ...codeComponents.controls.get('example.Input'), resources: [resources[0]] }]]) }, limits: { bytes: 1 } });
  assert.equal(limited.diagnostics[0].code, 'MODEL_CLIENT_IMPORT_LIMIT');
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
  assert.equal(first.clientResources.appActions[0].sourceKind, 'appaction');
  assert.equal(first.clientResources.appActions[0].source, await fs.realpath(path.join(root, 'appactions/x_review/appaction.xml')));
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
