import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { DataStore, emptyState } from '../lib/data.mjs';
import { remoteExecutionContext, serviceEndpointDelivery } from '../lib/dataverse-webhooks.mjs';
import { pluginCatalogue, runPluginPhase } from '../lib/exported-plugins.mjs';
import { createOrganizationBackend } from '../lib/organization-backend.mjs';
import { prepareClrRuntime } from '../lib/plugin-clr.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { fixedClock } from '../lib/runtime-clock.mjs';

const id = '20000000-0000-0000-0000-000000000001';
const target = { $type: 'Entity', logicalName: 'x_item', id, attributes: { x_name: 'Invented' } };
const reference = { $type: 'EntityReference', logicalName: 'x_item', id, name: null };
const storeOf = (options = {}) => {
  const state = emptyState();
  state.mappings.x_item = {
    logicalName: 'x_item',
    entitySet: 'x_items',
    idColumn: 'x_itemid',
    fields: { x_name: { dataverseType: 'nvarchar' } },
  };
  state.tables.x_item = [];
  return new DataStore({ state, ...options });
};
const facts = (operation, extra = {}) => ({
  item: { id, images: [] },
  entity: 'x_item',
  operation,
  stage: 40,
  record: { x_itemid: id, bulkIds: [id] },
  identity: { id },
  depth: 1,
  ...extra,
});
const parameters = (context, property = 'InputParameters') =>
  Object.fromEntries(context[property].map(({ key, value }) => [key, value]));

async function webhookReceiver(t, endpointOptions = {}, onReceive = () => {}) {
  const received = [];
  const receiver = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      received.push(JSON.parse(Buffer.concat(chunks)));
      onReceive(received.at(-1));
      response.writeHead(200).end();
    });
  });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        receiver.close(resolve);
        receiver.closeAllConnections();
      }),
  );
  return {
    received,
    endpoint: {
      serviceendpointid: id,
      contract: 8,
      url: `http://127.0.0.1:${receiver.address().port}/hook`,
      ...endpointOptions,
    },
  };
}

test('webhook-only stages share one known operation identity and time independently of delivery and authored transport metadata', async (t) => {
  for (const nested of [false, true]) {
    await t.test(nested ? 'known SDK parent' : 'root request', async (t) => {
      const clock = fixedClock(),
        initialTime = clock.now(),
        { received, endpoint } = await webhookReceiver(t, {}, () => clock.advance(5000)),
        store = storeOf({ clock }),
        parent = {
          $type: 'ExecutionContext',
          values: {
            MessageName: 'x_Outer',
            Stage: 30,
            Depth: 1,
            RequestId: { $type: 'Guid', value: '30000000-0000-4000-8000-000000000001' },
            OperationId: { $type: 'Guid', value: '30000000-0000-4000-8000-000000000002' },
            CorrelationId: { $type: 'Guid', value: '30000000-0000-4000-8000-000000000003' },
            OperationCreatedOn: { $type: 'DateTime', value: '2001-02-03T04:05:06.0000000' },
          },
        };
      store.state.tables.serviceendpoint = [endpoint];
      const steps = [10, 20, 40].map((stage) => ({
        id: `40000000-0000-4000-8000-${String(stage).padStart(12, '0')}`,
        enabled: true,
        name: `Invented webhook-only stage${stage}`,
        entity: 'x_item',
        message: 'Create',
        stage,
        rank: 1,
        mode: 0,
        supportedDeployment: 0,
        images: [],
        filteringAttributes: [],
        serviceEndpointId: id,
      }));
      const items = pluginCatalogue({ plugins: { steps } }),
        backend = await createOrganizationBackend({ store, items: () => items });
      t.after(async () => {
        await backend.close();
        store.close();
      });
      const authoredRequest = '50000000-0000-4000-8000-000000000001';
      await store.withOperationContext(
        () => {
          store.pluginRequestId = authoredRequest;
          store.pluginParentContext = nested ? parent : null;
          return store.create('x_item', { x_name: 'Webhook-only operation' }, { admin: true, id });
        },
        { fresh: true },
      );
      assert.deepEqual(
        received.map((context) => context.Stage),
        [10, 20, 40],
      );
      assert.equal(new Set(received.map((context) => context.OperationId)).size, 1);
      assert.equal(new Set(received.map((context) => context.OperationCreatedOn)).size, 1);
      assert.equal(new Set(received.map((context) => context.RequestId)).size, 1);
      assert.notEqual(received[0].RequestId, authoredRequest);
      assert.equal(clock.now(), initialTime + 15_000, 'real deliveries advance the controlled clock between stages');
      if (nested) {
        assert.equal(received[0].RequestId, parent.values.RequestId.value);
        assert.equal(received[0].OperationId, parent.values.OperationId.value);
        assert.ok(received.every((context) => context.CorrelationId === parent.values.CorrelationId.value));
        assert.equal(received[0].OperationCreatedOn, '/Date(981173106000)/');
        assert.ok(received.every((context) => context.ParentContext.MessageName === 'x_Outer'));
        assert.ok(received.every((context) => context.ParentContext.OperationId === parent.values.OperationId.value));
      } else {
        assert.equal(received[0].OperationId, received[0].RequestId);
        assert.equal(received[0].OperationCreatedOn, `/Date(${initialTime})/`);
      }
    });
  }
});

test(
  'webhook typed message payloads match the public SDK DataContract JSON serializer',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paq-webhook-message-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const sdk = clrSdk(),
      source = path.join(root, 'Serializer.cs'),
      executable = path.join(root, 'Serializer.exe');
    await fs.copyFile(sdk, path.join(root, 'Microsoft.Xrm.Sdk.dll'));
    await fs.writeFile(
      source,
      `using System; using System.IO; using System.Text; using System.Runtime.Serialization.Json; using Microsoft.Xrm.Sdk; using Microsoft.Xrm.Sdk.Query;
class Serializer { static void Main() { var id = new Guid("${id}"); var c = new RemoteExecutionContext(); c.OperationCreatedOn = DateTime.UtcNow;
var row = new Entity("x_item", id); row["x_name"] = "Invented";
c.InputParameters["Targets"] = new EntityCollection(new [] { row });
c.InputParameters["Target"] = new EntityReference("x_item", id);
c.InputParameters["Relationship"] = new Relationship("x_item_relation") { PrimaryEntityRole = EntityRole.Referenced };
c.InputParameters["RelatedEntities"] = new EntityReferenceCollection(new [] { new EntityReference("x_item", id) });
var q = new QueryExpression("x_item") { ColumnSet = new ColumnSet("x_name"), TopCount = 3 };
q.Criteria.AddCondition("x_name", ConditionOperator.Equal, "Invented"); q.AddOrder("x_name", OrderType.Descending);
var link = q.AddLink("x_parent", "x_parentid", "x_parentid", JoinOperator.LeftOuter); link.EntityAlias = "parent";
c.InputParameters["Query"] = q;
c.InputParameters["Fetch"] = new FetchExpression("<fetch><entity name='x_item'/></fetch>");
var by = new QueryByAttribute("x_item") { ColumnSet = new ColumnSet("x_name") }; by.AddAttributeValue("x_name", "Invented"); c.InputParameters["By"] = by;
c.InputParameters["Columns"] = new ColumnSet("x_name");
c.OutputParameters["Ids"] = new [] { id };
var serializer = new DataContractJsonSerializer(typeof(RemoteExecutionContext)); using (var stream = new MemoryStream()) { serializer.WriteObject(stream,c); Console.Write(Encoding.UTF8.GetString(stream.ToArray())); }
} }`,
    );
    compileClr(source, executable, { target: 'exe', references: [sdk, 'System.Runtime.Serialization.dll'] });
    const result = spawnSync(executable, [], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    const native = JSON.parse(result.stdout),
      expected = parameters(native),
      store = storeOf();
    const bulk = remoteExecutionContext(store, facts('createmultiple', { targets: [target] }));
    assert.deepEqual(parameters(bulk).Targets, expected.Targets);
    assert.deepEqual(parameters(bulk, 'OutputParameters').Ids, parameters(native, 'OutputParameters').Ids);
    const association = remoteExecutionContext(
      store,
      facts('associate', {
        associationParameters: {
          Target: reference,
          Relationship: { $type: 'Relationship', schemaName: 'x_item_relation', primaryEntityRole: 'Referenced' },
          RelatedEntities: { $type: 'EntityReferenceCollection', values: [reference] },
        },
      }),
    );
    for (const name of ['Target', 'Relationship', 'RelatedEntities'])
      assert.deepEqual(parameters(association)[name], expected[name]);
    const query = {
      $type: 'QueryExpression',
      entityName: 'x_item',
      columnSet: { allColumns: false, columns: ['x_name'] },
      criteria: {
        operatorName: 'And',
        conditions: [{ attributeName: 'x_name', operatorName: 'Equal', values: ['Invented'] }],
        filters: [],
      },
      orders: [{ attributeName: 'x_name', descending: true }],
      topCount: 3,
      distinct: false,
      noLock: false,
      linkEntities: [],
      pageInfo: { count: 0, pageNumber: 0, pagingCookie: null, returnTotalRecordCount: false },
    };
    query.linkEntities.push({
      $type: 'LinkEntity',
      linkFromEntityName: 'x_item',
      linkToEntityName: 'x_parent',
      linkFromAttributeName: 'x_parentid',
      linkToAttributeName: 'x_parentid',
      joinOperator: 'LeftOuter',
      entityAlias: 'parent',
      columns: { allColumns: false, columns: [] },
      linkCriteria: { operatorName: 'And', conditions: [], filters: [] },
      orders: [],
      linkEntities: [],
    });
    const read = remoteExecutionContext(store, facts('retrievemultiple', { query }));
    assert.deepEqual(parameters(read).Query, expected.Query);
    const fetch = remoteExecutionContext(
      store,
      facts('retrievemultiple', {
        query: { $type: 'FetchExpression', query: "<fetch><entity name='x_item'/></fetch>" },
      }),
    );
    assert.deepEqual(parameters(fetch).Query, expected.Fetch);
    const by = remoteExecutionContext(
      store,
      facts('retrievemultiple', {
        query: {
          $type: 'QueryByAttribute',
          entityName: 'x_item',
          columnSet: query.columnSet,
          attributes: ['x_name'],
          values: ['Invented'],
          orders: [],
        },
      }),
    );
    assert.deepEqual(parameters(by).Query, expected.By);
    const retrieve = remoteExecutionContext(
      store,
      facts('retrieve', { holder: { target: reference }, columns: { allColumns: false, columns: ['x_name'] } }),
    );
    assert.deepEqual(parameters(retrieve).ColumnSet, expected.Columns);
  },
);

test('unbound custom API webhook contexts preserve typed inputs, outputs and shared variables', () => {
  const store = storeOf();
  const context = remoteExecutionContext(
    store,
    facts('x_calculate', {
      entity: '',
      record: {},
      customApi: { name: 'x_Calculate' },
      messageParameters: {
        inputParameters: { values: { Record: target } },
        outputParameters: { values: { Id: { $type: 'Guid', value: id } } },
      },
      initialFrame: { sharedVariables: { values: { marker: 'preserved' } } },
    }),
  );
  assert.equal(context.MessageName, 'x_Calculate');
  assert.equal(context.PrimaryEntityName, 'none');
  assert.equal(parameters(context).Record.Id, id);
  assert.equal(parameters(context, 'OutputParameters').Id, id);
  assert.deepEqual(context.SharedVariables, [{ key: 'marker', value: 'preserved' }]);
});

test('webhook query serialization refuses an unknown configured query property instead of deleting it', () => {
  assert.throws(
    () =>
      remoteExecutionContext(
        storeOf(),
        facts('retrievemultiple', {
          query: { $type: 'QueryExpression', entityName: 'x_item', inventedUnsupportedFacet: true },
        }),
      ),
    { code: 'LocalWebhookContextUnsupported' },
  );
});

test('webhook post-operation snapshots retain extra input parameters and the final typed Target', () => {
  const context = remoteExecutionContext(
    storeOf(),
    facts('create', {
      target: { x_name: 'Stale' },
      initialFrame: {
        inputParametersStage: 40,
        inputParameters: {
          $type: 'ParameterCollection',
          values: {
            Target: { ...target, attributes: { x_name: 'Final context' } },
            Added: { $type: 'Guid', value: id },
          },
        },
      },
    }),
  );
  assert.equal(parameters(context).Target.Attributes[0].value, 'Final context');
  assert.equal(parameters(context).Added, id);
});

test('single-origin multiple-message webhooks retain the same-depth single main-operation parent', () => {
  const context = remoteExecutionContext(
    storeOf(),
    facts('updatemultiple', {
      record: { x_itemid: '00000000-0000-0000-0000-000000000000' },
      targets: [target],
      initialFrame: {
        delegatedSourceOperation: {
          operation: 'update',
          entity: 'x_item',
          primaryId: id,
          target,
          identity: { id },
          frame: {},
          depth: 1,
          isInTransaction: true,
        },
      },
    }),
  );
  assert.equal(context.ParentContext.MessageName, 'Update');
  assert.equal(context.ParentContext.Stage, 30);
  assert.equal(context.ParentContext.Depth, context.Depth);
  assert.equal(context.ParentContext.PrimaryEntityId, id);
  assert.equal(parameters(context.ParentContext).Target.Id, id);
});

test('webhook parent selection excludes async PreValidation snapshots and retains explicit delegation precedence', () => {
  const store = storeOf();
  const early = { $type: 'ExecutionContext', values: { Stage: 10, MessageName: 'Create' } };
  const delegated = { $type: 'ExecutionContext', values: { Stage: 30, MessageName: 'Update' } };
  const nested = { $type: 'ExecutionContext', values: { Stage: 30, MessageName: 'x_Outer' } };
  const initialFrame = { preValidationContext: early };
  store.pluginParentContext = nested;
  for (const operation of ['create', 'update', 'delete']) {
    for (const stage of [20, 40]) {
      const sync = remoteExecutionContext(store, facts(operation, { stage, initialFrame }));
      assert.equal(sync.ParentContext.Stage, 10);
      const async = remoteExecutionContext(store, facts(operation, { stage, initialFrame, asyncExecution: true }));
      assert.equal(async.ParentContext.MessageName, 'x_Outer');
      const modeOne = remoteExecutionContext(
        store,
        facts(operation, {
          stage,
          initialFrame,
          item: { id, images: [], contract: { mode: 1 } },
        }),
      );
      assert.equal(modeOne.ParentContext.MessageName, 'x_Outer');
      const explicit = remoteExecutionContext(
        store,
        facts(operation, {
          stage,
          initialFrame: { ...initialFrame, delegatedParentContext: delegated },
        }),
      );
      assert.equal(explicit.ParentContext.MessageName, 'Update');
    }
  }
  assert.equal(
    remoteExecutionContext(store, facts('create', { stage: 10, initialFrame })).ParentContext.MessageName,
    'x_Outer',
  );
  assert.equal(remoteExecutionContext(store, facts('retrieve', { initialFrame })).ParentContext.MessageName, 'x_Outer');
});

test(
  'original CLR PreValidation values reach serialized CRUD webhooks at stages20 and40 through their parent',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paq-webhook-early-'));
    let backend;
    t.after(async () => {
      await backend?.close();
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
    });
    const sdk = clrSdk(),
      source = path.join(root, 'Early.cs'),
      assembly = path.join(root, 'Early.dll');
    await fs.writeFile(
      source,
      `using System;using Microsoft.Xrm.Sdk;namespace Invented {public sealed class Early:IPlugin {public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));c.SharedVariables["EarlyMoney"]=new Money(4.25m);c.SharedVariables["EarlyGuid"]=new Guid("${id}");c.SharedVariables["EarlyMessage"]=c.MessageName;}}}`,
    );
    compileClr(source, assembly, { references: [sdk] });
    const runtime = await prepareClrRuntime({
      trust: 'execute-local-assembly',
      root,
      assembly: path.basename(assembly),
      typeName: 'Invented.Early',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, 'cache'),
      serviceProfile: { userId: id, evidence: 'Invented webhook PreValidation producer', grants: [] },
      context: { executionUserId: id, initiatingUserId: id, organizationId: id, businessUnitId: id },
    });
    const { received, endpoint } = await webhookReceiver(t);
    const store = storeOf();
    store.state.tables.serviceendpoint = [endpoint];
    const steps = ['Create', 'Update', 'Delete'].flatMap((message, messageIndex) =>
      [10, 20, 40].map((stage, stageIndex) => ({
        id: `30000000-0000-0000-0000-00000000000${messageIndex * 3 + stageIndex}`,
        enabled: true,
        name: `Invented ${message} stage${stage}`,
        entity: 'x_item',
        message,
        stage,
        rank: 1,
        mode: 0,
        supportedDeployment: 0,
        images: [],
        filteringAttributes: [],
        ...(stage === 10 ? { typeName: 'Invented.Early', assemblyId: 'invented' } : { serviceEndpointId: id }),
      })),
    );
    const runtimes = new Map(steps.filter((step) => step.stage === 10).map((step) => [step.id, runtime]));
    const descriptors = new Map([...runtimes].map(([stepId, value]) => [stepId, value.descriptor]));
    const items = pluginCatalogue({
      plugins: { steps },
      runtimes,
      descriptors,
      overrides: Object.fromEntries([...runtimes.keys()].map((stepId) => ['plugin-step:' + stepId, { mode: 'clr' }])),
    });
    backend = await createOrganizationBackend({ store, items: () => items, runtimes, descriptors });
    const row = await store.create('x_item', { x_name: 'Created' }, { admin: true, id });
    await store.update('x_item', row.x_itemid, { x_name: 'Updated' }, { admin: true, id });
    await store.remove('x_item', row.x_itemid, { admin: true, id });
    assert.deepEqual(
      received.map((context) => [context.MessageName, context.Stage]),
      [
        ['Create', 20],
        ['Create', 40],
        ['Update', 20],
        ['Update', 40],
        ['Delete', 20],
        ['Delete', 40],
      ],
    );
    for (const context of received) {
      const parent = context.ParentContext;
      assert.equal(parent?.Stage, 10, 'Every synchronous later webhook retains its actual PreValidation parent');
      assert.equal(parent.MessageName, context.MessageName);
      assert.equal(parent.Depth, context.Depth);
      assert.equal(parent.PrimaryEntityId, context.PrimaryEntityId);
      assert.equal(parent.IsInTransaction, false);
      assert.equal(context.IsInTransaction, true);
      const early = Object.fromEntries(parent.SharedVariables.map(({ key, value }) => [key, value]));
      assert.deepEqual(early.EarlyMoney, {
        __type: 'Money:http://schemas.microsoft.com/xrm/2011/Contracts',
        Value: 4.25,
      });
      assert.equal(early.EarlyGuid, id);
      assert.equal(early.EarlyMessage, context.MessageName);
      assert.equal(
        context.SharedVariables.some(({ key }) => key.startsWith('Early')),
        false,
      );
      assert.equal(parameters(parent).Target.Id, row.x_itemid);
    }
  },
);

test('the registered webhook pipeline sends typed bulk, association, read and unbound custom API payloads over loopback', async (t) => {
  const { received, endpoint } = await webhookReceiver(t, { authtype: 5 });
  const store = storeOf();
  store.state.tables.serviceendpoint = [endpoint];
  const webhooks = serviceEndpointDelivery(store);
  const invoke = (operation, extra = {}) =>
    runPluginPhase({
      ...facts(operation),
      store,
      handlers: new Map(),
      items: [
        {
          id,
          enabled: true,
          name: 'Invented hook',
          mode: 'webhook',
          contract: { mode: 0 },
          entity: extra.entity ?? 'x_item',
          message: operation,
          stage: 40,
          rank: 1,
          filteringAttributes: [],
          images: [],
          serviceEndpointId: id,
          ...(extra.customApi ? { customApi: extra.customApi } : {}),
        },
      ],
      initialFrame: {},
      awaitIo: true,
      webhooks,
      ...extra,
    });
  await invoke('createmultiple', { targets: [target], records: [{ x_itemid: id }], previousRecords: [null] });
  await invoke('associate', {
    associationParameters: {
      Target: reference,
      Relationship: { $type: 'Relationship', schemaName: 'x_item_relation', primaryEntityRole: null },
      RelatedEntities: { $type: 'EntityReferenceCollection', values: [reference] },
    },
  });
  await invoke('retrievemultiple', {
    query: { $type: 'FetchExpression', query: "<fetch><entity name='x_item'/></fetch>" },
    collection: { $type: 'EntityCollection', entities: [target], totalRecordCount: 1 },
  });
  await invoke('retrieve', {
    holder: { target: reference, entity: target },
    columns: { allColumns: true, columns: [] },
  });
  await invoke('x_calculate', {
    entity: '',
    record: {},
    customApi: { name: 'x_Calculate', bindingType: 0, allowedCustomProcessingStepType: 2 },
    messageParameters: {
      inputParameters: { $type: 'ParameterCollection', values: { Record: target } },
      outputParameters: { $type: 'ParameterCollection', values: { Answer: 42 } },
    },
  });
  assert.equal(parameters(received[0]).Targets.Entities[0].Id, id);
  assert.equal(parameters(received[1]).RelatedEntities[0].Id, id);
  assert.equal(parameters(received[2]).Query.Query, "<fetch><entity name='x_item'/></fetch>");
  assert.equal(parameters(received[2], 'OutputParameters').BusinessEntityCollection.Entities[0].Id, id);
  assert.equal(parameters(received[3]).ColumnSet.AllColumns, true);
  assert.equal(parameters(received[3], 'OutputParameters').BusinessEntity.Id, id);
  assert.equal(received[4].MessageName, 'x_Calculate');
  assert.equal(parameters(received[4]).Record.Id, id);
  assert.equal(parameters(received[4], 'OutputParameters').Answer, 42);
});
