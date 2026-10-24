import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore } from '../lib/data.mjs';
import { createAsyncPluginRunner } from '../lib/plugin-async.mjs';
import { pluginCatalogue, runPluginPhase } from '../lib/exported-plugins.mjs';
import { createFlowTriggerRunner } from '../lib/flow-triggers.mjs';
import { operationCatalogue } from '../lib/operation-catalogue.mjs';
import { settleCommittedWork } from '../lib/committed-work.mjs';

const stepId = '10000000-0000-4000-8000-000000000031',
  flowId = '10000000-0000-4000-8000-000000000032',
  user = '20000000-0000-4000-8000-000000000031';
const step = {
  id: stepId,
  name: 'Invented asynchronous step',
  entity: 'x_widget',
  message: 'Create',
  enabled: true,
  stage: 40,
  rank: 1,
  mode: 1,
  typeName: 'Invented.Async',
  assemblyId: 'invented',
  supportedDeployment: 0,
  filteringAttributes: [],
  images: [],
};
const data = () =>
  new DataStore({
    state: {
      version: 1,
      mappings: {
        x_widget: { entitySet: 'x_widgets', idColumn: 'x_widgetid', fields: { x_name: { type: 'string' } } },
        x_audit: { entitySet: 'x_audits', idColumn: 'x_auditid' },
      },
      tables: { x_widget: [], x_audit: [] },
      permissions: [],
      plugins: [],
      settings: { permissionMode: 'enforce' },
    },
  });
// 150 committed rows in one commit, the shape of a CreateMultiple or a $batch changeset.
const events = Array.from({ length: 150 }, (_, n) => ({
  entity: 'x_widget',
  operation: 'create',
  row: { x_widgetid: `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`, x_name: 'Row ' + n },
  target: { x_name: 'Row ' + n },
  submittedAttributes: ['x_name'],
}));

test('One commit of 150 rows runs every asynchronous plug-in step and reports the backlog without dropping work', async () => {
  const store = data(),
    notes = [];
  let runs = 0;
  const handlers = new Map([
      [
        stepId,
        () => {
          runs++;
        },
      ],
    ]),
    items = () => pluginCatalogue({ plugins: { steps: [step] }, handlers });
  store.setPluginPipeline((context) => runPluginPhase({ ...context, store, items: items(), handlers }));
  const runner = createAsyncPluginRunner({
    store,
    items,
    handlers,
    runtimes: new Map(),
    diagnostic: (n) => notes.push(n),
  });
  await store.transact(() => {
    for (const e of events)
      store.recordCommittedEvent(e.entity, e.operation, e.row, e.submittedAttributes, { target: e.target });
  });
  await settleCommittedWork(store, [runner], { close: true });
  assert.equal(runs, 150);
  assert.equal(notes.filter((n) => n.code === 'PLUGIN_ASYNC_COMPLETED').length, 150);
  assert.ok(!notes.some((n) => n.code === 'PLUGIN_ASYNC_LIMIT'));
  assert.equal(notes.filter((n) => n.code === 'PLUGIN_ASYNC_BACKLOG').length, 1);
  assert.deepEqual(runner.status(), { pending: 0, closed: true });
});

test('One commit of 150 rows runs every row-triggered flow and reports the backlog without dropping work', async () => {
  const store = data(),
    notes = [];
  const definition = {
    properties: {
      definition: {
        triggers: {
          row: {
            type: 'OpenApiConnectionWebhook',
            inputs: {
              host: { apiId: '/apis/shared_commondataserviceforapps', operationId: 'SubscribeWebhookTrigger' },
              parameters: {
                'subscriptionRequest/message': 1,
                'subscriptionRequest/entityname': 'x_widget',
                'subscriptionRequest/scope': 4,
              },
            },
          },
        },
        actions: {
          create: {
            type: 'OpenApiConnection',
            inputs: {
              host: { apiId: '/apis/shared_commondataserviceforapps', operationId: 'CreateRecord' },
              parameters: { entityName: 'x_audits', 'item/x_name': "@triggerOutputs()['body/x_name']" },
            },
          },
        },
      },
    },
  };
  const workflows = new Map([
    [flowId, { file: '/invented/flow.json', active: true, activation: { sourceValue: 1 }, definition }],
  ]);
  const identities = new Map([
    [
      flowId,
      {
        userId: user,
        evidence: 'Invented explicit flow owner',
        grants: [
          { entity: 'x_widget', operations: ['read'] },
          { entity: 'x_audit', operations: ['read', 'create'] },
        ],
      },
    ],
  ]);
  const runner = createFlowTriggerRunner({
    store,
    workflows: () => workflows,
    identities: () => identities,
    items: () => operationCatalogue({ portal: {}, workflows, handlers: { flowIdentities: identities } }),
    diagnostic: (n) => notes.push(n),
  });
  await store.transact(() => {
    for (const e of events)
      store.recordCommittedEvent(e.entity, e.operation, e.row, e.submittedAttributes, { target: e.target });
  });
  await settleCommittedWork(store, [runner], { close: true });
  assert.equal(store.snapshot().tables.x_audit.length, 150);
  assert.ok(!notes.some((n) => n.code === 'FLOW_TRIGGER_LIMIT'));
  assert.equal(notes.filter((n) => n.code === 'FLOW_TRIGGER_BACKLOG').length, 1);
  assert.deepEqual(runner.status(), { pending: 0, closed: true });
});
