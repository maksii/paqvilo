import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore } from '../lib/data.mjs';
import { pluginCatalogue, runPluginPhase } from '../lib/exported-plugins.mjs';
import { createOrganizationBackend } from '../lib/organization-backend.mjs';
import { localOrganizationService } from '../lib/local-organization-service.mjs';
import { dispatchSdkCall } from '../lib/plugin-clr.mjs';
import { rebindPermissionQuery } from '../lib/permission-query-mutation.mjs';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { EXTENSION } from '../lib/dataverse-virtual-providers.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { prepareClrRuntime, closeClrHostPool } from '../lib/plugin-clr.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';
import { ORDINARY_CLR_TIMEOUT_MS } from './fixtures/clr-budget.mjs';
import { bypassStepIds, pluginBypassOwnership, pluginStepBypassed } from '../lib/plugin-bypass.mjs';
import { platformValues } from '../lib/platform-settings.mjs';

const id = '20000000-0000-0000-0000-000000000001';
const user = '10000000-0000-0000-0000-000000000001';
const fixture = () =>
  new DataStore({
    state: {
      version: 1,
      mappings: { widget: { entitySet: 'widgets', idColumn: 'widgetid' } },
      tables: { widget: [{ widgetid: id, title: 'Before', note: 'Extra' }] },
      permissions: [],
      plugins: [],
      settings: { permissionMode: 'permissive' },
    },
  });
const step = (message, stage = 20) => ({
  id: `30000000-0000-0000-0000-${String(stage).padStart(12, '0')}`,
  enabled: true,
  entity: 'widget',
  message,
  stage,
  rank: 1,
  mode: 0,
  supportedDeployment: 0,
  filteringAttributes: [],
  images: [],
  typeName: 'Invented.Read',
  assemblyId: 'invented',
});
const profile = {
  userId: user,
  evidence: 'Invented read parity fixture',
  grants: [{ entity: 'widget', operations: ['read', 'update'] }],
};
const install = (store, handler, message = 'RetrieveMultiple', stage = 20, typed = false) => {
  const registration = step(message, stage),
    handlers = new Map([[typed ? registration.typeName : registration.id, handler]]);
  const items = pluginCatalogue({ plugins: { steps: [registration] }, handlers });
  store.setPluginPipeline(
    (c) => runPluginPhase({ ...c, store, items, handlers }),
    (c) => c.operation === message.toLowerCase(),
  );
};

test('a no-op read step preserves counts, string predicates, transport offsets and aliases', () => {
  const store = fixture();
  store.state.tables.widget[0].amount = 2;
  store.state.mappings.widget.relationships = {
    children: { entity: 'child', from: 'widgetid', to: 'widgetid', many: true },
  };
  store.state.mappings.child = { entitySet: 'children', idColumn: 'childid' };
  store.state.tables.child = [{ childid: id, widgetid: id, title: 'Child' }];
  store.state.mappings.parent = { entitySet: 'parents', idColumn: 'parentid' };
  store.state.mappings.widget.relationships.parent = {
    entity: 'parent',
    from: 'parentid',
    to: 'parentid',
    many: false,
  };
  Object.assign(store.state.tables.widget[0], { parentid: id, other: 'Before', enabled: true });
  store.state.tables.parent = [{ parentid: id, title: 'Parent' }];
  store.state.tables.widget.push({ widgetid: user, title: 'Other', amount: 3, parentid: null });
  const queries = [
    { $count: 'true', $select: 'title' },
    { $count: 'true', $select: '*' },
    { $filter: "contains(title,'efore')", $count: 'true' },
    { $filter: "not startswith(title,'X')", $skip: '0' },
    { $filter: 'title eq @needle', '@needle': "'Before'" },
    { $filter: "children/any(child:child/title eq 'Child')" },
    { $expand: 'children' },
    { $select: 'title', $expand: 'children($select=title)' },
    { $apply: 'aggregate(amount with sum as total)' },
    { $filter: "Microsoft.Dynamics.CRM.In(PropertyName='title',PropertyValues=['Before'])" },
    { $filter: "parent/title eq 'Parent'" },
    { $filter: 'parent/title eq null' },
    { $filter: 'not (parent/title eq null)' },
    { $filter: 'title eq other' },
    { $filter: 'enabled' },
    { $filter: 'true' },
    { $filter: "'Before' eq title" },
    { $orderby: 'parent/title desc' },
  ];
  const expected = queries.map((query) => store.query('widgets', query, { admin: true }));
  install(store, () => {});
  assert.deepEqual(
    queries.map((query) => store.query('widgets', query, { admin: true })),
    expected,
  );
});

test('HTTP property Retrieve honors its effective Target and ColumnSet before projecting the wire value', async (t) => {
  const replacement = '20000000-0000-0000-0000-000000000002';
  const f = await contractModuleFixture(t, {
    mappings: {
      widget: {
        logicalName: 'widget',
        entitySet: 'widgets',
        idColumn: 'widgetid',
        fields: { title: { dataverseType: 'nvarchar' }, note: { dataverseType: 'nvarchar' } },
      },
    },
    tables: {
      widget: [
        { widgetid: id, title: 'Original', note: 'Original note' },
        { widgetid: replacement, title: 'Replacement', note: 'Replacement note' },
      ],
    },
    extension: EXTENSION,
  });
  const seen = [];
  f.store.setPluginPipeline(
    (context) => {
      seen.push({ stage: context.stage, primary: context.record.widgetid });
      if (context.stage === 20) {
        context.holder.target.id = replacement;
        context.columns.columns.push('note');
      }
      if (context.stage === 40) {
        assert.equal(context.holder.entity.id, replacement);
        assert.deepEqual(context.holder.entity.attributes, {
          title: 'Replacement',
          note: 'Replacement note',
          widgetid: { $type: 'Guid', value: replacement },
        });
      }
    },
    (context) => context.operation === 'retrieve',
  );
  const body = await f.json(await f.request('GET', `/widgets(${id})/title`), 200);
  assert.equal(body.value, 'Replacement');
  assert.deepEqual(
    seen,
    [10, 20, 40].map((stage) => ({ stage, primary: id })),
  );
  seen.length = 0;
  const raw = await f.request('GET', `/widgets(${id})/title/$value`);
  assert.equal(raw.status, 200);
  assert.equal(await raw.text(), 'Replacement');
  assert.deepEqual(
    seen,
    [10, 20, 40].map((stage) => ({ stage, primary: id })),
  );
});

test('Retrieve executes its main read after pre-stages and honors ColumnSet changes', async () => {
  const store = fixture();
  const stages = [];
  store.setPluginPipeline(
    (c) => {
      stages.push(c.stage);
      if (c.stage === 20) {
        localOrganizationService(store, profile).update('widget', id, { title: 'After' });
        c.columns.columns.push('note');
      }
    },
    (c) => c.operation === 'retrieve',
  );
  const row = await store.readOperation(() =>
    store.get(
      'widget',
      id,
      { admin: true },
      {
        sdkColumns: { allColumns: false, columns: ['title'] },
      },
    ),
  );
  assert.equal(row.title, 'After');
  assert.equal(row.note, 'Extra');
  assert.deepEqual(stages, [10, 20, 40]);
  stages.length = 0;
  assert.equal(store.get('widget', '20000000-0000-0000-0000-000000000099', { admin: true }), null);
  assert.deepEqual(stages, [10, 20]);
});

test('HTTP entity and property reads run Retrieve once; bypassed reads run no custom steps', async (t) => {
  const f = await contractModuleFixture(t, {
    mappings: {
      widget: {
        logicalName: 'widget',
        entitySet: 'widgets',
        idColumn: 'widgetid',
        fields: { title: { dataverseType: 'nvarchar' } },
      },
    },
    tables: { widget: [{ widgetid: id, title: 'Before' }] },
    extension: EXTENSION,
  });
  const seen = [];
  const registrations = [
    step('Retrieve', 40),
    { ...step('RetrieveMultiple', 40), id: '30000000-0000-0000-0000-000000000041' },
  ];
  const handlers = new Map(
    registrations.map((s) => [
      s.id,
      (c) => {
        seen.push(c.operation);
        if (c.operation === 'retrieve')
          return {
            entityResult: { ...c.entityResult, attributes: { ...c.entityResult.attributes, title: 'Observed' } },
          };
      },
    ]),
  );
  const items = pluginCatalogue({ plugins: { steps: registrations }, handlers });
  const backend = await createOrganizationBackend({ store: f.store, items: () => items, handlers });
  t.after(() => backend.close());
  const body = await f.json(await f.request('GET', `/widgets(${id})?$select=title`), 200);
  assert.equal(body.title, 'Observed');
  assert.deepEqual(seen, ['retrieve']);
  seen.length = 0;
  const property = await f.json(await f.request('GET', `/widgets(${id})/title`), 200);
  assert.equal(property.value, 'Observed');
  assert.deepEqual(seen, ['retrieve']);
  seen.length = 0;
  await f.json(
    await f.request('GET', '/widgets?$count=true', null, { 'MSCRM.BypassCustomPluginExecution': 'true' }),
    200,
  );
  assert.deepEqual(seen, []);
  const selective = await f.json(
    await f.request('GET', `/widgets(${id})?$select=title`, null, {
      'MSCRM.BypassBusinessLogicExecutionStepIds': registrations[0].id,
    }),
    200,
  );
  assert.equal(selective.title, 'Before');
  assert.deepEqual(seen, []);
  await f.json(
    await f.request('GET', '/widgets?$count=true', null, {
      'MSCRM.BypassBusinessLogicExecutionStepIds': registrations[0].id,
    }),
    200,
  );
  assert.deepEqual(seen, ['retrievemultiple'], 'An unrelated selected ID must not bypass another message');
  seen.length = 0;
  await f.json(
    await f.request('GET', '/widgets?$count=true&$filter=contains(title,%27Before%27)', null, {
      'MSCRM.BypassBusinessLogicExecutionStepIds': registrations[1].id,
    }),
    200,
  );
  assert.deepEqual(seen, []);
  const missing = '20000000-0000-0000-0000-000000000099';
  const guard = step('Retrieve', 10);
  handlers.set(guard.id, (c) => {
    if (c.record.widgetid === missing) return { error: { message: 'Missing prevalidation guard' } };
  });
  items.push(...pluginCatalogue({ plugins: { steps: [guard] }, handlers }));
  const rejected = await f.request('GET', `/widgets(${missing})`);
  assert.equal(rejected.status, 400);
  assert.match((await rejected.json()).error.message, /Missing prevalidation guard/);
});

test('SDK virtual reads execute pre/result steps around the provider, including query mutation', async (t) => {
  const calls = [];
  const f = await contractModuleFixture(t, {
    mappings: {
      widget: {
        logicalName: 'widget',
        entitySet: 'widgets',
        idColumn: 'widgetid',
        isVirtual: true,
        fields: { title: { dataverseType: 'nvarchar' } },
      },
    },
    tables: { widget: [] },
    extension: EXTENSION,
    options: {
      virtualTableProviders: {
        widget: {
          retrieveSync: () => {
            calls.push('provider-get');
            return { widgetid: id, title: 'External' };
          },
          retrieveMultipleSync: () => {
            calls.push('provider-query');
            return [{ widgetid: id, title: 'External' }];
          },
        },
      },
    },
  });
  install(f.store, (c) => {
    calls.push(`step-${c.stage}`);
    return { error: { message: 'Read guard' } };
  });
  const sdk = localOrganizationService(f.store, profile);
  assert.throws(() => sdk.query('widget'), /Read guard/);
  assert.deepEqual(calls, ['step-20']);
  calls.length = 0;
  install(f.store, () => ({ error: { message: 'Single guard' } }), 'Retrieve');
  assert.throws(() => sdk.get('widget', id), /Single guard/);
  assert.deepEqual(calls, []);
  calls.length = 0;
  install(f.store, (c) => ({ collection: { ...c.collection, entities: [] } }), 'RetrieveMultiple', 40);
  assert.equal(sdk.query('widget').value.length, 0);
  assert.deepEqual(calls, ['provider-query']);
});

test('query-conversion Execute requests remain read-only and retain named SDK result shapes', () => {
  const store = fixture();
  store.pluginReadOnly = true;
  const execute = (requestName, values) =>
    dispatchSdkCall({
      store,
      profile,
      message: {
        method: 'Execute',
        userId: user,
        arguments: [
          { $type: 'OrganizationRequest', requestName, parameters: { $type: 'ParameterCollection', values } },
        ],
      },
    });
  const converted = execute('FetchXmlToQueryExpression', {
    FetchXml:
      '<fetch><entity name="widget"><attribute name="title"/><filter><condition attribute="title" operator="eq" value="Before"/></filter></entity></fetch>',
  });
  assert.equal(converted.responseName, 'FetchXmlToQueryExpression');
  assert.equal(converted.results.Query.$type, 'QueryExpression');
  const reversed = execute('QueryExpressionToFetchXml', { Query: converted.results.Query });
  assert.equal(reversed.responseName, 'QueryExpressionToFetchXml');
  assert.match(reversed.results.FetchXml, /value="Before"/);
  assert.equal(store.tableRows('widget').length, 1);
  const all = execute('FetchXmlToQueryExpression', { FetchXml: '<fetch><entity name="widget"/></fetch>' }).results
    .Query;
  assert.equal(all.columnSet.allColumns, true);
  const allRows = dispatchSdkCall({
    store,
    profile,
    message: { method: 'RetrieveMultiple', userId: user, arguments: [all] },
  });
  assert.equal(allRows.entities[0].attributes.note, 'Extra');
  store.state.mappings.widget.fields = {
    quantity: { dataverseType: 'int' },
    enabled: { dataverseType: 'bit' },
    happened: { dataverseType: 'datetime' },
  };
  const typed = execute('FetchXmlToQueryExpression', {
    FetchXml: `<fetch><entity name="widget"><filter hint="union"><condition attribute="quantity" operator="eq" value="1"/><condition attribute="enabled" operator="eq" value="1"/><condition attribute="widgetid" operator="eq" value="${id}"/><condition attribute="happened" operator="on" value="2026-10-29"/></filter></entity></fetch>`,
  });
  const criteria = typed.results.Query.criteria.filters[0];
  assert.equal(criteria.filterHint, 'union');
  assert.deepEqual(
    criteria.conditions.map((condition) => condition.values[0]),
    [1, true, { $type: 'Guid', value: id }, '2026-10-29T00:00:00+00:00'],
  );
  assert.throws(
    () =>
      execute('FetchXmlToQueryExpression', { FetchXml: '<fetch unknownfacet="true"><entity name="widget"/></fetch>' }),
    /unknownfacet.*not declared/,
  );
  const flags = execute('FetchXmlToQueryExpression', {
    FetchXml:
      '<fetch distinct="1" returntotalrecordcount="1"><entity name="widget"><order attribute="title" descending="1"/></entity></fetch>',
  }).results.Query;
  assert.equal(flags.distinct, true);
  assert.equal(flags.pageInfo.returnTotalRecordCount, true);
  assert.equal(flags.orders[0].descending, true);
  const options = execute('FetchXmlToQueryExpression', {
    FetchXml: '<fetch no-lock="1" options="LoopJoin" datasource="retained"><entity name="widget"/></fetch>',
  }).results.Query;
  assert.equal(options.noLock, true);
  assert.equal(options.queryHints, 'LoopJoin');
  assert.equal(options.dataSource, 'retained');
  assert.match(execute('QueryExpressionToFetchXml', { Query: options }).results.FetchXml, /datasource="retained"/);
  const other = '20000000-0000-0000-0000-000000000002';
  store.state.tables.widget.push({ widgetid: other, title: 'Other' });
  store.state.mappings.child = { entitySet: 'children', idColumn: 'childid' };
  store.state.tables.child = [{ childid: other, widgetid: id, title: 'Child' }];
  for (const linkType of ['any', 'not any']) {
    const original = `<fetch><entity name="widget"><attribute name="widgetid"/><filter><link-entity name="child" from="widgetid" to="widgetid" link-type="${linkType}"><filter><condition attribute="title" operator="eq" value="Child"/></filter></link-entity></filter></entity></fetch>`;
    const converted = execute('FetchXmlToQueryExpression', { FetchXml: original }).results.Query;
    const roundTrip = execute('QueryExpressionToFetchXml', { Query: converted }).results.FetchXml;
    assert.deepEqual(
      store.fetchXml(roundTrip, { admin: true }).entities.map((row) => row.widgetid),
      store.fetchXml(original, { admin: true }).entities.map((row) => row.widgetid),
      'A filter link must not disappear in conversion',
    );
    assert.equal(converted.criteria.filters[0].filters[0].anyAllFilterLinkEntity.$type, 'LinkEntity');
  }
});

test('SDK bypass options require explicit profile privileges and affect only the requested custom phases', () => {
  const store = fixture();
  const allowed = {
    ...profile,
    privileges: ['prvBypassCustomPlugins', 'prvBypassCustomBusinessLogic'],
    grants: [{ entity: 'widget', operations: ['read', 'create'] }],
  };
  install(store, () => ({ error: { message: 'Synchronous guard' } }), 'Create');
  const execute = (optional, caller = allowed) =>
    dispatchSdkCall({
      store,
      profile: caller,
      message: {
        method: 'Execute',
        userId: user,
        arguments: [
          {
            $type: 'OrganizationRequest',
            requestName: 'Create',
            parameters: {
              $type: 'ParameterCollection',
              values: {
                Target: {
                  $type: 'Entity',
                  logicalName: 'widget',
                  id: '00000000-0000-0000-0000-000000000000',
                  attributes: { title: 'SDK request' },
                },
                ...optional,
              },
            },
          },
        ],
      },
    });
  assert.throws(
    () => execute({ BypassCustomPluginExecution: true }, { ...allowed, privileges: [] }),
    /lacks prvBypassCustomPlugins/,
  );
  assert.throws(
    () => execute({ BypassBusinessLogicExecution: 'CustomSync' }, { ...allowed, privileges: [] }),
    /lacks prvBypassCustomBusinessLogic/,
  );
  assert.throws(() => execute({ BypassBusinessLogicExecution: 'CustomAsync' }), /Synchronous guard/);
  assert.equal(execute({ BypassCustomPluginExecution: true }).responseName, 'Create');
  assert.equal(execute({ BypassBusinessLogicExecution: 'CustomSync,CustomAsync' }).responseName, 'Create');
  assert.equal(store.tableRows('widget').length, 3);
});

test('a handled SDK missing-row read leaves its enclosing write transaction usable', async () => {
  const store = fixture();
  install(
    store,
    () => {
      assert.throws(
        () =>
          dispatchSdkCall({
            store,
            profile,
            message: {
              method: 'Retrieve',
              userId: user,
              arguments: ['widget', '20000000-0000-0000-0000-000000000099', { allColumns: true }],
            },
          }),
        (error) => error.code === 'NotFound',
      );
    },
    'Create',
  );
  await store.create('widgets', { title: 'Committed after handled read fault' });
  assert.equal(store.tableRows('widget').length, 2);
});

test('an Update PreValidation addition participates in later-stage filtering and rolls back on rejection', async (t) => {
  const store = fixture();
  const early = step('Update', 10),
    filtered = { ...step('Update', 20), filteringAttributes: ['note'] };
  const handlers = new Map([
    [early.id, () => ({ target: { note: 'Added during validation' } })],
    [filtered.id, ({ reject }) => reject('Filtered guard ran')],
  ]);
  const items = pluginCatalogue({ plugins: { steps: [early, filtered] }, handlers });
  const backend = await createOrganizationBackend({ store, items: () => items, handlers });
  t.after(() => backend.close());
  await assert.rejects(store.update('widgets', id, { title: 'Changed' }), /Filtered guard ran/);
  assert.equal(store.tableRows('widget')[0].title, 'Before');
  assert.equal(store.tableRows('widget')[0].note, 'Extra');
});

test(
  'original CLR Retrieve input mutations and real SDK conversion response classes reach the caller',
  { skip: CLR_SKIP },
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-read-mutations-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5 }));
    const sdk = clrSdk(),
      proxy = path.join(path.dirname(sdk), 'Microsoft.Crm.Sdk.Proxy.dll');
    await fs.copyFile(proxy, path.join(directory, path.basename(proxy)));
    const second = '20000000-0000-0000-0000-000000000002';
    const source = path.join(directory, 'ReadInputs.cs'),
      assembly = path.join(directory, 'ReadInputs.dll');
    await fs.writeFile(
      source,
      `using System;using Microsoft.Xrm.Sdk;using Microsoft.Xrm.Sdk.Query;using Microsoft.Crm.Sdk.Messages;
namespace Invented { public sealed class ReadInputs:IPlugin { public void Execute(IServiceProvider p) {
var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));
if(c.MessageName=="RetrieveMultiple"){var q=c.InputParameters["Query"] as QueryExpression;if(q!=null&&q.TopCount==7&&(!q.NoLock||q.QueryHints!="LoopJoin"))throw new Exception("Query options were lost");return;}
if(c.Stage==40){if(c.PrimaryEntityId!=new Guid("${id}")||((EntityReference)c.InputParameters["Target"]).Id!=new Guid("${second}"))throw new Exception("Retrieve changed immutable request identity");return;}
var service=((IOrganizationServiceFactory)p.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId);
var converted=(FetchXmlToQueryExpressionResponse)service.Execute(new FetchXmlToQueryExpressionRequest { FetchXml="<fetch><entity name='widget'><attribute name='title'/></entity></fetch>" });
if(converted.Query.EntityName!="widget")throw new Exception("Conversion lost table");
var reversed=(QueryExpressionToFetchXmlResponse)service.Execute(new QueryExpressionToFetchXmlRequest { Query=converted.Query });
if(!reversed.FetchXml.Contains("widget"))throw new Exception("Conversion lost XML");
((EntityReference)c.InputParameters["Target"]).Id=new Guid("${second}");
((ColumnSet)c.InputParameters["ColumnSet"]).Columns.Add("note");
var change=new Entity("widget",new Guid("${second}"));change["title"]="After";service.Update(change);
} } }`,
    );
    compileClr(source, assembly, { references: [sdk, proxy, 'System.Runtime.Serialization.dll'] });
    const runtime = await prepareClrRuntime({
      trust: 'execute-local-assembly',
      root: directory,
      assembly: path.basename(assembly),
      typeName: 'Invented.ReadInputs',
      dependencies: [path.basename(proxy)],
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(directory, 'cache'),
      serviceProfile: profile,
      context: { initiatingUserId: user, organizationId: user, businessUnitId: user },
      timeoutMs: ORDINARY_CLR_TIMEOUT_MS,
    });
    t.after(() => closeClrHostPool({ runtime }));
    const store = fixture();
    store.state.tables.widget.push({ widgetid: second, title: 'Replacement', note: 'New target' });
    const registration = { ...step('Retrieve'), typeName: 'Invented.ReadInputs', assemblyName: 'ReadInputs' };
    const post = { ...registration, stage: 40, id: '30000000-0000-0000-0000-000000000040' };
    const multiple = { ...registration, message: 'RetrieveMultiple', id: '30000000-0000-0000-0000-000000000021' };
    const runtimes = new Map([
      [registration.id, runtime],
      [post.id, runtime],
      [multiple.id, runtime],
    ]);
    const items = pluginCatalogue({
      plugins: { steps: [registration, post, multiple] },
      runtimes,
      overrides: {
        ['plugin-step:' + registration.id]: { mode: 'clr' },
        ['plugin-step:' + post.id]: { mode: 'clr' },
        ['plugin-step:' + multiple.id]: { mode: 'clr' },
      },
    });
    store.setPluginPipeline(
      (c) => runPluginPhase({ ...c, store, items, runtimes, handlers: new Map() }),
      (c) => ['retrieve', 'retrievemultiple'].includes(c.operation),
    );
    const row = await store.readOperation(() =>
      store.get('widget', id, { admin: true }, { sdkColumns: { allColumns: false, columns: ['title'] } }),
    );
    assert.equal(row.widgetid, second);
    assert.equal(row.title, 'After');
    assert.equal(row.note, 'New target');
    const sdkRetrieved = await store.readOperation(() =>
      dispatchSdkCall({
        store,
        profile,
        message: {
          method: 'Retrieve',
          userId: user,
          arguments: ['widget', { $type: 'Guid', value: id }, { allColumns: false, columns: ['title'] }],
        },
      }),
    );
    assert.equal(sdkRetrieved.id, second);
    assert.equal(sdkRetrieved.attributes.note, 'New target');
    store.state.mappings.widget.relationships = {
      children: { entity: 'child', from: 'widgetid', to: 'widgetid', many: true },
    };
    store.state.mappings.child = { entitySet: 'children', idColumn: 'childid' };
    store.state.tables.child = [{ childid: second, widgetid: id, title: 'Child' }];
    const selected = store.query('widget', { $filter: "children/any(child:child/title eq 'Child')" }, { admin: true });
    assert.deepEqual(
      selected.value.map((item) => item.widgetid),
      [id],
    );
    const optionRead = dispatchSdkCall({
      store,
      profile,
      message: {
        method: 'RetrieveMultiple',
        userId: user,
        arguments: [
          {
            $type: 'QueryExpression',
            entityName: 'widget',
            columnSet: { allColumns: true },
            criteria: { operatorName: 'And', conditions: [], filters: [] },
            topCount: 7,
            noLock: true,
            queryHints: 'LoopJoin',
            orders: [],
            linkEntities: [],
          },
        ],
      },
    });
    assert.equal(optionRead.entities.length, 2);
  },
);

test('a generated-join reducer runs before the backend budget with rebound privilege ordinals', () => {
  const store = fixture();
  store.state.mappings.grant = { entitySet: 'grants', idColumn: 'grantid' };
  store.state.tables.grant = [{ grantid: id, widgetid: id }];
  const link = (alias) =>
    `<link-entity name="grant" from="widgetid" to="widgetid" alias="${alias}" link-type="outer" />`;
  const xml = `<fetch><entity name="widget"><attribute name="widgetid"/>${Array.from({ length: 16 }, (_, i) => link('generated_' + i)).join('')}</entity></fetch>`;
  const reduced = `<fetch><entity name="widget"><attribute name="widgetid"/>${link('generated_0')}</entity></fetch>`;
  const permissionQuery = {
    xml,
    authoredLinkCount: 0,
    permissionLinkCount: 16,
    totalLinkCount: 16,
    generatedLinkOrdinals: Array.from({ length: 16 }, (_, i) => i),
    permissionGranted: true,
    qualification: 'modeled',
    diagnostics: [],
  };
  assert.throws(
    () => store.executePermissionFetchXml(xml, { admin: true }, {}, permissionQuery),
    (error) => error.details?.innerCode === '0x8004430d',
  );
  install(store, () => ({ query: { $type: 'FetchExpression', query: reduced } }));
  assert.deepEqual(
    store.executePermissionFetchXml(xml, { admin: true }, {}, permissionQuery).entities.map((row) => row.widgetid),
    [id],
  );
  assert.deepEqual(rebindPermissionQuery(permissionQuery, reduced).generatedLinkOrdinals, [0]);
  assert.throws(
    () => rebindPermissionQuery(permissionQuery, reduced.replace('name="grant"', 'name="widget"')),
    /link structure/,
  );
});

test('withdrawn Target lookups do not survive through original raw navigation bindings', () => {
  const store = fixture();
  store.state.mappings.widget.relationships = {
    parent: { entity: 'parent', from: 'parentid', to: 'parentid', many: false },
  };
  store.state.mappings.parent = { entitySet: 'parents', idColumn: 'parentid' };
  const original = { 'parent@odata.bind': `parents(${id})`, title: 'Withdrawn', note: 'Retained' };
  assert.deepEqual(
    store.pluginBindingInput(store.resolveMapping('widget'), original, { note: 'Retained' }, { admin: true }),
    { note: 'Retained' },
  );
  const retained = { parentid: { id, logical_name: 'parent' }, note: 'Retained' };
  assert.deepEqual(store.pluginBindingInput(store.resolveMapping('widget'), original, retained, { admin: true }), {
    'parent@odata.bind': `parents(${id})`,
    ...retained,
  });
  store.state.mappings.parent.tableType = 'Elastic';
  store.state.tables.parent = [{ parentid: id, partitionid: 'scoped' }];
  let reads = 0;
  store.setPluginPipeline(
    () => {
      reads++;
    },
    (c) => c.operation === 'retrieve',
  );
  const created = store.createRecord(
    'widget',
    {
      title: 'Elastic binding',
      'parent@odata.bind': `parents(${id})`,
      parentidpid: 'scoped',
    },
    { admin: true },
  );
  assert.equal(created.parentid.id, id);
  assert.equal(created.parentid.partitionid, 'scoped');
  assert.equal(reads, 0, 'Lookup normalization must not dispatch a phantom Retrieve');
});

test('selective SDK bypass respects organization limits and does not propagate into nested requests', async (t) => {
  const store = fixture(),
    first = { ...step('Update'), rank: 1 },
    second = { ...step('Update'), id: '30000000-0000-0000-0000-000000000022', rank: 2 };
  const child = '20000000-0000-0000-0000-000000000002';
  store.state.tables.widget.push({ widgetid: child, title: 'Child' });
  const privileged = { ...profile, privileges: ['prvBypassCustomBusinessLogic'] };
  const seen = [];
  const handlers = new Map([
    [
      first.id,
      (c) => {
        seen.push('first:' + c.record.widgetid);
      },
    ],
    [
      second.id,
      (c) => {
        seen.push('second:' + c.record.widgetid);
        if (c.target.title === 'Outer')
          dispatchSdkCall({
            store,
            profile: privileged,
            message: {
              method: 'Update',
              userId: user,
              arguments: [{ $type: 'Entity', logicalName: 'widget', id: child, attributes: { note: 'Nested' } }],
            },
          });
      },
    ],
  ]);
  const items = pluginCatalogue({ plugins: { steps: [first, second] }, handlers });
  const backend = await createOrganizationBackend({ store, items: () => items, handlers });
  t.after(() => backend.close());
  const invoke = (selectedProfile) =>
    dispatchSdkCall({
      store,
      profile: selectedProfile,
      message: {
        method: 'Execute',
        userId: user,
        arguments: [
          {
            $type: 'OrganizationRequest',
            requestName: 'Update',
            parameters: {
              $type: 'ParameterCollection',
              values: {
                Target: { $type: 'Entity', logicalName: 'widget', id, attributes: { title: 'Outer' } },
                BypassBusinessLogicExecutionStepIds: first.id,
              },
            },
          },
        ],
      },
    });
  assert.throws(
    () => invoke(profile),
    (error) => error.code === 'LocalBackendPermissionDenied',
  );
  assert.equal(store.tableRows('widget')[0].title, 'Before');
  await store.transact(() => invoke(privileged));
  assert.deepEqual(seen, ['second:' + id, 'first:' + child, 'second:' + child]);
  assert.equal(store.tableRows('widget').find((row) => row.widgetid === child).note, 'Nested');
  const four = [first.id, second.id, id, child].join(',');
  assert.throws(
    () => bypassStepIds(store, four),
    (error) => error.details?.innerCode === '0x80097628',
  );
  store.state.tables.organization = [
    {
      organizationid: user,
      orgdborgsettings:
        '<OrgSettings><BypassBusinessLogicExecutionStepIdsLimit>4</BypassBusinessLogicExecutionStepIdsLimit></OrgSettings>',
    },
  ];
  assert.equal(platformValues(store.state).BypassBusinessLogicExecutionStepIdsLimit, 4);
  assert.equal(bypassStepIds(store, four).length, 4);
  store.state.tables.organization[0].orgdborgsettings =
    '<OrgSettings><BypassBusinessLogicExecutionStepIdsLimit>2</BypassBusinessLogicExecutionStepIdsLimit></OrgSettings>';
  assert.throws(() => bypassStepIds(store, four), /exceeds the orgdb settings limit: 2/);
  assert.deepEqual(bypassStepIds(store, first.id.toUpperCase()), [first.id]);
  assert.deepEqual(bypassStepIds(store, ' {' + first.id.toUpperCase() + '} '), []);
  assert.deepEqual(bypassStepIds(store, 'invalid'), []);
  assert.deepEqual(bypassStepIds(store, 'invalid, ' + first.id), [first.id]);
  store.state.tables.organization[0].orgdborgsettings =
    '<OrgSettings><BypassBusinessLogicExecutionStepIdsLimit>3</BypassBusinessLogicExecutionStepIdsLimit></OrgSettings>';
  assert.deepEqual(bypassStepIds(store, ',' + first.id + ','), [first.id]);
  assert.throws(() => bypassStepIds(store, first.id + ',,,'), /number of step ids: 4/);
  assert.throws(
    () => bypassStepIds(store, [first.id, first.id, first.id, first.id].join(',')),
    /number of step ids: 4/,
  );
});

test('read bypass retains source-protected steps and reports unqualified ownership', async (t) => {
  assert.equal(pluginBypassOwnership({ customizationLevel: '' }).kind, 'unknown');
  assert.equal(pluginBypassOwnership({ customizationLevel: 0 }).kind, 'unknown');
  assert.equal(pluginBypassOwnership({ customizationLevel: 1 }).kind, 'unknown');
  assert.equal(
    pluginStepBypassed({ id, bypassOwnership: { kind: 'microsoft' } }, { bypassCustomPlugins: true }, null),
    true,
    'Unproved publisher text cannot establish protection',
  );
  const f = await contractModuleFixture(t, {
    mappings: {
      widget: {
        logicalName: 'widget',
        entitySet: 'widgets',
        idColumn: 'widgetid',
        fields: { title: { dataverseType: 'nvarchar' } },
      },
    },
    tables: { widget: [{ widgetid: id, title: 'Before' }] },
    extension: EXTENSION,
  });
  const registrations = [
    {
      ...step('Retrieve', 40),
      rank: 1,
      customizationLevel: 0,
      bypassOwnership: { kind: 'system', evidence: 'Invented explicitly classified system extension' },
    },
    {
      ...step('Retrieve', 40),
      rank: 2,
      id: '30000000-0000-0000-0000-000000000042',
      bypassOwnership: { kind: 'microsoft', evidence: 'Invented published ownership fixture' },
    },
    { ...step('Retrieve', 40), rank: 3, id: '30000000-0000-0000-0000-000000000043' },
  ];
  const seen = [],
    diagnostics = [];
  const handlers = new Map(
    registrations.map((entry) => [
      entry.id,
      (c) => {
        seen.push(entry.rank);
        return {
          entityResult: { ...c.entityResult, attributes: { ...c.entityResult.attributes, title: String(entry.rank) } },
        };
      },
    ]),
  );
  const items = pluginCatalogue({ plugins: { steps: registrations }, handlers });
  const backend = await createOrganizationBackend({
    store: f.store,
    items: () => items,
    handlers,
    diagnostic: (entry) => diagnostics.push(entry),
  });
  t.after(() => backend.close());
  for (const headers of [
    { 'MSCRM.BypassCustomPluginExecution': 'true' },
    { 'MSCRM.BypassBusinessLogicExecutionStepIds': registrations.map((entry) => entry.id).join(',') },
  ]) {
    seen.length = 0;
    const result = await f.json(await f.request('GET', `/widgets(${id})?$select=title`, null, headers), 200);
    assert.equal(result.title, '2');
    assert.deepEqual(seen, [1, 2]);
  }
  assert.ok(diagnostics.some((entry) => entry.code === 'PLUGIN_BYPASS_OWNERSHIP_UNKNOWN'));
  const privileged = { ...profile, privileges: ['prvBypassCustomPlugins', 'prvBypassCustomBusinessLogic'] };
  for (const parameter of [
    { BypassCustomPluginExecution: true },
    { BypassBusinessLogicExecutionStepIds: registrations.map((entry) => entry.id).join(',') },
  ]) {
    seen.length = 0;
    const result = await f.store.readOperation(() =>
      dispatchSdkCall({
        store: f.store,
        profile: privileged,
        message: {
          method: 'Execute',
          userId: user,
          arguments: [
            {
              $type: 'OrganizationRequest',
              requestName: 'Retrieve',
              parameters: {
                $type: 'ParameterCollection',
                values: {
                  Target: { $type: 'EntityReference', logicalName: 'widget', id },
                  ColumnSet: { $type: 'ColumnSet', allColumns: false, columns: ['title'] },
                  ...parameter,
                },
              },
            },
          ],
        },
      }),
    );
    assert.equal(result.results.Entity.attributes.title, '2');
    assert.deepEqual(seen, [1, 2]);
  }
});

test('SDK read mains include their primary Attribute across raw, organization and virtual projections', async (t) => {
  for (const kind of ['raw', 'organization', 'virtual']) {
    const mappings = {
      widget: {
        logicalName: 'widget',
        entitySet: 'widgets',
        idColumn: 'widgetid',
        fields: {
          title: { dataverseType: 'nvarchar' },
          note: { dataverseType: 'nvarchar' },
          nullable: { dataverseType: 'nvarchar' },
        },
      },
    };
    const row = { widgetid: id, title: 'Before', note: 'Unselected', nullable: null };
    const f =
      kind === 'raw'
        ? { store: fixture() }
        : await contractModuleFixture(t, {
            mappings: {
              widget: { ...mappings.widget, ...(kind === 'virtual' ? { isVirtual: true, tableType: 'Virtual' } : {}) },
            },
            tables: { widget: kind === 'virtual' ? [] : [row] },
            extension: EXTENSION,
            options:
              kind === 'virtual'
                ? {
                    virtualTableProviders: {
                      widget: {
                        retrieveSync: () => ({ ...row }),
                        retrieveMultipleSync: () => [{ ...row }],
                      },
                    },
                  }
                : {},
          });
    if (kind === 'raw') {
      f.store.state.tables.widget[0].nullable = null;
      f.store.state.mappings.widget.fields = mappings.widget.fields;
    }
    const call = (method, args) =>
      dispatchSdkCall({ store: f.store, profile, message: { method, userId: user, arguments: args } });
    for (const columns of [[], ['title'], ['nullable']]) {
      const columnSet = { allColumns: false, columns };
      for (const observe of [false, true]) {
        if (!observe)
          f.store.setPluginPipeline(
            () => {},
            () => false,
          );
        else
          install(
            f.store,
            ({ context }) => {
              const result = context.OutputParameters.BusinessEntity;
              assert.equal(result.widgetid, id, kind);
              assert.equal(Object.hasOwn(result, 'note'), false);
            },
            'Retrieve',
            40,
            true,
          );
        const result = call('Retrieve', ['widget', id, columnSet]);
        assert.equal(result.id, id);
        assert.deepEqual(result.attributes, {
          ...(columns.includes('title') ? { title: 'Before' } : {}),
          widgetid: { $type: 'Guid', value: id },
        });
        for (const type of [
          'QueryExpression',
          'QueryByAttribute',
          ...(kind === 'virtual' ? [] : ['FetchExpression']),
        ]) {
          const query =
            type === 'FetchExpression'
              ? {
                  $type: type,
                  query:
                    '<fetch><entity name="widget"><attribute name="' + (columns[0] ?? 'title') + '"/></entity></fetch>',
                }
              : {
                  $type: type,
                  entityName: 'widget',
                  columnSet,
                  ...(type === 'QueryExpression'
                    ? { criteria: { operatorName: 'And', conditions: [] } }
                    : { attributes: [], values: [] }),
                };
          if (observe)
            install(
              f.store,
              ({ context }) => {
                assert.equal(context.OutputParameters.BusinessEntityCollection[0].widgetid, id, kind + ' ' + type);
              },
              'RetrieveMultiple',
              40,
              true,
            );
          const collection = call('RetrieveMultiple', [query]);
          assert.equal(collection.entities.length, 1);
          assert.equal(collection.entities[0].id, id);
          assert.deepEqual(collection.entities[0].attributes, {
            ...(columns.includes('title') || (type === 'FetchExpression' && !columns.length)
              ? { title: 'Before' }
              : {}),
            widgetid: { $type: 'Guid', value: id },
          });
        }
      }
    }
    for (const observe of [false, true]) {
      if (!observe)
        f.store.setPluginPipeline(
          () => {},
          () => false,
        );
      else
        install(
          f.store,
          ({ query }) => {
            assert.equal(query.columnSet, null);
          },
          'RetrieveMultiple',
          40,
        );
      for (const type of ['QueryExpression', 'QueryByAttribute']) {
        const result = call('RetrieveMultiple', [
          {
            $type: type,
            entityName: 'widget',
            columnSet: null,
            ...(type === 'QueryExpression'
              ? { criteria: { operatorName: 'And', conditions: [] } }
              : { attributes: [], values: [] }),
          },
        ]);
        assert.deepEqual(
          result.entities[0].attributes,
          { widgetid: { $type: 'Guid', value: id } },
          kind + ' nil query ColumnSet',
        );
      }
    }
    if (kind !== 'virtual') {
      for (const query of [
        {
          $type: 'QueryExpression',
          entityName: 'widget',
          distinct: true,
          columnSet: { allColumns: false, columns: ['title'] },
          criteria: { operatorName: 'And', conditions: [] },
        },
        {
          $type: 'FetchExpression',
          query: '<fetch distinct="true"><entity name="widget"><attribute name="title"/></entity></fetch>',
        },
        {
          $type: 'FetchExpression',
          query:
            '<fetch aggregate="true"><entity name="widget"><attribute name="widgetid" alias="records" aggregate="count"/></entity></fetch>',
        },
      ]) {
        install(
          f.store,
          ({ collection }) => {
            assert.equal(collection.entities[0].id, '00000000-0000-0000-0000-000000000000');
            assert.equal(Object.hasOwn(collection.entities[0].attributes, 'widgetid'), false);
          },
          'RetrieveMultiple',
          40,
        );
        const result = call('RetrieveMultiple', [query]).entities[0];
        assert.equal(result.id, '00000000-0000-0000-0000-000000000000');
        assert.equal(Object.hasOwn(result.attributes, 'widgetid'), false);
        assert.equal(
          result.attributes.records?.value ?? result.attributes.title,
          query.query?.includes('aggregate=') ? 1 : 'Before',
        );
      }
    }
    if (kind !== 'virtual') {
      // Native distinct(empty) and distinct(explicit PK) retain identity; only
      // a distinct projection without the primary column has Guid.Empty.
      for (const columns of [[], ['widgetid']]) {
        install(
          f.store,
          ({ collection }) => {
            assert.equal(collection.entities[0].id, id);
            assert.deepEqual(collection.entities[0].attributes, { widgetid: { $type: 'Guid', value: id } });
          },
          'RetrieveMultiple',
          40,
        );
        const result = call('RetrieveMultiple', [
          {
            $type: 'QueryExpression',
            entityName: 'widget',
            distinct: true,
            columnSet: { allColumns: false, columns },
            criteria: { operatorName: 'And', conditions: [] },
          },
        ]).entities[0];
        assert.equal(result.id, id);
        assert.deepEqual(result.attributes, { widgetid: { $type: 'Guid', value: id } });
      }
    }
    if (kind === 'raw') {
      f.store.setPluginPipeline(
        () => {},
        () => false,
      );
      const before = f.store.query('widgets', { $select: 'nullable' }, { admin: true });
      install(f.store, () => {}, 'RetrieveMultiple', 40);
      assert.deepEqual(
        f.store.query('widgets', { $select: 'nullable' }, { admin: true }),
        before,
        'No-op SDK context projection must not remove public null fields',
      );
    } else if (kind === 'organization') {
      for (const [message, path] of [
        ['Retrieve', '/widgets(' + id + ')?$select=nullable'],
        ['RetrieveMultiple', '/widgets?$select=nullable'],
      ]) {
        f.store.setPluginPipeline(
          () => {},
          () => false,
        );
        const before = await f.json(await f.request('GET', path), 200);
        install(f.store, () => {}, message, 40);
        assert.deepEqual(await f.json(await f.request('GET', path), 200), before, 'No-op HTTP null projection');
      }
    }
    for (const method of ['Retrieve', 'RetrieveMultiple']) {
      install(
        f.store,
        ({ entityResult, collection }) => {
          const output = method === 'Retrieve' ? entityResult : collection.entities[0];
          assert.equal(output.attributes.widgetid.value, id);
          delete output.attributes.widgetid;
          output.attributes.nullable = null;
          return method === 'Retrieve' ? { entityResult } : { collection };
        },
        method,
        40,
      );
      const result = call(
        method,
        method === 'Retrieve'
          ? ['widget', id, { allColumns: false, columns: ['title'] }]
          : [
              {
                $type: 'QueryExpression',
                entityName: 'widget',
                columnSet: { allColumns: false, columns: ['title'] },
                criteria: { operatorName: 'And', conditions: [] },
              },
            ],
      );
      const entity = method === 'Retrieve' ? result : result.entities[0];
      assert.equal(entity.id, id);
      assert.deepEqual(
        entity.attributes,
        { title: 'Before', nullable: null },
        'PostOperation primary removal and explicit null must not be reseeded',
      );
    }
  }
});

test('SDK nil query ColumnSets retain their input shape and return only PK; Retrieve null faults before observers', () => {
  const store = fixture();
  let callbacks = 0;
  install(
    store,
    () => {
      callbacks++;
    },
    'Retrieve',
    10,
  );
  assert.throws(
    () =>
      dispatchSdkCall({
        store,
        profile,
        message: { method: 'Retrieve', userId: user, arguments: ['widget', id, null] },
      }),
    (error) =>
      error.status === 400 && error.details.innerCode === '0x80040203' && /ThrowIfNull: columnSet/.test(error.message),
  );
  assert.equal(callbacks, 0);
  for (const type of ['QueryExpression', 'QueryByAttribute']) {
    const source = {
      $type: type,
      entityName: 'widget',
      columnSet: null,
      ...(type === 'QueryExpression'
        ? { criteria: { operatorName: 'And', conditions: [] } }
        : { attributes: [], values: [] }),
    };
    install(
      store,
      ({ query }) => {
        assert.equal(query.columnSet, null);
        callbacks++;
      },
      'RetrieveMultiple',
      40,
    );
    const answer = dispatchSdkCall({
      store,
      profile,
      message: { method: 'RetrieveMultiple', userId: user, arguments: [source] },
    });
    assert.equal(answer.entities[0].id, id);
    assert.deepEqual(answer.entities[0].attributes, { widgetid: { $type: 'Guid', value: id } });
  }
  assert.equal(callbacks, 2);
});
