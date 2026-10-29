import test from 'node:test';
import { ORDINARY_CLR_TIMEOUT_MS } from './fixtures/clr-budget.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DataStore } from '../lib/data.mjs';
import { prepareClrRuntime, dispatchSdkCall } from '../lib/plugin-clr.mjs';
import { pluginCatalogue, runPluginPhase } from '../lib/exported-plugins.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const guid = (n) => `20000000-0000-0000-0000-${String(n).padStart(12, '0')}`,
  user = guid(1),
  existing = guid(2),
  created = guid(3),
  bulk1 = guid(4),
  bulk2 = guid(5);
const profile = {
  userId: user,
  evidence: 'Invented compiled pre-only caller contract',
  grants: [
    { entity: 'secondary', operations: ['create', 'read', 'update', 'delete'] },
    { entity: 'bulkitem', operations: ['create', 'read', 'update'] },
  ],
  bulkTables: [
    {
      entity: 'bulkitem',
      tableType: 'standard',
      messages: ['CreateMultiple', 'UpdateMultiple'],
      evidence: 'Invented standard bulk table',
    },
  ],
};
const data = () =>
  new DataStore({
    state: {
      version: 1,
      mappings: Object.fromEntries(
        ['widget', 'secondary', 'bulkitem'].map((entity) => [
          entity,
          { entitySet: entity + 's', idColumn: entity + 'id' },
        ]),
      ),
      tables: { widget: [], secondary: [{ secondaryid: existing, title: 'Stored' }], bulkitem: [] },
      permissions: [],
      plugins: [],
      settings: { permissionMode: 'permissive' },
    },
  });
const step = (n, entity, message, typeName, stage = 20, rank = 1) => ({
  id: guid(100 + n),
  enabled: true,
  entity,
  message,
  typeName: 'Invented.' + typeName,
  assemblyId: 'invented-main-response',
  assemblyName: 'MainResponse',
  stage,
  rank,
  mode: 0,
  supportedDeployment: 0,
  filteringAttributes: [],
  images: [],
});

test('Handler-only pre-operation mutations retain SDK main results with no matching post step', () => {
  const store = data(),
    row = step(1, 'secondary', 'Create', 'Handler'),
    handlers = new Map([[row.id, () => ({ target: { title: 'Handler persisted' } })]]),
    items = pluginCatalogue({ plugins: { steps: [row] }, handlers });
  store.setPluginPipeline((context) => runPluginPhase({ ...context, store, items, handlers }));
  const result = dispatchSdkCall({
    store,
    profile,
    message: {
      method: 'Create',
      userId: user,
      arguments: [{ $type: 'Entity', logicalName: 'secondary', id: created, attributes: { title: 'Submitted' } }],
    },
  });
  assert.equal(result.value, created);
  assert.equal(store.snapshot().tables.secondary.find((row) => row.secondaryid === created).title, 'Handler persisted');
  const selected = dispatchSdkCall({
    store,
    profile,
    message: {
      method: 'RetrieveMultiple',
      userId: user,
      arguments: [{ $type: 'QueryExpression', entityName: 'secondary', columnSet: { columns: ['title'] } }],
    },
  });
  assert.equal(selected.entities.length, 2);
  assert.ok(selected.entities.every((row) => row.id && !Object.hasOwn(row.attributes, 'secondaryid')));
});

test(
  'Original pre-only DLL callers receive actual main CRUD/read/bulk results and custom outputs without post registrations',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-main-response-'));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const sdk = clrSdk(),
      source = path.join(root, 'MainResponse.cs'),
      assembly = path.join(root, 'MainResponse.dll');
    await fs.writeFile(
      source,
      `using System;using Microsoft.Xrm.Sdk;using Microsoft.Xrm.Sdk.Messages;using Microsoft.Xrm.Sdk.Query;
namespace Invented {
public sealed class Pre:IPlugin {public void Execute(IServiceProvider services){var c=(IPluginExecutionContext)services.GetService(typeof(IPluginExecutionContext));if(c.Stage!=20)throw new Exception("Pre-only registration expected");c.OutputParameters["custom"]=new Money(19.25m);if(c.MessageName=="Create"||c.MessageName=="Update")((Entity)c.InputParameters["Target"])["title"]="Pre changed";else if(c.MessageName=="CreateMultiple"||c.MessageName=="UpdateMultiple")foreach(var e in ((EntityCollection)c.InputParameters["Targets"]).Entities)e["title"]="Pre bulk changed";}}
public sealed class Caller:IPlugin {
static Entity Row(string table,Guid id,string title){var e=new Entity(table,id);e["title"]=title;return e;}
static void Custom(OrganizationResponse r){if(!r.Results.Contains("custom")||((Money)r.Results["custom"]).Value!=19.25m)throw new Exception("Pre custom output missing");}
static void Read(Entity e){if(e==null||e.Id!=new Guid("${existing}")||e.GetAttributeValue<string>("title")!="Stored")throw new Exception("Main Retrieve output missing or stale");}
public void Execute(IServiceProvider services){var c=(IPluginExecutionContext)services.GetService(typeof(IPluginExecutionContext));var target=(Entity)c.InputParameters["Target"];var mode=target.GetAttributeValue<string>("title");var s=((IOrganizationServiceFactory)services.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId);
if(mode=="create-direct"){var id=s.Create(Row("secondary",new Guid("${created}"),"Submitted"));if(id!=new Guid("${created}")||s.Retrieve("secondary",id,new ColumnSet("title")).GetAttributeValue<string>("title")!="Pre changed")throw new Exception("Direct main Create id missing or wrong row");}
else if(mode=="create-named"){var r=(CreateResponse)s.Execute(new CreateRequest{Target=Row("secondary",new Guid("${created}"),"Submitted")});Custom(r);if(r.id!=new Guid("${created}")||s.Retrieve("secondary",r.id,new ColumnSet("title")).GetAttributeValue<string>("title")!="Pre changed")throw new Exception("Named main Create id missing or wrong row");}
else if(mode=="retrieve-direct")Read(s.Retrieve("secondary",new Guid("${existing}"),new ColumnSet("title")));
else if(mode=="retrieve-named"){var r=(RetrieveResponse)s.Execute(new RetrieveRequest{Target=new EntityReference("secondary",new Guid("${existing}")),ColumnSet=new ColumnSet("title")});Custom(r);Read(r.Entity);}
else if(mode=="multiple-direct"){var rows=s.RetrieveMultiple(new QueryExpression("secondary"){ColumnSet=new ColumnSet("title")});if(rows==null||rows.Entities.Count!=1)throw new Exception("Direct main collection missing");Read(rows.Entities[0]);}
else if(mode=="multiple-named"){var r=(RetrieveMultipleResponse)s.Execute(new RetrieveMultipleRequest{Query=new QueryExpression("secondary"){ColumnSet=new ColumnSet("title")}});Custom(r);if(r.EntityCollection==null||r.EntityCollection.Entities.Count!=1)throw new Exception("Named main collection missing");Read(r.EntityCollection.Entities[0]);}
else if(mode=="update-named"){var r=(UpdateResponse)s.Execute(new UpdateRequest{Target=Row("secondary",new Guid("${existing}"),"Submitted")});Custom(r);if(s.Retrieve("secondary",new Guid("${existing}"),new ColumnSet("title")).GetAttributeValue<string>("title")!="Pre changed")throw new Exception("Update persisted wrong target");}
else if(mode=="delete-named"){var r=(DeleteResponse)s.Execute(new DeleteRequest{Target=new EntityReference("secondary",new Guid("${existing}"))});Custom(r);if(s.RetrieveMultiple(new QueryExpression("secondary")).Entities.Count!=0)throw new Exception("Delete did not persist");}
else if(mode=="bulk"){var r=(CreateMultipleResponse)s.Execute(new CreateMultipleRequest{Targets=new EntityCollection(new[]{Row("bulkitem",new Guid("${bulk1}"),"First"),Row("bulkitem",new Guid("${bulk2}"),"Second")})});Custom(r);if(r.Ids.Length!=2||r.Ids[0]!=new Guid("${bulk1}")||r.Ids[1]!=new Guid("${bulk2}"))throw new Exception("Main bulk ids missing");foreach(var id in r.Ids)if(s.Retrieve("bulkitem",id,new ColumnSet("title")).GetAttributeValue<string>("title")!="Pre bulk changed")throw new Exception("Bulk returned ids differ from saved rows");var u=(UpdateMultipleResponse)s.Execute(new UpdateMultipleRequest{Targets=new EntityCollection(new[]{Row("bulkitem",r.Ids[0],"Update")})});Custom(u);}
else throw new Exception("Unknown invented case");target["status"]="passed:"+mode;((ITracingService)services.GetService(typeof(ITracingService))).Trace("Main response passed {0}",mode);}}
}`,
    );
    compileClr(source, assembly, { references: [sdk, 'System.Runtime.Serialization.dll'] });
    const descriptor = (typeName) => ({
      trust: 'execute-local-assembly',
      root,
      assembly: path.basename(assembly),
      typeName: 'Invented.' + typeName,
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, 'cache'),
      serviceProfile: profile,
      context: { initiatingUserId: user, organizationId: user, businessUnitId: user },
      timeoutMs: ORDINARY_CLR_TIMEOUT_MS,
    });
    const caller = await prepareClrRuntime(descriptor('Caller')),
      pre = await prepareClrRuntime(descriptor('Pre')),
      steps = [step(1, 'widget', 'Create', 'Caller')];
    let sequence = 1;
    for (const [entity, messages] of [
      ['secondary', ['Create', 'Update', 'Delete', 'Retrieve', 'RetrieveMultiple']],
      ['bulkitem', ['CreateMultiple', 'UpdateMultiple']],
    ])
      for (const message of messages) steps.push(step(++sequence, entity, message, 'Pre'));
    const runtimes = new Map(steps.map((row) => [row.id, row.entity === 'widget' ? caller : pre])),
      items = pluginCatalogue({
        plugins: { steps },
        runtimes,
        overrides: Object.fromEntries(steps.map((row) => ['plugin-step:' + row.id, { mode: 'clr' }])),
      }),
      notes = [];
    for (const mode of [
      'create-direct',
      'create-named',
      'retrieve-direct',
      'retrieve-named',
      'multiple-direct',
      'multiple-named',
      'update-named',
      'delete-named',
      'bulk',
    ]) {
      const store = data();
      store.setPluginPipeline(
        (context) =>
          runPluginPhase({
            ...context,
            store,
            items,
            runtimes,
            handlers: new Map(),
            diagnostic: (note) => notes.push(note),
          }),
        (context) =>
          steps.some((row) => row.entity === context.entity && row.message.toLowerCase() === context.operation),
      );
      let row;
      try {
        row = await store.create('widgets', { title: mode });
      } catch (error) {
        error.message = 'Scenario ' + mode + ': ' + error.message;
        throw error;
      }
      assert.equal(row.status, 'passed:' + mode);
      assert.ok(row.widgetid);
      if (mode === 'create-direct' || mode === 'create-named')
        assert.equal(store.snapshot().tables.secondary.find((row) => row.secondaryid === created).title, 'Pre changed');
    }
    const started = notes.filter((note) => note.code === 'PLUGIN_CLR_HOST_STARTED'),
      stopped = notes.filter((note) => note.code === 'PLUGIN_CLR_HOST_STOPPED');
    assert.equal(started.length, 23, 'one owned host per CLR step invocation of the scenarios above');
    assert.equal(started.length, stopped.length);
    assert.ok(stopped.every((note) => note.absenceVerified));
  },
);
