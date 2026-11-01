// @test-kind unproven: local model of tag inheritance and validation across nested SDK calls; no native capture cited
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
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { install as installCustomApis } from '../lib/dataverse-customapi.mjs';
import { createOperationRegistry } from '../lib/dataverse-operations.mjs';
import { pluginInvocationParent } from '../lib/plugin-execution-lifetime.mjs';

const user = '10000000-0000-0000-0000-000000000001',
  record = '20000000-0000-0000-0000-000000000001';
// A custom API main operation that records the shared tag its SDK caller's plug-in sees.
async function customApiTagCall(name) {
  const seen = [],
    store = new DataStore({
      state: { tables: { customapi: [{ customapiid: user, uniquename: name, bindingtype: 0 }] } },
    }),
    api = {
      store,
      records: {},
      change: (fn) => fn(),
      registry: createOperationRegistry(),
      principals: { byId: () => ({ systemuserid: user }), privileges: () => new Map() },
    };
  await installCustomApis(api, {
    handlers: new Map([
      [
        name.toLowerCase(),
        {
          handler: () => {
            seen.push(pluginInvocationParent(store).values.SharedVariables.values.tag);
            return {};
          },
        },
      ],
    ]),
  }).ready;
  store.recordPipeline = api.records;
  const profile = {
    userId: user,
    evidence: 'Invented custom API tag contract',
    grants: [{ message: name, operations: ['execute'] }],
  };
  const call = (values, parent, canonical = true) =>
    store.transact(() =>
      store.withOperationContext(
        () => {
          store.pluginSdkTag = parent && canonical ? 'parent' : undefined;
          return dispatchSdkCall({
            store,
            profile,
            message: {
              method: 'Execute',
              userId: user,
              parentContext: parent,
              arguments: [
                {
                  $type: 'OrganizationRequest',
                  requestName: name,
                  parameters: { $type: 'ParameterCollection', values },
                },
              ],
            },
          });
        },
        { fresh: true },
      ),
    );
  return { store, seen, call };
}
test('named custom API SDK calls apply the same duplicate inherited tag gate before main execution', async () => {
  const { store, seen, call } = await customApiTagCall('invented_TagChild');
  const parentContext = {
    $type: 'ExecutionContext',
    values: { SharedVariables: { $type: 'ParameterCollection', values: { tag: 'parent' } } },
  };
  for (const tag of ['child', 'parent']) {
    await assert.rejects(call({ tag }, parentContext), { code: 'LocalPluginTagDuplicate', status: 400 });
    assert.deepEqual(seen, [], 'Rejected descendants must not invoke the main operation');
    assert.equal(store.pluginSdkTag, undefined);
    assert.equal(store.pluginParentContext, undefined);
  }
  for (const tag of [null, undefined, 42]) await assert.rejects(call({ tag }), { code: 'LocalPluginSdkUnsupported' });
  await call({}, parentContext);
  await call({ tag: 'root' });
  await call({ tag: 'independent' }, parentContext, false);
  assert.deepEqual(
    seen,
    ['parent', 'root', 'independent'],
    'A visible shared value alone is not a canonical request tag',
  );
  assert.equal(store.pluginSdkTag, undefined);
  assert.equal(store.pluginParentContext, undefined);
});
// @test-kind parity: native-r2 traceFaults accepts request tags up to 13094 bytes; native depth39 accepts an 8830-byte tag
// @parity-evidence: native-r2 traceFaults tag 13094 bytes accepted; native depth39 8830 bytes
test('a 13094-byte request tag is accepted and reaches the plug-in unchanged', async () => {
  const tag = 't'.repeat(13094),
    { store, seen, call } = await customApiTagCall('invented_LongTag');
  await call({ tag });
  assert.equal(seen.length, 1, 'The custom API main operation runs once');
  assert.equal(seen[0].length, 13094);
  assert.ok(seen[0] === tag, 'The tag reaches the plug-in unchanged');
  assert.equal(store.pluginSdkTag, undefined);
});
test('typed JavaScript shared tag edits remain visible while an omitted child inherits the canonical input tag', async () => {
  const store = new DataStore({
    state: {
      mappings: { item: { idColumn: 'itemid' }, leaf: { idColumn: 'leafid' } },
      tables: { item: [], leaf: [] },
      settings: { permissionMode: 'permissive' },
    },
  });
  const profile = {
    userId: user,
    evidence: 'Invented canonical tag JS bridge',
    grants: [{ entity: 'leaf', operations: ['create'] }],
  };
  let parentAfter, childSeen;
  const steps = ['item', 'leaf'].map((entity, index) => ({
    id: `30000000-0000-4000-8000-00000000000${index}`,
    typeName: 'Invented.' + entity,
    assemblyId: 'invented',
    enabled: true,
    entity,
    message: 'Create',
    stage: entity === 'leaf' ? 10 : 20,
    rank: 1,
    mode: 0,
    supportedDeployment: 0,
    images: [],
    filteringAttributes: [],
  }));
  steps.push({ ...steps[0], id: '30000000-0000-4000-8000-000000000002', typeName: 'Invented.After', rank: 2 });
  const handlers = new Map([
    [
      'Invented.item',
      ({ context }) => {
        assert.equal(Object.hasOwn(context.InputParameters, 'tag'), false);
        context.SharedVariables.tag = 'visible';
        dispatchSdkCall({
          store,
          profile,
          message: {
            method: 'Create',
            userId: user,
            arguments: [
              { $type: 'Entity', logicalName: 'leaf', id: '00000000-0000-0000-0000-000000000000', attributes: {} },
            ],
          },
        });
        parentAfter = context.SharedVariables.tag;
      },
    ],
    [
      'Invented.leaf',
      ({ context }) => {
        childSeen = [context.SharedVariables.tag, context.InputParameters.tag];
        assert.equal(context.ParentContext.SharedVariables.tag, 'canonical');
      },
    ],
  ]);
  handlers.set('Invented.After', ({ context }) => {
    assert.equal(context.SharedVariables.tag, 'canonical');
    assert.equal(Object.hasOwn(context.InputParameters, 'tag'), false);
  });
  const items = pluginCatalogue({ plugins: { steps }, handlers });
  store.setPluginPipeline((event) => runPluginPhase({ ...event, store, items, handlers }));
  await store.withOperationContext(
    () => {
      store.pluginSdkTag = 'canonical';
      return store.create('item', {}, { admin: true, systemUserId: user });
    },
    { fresh: true },
  );
  assert.equal(parentAfter, 'visible');
  assert.deepEqual(childSeen, ['canonical', 'canonical']);
  assert.equal(store.tableRows('item').length, 1);
  assert.equal(store.tableRows('leaf').length, 1);
  assert.equal(store.pluginSdkTag, undefined);
});

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
  for (const tag of [null, 42])
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
  store.pluginSdkTag = 'parent';
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
    (error) => error.code === 'LocalPluginTagDuplicate' && error.details.innerCode === '0x80040224',
  );
  assert.equal(store.state.tables.item.length, 1);
  assert.equal(store.pluginSdkTag, 'parent');
  store.pluginSdkTag = undefined;
  assert.equal(store.pluginSdkTag, undefined);
});

test(
  'Original DLL named DeleteRequest tag reaches all stages, PreValidation parent and nested shortcut calls',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paq-sdk-tag-'));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const sdk = clrSdk(),
      source = path.join(root, 'Tag.cs'),
      assembly = path.join(root, 'Tag.dll');
    await fs.writeFile(
      source,
      `using System;using Microsoft.Xrm.Sdk;using Microsoft.Xrm.Sdk.Messages;namespace Invented {
 public sealed class Caller:IPlugin {public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));if(c.SharedVariables.Contains("tag"))throw new Exception("Tag leaked into caller");var s=((IOrganizationServiceFactory)p.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId);var r=new DeleteRequest{Target=new EntityReference("audit",new Guid("${record}"))};r.Parameters["tag"]="caller-tag";s.Execute(r);}}
 public sealed class DeleteObserver:IPlugin {readonly bool mutate;public DeleteObserver(string u,string s){mutate=u=="mutate";}public void Execute(IServiceProvider p){var c=(IPluginExecutionContext2)p.GetService(typeof(IPluginExecutionContext));if((string)c.SharedVariables["tag"]!="caller-tag"||c.IsPortalsClientCall||c.Depth!=2)throw new Exception("Child tag/origin mismatch");if(c.Stage==10)c.SharedVariables["pre"]="seen";if(c.Stage==20){if((string)c.ParentContext.SharedVariables["tag"]!="caller-tag"||(string)c.ParentContext.SharedVariables["pre"]!="seen")throw new Exception("PreValidation parent tag lost");var s=((IOrganizationServiceFactory)p.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId);s.Create(new Entity("leaf"));}if(c.Stage==40&&mutate){c.SharedVariables["tag"]="modified";var s=((IOrganizationServiceFactory)p.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId);s.Create(new Entity("leaf"));if((string)c.SharedVariables["tag"]!="modified")throw new Exception("Mutable visible tag lost");}}}
 public sealed class Leaf:IPlugin {public void Execute(IServiceProvider p){var c=(IPluginExecutionContext2)p.GetService(typeof(IPluginExecutionContext));if((string)c.SharedVariables["tag"]!="caller-tag"||c.InputParameters.Contains("tag")||c.Depth!=3||c.IsPortalsClientCall)throw new Exception("Nested shortcut tag lost");((Entity)c.InputParameters["Target"])["title"]="inherited";}}
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
    await rollback.update('item', record, { title: 'Mutable tag' }, { contactId: user });
    assert.equal(rollback.state.tables.audit.length, 0);
    assert.equal(
      rollback.state.tables.leaf.length,
      2,
      'Visible tag mutation must not change the canonical tag inherited by an omitted child request',
    );
    assert.ok(rollback.state.tables.leaf.every((row) => row.title === 'inherited'));
    assert.equal(rollback.pluginSdkTag, undefined);
  },
);
