// @test-kind unproven: local model of elastic-table key and partition addressing, typed lookup partitions and the 500-row fetch page; no native capture
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DataStore, emptyState } from '../lib/data.mjs';
import { localOrganizationService, sdkValueToRecord } from '../lib/local-organization-service.mjs';
import { dispatchSdkCall, recordToSdkEntity, prepareClrRuntime } from '../lib/plugin-clr.mjs';
import { pluginCatalogue, runPluginPhase } from '../lib/exported-plugins.mjs';
import { builtInKey } from '../lib/dataverse-elastic.mjs';
import { ORDINARY_CLR_TIMEOUT_MS } from './fixtures/clr-budget.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const user = '10000000-0000-4000-8000-000000000001',
  id = '20000000-0000-4000-8000-000000000001',
  zero = '00000000-0000-0000-0000-000000000000';
const guid = (value) => ({ $type: 'Guid', value });
const keys = (partitionid) => ({ readingid: guid(id), partitionid });
const reference = (partitionid) => ({
  $type: 'EntityReference',
  logicalName: 'reading',
  id: zero,
  keyAttributes: keys(partitionid),
});
const profile = {
  userId: user,
  evidence: 'Invented local elastic profile',
  grants: [
    { entity: 'reading', operations: ['read', 'create', 'update', 'delete'] },
    { entity: 'widget', operations: ['read', 'create', 'update', 'delete'] },
  ],
};
function fixture() {
  const state = emptyState();
  state.mappings.reading = {
    entitySet: 'readings',
    idColumn: 'readingid',
    nameColumn: 'name',
    tableType: 'Elastic',
    alternateKeys: [builtInKey('readingid')],
    fields: { name: { dataverseType: 'nvarchar' }, partitionid: { dataverseType: 'nvarchar' } },
  };
  state.mappings.widget = {
    entitySet: 'widgets',
    idColumn: 'widgetid',
    fields: {
      name: { dataverseType: 'nvarchar' },
      readingid: { dataverseType: 'lookup', targets: ['reading'] },
      readingidpid: { dataverseType: 'nvarchar' },
    },
    relationships: { readingid: { entity: 'reading', from: 'readingid', to: 'readingid', many: false } },
  };
  state.tables.reading = [
    { readingid: id, partitionid: 'A', name: 'Partition A' },
    { readingid: id, partitionid: 'B', name: 'Partition B' },
  ];
  state.tables.widget = [];
  return new DataStore({ state });
}
const execute = (store, name, values) =>
  dispatchSdkCall({
    store,
    profile,
    message: {
      userId: user,
      method: 'Execute',
      arguments: [
        { $type: 'OrganizationRequest', requestName: name, parameters: { $type: 'ParameterCollection', values } },
      ],
    },
  });

test('SDK EntityReference alternate keys and optional partitions select, update and delete only their addressed row', () => {
  const store = fixture();
  const selected = execute(store, 'Retrieve', {
    Target: reference('B'),
    ColumnSet: { allColumns: true },
    SessionToken: 'local-session',
  });
  assert.equal(selected.results.Entity.attributes.name, 'Partition B');
  execute(store, 'Update', {
    Target: {
      $type: 'Entity',
      logicalName: 'reading',
      id: zero,
      keyAttributes: keys('B'),
      attributes: { name: 'Changed B' },
    },
  });
  assert.equal(store.get('reading', id, { admin: true }, { partitionId: 'B' }).name, 'Changed B');
  assert.equal(store.get('reading', id, { admin: true }, { partitionId: 'A' }).name, 'Partition A');
  execute(store, 'Delete', { Target: { $type: 'EntityReference', logicalName: 'reading', id }, partitionId: 'A' });
  assert.equal(store.get('reading', id, { admin: true }, { partitionId: 'A' }), null);
  assert.ok(store.get('reading', id, { admin: true }, { partitionId: 'B' }));
});
test('SDK typed lookup keys preserve their partition and missing partitions never borrow another row name', () => {
  const store = fixture(),
    service = localOrganizationService(store, profile);
  const row = service.create('widget', { name: 'Linked', readingid: sdkValueToRecord(reference('B')) });
  assert.equal(row.readingid.id, id);
  assert.equal(row.readingidpid, 'B');
  assert.equal(recordToSdkEntity(store, 'widget', row).attributes.readingid.name, 'Partition B');
  const unresolved = service.create('widget', { name: 'Unresolved', readingid: { id, logical_name: 'reading' } });
  assert.equal(unresolved.readingidpid, null);
  assert.equal(recordToSdkEntity(store, 'widget', unresolved).attributes.readingid.name, null);
});
test('local SDK FetchXML uses elastic default and maximum page/count size 500', () => {
  const store = fixture(),
    service = localOrganizationService(store, profile);
  for (let index = 0; index < 501; index++)
    store.state.tables.reading.push({
      readingid: `30000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      name: 'Paged',
      partitionid: 'page',
    });
  const xml =
    '<fetch count="9999" returntotalrecordcount="true"><entity name="reading"><attribute name="readingid"/><filter><condition attribute="partitionid" operator="eq" value="page"/></filter></entity></fetch>';
  const first = service.fetch(xml, { sdkResult: true });
  assert.equal(first.entities.length, 500);
  assert.equal(first.total_record_count, 500);
  assert.equal(first.total_record_count_limit_exceeded, true);
  assert.equal(first.more_records, true);
  const second = service.fetch(xml.replace('count="9999"', 'count="9999" page="2"'), { sdkResult: true });
  assert.equal(second.entities.length, 1);
});
test(
  'an original .NET plugin forwards elastic key attributes through the real CLR host',
  { skip: CLR_SKIP },
  async (t) => {
    const sdk = clrSdk(),
      root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-clr-elastic-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const source = path.join(root, 'Elastic.cs'),
      assembly = path.join(root, 'Elastic.dll');
    await fs.writeFile(
      source,
      `using System;using Microsoft.Xrm.Sdk;using Microsoft.Xrm.Sdk.Query;using Microsoft.Xrm.Sdk.Messages;
namespace Invented{public sealed class Elastic:IPlugin{public void Execute(IServiceProvider services){
var c=(IPluginExecutionContext)services.GetService(typeof(IPluginExecutionContext));var s=((IOrganizationServiceFactory)services.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId);
var keys=new KeyAttributeCollection{{"readingid",new Guid("${id}")},{"partitionid","B"}};
var request=new RetrieveRequest{Target=new EntityReference("reading",keys),ColumnSet=new ColumnSet("name")};request["SessionToken"]="local-session";
var before=((RetrieveResponse)s.Execute(request)).Entity.GetAttributeValue<string>("name");
var update=new Entity("reading",keys);update["name"]="Changed B";s.Update(update);
var byPartition=new RetrieveRequest{Target=new EntityReference("reading",new Guid("${id}")),ColumnSet=new ColumnSet("name")};byPartition["partitionId"]="A";
if(((RetrieveResponse)s.Execute(byPartition)).Entity.GetAttributeValue<string>("name")!="Partition A")throw new InvalidPluginExecutionException("Wrong optional partition");
var delete=new DeleteRequest{Target=new EntityReference("reading",new Guid("${id}"))};delete["partitionId"]="A";s.Execute(delete);
var after=((RetrieveResponse)s.Execute(request)).Entity.GetAttributeValue<string>("name");((Entity)c.InputParameters["Target"])["name"]=before+"|"+after;
}}}`,
    );
    compileClr(source, assembly, { references: [sdk] });
    const runtime = await prepareClrRuntime({
      trust: 'execute-local-assembly',
      root,
      assembly: 'Elastic.dll',
      typeName: 'Invented.Elastic',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, '.paqvilo/cache'),
      serviceProfile: profile,
      context: { initiatingUserId: user, organizationId: user, businessUnitId: user },
      timeoutMs: ORDINARY_CLR_TIMEOUT_MS,
    });
    const store = fixture(),
      step = {
        id: '40000000-0000-4000-8000-000000000001',
        name: 'Invented elastic SDK caller',
        enabled: true,
        typeName: 'Invented.Elastic',
        assemblyId: 'invented',
        entity: 'widget',
        message: 'Create',
        stage: 20,
        rank: 1,
        mode: 0,
        supportedDeployment: 0,
        filteringAttributes: [],
        images: [],
      },
      runtimes = new Map([[step.id, runtime]]),
      handlers = new Map();
    store.setPluginPipeline(
      (context) =>
        runPluginPhase({
          ...context,
          store,
          runtimes,
          handlers,
          items: pluginCatalogue({
            plugins: { steps: [step] },
            handlers,
            runtimes,
            overrides: { ['plugin-step:' + step.id]: { mode: 'clr' } },
          }),
        }),
      (frame) => frame.entity === 'widget' && frame.operation === 'create',
    );
    const created = await store.create('widget', { name: 'Before' }, { admin: true });
    assert.equal(created.name, 'Partition B|Changed B');
    assert.equal(store.get('reading', id, { admin: true }, { partitionId: 'A' }), null);
    assert.equal(store.get('reading', id, { admin: true }, { partitionId: 'B' }).name, 'Changed B');
  },
);
