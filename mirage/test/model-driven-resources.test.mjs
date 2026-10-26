import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importModelDrivenResources, clientExtensionCatalogue } from '../lib/model-driven-resources.mjs';
import { modelDrivenSettings } from '../lib/model-driven-settings.mjs';
import { writeSolutionAssetEntries } from '../lib/dataverse-solution-assets.mjs';
import { createSimulator } from '../server.mjs';
import { loadOrganizationSources } from '../lib/solution-runtime-source.mjs';
import { validateValues } from '../lib/model-driven/data.mjs';
import { importModelDrivenProject } from '../../lense/model-driven.mjs';
import { importCodeComponents } from '../lib/code-components.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';

const descriptor = (name, file) =>
  `<WebResource><Name>${name}</Name><WebResourceType>3</WebResourceType><FileName>${file}</FileName></WebResource>`;
async function fixture(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mirage-client-resources-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  for (const [name, data] of Object.entries(files)) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, data);
  }
  return root;
}

test('selected unpacked and ZIP WebResources resolve declared filenames, layers and packed entity ribbons', async (t) => {
  const root = await fixture(t, {
    'WebResources/x_events.js': 'window.Example = {};',
    'WebResources/x_events.js.data.xml': descriptor('x_/events.js', 'WebResources/x_events.js'),
    'Other/Customizations.xml':
      '<ImportExportXml><Entities><Entity><Name>x_first</Name><RibbonDiffXml><CustomActions/></RibbonDiffXml></Entity><Entity><Name>x_second</Name><RibbonDiffXml><CustomActions/></RibbonDiffXml></Entity></Entities></ImportExportXml>',
    'WebResources/x_invalid.js.data.xml': descriptor('x_/invalid.js', '../secret.js'),
  });
  const imported = await importModelDrivenResources([{ type: 'directory', dir: root }]);
  assert.equal(imported.resources.length, 1);
  assert.equal(imported.assets.get(imported.resources[0].url).data.toString(), 'window.Example = {};');
  assert.deepEqual(
    imported.ribbonDocuments.map((item) => item.entity),
    ['x_first', 'x_second'],
  );
  assert.equal(
    imported.diagnostics.some((item) => item.code === 'MODEL_WEBRESOURCE_UNRESOLVED'),
    true,
  );
  const archive = path.join(root, 'extension.zip');
  await fs.writeFile(
    archive,
    writeSolutionAssetEntries([
      {
        name: 'customizations.xml',
        data: Buffer.from(
          `<ImportExportXml><WebResources>${descriptor('x_/events.js', 'WebResources/blob')}</WebResources></ImportExportXml>`,
        ),
      },
      { name: 'WebResources/blob', data: Buffer.from('window.Example = {version:2};') },
      {
        name: 'appactions/x_zip/appaction.xml',
        data: Buffer.from(
          '<appaction uniquename="x_zip"><contextentity><logicalname>x_first</logicalname></contextentity></appaction>',
        ),
      },
    ]),
  );
  const merged = await importModelDrivenResources([
    { type: 'directory', dir: root },
    { type: 'zip', dir: archive },
  ]);
  assert.equal(merged.resources.length, 1);
  assert.equal(merged.assets.get(merged.resources[0].url).data.toString(), 'window.Example = {version:2};');
  assert.equal(merged.appActions[0].source, `${archive}!/appactions/x_zip/appaction.xml`);
  assert.equal(merged.appActions[0].sourceKind, 'appaction');
  const broken = path.join(root, 'broken.zip');
  await fs.writeFile(
    broken,
    writeSolutionAssetEntries([
      {
        name: 'customizations.xml',
        data: Buffer.from(
          `<ImportExportXml><WebResources>${descriptor('x_/events.js', 'WebResources/missing')}</WebResources></ImportExportXml>`,
        ),
      },
    ]),
  );
  const replaced = await importModelDrivenResources([
    { type: 'directory', dir: root },
    { type: 'zip', dir: broken },
  ]);
  assert.equal(replaced.resources.length, 0, 'A broken overriding layer cannot execute an older script silently.');
  assert.equal(replaced.assets.has(imported.resources[0].url), false);
});

test('client extension trust is explicit, validated and cannot be inferred from imported metadata', () => {
  assert.deepEqual(modelDrivenSettings(), { trustedExtensions: false });
  for (const [input, message] of [
    [true, /must be an object/],
    [[], /must be an object/],
    [{ trustedExtensions: 'true' }, /trustedExtensions must be true or false/],
    [{ trusted: true }, /Unknown modelDriven key 'trusted'/],
  ])
    assert.throws(() => modelDrivenSettings(input), message, JSON.stringify(input));
  assert.equal(clientExtensionCatalogue({ resources: [] }, modelDrivenSettings()).trusted, false);
});

test('client import reads declared assets lazily and fails closed at aggregate layer, byte and traversal limits', async (t) => {
  const root = await fixture(t, {
    'WebResources/events.js': 'window.Example = {};',
    'WebResources/events.js.data.xml': descriptor('x_/events.js', 'WebResources/events.js'),
    'WebResources/unrelated.png': Buffer.alloc(4096),
  });
  const layer = { type: 'directory', dir: root };
  const selected = await importModelDrivenResources([layer], { limits: { bytes: 512 } });
  assert.equal(selected.resources.length, 1, 'unreferenced binary data does not consume the client asset budget');
  assert.deepEqual(selected.diagnostics, []);
  for (const [layers, limits] of [
    [[layer], { bytes: 16 }],
    [[layer], { entries: 2 }],
    [[layer, layer], { layers: 1 }],
    [[layer, layer], { bytes: 256 }],
  ]) {
    const limited = await importModelDrivenResources(layers, { limits });
    assert.equal(limited.resources.length, 0);
    assert.equal(limited.assets.size, 0);
    assert.equal(
      limited.diagnostics.some((item) => item.code === 'MODEL_CLIENT_IMPORT_LIMIT'),
      true,
    );
  }
  await assert.rejects(
    importModelDrivenResources([layer], { limits: { bytes: Number.MAX_SAFE_INTEGER } }),
    /Invalid.*limit/,
  );
  const zip = path.join(root, 'assets.zip');
  await fs.writeFile(zip, writeSolutionAssetEntries([{ name: 'WebResources/events.js', data: Buffer.alloc(512) }]));
  const zipped = await importModelDrivenResources([{ type: 'zip', dir: zip }], { limits: { bytes: 256 } });
  assert.equal(zipped.diagnostics[0].code, 'MODEL_CLIENT_IMPORT_LIMIT');
});

test('explicit client sources are independent of metadata, ordered, confined and fail closed at their own budget', async (t) => {
  const metadata = await fixture(t, {
    'Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>Complete</UniqueName><Version>1.0</Version></SolutionManifest></ImportExportXml>',
    'Entities/x_item/Entity.xml':
      '<Entity><Name>x_item</Name><EntityInfo><entity Name="x_item"><attributes><attribute PhysicalName="x_name"><Name>x_name</Name><Type>nvarchar</Type></attribute></attributes></entity></EntityInfo></Entity>',
    ...Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`WebResources/unrelated${i}.png`, 'unrelated'])),
  });
  const selected = await fixture(t, {
    'WebResources/events.js': 'window.Selected = 1;',
    'WebResources/events.js.data.xml': descriptor('x_/events.js', 'WebResources/events.js'),
    'WebResources/missing.js.data.xml': descriptor('x_/missing.js', '../outside.js'),
  });
  const override = await fixture(t, {
    'WebResources/events.js': 'window.Selected = 2;',
    'WebResources/events.js.data.xml': descriptor('x_/events.js', 'WebResources/events.js'),
  });
  const settings = modelDrivenSettings({ clientSources: [selected, override] });
  const organization = await loadOrganizationSources({ solutionRoots: [metadata], modelDriven: settings });
  const overlay = await importModelDrivenProject({
    solutionRoots: [metadata],
    solutionOrder: 'explicit',
    modelDriven: settings,
  });
  assert.ok(organization.metadata.entities.x_item);
  assert.equal(organization.clientResources.resources.length, 1);
  assert.deepEqual(overlay.resources, organization.clientResources.resources);
  assert.equal(
    organization.clientResources.assets.get(organization.clientResources.resources[0].url).data.toString(),
    'window.Selected = 2;',
  );
  assert.equal(
    organization.clientResources.resources[0].source,
    await fs.realpath(path.join(override, 'WebResources/events.js')),
  );
  assert.ok(organization.clientResources.diagnostics.some((item) => item.code === 'MODEL_WEBRESOURCE_UNRESOLVED'));
  const layers = [{ type: 'directory', dir: metadata }];
  assert.equal(
    (await importModelDrivenResources(layers, { limits: { entries: 8 } })).diagnostics[0].code,
    'MODEL_CLIENT_IMPORT_LIMIT',
  );
  const admitted = await importModelDrivenResources(layers, { clientSources: [override], limits: { entries: 3 } });
  assert.equal(admitted.resources.length, 1, 'three entries exactly fit the independent source budget');
  const rejected = await importModelDrivenResources(layers, { clientSources: [override], limits: { entries: 2 } });
  assert.equal(rejected.resources.length, 0);
  assert.equal(rejected.assets.size, 0);
  assert.equal(rejected.diagnostics[0].code, 'MODEL_CLIENT_IMPORT_LIMIT');
  const absent = await importModelDrivenResources(layers, { clientSources: [override, path.join(metadata, 'absent')] });
  assert.equal(absent.assets.size, 0);
  assert.equal(absent.diagnostics[0].code, 'MODEL_CLIENT_SOURCE_INVALID');
  assert.equal((await importModelDrivenResources(layers, { clientSources: [] })).resources.length, 0);
  assert.deepEqual(modelDrivenSettings({ clientSources: ['./local'] }, 'modelDriven', metadata).clientSources, [
    path.join(metadata, 'local'),
  ]);
  for (const clientSources of [true, [null], Array(129).fill(selected)])
    assert.throws(
      () => modelDrivenSettings({ clientSources }),
      /clientSources must be an ordered array of at most 128 local source paths/,
    );
});

test('platform-only client sources never fall back to organization roots and consume aggregate entry budget', async (t) => {
  const metadata = await fixture(t, {
    'WebResources/excluded.js': 'window.Excluded = true;',
    'WebResources/excluded.js.data.xml': descriptor('x_/excluded.js', 'WebResources/excluded.js'),
  });
  const selected = await fixture(t, {
    'React@16.14.0.js': 'window.React = {};',
    'ReactDOM@16.14.0.js': 'window.ReactDOM = {};',
  });
  const layers = [{ type: 'directory', dir: metadata }];
  const clientSources = ['React@16.14.0.js', 'ReactDOM@16.14.0.js'].map((name) => path.join(selected, name));
  const admitted = await importModelDrivenResources(layers, { clientSources, limits: { entries: 2 } });
  assert.equal(admitted.resources.length, 0);
  assert.equal(admitted.pcf.controls.length, 0);
  assert.equal(admitted.pcf.platformLibraries.length, 2);
  assert.equal(admitted.assets.size, 2);
  assert.deepEqual(admitted.diagnostics, []);
  const rejected = await importModelDrivenResources(layers, { clientSources, limits: { entries: 1 } });
  assert.equal(rejected.assets.size, 0);
  assert.equal(rejected.diagnostics[0].code, 'MODEL_CLIENT_IMPORT_LIMIT');
});

test('PCF client budgets include manifests, RESX and images and reuse the admitted JS snapshot', async (t) => {
  const files = {
    'Controls/Budget/ControlManifest.xml':
      '<manifest><control namespace="fx" constructor="Budget" control-type="standard"><resources><code path="bundle.js"/><resx path="strings.1033.resx"/><img path="icon.png"/></resources></control></manifest>',
    'Controls/Budget/ControlManifest.xml.data.xml': '<CustomControl><Name>fx.Budget</Name></CustomControl>',
    'Controls/Budget/bundle.js': 'var Budget;',
    'Controls/Budget/strings.1033.resx':
      '<root><data name="large"><value>' + 'x'.repeat(20000) + '</value></data></root>',
    'Controls/Budget/icon.png': Buffer.alloc(1024),
  };
  const root = await fixture(t, files),
    bytes = Object.values(files).reduce((sum, data) => sum + Buffer.byteLength(data), 0);
  const exact = await importModelDrivenResources([], { clientSources: [root], limits: { bytes } });
  assert.equal(exact.pcf.controls.length, 1);
  assert.deepEqual(exact.diagnostics, []);
  assert.equal(exact.pcf.controls[0].resources.resx.large.length, 20000);
  assert.equal(
    exact.assets.size,
    1,
    'only executable JS/CSS are served even though every imported resource consumes budget',
  );
  assert.equal([...exact.assets.values()][0].data.toString(), 'var Budget;');
  for (const budget of [512, bytes - 1]) {
    const rejected = await importModelDrivenResources([], { clientSources: [root], limits: { bytes: budget } });
    assert.equal(rejected.pcf.controls.length, 0);
    assert.equal(rejected.assets.size, 0);
    assert.equal(
      rejected.diagnostics.some((item) => item.code === 'MODEL_CLIENT_IMPORT_LIMIT'),
      true,
    );
  }
  await fs.writeFile(
    path.join(root, 'Controls/Budget/ControlManifest.xml'),
    files['Controls/Budget/ControlManifest.xml'] + ' '.repeat(20000),
  );
  const manifest = await importModelDrivenResources([], { clientSources: [root], limits: { bytes: 1024 } });
  assert.equal(manifest.assets.size, 0);
  assert.equal(manifest.diagnostics[0].code, 'MODEL_CLIENT_IMPORT_LIMIT');
});

test('PCF overriding declarations remove stale executables, preserve unrelated controls and allow later valid recovery', async (t) => {
  const files = (directory, name, source) => ({
    [`Controls/${directory}/ControlManifest.xml`]:
      '<manifest><control namespace="fx" constructor="Widget" control-type="standard"><resources><code path="bundle.js"/></resources></control></manifest>',
    [`Controls/${directory}/ControlManifest.xml.data.xml`]: `<CustomControl><Name>${name}</Name></CustomControl>`,
    [`Controls/${directory}/bundle.js`]: source,
  });
  const base = await fixture(t, {
    ...files('base-folder', 'fx.Widget', 'window.Base = true;'),
    ...files('other-folder', 'fx.Other', 'window.Other = true;'),
    'WebResources/events.js': 'window.Events = true;',
    'WebResources/events.js.data.xml': descriptor('x_/events.js', 'WebResources/events.js'),
  });
  const override = await fixture(t, files('different-folder', 'fx.Widget', 'window.Override = true;'));
  const recovered = await fixture(t, files('recovery-folder', 'fx.Widget', 'window.Recovered = true;'));
  const load = (...clientSources) => importModelDrivenResources([], { clientSources });
  const bodies = (result) => [...result.assets.values()].map((asset) => asset.data.toString());
  const selected = await load(base, override);
  assert.deepEqual(selected.pcf.controls.map((control) => control.name).sort(), ['fx.Other', 'fx.Widget']);
  assert.ok(bodies(selected).includes('window.Override = true;'));
  assert.ok(!bodies(selected).includes('window.Base = true;'));
  const direct = await importCodeComponents([base, override].map((dir) => ({ type: 'directory', dir })));
  assert.deepEqual(
    [...direct.assets.values()].map((asset) => asset.file).sort(),
    (
      await Promise.all(
        [
          path.join(base, 'Controls/other-folder/bundle.js'),
          path.join(override, 'Controls/different-folder/bundle.js'),
        ].map((file) => fs.realpath(file)),
      )
    ).sort(),
  );
  const manifest = path.join(await fs.realpath(override), 'Controls/different-folder/ControlManifest.xml');
  const validManifest = await fs.readFile(manifest, 'utf8');
  const brokenCases = [
    async () => fs.rm(path.join(override, 'Controls/different-folder/bundle.js')),
    async () => fs.writeFile(manifest, '<manifest>'),
    async () => fs.writeFile(manifest, '<manifest/>'),
    async () => fs.rm(manifest),
  ];
  for (const breakSource of brokenCases) {
    await fs.writeFile(manifest, validManifest);
    await fs.writeFile(path.join(override, 'Controls/different-folder/bundle.js'), 'window.Override = true;');
    await breakSource();
    const rejected = await load(base, override);
    assert.deepEqual(
      rejected.pcf.controls.map((control) => control.name),
      ['fx.Other'],
    );
    assert.ok(bodies(rejected).includes('window.Other = true;'));
    assert.ok(bodies(rejected).includes('window.Events = true;'));
    assert.ok(!bodies(rejected).some((body) => /window\.(?:Base|Override) =/.test(body)));
    // Diagnostics carry project-relative paths (<layer folder>/<path inside layer>), never absolute local paths.
    assert.ok(
      rejected.diagnostics.some(
        (item) =>
          item.code === 'PCF_IMPORT_FAILED' &&
          item.file === `${path.basename(override)}/Controls/different-folder/ControlManifest.xml`,
      ),
    );
    const directRejected = await importCodeComponents([base, override].map((dir) => ({ type: 'directory', dir })));
    assert.equal(directRejected.assets.size, 1, 'The Power Pages asset map also drops the superseded bundle.');
    const fixed = await load(base, override, recovered);
    assert.deepEqual(fixed.pcf.controls.map((control) => control.name).sort(), ['fx.Other', 'fx.Widget']);
    assert.ok(bodies(fixed).includes('window.Recovered = true;'));
    assert.ok(!bodies(fixed).includes('window.Base = true;'));
  }
  const exhausted = await importModelDrivenResources([], { clientSources: [base, recovered], limits: { bytes: 32 } });
  assert.equal(exhausted.assets.size, 0);
  assert.equal(exhausted.pcf.controls.length, 0);
  assert.equal(exhausted.resources.length, 0);
  assert.ok(exhausted.diagnostics.some((item) => item.code === 'MODEL_CLIENT_IMPORT_LIMIT'));
});

test('unresolved PCF identities disable the PCF catalogue without guessing a key or disabling independent WebResources', async (t) => {
  const manifest =
    '<manifest><control namespace="fx" constructor="Widget" control-type="standard"><resources><code path="bundle.js"/></resources></control></manifest>';
  const base = await fixture(t, {
    'Controls/Widget/ControlManifest.xml': manifest,
    'Controls/Widget/ControlManifest.xml.data.xml': '<CustomControl><Name>fx.Widget</Name></CustomControl>',
    'Controls/Widget/bundle.js': 'window.Base = true;',
    'WebResources/events.js': 'window.Events = true;',
    'WebResources/events.js.data.xml': descriptor('x_/events.js', 'WebResources/events.js'),
  });
  const override = await fixture(t, {
    'Controls/Widget/ControlManifest.xml': manifest,
    'Controls/Widget/bundle.js': 'window.Override = true;',
  });
  const identity = path.join(override, 'Controls/Widget/ControlManifest.xml.data.xml');
  for (const value of [
    undefined,
    '<CustomControl>',
    '<CustomControl/>',
    '<CustomControl><Name>../Widget</Name></CustomControl>',
  ]) {
    if (value === undefined) await fs.rm(identity, { force: true });
    else await fs.writeFile(identity, value);
    const result = await importModelDrivenResources([], { clientSources: [base, override] });
    assert.equal(result.pcf.controls.length, 0);
    assert.equal(result.resources.length, 1);
    assert.deepEqual(
      [...result.assets.values()].map((asset) => asset.data.toString()),
      ['window.Events = true;'],
    );
    assert.ok(result.diagnostics.some((item) => item.code === 'PCF_IDENTITY_UNRESOLVED'));
  }
  await fs.writeFile(identity, '<CustomControl><Name>fx.Widget</Name></CustomControl>');
  const repaired = await importModelDrivenResources([], { clientSources: [base, override] });
  assert.equal(repaired.pcf.controls.length, 1);
  assert.deepEqual(repaired.diagnostics, []);
  assert.ok([...repaired.assets.values()].some((asset) => asset.data.toString() === 'window.Override = true;'));
});

test('an empty model-driven client allowlist preserves the separate Power Pages PCF source surface', async (t) => {
  const solution = await fixture(t, {
    'Controls/Widget/ControlManifest.xml':
      '<manifest><control namespace="fx" constructor="Widget" control-type="standard"><resources><code path="bundle.js"/></resources></control></manifest>',
    'Controls/Widget/ControlManifest.xml.data.xml': '<CustomControl><Name>fx.Widget</Name></CustomControl>',
    'Controls/Widget/bundle.js': 'window.PortalWidget = true;',
  });
  const portal = await fixture(t, {
    'website.yml': 'adx_websiteid: invented\nadx_name: Invented\n',
    'web-pages/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main\n',
    'Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main\n',
    'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main\n',
    'Main.webtemplate.source.html': '<html><body>{% codecomponent name:"fx.Widget" %}</body></html>',
  });
  const runtime = await createSimulator({
    sourceDir: portal,
    solutionRoots: [solution],
    modelDriven: { trustedExtensions: false, clientSources: [] },
    watch: false,
    port: 0,
  });
  ownedFixture(t).add(() => runtime.close());
  const catalogue = await fetch(runtime.url + '/_apps/api').then((response) => response.json());
  assert.equal(catalogue.clientExtensions.trusted, false);
  assert.deepEqual(catalogue.clientExtensions.pcf.controls, []);
  const home = await fetch(runtime.url).then((response) => response.text());
  assert.match(home, /data-pcf-schema="fx.Widget"/);
  const asset = /\/__sim-static\/pcf\/[a-f0-9]+\/bundle\.js/.exec(home)?.[0];
  assert.ok(asset, 'The portal mount retains its explicitly declared bundle.');
  assert.equal(await fetch(runtime.url + asset).then((response) => response.text()), 'window.PortalWidget = true;');
});

test('a changed PCF resource is reported without rejecting organization import or exposing a partial control', async (t) => {
  const root = await fixture(t, {
    'WebResources/events.js': 'window.Example = {};',
    'WebResources/events.js.data.xml': descriptor('x_/events.js', 'WebResources/events.js'),
    'bundle.js': 'window.Input = class {};',
  });
  const resource = (name) => ({ kind: 'code', path: name, url: `/__sim-static/pcf/control/${name}` });
  const resources = [resource('bundle.js'), resource('missing.js')];
  const codeComponents = {
    controls: new Map([
      [
        'example.Input',
        { schemaName: 'example.Input', constructor: 'Input', type: 'standard', properties: [], resources },
      ],
    ]),
    assets: new Map(resources.map((item) => [item.url, { file: path.join(root, item.path), root }])),
    diagnostics: [],
  };
  const imported = await importModelDrivenResources([{ type: 'directory', dir: root }], { codeComponents });
  assert.equal(imported.resources.length, 1);
  assert.equal(imported.pcf.controls.length, 0);
  assert.equal(imported.assets.size, 1, 'the earlier control bundle is never exposed after a later resource fails');
  assert.equal(
    imported.diagnostics.some((item) => item.code === 'MODEL_PCF_RESOURCE_UNRESOLVED'),
    true,
  );
  const limited = await importModelDrivenResources([], {
    codeComponents: {
      ...codeComponents,
      controls: new Map([
        ['example.Input', { ...codeComponents.controls.get('example.Input'), resources: [resources[0]] }],
      ]),
    },
    limits: { bytes: 1 },
  });
  assert.equal(limited.diagnostics[0].code, 'MODEL_CLIENT_IMPORT_LIMIT');
});

test('PAC unpack pairs WebResource metadata with source and keeps apps distinct when GUIDs are omitted', async (t) => {
  const root = await fixture(t, {
    'Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>Example</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'AppModules/x_first/AppModule.xml':
      '<AppModule><UniqueName>x_first</UniqueName><LocalizedNames><LocalizedName description="First" languagecode="1033"/></LocalizedNames></AppModule>',
    'AppModules/x_second/AppModule.xml':
      '<AppModule><UniqueName>x_second</UniqueName><LocalizedNames><LocalizedName description="Second" languagecode="1033"/></LocalizedNames></AppModule>',
    'AppModuleSiteMaps/x_first/AppModuleSiteMap.xml':
      '<AppModuleSiteMap><SiteMapUniqueName>x_first</SiteMapUniqueName><SiteMap><Area Id="work"><Group Id="items"><Titles><Title LCID="1033" Title="Work management"/></Titles><SubArea Id="all" Entity="x_item"><Titles><Title LCID="1033" Title="All items"/></Titles></SubArea></Group></Area></SiteMap></AppModuleSiteMap>',
    'WebResources/x_/events.js': 'window.Example = {};',
    'WebResources/x_/events.js.data.xml':
      '<WebResource><WebResourceId>{aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa}</WebResourceId><Name>x_/events.js</Name><WebResourceType>3</WebResourceType><FileName>/WebResources/packedblob</FileName></WebResource>',
    'appactions/x_review/appaction.xml':
      '<appaction uniquename="x_review"><context>1</context><contextentity><logicalname>x_item</logicalname></contextentity><buttonlabeltext default="Review"/><location>0</location><type>0</type><onclickeventtype>2</onclickeventtype><onclickeventjavascriptfunctionname>Example.review</onclickeventjavascriptfunctionname><onclickeventjavascriptwebresourceid><webresourceid>aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa</webresourceid></onclickeventjavascriptwebresourceid><onclickeventjavascriptparameters>[{"type":5}]</onclickeventjavascriptparameters></appaction>',
  });
  const first = await loadOrganizationSources({ solutionRoots: [root] }),
    second = await loadOrganizationSources({ solutionRoots: [root] });
  assert.equal(first.metadata.modelDrivenApps.length, 2);
  assert.equal(new Set(first.metadata.modelDrivenApps.map((app) => app.id)).size, 2);
  assert.deepEqual(
    first.metadata.modelDrivenApps.map((app) => app.id),
    second.metadata.modelDrivenApps.map((app) => app.id),
  );
  assert.ok(first.metadata.modelDrivenApps.every((app) => app.idSource === 'derived-local'));
  assert.equal(
    first.metadata.modelDrivenApps.find((app) => app.uniqueName === 'x_first').navigation[0].groups[0].title,
    'Work management',
  );
  const records = first.scan.layers
    .flatMap((layer) => layer.documents.flatMap((document) => document.facts.recordComponents ?? []))
    .filter((component) => component.kind === 'appmodule');
  assert.deepEqual(
    records.map((component) => component.id).sort(),
    first.metadata.modelDrivenApps.map((app) => app.id).sort(),
  );
  assert.equal(first.clientResources.resources[0].name, 'x_/events.js');
  assert.equal(first.clientResources.appActions[0].supported, true);
  assert.equal(first.clientResources.appActions[0].sourceKind, 'appaction');
  assert.equal(
    first.clientResources.appActions[0].source,
    await fs.realpath(path.join(root, 'appactions/x_review/appaction.xml')),
  );
  assert.equal(first.clientResources.appActions[0].actions[0].library, 'x_/events.js');
  assert.deepEqual(first.clientResources.diagnostics, []);
});

test('create defers omitted platform-required columns without relaxing explicit nulls or business requirements', () => {
  const table = {
    fields: {
      x_name: { name: 'x_name', label: 'Name', type: 'text', required: true, requiredLevel: 'applicationrequired' },
      ownerid: {
        name: 'ownerid',
        label: 'Owner',
        type: 'lookup',
        dataverseType: 'owner',
        required: true,
        requiredLevel: 'systemrequired',
      },
    },
  };
  assert.deepEqual(validateValues(table, { x_name: 'Example' }, 'create'), { x_name: 'Example' });
  assert.throws(() => validateValues(table, { x_name: 'Example', ownerid: null }, 'create'), /Owner is required/);
  assert.throws(() => validateValues(table, {}, 'create'), /Name is required/);
});

test('standalone HTTP denies untrusted code and only serves declared assets after opt-in', async (t) => {
  const root = await fixture(t, {
    'WebResources/x_events.js': 'window.Example = {};',
    'WebResources/x_events.js.data.xml': descriptor('x_/events.js', 'WebResources/x_events.js'),
  });
  for (const trusted of [false, true]) {
    const sim = await createSimulator({
      runtime: { kind: 'model-driven' },
      simulation: { level: 'dry-run' },
      solutionRoots: [root],
      modelDriven: { trustedExtensions: trusted },
      watch: false,
    });
    try {
      const catalogue = await (await fetch(sim.url + '/_apps/api')).json();
      assert.equal(catalogue.clientExtensions.trusted, trusted);
      const url = sim.url + catalogue.clientExtensions.resources[0].url;
      const response = await fetch(url);
      assert.equal(response.status, trusted ? 200 : 404);
      if (trusted) {
        assert.match(response.headers.get('content-type'), /javascript/);
        const body = await response.text();
        assert.match(body, /^window\.Example = \{\};\n\/\/# sourceMappingURL=data:/);
      }
      assert.equal((await fetch(url + '?unlisted=1')).status, 404);
      assert.equal((await fetch(sim.url + '/_apps/resources/undeclared')).status, 404);
      assert.equal((await fetch(url, { method: 'POST' })).status, 405);
    } finally {
      await sim.close();
    }
  }
});

test('application icons use passive declared image resources without enabling Solution code', async (t) => {
  const id = '77777777-7777-4777-8777-777777777777';
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M1 1h22v22H1z"/></svg>';
  const root = await fixture(t, {
    'Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>InventedIcons</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'AppModules/x_inventory/AppModule.xml': `<AppModule><UniqueName>x_inventory</UniqueName><LocalizedNames><LocalizedName description="Inventory" languagecode="1033"/></LocalizedNames><WebResourceId>{${id}}</WebResourceId></AppModule>`,
    'WebResources/x_icon.svg': svg,
    'WebResources/x_icon.svg.data.xml': `<WebResource><WebResourceId>{${id}}</WebResourceId><Name>x_/icon.svg</Name><WebResourceType>11</WebResourceType><FileName>WebResources/x_icon.svg</FileName></WebResource>`,
    'WebResources/x_events.js': 'window.MustStayDisabled = true;',
    'WebResources/x_events.js.data.xml': descriptor('x_/events.js', 'WebResources/x_events.js'),
  });
  const sim = await createSimulator({
    runtime: { kind: 'model-driven' },
    simulation: { level: 'dry-run' },
    solutionRoots: [root],
    modelDriven: { trustedExtensions: false },
    watch: false,
  });
  ownedFixture(t).add(() => sim.close());
  const catalogue = await (await fetch(sim.url + '/_apps/api')).json();
  assert.equal(catalogue.clientExtensions.trusted, false);
  const icon = catalogue.clientExtensions.resources.find((resource) => resource.type === 'image');
  assert.equal(catalogue.apps.find((app) => app.uniqueName === 'x_inventory').iconUrl, icon.url);
  const response = await fetch(sim.url + icon.url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/svg+xml');
  assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(await response.text(), svg);
  const script = catalogue.clientExtensions.resources.find((resource) => resource.type === 'script');
  assert.equal((await fetch(sim.url + script.url)).status, 404);
  assert.equal((await fetch(sim.url + icon.url + '?external=1')).status, 404);
});

test('modelDriven.enabled false switches the model-driven surface off on both hosts', async (t) => {
  assert.deepEqual(modelDrivenSettings({ enabled: false }), { enabled: false, trustedExtensions: false });
  assert.deepEqual(
    modelDrivenSettings({ enabled: true }),
    { trustedExtensions: false },
    'on is the default and is not echoed',
  );
  assert.throws(() => modelDrivenSettings({ enabled: 'no' }), /enabled must be true or false/);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-md-off-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const portal = fileURLToPath(new URL('../../examples/project/portal', import.meta.url));
  for (const options of [
    { sourceDir: portal, stateFile: path.join(dir, 'portal', 'state.json') },
    { runtime: { kind: 'model-driven' }, simulation: { level: 'dry-run' } },
  ]) {
    const sim = await createSimulator({ ...options, modelDriven: { enabled: false }, watch: false });
    try {
      const status = await (await fetch(sim.url + '/_sim/api/status')).json();
      assert.equal(status.links.modelDriven, null);
      // The shell and its catalogue API are not served at all (an error page would also be "not 200").
      for (const route of ['/main.aspx', '/_apps/api'])
        assert.equal((await fetch(sim.url + route, { redirect: 'manual' })).status, 404, route);
    } finally {
      await sim.close();
    }
  }
});
