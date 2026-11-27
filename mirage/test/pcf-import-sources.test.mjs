// @test-kind contract: Paqvilo's PCF catalogue sources (unpacked, YAML, ZIP and pcf-scripts build output), manifest facts and resource serving are designed runtime behaviour, exercised with invented controls.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importCodeComponents, renderCodeComponent } from '../lib/code-components.mjs';
import { pcfBuildLayers, pcfSettings } from '../lib/pcf-sources.mjs';
import { servePcfResource } from '../lib/canvas-pcf.mjs';
import { writeSolutionAssetEntries } from '../lib/dataverse-solution-assets.mjs';
import { solutionWatchFilter } from '../lib/solution-roots.mjs';
import { inventoryEntry, mergeInventory } from '../lib/solution-inventory.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

async function workspace(t) {
  const dir = await fs.realpath(await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-pcf-sources-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const manifest = (namespace, constructor, resources = '<code path="bundle.js" order="1"/>', body = '') =>
  `<manifest><control namespace="${namespace}" constructor="${constructor}" version="1.2.3" control-type="standard">${body}<property name="value" of-type="SingleLine.Text" usage="bound"/><resources>${resources}</resources></control></manifest>`;
async function writeFiles(root, files) {
  for (const [relative, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), text);
  }
}
async function exported(
  root,
  folder,
  { name = folder, namespace = 'Invented', constructor = 'Editor', data = true } = {},
) {
  await writeFiles(path.join(root, folder), {
    'ControlManifest.xml': manifest(namespace, constructor),
    'bundle.js': `/* ${folder} */`,
    ...(data ? { 'ControlManifest.xml.data.xml': `<CustomControl><Name>${name}</Name></CustomControl>` } : {}),
  });
}

function response() {
  const result = { status: null, headers: null, body: null };
  return {
    result,
    writeHead(status, headers) {
      result.status = status;
      result.headers = headers;
    },
    end(body) {
      result.body = body;
    },
  };
}
const fail = (status, message) => Object.assign(new Error(message), { status });
async function serve(catalog, url) {
  const res = response();
  await servePcfResource({ method: 'GET' }, res, { assets: catalog.assets, key: url, fail });
  return res.result;
}

test('one control without a readable identity withdraws only the controls it could supersede', async (t) => {
  const dir = await workspace(t);
  const controls = path.join(dir, 'Controls');
  await exported(controls, 'inv_Invented.Editor');
  await exported(controls, 'inv_Other.Viewer', { namespace: 'Other', constructor: 'Viewer' });
  await exported(controls, 'inv_Third.Picker', { namespace: 'Third', constructor: 'Picker' });
  // A later folder with an unreadable identity: its folder name matches no control, its constructor matches the first.
  await exported(controls, 'z_broken', { data: false });
  const catalog = await importCodeComponents([{ dir }]);
  assert.deepEqual([...catalog.controls.keys()].sort(), ['inv_Other.Viewer', 'inv_Third.Picker']);
  assert.deepEqual(
    catalog.diagnostics.map((entry) => [entry.code, entry.name ?? null]),
    [
      ['PCF_IDENTITY_UNRESOLVED', null],
      ['PCF_IDENTITY_SHADOWED', 'inv_Invented.Editor'],
    ],
  );
  assert.equal(
    [...catalog.assets.values()].filter((asset) => asset.file.includes('inv_Invented.Editor')).length,
    0,
    'the withdrawn control serves nothing',
  );
  // A folder that shares the earlier control's folder name is a collision too, even without a readable manifest.
  const second = path.join(dir, 'second');
  await writeFiles(path.join(second, 'Controls', 'inv_Other.Viewer'), { 'ControlManifest.xml.data.xml': '<broken' });
  const layered = await importCodeComponents([{ dir }, { dir: second }]);
  assert.deepEqual([...layered.controls.keys()].sort(), ['inv_Third.Picker']);
  // A later readable control of the same name supersedes the unresolved one again.
  const third = path.join(dir, 'third');
  await exported(path.join(third, 'controls'), 'inv_Invented.Editor');
  const restored = await importCodeComponents([{ dir }, { dir: third }]);
  assert.ok(restored.controls.has('inv_Invented.Editor'));
});

test('a lower-case controls folder and a YAML solution component list select the imported controls', async (t) => {
  const dir = await workspace(t);
  await exported(path.join(dir, 'controls'), 'inv_Invented.Editor');
  await exported(path.join(dir, 'controls'), 'inv_Other.Viewer', { namespace: 'Other', constructor: 'Viewer' });
  assert.deepEqual(
    [...(await importCodeComponents([{ dir }])).controls.keys()],
    ['inv_Invented.Editor', 'inv_Other.Viewer'],
  );
  const listed = [{ relative: 'controls/inv_other.viewer/controlmanifest.xml' }];
  const yaml = await importCodeComponents([{ dir, type: 'directory', format: 'yaml', files: listed }]);
  assert.deepEqual([...yaml.controls.keys()], ['inv_Other.Viewer']);
  const none = await importCodeComponents([{ dir, type: 'directory', format: 'yaml', files: [] }]);
  assert.equal(none.controls.size, 0, 'a YAML solution that lists no control holds none');
});

test('pcf-scripts build output is named by its publisher prefix and supersedes the exported control', async (t) => {
  const dir = await workspace(t);
  await exported(path.join(dir, 'solution', 'Controls'), 'inv_Invented.Editor');
  const project = path.join(dir, 'components', 'editor');
  await writeFiles(project, {
    'editor.pcfproj':
      '<Project><PropertyGroup><OutputPath>$(MSBuildThisFileDirectory)out\\controls</OutputPath></PropertyGroup></Project>',
    'out/controls/Editor/ControlManifest.xml': manifest('Invented', 'Editor'),
    'out/controls/Editor/bundle.js': '/* built */',
  });
  await writeFiles(path.join(dir, 'packaging'), {
    'src/Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><Publisher><CustomizationPrefix>inv</CustomizationPrefix></Publisher></SolutionManifest></ImportExportXml>',
  });
  const settings = pcfSettings(
    { sources: [{ path: './components/editor/editor.pcfproj', solution: './packaging' }], maxResourceBytes: 1024 },
    'pcf',
    dir,
  );
  const diagnostics = [];
  const layers = await pcfBuildLayers(settings, { diagnostic: (entry) => diagnostics.push(entry) });
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(layers, [
    {
      type: 'pcf-build',
      dir: path.join(project, 'out', 'controls'),
      publisherPrefix: 'inv',
      source: path.join(project, 'editor.pcfproj'),
    },
  ]);
  const catalog = await importCodeComponents([{ dir: path.join(dir, 'solution') }, ...layers]);
  const control = catalog.controls.get('inv_Invented.Editor');
  assert.equal(control.identityFile, null);
  assert.equal(control.file, path.join(project, 'out', 'controls', 'Editor', 'ControlManifest.xml'));
  assert.equal((await serve(catalog, control.resources[0].url)).body.toString(), '/* built */');
  // A project folder resolves its out/controls; an explicit prefix needs no solution project.
  const direct = await pcfBuildLayers(pcfSettings({ sources: [{ path: project, publisherPrefix: 'abc' }] }));
  assert.equal(direct[0].dir, path.join(project, 'out', 'controls'));
  const named = await importCodeComponents(direct);
  assert.deepEqual([...named.controls.keys()], ['abc_Invented.Editor']);
  // Not built yet: reported and skipped.
  const missing = [];
  assert.deepEqual(
    await pcfBuildLayers(
      pcfSettings({ sources: [{ path: path.join(dir, 'nothing.pcfproj'), publisherPrefix: 'abc' }] }),
      {
        diagnostic: (entry) => missing.push(entry.code),
      },
    ),
    [],
  );
  assert.deepEqual(missing, ['PCF_BUILD_OUTPUT_MISSING']);
  for (const value of [
    { sources: [{ path: 'x' }] },
    { sources: [{ path: 'x', publisherPrefix: 'mscrmx' }] },
    { sources: [{ path: 'x', publisherPrefix: 'a' }] },
    { sources: [{ path: 'x', publisherPrefix: 'ab', solution: 'y' }] },
    { maxResourceBytes: 0 },
    { other: true },
  ])
    assert.throws(() => pcfSettings(value), /pcf/);
  await assert.rejects(importCodeComponents([{ type: 'pcf-build', dir: project }]), /publisher prefix/);
});

test('Solution ZIP layers import their controls by their CustomControl declarations and serve the archived bytes', async (t) => {
  const dir = await workspace(t);
  const zip = path.join(dir, 'invented_solution.zip');
  const entry = (name, text) => ({ name, data: Buffer.from(text) });
  await fs.writeFile(
    zip,
    writeSolutionAssetEntries([
      entry(
        'customizations.xml',
        '<ImportExportXml><CustomControls><CustomControl><Name>inv_Invented.Editor</Name><FileName>/Controls/inv_Invented.Editor/ControlManifest.xml</FileName></CustomControl></CustomControls></ImportExportXml>',
      ),
      entry(
        'Controls/inv_Invented.Editor/ControlManifest.xml',
        manifest('Invented', 'Editor', '<code path="bundle.js" order="1"/><img path="img/icon.svg"/>'),
      ),
      entry('Controls/inv_Invented.Editor/bundle.js', '/* zipped */'),
      entry('Controls/inv_Invented.Editor/img/icon.svg', '<svg/>'),
      entry('Controls/inv_Unnamed.Thing/ControlManifest.xml', manifest('Unnamed', 'Thing')),
      entry('Controls/inv_Unnamed.Thing/bundle.js', '/* unnamed */'),
    ]),
  );
  const catalog = await importCodeComponents([{ type: 'zip', dir: zip }]);
  assert.deepEqual([...catalog.controls.keys()], ['inv_Invented.Editor']);
  assert.deepEqual(
    catalog.diagnostics.map((item) => item.code),
    ['PCF_IDENTITY_UNRESOLVED'],
  );
  const control = catalog.controls.get('inv_Invented.Editor');
  assert.equal(control.file, undefined);
  assert.deepEqual(control.archive, { file: zip, entry: 'Controls/inv_Invented.Editor/ControlManifest.xml' });
  const resource = (kind) => control.resources.find((item) => item.kind === kind).url;
  assert.equal((await serve(catalog, resource('code'))).body.toString(), '/* zipped */');
  const image = await serve(catalog, resource('img'));
  assert.equal(image.headers['content-type'], 'image/svg+xml');
  const broken = path.join(dir, 'broken.zip');
  await fs.writeFile(broken, 'not a zip');
  const unreadable = await importCodeComponents([{ type: 'zip', dir: broken }]);
  assert.equal(unreadable.diagnostics[0].code, 'PCF_ARCHIVE_UNREADABLE');
});

test('declared images, html and the files declared styles and bundles refer to are served with their own types', async (t) => {
  const dir = await workspace(t);
  const control = path.join(dir, 'Controls', 'inv_Invented.Editor');
  await writeFiles(control, {
    'ControlManifest.xml': manifest(
      'Invented',
      'Editor',
      '<code path="bundle.js" order="1"/><css path="css/editor.css" order="1"/><img path="img/icon.png"/><html path="html/help.html"/><dependency type="control" name="inv_Invented.Library" load-type="onDemand"/><unknown path="x"/>',
    ),
    'ControlManifest.xml.data.xml': '<CustomControl><Name>inv_Invented.Editor</Name></CustomControl>',
    'bundle.js': 'var x;\n//# sourceMappingURL=bundle.js.map',
    'bundle.js.map': '{}',
    'css/editor.css':
      '.a{background:url("../img/back.webp")}@font-face{src:url(fonts/f.woff2?v=1)}.b{background:url(https://example.invalid/x.png)}.c{background:url(../../outside.png)}',
    'css/fonts/f.woff2': 'font',
    'img/icon.png': 'png',
    'img/back.webp': 'webp',
    'html/help.html': '<p>help</p>',
    'undeclared.js': 'secret',
  });
  await fs.writeFile(path.join(dir, 'Controls', 'outside.png'), 'outside');
  const catalog = await importCodeComponents([{ dir }]);
  const record = catalog.controls.get('inv_Invented.Editor');
  assert.deepEqual(record.dependencies, [
    { type: 'control', name: 'inv_Invented.Library', order: null, loadType: 'onDemand' },
  ]);
  assert.deepEqual(
    catalog.diagnostics.map((item) => [item.code, item.kind]),
    [['PCF_RESOURCE_KIND_UNSUPPORTED', 'unknown']],
  );
  const base = record.resources.find((resource) => resource.kind === 'code').url.replace(/bundle\.js$/, '');
  const types = {};
  for (const relative of [
    'bundle.js',
    'bundle.js.map',
    'css/editor.css',
    'css/fonts/f.woff2',
    'img/icon.png',
    'img/back.webp',
    'html/help.html',
  ])
    types[relative] = (await serve(catalog, base + relative)).headers['content-type'];
  assert.deepEqual(types, {
    'bundle.js': 'text/javascript; charset=utf-8',
    'bundle.js.map': 'application/json; charset=utf-8',
    'css/editor.css': 'text/css; charset=utf-8',
    'css/fonts/f.woff2': 'font/woff2',
    'img/icon.png': 'image/png',
    'img/back.webp': 'image/webp',
    'html/help.html': 'text/html; charset=utf-8',
  });
  for (const relative of ['undeclared.js', '../outside.png', 'outside.png'])
    await assert.rejects(serve(catalog, base + relative), { status: 404 });
  // The catalogue itself admitted exactly these files: the outside and remote style references were never located.
  assert.deepEqual(
    [...catalog.assets.values()].map((asset) => path.relative(control, asset.file).replaceAll('\\', '/')).sort(),
    [
      'bundle.js',
      'bundle.js.map',
      'css/editor.css',
      'css/fonts/f.woff2',
      'html/help.html',
      'img/back.webp',
      'img/icon.png',
    ],
  );
});

test('a declared resource above the configured byte cap is refused with its size and the setting', async (t) => {
  const dir = await workspace(t);
  await exported(path.join(dir, 'Controls'), 'inv_Invented.Editor');
  await fs.writeFile(path.join(dir, 'Controls', 'inv_Invented.Editor', 'bundle.js'), 'x'.repeat(2048));
  const refused = await importCodeComponents([{ dir }], { maxResourceBytes: 1024 });
  assert.equal(refused.controls.size, 0);
  assert.equal(refused.diagnostics[0].code, 'PCF_IMPORT_FAILED');
  assert.equal(refused.diagnostics[0].reason, 'PCF_RESOURCE_TOO_LARGE');
  assert.equal(refused.diagnostics[0].size, 2048);
  assert.match(refused.diagnostics[0].message, /pcf\.maxResourceBytes/);
  const admitted = await importCodeComponents([{ dir }], { maxResourceBytes: 4096 });
  const asset = [...admitted.assets.values()][0];
  assert.equal(asset.maxBytes, 4096);
});

test('manifest facts, Enum values and dependencies are imported as exported', async (t) => {
  const dir = await workspace(t);
  const control = path.join(dir, 'Controls', 'inv_Invented.Editor');
  await writeFiles(control, {
    'ControlManifest.xml': `<manifest><control namespace="Invented" constructor="Editor" version="2.0.1" api-version="1.3.0" display-name-key="Editor_Name" description-key="Editor_Desc" control-type="standard">
      <external-service-usage enabled="true"><domain>example.invalid</domain></external-service-usage>
      <property name="mode" display-name-key="Mode" description-key="Mode_Desc" of-type="Enum" usage="input" required="true" default-value="1" pfx-default-value="&quot;Low&quot;">
        <value name="Low" display-name-key="Low_Key">1</value><value name="High" display-name-key="High_Key">2</value>
      </property>
      <property name="value" of-type="SingleLine.Text" usage="bound"/>
      <common-property name="Width" ref="width"/>
      <property-dependencies><property-dependency input="mode" output="value" required-for="schema"/></property-dependencies>
      <data-set name="rows"><property-set name="column" of-type="SingleLine.Text" usage="bound"/></data-set>
      <resources><code path="bundle.js" order="1"/></resources></control></manifest>`,
    'ControlManifest.xml.data.xml': '<CustomControl><Name>inv_Invented.Editor</Name></CustomControl>',
    'bundle.js': '/* */',
  });
  const record = (await importCodeComponents([{ dir }])).controls.get('inv_Invented.Editor');
  assert.deepEqual(
    {
      version: record.version,
      apiVersion: record.apiVersion,
      displayNameKey: record.displayNameKey,
      descriptionKey: record.descriptionKey,
      externalServiceUsage: record.externalServiceUsage,
      commonProperties: record.commonProperties,
      propertyDependencies: record.propertyDependencies,
    },
    {
      version: '2.0.1',
      apiVersion: '1.3.0',
      displayNameKey: 'Editor_Name',
      descriptionKey: 'Editor_Desc',
      externalServiceUsage: { enabled: 'true', domains: ['example.invalid'] },
      commonProperties: [{ name: 'Width', ref: 'width' }],
      propertyDependencies: [{ input: 'mode', output: 'value', 'required-for': 'schema' }],
    },
  );
  assert.deepEqual(
    record.properties.map((property) => property.name),
    ['mode', 'value'],
    'a dataset property-set is not a control parameter',
  );
  const mode = record.properties[0];
  assert.equal(mode['pfx-default-value'], '"Low"');
  assert.equal(mode['description-key'], 'Mode_Desc');
  assert.deepEqual(mode.values, [
    { name: 'Low', value: '1', displayNameKey: 'Low_Key' },
    { name: 'High', value: '2', displayNameKey: 'High_Key' },
  ]);
  assert.equal(Object.hasOwn(record.properties[1], 'values'), false);
});

test('the inventory names a control as the catalogue does and keeps its constructor', () => {
  const folder = 'inv_Invented.Editor';
  const records = mergeInventory([
    ...inventoryEntry(`Controls/${folder}/ControlManifest.xml`, {
      text: manifest('Invented', 'Editor'),
      component: 'customcontrol',
      componentName: folder,
    }),
    ...inventoryEntry(`Controls/${folder}/ControlManifest.xml.data.xml`, {
      text: `<CustomControl><Name>${folder}</Name></CustomControl>`,
      component: 'customcontrol',
      componentName: folder,
    }),
  ]);
  assert.equal(records.length, 1);
  assert.equal(records[0].name, folder);
  assert.equal(records[0].controlConstructor, 'Invented.Editor');
  assert.equal(records[0].version, '1.2.3');
});

test('a pcf.sources build output is watched for control files only', async (t) => {
  const dir = await workspace(t);
  const built = path.join(dir, 'out', 'controls');
  const ignored = solutionWatchFilter({ roots: [], layers: [], controlTrees: [built] });
  const file = { isFile: () => true };
  assert.equal(ignored(path.join(built, 'Editor', 'bundle.js'), file), false);
  assert.equal(ignored(path.join(built, 'Editor', 'img', 'icon.gif'), file), false);
  assert.equal(ignored(path.join(built, 'Editor', 'fonts', 'f.ttf'), file), false);
  assert.equal(ignored(path.join(built, 'Editor', 'notes.txt'), file), true);
  assert.equal(ignored(path.join(built, 'node_modules', 'x.js'), file), true);
});

test('render names the import failure of a control that is not in the catalogue', async (t) => {
  const dir = await workspace(t);
  await writeFiles(path.join(dir, 'Controls', 'inv_Invented.Editor'), {
    'ControlManifest.xml': manifest('Invented', 'Editor', '<code path="missing.js"/>'),
    'ControlManifest.xml.data.xml': '<CustomControl><Name>inv_Invented.Editor</Name></CustomControl>',
  });
  const catalog = await importCodeComponents([{ dir }]);
  const diagnostics = [];
  const html = renderCodeComponent({
    name: 'inv_Invented.Editor',
    portal: {},
    catalog,
    diagnostic: (entry) => diagnostics.push(entry),
  });
  assert.match(html, /was not imported: Declared PCF resource is missing or outside its control: missing\.js/);
  assert.equal(diagnostics[0].importCode, 'PCF_IMPORT_FAILED');
});

test('the runtime serves a pcf.sources build output and keeps portal catalogue diagnostics beside clientSources', async (t) => {
  const { createSimulator } = await import('../server.mjs');
  const dir = await workspace(t);
  const solution = path.join(dir, 'solution');
  await writeFiles(path.join(solution, 'Controls', 'inv_Broken.Thing'), {
    'ControlManifest.xml': manifest('Broken', 'Thing', '<code path="missing.js"/>'),
    'ControlManifest.xml.data.xml': '<CustomControl><Name>inv_Broken.Thing</Name></CustomControl>',
  });
  await writeFiles(path.join(dir, 'editor', 'out', 'controls', 'Editor'), {
    'ControlManifest.xml': manifest('Invented', 'Editor'),
    'bundle.js': 'window.InventedBuilt = true;',
  });
  const portal = path.join(dir, 'portal');
  await writeFiles(portal, {
    'website.yml': 'adx_websiteid: invented\nadx_name: Invented\n',
    'web-pages/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main\n',
    'Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main\n',
    'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main\n',
    'Main.webtemplate.source.html': '<html><body>{% codecomponent name:inv_Invented.Editor %}</body></html>',
  });
  const runtime = await createSimulator({
    sourceDir: portal,
    solutionRoots: [solution],
    modelDriven: { trustedExtensions: false, clientSources: [] },
    pcf: pcfSettings({ sources: [{ path: './editor', publisherPrefix: 'inv' }] }, 'pcf', dir),
    watch: false,
    port: 0,
  });
  t.after(() => runtime.close());
  const home = await fetch(runtime.url).then((response) => response.text());
  assert.match(home, /data-pcf-schema="inv_Invented.Editor"/);
  const asset = /\/__sim-static\/pcf\/[a-f0-9]+\/bundle\.js/.exec(home)?.[0];
  assert.equal(await fetch(runtime.url + asset).then((response) => response.text()), 'window.InventedBuilt = true;');
  const { diagnostics } = await (await fetch(runtime.url + '/_sim/api/diagnostics')).json();
  const failed = diagnostics.find((entry) => entry.code === 'PCF_IMPORT_FAILED');
  assert.equal(failed?.catalogue, 'portal');
});

const control = (extra = {}) => ({
  schemaName: 'inv_Invented.Editor',
  constructor: 'Invented.Editor',
  type: 'standard',
  properties: [],
  features: [],
  libraries: [],
  dependencies: [],
  resources: [{ kind: 'code', path: 'bundle.js', url: '/__sim-static/pcf/t/bundle.js' }],
  ...extra,
});
const render = (record, options = {}) => {
  const diagnostics = [];
  const html = renderCodeComponent({
    name: record.schemaName,
    portal: {},
    catalog: { controls: new Map([[record.schemaName, record]]) },
    diagnostic: (entry) => diagnostics.push(entry),
    ...options,
  });
  return { html, diagnostics };
};

test('a standard control whose platform library is not supplied is refused naming pcf.platformLibraries', () => {
  const record = control({ libraries: [{ name: 'React', version: '16.14.0' }] });
  const { html, diagnostics } = render(record);
  assert.equal(diagnostics[0].reason, 'PCF_PLATFORM_LIBRARY_UNSUPPORTED');
  assert.match(
    html,
    /requires platform libraries \(React 16\.14\.0\)\. Supply React@16\.14\.0\.js as project files in pcf\.platformLibraries/,
  );
  assert.doesNotMatch(html, /clientSources/);
  // Supplied as a project file, the control mounts (the live field host mounts it: paqvilo-developer pcf-parity summary-B).
  const supplied = render(record, { platformLibraries: [{ name: 'React', version: '16.14.0', url: '/x/React.js' }] });
  assert.match(supplied.html, /__paqviloPcf\.mount/);
});

test('render reports dependencies, required parameters without a value and Web API use without a table mapping', () => {
  const record = control({
    dependencies: [{ type: 'control', name: 'inv_Invented.Library', order: null, loadType: 'onDemand' }],
    features: [{ name: 'WebAPI', required: 'false' }],
    properties: [
      { name: 'Mode', usage: 'input', 'of-type': 'SingleLine.Text', required: 'true' },
      { name: 'Given', usage: 'input', 'of-type': 'SingleLine.Text', required: 'true' },
      { name: 'Defaulted', usage: 'input', 'of-type': 'SingleLine.Text', required: 'true', 'default-value': 'x' },
      { name: 'Optional', usage: 'input', 'of-type': 'SingleLine.Text' },
    ],
  });
  const { html, diagnostics } = render(record, { args: { Given: 'value' } });
  assert.match(html, /__paqviloPcf\.mount/, 'notices never refuse the control');
  assert.deepEqual(
    diagnostics.map((entry) => entry.code),
    ['PCF_DEPENDENCY_NOT_LOADED', 'PCF_REQUIRED_PROPERTY_MISSING', 'PCF_WEBAPI_MAPPING_MISSING'],
  );
  assert.deepEqual(diagnostics[1].properties, ['Mode']);
  const mapped = render(record, {
    args: { Mode: 'a', Given: 'b' },
    mappings: { x_row: { entitySet: 'x_rows', idColumn: 'x_rowid' } },
  });
  assert.deepEqual(
    mapped.diagnostics.map((entry) => entry.code),
    ['PCF_DEPENDENCY_NOT_LOADED'],
  );
});

test('portal:pcf source graph rows list every Power Pages refusal reason of a control', async () => {
  const { buildSourceGraph } = await import('../lib/source-graph.mjs');
  const controls = [
    { name: 'inv_Plain.Ok', controlType: 'standard', features: [], libraries: [] },
    {
      name: 'inv_Many.Reasons',
      controlType: 'standard',
      features: [{ name: 'Device.captureImage', required: 'true' }],
      libraries: [{ name: 'React', version: '16.14.0' }],
      dependencies: [{ type: 'control', name: 'inv_Other.Library' }],
    },
    { name: 'inv_Odd.Type', controlType: 'other', features: [], libraries: [] },
  ];
  const rows = buildSourceGraph({ portal: { diagnostics: [] }, clientResources: { pcf: { controls } } })
    .requirements()
    .filter((row) => row.id.startsWith('portal:pcf/'));
  assert.deepEqual(
    rows.map((row) => [row.id, row.reason, row.reasons]),
    [
      [
        'portal:pcf/inv_many.reasons',
        'PCF_FEATURE_DECLARATIONS_UNSUPPORTED',
        ['PCF_FEATURE_DECLARATIONS_UNSUPPORTED', 'PCF_PLATFORM_LIBRARY_UNSUPPORTED', 'PCF_DEPENDENCY_NOT_LOADED'],
      ],
      ['portal:pcf/inv_odd.type', 'PCF_CONTROL_TYPE_UNSUPPORTED', ['PCF_CONTROL_TYPE_UNSUPPORTED']],
    ],
  );
});

test('RESX groups of one control resolve to one language and never mix languages', () => {
  const resource = (group, lcid, strings) => ({
    path: `strings/${group}.${lcid}.resx`,
    group: `strings/${group}`,
    lcid,
    attributes: {},
    strings,
  });
  const record = control({
    stringResources: [
      resource('Labels', 1036, { Caption: 'Bonjour' }),
      resource('Labels', 1033, { Caption: 'Hello' }),
      resource('Errors', 1033, { Failure: 'Failed' }),
    ],
  });
  const english = { code: 'en-US', lcid: 1033, isDefault: true };
  const spec = (language) => {
    const { html, diagnostics } = render(record, { language, portal: { websiteLanguages: [english] } });
    return { value: JSON.parse(/__paqviloPcf\.mount\((.*), document\.currentScript/.exec(html)[1]), diagnostics };
  };
  const french = spec({ code: 'fr-FR', lcid: 1036 });
  assert.deepEqual(french.value.strings, { Caption: 'Bonjour' }, 'the English-only group is not mixed into French');
  assert.equal(french.value.localization.lcid, 1036);
  assert.deepEqual(
    french.diagnostics.map((entry) => [entry.code, entry.group, entry.controlLcid]),
    [['PCF_RESOURCE_LANGUAGE_UNRESOLVED', 'strings/Errors', 1036]],
  );
  const german = spec({ code: 'de-DE', lcid: 1031 });
  assert.deepEqual(german.value.strings, { Caption: 'Hello', Failure: 'Failed' });
  assert.deepEqual(
    german.diagnostics.map((entry) => entry.code),
    ['PCF_RESOURCE_LANGUAGE_FALLBACK'],
  );
  assert.deepEqual(german.diagnostics[0].groups, ['strings/Labels', 'strings/Errors']);
});

test('a rebuilt control reloads the code components alone and the page serves the new bundle', async (t) => {
  const { createSimulator } = await import('../server.mjs');
  const dir = await workspace(t);
  const built = path.join(dir, 'editor', 'out', 'controls', 'Editor');
  await writeFiles(built, { 'ControlManifest.xml': manifest('Invented', 'Editor'), 'bundle.js': '/* first */' });
  const portal = path.join(dir, 'portal');
  await writeFiles(portal, {
    'website.yml': 'adx_websiteid: invented\nadx_name: Invented\n',
    'web-pages/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main\n',
    'Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main\n',
    'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main\n',
    'Main.webtemplate.source.html': '<html><body>{% codecomponent name:inv_Invented.Editor %}</body></html>',
  });
  const runtime = await createSimulator({
    sourceDir: portal,
    pcf: pcfSettings({ sources: [{ path: './editor', publisherPrefix: 'inv' }] }, 'pcf', dir),
    watch: true,
    port: 0,
  });
  t.after(() => runtime.close());
  const bundle = async () => {
    const home = await fetch(runtime.url).then((response) => response.text());
    const asset = /\/__sim-static\/pcf\/[a-f0-9]+\/bundle\.js/.exec(home)?.[0];
    return fetch(runtime.url + asset).then((response) => response.text());
  };
  assert.equal(await bundle(), '/* first */');
  // createSimulator resolves after the source watcher reported ready.
  await fs.writeFile(path.join(built, 'bundle.js'), '/* second */');
  // The 50 ms only paces the reads; a reload that never comes is ended by the runner's --test-timeout.
  let reloaded;
  while (!reloaded) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const { diagnostics } = await (await fetch(runtime.url + '/_sim/api/diagnostics')).json();
    reloaded = diagnostics.find((entry) => entry.code === 'SOURCES_RELOADED');
  }
  assert.equal(reloaded.scope, 'code-components');
  assert.equal(await bundle(), '/* second */');
});

test('a build output folder without a readable manifest withdraws the controls its rebuild could replace', async (t) => {
  const dir = await workspace(t);
  await exported(path.join(dir, 'solution', 'Controls'), 'inv_Invented.Editor');
  await exported(path.join(dir, 'solution', 'Controls'), 'inv_Other.Viewer', {
    namespace: 'Other',
    constructor: 'Viewer',
  });
  await exported(path.join(dir, 'solution', 'Controls'), 'abc_Foreign.Editor', { namespace: 'Foreign' });
  const built = path.join(dir, 'out', 'controls');
  const layers = [{ dir: path.join(dir, 'solution') }, { type: 'pcf-build', dir: built, publisherPrefix: 'inv' }];
  // Half written during a rebuild: no namespace or constructor; the folder names the constructor.
  await writeFiles(path.join(built, 'Editor'), { 'ControlManifest.xml': '<manifest><control', 'bundle.js': '/* */' });
  const folder = await importCodeComponents(layers);
  assert.deepEqual([...folder.controls.keys()].sort(), ['abc_Foreign.Editor', 'inv_Other.Viewer']);
  assert.deepEqual(
    folder.diagnostics.filter((entry) => entry.code === 'PCF_IDENTITY_SHADOWED').map((entry) => entry.name),
    ['inv_Invented.Editor'],
  );
  // A folder name that matches no control and no constructor: every earlier control of the prefix could be replaced.
  await fs.rm(path.join(built, 'Editor'), { recursive: true });
  await writeFiles(path.join(built, 'Renamed'), { 'bundle.js': '/* manifest not written yet */' });
  const prefix = await importCodeComponents(layers);
  assert.deepEqual([...prefix.controls.keys()], ['abc_Foreign.Editor']);
  assert.deepEqual(
    prefix.diagnostics
      .filter((entry) => entry.code === 'PCF_IDENTITY_SHADOWED')
      .map((entry) => entry.name)
      .sort(),
    ['inv_Invented.Editor', 'inv_Other.Viewer'],
  );
});

test('watch: control-only reloads replace their PCF findings, a half-written rebuild withdraws the export, an identity change reloads all', async (t) => {
  const { createSimulator } = await import('../server.mjs');
  const dir = await workspace(t);
  const solution = path.join(dir, 'solution');
  await writeFiles(path.join(solution, 'Other'), {
    'Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>Invented</UniqueName></SolutionManifest></ImportExportXml>',
  });
  await exported(path.join(solution, 'Controls'), 'inv_Invented.Editor');
  await writeFiles(path.join(solution, 'Controls', 'inv_Broken.Thing'), {
    'ControlManifest.xml': manifest('Broken', 'Thing', '<code path="missing.js"/>'),
    'ControlManifest.xml.data.xml': '<CustomControl><Name>inv_Broken.Thing</Name></CustomControl>',
  });
  const built = path.join(dir, 'editor', 'out', 'controls', 'Editor');
  await writeFiles(built, { 'ControlManifest.xml': manifest('Invented', 'Editor'), 'bundle.js': '/* built */' });
  const portal = path.join(dir, 'portal');
  await writeFiles(portal, {
    'website.yml': 'adx_websiteid: invented\nadx_name: Invented\n',
    'web-pages/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main\n',
    'Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main\n',
    'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main\n',
    'Main.webtemplate.source.html': '<html><body>{% codecomponent name:inv_Invented.Editor %}</body></html>',
  });
  const runtime = await createSimulator({
    sourceDir: portal,
    solutionRoots: [solution],
    pcf: pcfSettings({ sources: [{ path: './editor', publisherPrefix: 'inv' }] }, 'pcf', dir),
    watch: true,
    port: 0,
  });
  t.after(() => runtime.close());
  const diagnostics = async () => (await (await fetch(runtime.url + '/_sim/api/diagnostics')).json()).diagnostics;
  const reloads = async () => (await diagnostics()).filter((entry) => entry.code === 'SOURCES_RELOADED');
  // The 50 ms only paces the reads; a reload that never comes is ended by the runner's --test-timeout.
  // A full reload drops the findings of the previous revision, so a reload is found by its revision.
  const nextReload = async (revision) => {
    for (;;) {
      const done = (await reloads()).filter((entry) => entry.revision > revision);
      if (done.length) return done.at(-1);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const failures = async () => (await diagnostics()).filter((entry) => entry.code === 'PCF_IMPORT_FAILED').length;
  assert.equal(await failures(), 1);
  await fs.writeFile(path.join(built, 'bundle.js'), '/* rebuilt */');
  let reload = await nextReload(0);
  assert.equal(reload.scope, 'code-components');
  assert.equal(await failures(), 1, 'the previous catalogue finding is replaced, not repeated');
  // A rebuild writes its manifest after the bundle: the half-written manifest must not leave the export serving.
  await fs.writeFile(path.join(built, 'ControlManifest.xml'), '<manifest><control');
  reload = await nextReload(reload.revision);
  assert.equal(reload.scope, 'code-components');
  const home = await fetch(runtime.url).then((response) => response.text());
  assert.doesNotMatch(home, /data-pcf-schema="inv_Invented.Editor"/);
  // The tag of a withdrawn control renders nothing, as a missing control does on Power Pages; the diagnostic says why.
  assert.ok(
    (await diagnostics()).some(
      (entry) => entry.code === 'PCF_LIQUID_CONTROL_NOT_FOUND' && /was not imported/.test(entry.message),
    ),
  );
  // An identity file of a Solution layer belongs to the inventory: the full reload runs.
  await fs.writeFile(
    path.join(solution, 'Controls', 'inv_Invented.Editor', 'ControlManifest.xml.data.xml'),
    '<CustomControl><Name>inv_Invented.Renamed</Name></CustomControl>',
  );
  reload = await nextReload(reload.revision);
  assert.equal(reload.scope, undefined);
});

test('the model-driven host serves the files a declared style refers to under its control address', async (t) => {
  const { importModelDrivenResources } = await import('../lib/model-driven-resources.mjs');
  const dir = await workspace(t);
  await writeFiles(path.join(dir, 'Controls', 'inv_Invented.Editor'), {
    'ControlManifest.xml': manifest(
      'Invented',
      'Editor',
      '<code path="bundle.js" order="1"/><css path="editor.css" order="1"/>',
    ),
    'ControlManifest.xml.data.xml': '<CustomControl><Name>inv_Invented.Editor</Name></CustomControl>',
    'bundle.js': '/* */',
    'editor.css': '.a{background:url(img/back.png)}',
    'img/back.png': 'png',
  });
  const catalog = await importCodeComponents([{ dir }], { retainBytes: true });
  const imported = await importModelDrivenResources([{ type: 'directory', dir }], { codeComponents: catalog });
  const image = [...imported.assets].find(([url]) => url.endsWith('/img/back.png'));
  assert.ok(image?.[0].startsWith('/_apps/controls/'), [...imported.assets.keys()].join(', '));
  assert.equal(image[1].mime, 'image/png');
  assert.equal(image[1].data.toString(), 'png');
});

test('a .pcfproj OutputPath that leaves its project folder is refused before it is read', async (t) => {
  const dir = await workspace(t);
  const project = path.join(dir, 'project');
  await writeFiles(dir, { 'elsewhere/controls/Editor/ControlManifest.xml': manifest('Invented', 'Editor') });
  for (const output of [
    String.raw`..\elsewhere\controls`,
    String.raw`C:\elsewhere`,
    String.raw`\\attacker.invalid\share`,
    '../elsewhere/controls',
  ]) {
    await writeFiles(project, {
      'editor.pcfproj': `<Project><PropertyGroup><OutputPath>${output}</OutputPath></PropertyGroup></Project>`,
    });
    const diagnostics = [];
    const layers = await pcfBuildLayers(
      pcfSettings({ sources: [{ path: path.join(project, 'editor.pcfproj'), publisherPrefix: 'inv' }] }),
      { diagnostic: (entry) => diagnostics.push(entry.code) },
    );
    assert.deepEqual(layers, [], output);
    assert.deepEqual(diagnostics, ['PCF_BUILD_SOURCE_OUTSIDE'], output);
  }
  // The same folder named by the setting itself is a source.
  const named = await pcfBuildLayers(
    pcfSettings({ sources: [{ path: path.join(dir, 'elsewhere', 'controls'), publisherPrefix: 'inv' }] }),
  );
  assert.equal(named.length, 1);
});

// @test-kind observation: the live platform library set (React and ReactDOM 16.14.0, @fluentui/react 8.122.8) follows two page loads of a Power Pages site (paqvilo-developer pcf-parity summary-D)
test('pcf.platformLibraries names the live set when a file is missing or another version', async (t) => {
  const { pcfPlatformLibraries } = await import('../lib/pcf-sources.mjs');
  const dir = await workspace(t);
  await writeFiles(dir, {
    'React@17.0.2.js': '/* */',
    'ReactDOM@16.14.0.js': '/* */',
    'FluentUIReact@8.122.8.js': '/* */',
  });
  const diagnostics = [];
  const supplied = await pcfPlatformLibraries(
    pcfSettings(
      { platformLibraries: ['React@17.0.2.js', 'ReactDOM@16.14.0.js', 'FluentUIReact@8.122.8.js'] },
      'pcf',
      dir,
    ),
    { diagnostic: (entry) => diagnostics.push(entry) },
  );
  assert.deepEqual(
    supplied.libraries.map((library) => `${library.name}@${library.version}`),
    ['React@17.0.2', 'ReactDOM@16.14.0', 'FluentUIReact@8.122.8'],
  );
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, 'PCF_PLATFORM_LIBRARY_LIVE_SET');
  assert.match(diagnostics[0].message, /lacks React@16\.14\.0\.js\./);
  await writeFiles(dir, { 'React@16.14.0.js': '/* */' });
  const live = [];
  await pcfPlatformLibraries(
    pcfSettings(
      { platformLibraries: ['React@16.14.0.js', 'ReactDOM@16.14.0.js', 'FluentUIReact@8.122.8.js'] },
      'pcf',
      dir,
    ),
    { diagnostic: (entry) => live.push(entry) },
  );
  assert.deepEqual(live, []);
});

test('pcf.platformLibraries serves one file per library and reports a second', async (t) => {
  const { pcfPlatformLibraries } = await import('../lib/pcf-sources.mjs');
  const dir = await workspace(t);
  await writeFiles(dir, { 'React@16.14.0.js': '/* */', 'react@17.0.2.js': '/* */' });
  const diagnostics = [];
  const served = await pcfPlatformLibraries(
    pcfSettings({ platformLibraries: ['React@16.14.0.js', 'react@17.0.2.js'] }, 'pcf', dir),
    { diagnostic: (entry) => diagnostics.push(entry.code) },
  );
  assert.deepEqual(
    served.libraries.map((library) => library.version),
    ['16.14.0'],
  );
  assert.ok(diagnostics.includes('PCF_PLATFORM_LIBRARY_DUPLICATE'));
});

test('a required input with a default value is neither written empty nor reported missing', () => {
  const record = control({
    properties: [
      { name: 'needed', usage: 'input', 'of-type': 'SingleLine.Text', required: 'true', 'default-value': 'd' },
    ],
  });
  const { html, diagnostics } = render(record, { liquidTag: true });
  const context = JSON.parse(
    /pcf-controlcontext="([^"]*)"/
      .exec(html)[1]
      .replace(
        /&(quot|amp|lt|gt|#39|#32);/g,
        (_, name) => ({ quot: '"', amp: '&', lt: '<', gt: '>', '#39': "'", '#32': ' ' })[name],
      ),
  );
  assert.deepEqual(context.ControlProperties, {});
  assert.ok(!diagnostics.some((entry) => entry.code === 'PCF_REQUIRED_PROPERTY_MISSING'));
});
