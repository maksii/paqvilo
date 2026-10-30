import test from 'node:test';
import { ORDINARY_CLR_TIMEOUT_MS } from './fixtures/clr-budget.mjs';
import { CLR_SKIP, clrSdk, compileClr, retypeClrRuntime } from './fixtures/clr-sdk.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DataStore } from '../lib/data.mjs';
import { localOrganizationService } from '../lib/local-organization-service.mjs';
import { dispatchSdkCall, prepareClrRuntime } from '../lib/plugin-clr.mjs';
import { pluginCatalogue, runPluginPhase } from '../lib/exported-plugins.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
const user = '10000000-0000-0000-0000-000000000001',
  id = '20000000-0000-0000-0000-000000000001',
  empty = '00000000-0000-0000-0000-000000000000';
const profile = {
  userId: user,
  evidence: 'Invented standard-table bulk source',
  grants: [{ entity: 'secondary', operations: ['read', 'create', 'update', 'delete'] }],
  bulkTables: [
    {
      entity: 'secondary',
      tableType: 'standard',
      evidence: 'Invented standard-table message availability',
      messages: ['CreateMultiple', 'UpdateMultiple'],
    },
  ],
};
const storeOf = () =>
  new DataStore({
    state: {
      version: 1,
      mappings: {
        widget: { entitySet: 'widgets', idColumn: 'widgetid' },
        secondary: { entitySet: 'secondaries', idColumn: 'secondaryid' },
      },
      tables: { widget: [], secondary: [{ secondaryid: id, title: 'Before', keep: 'Original' }] },
      permissions: [{ entity: 'widget', scope: 'global', roles: ['Editor'], operations: ['create', 'read'] }],
      plugins: [],
      settings: { permissionMode: 'enforce' },
    },
  });
const entity = (attributes, id_ = empty) => ({ $type: 'Entity', logicalName: 'secondary', id: id_, attributes });
const invoke = (store, name, entities) =>
  dispatchSdkCall({
    store,
    profile,
    message: {
      method: 'Execute',
      userId: user,
      arguments: [
        {
          $type: 'OrganizationRequest',
          requestName: name,
          parameters: { $type: 'ParameterCollection', values: { Targets: { $type: 'EntityCollection', entities } } },
        },
      ],
    },
  });

test('standard bulk does not mistake the recommended batch size for a 1000-record limit', async () => {
  const store = storeOf();
  await store.transact(() =>
    invoke(
      store,
      'CreateMultiple',
      Array.from({ length: 1001 }, (_, index) => entity({ title: `Invented ${index}` })),
    ),
  );
  assert.equal(store.tableRows('secondary').length, 1002);
});

test('Standard bulk validates all identities/security before writing and preserves atomic failure', async () => {
  const store = storeOf(),
    before = store.snapshot();
  assert.throws(
    () =>
      invoke(store, 'UpdateMultiple', [
        entity({ title: 'Changed' }, id),
        entity({ title: 'Missing' }, '20000000-0000-0000-0000-000000000099'),
      ]),
    /not found/,
  );
  const repeated = storeOf();
  invoke(repeated, 'UpdateMultiple', [entity({ title: 'First' }, id), entity({ title: 'Second' }, id)]);
  assert.equal(repeated.tableRows('secondary')[0].title, 'First');
  assert.throws(
    () => invoke(store, 'CreateMultiple', [entity({}), { ...entity({}), logicalName: 'widget' }]),
    /one exact logical table/,
  );
  assert.throws(
    () => localOrganizationService(store, { ...profile, bulkTables: undefined }).bulk('createmultiple', [entity({})]),
    /source-evidenced/,
  );
  assert.throws(
    () =>
      localOrganizationService(store, { ...profile, bulkTables: [{ ...profile.bulkTables[0], tableType: 'elastic' }] }),
    /standard tables/,
  );
  assert.deepEqual(store.snapshot(), before);
  let calls = 0;
  store.setPluginPipeline(
    (context) => {
      if (context.stage === 40) {
        calls++;
        throw new Error('bulk rejected');
      }
    },
    (context) => context.operation === 'createmultiple',
  );
  await assert.rejects(
    store.transact(() => invoke(store, 'CreateMultiple', [entity({ title: 'one' }), entity({ title: 'two' })])),
    /bulk rejected/,
  );
  assert.equal(calls, 1);
  assert.deepEqual(store.snapshot(), before);
  store.setPluginPipeline(
    () => {},
    () => true,
  );
  assert.throws(() => invoke(store, 'CreateMultiple', [entity({ title: 'mixed' })]), /merged-pipeline ordering/);
  assert.deepEqual(store.snapshot(), before);
});

test(
  'Original bulk PreOperation SDK changes cannot retain a stale backend grant on any target',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-bulk-grant-'));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const sdk = clrSdk(),
      source = path.join(root, 'BulkGrant.cs'),
      assembly = path.join(root, 'BulkGrant.dll'),
      second = '20000000-0000-0000-0000-000000000002';
    await fs.writeFile(
      source,
      `using System;using Microsoft.Xrm.Sdk;using Microsoft.Xrm.Sdk.Messages;
namespace Invented {public sealed class Driver:IPlugin {public void Execute(IServiceProvider services){var c=(IPluginExecutionContext)services.GetService(typeof(IPluginExecutionContext));var s=((IOrganizationServiceFactory)services.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId);var a=new Entity("secondary",new Guid("${id}"));a["title"]="First primary changed";var b=new Entity("secondary",new Guid("${second}"));b["title"]="Second primary changed";s.Execute(new UpdateMultipleRequest{Targets=new EntityCollection(new[]{a,b})});}}
public sealed class GuardChange:IPlugin {public void Execute(IServiceProvider services){var c=(IPluginExecutionContext4)services.GetService(typeof(IPluginExecutionContext));if(c.PreEntityImagesCollection[0]["before"].GetAttributeValue<bool>("allowed")!=true)throw new Exception("Original preimage lost");var s=((IOrganizationServiceFactory)services.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId);var change=new Entity("secondary",new Guid("${second}"));change["allowed"]=false;s.Update(change);((ITracingService)services.GetService(typeof(ITracingService))).Trace("Original bulk changed current grant flag");}}}`,
    );
    compileClr(source, assembly, { references: [sdk] });
    const restricted = {
      ...profile,
      grants: [{ entity: 'secondary', operations: ['update'], predicate: (row) => row.allowed === true }],
    };
    const descriptor = (type, serviceProfile) => ({
      trust: 'execute-local-assembly',
      root,
      assembly: path.basename(assembly),
      typeName: 'Invented.' + type,
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, 'cache'),
      serviceProfile,
      context: {
        initiatingUserId: user,
        organizationId: '50000000-0000-0000-0000-000000000001',
        businessUnitId: '60000000-0000-0000-0000-000000000001',
      },
      timeoutMs: ORDINARY_CLR_TIMEOUT_MS,
    });
    const base = {
      assemblyId: 'invented-bulk-grant',
      enabled: true,
      rank: 1,
      mode: 0,
      stage: 20,
      supportedDeployment: 0,
      filteringAttributes: [],
    };
    const steps = [
      {
        ...base,
        id: '30000000-0000-0000-0000-000000000091',
        name: 'Invented restricted driver',
        entity: 'widget',
        message: 'Create',
        typeName: 'Invented.Driver',
        images: [],
      },
      {
        ...base,
        id: '30000000-0000-0000-0000-000000000092',
        name: 'Invented source-configured privileged grant change',
        entity: 'secondary',
        message: 'UpdateMultiple',
        typeName: 'Invented.GuardChange',
        images: [{ alias: 'before', type: 0, attributes: ['allowed'] }],
      },
    ];
    const driver = await prepareClrRuntime(descriptor('Driver', restricted));
    const runtimes = new Map([
        [steps[0].id, driver],
        [steps[1].id, retypeClrRuntime(driver, { typeName: 'Invented.GuardChange', serviceProfile: profile })],
      ]),
      store = storeOf(),
      notes = [];
    store.state.tables.secondary[0].allowed = true;
    store.state.tables.secondary.push({ secondaryid: second, title: 'Second original', allowed: true });
    store.file = path.join(root, 'state.json');
    await store.save();
    const before = store.snapshot();
    const items = pluginCatalogue({
      plugins: { steps },
      runtimes,
      overrides: Object.fromEntries(steps.map((step) => ['plugin-step:' + step.id, { mode: 'clr' }])),
    });
    store.setPluginPipeline(
      (context) => runPluginPhase({ ...context, store, runtimes, items, diagnostic: (note) => notes.push(note) }),
      (context) =>
        items.some((item) => item.entity === context.entity && item.message.toLowerCase() === context.operation),
    );
    await assert.rejects(store.create('widget', { title: 'Attempt' }, { roles: ['Editor'] }), /denied update/);
    assert.deepEqual(store.snapshot(), before);
    assert.deepEqual(JSON.parse(await fs.readFile(store.file, 'utf8')).tables.secondary, before.tables.secondary);
    assert.ok(notes.some((note) => note.message === 'Original bulk changed current grant flag'));
    const hosts = notes.filter((note) => note.code === 'PLUGIN_CLR_HOST_STOPPED');
    assert.equal(hosts.length, 2);
    assert.ok(hosts.every((note) => note.absenceVerified));
    if (process.env.PAQ_TEST_CLR_EVIDENCE) {
      const hash = async (file) =>
        createHash('sha256')
          .update(await fs.readFile(file))
          .digest('hex');
      await fs.writeFile(
        path.resolve(process.env.PAQ_TEST_CLR_EVIDENCE) + '.bulk-grant.json',
        JSON.stringify(
          {
            schemaVersion: 1,
            generatedAt: new Date().toISOString(),
            scope: 'Actual original invented DLL grant mutation; native source role security not qualified',
            originalSourceSha256: await hash(source),
            originalAssemblySha256: await hash(assembly),
            sdkAssemblySha256: await hash(sdk),
            ownedHosts: { stopped: hosts.length, allAbsenceVerified: true },
            assertionScopes: [
              'Preimage stays original while authorization refreshes post-stage20 current rows',
              'All bulk targets authorized before first primary write',
              'Nested grant change and all primary writes rollback in saved state',
            ],
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

test(
  'Original DLL executes Targets, Context4 aligned images, filtering, rank and typed bulk responses',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-sdk-bulk-'));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const sdk = clrSdk(),
      source = path.join(root, 'BulkOriginal.cs'),
      assembly = path.join(root, 'BulkOriginal.dll');
    await fs.writeFile(
      source,
      `using System;using System.Collections.Generic;using System.ServiceModel;using Microsoft.Xrm.Sdk;using Microsoft.Xrm.Sdk.Messages;
namespace Invented {public sealed class Driver:IPlugin {public void Execute(IServiceProvider services){var c=(IPluginExecutionContext)services.GetService(typeof(IPluginExecutionContext));var s=((IOrganizationServiceFactory)services.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId);var target=(Entity)c.InputParameters["Target"];
var a=new Entity("secondary");a["title"]=" one ";var b=new Entity("secondary");b["title"]=" two ";var created=(CreateMultipleResponse)s.Execute(new CreateMultipleRequest{Targets=new EntityCollection(new[]{a,b})});if(created.Ids.Length!=2||created.Ids[0]==Guid.Empty||created.Ids[0]==created.Ids[1])throw new Exception("Bulk response IDs lost");
var u=new Entity("secondary",new Guid("${id}"));u["title"]=target.GetAttributeValue<string>("title")=="fault"?"fault":" updated ";u["keep"]="must remove";try{var updated=(UpdateMultipleResponse)s.Execute(new UpdateMultipleRequest{Targets=new EntityCollection(new[]{u})});}catch(FaultException<OrganizationServiceFault> fault){if((string)fault.Detail.ErrorDetails["failedRecordId"]!="${id}")throw new Exception("Per-record SDK fault details lost");throw new InvalidPluginExecutionException("Observed bulk per-record fault");}
if(target.GetAttributeValue<string>("title")=="reject")throw new InvalidPluginExecutionException("Caller rejected bulk writes");((ITracingService)services.GetService(typeof(ITracingService))).Trace("Original bulk driver completed");}}
public sealed class Bulk:IPlugin {public void Execute(IServiceProvider services){var c=(IPluginExecutionContext4)services.GetService(typeof(IPluginExecutionContext));var targets=(EntityCollection)c.InputParameters["Targets"];if(c.PrimaryEntityId!=Guid.Empty||!c.IsInTransaction||c.Mode!=0)throw new Exception("Bulk context lost");
if(c.Stage==20){if(c.PreEntityImagesCollection.Length!=targets.Entities.Count||c.PostEntityImagesCollection.Length!=targets.Entities.Count)throw new Exception("Image alignment lost");for(int i=0;i<targets.Entities.Count;i++){if(targets.Entities[i].GetAttributeValue<string>("title")=="fault")throw new InvalidPluginExecutionException("Bulk target rejected",new Dictionary<string,string>{{"failedRecordId",targets.Entities[i].Id.ToString()}});if(c.MessageName=="UpdateMultiple"&&c.PreEntityImagesCollection[i]["before"].GetAttributeValue<string>("title")!="Before")throw new Exception("Preimage lost");targets.Entities[i]["title"]=targets.Entities[i].GetAttributeValue<string>("title").Trim();targets.Entities[i].Attributes.Remove("keep");}c.SharedVariables["rank"]=new Money(23.5m);}
else{if(((Money)c.SharedVariables["rank"]).Value!=23.5m||c.PostEntityImagesCollection.Length!=targets.Entities.Count)throw new Exception("Shared or post image lost");for(int i=0;i<targets.Entities.Count;i++)if(c.PostEntityImagesCollection[i]["after"].GetAttributeValue<string>("title")!=targets.Entities[i].GetAttributeValue<string>("title"))throw new Exception("Postimage value lost");if(c.MessageName=="CreateMultiple"&&((Guid[])c.OutputParameters["Ids"]).Length!=targets.Entities.Count)throw new Exception("Output IDs lost");}
((ITracingService)services.GetService(typeof(ITracingService))).Trace("Original {0} stage {1}",c.MessageName,c.Stage);}}
public sealed class RejectUnexpected:IPlugin {public void Execute(IServiceProvider services){throw new Exception("Unsubmitted filtering attribute triggered");}}}`,
    );
    compileClr(source, assembly, { references: [sdk] });
    const descriptor = (typeName) => ({
      trust: 'execute-local-assembly',
      root,
      assembly: path.basename(assembly),
      typeName: 'Invented.' + typeName,
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
    const steps = [],
      runtimes = new Map();
    let counter = 0,
      prepared;
    const add = async (type, entity, message, stage, filteringAttributes = [], images = []) => {
      const id_ = '30000000-0000-0000-0000-' + String(++counter).padStart(12, '0');
      steps.push({
        id: id_,
        name: 'Invented ' + type,
        assemblyId: 'invented-bulk',
        enabled: true,
        entity,
        message,
        stage,
        rank: counter,
        mode: 0,
        supportedDeployment: 0,
        filteringAttributes,
        images,
        typeName: 'Invented.' + type,
      });
      prepared ??= await prepareClrRuntime(descriptor(type));
      runtimes.set(id_, retypeClrRuntime(prepared, { typeName: 'Invented.' + type }));
    };
    await add('Driver', 'widget', 'Create', 20);
    for (const message of ['CreateMultiple', 'UpdateMultiple']) {
      await add('Bulk', 'secondary', message, 20, message === 'UpdateMultiple' ? ['title'] : [], [
        { alias: 'before', type: 0, attributes: ['title'] },
      ]);
      await add('Bulk', 'secondary', message, 40, [], [{ alias: 'after', type: 1, attributes: ['title'] }]);
    }
    await add('RejectUnexpected', 'secondary', 'UpdateMultiple', 20, ['unsubmitted']);
    const store = storeOf(),
      notes = [],
      items = pluginCatalogue({
        plugins: { steps },
        runtimes,
        overrides: Object.fromEntries(steps.map((step) => ['plugin-step:' + step.id, { mode: 'clr' }])),
      });
    store.setPluginPipeline(
      (context) => runPluginPhase({ ...context, store, runtimes, items, diagnostic: (note) => notes.push(note) }),
      (context) =>
        steps.some((step) => step.entity === context.entity && step.message.toLowerCase() === context.operation),
    );
    store.file = path.join(root, 'state.json');
    await store.save();
    const before = store.snapshot();
    await assert.rejects(
      store.create('widget', { title: 'reject' }, { roles: ['Editor'] }),
      /Caller rejected bulk writes/,
    );
    assert.deepEqual(store.snapshot(), before);
    assert.deepEqual(JSON.parse(await fs.readFile(store.file, 'utf8')).tables.secondary, before.tables.secondary);
    await store.create('widget', { title: 'accepted' }, { roles: ['Editor'] });
    assert.deepEqual(
      store.snapshot().tables.secondary.map((row) => row.title),
      ['updated', 'one', 'two'],
    );
    assert.equal(store.snapshot().tables.secondary[0].keep, 'Original');
    const faultBefore = store.snapshot();
    await assert.rejects(
      store.create('widget', { title: 'fault' }, { roles: ['Editor'] }),
      /Observed bulk per-record fault/,
    );
    assert.deepEqual(store.snapshot(), faultBefore);
    assert.deepEqual(JSON.parse(await fs.readFile(store.file, 'utf8')).tables.secondary, faultBefore.tables.secondary);
    assert.equal(notes.filter((note) => note.message === 'Original bulk driver completed').length, 1);
    assert.equal(notes.filter((note) => note.message === 'Original CreateMultiple stage 20').length, 3);
    const hosts = notes.filter((note) => note.code === 'PLUGIN_CLR_HOST_STOPPED');
    assert.equal(hosts.length, 14);
    assert.ok(hosts.every((note) => note.absenceVerified));
    if (process.env.PAQ_TEST_CLR_EVIDENCE) {
      const hash = async (file) =>
          createHash('sha256')
            .update(await fs.readFile(file))
            .digest('hex'),
        hosts = notes.filter((note) => note.code === 'PLUGIN_CLR_HOST_STOPPED');
      await fs.writeFile(
        path.resolve(process.env.PAQ_TEST_CLR_EVIDENCE) + '.bulk.json',
        JSON.stringify(
          {
            schemaVersion: 1,
            generatedAt: new Date().toISOString(),
            scope: 'Actual compiled invented original DLL; no native organization execution',
            originalSourceSha256: await hash(source),
            originalAssemblySha256: await hash(assembly),
            sdkAssemblySha256: await hash(sdk),
            ownedHosts: { stopped: hosts.length, allAbsenceVerified: hosts.every((note) => note.absenceVerified) },
            assertionScopes: [
              'Context4 Targets and aligned images',
              'Submitted attribute filters and stage shared state',
              'Actual SDK bulk response IDs and per-record FaultException details',
              'Standard-table atomic saved-state rollback',
            ],
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
