import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { writeSolutionAssetEntries } from '../lib/dataverse-solution-assets.mjs';
import {
  scanSolutionSources,
  buildSolutionSchema,
  classifySolutionPath,
  readSolutionZip,
  parseSchemaDocument,
} from '../lib/solution-schema.mjs';
import { importSolutionData, applySolutionData } from '../lib/solution-data.mjs';
import { SolutionFileCache } from '../lib/solution-cache.mjs';
import {
  INVENTORY_FOLDERS,
  inventoryEntry,
  mergeInventory,
  mergeCanvasLayers,
  canvasMsappRecord,
} from '../lib/solution-inventory.mjs';
import { buildSourceGraph } from '../lib/source-graph.mjs';
import { settleFileTimes } from './support/file-times.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const CONNECTOR_ID = '77777777-7777-4777-8777-777777777772';
const BPF_ID = '77777777-7777-4777-8777-777777777773';
const VIEW_ID = '77777777-7777-4777-8777-777777777774';
const CHART_ID = '77777777-7777-4777-8777-777777777775';

const PA_YAML = [
  'App:',
  '  Properties:',
  '    OnStart: =Set(fxCounter, 1)',
  'DataSources:',
  '  Items:',
  '    Type: Table',
  '    Parameters:',
  '      TableLogicalName: x_item',
  '',
].join('\n');
const SCREEN = 'Screens:\n  HomeScreen:\n    Properties:\n      Fill: =Color.White\n';
const msapp = () =>
  writeSolutionAssetEntries([
    { name: 'Src/App.pa.yaml', data: Buffer.from(PA_YAML) },
    { name: 'Src/HomeScreen.pa.yaml', data: Buffer.from(SCREEN) },
  ]);

test('canvas payload layers replace source coverage diagnostics, while metadata preserves them', async () => {
  const partialBytes = writeSolutionAssetEntries([
    { name: 'Src/App.pa.yaml', data: Buffer.from('App: [') },
    { name: 'Src/HomeScreen.pa.yaml', data: Buffer.from(SCREEN) },
  ]);
  const partial = await canvasMsappRecord(partialBytes, { name: 'x_app' });
  const valid = await canvasMsappRecord(msapp(), { name: 'x_app' });
  const metadata = { component: 'canvasapp', name: 'x_app', level: 'inventory', dependencies: [] };
  for (const [first, latest, status] of [
    [partial, valid, 'satisfied'],
    [valid, partial, 'unsupported'],
  ]) {
    const [record] = mergeCanvasLayers([first, latest, metadata]);
    assert.deepEqual(record.sourceDiagnostics, latest.sourceDiagnostics);
    const graph = buildSourceGraph({ scan: { inventory: [record] } });
    for (const id of ['canvas:app/x_app', 'canvas:rendering'])
      assert.equal(graph.requirements().find((row) => row.id === id).status, status);
  }
});

test('canvas metadata and payload fidelity agree through either order and metadata-only layers', async () => {
  const payload = await canvasMsappRecord(msapp(), { name: 'x_app' });
  const metadata = {
    component: 'canvasapp',
    level: 'inventory',
    reason: 'CANVAS_HOST_NOT_IMPLEMENTED',
    name: 'x_app',
    id: 'app-id',
    dependencies: [],
  };
  for (const records of [
    [metadata, payload],
    [payload, metadata],
  ]) {
    const [record] = mergeInventory(records);
    assert.equal(record.level, 'behaviour');
    assert.equal(record.reason, null);
    assert.equal(record.id, 'app-id');
    assert.equal(record.tree.screens.length, 1);
    const layered = mergeCanvasLayers([
      { ...record, displayName: 'Before', layer: 0, solution: 'Base', source: 'base/app.msapp' },
      {
        ...metadata,
        displayName: 'Latest metadata',
        layer: 1,
        solution: 'Extension',
        source: 'extension/app.meta.xml',
      },
    ]);
    assert.equal(layered.length, 1);
    assert.equal(layered[0].level, 'behaviour');
    assert.equal(layered[0].displayName, 'Latest metadata');
    const graph = buildSourceGraph({ scan: { inventory: layered } });
    const app = graph.resolve('canvasapp', 'x_app');
    assert.equal(app.variants, 2, 'Effective payload merging retains the selected layer contributions.');
    assert.deepEqual(app.contributions, [
      { layer: 0, solution: 'Base', source: 'base/app.msapp' },
      { layer: 1, solution: 'Extension', source: 'extension/app.meta.xml' },
    ]);
    assert.deepEqual(app.sources, ['base/app.msapp', 'extension/app.meta.xml']);
    assert.ok(graph.requirements().some((row) => row.id === 'canvas:app/x_app' && row.status === 'satisfied'));
    assert.ok(!graph.requirements().some((row) => row.reason === 'CANVAS_HOST_NOT_IMPLEMENTED'));
    assert.ok(graph.requirements().some((row) => row.reason === 'CANVAS_RENDERING_BASELINE'));
  }
  const broken = await canvasMsappRecord(Buffer.from('invalid'), { name: 'x_app' });
  const [failed] = mergeInventory([payload, broken, metadata]);
  assert.equal(failed.level, 'inventory');
  assert.ok(failed.reason);
  assert.equal(failed.tree, undefined);
  const oversized = await canvasMsappRecord(Buffer.from('x'), { name: 'x_app', size: 100_000_000 });
  const [bounded] = mergeCanvasLayers([payload, oversized, metadata]);
  assert.equal(bounded.level, 'inventory');
  assert.equal(bounded.tree, undefined, 'An oversized newer payload cannot keep older executable logic.');
  assert.equal(bounded.canvas, undefined);
  assert.ok(bounded.diagnostics.some((diagnostic) => diagnostic.code === 'SOLUTION_CANVAS_MSAPP_TOO_LARGE'));
});

const SOLUTION_XML = `<ImportExportXml><SolutionManifest><UniqueName>InventedInventory</UniqueName><Version>1.2.0.0</Version>
<RootComponents><RootComponent type="300" schemaName="x_inventedapp_1a2b3" behavior="0"/><RootComponent type="20" schemaName="x_absentrole" behavior="0"/></RootComponents>
<MissingDependencies><MissingDependency><Required type="1" schemaName="x_external" displayName="External"/><Dependent type="300" schemaName="x_inventedapp_1a2b3" displayName="Invented app"/></MissingDependency></MissingDependencies>
</SolutionManifest></ImportExportXml>`;
const CANVAS_REFERENCES = JSON.stringify({
  one: {
    id: '/providers/Microsoft.PowerApps/apis/shared_fxinvented',
    connectionReferenceLogicalName: 'x_sharedinvented',
  },
});
const DATABASE_REFERENCES = JSON.stringify({
  'default.cds': { dataSources: { Items: { entitySetName: 'x_items', logicalName: 'x_item' } } },
});
const CUSTOMIZATIONS = `<ImportExportXml><Entities/>
<Workflows><Workflow WorkflowId="{${BPF_ID}}" Name="Invented process"><Category>4</Category><PrimaryEntity>x_item</PrimaryEntity></Workflow>
<Workflow WorkflowId="{77777777-7777-4777-8777-777777777776}" Name="Invented classic"><Category>0</Category></Workflow></Workflows>
<FieldSecurityProfiles><FieldSecurityProfile fieldsecurityprofileid="{77777777-7777-4777-8777-777777777777}" name="Invented profile"/></FieldSecurityProfiles>
<Dashboards><Dashboard><FormId>{77777777-7777-4777-8777-77777777777a}</FormId><LocalizedNames><LocalizedName description="Invented dashboard" languagecode="1033"/></LocalizedNames>
<FormXml><forms><systemform><form><tabs><tab><columns><column><sections><section><rows><row><cell><control><parameters><ViewId>{${VIEW_ID}}</ViewId><VisualizationId>{${CHART_ID}}</VisualizationId></parameters></control></cell></row></rows></section></sections></column></columns></tab></tabs></form></systemform></forms></FormXml></Dashboard></Dashboards>
<WebResources><WebResource><WebResourceId>{77777777-7777-4777-8777-77777777777b}</WebResourceId><Name>x_/page.html</Name><WebResourceType>1</WebResourceType></WebResource>
<WebResource><WebResourceId>{77777777-7777-4777-8777-77777777777c}</WebResourceId><Name>x_/script.js</Name><WebResourceType>3</WebResourceType></WebResource></WebResources>
<CanvasApps><CanvasApp><Name>x_inventedapp_1a2b3</Name><AppVersion>2026-01-01T00:00:00Z</AppVersion><DisplayName>Invented app</DisplayName>
<ConnectionReferences>${CANVAS_REFERENCES}</ConnectionReferences><DatabaseReferences>${DATABASE_REFERENCES}</DatabaseReferences></CanvasApp></CanvasApps>
<Connectors><Connector><connectorid>{${CONNECTOR_ID}}</connectorid><name>x_InventedConnector</name><displayname>Invented connector</displayname></Connector></Connectors>
<connectionreferences><connectionreference connectionreferencelogicalname="x_sharedinvented"><connectionreferencedisplayname>Invented reference</connectionreferencedisplayname>
<connectorid>/providers/Microsoft.PowerApps/apis/shared_fxinvented</connectorid></connectionreference></connectionreferences><Languages/></ImportExportXml>`;
const ENTITY =
  '<Entity><Name>x_item</Name><EntityInfo><entity Name="x_item"><EntitySetName>x_items</EntitySetName><PrimaryIdAttribute>x_itemid</PrimaryIdAttribute><attributes><attribute PhysicalName="x_itemid"><Name>x_itemid</Name><Type>primarykey</Type></attribute></attributes></entity></EntityInfo></Entity>';
const OPENAPI = JSON.stringify({
  swagger: '2.0',
  info: { title: 'Invented connector', 'x-ms-api-annotation': {} },
  host: 'invented.example.test',
  paths: {
    '/widgets': {
      get: { operationId: 'ListWidgets', 'x-ms-pageable': { nextLinkName: 'next' } },
      post: { operationId: 'CreateWidget' },
    },
    '/widgets/{id}': { get: { operationId: 'GetWidget', 'x-ms-visibility': 'important' } },
  },
  'x-ms-connector-metadata': [],
});

const CLASSIC = {
  'Other/Solution.xml': SOLUTION_XML,
  'Other/Customizations.xml': CUSTOMIZATIONS,
  'Entities/x_item/Entity.xml': ENTITY,
  'Entities/x_item/Visualizations/{77777777-7777-4777-8777-777777777775}.xml': `<visualization><savedqueryvisualizationid>{${CHART_ID}}</savedqueryvisualizationid><primaryentitytypecode>x_item</primaryentitytypecode><LocalizedNames><LocalizedName description="Invented chart" languagecode="1033"/></LocalizedNames></visualization>`,
  'CanvasApps/x_inventedapp_1a2b3.meta.xml':
    '<CanvasApp><Name>x_inventedapp_1a2b3</Name><DisplayName>Invented app</DisplayName></CanvasApp>',
  'CanvasApps/x_inventedapp_1a2b3_DocumentUri.msapp': msapp(),
  'CanvasApps/x_inventedapp_1a2b3_BackgroundImageUri': 'not a component file',
  'Connectors/x_InventedConnector_openapidefinition.json': OPENAPI,
  'Connectors/x_InventedConnector_policytemplateinstances.json': JSON.stringify([
    { templateId: 'routerequesttoendpoint' },
  ]),
  'Roles/Invented Role.xml':
    '<Role id="{77777777-7777-4777-8777-77777777777d}" name="Invented Role"><RolePrivileges/></Role>',
  'AppActions/x_fxcommand/appaction.xml':
    '<appaction uniquename="x_fxcommand"><name>Invented command</name><visibilityformula>=Self.Selected.Item.x_name &lt;&gt; ""</visibilityformula></appaction>',
  'Reports/Invented.rdl.data.xml':
    '<Report><ReportId>{77777777-7777-4777-8777-77777777777e}</ReportId><Name>Invented report</Name></Report>',
};

async function writeTree(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
}
async function tempDir(t) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'solution-inventory-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
const byKey = (records) => Object.fromEntries(records.map((record) => [`${record.component}:${record.name}`, record]));

test('inventory folders are classified, existing kinds keep precedence and web resources stay unclassified', () => {
  assert.deepEqual(classifySolutionPath('CanvasApps/x_app_DocumentUri.msapp'), {
    kind: 'inventory',
    component: 'canvasapp',
    componentName: 'x_app',
  });
  assert.deepEqual(classifySolutionPath('canvasapps/x_app/x_app.msapp'), {
    kind: 'inventory',
    component: 'canvasapp',
    componentName: 'x_app',
  });
  assert.deepEqual(classifySolutionPath('Entities/x_item/Visualizations/a.xml'), {
    kind: 'inventory',
    component: 'chart',
    componentName: 'a',
  });
  assert.equal(classifySolutionPath('Visualizations/a.xml'), null);
  assert.equal(classifySolutionPath('CanvasApps/x_app_BackgroundImageUri'), null);
  assert.equal(classifySolutionPath('WebResources/script.js'), null);
  assert.equal(classifySolutionPath('Controls/x_ns.Control/bundle.js'), null);
  assert.equal(classifySolutionPath('Controls/x_ns.Control/ControlManifest.xml').component, 'customcontrol');
  assert.deepEqual(classifySolutionPath('AppModules/CanvasApps/a.xml'), { kind: 'app' });
  assert.deepEqual(classifySolutionPath('environmentvariabledefinitions/environment_variable_values.json'), {
    kind: 'envvalue',
    envDir: 'environmentvariabledefinitions',
  });
  for (const row of INVENTORY_FOLDERS)
    assert.ok(row.componentType === null || Number.isInteger(row.componentType), row.component);
});

test('an unpacked classic Solution lists every inventory component with dependencies and never materialises rows', async (t) => {
  const root = await tempDir(t);
  await writeTree(root, CLASSIC);
  const scan = await scanSolutionSources([root]);
  const records = byKey(scan.inventory);

  const canvas = records['canvasapp:x_inventedapp_1a2b3'];
  assert.equal(canvas.componentType, 300);
  assert.equal(canvas.solution, 'InventedInventory');
  assert.equal(canvas.layer, 0);
  assert.equal(canvas.format, 'xml');
  assert.equal(canvas.level, 'behaviour');
  assert.equal(canvas.reason, null);
  assert.equal(canvas.version, '2026-01-01T00:00:00Z');
  assert.equal(canvas.root, true);
  assert.equal(canvas.msapp.size, CLASSIC['CanvasApps/x_inventedapp_1a2b3_DocumentUri.msapp'].length);
  assert.deepEqual(canvas.canvas.screens, ['HomeScreen']);
  assert.ok(canvas.canvas.formulas.some((formula) => formula.text === '=Set(fxCounter, 1)'));
  for (const dependency of [
    { component: 'connectionreference', name: 'x_sharedinvented' },
    { component: 'table', name: 'x_item' },
  ])
    assert.ok(
      canvas.dependencies.some((item) => item.component === dependency.component && item.name === dependency.name),
      JSON.stringify(dependency),
    );
  // Customizations.xml and the .msapp source both name the table; the merged record carries it once.
  assert.equal(canvas.dependencies.filter((item) => item.name === 'x_item').length, 1);
  assert.ok(canvas.dependencies.some((item) => item.name === 'x_external' && item.missing === true));

  const connector = records['connector:x_InventedConnector'];
  assert.equal(connector.componentType, 371);
  assert.equal(connector.id, CONNECTOR_ID);
  assert.deepEqual(connector.openapi.operations, ['CreateWidget', 'GetWidget', 'ListWidgets']);
  assert.deepEqual(connector.openapi.extensions, [
    'x-ms-api-annotation',
    'x-ms-connector-metadata',
    'x-ms-pageable',
    'x-ms-visibility',
  ]);
  assert.equal(connector.openapi.title, 'Invented connector');
  assert.deepEqual(connector.policies, ['routerequesttoendpoint']);

  const reference = records['connectionreference:x_sharedinvented'];
  assert.equal(reference.level, 'behaviour');
  assert.deepEqual(reference.dependencies, [{ component: 'connector', name: 'shared_fxinvented' }]);
  assert.equal(records['businessprocessflow:Invented process'].id, BPF_ID);
  assert.deepEqual(records['businessprocessflow:Invented process'].dependencies, [
    { component: 'table', name: 'x_item' },
  ]);
  assert.equal(records['businessprocessflow:Invented classic'], undefined);
  assert.deepEqual(records['dashboard:Invented dashboard'].dependencies, [
    { component: 'view', name: VIEW_ID },
    { component: 'chart', name: CHART_ID },
  ]);
  assert.equal(records['chart:Invented chart'].id, CHART_ID);
  assert.equal(records['webresource:x_/page.html'].webResourceType, 1);
  assert.equal(records['webresource:x_/script.js'], undefined);
  assert.equal(records['fieldsecurityprofile:Invented profile'].componentType, 70);
  assert.equal(records['role:Invented Role'].componentType, 20);
  // Read role and profile definitions are imported into the security tables; a manifest-only role stays inventory.
  assert.deepEqual([records['role:Invented Role'].level, records['role:Invented Role'].privileges], ['behaviour', []]);
  assert.deepEqual(
    [
      records['fieldsecurityprofile:Invented profile'].level,
      records['fieldsecurityprofile:Invented profile'].permissions,
    ],
    ['behaviour', []],
  );
  assert.deepEqual(
    [records['role:x_absentrole'].level, records['role:x_absentrole'].reason],
    ['inventory', 'ROLE_NOT_IMPORTED'],
  );
  assert.equal(records['role:x_absentrole'].sourceMissing, true);
  assert.equal(records['report:Invented report'].componentType, 31);
  const command = records['appaction:x_fxcommand'];
  assert.equal(command.level, 'inventory');
  assert.deepEqual(command.formulas, [{ property: 'visibilityformula', text: '=Self.Selected.Item.x_name <> ""' }]);

  // One diagnostic per inventory-level component kind; the generic ones carry their component.
  const codes = scan.diagnostics.filter((item) => item.inventory).map((item) => `${item.code}:${item.component ?? ''}`);
  assert.deepEqual(
    codes.filter((code) => codes.indexOf(code) !== codes.lastIndexOf(code)),
    [],
  );
  // The connector's OpenAPI definition compiles without diagnostics: it runs at contract, so it is not an inventory kind.
  assert.ok(!codes.includes('SOLUTION_CONNECTOR_INVENTORY:connector'));
  for (const code of [
    'SOLUTION_BPF_INVENTORY:businessprocessflow',
    'SOLUTION_DASHBOARD_INVENTORY:dashboard',
    'SOLUTION_CHART_INVENTORY:chart',
    'SOLUTION_WEBRESOURCE_INVENTORY:webresource',
    'SOLUTION_APPACTION_INVENTORY:appaction',
    'SOLUTION_COMPONENT_INVENTORY:role',
    'SOLUTION_COMPONENT_INVENTORY:report',
  ])
    assert.ok(codes.includes(code), code);
  assert.ok(!codes.includes('SOLUTION_COMPONENT_INVENTORY:fieldsecurityprofile'));
  assert.ok(!codes.some((code) => code.startsWith('SOLUTION_CANVAS_MSAPP_MISSING')));

  // Nothing listed here becomes a table or a row; only the Solution's connection reference is seeded (behaviour).
  const data = await importSolutionData([root], { scan });
  assert.deepEqual(Object.keys(data.mappings), ['x_item']);
  const state = applySolutionData({ mappings: {}, tables: {}, simulator: {} }, data);
  assert.deepEqual(Object.keys(state.tables).sort(), ['connectionreference', 'x_item']);
  for (const name of [
    'canvasapp',
    'connector',
    'role',
    'systemform',
    'savedqueryvisualization',
    'appaction',
    'workflow',
    'report',
    'fieldsecurityprofile',
  ])
    assert.equal(state.mappings[name], undefined, name);
});

test('a Solution ZIP keeps .msapp entries as name and size and inventories the canvas app from them', async (t) => {
  const root = await tempDir(t);
  const archive = path.join(root, 'invented.zip');
  await fs.writeFile(
    archive,
    writeSolutionAssetEntries(
      Object.entries({ ...CLASSIC, 'CanvasApps/x_app_DocumentUri.msapp': msapp() }).map(([name, content]) => ({
        name,
        data: Buffer.from(content),
      })),
    ),
  );
  const entries = readSolutionZip(await fs.readFile(archive));
  const entry = entries.find((item) => item.name === 'CanvasApps/x_app_DocumentUri.msapp');
  assert.equal(entry.size, msapp().length);
  assert.equal(entry.xml, undefined);
  assert.equal(entry.componentName, 'x_app');
  // A binary entry is never parsed as XML: it becomes the canvas app's inventory record only.
  const parsed = parseSchemaDocument(entry.xml, entry);
  assert.deepEqual(
    [parsed.entities, parsed.inventory.map((item) => [item.component, item.name, item.msapp])],
    [[], [['canvasapp', 'x_app', { size: entry.size }]]],
  );
  assert.deepEqual(
    inventoryEntry(entry.name, { size: entry.size, component: 'canvasapp', componentName: 'x_app' })[0].msapp,
    { size: entry.size },
  );

  const scan = await scanSolutionSources([archive]);
  const records = byKey(scan.inventory);
  assert.deepEqual(records['canvasapp:x_app'].canvas.screens, ['HomeScreen']);
  assert.equal(records['canvasapp:x_app'].msapp.size, msapp().length);
  assert.match(records['canvasapp:x_app'].source, /invented\.zip!\/CanvasApps\/x_app_DocumentUri\.msapp$/);
  assert.deepEqual(records['connector:x_InventedConnector'].openapi.operations, [
    'CreateWidget',
    'GetWidget',
    'ListWidgets',
  ]);
});

test('a YAML source-control repository is detected, imports its tables and environment variables and lists inventory', async (t) => {
  const root = await tempDir(t);
  await writeTree(root, {
    'solutions/InventedYaml/solution.yml': 'SolutionManifest:\n  UniqueName: InventedYaml\n  Version: 3.0.0.1\n',
    // solutioncomponents.yml lists every component path of the solution.
    'solutions/InventedYaml/solutioncomponents.yml': [
      'canvasapps/x_yamlapp',
      'modernflows/x_yamlflow',
      'connectionreferences/x_yamlref',
      'entities/x_item',
      'environmentvariabledefinitions/x_Url',
    ]
      .map((entry) => `- Path: ${entry}\n`)
      .join(''),
    'publishers/InventedPublisher/publisher.yml':
      'Publisher:\n  UniqueName: inventedpublisher\n  CustomizationPrefix: x\n',
    'canvasapps/x_yamlapp/x_yamlapp.msapp': msapp(),
    'modernflows/x_yamlflow/x_yamlflow.json': JSON.stringify({
      properties: { connectionReferences: { one: { connection: { connectionReferenceLogicalName: 'x_yamlref' } } } },
    }),
    'connectionreferences/x_yamlref/connectionreference.yml':
      'connectionreferencelogicalname: x_yamlref\nconnectorid: /providers/Microsoft.PowerApps/apis/shared_fxyaml\n',
    'entities/x_item/entity.yml': 'Name: x_item\n',
    'environmentvariabledefinitions/x_Url/environmentvariabledefinition.xml':
      '<environmentvariabledefinition schemaname="x_Url"><type>100000000</type><defaultvalue>https://invented.example.test</defaultvalue></environmentvariabledefinition>',
  });
  const scan = await scanSolutionSources([root]);
  assert.equal(scan.layers.length, 1);
  assert.equal(scan.layers[0].format, 'yaml');
  assert.equal(scan.layers[0].name, 'InventedYaml');
  assert.equal(scan.layers[0].loose, false);
  // YAML tables load through the YAML adapter (solution-yaml.mjs): the layer is not empty.
  assert.ok(!scan.diagnostics.some((item) => item.code === 'SOLUTION_YAML_EMPTY'));
  const records = byKey(scan.inventory);
  assert.equal(records['canvasapp:x_yamlapp'].format, 'yaml');
  assert.deepEqual(records['canvasapp:x_yamlapp'].canvas.screens, ['HomeScreen']);
  assert.deepEqual(records['modernflow:x_yamlflow'].dependencies, [
    { component: 'connectionreference', name: 'x_yamlref' },
  ]);
  assert.equal(
    records['connectionreference:x_yamlref'].connectorId,
    '/providers/Microsoft.PowerApps/apis/shared_fxyaml',
  );
  const schema = buildSolutionSchema(scan);
  assert.equal(schema.tables.x_item.origin, 'solution');
  // Modern flows stay inventory with their diagnostic: the modernflows/ file shape is not documented.
  assert.equal(records['modernflow:x_yamlflow'].level, 'inventory');
  assert.ok(scan.diagnostics.some((item) => item.code === 'SOLUTION_MODERNFLOW_INVENTORY'));
  assert.equal(schema.environmentVariables[0].schemaName, 'x_Url');
  assert.deepEqual(
    schema.connectionReferences.map((reference) => reference.logicalName),
    ['x_yamlref'],
  );
});

test('inventory keeps solution cache reuse: an unchanged rescan only hits and an unchanged previous scan is returned', async (t) => {
  // The reuse assertions below concern files written moments ago.
  settleFileTimes(t);
  const root = await tempDir(t);
  await writeTree(root, CLASSIC);
  const cacheFile = path.join(root, '.paqvilo', 'solution-cache.json');
  const first = await scanSolutionSources([root], { cacheFile });
  await first.cache.save();
  assert.ok(first.cache.stats.misses > 0);
  assert.ok(first.diagnostics.some((item) => item.inventory));
  assert.equal(await scanSolutionSources([root], { previous: first }), first);
  const cache = await SolutionFileCache.open(cacheFile);
  const second = await scanSolutionSources([root], { cache });
  assert.deepEqual(second.cache.stats, { hits: first.cache.stats.misses, misses: 0 });
  assert.deepEqual(second.inventory, first.inventory);
});

test('a corrupted .msapp in a Solution ZIP reports SOLUTION_INVENTORY_READ_FAILED and keeps the rest of the archive', async (t) => {
  const root = await tempDir(t);
  const name = 'CanvasApps/x_app_DocumentUri.msapp',
    inner = 'Assets/fx_noise.bin';
  // Mostly random bytes keep the outer entry stored, so a flipped byte reaches only the CRC check.
  const payload = writeSolutionAssetEntries([
    { name: 'Src/App.pa.yaml', data: Buffer.from(PA_YAML) },
    { name: inner, data: randomBytes(64 * 1024) },
  ]);
  const zip = writeSolutionAssetEntries(
    Object.entries({ ...CLASSIC, [name]: payload }).map(([entry, content]) => ({
      name: entry,
      data: Buffer.from(content),
    })),
  );
  for (const [label, corrupt] of [
    [
      'payload byte',
      (bytes) => {
        bytes[bytes.indexOf(Buffer.from(inner)) + inner.length + 4096] ^= 0xff;
      },
    ],
    [
      'local header signature',
      (bytes) => {
        bytes.writeUInt32LE(0, bytes.indexOf(Buffer.from(name)) - 30);
      },
    ],
  ]) {
    const archive = path.join(root, `${label.replaceAll(' ', '-')}.zip`),
      bytes = Buffer.from(zip);
    corrupt(bytes);
    await fs.writeFile(archive, bytes);
    const scan = await scanSolutionSources([archive]);
    const records = byKey(scan.inventory);
    assert.deepEqual(
      records['canvasapp:x_app'].diagnostics.map((item) => item.code),
      ['SOLUTION_INVENTORY_READ_FAILED'],
      label,
    );
    assert.equal(records['canvasapp:x_app'].msapp.size, payload.length, label);
    assert.ok(records['connector:x_InventedConnector'], label);
    assert.ok(
      scan.diagnostics.some((item) => item.code === 'SOLUTION_INVENTORY_READ_FAILED' && item.name === 'x_app'),
      label,
    );
  }
});

test('a compiled connector rises to contract; a blocking compilation diagnostic is an error its preflight row names', () => {
  const openapi = JSON.stringify({
    swagger: '2.0',
    info: { title: 'Invented' },
    host: 'api.example.test',
    basePath: '/v1',
    schemes: ['https'],
    paths: {
      '/items/{id}': {
        get: {
          operationId: 'GetItem',
          parameters: [{ name: 'id', in: 'path', required: true, type: 'string' }],
          responses: { 200: { description: 'ok' } },
        },
      },
    },
  });
  const entry = (name, file, text) =>
    inventoryEntry(`Connectors/${name}/${file}`, {
      size: text.length,
      text,
      component: 'connector',
      componentName: name,
    });
  const [ok] = mergeInventory(entry('x_fxok', 'x_fxok_openapidefinition.json', openapi));
  assert.deepEqual([ok.level, ok.reason], ['contract', 'CONNECTOR_COMPILED_CONTRACT']);
  const policy = JSON.stringify([
    {
      templateId: 'setqueryparameter',
      parameters: {
        'x-ms-apimTemplateParameter.name': 'x-out',
        'x-ms-apimTemplateParameter.value': 'v',
        'x-ms-apimTemplate-policySection': 'Response',
      },
    },
  ]);
  const [bad] = mergeInventory([
    ...entry('x_fxbad', 'x_fxbad_openapidefinition.json', openapi),
    ...entry('x_fxbad', 'x_fxbad_policytemplateinstances.json', policy),
  ]);
  assert.deepEqual(
    [bad.level, bad.diagnostics.map((item) => [item.code, item.severity])],
    ['inventory', [['CONNECTOR_POLICY_UNSUPPORTED', 'error']]],
  );
  const rows = buildSourceGraph({ scan: { inventory: [ok, bad] } }).requirements();
  assert.deepEqual(
    rows.map((row) => [row.id, row.status, row.reason]),
    [['connector:x_fxbad', 'unsupported', 'CONNECTOR_POLICY_UNSUPPORTED']],
  );
});
