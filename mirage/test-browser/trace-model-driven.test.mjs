// Model-driven client trace propagation in a real browser (docs/design/tracing.md, DV-A-13): the shell's calls to
// /_apps/api (catalogue, records) and Xrm.WebApi through the bridge carry the page root's trace headers, so they are
// children of the GET /main.aspx root in one trace.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { drainFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { sharedBrowser } from './shared-browser.mjs';
import { writeFiles } from '../test/support/trace-staff-hosts.mjs';

const chrome = sharedBrowser();
const ITEM = 'c3e00000-0000-4000-8000-000000000001';
const solution = {
  'Other/Solution.xml':
    '<ImportExportXml><SolutionManifest><UniqueName>InventedClientTrace</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
  'AppModules/x_trace/AppModule.xml':
    '<AppModule><UniqueName>x_trace</UniqueName><AppModuleId>{c3e00000-0000-4000-8000-000000000077}</AppModuleId><LocalizedNames><LocalizedName description="Invented workspace" languagecode="1033"/></LocalizedNames><AppModuleComponents><AppModuleComponent type="1" schemaName="x_item"/></AppModuleComponents></AppModule>',
  'AppModuleSiteMaps/x_trace/AppModuleSiteMap.xml':
    '<AppModuleSiteMap><AppModuleUniqueName>x_trace</AppModuleUniqueName><SiteMap><Area Id="main"><Group Id="work"><Titles><Title LCID="1033" Title="Work"/></Titles><SubArea Id="items" Entity="x_item"><Titles><Title LCID="1033" Title="Items"/></Titles></SubArea></Group></Area></SiteMap></AppModuleSiteMap>',
  'Entities/x_item/Entity.xml':
    '<Entity><Name>x_item</Name><EntityInfo><entity Name="x_item"><LocalizedNames><LocalizedName description="Item" languagecode="1033"/></LocalizedNames><EntitySetName>x_items</EntitySetName><PrimaryIdAttribute>x_itemid</PrimaryIdAttribute><PrimaryNameAttribute>x_name</PrimaryNameAttribute><attributes><attribute PhysicalName="x_itemid"><Name>x_itemid</Name><LogicalName>x_itemid</LogicalName><Type>primarykey</Type></attribute><attribute PhysicalName="x_name"><Name>x_name</Name><LogicalName>x_name</LogicalName><Type>nvarchar</Type><displaynames><displayname description="Name" languagecode="1033"/></displaynames></attribute></attributes></entity></EntityInfo></Entity>',
  'Entities/x_item/FormXml/main/item.xml':
    '<systemform><formid>{item-form}</formid><type>2</type><LocalizedNames><LocalizedName description="Information" languagecode="1033"/></LocalizedNames><form><tabs><tab name="general"><labels><label description="General" languagecode="1033"/></labels><columns><column><sections><section name="details"><labels><label description="Details" languagecode="1033"/></labels><rows><row><cell><labels><label description="Name" languagecode="1033"/></labels><control datafieldname="x_name"/></cell></row></rows></section></sections></column></columns></tab></tabs></form></systemform>',
  'Entities/x_item/SavedQueries/items.xml':
    '<savedquery><savedqueryid>{items-view}</savedqueryid><querytype>0</querytype><isdefault>1</isdefault><LocalizedNames><LocalizedName description="Items" languagecode="1033"/></LocalizedNames><fetchxml><fetch><entity name="x_item"><attribute name="x_name"/></entity></fetch></fetchxml><layoutxml><grid><row><cell name="x_name" width="200"/></row></grid></layoutxml></savedquery>',
};

const closers = [],
  removers = [];
after(async () => {
  await drainFixture(closers);
  await drainFixture(removers);
});

test('the shell, its record calls and Xrm.WebApi join the page trace as children of the GET /main.aspx root', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'trace-model-driven-browser-'));
  removers.push(() => fs.rm(root, { recursive: true, force: true }));
  await writeFiles(path.join(root, 'solution'), solution);
  const sim = await createSimulator({
    runtime: { kind: 'model-driven' },
    solutionRoots: [path.join(root, 'solution')],
    projectRoot: root,
    port: 0,
    watch: false,
    simulation: { level: 'dry-run' },
    initial: { tables: { x_item: [{ x_itemid: ITEM, x_name: 'Copper' }] } },
    dataverse: { enabled: true, tls: false, tds: { enabled: false } },
    trace: { level: 'summary' },
  });
  closers.push(() => sim.close());
  const page = await chrome.page(t);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const response = await page.goto(sim.url + '/main.aspx?appname=x_trace&pagetype=entityrecord&etn=x_item&id=' + ITEM);
  const traceId = response.headers()['x-trace-id'],
    pageSpan = response.headers()['x-sim-span-id'];
  assert.ok(traceId && pageSpan, 'the shell answer names its root');
  await page.waitForFunction(
    () => document.documentElement.dataset.mirageAppState === 'ready' && Boolean(globalThis.Xrm),
  );
  // Xrm.WebApi.online.execute goes through the shell's Web API bridge (POST /_apps/api/webapi).
  const status = await page.evaluate(async (id) => {
    const request = {
      entityReference: { entityType: 'x_item', id },
      getMetadata: () => ({ boundParameter: null, operationType: 2, operationName: 'Retrieve', parameterTypes: {} }),
    };
    return (await globalThis.Xrm.WebApi.online.execute(request)).status;
  }, ITEM);
  assert.equal(status, 200);
  const children = sim.trace.spans({ traceId, parentSpanId: pageSpan, pageSize: 200 }).items.map((span) => span.name);
  assert.ok(children.includes('GET /_apps/api/index'), children.join(', '));
  assert.ok(children.includes(`GET /_apps/api/tables/x_item/${ITEM}`), children.join(', '));
  assert.ok(children.includes('POST /_apps/api/webapi'), children.join(', '));
  assert.deepEqual(errors, []);
});
