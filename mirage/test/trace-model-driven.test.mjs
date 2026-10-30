// Model-driven app tracing (docs/design/tracing.md, DV-A-2/-3/-13, DV-B1-1/-2/-14): roots of the shell and /_apps/api
// name the model-driven host and the staff user; the shell page carries its root so the app's calls (records, the
// Xrm.WebApi bridge) join the page trace with every descendant as that user; error answers name their code on the root;
// the catalogue's table rights are one aggregated permission event.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { drainFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { endedTree } from './support/trace-scenario.mjs';
import { staffSimulator, writeFiles } from './support/trace-staff-hosts.mjs';

const APP = 'c3c00000-0000-4000-8000-000000000077';
const ADMIN = 'c3c00000-0000-4000-8000-0000000000a1',
  BASIC = 'c3c00000-0000-4000-8000-0000000000a2',
  ASSEMBLY = 'c3c00000-0000-4000-8000-000000000061',
  TYPE = 'c3c00000-0000-4000-8000-000000000062',
  STEP = 'c3c00000-0000-4000-8000-000000000063';
const entityXml = (name, set, id) =>
  `<Entity><Name>${name}</Name><EntityInfo><entity Name="${name}"><LocalizedNames><LocalizedName description="${name}" languagecode="1033"/></LocalizedNames><EntitySetName>${set}</EntitySetName><PrimaryIdAttribute>${id}</PrimaryIdAttribute><PrimaryNameAttribute>x_name</PrimaryNameAttribute><attributes><attribute PhysicalName="${id}"><Name>${id}</Name><LogicalName>${id}</LogicalName><Type>primarykey</Type></attribute><attribute PhysicalName="x_name"><Name>x_name</Name><LogicalName>x_name</LogicalName><Type>nvarchar</Type><displaynames><displayname description="Name" languagecode="1033"/></displaynames></attribute><attribute PhysicalName="x_quantity"><Name>x_quantity</Name><LogicalName>x_quantity</LogicalName><Type>int</Type><displaynames><displayname description="Quantity" languagecode="1033"/></displaynames></attribute></attributes></entity></EntityInfo></Entity>`;
const solution = {
  'Other/Solution.xml':
    '<ImportExportXml><SolutionManifest><UniqueName>InventedModelTrace</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
  'AppModules/x_trace/AppModule.xml': `<AppModule><UniqueName>x_trace</UniqueName><AppModuleId>{${APP}}</AppModuleId><LocalizedNames><LocalizedName description="Invented workspace" languagecode="1033"/></LocalizedNames><AppModuleComponents><AppModuleComponent type="1" schemaName="x_item"/><AppModuleComponent type="1" schemaName="x_part"/></AppModuleComponents></AppModule>`,
  'AppModuleSiteMaps/x_trace/AppModuleSiteMap.xml':
    '<AppModuleSiteMap><AppModuleUniqueName>x_trace</AppModuleUniqueName><SiteMap><Area Id="main"><Group Id="work"><Titles><Title LCID="1033" Title="Work"/></Titles><SubArea Id="items" Entity="x_item"><Titles><Title LCID="1033" Title="Items"/></Titles></SubArea></Group></Area></SiteMap></AppModuleSiteMap>',
  'Entities/x_item/Entity.xml': entityXml('x_item', 'x_items', 'x_itemid'),
  'Entities/x_item/SavedQueries/items.xml':
    '<savedquery><savedqueryid>{items-view}</savedqueryid><querytype>0</querytype><isdefault>1</isdefault><LocalizedNames><LocalizedName description="Items" languagecode="1033"/></LocalizedNames><fetchxml><fetch><entity name="x_item"><attribute name="x_name"/></entity></fetch></fetchxml><layoutxml><grid><row><cell name="x_name" width="200"/></row></grid></layoutxml></savedquery>',
  'Entities/x_part/Entity.xml': entityXml('x_part', 'x_parts', 'x_partid'),
  'PluginAssemblies/Invented.Items/Invented.Items.xml': `<PluginAssembly PluginAssemblyId="{${ASSEMBLY}}"><Name>Invented.Items</Name><Version>1.0.0.0</Version><IsolationMode>2</IsolationMode><SourceType>0</SourceType><PluginTypes><PluginType PluginTypeId="{${TYPE}}"><TypeName>Invented.Items.Rules</TypeName></PluginType></PluginTypes></PluginAssembly>`,
  [`SdkMessageProcessingSteps/${STEP}.xml`]: `<SdkMessageProcessingStep SdkMessageProcessingStepId="{${STEP}}"><Name>Invented item pre-operation</Name><PluginTypeId>${TYPE}</PluginTypeId><SdkMessageName>Create</SdkMessageName><PrimaryEntity>x_item</PrimaryEntity><Stage>20</Stage><Rank>1</Rank><Mode>0</Mode><SupportedDeployment>0</SupportedDeployment><StateCode>0</StateCode><FilteringAttributes></FilteringAttributes></SdkMessageProcessingStep>`,
};

// An invented plug-in step that refuses an item named 'Bad item' (an unhandled exception: fault 0x80040224).
const pack = {
  id: 'model-trace',
  name: 'Invented model-driven plug-in',
  description: 'Invented plug-in handler for the model-driven trace tests',
  matches: () => true,
  presets: () => ({}),
  pluginSteps: {
    [STEP]: ({ target }) => {
      if (target.x_name === 'Bad item')
        throw Object.assign(new Error('Bad items are refused.'), { code: 'InventedBadItem' });
    },
  },
};

const closers = [],
  removers = [];
after(async () => {
  await drainFixture(closers);
  await drainFixture(removers);
});
let shared;
const runtime = () =>
  (shared ??= (async () => {
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'trace-model-driven-'));
    removers.push(() => fs.rm(root, { recursive: true, force: true }));
    await writeFiles(path.join(root, 'solution'), solution);
    return staffSimulator({
      root,
      admin: ADMIN,
      basic: BASIC,
      closers,
      runtime: { kind: 'model-driven' },
      packs: [pack],
    });
  })());

// The shell page as a browser opens it: its root span and the trace headers its metas name.
async function openShell(cookie) {
  const { sim } = await runtime();
  const response = await fetch(sim.url + '/main.aspx?appid=' + APP, { headers: { cookie } });
  const html = await response.text();
  const meta = (name) => new RegExp(`<meta name="${name}" content="([^"]*)"`).exec(html)?.[1];
  const tree = await endedTree(sim.trace, response.headers.get('x-trace-id'));
  return {
    root: tree.root,
    headers: { 'x-trace-id': meta('mirage-trace-id'), 'x-sim-parent-trace': meta('mirage-trace-parent') },
  };
}
// One /_apps/api call as the shell makes it (app.mjs api()): its answer, root and ended trace.
async function call(suffix, { cookie, headers = {}, method = 'GET', body } = {}) {
  const { sim } = await runtime();
  const response = await fetch(sim.url + '/_apps/api' + suffix, {
    method,
    headers: { 'content-type': 'application/json', 'x-sim-csrf': sim.csrf, cookie, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const answer = await response.json();
  const tree = await endedTree(sim.trace, response.headers.get('x-trace-id'));
  const root = tree.spans.find((span) => span.spanId === response.headers.get('x-sim-span-id'));
  return { response, answer, tree, root };
}
const descendants = (tree, ancestor) => {
  const ids = new Set([ancestor.spanId]);
  return tree.spans.filter((span) => ids.has(span.parentSpanId) && ids.add(span.spanId));
};

test('the shell is a model-driven root of the staff user and its page names that root for the app calls', async () => {
  const { admin } = await runtime();
  const { root, headers } = await openShell(admin.cookie);
  assert.deepEqual(
    [root.name, root.module, root.origin.host, root.actor.kind, root.actor.id, root.actor.name],
    ['GET /main.aspx', 'model-driven', 'model-driven', 'staff', admin.id, 'Invented Admin'],
  );
  assert.deepEqual(headers, { 'x-trace-id': root.traceId, 'x-sim-parent-trace': root.spanId });
});

test('catalogue table rights are one aggregated permission event, not one per table and operation', async () => {
  const { admin } = await runtime();
  const { response, tree, root } = await call('/index', { cookie: admin.cookie });
  assert.equal(response.status, 200);
  const decisions = tree.spans.flatMap((span) => span.events.filter((event) => event.type === 'permission'));
  assert.equal(decisions.length, 1, 'one permission event for the whole evaluation');
  const [event] = root.events.filter((item) => item.type === 'permission');
  const { result, tables, allowed, denied } = event.attributes;
  assert.equal(result, 'evaluated');
  assert.ok(tables >= 2, 'every catalogue table was evaluated');
  assert.equal(allowed + denied, tables * 4, 'read, create, update and delete of each table are counted');
});

test('a record write carrying the page headers joins the shell trace; root and descendants name the table, record and staff user', async () => {
  const { admin } = await runtime();
  const shell = await openShell(admin.cookie);
  const { response, answer, tree, root } = await call('/tables/x_item', {
    cookie: admin.cookie,
    headers: shell.headers,
    method: 'POST',
    body: { x_name: 'Copper', x_quantity: 2 },
  });
  assert.equal(response.status, 201);
  assert.deepEqual(
    [root.traceId, root.parentSpanId, root.module, root.origin.host, root.entity, root.recordId],
    [shell.root.traceId, shell.root.spanId, 'model-driven', 'model-driven', 'x_item', answer.id],
  );
  const below = descendants(tree, root);
  assert.ok(below.some((span) => span.kind === 'dataverse' && span.operation === 'create'));
  assert.ok(
    [root, ...below].every(
      (span) => span.actor.kind === 'plugin' || (span.actor.kind === 'staff' && span.actor.id === admin.id),
    ),
    'no span of the save is anonymous: the pipeline runs as the staff user, a plug-in step as its plug-in',
  );
  // A grid read names its view and page on the root.
  const grid = await call(
    '/tables/x_item?query=' + encodeURIComponent(JSON.stringify({ view: 'items-view', page: 1, pageSize: 5 })),
    { cookie: admin.cookie, headers: shell.headers },
  );
  assert.deepEqual(
    [grid.root.entity, grid.root.attributes.view, grid.root.attributes.page, grid.root.attributes.pageSize],
    ['x_item', 'items-view', 1, 5],
  );
});

test('handled error answers name their code, message and status on the root (412 stale save, denied create)', async () => {
  const { admin, basic } = await runtime();
  const created = await call('/tables/x_item', { cookie: admin.cookie, method: 'POST', body: { x_name: 'Tin' } });
  const read = await call('/tables/x_item/' + created.answer.id, { cookie: admin.cookie });
  await call('/tables/x_item/' + created.answer.id, {
    cookie: admin.cookie,
    method: 'PATCH',
    headers: { 'if-match': read.answer.etag },
    body: { x_quantity: 3 },
  });
  const stale = await call('/tables/x_item/' + created.answer.id, {
    cookie: admin.cookie,
    method: 'PATCH',
    headers: { 'if-match': read.answer.etag },
    body: { x_quantity: 4 },
  });
  assert.equal(stale.response.status, 412);
  assert.deepEqual(
    [stale.root.status, stale.root.error.code, stale.root.error.message, stale.root.error.status],
    ['error', stale.answer.error.code, stale.answer.error.message, 412],
  );
  const refused = await call('/tables/x_item', { cookie: basic.cookie, method: 'POST', body: { x_name: 'Basic' } });
  assert.equal(refused.response.status, 403);
  assert.deepEqual(
    [refused.root.status, refused.root.error.code, refused.root.error.message, refused.root.actor.id],
    ['denied', refused.answer.error.code, refused.answer.error.message, basic.id],
  );
});

test('an Xrm.WebApi bridge call with the page headers nests the Dataverse listener root under it in the shell trace', async () => {
  const { admin } = await runtime();
  const shell = await openShell(admin.cookie);
  const { response, tree, root } = await call('/webapi', {
    cookie: admin.cookie,
    headers: shell.headers,
    method: 'POST',
    body: { method: 'GET', path: '/api/data/v9.2/x_items?$select=x_name' },
  });
  assert.equal(response.status, 200);
  assert.deepEqual([root.traceId, root.parentSpanId, root.actor.id], [shell.root.traceId, shell.root.spanId, admin.id]);
  const listener = descendants(tree, root).find((span) => span.origin.host === 'dataverse-api' && span.kind === 'http');
  assert.deepEqual([listener?.parentSpanId, listener?.actor.kind], [root.spanId, 'staff']);
});

test('a save a plug-in refuses names the fault identity of its spans on the root; the answer keeps its own code', async () => {
  const { admin } = await runtime();
  const { response, answer, tree, root } = await call('/tables/x_item', {
    cookie: admin.cookie,
    method: 'POST',
    body: { x_name: 'Bad item' },
  });
  assert.ok(response.status >= 400);
  const step = tree.spans.find((span) => span.kind === 'plugin-step' && span.error);
  assert.ok(step?.error.pluginType, 'the step names the plug-in fault');
  const { type, code, pluginType, step: stepName, stage, depth, message } = step.error;
  assert.deepEqual(
    [root.status, root.error.type, root.error.code, root.error.pluginType, root.error.step, root.error.stage],
    ['error', type, code, pluginType, stepName, stage],
  );
  assert.deepEqual([root.error.depth, root.error.message], [depth, message]);
  assert.match(root.error.code, /^0x8004/);
  assert.notEqual(answer.error.code, root.error.code, 'the HTTP answer is unchanged: it keeps its envelope code');
});
