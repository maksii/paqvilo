import test from 'node:test';
import { ORDINARY_CLR_TIMEOUT_MS } from './fixtures/clr-budget.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DataStore } from '../lib/data.mjs';
import { dispatchSdkCall, prepareClrRuntime } from '../lib/plugin-clr.mjs';
import { pluginCatalogue, runPluginPhase } from '../lib/exported-plugins.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
const user = '10000000-0000-0000-0000-000000000001',
  id = '20000000-0000-0000-0000-000000000001';
const profile = {
  userId: user,
  evidence: 'Invented named SDK Execute proof',
  grants: [{ entity: 'secondary', operations: ['read', 'create', 'update', 'delete'] }],
};
const storeOf = () =>
  new DataStore({
    state: {
      version: 1,
      mappings: {
        widget: { entitySet: 'widgets', idColumn: 'widgetid' },
        secondary: { entitySet: 'secondaries', idColumn: 'secondaryid' },
      },
      tables: { widget: [], secondary: [{ secondaryid: id, title: 'Before' }] },
      permissions: [{ entity: 'widget', scope: 'global', roles: ['Editor'], operations: ['create', 'read'] }],
      plugins: [],
      settings: { permissionMode: 'enforce' },
    },
  });
const entity = (attributes) => ({ $type: 'Entity', logicalName: 'secondary', id, attributes });
const request = (requestName, values) => ({
  $type: 'OrganizationRequest',
  requestName,
  parameters: { $type: 'ParameterCollection', values },
});
const invoke = (store, value) =>
  dispatchSdkCall({ store, profile, message: { method: 'Execute', userId: user, arguments: [value] } });

test('Named SDK Execute validates parameter contracts before writes and retains typed responses', () => {
  const store = storeOf(),
    before = store.snapshot();
  assert.throws(
    () =>
      invoke(
        store,
        request('Create', { Target: entity({ title: 'Untrusted override' }), BypassCustomPluginExecution: true }),
      ),
    /Unsupported SDK Execute/,
  );
  assert.throws(() => invoke(store, request('ExecuteTransaction', { Requests: [] })), /Unsupported SDK Execute/);
  assert.deepEqual(store.snapshot(), before);
  const retrieved = invoke(
    store,
    request('Retrieve', {
      Target: { $type: 'EntityReference', logicalName: 'secondary', id },
      ColumnSet: { $type: 'ColumnSet', columns: ['title'] },
    }),
  );
  assert.equal(retrieved.responseName, 'Retrieve');
  assert.equal(retrieved.results.Entity.id, id);
  const updated = invoke(store, request('Update', { Target: entity({ title: 'Changed' }) }));
  assert.deepEqual(updated, { $type: 'OrganizationResponse', responseName: 'Update', results: {} });
  assert.equal(store.snapshot().tables.secondary[0].title, 'Changed');
  store.pluginReadOnly = true;
  assert.equal(
    invoke(
      store,
      request('Retrieve', {
        Target: { $type: 'EntityReference', logicalName: 'secondary', id },
        ColumnSet: { $type: 'ColumnSet', columns: [] },
      }),
    ).results.Entity.id,
    id,
  );
  assert.throws(
    () => invoke(store, request('Delete', { Target: { $type: 'EntityReference', logicalName: 'secondary', id } })),
    /serialized read-operation/,
  );
  assert.equal(store.snapshot().tables.secondary.length, 1);
});

test(
  'Original DLL casts named SDK Execute responses and secondary writes retain caller rollback',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-sdk-execute-'));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const sdk = clrSdk(),
      source = path.join(root, 'ExecuteOriginal.cs'),
      assembly = path.join(root, 'ExecuteOriginal.dll');
    await fs.writeFile(
      source,
      `using System;using Microsoft.Xrm.Sdk;using Microsoft.Xrm.Sdk.Messages;using Microsoft.Xrm.Sdk.Query;
namespace Invented {public sealed class ExecuteOriginal:IPlugin {public void Execute(IServiceProvider services){
var c=(IPluginExecutionContext)services.GetService(typeof(IPluginExecutionContext));var target=(Entity)c.InputParameters["Target"];
var s=((IOrganizationServiceFactory)services.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId);
var transient=new Entity("secondary");transient["title"]="Transient";var created=(CreateResponse)s.Execute(new CreateRequest{Target=transient});if(created.id==Guid.Empty)throw new Exception("Untyped CreateResponse");
var received=(RetrieveResponse)s.Execute(new RetrieveRequest{Target=new EntityReference("secondary",new Guid("${id}")),ColumnSet=new ColumnSet("title")});if(received.Entity.Id!=new Guid("${id}"))throw new Exception("Retrieve identity lost");
received.Entity["title"]="Execute changed";var updated=(UpdateResponse)s.Execute(new UpdateRequest{Target=received.Entity});
var q=new QueryExpression("secondary"){ColumnSet=new ColumnSet("title")};q.Criteria.AddCondition("title",ConditionOperator.Equal,"Execute changed");var multiple=(RetrieveMultipleResponse)s.Execute(new RetrieveMultipleRequest{Query=q});if(multiple.EntityCollection.Entities.Count!=1||multiple.EntityCollection.Entities[0].Id==Guid.Empty)throw new Exception("Untyped RetrieveMultipleResponse");
var deleted=(DeleteResponse)s.Execute(new DeleteRequest{Target=new EntityReference("secondary",created.id)});
((ITracingService)services.GetService(typeof(ITracingService))).Trace("Original typed Execute completed");if(target.GetAttributeValue<string>("title")=="reject")throw new InvalidPluginExecutionException("Original Execute rejected after write");
}}}`,
    );
    compileClr(source, assembly, { references: [sdk] });
    const runtime = await prepareClrRuntime({
      trust: 'execute-local-assembly',
      root,
      assembly: path.basename(assembly),
      typeName: 'Invented.ExecuteOriginal',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, '.paqvilo/cache'),
      serviceProfile: profile,
      context: {
        initiatingUserId: user,
        organizationId: '50000000-0000-0000-0000-000000000001',
        businessUnitId: '60000000-0000-0000-0000-000000000001',
      },
      timeoutMs: ORDINARY_CLR_TIMEOUT_MS,
    });
    const store = storeOf(),
      notes = [],
      step = {
        id: '30000000-0000-0000-0000-000000000001',
        name: 'Invented Execute',
        assemblyId: 'invented-execute',
        enabled: true,
        entity: 'widget',
        message: 'Create',
        stage: 20,
        rank: 1,
        mode: 0,
        supportedDeployment: 0,
        filteringAttributes: [],
        images: [],
        typeName: 'Invented.ExecuteOriginal',
      },
      runtimes = new Map([[step.id, runtime]]);
    store.setPluginPipeline((context) =>
      runPluginPhase({
        ...context,
        store,
        runtimes,
        items: pluginCatalogue({
          plugins: { steps: [step] },
          runtimes,
          overrides: { ['plugin-step:' + step.id]: { mode: 'clr' } },
        }),
        diagnostic: (note) => notes.push(note),
      }),
    );
    store.file = path.join(root, 'state.json');
    await store.save();
    const before = store.snapshot();
    await assert.rejects(
      store.create('widget', { title: 'reject' }, { roles: ['Editor'] }),
      /Original Execute rejected after write/,
    );
    assert.deepEqual(store.snapshot(), before);
    assert.deepEqual(JSON.parse(await fs.readFile(store.file, 'utf8')).tables.secondary, before.tables.secondary);
    await store.create('widget', { title: 'accepted' }, { roles: ['Editor'] });
    assert.equal(store.snapshot().tables.secondary[0].title, 'Execute changed');
    assert.equal(store.snapshot().tables.secondary.length, 1);
    assert.ok(notes.some((note) => note.message === 'Original typed Execute completed'));
    const hosts = notes.filter((note) => note.code === 'PLUGIN_CLR_HOST_STOPPED');
    assert.equal(hosts.length, 2);
    assert.ok(hosts.every((note) => note.absenceVerified));
    if (process.env.PAQ_TEST_CLR_EVIDENCE) {
      const hash = async (file) =>
          createHash('sha256')
            .update(await fs.readFile(file))
            .digest('hex'),
        hosts = notes.filter((note) => note.code === 'PLUGIN_CLR_HOST_STOPPED');
      await fs.writeFile(
        path.resolve(process.env.PAQ_TEST_CLR_EVIDENCE) + '.execute.json',
        JSON.stringify(
          {
            schemaVersion: 1,
            generatedAt: new Date().toISOString(),
            scope: 'Actual compiled invented original DLL; no native organization execution',
            originalSourceSha256: await hash(source),
            originalAssemblySha256: await hash(assembly),
            sdkAssemblySha256: await hash(sdk),
            ownedHosts: { stopped: hosts.length, allAbsenceVerified: hosts.every((note) => note.absenceVerified) },
            assertionScopes: ['Actual named SDK response casts', 'Caller rollback retains saved secondary state'],
            nativeQualified: false,
          },
          null,
          2,
        ) + '\n',
        { flag: 'wx' },
      );
    }
  },
);
