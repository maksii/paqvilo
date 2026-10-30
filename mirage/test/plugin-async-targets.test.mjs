// @test-kind parity: native dataverse-recorder pipelineEffects corpus: async steps get the Target PostOperation started with, not its context edits
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createOrganizationBackend } from '../lib/organization-backend.mjs';
import { pluginCatalogue } from '../lib/exported-plugins.mjs';
import { sdkValueToRecord } from '../lib/local-organization-service.mjs';
import { prepareClrRuntime } from '../lib/plugin-clr.mjs';
import { createScheduler, fixedClock } from '../lib/runtime-clock.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';
import { ORDINARY_CLR_TIMEOUT_MS } from './fixtures/clr-budget.mjs';

const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const reference = { id: id(2), logical_name: 'systemuser' };
function storeOf() {
  const state = emptyState();
  state.mappings.widget = {
    entitySet: 'widgets',
    idColumn: 'widgetid',
    recordDefaults: { flag: true, category: 4, statecode: 0, statuscode: 1 },
    fields: {
      title: { dataverseType: 'nvarchar' },
      text: { dataverseType: 'nvarchar' },
      scenario: { dataverseType: 'nvarchar' },
      flag: { dataverseType: 'bit' },
      category: { dataverseType: 'picklist' },
      statecode: { dataverseType: 'state' },
      statuscode: { dataverseType: 'status' },
      code: { dataverseType: 'nvarchar', autoNumberFormat: 'INV-{SEQNUM:4}' },
      createdon: { dataverseType: 'datetime' },
      modifiedon: { dataverseType: 'datetime' },
    },
  };
  state.tables.widget = [{ widgetid: id(10), title: 'Old title', untouched: 'Stored only', category: 99 }];
  const clock = fixedClock();
  return new DataStore({ state, clock });
}
function steps() {
  return [
    { message: 'Create', stage: 40, mode: 0, typeName: 'Invented.PostMutation' },
    { message: 'CreateMultiple', stage: 40, mode: 1, typeName: 'Invented.AsyncTarget' },
    { message: 'UpdateMultiple', stage: 40, mode: 1, typeName: 'Invented.AsyncTarget' },
  ].map((step, index) => ({
    id: id(index + 20),
    enabled: true,
    name: 'Invented async materialization',
    entity: 'widget',
    rank: 1,
    supportedDeployment: 0,
    assemblyId: 'invented',
    filteringAttributes: [],
    images: [],
    ...step,
  }));
}
const mutator = ({ context }) => {
  const target = context.InputParameters.Target;
  if (target.scenario === 'removed') {
    delete target.title;
    delete target.flag;
    delete target.widgetid;
    target.text = 'PostOperation context only';
  }
};
async function exercise(t, { observe, runtime } = {}) {
  const store = storeOf(),
    scheduler = createScheduler({ clock: store.clock, manual: true });
  const handlers = new Map([
    ['Invented.PostMutation', mutator],
    ...(observe ? [['Invented.AsyncTarget', observe]] : []),
  ]);
  const registrations = steps(),
    runtimes = runtime
      ? new Map(registrations.filter((step) => step.mode === 1).map((step) => [step.id, runtime]))
      : new Map(),
    descriptors = new Map([...runtimes].map(([key, value]) => [key, value.descriptor]));
  const items = pluginCatalogue({
    plugins: { steps: registrations },
    handlers,
    runtimes,
    descriptors,
    overrides: Object.fromEntries([...runtimes.keys()].map((key) => ['plugin-step:' + key, { mode: 'clr' }])),
  });
  const backend = await createOrganizationBackend({
    store,
    items: () => items,
    handlers,
    runtimes,
    descriptors,
    scheduler,
  });
  t.after(async () => {
    await backend.close();
    store.close();
  });
  const identity = { admin: true, systemUserId: id(2) },
    createOptions = {
      pluginAcceptLanguage: 'fr-CA',
      systemColumns: { ownerid: reference, createdby: reference, modifiedby: reference, modifiedonbehalfby: null },
    };
  let removed;
  await store.withOperationContext(
    async () => {
      store.pluginSdkTag = 'Invented materialization request';
      await store.create(
        'widget',
        { title: 'Baseline', text: 'Stored text', scenario: 'baseline' },
        identity,
        createOptions,
      );
      removed = await store.create(
        'widget',
        { title: 'Removed from context', text: 'Stored text', scenario: 'removed' },
        identity,
        createOptions,
      );
      await store.update('widget', id(10), { title: 'Updated', scenario: 'updated' }, identity, {
        pluginAcceptLanguage: 'de-DE',
        systemColumns: { modifiedby: reference, modifiedonbehalfby: null },
      });
    },
    { fresh: true },
  );
  await scheduler.runDue();
  await backend.asyncPluginRunner.drain();
  assert.deepEqual(
    store.tableRows('asyncoperation').map((job) => job.statuscode),
    [30, 30, 30],
    store
      .tableRows('asyncoperation')
      .map((job) => job.message)
      .join('\n'),
  );
  const persisted = store.tableRows('widget').find((row) => row.widgetid === removed.widgetid);
  assert.equal(persisted.title, 'Removed from context');
  assert.equal(persisted.flag, true);
  assert.equal(persisted.text, 'Stored text');
  assert.equal(persisted.widgetid, removed.widgetid);
  assert.equal(store.tableRows('widget')[0].untouched, 'Stored only');
}

// Native corpus (dataverse-recorder pipelineEffects): a value a synchronous PostOperation step sets on the Create Target,
// its custom output and its shared variable are absent from the asynchronous step's context. The queued Target is the
// one PostOperation started with, so PostOperation context removals and values do not reach it either.
test('queued multiple Targets contain materialized Create defaults and partial Update stamps, not PostOperation context edits', async (t) => {
  const observed = [];
  await exercise(t, {
    observe: ({ context }) => {
      const wire = context.InputParameters.Targets[0],
        target = wire.$type === 'Entity' ? sdkValueToRecord(wire) : wire,
        parent = context.ParentContext,
        baseline = parent.InputParameters.Target;
      assert.equal(context.Mode, 1);
      assert.equal(context.IsInTransaction, false);
      assert.equal(parent.Stage, 30);
      assert.equal(parent.Mode, 1);
      assert.equal(parent.MessageName, context.MessageName);
      assert.equal(parent.Depth, context.Depth);
      assert.equal(parent.RequestId, context.RequestId);
      assert.equal(parent.OperationId, context.OperationId);
      assert.equal(parent.OperationCreatedOn, context.OperationCreatedOn);
      assert.equal(parent.SharedVariables.tag, 'Invented materialization request');
      assert.equal(baseline.widgetid, parent.PrimaryEntityId);
      assert.equal(context.SharedVariables.IsAutoTransact, true);
      assert.equal(context.SharedVariables.AcceptLang, target.scenario === 'updated' ? 'de-DE' : 'fr-CA');
      if (target.scenario === 'updated') {
        assert.equal(context.MessageName, 'UpdateMultiple');
        assert.equal(target.widgetid, id(10));
        assert.ok(target.modifiedon);
        assert.equal(target.modifiedby.id, id(2));
        assert.equal(target.modifiedonbehalfby, null);
        assert.equal(Object.hasOwn(target, 'untouched'), false);
        assert.equal(Object.hasOwn(target, 'category'), false);
        assert.equal(parent.InputParameters.ConcurrencyBehavior, 0);
      } else {
        assert.equal(context.SharedVariables.DefaultsAddedFlag, true);
        assert.equal(target.category, 4);
        assert.equal(target.statuscode, 1);
        assert.equal(target.statecode, 0);
        assert.match(target.code, /^INV-100[01]$/);
        assert.equal(target.ownerid.id, id(2));
        assert.equal(baseline.flag, true);
        assert.ok(baseline.title);
        if (target.scenario === 'removed') {
          assert.equal(target.title, 'Removed from context');
          assert.equal(target.flag, true);
          assert.ok(target.widgetid);
          assert.equal(target.text, 'Stored text');
          assert.equal(baseline.text, 'Stored text');
        } else {
          assert.equal(target.title, 'Baseline');
          assert.equal(target.flag, true);
          assert.ok(target.widgetid);
        }
      }
      observed.push(target.scenario);
    },
  });
  assert.deepEqual(observed, ['baseline', 'removed', 'updated']);
});

test(
  'original CLR observes the same queued materialization, Context4 alignment and pre-mutation main parent',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-async-targets-')),
      source = path.join(root, 'Targets.cs'),
      sdk = clrSdk(),
      log = path.join(root, 'seen.txt');
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    await fs.writeFile(
      source,
      `using System;using System.IO;using Microsoft.Xrm.Sdk;namespace Invented{public sealed class AsyncTarget:IPlugin{public void Execute(IServiceProvider p){var c=(IPluginExecutionContext4)p.GetService(typeof(IPluginExecutionContext));var t=((EntityCollection)c.InputParameters["Targets"]).Entities[0];var scenario=t.GetAttributeValue<string>("scenario");var parent=c.ParentContext;var baseline=(Entity)parent.InputParameters["Target"];if(c.Mode!=1||c.IsInTransaction||c.OperationCreatedOn.Kind!=DateTimeKind.Unspecified||parent==null||parent.Stage!=30||parent.Mode!=1||parent.MessageName!=c.MessageName||parent.Depth!=c.Depth||parent.OperationId!=c.OperationId||parent.RequestId!=c.RequestId||parent.OperationCreatedOn!=c.OperationCreatedOn||baseline.Id!=parent.PrimaryEntityId)throw new Exception("Async main parent metadata differs");if((string)parent.SharedVariables["tag"]!="Invented materialization request")throw new Exception("Canonical parent tag lost");if(c.PostEntityImagesCollection.Length!=1||c.PostEntityImagesCollection[0].Count!=0||c.PreEntityImagesCollection.Length!=(scenario=="updated"?1:0))throw new Exception("Async Context4 alignment differs");if(scenario=="updated"){if(t.GetAttributeValue<Guid>("widgetid")!=new Guid("${id(10)}")||!t.Contains("modifiedon")||!t.Contains("modifiedby")||!t.Contains("modifiedonbehalfby")||t.Contains("untouched")||t.Contains("category")||(ConcurrencyBehavior)parent.InputParameters["ConcurrencyBehavior"]!=ConcurrencyBehavior.Default)throw new Exception("Update Target lost partial/stamp shape");}else{if(t.GetAttributeValue<OptionSetValue>("category").Value!=4||t.GetAttributeValue<OptionSetValue>("statuscode").Value!=1||!t.GetAttributeValue<string>("code").StartsWith("INV-")||!baseline.GetAttributeValue<bool>("flag")||!baseline.Contains("title")||!baseline.Contains("widgetid"))throw new Exception("Create defaults or parent baseline lost");if(scenario=="removed"){if(!t.Contains("title")||!t.GetAttributeValue<bool>("flag")||!t.Contains("widgetid")||t.GetAttributeValue<string>("text")!="Stored text"||baseline.GetAttributeValue<string>("text")!="Stored text")throw new Exception("PostOperation context edits reached the queued Target");}else if(!t.Contains("widgetid")||!t.GetAttributeValue<bool>("flag"))throw new Exception("Baseline primary/default lost");}File.AppendAllText(@"${log.replaceAll('"', '""')}",scenario+Environment.NewLine);}}}`,
    );
    compileClr(source, path.join(root, 'Targets.dll'), { references: [sdk] });
    const runtime = await prepareClrRuntime({
      trust: 'execute-local-assembly',
      root,
      assembly: 'Targets.dll',
      typeName: 'Invented.AsyncTarget',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, 'cache'),
      timeoutMs: ORDINARY_CLR_TIMEOUT_MS,
      serviceProfile: { userId: id(2), evidence: 'Invented async target observer', grants: [] },
      context: { initiatingUserId: id(2), organizationId: id(2), businessUnitId: id(2) },
    });
    await exercise(t, { runtime });
    assert.deepEqual((await fs.readFile(log, 'utf8')).trim().split(/\r?\n/), ['baseline', 'removed', 'updated']);
  },
);
