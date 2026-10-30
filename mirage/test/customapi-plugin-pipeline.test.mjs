import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { install, describeCustomApis, powerFxRequirements } from '../lib/dataverse-customapi.mjs';
import { createOrganizationBackend } from '../lib/organization-backend.mjs';
import { pluginCatalogue, runPluginPhase } from '../lib/exported-plugins.mjs';
import { localOrganizationService } from '../lib/local-organization-service.mjs';
import { createScheduler } from '../lib/runtime-clock.mjs';
import { pluginMessageValues } from '../lib/plugin-message-values.mjs';
import { pluginInvocationParent } from '../lib/plugin-execution-lifetime.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { clrContext, executeClrPlugin, prepareClrRuntime } from '../lib/plugin-clr.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';
import { prepareCustomApiRuntimes } from '../lib/dataverse-customapi.mjs';

const user = '10000000-0000-0000-0000-000000000002';
const name = 'invented_Execute';
const profile = {
  userId: user,
  evidence: 'Invented custom API main-operation writes',
  grants: [{ entity: 'child', operations: ['create'] }],
};

test(
  'original custom API Entity outputs retain Id, RowVersion and formatted values through a no-op JavaScript post observer',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-customapi-entity-'));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const sdk = clrSdk(),
      source = path.join(root, 'EntityMain.cs'),
      assembly = path.join(root, 'OriginalMain.dll');
    await fs.writeFile(
      source,
      `using System;using Microsoft.Xrm.Sdk;namespace Invented {public sealed class TypedMain:IPlugin {public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));var row=new Entity("child",new Guid("${user}"));row["title"]="Typed entity";row.RowVersion="9007199254740993";row.FormattedValues["title"]="Exact formatting";c.OutputParameters["Answer"]=row;}}}`,
    );
    compileClr(source, assembly, { references: [sdk] });
    const mainDescriptor = {
      trust: 'execute-local-assembly',
      root,
      assembly: path.basename(assembly),
      typeName: 'Invented.TypedMain',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, 'cache'),
      serviceProfile: profile,
      context: {
        initiatingUserId: user,
        organizationId: user,
        businessUnitId: user,
        mainOperationStepId: '10000000-0000-0000-0000-000000000003',
        mainOperationStepEvidence: 'Invented original main-operation identity',
      },
    };
    const f = await fixture(t, { stages: [40], mainDescriptor, extension: () => {} });
    Object.assign(f.store.tableRows('customapiresponseproperty')[0], { type: 3, logicalentityname: 'child' });
    const response = await f.store.transact(() =>
      f.store.sdkMutation(() =>
        f.api.records.executeMessageSyncInternal({
          principal: {
            userId: user,
            evidence: 'Invented typed main response',
            grants: [{ message: name, operations: ['execute'] }],
          },
          name,
          parameters: { $type: 'ParameterCollection', values: { Text: 'Typed response' } },
        }),
      ),
    );
    const entity = response.outputs.values.Answer;
    assert.equal(entity.$type, 'Entity');
    assert.equal(entity.id, user);
    assert.equal(entity.rowVersion, '9007199254740993');
    assert.equal(entity.formattedValues.title, 'Exact formatting');
    assert.equal(entity.attributes.title, 'Typed entity');
  },
);

test(
  'a JavaScript main operation retains its async depth and context when it calls an original CLR child',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-main-child-'));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const sdk = clrSdk(),
      source = path.join(root, 'Child.cs'),
      assembly = path.join(root, 'Child.dll');
    // Native (parity corpus pipelineEffects): a nested Create PreOperation's ParentContext is its own Create stage-30 main operation; the calling context is that main operation's parent.
    await fs.writeFile(
      source,
      `using System;using Microsoft.Xrm.Sdk;namespace Invented {public sealed class Child:IPlugin {public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));var main=c.ParentContext;if(main==null||main.MessageName!="Create"||main.Stage!=30||main.Depth!=2)throw new Exception("Create main operation parent lost");var caller=main.ParentContext;if(c.Depth!=2||caller==null||caller.MessageName!="${name}"||caller.Stage!=30||caller.Depth!=1||(string)caller.InputParameters["Text"]!="From JS"||(bool)caller.SharedVariables["IsAutoTransact"]!=true)throw new Exception("Main parent context lost");((Entity)c.InputParameters["Target"])["title"]="Observed child";}}}`,
    );
    compileClr(source, assembly, { references: [sdk] });
    const runtime = await prepareClrRuntime({
      trust: 'execute-local-assembly',
      root,
      assembly: path.basename(assembly),
      typeName: 'Invented.Child',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, 'cache'),
      serviceProfile: profile,
      context: { initiatingUserId: user, organizationId: user, businessUnitId: user },
    });
    const f = await fixture(t, {
      stages: [],
      main: async (ctx) => {
        await Promise.resolve();
        const row = localOrganizationService(ctx.api.store, profile).create('child', { title: 'Requested' });
        return { outputs: { Answer: row.title } };
      },
    });
    const step = {
      id: user,
      enabled: true,
      entity: 'child',
      message: 'Create',
      stage: 20,
      mode: 0,
      rank: 1,
      supportedDeployment: 0,
      filteringAttributes: [],
      images: [],
      typeName: 'Invented.Child',
      assemblyId: 'invented',
    };
    const runtimes = new Map([[step.id, runtime]]);
    const items = pluginCatalogue({
      plugins: { steps: [step] },
      runtimes,
      overrides: { ['plugin-step:' + step.id]: { mode: 'clr' } },
    });
    f.store.setPluginPipeline((ctx) => runPluginPhase({ ...ctx, store: f.store, items, runtimes }));
    assert.equal((await f.call('From JS')).body.Answer, 'Observed child');
  },
);
async function fixture(
  t,
  {
    stages = [10, 20, 40],
    policy = 2,
    extension,
    main,
    namedMain = false,
    runtime,
    mainDescriptor,
    tracing = 0,
    binding = 0,
    isFunction = false,
    timeoutMs,
  } = {},
) {
  const state = emptyState();
  state.mappings.child = { entitySet: 'children', idColumn: 'childid' };
  state.tables.child = binding
    ? [
        { childid: user, title: 'First bound row' },
        { childid: '10000000-0000-0000-0000-000000000003', title: 'Second bound row' },
      ]
    : [];
  if (tracing) {
    state.mappings.plugintracelog = { entitySet: 'plugintracelogs', idColumn: 'plugintracelogid' };
    state.tables.plugintracelog = [];
    state.tables.organization = [{ organizationid: user, plugintracelogsetting: tracing }];
    state.dataverse = { ...state.dataverse, organizationId: user };
  }
  state.tables.customapi = [
    {
      customapiid: user,
      uniquename: name,
      bindingtype: binding,
      isfunction: isFunction,
      ...(binding ? { boundentitylogicalname: 'child' } : {}),
      allowedcustomprocessingsteptype: policy,
      ...(namedMain || mainDescriptor ? { plugintypeid: user } : {}),
    },
  ];
  if (mainDescriptor) {
    state.tables.plugintype = [{ plugintypeid: user, typename: mainDescriptor.typeName, pluginassemblyid: user }];
    state.tables.pluginassembly = [{ pluginassemblyid: user, name: 'OriginalMain' }];
  }
  state.tables.customapirequestparameter = [
    { customapirequestparameterid: user, customapiid: user, uniquename: 'Text', type: 10, isoptional: false },
  ];
  state.tables.customapiresponseproperty = [
    { customapiresponsepropertyid: user, customapiid: user, uniquename: 'Answer', type: 10 },
  ];
  const store = new DataStore({ state });
  const operations = [];
  const diagnostics = [];
  const api = {
    store,
    diagnostic: (entry) => diagnostics.push(entry),
    records: {},
    change: (fn) => fn(),
    principals: { privileges: () => new Map(), byId: (id) => (id === user ? { systemuserid: user } : null) },
    registry: {
      register: (op) => operations.push(op),
      has: (key) => operations.some((op) => op.name === key),
      find: (query) =>
        operations.find(
          (op) =>
            op.name === query.name &&
            op.kind === query.kind &&
            op.binding === query.binding &&
            (!op.entity || op.entity === query.entity),
        ),
    },
  };
  const runtimes = new Map();
  const mainDescriptors = new Map(mainDescriptor ? [[user, mainDescriptor]] : []);
  await install(api, {
    handlers: main ? new Map([[name.toLowerCase(), { handler: main }]]) : new Map(),
    pluginRuntimes: mainDescriptors,
    runtimes,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  }).ready;
  const customApi = { name, bindingType: binding, allowedCustomProcessingStepType: policy, isFunction };
  const steps = stages.map((value, index) => ({
    id: '30000000-0000-0000-0000-00000000000' + index,
    enabled: true,
    entity: binding ? 'child' : null,
    message: name,
    stage: typeof value === 'number' ? value : value.stage,
    mode: typeof value === 'number' ? 0 : value.mode,
    rank: index + 1,
    supportedDeployment: 0,
    filteringAttributes: [],
    images: [],
    typeName: runtime?.descriptor.typeName ?? 'Invented.Extension' + index,
    assemblyId: 'invented',
    customApi,
  }));
  const handlers = new Map(steps.map((step) => [step.typeName, extension ?? (() => {})]));
  if (runtime) for (const step of steps) runtimes.set(step.id, runtime);
  const descriptors = new Map(runtime ? steps.map((step) => [step.id, runtime.descriptor]) : []);
  const overrides = runtime ? Object.fromEntries(steps.map((step) => ['plugin-step:' + step.id, { mode: 'clr' }])) : {};
  const items = pluginCatalogue({ plugins: { steps }, handlers, runtimes, descriptors, overrides });
  assert.ok(
    items.every((item) => !item.unsupported),
    items.map((item) => item.unsupported).join(','),
  );
  const scheduler = createScheduler({ manual: true });
  const backend = await createOrganizationBackend({
    store,
    items: () => items,
    handlers,
    runtimes,
    descriptors,
    scheduler,
    diagnostic: (entry) => diagnostics.push(entry),
  });
  t.after(() => backend.close());
  const call = (Text = 'Authored', headers = {}) =>
    operations
      .find((op) => op.name === name)
      .handle({
        method: isFunction ? 'GET' : 'POST',
        url: new URL('http://127.0.0.1/api/data/v9.2/' + name),
        origin: 'http://127.0.0.1',
        version: 'v9.2',
        body: isFunction ? undefined : { Text },
        params: isFunction ? { Text } : {},
        headers,
        user: { systemuserid: user },
        ...(binding
          ? {
              target: {
                mapping: store.resolveMapping('child'),
                ...(binding === 1 ? { id: user, row: store.tableRows('child')[0] } : {}),
              },
            }
          : {}),
      });
  return { store, call, scheduler, backend, api, diagnostics, runtimes, mainDescriptors, items, handlers };
}

test('custom API registered stages change the main inputs and final outputs in one transaction', async (t) => {
  const seen = [];
  const f = await fixture(t, {
    extension: ({ context }) => {
      seen.push(context.Stage);
      assert.equal(context.MessageName, name);
      if (context.Stage === 10) {
        assert.equal(context.PrimaryEntityName, 'none');
        assert.equal(context.PrimaryEntityId, '00000000-0000-0000-0000-000000000000');
        assert.equal(context.SharedVariables.AcceptLang, '');
        assert.equal(context.SharedVariables.IsAutoTransact, true);
        assert.deepEqual(context.OutputParameters, {});
        context.InputParameters.Text = 'Normalized';
        context.SharedVariables.guard = 'early';
      } else if (context.Stage === 20) {
        assert.equal(context.InputParameters.Text, 'Normalized');
        assert.equal(context.SharedVariables.guard, 'early');
        context.InputParameters.Text += ' before main';
      } else {
        assert.equal(context.OutputParameters.Answer, 'Normalized before main');
        context.OutputParameters.Answer += ' after main';
      }
    },
    main: (ctx) => {
      seen.push(30);
      localOrganizationService(ctx.api.store, profile).create('child', { title: ctx.inputs.Text });
      return { outputs: { Answer: ctx.inputs.Text } };
    },
  });
  const response = await f.call();
  assert.equal(response.body.Answer, 'Normalized before main after main');
  assert.deepEqual(seen, [10, 20, 30, 40]);
  assert.equal(f.store.tableRows('child')[0].title, 'Normalized before main');
});

test('both internal custom API drives retain validated system optional parameters in the mandatory main context', async (t) => {
  const seen = [],
    events = [],
    contexts = [];
  const f = await fixture(t, {
    stages: [10, 20, 40, { stage: 40, mode: 1 }],
    extension: ({ context }) => {
      seen.push(context.Stage);
    },
    main: (ctx) => {
      const context = pluginInvocationParent(f.store);
      assert.equal(context.values.Stage, 30);
      contexts.push(structuredClone(context.values.InputParameters.values));
      return { outputs: { Answer: ctx.inputs.Text } };
    },
  });
  f.store.addCommittedEvents((batch) => events.push(...batch));
  const systemParameters = {
    BypassCustomPluginExecution: false,
    BypassBusinessLogicExecution: 'CustomSync,CustomAsync',
    BypassBusinessLogicExecutionStepIds: f.items[0].id.toUpperCase(),
  };
  for (const sync of [true, false]) {
    const request = {
      principal: {
        userId: user,
        evidence: 'Invented validated transport controls',
        grants: [{ message: name, operations: ['execute'] }],
      },
      name,
      parameters: { Text: 'Mandatory main' },
      bypassCustomPlugins: true,
      bypassCustomAsync: true,
      systemParameters,
    };
    const answer = await f.store.transact(() =>
      sync ? f.api.records.executeMessageSyncInternal(request) : f.api.records.executeMessageInternal(request),
    );
    assert.equal(answer.body.Answer, 'Mandatory main');
    await f.store.flushCommittedEvents();
    await f.scheduler.runDue();
  }
  assert.deepEqual(
    contexts,
    [1, 2].map(() => ({ Text: 'Mandatory main', ...systemParameters })),
  );
  assert.deepEqual(seen, []);
  assert.equal(f.store.tableRows('asyncoperation').length, 0);
  assert.equal(events.filter((event) => event.operation === name.toLowerCase() && event.bypassCustomAsync).length, 2);
});

test('selective custom API step bypass skips only the chosen extension and retains its mandatory main operation', async (t) => {
  const seen = [];
  const f = await fixture(t, {
    extension: ({ context }) => {
      seen.push(context.Stage);
    },
    main: (ctx) => {
      seen.push(30);
      return { outputs: { Answer: ctx.inputs.Text } };
    },
  });
  const skipped = f.items.find((item) => item.stage === 20).id;
  const response = await f.store.transact(() =>
    f.api.records.executeMessageSyncInternal({
      principal: {
        userId: user,
        evidence: 'Invented selective step caller',
        grants: [{ message: name, operations: ['execute'] }],
      },
      name,
      parameters: { $type: 'ParameterCollection', values: { Text: 'Still executes main' } },
      bypassStepIds: [skipped.toUpperCase(), user],
    }),
  );
  assert.equal(response.outputs.values.Answer, 'Still executes main');
  assert.deepEqual(seen, [10, 30, 40]);
});

test('global custom API extension bypass retains source-protected steps and the mandatory main operation', async (t) => {
  for (const ownership of [
    { customizationLevel: 0, bypassOwnership: { kind: 'system', evidence: 'Invented core implementation witness' } },
    { bypassOwnership: { kind: 'microsoft', evidence: 'Invented source solution witness' } },
  ]) {
    const seen = [];
    const f = await fixture(t, {
      extension: ({ context }) => {
        seen.push(context.Stage);
      },
      main: () => {
        seen.push(30);
        return { outputs: { Answer: 'Mandatory main' } };
      },
    });
    Object.assign(
      f.items.find((item) => item.stage === 20),
      ownership,
    );
    const response = await f.store.transact(() =>
      f.api.records.executeMessageSyncInternal({
        principal: {
          userId: user,
          evidence: 'Invented protected extension caller',
          grants: [{ message: name, operations: ['execute'] }],
        },
        name,
        parameters: { $type: 'ParameterCollection', values: { Text: 'Authored' } },
        bypassCustomPlugins: true,
      }),
    );
    assert.equal(response.outputs.values.Answer, 'Mandatory main');
    assert.deepEqual(seen, [20, 30]);
    assert.ok(f.diagnostics.some((entry) => entry.code === 'PLUGIN_BYPASS_OWNERSHIP_UNKNOWN'));
  }
});

test(
  'original bound custom API main operations use the declared table and only entity binding adds Target',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-bound-main-'));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const sdk = clrSdk(),
      source = path.join(root, 'Bound.cs'),
      assembly = path.join(root, 'OriginalMain.dll');
    await fs.writeFile(
      source,
      `using System;using Microsoft.Xrm.Sdk;namespace Invented {public sealed class BoundMain:IPlugin {public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));bool entity=(string)c.InputParameters["Text"]=="entity";if(c.Stage!=30||c.PrimaryEntityName!="child"||c.PrimaryEntityId!=(entity?new Guid("${user}"):Guid.Empty)||c.InputParameters.Contains("Target")!=entity)throw new Exception("Bound main context lost");if(entity){var target=(EntityReference)c.InputParameters["Target"];if(target.LogicalName!="child"||target.Id!=c.PrimaryEntityId)throw new Exception("Bound Target lost");}c.OutputParameters["Answer"]="Bound main observed";}}}`,
    );
    compileClr(source, assembly, { references: [sdk] });
    const descriptor = {
      trust: 'execute-local-assembly',
      root,
      assembly: path.basename(assembly),
      typeName: 'Invented.BoundMain',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, 'cache'),
      serviceProfile: { userId: user, evidence: 'Invented bound main descriptor', grants: [] },
      context: {
        executionUserId: user,
        initiatingUserId: user,
        organizationId: user,
        businessUnitId: user,
        mainOperationStepId: '90000000-0000-0000-0000-000000000001',
        mainOperationStepEvidence: 'Invented internal main step context witness',
      },
    };
    for (const binding of [1, 2]) {
      const f = await fixture(t, { binding, mainDescriptor: descriptor });
      assert.equal((await f.call(binding === 1 ? 'entity' : 'collection')).body.Answer, 'Bound main observed');
    }
  },
);

test('custom API AcceptLang follows only its incoming HTTP headers and stays empty on an internal SDK request', async (t) => {
  const seen = [];
  const f = await fixture(t, {
    stages: [20],
    extension: ({ context }) => {
      seen.push(context.SharedVariables.AcceptLang);
    },
  });
  await f.call('HTTP', { 'accept-language': 'fr-FR,fr;q=0.8' });
  await f.store.transact(() =>
    f.api.records.executeMessageSyncInternal({
      principal: {
        userId: user,
        evidence: 'Invented internal language caller',
        grants: [{ message: name, operations: ['execute'] }],
      },
      name,
      parameters: { $type: 'ParameterCollection', values: { Text: 'SDK' } },
    }),
  );
  assert.deepEqual(seen, ['fr-FR,fr;q=0.8', '']);
});

test('custom API functions retain their SDK message event without emitting an action-performed flow event', async (t) => {
  for (const isFunction of [false, true]) {
    const seen = [],
      events = [];
    const f = await fixture(t, {
      isFunction,
      extension: ({ context }) => {
        seen.push(context.Stage);
      },
      main: (ctx) => ({ outputs: { Answer: ctx.inputs.Text } }),
    });
    f.store.addCommittedEvents((batch) => events.push(...batch));
    assert.equal((await f.call('Result')).body.Answer, 'Result');
    await f.store.flushCommittedEvents();
    assert.deepEqual(seen, [10, 20, 40]);
    assert.equal(events.filter((event) => event.operation === name.toLowerCase()).length, 1);
    assert.equal(events.filter((event) => event.operation === 'action').length, isFunction ? 0 : 1);
  }
});

async function gatedFx(t, { synchronous, timeoutMs }) {
  const f = await fixture(t, { stages: [], timeoutMs });
  f.store.tableRows('customapi')[0].fxexpressionid = user;
  f.store.state.tables.fxexpression = [{ fxexpressionid: user, expression: 'InventedExpression' }];
  let release, resumed;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const finished = new Promise((resolve) => {
    resumed = resolve;
  });
  f.api.providers = {
    powerFx: {
      available: true,
      describe: () => ({ operations: [{ name: synchronous ? 'evaluateSync' : 'evaluate', level: 'behaviour' }] }),
      [synchronous ? 'evaluateSync' : 'evaluate']: async () => {
        if (!synchronous) localOrganizationService(f.store, profile).create('child', { title: 'Before timeout' });
        await gate;
        try {
          localOrganizationService(f.store, profile).create('child', { title: 'Too late' });
        } catch (error) {
          resumed(error);
        }
        return { value: { Answer: 'Late' } };
      },
    },
  };
  return { f, release, finished };
}

test('a refused synchronous Power Fx provider cannot resume SDK writes after returning a promise', async (t) => {
  const { f, release, finished } = await gatedFx(t, { synchronous: true });
  await assert.rejects(
    f.store.transact(() =>
      f.api.records.executeMessageSyncInternal({
        principal: {
          userId: user,
          evidence: 'Invented synchronous caller',
          grants: [{ message: name, operations: ['execute'] }],
        },
        name,
        parameters: { $type: 'ParameterCollection', values: { Text: 'Authored' } },
      }),
    ),
    (error) => error.code === 'SdkAsyncPreOperationUnsupported',
  );
  release();
  assert.equal((await finished).code, 'LocalPluginExecutionExpired');
  assert.equal(f.store.tableRows('child').length, 0);
});

test('an asynchronous Power Fx main operation times out and cannot resume SDK writes after rollback', async (t) => {
  const { f, release, finished } = await gatedFx(t, { synchronous: false, timeoutMs: 10 });
  await assert.rejects(
    f.call(),
    (error) =>
      error.status === 400 && error.details?.innerCode === '0x80040224' && /timeout|time limit/i.test(error.message),
  );
  assert.equal(f.store.tableRows('child').length, 0);
  release();
  assert.equal((await finished).code, 'LocalPluginExecutionExpired');
  assert.equal(f.store.tableRows('child').length, 0);
});

for (const timedOut of [false, true])
  test(`Power Fx retained bound caller state and cached data sources expire after ${timedOut ? 'timeout' : 'success'}`, async (t) => {
    const f = await fixture(t, { stages: [], binding: 1, timeoutMs: 10 });
    f.store.tableRows('customapi')[0].fxexpressionid = user;
    f.store.state.tables.fxexpression = [{ fxexpressionid: user, expression: 'RetainedBoundCaller' }];
    f.store.tableRows('child')[0].nested = { title: 'Detached scope value' };
    let release, completed, cached, retained;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const finished = new Promise((resolve) => {
      completed = resolve;
    });
    const errors = [];
    f.api.providers = {
      powerFx: {
        available: true,
        describe: () => ({ operations: [{ name: 'evaluate', level: 'behaviour' }] }),
        evaluate: (_expression, { host }) => {
          cached = host.dataSource('children').adapter;
          retained = host.caller.target.row;
          const detachedNested = host.scope.nested;
          const late = gate.then(() => {
            detachedNested.title = 'Changed detached scope';
            for (const action of [
              () => cached.create({ title: 'Late' }),
              () => {
                retained.title = 'Late';
              },
            ]) {
              try {
                action();
              } catch (error) {
                errors.push(error.code);
              }
            }
            completed();
            return { value: { Answer: 'Completed' } };
          });
          return timedOut ? late : { value: { Answer: 'Completed' } };
        },
      },
    };
    if (timedOut) await assert.rejects(f.call(), (error) => error.details?.innerCode === '0x80040224');
    else assert.equal((await f.call()).body.Answer, 'Completed');
    release();
    await finished;
    assert.deepEqual(errors, ['LocalPluginExecutionExpired', 'LocalPluginExecutionExpired']);
    assert.throws(() => cached.create({ title: 'Fresh-context late' }), { code: 'LocalPluginExecutionExpired' });
    assert.throws(
      () => {
        retained.title = 'Fresh-context late';
      },
      { code: 'LocalPluginExecutionExpired' },
    );
    assert.equal(f.store.tableRows('child').length, 2);
    assert.equal(f.store.tableRows('child')[0].title, 'First bound row');
    assert.equal(f.store.tableRows('child')[0].nested.title, 'Detached scope value');
  });

test('a bound custom API main handler sees the validated Target replacement made by a pre-operation extension', async (t) => {
  const replacement = '10000000-0000-0000-0000-000000000003';
  const f = await fixture(t, {
    binding: 1,
    stages: [20],
    extension: ({ context }) => {
      context.InputParameters.Target = { id: replacement, logical_name: 'child' };
    },
    main: (ctx) => ({ outputs: { Answer: ctx.target.id + ':' + ctx.target.row.title } }),
  });
  assert.equal((await f.call()).body.Answer, replacement + ':Second bound row');
  assert.equal(f.store.tableRows('child').length, 2);
});

test(
  'an intervening no-op JavaScript extension preserves CLR Money, Guid and implicit bound Target types',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-customapi-typed-'));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const sdk = clrSdk(),
      source = path.join(root, 'TypedBridge.cs'),
      assembly = path.join(root, 'TypedBridge.dll');
    await fs.writeFile(
      source,
      `using System;using Microsoft.Xrm.Sdk;namespace Invented {public sealed class TypedBridge:IPlugin {public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));if(c.Stage==10){c.SharedVariables["amount"]=new Money(5.25m);c.SharedVariables["guid"]=new Guid("${user}");}if(c.Stage==40){if(((Money)c.SharedVariables["amount"]).Value!=5.25m||(Guid)c.SharedVariables["guid"]!=new Guid("${user}")||((EntityReference)c.InputParameters["Target"]).Id!=new Guid("${user}"))throw new Exception("SDK type erased by observer");c.OutputParameters["Answer"]="Typed bridge retained";}}}}`,
    );
    compileClr(source, assembly, { references: [sdk] });
    const runtime = await prepareClrRuntime({
      trust: 'execute-local-assembly',
      root,
      assembly: path.basename(assembly),
      typeName: 'Invented.TypedBridge',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, 'cache'),
      serviceProfile: profile,
      context: { initiatingUserId: user, organizationId: user, businessUnitId: user },
    });
    const f = await fixture(t, { runtime, binding: 1, main: () => ({ outputs: { Answer: 'Main' } }) });
    f.items[1].mode = 'handler';
    assert.equal((await f.call()).body.Answer, 'Typed bridge retained');
  },
);

test('a custom API post-operation rejection rolls back the main operation and schedules no async job', async (t) => {
  const f = await fixture(t, {
    extension: ({ context, reject }) => {
      if (context.Stage === 40) reject('Rejected after main');
    },
    main: (ctx) => {
      localOrganizationService(ctx.api.store, profile).create('child', { title: 'Must roll back' });
      return { outputs: { Answer: 'No' } };
    },
  });
  await assert.rejects(f.call(), /Rejected after main/);
  assert.equal(f.store.tableRows('child').length, 0);
  assert.equal(f.store.tableRows('asyncoperation').length, 0);
});

test('custom API asynchronous extensions receive committed input/output snapshots', async (t) => {
  for (const isFunction of [false, true]) {
    const seen = [];
    const f = await fixture(t, {
      stages: [{ stage: 40, mode: 1 }],
      policy: isFunction ? 2 : 1,
      isFunction,
      extension: ({ context }) => {
        seen.push({
          input: context.InputParameters.Text,
          output: context.OutputParameters.Answer,
          inTransaction: context.IsInTransaction,
        });
      },
      main: (ctx) => ({ outputs: { Answer: ctx.inputs.Text + ' answered' } }),
    });
    assert.equal((await f.call('Committed')).body.Answer, 'Committed answered');
    assert.deepEqual(seen, []);
    await f.scheduler.runDue();
    assert.deepEqual(seen, [{ input: 'Committed', output: 'Committed answered', inTransaction: false }]);
    assert.equal(f.store.tableRows('asyncoperation')[0].statuscode, 30);
  }
});

test('an exported main-operation plug-in without a local implementation refuses the custom API', async (t) => {
  const f = await fixture(t, { stages: [], namedMain: true });
  assert.equal(describeCustomApis(f.api).operations.find((op) => op.name === 'customapi:' + name).level, 'contract');
  assert.ok(
    powerFxRequirements(f.store, { available: true }).some(
      (entry) => entry.id === 'custom-api:main:' + name && !entry.reachable,
    ),
  );
  await assert.rejects(
    f.call(),
    (error) => error.status === 501 && error.code === 'LocalPluginMainOperationUnavailable',
  );
});

test('a successful custom API also fences detached continuations after its response', async (t) => {
  let release, late;
  const gate = new Promise((resolve) => (release = resolve));
  const f = await fixture(t, {
    stages: [],
    main: ({ api }) => {
      late = gate.then(() => localOrganizationService(api.store, profile).create('child', { title: 'Detached write' }));
      return { outputs: { Answer: 'Completed' } };
    },
  });
  assert.equal((await f.call()).body.Answer, 'Completed');
  release();
  await assert.rejects(late, (error) => error.code === 'LocalPluginExecutionExpired');
  assert.equal(f.store.tableRows('child').length, 0);
});

test('custom API main-handler traces obey organization settings and survive a failed business transaction', async (t) => {
  const f = await fixture(t, {
    stages: [],
    tracing: 1,
    main: (ctx) => {
      ctx.trace('Main handler failure trace');
      localOrganizationService(ctx.api.store, profile).create('child', { title: 'Roll back' });
      throw { pluginFault: 'InvalidPluginExecutionException', message: 'Main handler refused' };
    },
  });
  await assert.rejects(f.call(), /Main handler refused/);
  assert.equal(f.store.tableRows('child').length, 0);
  const traces = f.store.tableRows('plugintracelog');
  assert.equal(traces.length, 1);
  assert.equal(traces[0].messagename, name);
  assert.equal(traces[0].messageblock, 'Main handler failure trace');
  assert.match(traces[0].exceptiondetails, /Main handler refused/);
});

test('original main-operation execution requires witnessed internal-step identity before preparing any DLL', async (t) => {
  const f = await fixture(t, {
    stages: [],
    mainDescriptor: {
      typeName: 'Invented.Unqualified',
      context: { initiatingUserId: user, organizationId: user, businessUnitId: user },
    },
  });
  await assert.rejects(f.call(), (error) => error.code === 'LocalPluginMainContextUnavailable');
  assert.match(
    describeCustomApis(f.api).operations.find((op) => op.name === 'customapi:' + name).reason,
    /evidence-qualified mainOperationStepId/,
  );
});

test('synchronous SDK custom API execution shares registered stages and typed final outputs', async (t) => {
  const seen = [];
  const f = await fixture(t, {
    extension: ({ context }) => {
      seen.push(context.Stage);
      assert.equal(Object.hasOwn(context.InputParameters, 'FromSandbox'), false);
      if (context.Stage === 20) context.InputParameters.Text += ' pre';
      if (context.Stage === 40) context.OutputParameters.Answer += ' post';
    },
    main: (ctx) => ({ outputs: { Answer: ctx.inputs.Text + ' main' } }),
  });
  const response = await f.store.transact(() =>
    f.store.sdkMutation(() =>
      f.api.records.executeMessageSyncInternal({
        principal: {
          userId: user,
          evidence: 'Invented SDK custom message',
          grants: [{ message: name, operations: ['execute'] }],
        },
        name,
        parameters: { $type: 'ParameterCollection', values: { Text: 'SDK' } },
      }),
    ),
  );
  assert.equal(response.outputs.values.Answer, 'SDK pre main post');
  assert.deepEqual(seen, [10, 20, 40]);
});

test('synchronous SDK execution refuses an async-only main handler and fences its continuation', async (t) => {
  let release, late;
  const gate = new Promise((resolve) => (release = resolve));
  const f = await fixture(t, {
    stages: [],
    main: (ctx) => {
      localOrganizationService(ctx.api.store, profile).create('child', { title: 'Uncommitted initial effect' });
      late = gate.then(() =>
        localOrganizationService(ctx.api.store, profile).create('child', { title: 'Late effect' }),
      );
      return late;
    },
  });
  await assert.rejects(
    f.store.transact(() =>
      f.store.sdkMutation(() =>
        f.api.records.executeMessageSyncInternal({
          principal: {
            userId: user,
            evidence: 'Invented SDK custom message',
            grants: [{ message: name, operations: ['execute'] }],
          },
          name,
          parameters: { $type: 'ParameterCollection', values: { Text: 'SDK' } },
        }),
      ),
    ),
    (error) => error.status === 501 && error.code === 'SdkAsyncPreOperationUnsupported',
  );
  release();
  await assert.rejects(late, (error) => error.code === 'LocalPluginExecutionExpired');
  assert.equal(f.store.tableRows('child').length, 0);
});

test('recursive JavaScript custom API main operations share the eight-level plugin depth limit', async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    stages: [],
    main: () => {
      calls++;
      if (calls < 10)
        return {
          outputs: pluginMessageValues(
            f.api.records.executeMessageSyncInternal({
              principal: {
                userId: user,
                evidence: 'Invented recursive main operation',
                grants: [{ message: name, operations: ['execute'] }],
              },
              name,
              parameters: { $type: 'ParameterCollection', values: { Text: 'Nested' } },
            }).outputs,
          ),
        };
      return { outputs: { Answer: 'Unexpected depth' } };
    },
  });
  await assert.rejects(f.call(), (error) => error.code === 'LocalPluginDepth');
  assert.equal(calls, 8);
});

test('overlapping asynchronous main operations on separate organizations keep independent invocation depths', async (t) => {
  let release,
    entered = 0,
    both;
  const gate = new Promise((resolve) => (release = resolve));
  const started = new Promise((resolve) => (both = resolve));
  const main = async () => {
    if (++entered === 2) both();
    await gate;
    return { outputs: { Answer: 'Independent' } };
  };
  const first = await fixture(t, { stages: [], tracing: 2, main });
  const second = await fixture(t, { stages: [], tracing: 2, main });
  const calls = [first.call(), second.call()];
  await started;
  release();
  await Promise.all(calls);
  assert.equal(first.store.tableRows('plugintracelog')[0].depth, 1);
  assert.equal(second.store.tableRows('plugintracelog')[0].depth, 1);
});

test(
  'original CLR extensions receive custom API parameters and change the main inputs and final response',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-customapi-stages-'));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const sdk = clrSdk(),
      source = path.join(root, 'Registered.cs'),
      assembly = path.join(root, 'Registered.dll');
    await fs.writeFile(
      source,
      `using System;using Microsoft.Xrm.Sdk;namespace Invented {public sealed class Registered:IPlugin {public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));if(c.MessageName!="${name}"||c.PrimaryEntityName!="none"||c.PrimaryEntityId!=Guid.Empty)throw new Exception("Custom message context lost");if(c.Stage==10){if(c.OutputParameters.Count!=0)throw new Exception("Premature output");c.InputParameters["Text"]="CLR normalized";c.SharedVariables["guard"]="seen";}if(c.Stage==20){if((string)c.SharedVariables["guard"]!="seen")throw new Exception("Shared value lost");c.InputParameters["Text"]=(string)c.InputParameters["Text"]+" before main";}if(c.Stage==40){if((string)c.OutputParameters["Answer"]!="CLR normalized before main")throw new Exception("Main output lost");c.OutputParameters["Answer"]="CLR final";}}}}`,
    );
    compileClr(source, assembly, { references: [sdk] });
    const runtime = await prepareClrRuntime({
      trust: 'execute-local-assembly',
      root,
      assembly: path.basename(assembly),
      typeName: 'Invented.Registered',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, 'cache'),
      serviceProfile: { userId: user, evidence: 'Invented CLR custom API extension contract', grants: [] },
      context: { initiatingUserId: user, organizationId: user, businessUnitId: user },
    });
    const f = await fixture(t, { runtime, main: (ctx) => ({ outputs: { Answer: ctx.inputs.Text } }) });
    assert.equal((await f.call()).body.Answer, 'CLR final');
  },
);

test(
  'an explicitly trusted customapiid runtime executes the original stage-30 main operation',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-customapi-main-'));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const sdk = clrSdk(),
      source = path.join(root, 'OriginalMain.cs'),
      assembly = path.join(root, 'OriginalMain.dll');
    await fs.writeFile(
      source,
      `using System;using Microsoft.Xrm.Sdk;namespace Invented {public sealed class OriginalMain:IPlugin {public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));if(c.MessageName!="${name}"||c.Stage!=30||!c.IsInTransaction)throw new Exception("Wrong main context");var s=((IOrganizationServiceFactory)p.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId);var row=new Entity("child");row["title"]=(string)c.InputParameters["Text"];s.Create(row);if((string)c.InputParameters["Text"]=="reject")throw new InvalidPluginExecutionException("Original main refused");c.OutputParameters["Answer"]="Original main answered";c.SharedVariables["main"]="original";}}}`,
    );
    compileClr(source, assembly, { references: [sdk] });
    const mainDescriptor = {
      trust: 'execute-local-assembly',
      persistentHost: true,
      root,
      assembly: path.basename(assembly),
      typeName: 'Invented.OriginalMain',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, 'cache'),
      serviceProfile: profile,
      context: {
        initiatingUserId: user,
        organizationId: user,
        businessUnitId: user,
        mainOperationStepId: '10000000-0000-0000-0000-000000000003',
        mainOperationStepEvidence: 'Invented internal main-operation step witness',
      },
    };
    const f = await fixture(t, {
      stages: [40],
      mainDescriptor,
      tracing: 2,
      extension: ({ context }) => {
        assert.equal(context.SharedVariables.main, 'original');
        context.OutputParameters.Answer += ' with post';
      },
    });
    assert.equal(describeCustomApis(f.api).operations.find((op) => op.name === 'customapi:' + name).level, 'behaviour');

    const sdkResponse = await f.store.transact(() =>
      f.store.sdkMutation(() =>
        f.api.records.executeMessageSyncInternal({
          principal: {
            userId: user,
            evidence: 'Invented first SDK CLR main call',
            grants: [{ message: name, operations: ['execute'] }],
          },
          name,
          parameters: { $type: 'ParameterCollection', values: { Text: 'SDK main input' } },
        }),
      ),
    );
    assert.equal(sdkResponse.outputs.values.Answer, 'Original main answered with post');
    assert.equal((await f.call('Main input')).body.Answer, 'Original main answered with post');
    await assert.rejects(
      f.call('reject'),
      (error) => error.details?.innerCode === '0x80040265' && /Original main refused/.test(error.message),
    );
    assert.deepEqual(
      f.store.tableRows('child').map((row) => row.title),
      ['SDK main input', 'Main input'],
    );
    const mainTraces = f.store
      .tableRows('plugintracelog')
      .filter((trace) => trace.typename === 'Invented.OriginalMain');
    assert.equal(mainTraces.length, 3);
    assert.match(mainTraces.at(-1).exceptiondetails, /Original main refused/);
    assert.ok(
      mainTraces.every(
        (trace) => trace.pluginstepid.id === mainDescriptor.context.mainOperationStepId && trace.messagename === name,
      ),
    );
    assert.equal(describeCustomApis(f.api).operations.find((op) => op.name === 'customapi:' + name).level, 'behaviour');
    await f.call('Live pooled host');
    const stopped = f.diagnostics.filter((entry) => entry.code === 'PLUGIN_CLR_HOST_STOPPED').length;
    const replacement = {
      ...mainDescriptor,
      context: {
        ...mainDescriptor.context,
        mainOperationStepId: '10000000-0000-0000-0000-000000000004',
        mainOperationStepEvidence: 'Invented refreshed internal step witness',
      },
    };
    f.mainDescriptors.set(user, replacement);
    await prepareCustomApiRuntimes(f.api, { refresh: true });
    assert.ok(f.diagnostics.filter((entry) => entry.code === 'PLUGIN_CLR_HOST_STOPPED').length > stopped);
    assert.equal(f.runtimes.get(user).descriptor, replacement);
    await f.call('Refreshed runtime');
    const refreshed = f.store
      .tableRows('plugintracelog')
      .filter((trace) => trace.typename === 'Invented.OriginalMain')
      .at(-1);
    assert.equal(refreshed.pluginstepid.id, replacement.context.mainOperationStepId);
    const beforeDelete = f.diagnostics.filter((entry) => entry.code === 'PLUGIN_CLR_HOST_STOPPED').length;
    f.store.state.tables.customapi = [];
    await prepareCustomApiRuntimes(f.api);
    assert.equal(f.runtimes.has(user), false);
    const finalStops = f.diagnostics.filter((entry) => entry.code === 'PLUGIN_CLR_HOST_STOPPED').slice(beforeDelete);
    assert.equal(finalStops.length, 1);
    assert.equal(finalStops[0].absenceVerified, true);
  },
);

test(
  'an original CLR caller executes a custom OrganizationRequest and receives its generic response results',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-customapi-caller-'));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const sdk = clrSdk(),
      source = path.join(root, 'Caller.cs'),
      assembly = path.join(root, 'Caller.dll');
    await fs.writeFile(
      source,
      `using System;using System.ServiceModel;using Microsoft.Xrm.Sdk;namespace Invented {public sealed class Caller:IPlugin {public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));var target=(Entity)c.InputParameters["Target"];var s=((IOrganizationServiceFactory)p.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId);var request=new OrganizationRequest("${name}");request.Parameters["Text"]="CLR SDK";if(target.GetAttributeValue<bool>("catch")){bool caught=false;try{s.Execute(request);}catch(FaultException<OrganizationServiceFault>){caught=true;}if(!caught)throw new Exception("Function rejection missing");target["note"]="caught";return;}var result=s.Execute(request);if(result.ResponseName!="${name}"||(string)result.Results["Answer"]!="CLR SDK answered")throw new Exception("Custom response lost");target["note"]="received";}}}`,
    );
    compileClr(source, assembly, { references: [sdk, 'System.ServiceModel.dll'] });
    const runtime = await prepareClrRuntime({
      trust: 'execute-local-assembly',
      root,
      assembly: path.basename(assembly),
      typeName: 'Invented.Caller',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, 'cache'),
      serviceProfile: {
        userId: user,
        evidence: 'Invented original caller execution grant',
        grants: [{ message: name, operations: ['execute'] }],
      },
      context: { initiatingUserId: user, organizationId: user, businessUnitId: user },
    });
    for (const isFunction of [false, true]) {
      const f = await fixture(t, {
        stages: [20],
        isFunction,
        extension: ({ context }) => {
          if (context.InputParameters.Text === 'CLR SDK') {
            assert.equal(context.InputParameters.FromSandbox, true);
            assert.equal(context.Depth, 2);
          } else
            assert.equal(
              Object.hasOwn(context.InputParameters, 'FromSandbox'),
              false,
              'a JavaScript SDK caller does not inherit an ancestor original CLR source',
            );
        },
        main: (ctx) => {
          if (isFunction) throw new Error('Function rejected');
          if (ctx.inputs.Text !== 'JS descendant') {
            const child = localOrganizationService(ctx.api.store, runtime.descriptor.serviceProfile).executeMessageSync(
              name,
              null,
              { $type: 'ParameterCollection', values: { Text: 'JS descendant' } },
            );
            assert.equal(child.outputs.values.Answer, 'JS descendant answered');
          }
          return { outputs: { Answer: ctx.inputs.Text + ' answered' } };
        },
      });
      f.store.state.mappings.widget = { entitySet: 'widgets', idColumn: 'widgetid' };
      f.store.state.tables.widget = [];
      f.store.recordPipeline = f.api.records;
      const record = { widgetid: user };
      let observed;
      const invocation = f.store.transact(() => {
        f.store.pluginInTransaction = true;
        try {
          if (isFunction) f.store.createRecord('widget', { title: 'Must roll back' }, { admin: true });
          observed = executeClrPlugin(
            runtime,
            clrContext({
              runtime,
              store: f.store,
              step: { id: user, name: 'Caller', typeName: 'Invented.Caller', contract: { mode: 0 }, images: [] },
              entity: 'widget',
              operation: 'create',
              stage: 20,
              target: { title: 'Caller', ...(isFunction ? { catch: true } : {}) },
              record,
              frame: {},
              depth: 1,
            }),
            { store: f.store },
          );
          return observed;
        } finally {
          f.store.pluginInTransaction = false;
        }
      });
      if (isFunction) {
        await assert.rejects(invocation, (error) => error.status === 400 && error.details?.innerCode === '0x8009000c');
        assert.equal(observed.target.attributes.note, 'caught');
        assert.equal(f.store.tableRows('widget').length, 0);
      } else {
        assert.equal((await invocation).target.attributes.note, 'received');
        assert.equal((await f.call('JS direct')).body.Answer, 'JS direct answered');
      }
    }
  },
);
