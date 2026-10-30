import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DataStore, emptyState } from '../lib/data.mjs';
import { DataError } from '../lib/data-error.mjs';
import { localOrganizationService } from '../lib/local-organization-service.mjs';
import { prepareClrRuntime, dispatchSdkCall, clrHostPoolStatus } from '../lib/plugin-clr.mjs';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { attachClrSteps } from './fixtures/plugin-pipeline.mjs';
import { CLR_SKIP, clrSdk, compileClr, retypeClrRuntime } from './fixtures/clr-sdk.mjs';

const empty = '00000000-0000-0000-0000-000000000000';
const user = '10000000-0000-0000-0000-000000000001';
const requested = '20000000-0000-0000-0000-000000000001';
const observerStages = [10, 20, 40];
const childInvocationBudgetMs = 2_000;
// The caller's inclusive deadline contains three independently bounded child
// CLR invocations, including isolated host startup, plus its own execution.
// Keep the ordinary child budget; configure this fixture's caller for its
// actual call graph instead of fitting four cold hosts into one child budget.
const callerInvocationBudgetMs = childInvocationBudgetMs * (observerStages.length + 1);
const fields = {
  mode: { dataverseType: 'nvarchar' },
  result: { dataverseType: 'nvarchar' },
  flag: { dataverseType: 'bit' },
  authoredstate: { dataverseType: 'bit' },
  choice: { dataverseType: 'picklist', options: [{ value: 2 }] },
  statecode: { dataverseType: 'int' },
  statuscode: { dataverseType: 'picklist', options: [{ value: 1, state: 0 }] },
};
const profile = {
  userId: user,
  evidence: 'Invented SDK identity channel profile',
  grants: [{ entity: 'widget', operations: ['create', 'read'] }],
};
const schema = {
  widget: { entitySet: 'widgets', idColumn: 'widgetid', fields, recordDefaults: { flag: false, choice: 2 } },
  trigger: { entitySet: 'triggers', idColumn: 'triggerid', fields },
};

test('an SDK Entity.Id seeds grant evaluation without becoming an authored primary Attribute', () => {
  const state = emptyState();
  state.mappings = structuredClone(schema);
  state.tables.widget = [];
  const store = new DataStore({ state }),
    observed = [];
  store.setPluginPipeline(
    (context) => {
      observed.push({
        stage: context.stage,
        primary: context.record.widgetid,
        authored: Object.hasOwn(context.target, 'widgetid'),
      });
    },
    ({ entity, operation }) => entity === 'widget' && operation === 'create',
  );
  const constrained = {
    ...profile,
    grants: [{ entity: 'widget', operations: ['create'], predicate: (row) => row.widgetid === requested }],
  };
  const value = dispatchSdkCall({
    store,
    profile: constrained,
    message: {
      method: 'Create',
      userId: user,
      arguments: [{ $type: 'Entity', logicalName: 'widget', id: requested, attributes: { mode: 'id-only' } }],
    },
  });
  assert.equal(value.value, requested);
  assert.deepEqual(observed, [
    { stage: 10, primary: requested, authored: false },
    { stage: 20, primary: requested, authored: true },
    { stage: 40, primary: requested, authored: true },
  ]);
  assert.throws(
    () =>
      localOrganizationService(store, constrained).create(
        'widget',
        { mode: 'denied' },
        { sdkCreateId: '20000000-0000-0000-0000-000000000099' },
      ),
    { code: 'LocalBackendPermissionDenied' },
  );
  assert.equal(store.tableRows('widget').length, 1);
});

test('conflicting SDK Create identity faults before PreValidation but an empty Attribute retains custom10 priority', () => {
  for (const attribute of [empty, '20000000-0000-0000-0000-000000000099']) {
    const state = emptyState();
    state.mappings = structuredClone(schema);
    state.tables.widget = [];
    const store = new DataStore({ state });
    let invoked = 0;
    store.setPluginPipeline((context) => {
      if (context.stage === 10) {
        invoked++;
        assert.equal(context.record.widgetid, requested);
        throw new DataError('Invented custom PreValidation rejection', 400, 'PluginValidation', {
          innerCode: '0x80040265',
        });
      }
    });
    assert.throws(
      () =>
        dispatchSdkCall({
          store,
          profile,
          message: {
            method: 'Create',
            userId: user,
            arguments: [
              {
                $type: 'Entity',
                logicalName: 'widget',
                id: requested,
                attributes: { widgetid: { $type: 'Guid', value: attribute } },
              },
            ],
          },
        }),
      (error) =>
        attribute === empty
          ? error.details?.innerCode === '0x80040265'
          : error.details?.innerCode === '0x80040203' &&
            error.message === 'Entity Id must be the same as the value set in property bag',
    );
    assert.equal(invoked, attribute === empty ? 1 : 0);
    assert.equal(store.tableRows('widget').length, 0);
  }
  const state = emptyState();
  state.mappings = structuredClone(schema);
  state.tables.widget = [];
  const store = new DataStore({ state }),
    stages = [];
  store.setPluginPipeline((context) => {
    stages.push(context.stage);
    assert.equal(context.record.widgetid, requested);
    assert.equal(context.target.widgetid, empty);
  });
  assert.throws(
    () => localOrganizationService(store, profile).create('widget', { widgetid: empty }, { sdkCreateId: requested }),
    (error) => error.details?.innerCode === '0x80040203' && error.message === 'Expected non-empty Guid.',
  );
  assert.deepEqual(stages, [10]);
  assert.equal(store.tableRows('widget').length, 0);
});

test('deep-insert child messages do not inherit the parent SDK identity, response token or derived-column projection', async () => {
  const state = emptyState();
  state.mappings = structuredClone(schema);
  Object.assign(state.mappings.widget.fields, {
    childid: { dataverseType: 'lookup' },
    parentid: { dataverseType: 'lookup' },
  });
  state.mappings.widget.relationships = {
    child: { entity: 'widget', from: 'childid', to: 'widgetid', many: false },
    children: { entity: 'widget', from: 'widgetid', to: 'parentid', many: true },
    edges: {
      entity: 'widget',
      from: 'widgetid',
      to: 'widgetid',
      many: true,
      intersect: { entity: 'widgetlink', from: 'leftid', to: 'rightid' },
    },
  };
  state.mappings.widgetlink = {
    entitySet: 'widgetlinks',
    idColumn: 'widgetlinkid',
    fields: { leftid: { dataverseType: 'lookup' }, rightid: { dataverseType: 'lookup' } },
  };
  state.tables.widget = [];
  state.tables.widgetlink = [];
  const store = new DataStore({ state }),
    token = {},
    phases = [],
    targets = [];
  const original = store.exportedPluginPhase.bind(store);
  store.exportedPluginPhase = (...args) => {
    if (args[2] === 10)
      phases.push({
        mode: args[4].mode,
        seed: args[8].sdkCreateId,
        token: args[8].sdkResponseToken,
        derived: args[8].derivedCreateColumns,
      });
    return original(...args);
  };
  store.setPluginPipeline((context) => {
    if (context.stage === 10)
      targets.push({ mode: context.record.mode, state: Object.hasOwn(context.target, 'statecode') });
  });
  const child = (mode) => ({ mode, statecode: 0, statuscode: 1 });
  await store.create(
    'widget',
    { ...child('root'), child: child('single'), children: [child('collection')], edges: [child('intersect')] },
    { admin: true },
    { sdkCreateId: requested, sdkResponseToken: token, derivedCreateColumns: { statecode: 0, statuscode: 1 } },
  );
  assert.equal(store.tableRows('widget').length, 4);
  assert.equal(new Set(store.tableRows('widget').map((row) => row.widgetid)).size, 4);
  assert.equal(store.tableRows('widget').find((row) => row.mode === 'root').widgetid, requested);
  for (const phase of phases) {
    assert.equal(phase.seed, phase.mode === 'root' ? requested : undefined);
    assert.equal(phase.token, phase.mode === 'root' ? token : undefined);
    assert.equal(Boolean(phase.derived), phase.mode === 'root');
  }
  assert.deepEqual(
    targets.map(({ mode, state }) => [mode, state]),
    [
      ['root', false],
      ['single', true],
      ['collection', true],
      ['intersect', true],
    ],
  );
});

test('early Target projection retains authored inputs without changing unchanged runtime audit stamps in the stored row', async () => {
  for (const edited of [false, true]) {
    const state = emptyState();
    state.mappings = structuredClone(schema);
    state.tables.widget = [];
    const store = new DataStore({ state }),
      seen = [];
    store.setPluginPipeline((context) => {
      seen.push([context.stage, context.target.createdby]);
      if (edited && context.stage === 10) context.target.createdby = 'Invented plugin actor';
    });
    const row = await store.create(
      'widget',
      { createdby: 'Invented authored actor' },
      { admin: true },
      { systemColumns: { createdby: 'Invented runtime actor' } },
    );
    const expected = edited ? 'Invented plugin actor' : 'Invented runtime actor';
    assert.deepEqual(seen, [
      [10, 'Invented authored actor'],
      [20, expected],
      [40, expected],
    ]);
    assert.equal(row.createdby, expected);
  }
});

test(
  'original CLR direct and named SDK Create preserve Entity.Id and primary Attribute input channels',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-sdk-create-id-'));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const sdk = clrSdk(),
      source = path.join(root, 'CreateId.cs'),
      assembly = path.join(root, 'CreateId.dll');
    // Timing: native Create Targets (recorder parity corpus, crud) never carry versionnumber at any stage.
    await fs.writeFile(
      source,
      `using System;using Microsoft.Xrm.Sdk;using Microsoft.Xrm.Sdk.Messages;namespace Invented {
public sealed class Caller:IPlugin{public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));var t=(Entity)c.InputParameters["Target"];var mode=t.GetAttributeValue<string>("mode");var child=new Entity("widget");child["mode"]=mode;var id=new Guid("${requested}");if(mode=="id-only"||mode=="same")child.Id=id;if(mode=="attribute-only"||mode=="same")child["widgetid"]=id;var service=((IOrganizationServiceFactory)p.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId);var result=t.GetAttributeValue<bool>("named")?((CreateResponse)service.Execute(new CreateRequest{Target=child})).id:service.Create(child);t["result"]=result.ToString();}}
public sealed class Observe:IPlugin{public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));var t=(Entity)c.InputParameters["Target"];var mode=t.GetAttributeValue<string>("mode");bool authored=mode=="attribute-only"||mode=="same";if(t.Id==Guid.Empty||t.Id!=c.PrimaryEntityId)throw new Exception("Allocated Entity.Id differs from request primary");if(t.Contains("widgetid")!=(authored||c.Stage!=10))throw new Exception("Entity.Id became an authored primary Attribute at stage "+c.Stage);if(t.Contains("widgetid")&&(Guid)t["widgetid"]!=t.Id)throw new Exception("Primary Attribute differs from allocated identity");if(mode!="empty"&&t.Id!=new Guid("${requested}"))throw new Exception("Caller identity was lost");if(!t.Contains("flag")||!(t["flag"] is bool)||(bool)t["flag"])throw new Exception("Source Boolean default missing");if(c.Stage==10)foreach(var name in new[]{"createdon","modifiedon","createdby","modifiedby","statecode","statuscode","ownerid"})if(t.Contains(name))throw new Exception("Derived column appeared before main: "+name);}}
public sealed class Timing:IPlugin{public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));var t=(Entity)c.InputParameters["Target"];bool authored=t.GetAttributeValue<bool>("authoredstate");if(!t.Contains("flag")||!(t["flag"] is bool)||(bool)t["flag"])throw new Exception("Source Boolean default lost");if(c.Stage==10){foreach(var name in new[]{"createdon","modifiedon","createdby","modifiedby","ownerid","versionnumber"})if(t.Contains(name))throw new Exception("Derived column appeared in PreValidation: "+name);if(t.Contains("statecode")!=authored||t.Contains("statuscode")!=authored)throw new Exception("Authored state/status projection lost");if(t.Contains("choice"))throw new Exception("Unqualified picklist timing changed");}else{foreach(var name in new[]{"createdon","modifiedon","createdby","modifiedby","statecode","statuscode","widgetid"})if(!t.Contains(name))throw new Exception("Derived column missing at PreOperation: "+name);if(t.Contains("versionnumber"))throw new Exception("Row version appeared in the Target");}}}
}`,
    );
    compileClr(source, assembly, { references: [sdk] });
    const runtime = await prepareClrRuntime({
      trust: 'execute-local-assembly',
      root,
      assembly: 'CreateId.dll',
      typeName: 'Invented.Observe',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, 'cache'),
      timeoutMs: childInvocationBudgetMs,
      serviceProfile: profile,
      context: { executionUserId: user, initiatingUserId: user, organizationId: user, businessUnitId: user },
    });
    for (const { organization, pooled } of [
      { organization: false, pooled: false },
      { organization: true, pooled: false },
      { organization: true, pooled: true },
    ])
      for (const named of [false, true])
        for (const mode of ['id-only', 'attribute-only', 'same', 'empty'])
          await t.test(
            `${pooled ? 'pooled' : 'isolated'}/${organization ? 'organization' : 'store'}/${named ? 'named' : 'direct'}/${mode}`,
            async (t) => {
              const f = organization
                ? await contractModuleFixture(t, {
                    extension: { name: 'sdk-create-id-fixture', install() {} },
                    mappings: {
                      ...schema,
                      trigger: { ...schema.trigger, fields: { ...fields, named: { dataverseType: 'bit' } } },
                    },
                    tables: { widget: [], trigger: [] },
                  })
                : (() => {
                    const state = emptyState();
                    state.mappings = structuredClone(schema);
                    state.tables.widget = [];
                    state.tables.trigger = [];
                    return { store: new DataStore({ state }) };
                  })();
              const captured = [];
              const steps = observerStages.map((stage, index) => ({
                id: `30000000-0000-0000-0000-00000000000${index}`,
                enabled: true,
                entity: 'widget',
                message: 'Create',
                stage,
                rank: 1,
                mode: 0,
                supportedDeployment: 0,
                filteringAttributes: [],
                images: [],
                typeName: 'Invented.Observe',
                assemblyId: 'invented',
              }));
              steps.push({
                ...steps[1],
                id: '30000000-0000-0000-0000-000000000004',
                entity: 'trigger',
                typeName: 'Invented.Caller',
              });
              steps.push(
                ...steps.slice(0, 3).map((step, index) => ({
                  ...step,
                  id: `40000000-0000-0000-0000-00000000000${index}`,
                  rank: 2,
                  typeName: 'Invented.Capture',
                })),
              );
              await attachClrSteps(t, {
                store: f.store,
                steps,
                runtime: (step) =>
                  step.typeName === 'Invented.Capture'
                    ? null
                    : retypeClrRuntime(runtime, {
                        typeName: step.typeName,
                        persistentHost: pooled,
                        timeoutMs:
                          step.typeName === 'Invented.Caller' ? callerInvocationBudgetMs : childInvocationBudgetMs,
                      }),
                handlers: new Map([
                  [
                    'Invented.Capture',
                    ({ context }) => {
                      captured.push(context.Stage);
                    },
                  ],
                ]),
              });
              const row = await f.store.create('trigger', { mode, named }, { admin: true });
              assert.deepEqual(captured, [10, 20, 40]);
              if (pooled) {
                const hosts = clrHostPoolStatus();
                assert(hosts.some((host) => host.typeName === 'Invented.Caller' && host.depth === 1 && !host.active));
                assert(hosts.some((host) => host.typeName === 'Invented.Observe' && host.depth === 2 && !host.active));
              }
              const child = f.store.tableRows('widget')[0];
              assert.equal(f.store.tableRows('widget').length, 1);
              assert.equal(row.result, child.widgetid);
              assert.notEqual(child.widgetid, empty);
              if (mode !== 'empty') assert.equal(child.widgetid, requested);
            },
          );
    for (const authored of [false, true])
      await t.test(`HTTP-derived-column-timing/${authored ? 'authored-state-status' : 'defaults'}`, async (t) => {
        const f = await contractModuleFixture(t, {
          extension: { name: 'sdk-create-timing-fixture', install() {} },
          mappings: schema,
          tables: { widget: [], trigger: [] },
        });
        const steps = [10, 20, 40].map((stage, index) => ({
          id: `50000000-0000-0000-0000-00000000000${index}`,
          enabled: true,
          entity: 'widget',
          message: 'Create',
          stage,
          rank: 1,
          mode: 0,
          supportedDeployment: 0,
          filteringAttributes: [],
          images: [],
          typeName: 'Invented.Timing',
          assemblyId: 'invented',
        }));
        await attachClrSteps(t, {
          store: f.store,
          steps,
          runtime: retypeClrRuntime(runtime, { typeName: 'Invented.Timing' }),
        });
        const response = await f.request('POST', '/widgets', {
          mode: 'timing',
          authoredstate: authored,
          ...(authored ? { statecode: 0, statuscode: 1 } : {}),
        });
        assert.equal(response.status, 201, await response.text());
        const row = f.store.tableRows('widget')[0];
        assert.equal(row.flag, false);
        assert.equal(row.choice, 2);
        assert.equal(row.statecode, 0);
        assert.equal(row.statuscode, 1);
        assert(row.createdby && row.createdon && row.modifiedby && row.modifiedon && row.versionnumber);
      });
  },
);
