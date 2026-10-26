import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { writeSolutionAssetEntries } from '../lib/dataverse-solution-assets.mjs';
import { canvasInventoryRecord, readCanvasSource, readCanvasSources } from '../lib/canvas-source.mjs';

const APP = [
  'App:',
  '  Properties:',
  '    OnStart: =Set(fxCounter, 1)',
  'DataSources:',
  '  Widgets:',
  '    Type: Table',
  '    Parameters:',
  '      TableLogicalName: fx_widget',
  '  InventedService:',
  '    Type: Actions',
  '    ConnectorId: shared_fxinvented',
  '',
].join('\n');
const HOME = [
  'Screens:',
  '  HomeScreen:',
  '    Properties:',
  '      Fill: =RGBA(255, 255, 255, 1)',
  '    Children:',
  '      - WidgetGallery:',
  '          Control: Gallery@2.15.0',
  '          Variant: Vertical',
  '          Properties:',
  '            Items: =Filter(Widgets, fx_name <> "")',
  '          Children:',
  '            - WidgetTitle:',
  '                Control: Label@2.5.1',
  '                Properties:',
  '                  Text: =ThisItem.fx_name',
  '',
].join('\n');
const DETAIL = [
  'Screens:',
  '  DetailScreen:',
  '    Children:',
  '      - SaveButton:',
  '          Control: Button@0.0.45',
  '          Properties:',
  '            OnSelect: |-',
  '              =Patch(Widgets, Defaults(Widgets), {fx_name: "x"})',
  '',
].join('\n');
const COMPONENT =
  'ComponentDefinitions:\n  FxHeader:\n    DefinitionType: CanvasComponent\n    Properties:\n      Fill: =Color.Blue\n';
const files = {
  'Src/App.pa.yaml': APP,
  'Src/HomeScreen.pa.yaml': HOME,
  'Src/DetailScreen.pa.yaml': DETAIL,
  'Src/Component/FxHeader.pa.yaml': COMPONENT,
  'Header.json': '{}',
};
const msappOf = (entries) =>
  writeSolutionAssetEntries(Object.entries(entries).map(([name, body]) => ({ name, data: Buffer.from(body) })));

test('configured canvas imports reject an archive changed during the opened read with a source diagnostic', async (t) => {
  const root = await dirOf(t, { 'Invented.msapp': msappOf(files) });
  const file = await fs.realpath(path.join(root, 'Invented.msapp'));
  const open = fs.open;
  let grew = false;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args);
    if (args[0] === file) {
      const read = handle.read.bind(handle);
      t.mock.method(handle, 'read', async (...readArgs) => {
        if (!grew) {
          grew = true;
          await fs.appendFile(file, Buffer.from('changed during read'));
        }
        return read(...readArgs);
      });
    }
    return handle;
  });
  const report = await readCanvasSources(['Invented.msapp'], { projectRoot: root });
  assert.equal(grew, true);
  assert.deepEqual(report.records, []);
  assert.equal(report.diagnostics.length, 1);
  assert.equal(report.diagnostics[0].code, 'CANVAS_SOURCE_MISSING');
  assert.equal(report.diagnostics[0].source, 'Invented.msapp');
});

test('configured canvas imports retain directory and archive inventories and diagnose missing paths', async (t) => {
  const root = await dirOf(t, {
    ...Object.fromEntries(Object.entries(files).map(([name, body]) => ['unpacked/' + name, body])),
    'Invented.msapp': msappOf(files),
  });
  const report = await readCanvasSources(['unpacked', 'Invented.msapp', 'missing.msapp'], { projectRoot: root });
  assert.deepEqual(
    report.records.map((record) => [record.format, record.canvas.screens]),
    [
      ['directory', ['DetailScreen', 'HomeScreen']],
      ['msapp', ['DetailScreen', 'HomeScreen']],
    ],
  );
  assert.deepEqual(
    report.diagnostics.map((item) => [item.code, item.source]),
    [['CANVAS_SOURCE_MISSING', 'missing.msapp']],
  );
});

async function dirOf(t, entries) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-source-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(entries)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), body);
  }
  return root;
}

function assertInventory(source) {
  assert.deepEqual(source.diagnostics, []);
  assert.equal(source.app.schemaVersion, '3.0');
  assert.deepEqual(source.screens.map((screen) => screen.name).sort(), ['DetailScreen', 'HomeScreen']);
  const home = source.screens.find((screen) => screen.name === 'HomeScreen');
  assert.deepEqual(home.controls, [
    { name: 'WidgetGallery', control: 'Gallery@2.15.0', parent: null, variant: 'Vertical' },
    { name: 'WidgetTitle', control: 'Label@2.5.1', parent: 'WidgetGallery' },
  ]);
  assert.deepEqual(source.components, [{ name: 'FxHeader', definitionType: 'CanvasComponent', controls: [] }]);
  assert.deepEqual(source.dataSources, [
    { name: 'Widgets', kind: 'Table', table: 'fx_widget' },
    { name: 'InventedService', kind: 'Actions', connectorId: 'shared_fxinvented' },
  ]);
  assert.deepEqual(
    source.formulas.find((row) => row.property === 'Items'),
    {
      owner: 'HomeScreen.WidgetGallery',
      property: 'Items',
      text: '=Filter(Widgets, fx_name <> "")',
      source: 'Src/HomeScreen.pa.yaml',
      line: 10,
    },
  );
  assert.deepEqual(
    source.formulas.find((row) => row.property === 'Text'),
    {
      owner: 'HomeScreen.WidgetTitle',
      property: 'Text',
      text: '=ThisItem.fx_name',
      source: 'Src/HomeScreen.pa.yaml',
      line: 15,
    },
  );
  assert.deepEqual(
    source.formulas.find((row) => row.owner === 'App'),
    { owner: 'App', property: 'OnStart', text: '=Set(fxCounter, 1)', source: 'Src/App.pa.yaml', line: 3 },
  );
  assert.deepEqual(
    source.formulas.find((row) => row.property === 'OnSelect'),
    {
      owner: 'DetailScreen.SaveButton',
      property: 'OnSelect',
      text: '=Patch(Widgets, Defaults(Widgets), {fx_name: "x"})',
      source: 'Src/DetailScreen.pa.yaml',
      line: 7,
    },
  );
  assert.equal(source.formulas.length, 6);
}

test('canvas source inventories a two-screen app from an extracted directory', async (t) => {
  const source = await readCanvasSource({ dir: await dirOf(t, files), name: 'InventedCanvas', version: '1.0.0.1' });
  assert.deepEqual(source.app, { name: 'InventedCanvas', version: '1.0.0.1', schemaVersion: '3.0' });
  assertInventory(source);
});

test('canvas source inventories the same app from an in-memory msapp with backslash entry names', async () => {
  const zipped = msappOf(
    Object.fromEntries(Object.entries(files).map(([name, body]) => [name.replaceAll('/', '\\'), body])),
  );
  assertInventory(await readCanvasSource({ msapp: zipped, name: 'InventedCanvas' }));
});

test('canvas formulas are inventoried as text and never evaluated', async () => {
  const source = await readCanvasSource({
    msapp: msappOf({ 'Src/App.pa.yaml': 'App:\n  Properties:\n    OnStart: =globalThis.fxCanvasEvaluated = true\n' }),
  });
  assert.equal(globalThis.fxCanvasEvaluated, undefined);
  assert.equal(source.formulas[0].text, '=globalThis.fxCanvasEvaluated = true');
  assert.deepEqual(source.screens, []);
});

test('canvas source reads the retired fx.yaml format when no pa.yaml exists, and ignores it next to pa.yaml', async () => {
  const source = await readCanvasSource({
    msapp: msappOf({ 'Src/HomeScreen.fx.yaml': 'HomeScreen As screen:\n', 'CanvasManifest.json': '{}' }),
  });
  assert.deepEqual(
    source.diagnostics.map((item) => item.code),
    ['CANVAS_SOURCE_LEGACY_FXYAML'],
  );
  assert.deepEqual(source.screens, [{ name: 'HomeScreen', controls: [] }]);
  const mixed = await readCanvasSource({ msapp: msappOf({ ...files, 'Src/Old.fx.yaml': 'Old As screen:\n' }) });
  assert.deepEqual(
    mixed.diagnostics.map((item) => item.code),
    ['CANVAS_SOURCE_LEGACY_FXYAML'],
  );
  assert.ok(!mixed.screens.some((screen) => screen.name === 'Old'));
  const empty = await readCanvasSource({ msapp: msappOf({ 'Properties.json': '{}' }) });
  assert.deepEqual(
    empty.diagnostics.map((item) => item.code),
    ['CANVAS_SOURCE_NO_PAYAML'],
  );
});

test('canvas source reports unknown schema versions and top-level keys', async () => {
  const declared = await readCanvasSource({
    msapp: msappOf({
      'Src/App.pa.yaml': '# yaml-language-server: $schema=https://example.test/pa-yaml/v9.1/pa.schema.yaml\nApp: {}\n',
    }),
  });
  assert.deepEqual(
    declared.diagnostics.map((item) => item.code),
    ['CANVAS_SOURCE_SCHEMA_UNKNOWN'],
  );
  assert.equal(declared.app.schemaVersion, '9.1');
  const key = await readCanvasSource({ msapp: msappOf({ 'Src/App.pa.yaml': 'App: {}\nFxFuture: {}\n' }) });
  assert.equal(key.diagnostics[0].code, 'CANVAS_SOURCE_SCHEMA_UNKNOWN');
  assert.match(key.diagnostics[0].message, /FxFuture.*line 2/);
});

test('canvas source reports invalid YAML with file and line but no content', async () => {
  const secret = 'fxSecretFormulaText';
  const source = await readCanvasSource({
    msapp: msappOf({ 'Src/App.pa.yaml': `App:\n  Properties:\n    OnStart: ="${secret}\n  - broken: [\n` }),
  });
  assert.equal(source.diagnostics.length, 1);
  const [diagnostic] = source.diagnostics;
  assert.equal(diagnostic.code, 'CANVAS_SOURCE_YAML_INVALID');
  assert.equal(diagnostic.source, 'Src/App.pa.yaml');
  assert.match(diagnostic.message, /^Src\/App\.pa\.yaml: YAML parse error at line \d+ \(\w+\)\.$/);
  assert.doesNotMatch(JSON.stringify(source), new RegExp(secret));
});

test('canvas source reports an unreadable msapp archive', async () => {
  const source = await readCanvasSource({ msapp: Buffer.from('not a zip') });
  assert.deepEqual(
    source.diagnostics.map((item) => item.code),
    ['CANVAS_SOURCE_ARCHIVE_INVALID'],
  );
});

test('canvas inventory record of a parsed app is level behaviour with its control tree and data-source dependencies', async () => {
  const source = await readCanvasSource({ msapp: msappOf(files), name: 'fx_inventedcanvas_1a2b3', version: '1.0.0.3' });
  const record = canvasInventoryRecord(source, {
    solution: 'InventedCore',
    layer: 1,
    file: 'CanvasApps/fx_inventedcanvas_1a2b3.msapp',
    format: 'xml',
  });
  const { tree, ...rest } = record;
  assert.deepEqual(rest, {
    component: 'canvasapp',
    componentType: 300,
    id: null,
    name: 'fx_inventedcanvas_1a2b3',
    version: '1.0.0.3',
    solution: 'InventedCore',
    layer: 1,
    source: 'CanvasApps/fx_inventedcanvas_1a2b3.msapp',
    format: 'xml',
    dependencies: [
      { component: 'table', name: 'fx_widget' },
      { component: 'connector', name: 'shared_fxinvented' },
    ],
    level: 'behaviour',
    reason: null,
    unsupported: [],
  });
  assert.deepEqual(
    tree.screens.map((screen) => [screen.name, screen.controls.map((control) => control.name)]),
    [
      ['DetailScreen', ['SaveButton']],
      ['HomeScreen', ['WidgetGallery', 'WidgetTitle']],
    ],
  );
  const unread = canvasInventoryRecord(await readCanvasSource({ msapp: msappOf({ 'Properties.json': '{}' }) }));
  assert.deepEqual([unread.level, unread.reason, unread.tree], ['inventory', 'CANVAS_SOURCE_NO_PAYAML', undefined]);
});

test('canvas source lists controls the runtime does not host as unsupported', async () => {
  const screen =
    'Screens:\n  S:\n    Children:\n      - Chart1:\n          Control: PieChart@1.0.0\n      - Header1:\n          Control: CanvasComponent\n          ComponentName: FxHeader\n      - Title:\n          Control: Classic/TextInput@2.3.2\n';
  const record = canvasInventoryRecord(await readCanvasSource({ msapp: msappOf({ 'Src/S.pa.yaml': screen }) }));
  assert.deepEqual(record.unsupported, [
    { screen: 'S', name: 'Chart1', control: 'PieChart@1.0.0' },
    { screen: 'S', name: 'Header1', control: 'component FxHeader' },
  ]);
});

test('canvas source reads an fx.yaml app: properties, nested controls, quoted names and DataSources json', async () => {
  const app = 'App As appinfo:\n    OnStart: =Set(fxReady, true)\n';
  const home = [
    'HomeScreen As screen:',
    '    OnVisible: |-',
    '        =UpdateContext({fxSeen: true})',
    '',
    `    "'Widget List' As gallery.galleryVertical":`,
    '        Items: =Widgets',
    '',
    '        WidgetTitle As label:',
    '            Text: =ThisItem.fx_name',
    '',
    '    SearchBox As text:',
    '        Default: =""',
    '',
  ].join('\n');
  const source = await readCanvasSource({
    msapp: msappOf({
      'Src/App.fx.yaml': app,
      'Src/HomeScreen.fx.yaml': home,
      'DataSources/Widgets.json': JSON.stringify([
        { Name: 'Widgets', Type: 'NativeCDSDataSourceInfo', LogicalName: 'fx_widget' },
      ]),
    }),
    name: 'fx_legacy',
  });
  assert.equal(source.app.format, 'fx.yaml');
  assert.deepEqual(source.screens, [
    {
      name: 'HomeScreen',
      controls: [
        { name: 'Widget List', control: 'gallery.galleryVertical', parent: null },
        { name: 'WidgetTitle', control: 'label', parent: 'Widget List' },
        { name: 'SearchBox', control: 'text', parent: null },
      ],
    },
  ]);
  assert.deepEqual(source.dataSources, [{ name: 'Widgets', kind: 'Table', table: 'fx_widget' }]);
  assert.deepEqual(
    source.formulas.map((row) => [row.owner, row.property, row.text]),
    [
      ['App', 'OnStart', '=Set(fxReady, true)'],
      ['HomeScreen', 'OnVisible', '=UpdateContext({fxSeen: true})'],
      ['HomeScreen.Widget List', 'Items', '=Widgets'],
      ['HomeScreen.WidgetTitle', 'Text', '=ThisItem.fx_name'],
      ['HomeScreen.SearchBox', 'Default', '=""'],
    ],
  );
  assert.deepEqual(canvasInventoryRecord(source).unsupported, []);
});

test('canvas source inventories an msapp without inflating its large media entries', async () => {
  const media = 'Assets/Images/fx_large.png';
  const zipped = writeSolutionAssetEntries([
    ...Object.entries(files).map(([name, body]) => ({ name, data: Buffer.from(body) })),
    { name: media, data: randomBytes(4 * 1024 * 1024) },
  ]);
  // A flipped media byte fails any inflate/CRC of that entry; the inventory still succeeds because it is never read.
  zipped[zipped.indexOf(Buffer.from(media)) + media.length + 2048] ^= 0xff;
  assertInventory(await readCanvasSource({ msapp: zipped, name: 'InventedCanvas' }));
});

test('partial canvas source cannot claim complete app or rendering coverage', async () => {
  const { canvasRequirementRows } = await import('../lib/source-graph.mjs');
  for (const broken of [
    'Screens: [',
    '# $schema=https://powerapps.com/schemas/pa-yaml/v9.1/pa.schema.json\nApp: {}\n',
  ]) {
    const source = await readCanvasSource({
      msapp: msappOf({ 'Src/HomeScreen.pa.yaml': HOME, 'Src/App.pa.yaml': broken }),
      name: 'partial',
    });
    assert.equal(source.screens.length, 1);
    const record = canvasInventoryRecord(source);
    assert.equal(record.level, 'behaviour'); // Parsed screens remain available for inspection.
    assert.equal(record.sourceDiagnostics.length, 1);
    const rows = canvasRequirementRows([record]);
    assert.equal(rows.find((row) => row.id === 'canvas:app/partial').status, 'unsupported');
    assert.equal(rows.find((row) => row.id === 'canvas:app/partial').reason, record.sourceDiagnostics[0].code);
    assert.equal(rows.find((row) => row.id === 'canvas:rendering').status, 'unsupported');
  }
  const unreadable = canvasInventoryRecord(
    await readCanvasSource({ msapp: Buffer.from('invalid'), name: 'unreadable' }),
  );
  const row = canvasRequirementRows([unreadable]).find((item) => item.id === 'canvas:app/unreadable');
  assert.equal(row.status, 'unsupported');
  assert.equal(row.reason, 'CANVAS_SOURCE_ARCHIVE_INVALID');
});

test('Solution canvas inventory retains partial source coverage diagnostics', async () => {
  const { canvasMsappRecord } = await import('../lib/solution-inventory.mjs');
  const { canvasRequirementRows } = await import('../lib/source-graph.mjs');
  const record = await canvasMsappRecord(msappOf({ 'Src/HomeScreen.pa.yaml': HOME, 'Src/App.pa.yaml': 'App: [' }), {
    name: 'partial',
  });
  assert.equal(record.sourceDiagnostics[0].code, 'CANVAS_SOURCE_YAML_INVALID');
  assert.equal(canvasRequirementRows([record]).find((row) => row.id === 'canvas:rendering').status, 'unsupported');
});

test('malformed canvas structures and duplicate screen definitions cannot claim complete coverage', async () => {
  const { canvasRequirementRows } = await import('../lib/source-graph.mjs');
  for (const [extra, code] of [
    [{ 'Src/Broken.pa.yaml': 'Screens:\n  Other:\n    Children: not-a-sequence\n' }, 'CANVAS_SOURCE_STRUCTURE_INVALID'],
    [{ 'Src/Other.pa.yaml': 'Screens:\n  HomeScreen:\n    Children: []\n' }, 'CANVAS_SOURCE_STRUCTURE_INVALID'],
    [{ 'Src/Broken.pa.yaml': 'App:\n  Properties: not-a-map\n' }, 'CANVAS_SOURCE_STRUCTURE_INVALID'],
    [{ 'Src/Broken.pa.yaml': 'ComponentDefinitions:\n  Widget: invalid\n' }, 'CANVAS_SOURCE_STRUCTURE_INVALID'],
    [{ 'Src/Broken.pa.yaml': 'Screens:\n  Other:\n    Children: [invalid]\n' }, 'CANVAS_SOURCE_STRUCTURE_INVALID'],
    [
      {
        'Src/Broken.pa.yaml':
          'Screens:\n  Other:\n    Children:\n      - Same: { Control: Label }\n      - same: { Control: Label }\n',
      },
      'CANVAS_SOURCE_STRUCTURE_INVALID',
    ],
    [
      { 'Src/Broken.pa.yaml': 'Screens:\n  Other:\n    Children:\n      - WidgetTitle: { Control: Label }\n' },
      'CANVAS_SOURCE_NAME_COLLISION',
    ],
    [
      {
        'Src/Component/Widget.pa.yaml':
          'ComponentDefinitions:\n  Widget:\n    DefinitionType: CanvasComponent\n    Children:\n      - WidgetTitle: { Control: Label }\n',
      },
      'CANVAS_SOURCE_NAME_COLLISION',
    ],
    [
      { 'Src/Broken.pa.yaml': 'Screens:\n  Other:\n    Children:\n      - HomeScreen: { Control: Label }\n' },
      'CANVAS_SOURCE_NAME_COLLISION',
    ],
  ]) {
    const source = await readCanvasSource({
      msapp: msappOf({ 'Src/HomeScreen.pa.yaml': HOME, ...extra }),
      name: 'partial',
    });
    const record = canvasInventoryRecord(source);
    assert.ok(record.sourceDiagnostics?.some((diagnostic) => diagnostic.code === code));
    const rows = canvasRequirementRows([record]);
    assert.equal(rows.find((row) => row.id === 'canvas:app/partial').status, 'unsupported');
    assert.equal(rows.find((row) => row.id === 'canvas:rendering').status, 'unsupported');
  }
});

test('normal data source and component mappings remain readable', async () => {
  const source = await readCanvasSource({ msapp: msappOf(files) });
  assert.ok(!source.diagnostics.some((item) => item.code === 'CANVAS_SOURCE_STRUCTURE_INVALID'));
  assert.deepEqual(
    source.dataSources.map((item) => item.name),
    ['Widgets', 'InventedService'],
  );
  assert.deepEqual(
    source.components.map((item) => item.name),
    ['FxHeader'],
  );
});

test('legacy cross-screen name collisions refuse a cyclic runtime before starting', async () => {
  const source = await readCanvasSource({
    msapp: msappOf({
      'Src/App.fx.yaml': 'App As appinfo:\n  OnStart: =Set(started, true)\n',
      'Src/One.fx.yaml': 'One As screen:\n  A As groupContainer:\n    B As label:\n      Text: ="one"\n',
      'Src/Two.fx.yaml': 'Two As screen:\n  B As groupContainer:\n    A As label:\n      Text: ="two"\n',
    }),
    name: 'legacy',
  });
  assert.ok(source.diagnostics.some((item) => item.code === 'CANVAS_SOURCE_NAME_COLLISION'));
  const { createCanvasApp } = await import('../lib/canvas-runtime.mjs');
  const { createPowerFxEvaluator } = await import('../lib/canvas-power-fx.mjs');
  assert.throws(() => createCanvasApp({ app: { uniqueName: 'legacy', source }, evaluator: createPowerFxEvaluator() }), {
    code: 'CanvasSourceNameCollision',
    status: 501,
  });
});
