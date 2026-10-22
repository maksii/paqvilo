import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadSourceGraph } from '../api.mjs';
import { buildSourceGraph } from '../lib/source-graph.mjs';
import { loadOrganizationSources } from '../lib/solution-runtime-source.mjs';

const manifest = (name, version, missing = '') => `<ImportExportXml><SolutionManifest><UniqueName>${name}</UniqueName><Version>${version}</Version>${missing}</SolutionManifest></ImportExportXml>`;
const entity = name => `<Entity><Name>${name}</Name><EntityInfo><entity Name="${name}"><EntitySetName>${name}s</EntitySetName><PrimaryIdAttribute>${name}id</PrimaryIdAttribute>
<attributes><attribute PhysicalName="${name}id"><Name>${name}id</Name><Type>primarykey</Type></attribute><attribute PhysicalName="createdon"><Name>createdon</Name><Type>datetime</Type></attribute>
<attribute PhysicalName="createdby"><Name>createdby</Name><Type>lookup</Type></attribute><attribute PhysicalName="modifiedon"><Name>modifiedon</Name><Type>datetime</Type></attribute>
<attribute PhysicalName="modifiedby"><Name>modifiedby</Name><Type>lookup</Type></attribute><attribute PhysicalName="statecode"><Name>statecode</Name><Type>state</Type></attribute>
<attribute PhysicalName="statuscode"><Name>statuscode</Name><Type>status</Type></attribute></attributes></entity></EntityInfo></Entity>`;
const MISSING = `<MissingDependencies>
<MissingDependency><Required type="1" schemaName="x_base"/><Dependent type="300" schemaName="x_app"/></MissingDependency>
<MissingDependency><Required type="1" schemaName="x_absent"/><Dependent type="300" schemaName="x_app"/></MissingDependency></MissingDependencies>`;

async function layers(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'source-graph-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    'A/Other/Solution.xml': manifest('InventedBase', '1.0.0.0'),
    'A/Entities/x_base/Entity.xml': entity('x_base'),
    'A/Other/Customizations.xml': `<ImportExportXml><Entities/><CanvasApps><CanvasApp><Name>x_app</Name><AppVersion>1</AppVersion></CanvasApp></CanvasApps>
<connectionreferences><connectionreference connectionreferencelogicalname="x_boundref"><connectorid>/providers/Microsoft.PowerApps/apis/shared_fxa</connectorid></connectionreference></connectionreferences></ImportExportXml>`,
    'A/environmentvariabledefinitions/x_Default/environmentvariabledefinition.xml': '<environmentvariabledefinition schemaname="x_Default"><type>100000000</type><defaultvalue>local</defaultvalue></environmentvariabledefinition>',
    'A/environmentvariabledefinitions/x_Empty/environmentvariabledefinition.xml': '<environmentvariabledefinition schemaname="x_Empty"><type>100000000</type></environmentvariabledefinition>',
    'B/Other/Solution.xml': manifest('InventedExtension', '2.0.0.0', MISSING),
    'B/Other/Customizations.xml': `<ImportExportXml><Entities/><CanvasApps><CanvasApp><Name>x_app</Name><AppVersion>2</AppVersion></CanvasApp></CanvasApps>
<Roles/><connectionreferences><connectionreference connectionreferencelogicalname="x_unboundref"><connectorid>/providers/Microsoft.PowerApps/apis/shared_fxb</connectorid></connectionreference></connectionreferences></ImportExportXml>`,
    'B/Roles/Invented Role.xml': '<Role id="{77777777-7777-4777-8777-777777777771}" name="Invented Role"/>',
  };
  for (const [relative, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), content);
  }
  return [path.join(root, 'A'), path.join(root, 'B')];
}

test('the graph resolves the later selected layer and reports requirement statuses', async t => {
  const roots = await layers(t);
  const sources = await loadOrganizationSources({ solutionRoots: roots, solutionOrder: 'explicit' });
  assert.ok(sources.graph && sources.inventory.length);
  const graph = buildSourceGraph({ ...sources, workflows: new Map([['77777777-7777-4777-8777-777777777779', { name: 'Invented off', active: false }]]),
    bindings: { connectionReferences: [{ logicalName: 'X_BOUNDREF', connectionId: 'fx-connection' }] } });

  const app = graph.resolve('canvasapp', 'X_APP');
  assert.equal(app.solution, 'InventedExtension');
  assert.equal(app.version, '2');
  assert.equal(app.variants, 2);
  assert.equal(app.level, 'inventory');
  assert.equal(graph.resolve('table', 'x_base').level, 'behaviour');
  assert.equal(graph.resolve('layer', 'InventedExtension').version, '2.0.0.0');
  assert.equal(graph.resolve('canvasapp', 'x_unknown'), null);

  const status = Object.fromEntries(graph.requirements().map(row => [row.id, row.status]));
  assert.equal(status['connectionreference:x_boundref'], 'satisfied');
  assert.equal(status['connectionreference:x_unboundref'], 'missing');
  assert.equal(status['environmentvariable:x_default'], 'satisfied');
  assert.equal(status['environmentvariable:x_empty'], 'missing');
  assert.equal(status['canvasapp:x_app'], 'placeholder');
  // A role file is imported into the security tables (dataverse-security.mjs importSolutionSecurity): no preflight row.
  assert.equal(status['role:invented role'], undefined);
  assert.equal(status['table:x_base'], 'satisfied');
  assert.equal(status['table:x_absent'], 'missing');
  assert.equal(status['workflow:77777777-7777-4777-8777-777777777779'], 'disabled');
  for (const row of graph.requirements()) assert.deepEqual(Object.keys(row).slice(0, 4), ['id', 'kind', 'source', 'status']);

  const summary = graph.summary();
  assert.equal(summary.nodes, graph.nodes.size);
  assert.equal(summary.kinds.canvasapp.inventory, 1);
  assert.equal(summary.kinds.layer.behaviour, 2);
  assert.ok(summary.levels.inventory >= 1);
  assert.equal(summary.kinds.role.behaviour, 1);
  const again = buildSourceGraph({ ...sources, workflows: new Map([['77777777-7777-4777-8777-777777777779', { name: 'Invented off', active: false }]]) });
  assert.equal(again.fingerprint, graph.fingerprint);
  assert.match(graph.fingerprint, /^[0-9a-f]{64}$/);
});

test('loadSourceGraph is public and serialises without source values', async t => {
  const roots = await layers(t);
  const graph = await loadSourceGraph({ solutionRoots: roots, solutionOrder: 'explicit' });
  for (const name of ['nodes', 'resolve', 'requirements', 'summary', 'fingerprint']) assert.ok(name in graph, name);
  assert.ok(graph.nodes instanceof Map);
  const json = JSON.parse(JSON.stringify(graph));
  assert.deepEqual(Object.keys(json), ['fingerprint', 'summary', 'nodes']);
  assert.ok(json.nodes.every(node => typeof node.id === 'string' && node.id.startsWith(node.kind + ':')));
  assert.ok(!JSON.stringify(json).includes('fx-connection'));
});

test('requirements report unresolved inventory dependencies, absent sources, record errors and environment variable semantics', () => {
  const scan = { layers: [], inventory: [
    { component: 'canvasapp', name: 'x_app', level: 'inventory', source: 'CanvasApps/x_app.msapp', diagnostics: [],
      dependencies: [{ component: 'connector', name: 'shared_fxabsent' }, { component: 'connectionreference', name: 'x_unboundref' },
        { component: 'connectionreference', name: 'x_boundref' }, { component: 'table', name: 'x_item' }, { component: 'table', name: 'x_listed', missing: true }] },
    { component: 'canvasapp', name: 'x_broken', level: 'inventory', dependencies: [], diagnostics: [{ code: 'SOLUTION_INVENTORY_READ_FAILED', severity: 'error' }] },
    { component: 'canvasapp', name: 'x_large', level: 'inventory', dependencies: [], diagnostics: [{ code: 'SOLUTION_CANVAS_MSAPP_TOO_LARGE' }] },
    { component: 'role', name: 'x_rootonly', level: 'inventory', dependencies: [], sourceMissing: true },
  ] };
  const solutionData = { schema: { tables: { x_item: { logicalName: 'x_item', origin: 'solution' } },
    connectionReferences: [{ logicalName: 'x_unboundref' }, { logicalName: 'x_boundref' }],
    environmentVariables: [{ schemaName: 'x_Optional', type: 100000000, isRequired: false }, { schemaName: 'x_Required', type: 100000000, isRequired: true },
      { schemaName: 'x_Unflagged', type: 100000000 }, { schemaName: 'x_Secret', type: 100000005, defaultValue: 'fx-vault-reference' }] } };
  const graph = buildSourceGraph({ scan, solutionData, bindings: { connectionReferences: [{ logicalName: 'x_boundref', connectionId: 'fx-connection' }] } });
  const rows = graph.requirements();
  const row = (id, dependent) => rows.filter(item => item.id === id && item.dependent === dependent);
  assert.deepEqual(row('connector:shared_fxabsent', 'canvasapp:x_app').map(item => [item.status, item.reason]), [['missing', 'INVENTORY_DEPENDENCY_UNRESOLVED']]);
  assert.deepEqual(row('connectionreference:x_unboundref', 'canvasapp:x_app').map(item => item.reason), ['INVENTORY_DEPENDENCY_UNRESOLVED']);
  assert.deepEqual(row('connectionreference:x_unboundref', undefined).map(item => item.reason), ['SOLUTION_CONNREF_UNBOUND']);
  assert.deepEqual(row('connectionreference:x_boundref', 'canvasapp:x_app'), []);
  assert.deepEqual(row('table:x_item', 'canvasapp:x_app'), []);
  assert.deepEqual(row('table:x_listed', 'canvasapp:x_app'), []);
  const status = Object.fromEntries(rows.filter(item => !item.dependent).map(item => [item.id, [item.status, item.reason]]));
  assert.deepEqual(status['canvasapp:x_app'], ['placeholder', null]);
  assert.deepEqual(status['canvasapp:x_broken'], ['unsupported', 'SOLUTION_INVENTORY_READ_FAILED']);
  assert.deepEqual(status['canvasapp:x_large'], ['placeholder', null]);
  assert.deepEqual(status['role:x_rootonly'], ['missing', 'SOLUTION_COMPONENT_SOURCE_MISSING']);
  assert.deepEqual(status['environmentvariable:x_optional'], ['satisfied', null]);
  assert.deepEqual(status['environmentvariable:x_required'], ['missing', 'ENVIRONMENT_VARIABLE_NO_VALUE']);
  assert.deepEqual(status['environmentvariable:x_unflagged'], ['missing', 'ENVIRONMENT_VARIABLE_NO_VALUE']);
  assert.deepEqual(status['environmentvariable:x_secret'], ['secret', 'ENVIRONMENT_VARIABLE_SECRET']);
  assert.equal(rows.find(item => item.id === 'environmentvariable:x_secret').provider, 'secret-resolver');
  assert.ok(!JSON.stringify(rows).includes('fx-vault-reference') && !JSON.stringify(rows).includes('fx-connection'));
});
