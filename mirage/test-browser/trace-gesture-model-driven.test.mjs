// @test-kind contract: a gesture starts an activity linked to the page load
// Model-driven gesture tracing in a real browser (docs/design/tracing.md): a Save the user clicks is the root of a new
// trace, linked by parent-request to the page load's root span; the page load's trace gains no span from the click.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sharedBrowser } from './shared-browser.mjs';
import { openModelDrivenRecord } from './model-driven-trace-fixture.mjs';

const chrome = sharedBrowser();
const ITEM = 'c3e00000-0000-4000-8000-000000000002';
const solution = {
  'Other/Solution.xml':
    '<ImportExportXml><SolutionManifest><UniqueName>InventedClientGesture</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
  'AppModules/x_trace/AppModule.xml':
    '<AppModule><UniqueName>x_trace</UniqueName><AppModuleId>{c3e00000-0000-4000-8000-000000000078}</AppModuleId><LocalizedNames><LocalizedName description="Invented workspace" languagecode="1033"/></LocalizedNames><AppModuleComponents><AppModuleComponent type="1" schemaName="x_item"/></AppModuleComponents></AppModule>',
  'AppModuleSiteMaps/x_trace/AppModuleSiteMap.xml':
    '<AppModuleSiteMap><AppModuleUniqueName>x_trace</AppModuleUniqueName><SiteMap><Area Id="main"><Group Id="work"><Titles><Title LCID="1033" Title="Work"/></Titles><SubArea Id="items" Entity="x_item"><Titles><Title LCID="1033" Title="Items"/></Titles></SubArea></Group></Area></SiteMap></AppModuleSiteMap>',
  'Entities/x_item/Entity.xml':
    '<Entity><Name>x_item</Name><EntityInfo><entity Name="x_item"><LocalizedNames><LocalizedName description="Item" languagecode="1033"/></LocalizedNames><EntitySetName>x_items</EntitySetName><PrimaryIdAttribute>x_itemid</PrimaryIdAttribute><PrimaryNameAttribute>x_name</PrimaryNameAttribute><attributes><attribute PhysicalName="x_itemid"><Name>x_itemid</Name><LogicalName>x_itemid</LogicalName><Type>primarykey</Type></attribute><attribute PhysicalName="x_name"><Name>x_name</Name><LogicalName>x_name</LogicalName><Type>nvarchar</Type><displaynames><displayname description="Name" languagecode="1033"/></displaynames></attribute></attributes></entity></EntityInfo></Entity>',
  'Entities/x_item/FormXml/main/item.xml':
    '<systemform><formid>{item-form}</formid><type>2</type><LocalizedNames><LocalizedName description="Information" languagecode="1033"/></LocalizedNames><form><tabs><tab name="general"><labels><label description="General" languagecode="1033"/></labels><columns><column><sections><section name="details"><labels><label description="Details" languagecode="1033"/></labels><rows><row><cell><labels><label description="Name" languagecode="1033"/></labels><control datafieldname="x_name"/></cell></row></rows></section></sections></column></columns></tab></tabs></form></systemform>',
  'Entities/x_item/SavedQueries/items.xml':
    '<savedquery><savedqueryid>{items-view}</savedqueryid><querytype>0</querytype><isdefault>1</isdefault><LocalizedNames><LocalizedName description="Items" languagecode="1033"/></LocalizedNames><fetchxml><fetch><entity name="x_item"><attribute name="x_name"/></entity></fetch></fetchxml><layoutxml><grid><row><cell name="x_name" width="200"/></row></grid></layoutxml></savedquery>',
};

test('a Save the user clicks is the root of its own trace, linked to the page load; the page load gains no span', async (t) => {
  const { sim, page, errors, response } = await openModelDrivenRecord(t, chrome, {
    tempPrefix: 'trace-gesture-model-driven-',
    solution,
    item: ITEM,
  });
  const pageTrace = response.headers()['x-trace-id'],
    pageSpan = response.headers()['x-sim-span-id'];
  assert.ok(pageTrace && pageSpan, 'the shell answer names its root');
  await page.waitForFunction(
    () => document.documentElement.dataset.mirageAppState === 'ready' && Boolean(globalThis.Xrm),
  );
  await page.getByLabel('Name', { exact: true }).fill('Copper saved by a click');
  const pageSpans = () => sim.trace.spans({ traceId: pageTrace, pageSize: 200 }).total;
  const before = pageSpans();
  const saved = page.waitForResponse(
    (answer) => answer.request().method() === 'PATCH' && answer.url().includes('/_apps/api/tables/x_item/'),
  );
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const answer = await saved;
  assert.equal(answer.status(), 200);
  const saveTrace = answer.headers()['x-trace-id'],
    saveSpan = answer.headers()['x-sim-span-id'];
  assert.ok(saveTrace && saveSpan, 'the save answer names its root');
  assert.notEqual(saveTrace, pageTrace, 'the click starts an activity of its own');
  const save = sim.trace.span(saveSpan);
  assert.equal(save.traceId, saveTrace);
  assert.equal(save.parentSpanId, null);
  assert.ok(save.name.startsWith('PATCH '), save.name);
  assert.deepEqual(
    save.links.filter((link) => link.relation === 'parent-request'),
    [{ traceId: pageTrace, spanId: pageSpan, relation: 'parent-request' }],
  );
  assert.equal(pageSpans(), before, 'the page load trace gained no span from the click');
  assert.deepEqual(errors, []);
});
