// @test-kind unproven: local model of SDK entry snapshot detachment and callback operation metadata; no native capture cited
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  pluginExecutionLifetime,
  pluginInvocationParent,
  pluginInvocationSdkParent,
} from '../lib/plugin-execution-lifetime.mjs';
import { clrSdkEntryContext } from '../lib/plugin-sdk-parent.mjs';
import { install } from '../lib/dataverse-customapi.mjs';
import { localOrganizationService } from '../lib/local-organization-service.mjs';
import { closeClrHostPool, executeClrPlugin, prepareClrRuntime } from '../lib/plugin-clr.mjs';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { attachClrSteps } from './fixtures/plugin-pipeline.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';
import { ORDINARY_CLR_TIMEOUT_MS } from './fixtures/clr-budget.mjs';
import { DataStore, emptyState } from '../lib/data.mjs';
import { pluginCatalogue, runPluginPhase } from '../lib/exported-plugins.mjs';
import { fixedClock } from '../lib/runtime-clock.mjs';
import { pluginContextValues } from '../lib/plugin-message-values.mjs';

const id = (n) => `70000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const apiName = 'invented_ParentSnapshot';

test('SDK entry snapshots remain detached while the author retains its live invocation context', () => {
  const store = {},
    context = { $type: 'ExecutionContext', values: { SharedVariables: { values: { earlier: 'Completed' } } } };
  const execution = pluginExecutionLifetime(store, 1, () => context);
  execution.run(() => {
    context.values.SharedVariables.values.current = 'Live';
    assert.equal(pluginInvocationParent(store).values.SharedVariables.values.current, 'Live');
    const first = pluginInvocationSdkParent(store);
    assert.deepEqual(first.values.SharedVariables.values, { earlier: 'Completed' });
    first.values.SharedVariables.values.earlier = 'Child mutation';
    assert.equal(pluginInvocationSdkParent(store).values.SharedVariables.values.earlier, 'Completed');
  });
  execution.close();
  for (const absent of [undefined, null]) {
    const values = clrSdkEntryContext({
      inputParameters: absent,
      outputParameters: absent,
      sharedVariables: absent,
    }).values;
    for (const name of ['InputParameters', 'OutputParameters', 'SharedVariables'])
      assert.deepEqual(values[name], { $type: 'ParameterCollection', values: {} });
  }
});

for (const legacy of [false, true])
  test(`six ${legacy ? 'legacy' : 'typed'} JavaScript-only callbacks share known operation metadata within each request`, async () => {
    const clock = fixedClock(),
      state = emptyState();
    state.mappings.widget = { entitySet: 'widgets', idColumn: 'widgetid' };
    state.tables.widget = [];
    const store = new DataStore({ state, clock });
    const seen = [];
    const handlers = new Map([
      [
        'Invented.Metadata',
        (payload) => {
          const context = legacy ? pluginContextValues(pluginInvocationParent(store), store) : payload.context;
          const entry = pluginInvocationSdkParent(store).values;
          assert.equal(context.RequestId, context.OperationId);
          assert.notEqual(context.CorrelationId, context.RequestId);
          assert.equal(entry.RequestId.value, context.RequestId);
          assert.equal(entry.OperationId.value, context.OperationId);
          assert.equal(entry.CorrelationId.value, context.CorrelationId);
          assert.equal(entry.OperationCreatedOn.value, context.OperationCreatedOn);
          assert.equal(context.OperationCreatedOn.endsWith('Z'), false);
          seen.push([
            context.MessageName,
            context.Stage,
            context.RequestId,
            context.CorrelationId,
            context.OperationCreatedOn,
          ]);
          clock.advance(1000);
        },
      ],
    ]);
    const steps = ['Create', 'Update'].flatMap((message, index) =>
      [10, 20, 40].map((stage) => ({
        id: id(50 + index * 3 + stage),
        enabled: true,
        entity: 'widget',
        message,
        typeName: 'Invented.Metadata',
        assemblyId: 'invented',
        stage,
        rank: 1,
        mode: 0,
        supportedDeployment: 0,
        filteringAttributes: [],
        images: [],
      })),
    );
    const selectedHandlers = legacy
      ? new Map(steps.map((step) => [step.id, handlers.get('Invented.Metadata')]))
      : handlers;
    const items = pluginCatalogue({ plugins: { steps }, handlers: selectedHandlers });
    store.setPluginPipeline((context) => runPluginPhase({ ...context, store, items, handlers: selectedHandlers }));
    const row = await store.create('widget', { title: 'Created' }, { admin: true });
    await store.update('widget', row.widgetid, { title: 'Updated' }, { admin: true });
    assert.deepEqual(
      seen.map(([message, stage]) => [message, stage]),
      [
        ['Create', 10],
        ['Create', 20],
        ['Create', 40],
        ['Update', 10],
        ['Update', 20],
        ['Update', 40],
      ],
    );
    for (const offset of [0, 3])
      for (const index of [1, 2]) assert.deepEqual(seen[offset].slice(2), seen[offset + index].slice(2));
    assert.notEqual(seen[0][2], seen[3][2]);
    assert.notEqual(seen[0][4], seen[3][4]);
  });

// @test-kind parity: native dev-environment recorder corpus (pipelineEffects): nested Create parent is stage-30 main operation, entry snapshot above
for (const flavor of ['typed', 'legacy', 'original'])
  test(
    `${flavor} SDK callers preserve per-step entry images, inputs and shared state across repeated live argument calls`,
    { skip: CLR_SKIP },
    async (t) => {
      const original = flavor === 'original',
        legacy = flavor === 'legacy';
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-sdk-parent-'));
      const backends = [],
        standalone = [],
        pending = [],
        releases = [],
        late = [];
      t.after(async () => {
        for (const release of releases) release();
        await Promise.all(pending);
        for (const backend of backends) await backend.close();
        for (const runtime of standalone) closeClrHostPool({ runtime });
        await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
      });
      const sdk = clrSdk(),
        source = path.join(root, 'Parents.cs'),
        assembly = path.join(root, 'Parents.dll');
      // Native (parity corpus pipelineEffects): a nested Create PreOperation's parent is its own Create main operation; the SDK entry snapshot is one level up.
      await fs.writeFile(
        source,
        `using System;using Microsoft.Xrm.Sdk;namespace Invented {
public sealed class Child:IPlugin{public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));var row=(Entity)c.InputParameters["Target"];var kind=row.GetAttributeValue<string>("kind");var parent=c.ParentContext;if(parent==null||parent.MessageName!="Create"||parent.Stage!=30||parent.Depth!=c.Depth)throw new Exception("Create main operation parent missing");parent=parent.ParentContext;if(parent==null)throw new Exception("Parent missing");if(kind=="raw"){if(parent.InputParameters.Count!=0||parent.OutputParameters.Count!=0||parent.SharedVariables.Count!=0)throw new Exception("Missing CLR envelopes were not normalized");return;}
if(c.RequestId!=parent.RequestId||c.OperationId!=parent.OperationId||c.CorrelationId!=parent.CorrelationId||c.OperationCreatedOn!=parent.OperationCreatedOn||c.OperationCreatedOn.Kind!=DateTimeKind.Unspecified||parent.OperationCreatedOn.Kind!=DateTimeKind.Unspecified)throw new Exception("SDK entry operation metadata lost");if(!row.GetAttributeValue<string>("label").StartsWith(kind=="main"?"Edited argument":"Live target argument"))throw new Exception("SDK argument was frozen with parent metadata");if(parent.SharedVariables.Contains("currentMarker")||parent.OutputParameters.Contains("currentOutput"))throw new Exception("In-flight caller state leaked into SDK parent");
if(kind=="main"){if(parent.Stage!=30||parent.MessageName!="${apiName}"||(string)parent.InputParameters["Text"]!="Requested"||parent.OutputParameters.Count!=0||parent.SecondaryEntityName!="none"||parent.IsolationMode!=2)throw new Exception("Main entry snapshot mismatch");return;}
if(!(parent.SharedVariables["AcceptLang"] is string)||(string)parent.SharedVariables["AcceptLang"]!="fr-FR"||!(parent.SharedVariables["IsAutoTransact"] is bool)||(bool)parent.SharedVariables["IsAutoTransact"]!=(kind!="framework"))throw new Exception("Typed framework SharedVariables mismatch");var target=(Entity)parent.InputParameters["Target"];if((string)target["title"]!="Requested"||target.Contains("added"))throw new Exception("Caller Target snapshot changed");if(kind=="framework"){if(parent.MessageName!="Upsert"||parent.Stage!=30||parent.PrimaryEntityName!="none"||parent.PrimaryEntityId!=Guid.Empty||parent.PreEntityImages.Count!=0||parent.PostEntityImages.Count!=0||parent.OutputParameters.Count!=0||parent.SharedVariables.Contains("seedMarker")||!parent.InputParameters.Contains("ReturnRowVersion")||parent.InputParameters["ReturnRowVersion"]!=null)throw new Exception("HTTP Upsert framework parent mismatch");}
else{if(parent.MessageName!="Update"||parent.Stage!=20||parent.PrimaryEntityName!="widget"||parent.PrimaryEntityId!=new Guid("${id(1)}")||parent.OwningExtension.Id!=new Guid("${id(12)}")||(string)parent.SharedVariables["seedMarker"]!="Earlier"||parent.PreEntityImages["Original"].GetAttributeValue<string>("title")!="Before"||!(parent.InputParameters["ConcurrencyBehavior"] is ConcurrencyBehavior)||parent.SecondaryEntityName!="none")throw new Exception("Update entry snapshot mismatch");}
}} public sealed class Parent:IPlugin{public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));var target=(Entity)c.InputParameters["Target"];var kind=target.GetAttributeValue<string>("kind");target["title"]="Live target";target["added"]=true;c.PreEntityImages["Original"]["title"]="Live image";c.SharedVariables["seedMarker"]="Edited";c.SharedVariables["currentMarker"]="Live";c.SharedVariables["opaque"]=new object();c.OutputParameters["currentOutput"]="Live";var service=((IOrganizationServiceFactory)p.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId);for(int i=1;i<=2;i++){var row=new Entity("child");row["kind"]=kind;row["label"]=target.GetAttributeValue<string>("title")+" argument "+i;service.Create(row);}c.SharedVariables.Remove("opaque");if((string)c.SharedVariables["currentMarker"]!="Live"||(string)c.SharedVariables["seedMarker"]!="Edited"||(string)c.OutputParameters["currentOutput"]!="Live"||c.PreEntityImages["Original"].GetAttributeValue<string>("title")!="Live image"||target.GetAttributeValue<string>("title")!="Live target")throw new Exception("SDK snapshot changed caller live state");}}
public sealed class Main:IPlugin{public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));c.InputParameters["Text"]="Edited";c.SharedVariables["currentMarker"]="Live";c.OutputParameters["currentOutput"]="Live";var s=((IOrganizationServiceFactory)p.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId);for(int i=1;i<=2;i++){var row=new Entity("child");row["kind"]="main";row["label"]=(string)c.InputParameters["Text"]+" argument "+i;s.Create(row);}if((string)c.InputParameters["Text"]!="Edited"||(string)c.SharedVariables["currentMarker"]!="Live"||(string)c.OutputParameters["currentOutput"]!="Live")throw new Exception("Main live state changed");c.OutputParameters["Reply"]="Completed";}}
public sealed class AsyncImages:IPlugin{public void Execute(IServiceProvider p){var c=(IPluginExecutionContext4)p.GetService(typeof(IPluginExecutionContext));if(c.Mode!=1||c.PreEntityImagesCollection.Length!=0||c.PostEntityImagesCollection.Length!=2||(string)c.SharedVariables["arrayCounts"]!="0:2")throw new Exception("Async Context4 image availability differs from model");foreach(var images in c.PostEntityImagesCollection)if(images.Count!=1||!images.Contains("AsynchronousStepPrimaryName"))throw new Exception("Unexpected registered post image");var parent=c.ParentContext;if(parent==null||parent.MessageName!=c.MessageName||parent.Stage!=30||parent.Mode!=1||parent.Depth!=c.Depth||parent.PrimaryEntityName!="widget"||parent.PrimaryEntityId!=new Guid("${id(1)}")||parent.IsInTransaction||parent.IsolationMode!=2||parent.OperationId!=c.OperationId||parent.RequestId!=c.RequestId||parent.CorrelationId!=c.CorrelationId||parent.OperationCreatedOn!=c.OperationCreatedOn||parent.OperationCreatedOn.Kind!=DateTimeKind.Unspecified)throw new Exception("Async main parent tuple missing");if(parent.OutputParameters.Count!=0||parent.PreEntityImages.Count!=0||parent.PostEntityImages.Count!=0||parent.InputParameters.Contains("Targets")||!parent.InputParameters.Contains("Target")||((Entity)parent.InputParameters["Target"]).Id!=new Guid("${id(1)}")||(string)parent.InputParameters["tag"]!="known")throw new Exception("Async main scalar inputs missing");if(c.MessageName=="UpdateMultiple"&&(ConcurrencyBehavior)parent.InputParameters["ConcurrencyBehavior"]!=ConcurrencyBehavior.Default)throw new Exception("Async main concurrency input missing");if(c.MessageName=="CreateMultiple"&&!(bool)parent.InputParameters["FromSandbox"])throw new Exception("Async main SDK source missing");}}public sealed class Raw:IPlugin{public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));var s=((IOrganizationServiceFactory)p.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId);var row=new Entity("child");row["kind"]="raw";s.Create(row);}}
}`,
      );
      compileClr(source, assembly, { references: [sdk] });
      const profile = {
        userId: id(1),
        evidence: 'Invented SDK parent boundary',
        grants: [{ entity: 'child', operations: ['create'] }],
      };
      const descriptor = {
        trust: 'execute-local-assembly',
        root,
        assembly: path.basename(assembly),
        typeName: 'Invented.Main',
        sdkRoot: path.dirname(sdk),
        sdkAssembly: path.basename(sdk),
        cacheRoot: path.join(root, 'cache'),
        serviceProfile: profile,
        timeoutMs: ORDINARY_CLR_TIMEOUT_MS,
        persistentHost: true,
        context: {
          executionUserId: id(1),
          initiatingUserId: id(1),
          organizationId: id(1),
          businessUnitId: id(1),
          mainOperationStepId: id(90),
          mainOperationStepEvidence: 'Invented main entry identity',
        },
      };
      let store;
      const f = await contractModuleFixture(t, {
        mappings: Object.fromEntries(
          ['widget', 'child'].map((name) => [
            name,
            {
              entitySet: name === 'child' ? 'children' : 'widgets',
              idColumn: name + 'id',
              nameColumn: 'title',
              fields: Object.fromEntries(
                ['title', 'kind', 'label'].map((field) => [field, { dataverseType: 'nvarchar' }]),
              ),
            },
          ]),
        ),
        tables: {
          widget: [{ widgetid: id(1), title: 'Before' }],
          child: [],
          customapi: [
            { customapiid: id(1), uniquename: apiName, bindingtype: 0, ...(original ? { plugintypeid: id(1) } : {}) },
          ],
          customapirequestparameter: [
            { customapirequestparameterid: id(1), customapiid: id(1), uniquename: 'Text', type: 10, isoptional: false },
          ],
          customapiresponseproperty: [
            { customapiresponsepropertyid: id(1), customapiid: id(1), uniquename: 'Reply', type: 10 },
          ],
          ...(original
            ? {
                plugintype: [{ plugintypeid: id(1), typename: 'Invented.Main', pluginassemblyid: id(1) }],
                pluginassembly: [{ pluginassemblyid: id(1), name: 'Parents' }],
              }
            : {}),
        },
        extension: {
          name: 'customapi',
          async install(api) {
            store = api.store;
            await install(api, {
              pluginRuntimes: original ? new Map([[id(1), { ...descriptor, persistentHost: false }]]) : new Map(),
              handlers: original
                ? new Map()
                : new Map([
                    [
                      apiName.toLowerCase(),
                      {
                        handler() {
                          const live = pluginInvocationParent(store).values;
                          live.InputParameters.values.Text = 'Edited';
                          live.SharedVariables.values.currentMarker = 'Live';
                          live.OutputParameters.values.currentOutput = 'Live';
                          for (let i = 1; i <= 2; i++)
                            localOrganizationService(store, profile).create('child', {
                              kind: 'main',
                              label: live.InputParameters.values.Text + ' argument ' + i,
                            });
                          assert.equal(live.InputParameters.values.Text, 'Edited');
                          assert.equal(live.OutputParameters.values.currentOutput, 'Live');
                          return { outputs: { Reply: 'Completed' } };
                        },
                      },
                    ],
                  ]),
            }).ready;
          },
        },
      });
      const childRuntime = await prepareClrRuntime({ ...descriptor, typeName: 'Invented.Child' });
      const parentRuntime = original ? await prepareClrRuntime({ ...descriptor, typeName: 'Invented.Parent' }) : null;
      const step = (n, entity, typeName, rank, images = []) => ({
        id: id(n),
        enabled: true,
        entity,
        typeName,
        assemblyId: 'invented',
        message: entity === 'child' ? 'Create' : 'Update',
        stage: 20,
        mode: 0,
        rank,
        supportedDeployment: 0,
        images,
        filteringAttributes: [],
      });
      const mounted = await attachClrSteps(t, {
        store,
        runtime: (item) =>
          item.entity === 'child' ? childRuntime : item.typeName === 'Invented.Parent' ? parentRuntime : null,
        steps: [
          step(11, 'widget', 'Invented.Seed', 1),
          step(12, 'widget', 'Invented.Parent', 2, [{ alias: 'Original', type: 0, attributes: ['title'] }]),
          step(13, 'child', 'Invented.Child', 1),
        ],
        handlers: new Map([
          [
            'Invented.Seed',
            ({ context }) => {
              context.SharedVariables.seedMarker = 'Earlier';
            },
          ],
          [
            legacy ? id(12) : 'Invented.Parent',
            (payload) => {
              const { context } = payload;
              const target = legacy ? payload.target : context.InputParameters.Target;
              target.title = 'Live target';
              target.added = true;
              if (!legacy) {
                context.PreEntityImages.Original.title = 'Live image';
                context.SharedVariables.seedMarker = 'Edited';
                context.SharedVariables.currentMarker = 'Live';
                context.SharedVariables.opaque = () => {};
                context.OutputParameters.currentOutput = 'Live';
              }
              for (let i = 1; i <= 2; i++)
                localOrganizationService(store, profile).create('child', {
                  kind: target.kind,
                  label: target.title + ' argument ' + i,
                });
              if (legacy) {
                const service = localOrganizationService(store, profile);
                const gate = new Promise((resolve) => releases.push(resolve));
                pending.push(
                  gate.then(() => service.create('child', { kind: 'late' })).catch((error) => late.push(error.code)),
                );
                assert.equal(target.title, 'Live target');
                return { target: { title: target.title, added: target.added } };
              }
              delete context.SharedVariables.opaque;
              assert.equal(target.title, 'Live target');
              assert.equal(context.PreEntityImages.Original.title, 'Live image');
              assert.equal(context.SharedVariables.seedMarker, 'Edited');
            },
          ],
        ]),
      });
      backends.push(mounted.backend);
      for (const framework of [false, true]) {
        store.tableRows('widget')[0].title = 'Before';
        await f.json(
          await f.request(
            'PATCH',
            `/widgets(${id(1)})`,
            { title: 'Requested', kind: framework ? 'framework' : 'entry' },
            { 'Accept-Language': 'fr-FR', ...(framework ? {} : { 'If-Match': '*' }) },
          ),
          200,
        );
        assert.equal(store.tableRows('widget')[0].title, 'Live target');
        assert.equal(store.tableRows('widget')[0].added, true);
      }
      const main = await f.json(await f.request('POST', '/' + apiName, { Text: 'Requested' }), 200);
      assert.equal(main.Reply, 'Completed');
      assert.equal(store.tableRows('child').length, 6);
      for (const release of releases) release();
      await Promise.all(pending);
      if (legacy) assert.deepEqual(late, ['LocalPluginExecutionExpired', 'LocalPluginExecutionExpired']);
      assert.equal(store.tableRows('child').length, 6, 'expired callbacks cannot reuse their retained SDK service');
      if (original) {
        const raw = await prepareClrRuntime({ ...descriptor, typeName: 'Invented.Raw' });
        standalone.push(raw);
        for (const missing of [undefined, null])
          await store.transact(() =>
            executeClrPlugin(
              raw,
              {
                context: {
                  MessageName: 'InventedRaw',
                  Stage: 20,
                  Depth: 1,
                  UserId: { $type: 'Guid', value: profile.userId },
                },
                inputParameters: missing,
                outputParameters: missing,
                sharedVariables: missing,
              },
              { store },
            ),
          );
        assert.equal(store.tableRows('child').length, 8);
        const imageRuntime = await prepareClrRuntime({ ...descriptor, typeName: 'Invented.AsyncImages' });
        standalone.push(imageRuntime);
        for (const message of ['CreateMultiple', 'UpdateMultiple']) {
          const nodes = ['Invented.ArrayModel', 'Invented.AsyncImages'].map((typeName, index) => ({
            ...step(70 + index, 'widget', typeName, index + 1),
            message,
            mode: 1,
            stage: 40,
          }));
          const runtimes = new Map([[id(71), imageRuntime]]);
          const handlers = new Map([
            [
              'Invented.ArrayModel',
              ({ context }) => {
                // @parity-evidence: native bulk.json ev 1407 and 1446 (asynchronous bulk-origin CreateMultiple and UpdateMultiple without registered images): PreEntityImagesCollection [], PostEntityImagesCollection one AsynchronousStepPrimaryName set per target
                assert.equal(context.PreEntityImagesCollection.length, 0);
                assert.equal(context.PostEntityImagesCollection.length, 2);
                assert.ok(context.PostEntityImagesCollection.every((images) => images.AsynchronousStepPrimaryName));
                assert.equal(context.Depth, 2);
                assert.equal(context.ParentContext.MessageName, message);
                assert.equal(context.ParentContext.Stage, 30);
                assert.equal(context.ParentContext.Mode, 1);
                assert.equal(context.ParentContext.Depth, 2);
                assert.equal(context.ParentContext.InputParameters.Target.widgetid, id(1));
                assert.equal(context.ParentContext.InputParameters.tag, 'known');
                context.SharedVariables.arrayCounts = context.PreEntityImagesCollection.length + ':2';
              },
            ],
          ]);
          const items = pluginCatalogue({
            plugins: { steps: nodes },
            handlers,
            runtimes,
            overrides: { ['plugin-step:' + id(71)]: { mode: 'clr' } },
          });
          const records = [store.tableRows('widget')[0], { widgetid: id(2) }];
          runPluginPhase({
            store,
            items,
            runtimes,
            handlers,
            entity: 'widget',
            operation: message.toLowerCase(),
            stage: 40,
            asyncExecution: true,
            // Two targets: a request that entered as the multiple message (plugin-bulk.mjs).
            bulkOrigin: true,
            initialFrame: {
              operationDepth: 2,
              requestId: id(80),
              operationId: id(81),
              correlationId: id(82),
              createdOn: '2026-01-02T03:04:05.000Z',
              createdOnWire: { $type: 'DateTime', value: '2026-01-02T03:04:05.000' },
              asyncSourceParent: {
                primaryId: id(1),
                inputParameters: {
                  $type: 'ParameterCollection',
                  values: {
                    Target: { $type: 'Entity', logicalName: 'widget', id: id(1), attributes: {} },
                    tag: 'known',
                    ...(message === 'UpdateMultiple'
                      ? { ConcurrencyBehavior: { $type: 'ConcurrencyBehavior', value: 0 } }
                      : { FromSandbox: true }),
                  },
                },
                sharedVariables: { $type: 'ParameterCollection', values: { tag: 'known' } },
              },
            },
            record: { widgetid: '00000000-0000-0000-0000-000000000000', bulkIds: [id(1), id(2)] },
            targets: records.map((row) => ({
              $type: 'Entity',
              logicalName: 'widget',
              id: row.widgetid,
              attributes: {},
            })),
            records,
            previousRecords: message === 'CreateMultiple' ? [] : records,
            identity: { admin: true },
          });
        }
      }
    },
  );
