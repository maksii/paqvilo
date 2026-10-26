import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DataStore } from '../lib/data.mjs';
import { prepareClrRuntime, dispatchSdkCall } from '../lib/plugin-clr.mjs';
import { pluginCatalogue, runPluginPhase } from '../lib/exported-plugins.mjs';
import { ORDINARY_CLR_TIMEOUT_MS } from './fixtures/clr-budget.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';

const user = '10000000-0000-0000-0000-000000000001',
  record = '20000000-0000-0000-0000-000000000001';
test('Named SDK tag validation rejects unsupported values before backend changes', () => {
  const store = new DataStore({
      state: {
        mappings: { item: { idColumn: 'itemid' } },
        tables: { item: [{ itemid: record }] },
        settings: { permissionMode: 'permissive' },
      },
    }),
    profile = {
      userId: user,
      evidence: 'Invented SDK tag contract',
      grants: [{ entity: 'item', operations: ['delete'] }],
    };
  for (const tag of [null, 42, 'x'.repeat(8193)])
    assert.throws(
      () =>
        dispatchSdkCall({
          store,
          profile,
          message: {
            method: 'Execute',
            userId: user,
            arguments: [
              {
                $type: 'OrganizationRequest',
                requestName: 'Delete',
                parameters: {
                  $type: 'ParameterCollection',
                  values: { Target: { $type: 'EntityReference', logicalName: 'item', id: record }, tag },
                },
              },
            ],
          },
        }),
      (error) => error.code === 'LocalPluginSdkUnsupported',
    );
  assert.throws(
    () =>
      dispatchSdkCall({
        store,
        profile,
        message: {
          method: 'Execute',
          userId: user,
          parentContext: {
            $type: 'ExecutionContext',
            values: { SharedVariables: { $type: 'ParameterCollection', values: { tag: 'parent' } } },
          },
          arguments: [
            {
              $type: 'OrganizationRequest',
              requestName: 'Delete',
              parameters: {
                $type: 'ParameterCollection',
                values: { Target: { $type: 'EntityReference', logicalName: 'item', id: record }, tag: 'child' },
              },
            },
          ],
        },
      }),
    (error) => error.code === 'LocalPluginTagImmutable',
  );
  assert.equal(store.state.tables.item.length, 1);
  assert.equal(store.pluginSdkTag, undefined);
});

test(
  'Original DLL named DeleteRequest tag reaches all stages, PreValidation parent and nested shortcut calls',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-sdk-tag-'));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const sdk = clrSdk(),
      source = path.join(root, 'Tag.cs'),
      assembly = path.join(root, 'Tag.dll');
    await fs.writeFile(
      source,
      `using System;using Microsoft.Xrm.Sdk;using Microsoft.Xrm.Sdk.Messages;namespace Invented {
 public sealed class Caller:IPlugin {public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));if(c.SharedVariables.Contains("tag"))throw new Exception("Tag leaked into caller");var s=((IOrganizationServiceFactory)p.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId);var r=new DeleteRequest{Target=new EntityReference("audit",new Guid("${record}"))};r.Parameters["tag"]="caller-tag";s.Execute(r);}}
 public sealed class DeleteObserver:IPlugin {readonly bool mutate;public DeleteObserver(string u,string s){mutate=u=="mutate";}public void Execute(IServiceProvider p){var c=(IPluginExecutionContext2)p.GetService(typeof(IPluginExecutionContext));if((string)c.SharedVariables["tag"]!="caller-tag"||c.IsPortalsClientCall||c.Depth!=2)throw new Exception("Child tag/origin mismatch");if(c.Stage==10)c.SharedVariables["pre"]="seen";if(c.Stage==20){if((string)c.ParentContext.SharedVariables["tag"]!="caller-tag"||(string)c.ParentContext.SharedVariables["pre"]!="seen")throw new Exception("PreValidation parent tag lost");var s=((IOrganizationServiceFactory)p.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId);s.Create(new Entity("leaf"));}if(c.Stage==40&&mutate)c.SharedVariables["tag"]="modified";}}
 public sealed class Leaf:IPlugin {public void Execute(IServiceProvider p){var c=(IPluginExecutionContext2)p.GetService(typeof(IPluginExecutionContext));if((string)c.SharedVariables["tag"]!="caller-tag"||c.Depth!=3||c.IsPortalsClientCall)throw new Exception("Nested shortcut tag lost");((Entity)c.InputParameters["Target"])["title"]="inherited";}}
 }`,
    );
    compileClr(source, assembly, { references: [sdk, 'System.Runtime.Serialization.dll'] });
    const profile = {
        userId: user,
        evidence: 'Invented named SDK tag flow',
        grants: [
          { entity: 'audit', operations: ['read', 'delete'] },
          { entity: 'leaf', operations: ['create'] },
        ],
      },
      descriptor = {
        trust: 'execute-local-assembly',
        root,
        assembly: 'Tag.dll',
        sdkRoot: path.dirname(sdk),
        sdkAssembly: path.basename(sdk),
        cacheRoot: path.join(root, 'cache'),
        serviceProfile: profile,
        context: { initiatingUserId: user, organizationId: user, businessUnitId: user },
        timeoutMs: ORDINARY_CLR_TIMEOUT_MS,
      };
    const runtimeByType = new Map();
    for (const type of ['Caller', 'DeleteObserver', 'Leaf'])
      runtimeByType.set(type, await prepareClrRuntime({ ...descriptor, typeName: 'Invented.' + type }));
    let index = 0;
    const step = (entity, message, stage, type) => ({
        id: '30000000-0000-0000-0000-' + String(++index).padStart(12, '0'),
        enabled: true,
        entity,
        message,
        stage,
        rank: 1,
        mode: 0,
        supportedDeployment: 0,
        filteringAttributes: [],
        images: [],
        typeName: 'Invented.' + type,
        assemblyId: 'invented',
      }),
      steps = [
        step('item', 'Update', 20, 'Caller'),
        ...[10, 20, 40].map((stage) => step('audit', 'Delete', stage, 'DeleteObserver')),
        step('leaf', 'Create', 20, 'Leaf'),
      ],
      runtimes = new Map(steps.map((step) => [step.id, runtimeByType.get(step.typeName.split('.').at(-1))])),
      items = pluginCatalogue({
        plugins: { steps },
        runtimes,
        overrides: Object.fromEntries(steps.map((step) => ['plugin-step:' + step.id, { mode: 'clr' }])),
      });
    const store = new DataStore({
      state: {
        mappings: { item: { idColumn: 'itemid' }, audit: { idColumn: 'auditid' }, leaf: { idColumn: 'leafid' } },
        tables: { item: [{ itemid: record }], audit: [{ auditid: record }], leaf: [] },
        settings: { permissionMode: 'permissive' },
      },
    });
    store.setPluginPipeline((event) => runPluginPhase({ ...event, store, items, runtimes }));
    await store.update('item', record, { title: 'Trigger' }, { contactId: user });
    assert.equal(store.state.tables.audit.length, 0);
    assert.equal(store.state.tables.leaf[0].title, 'inherited');
    assert.equal(store.pluginSdkTag, undefined);
    const late = steps.find((step) => step.entity === 'audit' && step.stage === 40),
      original = runtimes.get(late.id);
    runtimes.set(late.id, { ...original, descriptor: { ...original.descriptor, unsecureConfiguration: 'mutate' } });
    const rollback = new DataStore({
      state: {
        mappings: { item: { idColumn: 'itemid' }, audit: { idColumn: 'auditid' }, leaf: { idColumn: 'leafid' } },
        tables: { item: [{ itemid: record }], audit: [{ auditid: record }], leaf: [] },
        settings: { permissionMode: 'permissive' },
      },
    });
    rollback.setPluginPipeline((event) => runPluginPhase({ ...event, store: rollback, items, runtimes }));
    await assert.rejects(rollback.update('item', record, { title: 'Fail' }, { contactId: user }), /tag is immutable/);
    assert.equal(rollback.state.tables.audit.length, 1);
    assert.equal(rollback.state.tables.leaf.length, 0);
    assert.equal(rollback.pluginSdkTag, undefined);
  },
);
