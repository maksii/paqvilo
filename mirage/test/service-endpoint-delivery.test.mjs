// Service endpoint contracts 2 (Queue), 5 (Topic) and 6 (Queue Persistent) delivered to the local message bus.
// Invented x_widget table, invented endpoints and steps; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { EXTENSIONS } from '../lib/dataverse-extensions.mjs';
import { install as installRegistration, overlayRegisteredSteps } from '../lib/dataverse-plugin-registration.mjs';
import { serviceEndpointDelivery, webhookDelivery } from '../lib/dataverse-webhooks.mjs';
import { createLocalMessageBus, messagingSettings } from '../lib/message-bus.mjs';
import { createAsyncPluginRunner } from '../lib/plugin-async.mjs';
import { pluginCatalogue, pluginPhaseRequiresCheckpoint, pluginStepMatchesEntity, runPluginPhase } from '../lib/exported-plugins.mjs';

const WIDGET = '77777777-7777-4777-8777-777777777701';
const ENDPOINT = '77777777-7777-4777-8777-777777777702';
const STEP = '77777777-7777-4777-8777-777777777703';
const PROPERTIES = ['BusinessUnitId', 'CorrelationId', 'Depth', 'InitiatingUserId', 'InputParameters', 'IsExecutingOffline', 'IsInTransaction', 'IsOfflinePlayback', 'IsolationMode', 'MessageName', 'Mode', 'OperationCreatedOn', 'OperationId', 'OrganizationId', 'OrganizationName', 'OutputParameters', 'OwningExtension', 'ParentContext', 'PostEntityImages', 'PreEntityImages', 'PrimaryEntityId', 'PrimaryEntityName', 'RequestId', 'SecondaryEntityName', 'SharedVariables', 'Stage', 'UserId'];

function fixtureState() {
  const state = emptyState();
  state.mappings.x_widget = { logicalName: 'x_widget', entitySet: 'x_widgets', idColumn: 'x_widgetid', nameColumn: 'x_name', userConfigured: true, fields: { x_name: { dataverseType: 'nvarchar' } }, relationships: {} };
  state.tables.x_widget = [];
  return state;
}

// endpoints: providers.messaging.endpoints; bus false: no messaging provider (today's behaviour).
async function world(t, { mode = 1, contract = 2, endpoints = { [ENDPOINT]: 'local/x-queue' }, bus: withBus = true } = {}) {
  const store = await new DataStore({ state: fixtureState() }).init();
  const diagnostics = [];
  const diagnostic = (entry) => diagnostics.push(entry);
  const api = await startDataverseApi({ store, settings: dataverseSettings({ enabled: true }), log: () => {}, extensions: [...EXTENSIONS] });
  const messageId = store.tableRows('sdkmessage').find((row) => row.name === 'Create').sdkmessageid;
  const filterId = store.tableRows('sdkmessagefilter').find((row) => row.sdkmessageid === messageId && row.primaryobjecttypecode === 'x_widget').sdkmessagefilterid;
  await store.create('serviceendpoint', { serviceendpointid: ENDPOINT, name: 'Invented queue', contract, connectionmode: 1, authtype: 2, authvalue: 'invented-sas-key' }, { admin: true });
  await store.create('sdkmessageprocessingstep', {
    sdkmessageprocessingstepid: STEP, name: 'Invented queue step', sdkmessageid: messageId, sdkmessagefilterid: filterId,
    eventhandler: { id: ENDPOINT, logical_name: 'serviceendpoint' }, stage: 40, mode, rank: 1, statecode: 0, supporteddeployment: 0,
  }, { admin: true });
  const bus = createLocalMessageBus({ store });
  const messaging = { bus, settings: messagingSettings({ endpoints }), organizationUri: 'https://invented.example.test' };
  const webhooks = withBus ? serviceEndpointDelivery(store, { messaging }) : webhookDelivery(store);
  const steps = () => pluginCatalogue({ plugins: overlayRegisteredSteps({ steps: [], types: [], assemblies: [] }, store), handlers: new Map() });
  store.setPluginPipeline(
    (context) => runPluginPhase({ ...context, store, items: steps(), handlers: new Map(), webhooks, diagnostic }),
    ({ entity, operation }) => steps().some((item) => item.enabled && pluginStepMatchesEntity(item, entity) && String(item.message).toLowerCase() === operation),
    (context) => pluginPhaseRequiresCheckpoint(steps(), context),
  );
  const runner = createAsyncPluginRunner({ store, items: steps, handlers: new Map(), runtimes: new Map(), webhooks, diagnostic, systemJobs: () => true });
  t.after(async () => { await runner.close(); await api.close(); });
  const job = () => store.tableRows('asyncoperation').find((row) => row.owningextensionid?.id === STEP);
  return { store, bus, runner, diagnostics, job };
}

const create = (store, id = WIDGET) => store.create('x_widget', { x_widgetid: id, x_name: 'alpha' }, { admin: true });

test('a contract 2 async step sends exactly one message per committed event, with the RemoteExecutionContext and listener properties', async (t) => {
  const { store, bus, runner, job } = await world(t);
  await create(store);
  await create(store, '77777777-7777-4777-8777-777777777799');
  await runner.drain();
  const messages = bus.peek('x-queue');
  assert.equal(messages.length, 2);
  const [first] = messages;
  assert.deepEqual(Object.keys(first.body), PROPERTIES);
  assert.equal(first.body.MessageName, 'Create');
  assert.equal(first.body.PrimaryEntityName, 'x_widget');
  assert.equal(first.body.PrimaryEntityId, WIDGET);
  assert.equal(first.body.IsInTransaction, false);
  assert.equal(first.messageId, first.body.OperationId);
  assert.deepEqual(first.properties, { organizationUri: 'https://invented.example.test', callingUser: first.body.UserId, initiatingUser: first.body.InitiatingUserId, entity: 'x_widget', requestName: 'Create' });
  assert.equal(job().statuscode, 30, 'the System Job succeeded');
});

test('a rolled-back write sends nothing', async (t) => {
  const { store, bus, runner } = await world(t);
  await assert.rejects(store.transact(() => { store.createRecord('x_widget', { x_widgetid: WIDGET, x_name: 'alpha' }, { admin: true }); throw new Error('invented rollback'); }));
  await runner.drain();
  assert.equal(bus.peek('x-queue').length, 0);
  assert.equal(store.tableRows('x_widget').length, 0);
});

test('a sync contract 5 step sends inside the transaction: a commit keeps the message, a failing transaction takes it away', async (t) => {
  const { store, bus } = await world(t, { mode: 0, contract: 5, endpoints: { 'Invented queue': 'local/x-topic' } });
  await assert.rejects(store.transact(() => { store.createRecord('x_widget', { x_widgetid: WIDGET, x_name: 'alpha' }, { admin: true }); throw new Error('invented rollback'); }));
  await store.transact(() => {}); // any send queued outside the transaction would have run by now
  assert.equal(bus.peek('x-topic').length, 0, 'the rolled-back transaction left no message');
  await create(store);
  const [message] = bus.peek('x-topic');
  assert.equal(message.body.IsInTransaction, true);
  assert.equal(message.properties.requestName, 'Create');
  assert.equal(bus.peek('x-topic').length, 1);
});

test('an unmapped endpoint is reported and its System Job Failed, never dropped silently', async (t) => {
  const { store, bus, runner, diagnostics, job } = await world(t, { endpoints: {} });
  await create(store);
  await runner.drain();
  assert.equal(bus.peek('x-queue').length, 0);
  assert.equal(job().statuscode, 31);
  assert.match(job().message, /no providers\.messaging\.endpoints mapping/);
  const note = diagnostics.find((entry) => entry.code === 'SERVICE_ENDPOINT_UNMAPPED');
  assert.equal(note.endpointId, ENDPOINT);
  assert.ok(!JSON.stringify(diagnostics).includes('invented-sas-key'), 'no authvalue in diagnostics');
});

test('an unmapped sync step fails the operation and rolls it back', async (t) => {
  const { store } = await world(t, { mode: 0, endpoints: {} });
  await assert.rejects(create(store), /no providers\.messaging\.endpoints mapping/);
  assert.equal(store.tableRows('x_widget').length, 0);
});

test('without a messaging provider a contract 2 job is Canceled as before', async (t) => {
  const { store, runner, diagnostics, job } = await world(t, { bus: false });
  await create(store);
  await runner.drain();
  assert.equal(job().statuscode, 32);
  assert.ok(diagnostics.some((entry) => entry.code === 'WEBHOOK_NOT_DELIVERED' && entry.reason === 'contract-not-simulated'));
});

test('TriggerServiceEndpointCheck accepts mapped contracts 2, 5 and 6 when a bus is configured', async () => {
  const store = await new DataStore({ state: emptyState() }).init();
  const bus = createLocalMessageBus({ store });
  const action = (providers) => {
    const ops = [];
    installRegistration({ store: new DataStore({ state: emptyState() }), recordHooks: { add() {} }, registry: { register: (op) => ops.push(op) }, principals: {}, settings: {}, providers });
    const op = ops.find((item) => item.name === 'TriggerServiceEndpointCheck');
    return (row) => op.handle({ target: { id: 'row', row }, body: {}, user: { systemuserid: 'x' } });
  };
  const probe = action({ messaging: { bus, settings: messagingSettings({ endpoints: { [ENDPOINT]: 'local/x-queue' } }) } });
  for (const contract of [2, 5, 6]) assert.deepEqual(await probe({ serviceendpointid: ENDPOINT, contract }), { status: 204 }, `contract ${contract}`);
  await assert.rejects(probe({ serviceendpointid: '77777777-7777-4777-8777-777777777700', contract: 2 }), (error) => error.status === 400);
  await assert.rejects(probe({ serviceendpointid: ENDPOINT, contract: 7 }), (error) => error.status === 400);
  await assert.rejects(action({ messaging: null })({ serviceendpointid: ENDPOINT, contract: 2 }), (error) => error.status === 400);
  assert.equal(bus.peek('x-queue').length, 0, 'the check sends nothing');
});
