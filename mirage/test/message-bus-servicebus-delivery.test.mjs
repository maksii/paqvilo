// A Dataverse service endpoint (contract 2 queue, 5 topic) mapped to a servicebus-emulator provider delivers through the core
// AMQP bus (dataverse-webhooks.mjs serviceEndpointDelivery → bus.send) to the loopback fake broker.
// A synchronous step runs inside its operation on the asynchronous pipeline (data.mjs createRecordAsync): the send is awaited and
// a failed send fails the operation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { EXTENSIONS } from '../lib/dataverse-extensions.mjs';
import { overlayRegisteredSteps } from '../lib/dataverse-plugin-registration.mjs';
import { serviceEndpointDelivery } from '../lib/dataverse-webhooks.mjs';
import {
  createLocalMessageBus,
  createServiceBusEmulatorBus,
  mappedEntities,
  messagingSettings,
} from '../lib/message-bus.mjs';
import { createAsyncPluginRunner } from '../lib/plugin-async.mjs';
import {
  pluginCatalogue,
  pluginPhaseRequiresCheckpoint,
  pluginStepMatchesEntity,
  runPluginPhase,
} from '../lib/exported-plugins.mjs';
import { startFakeBroker } from '../testing/amqp-fake-broker.mjs';

const KEY = 'invented-key-7f3a9c',
  ENDPOINT = '77777777-7777-4777-8777-777777777702',
  STEP = '77777777-7777-4777-8777-777777777703';
const env = {
  FX_SB: `Endpoint=sb://127.0.0.1;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=${KEY};UseDevelopmentEmulator=true;`,
};

const APP = '77777777-7777-4777-8777-777777777705',
  SECOND_ENDPOINT = '77777777-7777-4777-8777-777777777706',
  SECOND_STEP = '77777777-7777-4777-8777-777777777707';
let counter = 0;
// second: a second synchronous step (rank 2) whose endpoint maps to `second` (an entity the broker does not know fails it).
async function world(t, { contract = 2, entity = 'x-queue', mode = 1, second = null } = {}) {
  const broker = await startFakeBroker({ key: KEY, queues: ['x-queue'], topics: { 'x-topic': ['x-sub'] } });
  const state = emptyState();
  state.mappings.x_widget = {
    logicalName: 'x_widget',
    entitySet: 'x_widgets',
    idColumn: 'x_widgetid',
    nameColumn: 'x_name',
    userConfigured: true,
    fields: { x_name: { dataverseType: 'nvarchar' } },
    relationships: {},
  };
  state.tables.x_widget = [];
  const store = await new DataStore({ state }).init();
  const diagnostics = [],
    diagnostic = (entry) => diagnostics.push(entry);
  const variable = `FX_PL1_APP_SECRET_${process.pid}_${++counter}`;
  process.env[variable] = 'invented-secret';
  const api = await startDataverseApi({
    store,
    settings: dataverseSettings({
      enabled: true,
      tds: { enabled: false },
      applications: [
        { appId: APP, displayName: 'Invented', secretEnvironmentVariable: variable, roles: ['System Administrator'] },
      ],
    }),
    log: () => {},
    extensions: [...EXTENSIONS],
  });
  const messageId = store.tableRows('sdkmessage').find((row) => row.name === 'Create').sdkmessageid;
  const filterId = store
    .tableRows('sdkmessagefilter')
    .find((row) => row.sdkmessageid === messageId && row.primaryobjecttypecode === 'x_widget').sdkmessagefilterid;
  const register = async (endpointId, stepId, name, rank) => {
    await store.create(
      'serviceendpoint',
      {
        serviceendpointid: endpointId,
        name: `${name} endpoint`,
        contract,
        connectionmode: 1,
        authtype: 2,
        authvalue: 'invented-sas-key',
      },
      { admin: true },
    );
    await store.create(
      'sdkmessageprocessingstep',
      {
        sdkmessageprocessingstepid: stepId,
        name,
        sdkmessageid: messageId,
        sdkmessagefilterid: filterId,
        eventhandler: { id: endpointId, logical_name: 'serviceendpoint' },
        stage: 40,
        mode,
        rank,
        statecode: 0,
        supporteddeployment: 0,
      },
      { admin: true },
    );
  };
  await register(ENDPOINT, STEP, 'Invented step', 1);
  if (second) await register(SECOND_ENDPOINT, SECOND_STEP, 'Invented second step', 2);
  const settings = messagingSettings({
    sb: { kind: 'servicebus-emulator', connectionString: 'env:FX_SB', amqpPort: broker.port },
    endpoints: { [ENDPOINT]: `sb/${entity}`, ...(second ? { [SECOND_ENDPOINT]: `sb/${second}` } : {}) },
  });
  const emulator = createServiceBusEmulatorBus({
    id: 'sb',
    settings: settings.sb,
    entities: mappedEntities(settings, 'sb'),
    env,
  });
  const messaging = {
    bus: createLocalMessageBus({ store }),
    buses: { sb: emulator },
    settings,
    organizationUri: 'https://invented.example.test',
  };
  const webhooks = serviceEndpointDelivery(store, { messaging });
  const steps = () =>
    pluginCatalogue({
      plugins: overlayRegisteredSteps({ steps: [], types: [], assemblies: [] }, store),
      handlers: new Map(),
    });
  store.setPluginPipeline(
    (context) => runPluginPhase({ ...context, store, items: steps(), handlers: new Map(), webhooks, diagnostic }),
    ({ entity: table, operation }) =>
      steps().some(
        (item) =>
          item.enabled && pluginStepMatchesEntity(item, table) && String(item.message).toLowerCase() === operation,
      ),
    (context) => pluginPhaseRequiresCheckpoint(steps(), context),
  );
  const runner = createAsyncPluginRunner({
    store,
    items: steps,
    handlers: new Map(),
    runtimes: new Map(),
    webhooks,
    diagnostic,
    systemJobs: () => true,
  });
  t.after(async () => {
    delete process.env[variable];
    await runner.close();
    await api.close();
    await emulator.close();
    await broker.close();
  });
  const job = () => store.tableRows('asyncoperation').find((row) => row.owningextensionid?.id === STEP);
  const token = (
    await (
      await fetch(`${api.origin}/${api.tenantId}/oauth2/v2.0/token`, {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: APP,
          client_secret: 'invented-secret',
          scope: `${api.origin}/.default`,
        }),
      })
    ).json()
  ).access_token;
  // A Web API request as the application user.
  const request = async (method, path, body) => {
    const response = await fetch(`${api.origin}/api/data/v9.2${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  };
  return { store, broker, emulator, runner, diagnostics, job, messaging, request };
}

const create = (store) =>
  store.create('x_widget', { x_widgetid: '77777777-7777-4777-8777-777777777701', x_name: 'alpha' }, { admin: true });

test('a contract 2 async step mapped to a servicebus-emulator queue delivers the RemoteExecutionContext over AMQP', async (t) => {
  const { store, broker, emulator, runner, job } = await world(t);
  await create(store);
  await runner.drain();
  assert.equal(broker.count('x-queue'), 1);
  const [message] = await emulator.receive('x-queue');
  assert.equal(message.body.MessageName, 'Create');
  assert.equal(message.body.PrimaryEntityName, 'x_widget');
  assert.equal(message.messageId, message.body.OperationId);
  assert.equal(message.properties.requestName, 'Create');
  assert.equal(message.properties.organizationUri, 'https://invented.example.test');
  assert.equal(job().statuscode, 30, 'the System Job succeeded');
});

test('a synchronous emulator step is awaited inside a Web API create: the message is on the broker when the 204 answers', async (t) => {
  const { store, broker, request, diagnostics } = await world(t, { mode: 0, contract: 5, entity: 'x-topic' });
  const answer = await request('POST', '/x_widgets', { x_name: 'alpha' });
  assert.equal(answer.status, 204, JSON.stringify(answer.json));
  assert.equal(broker.count('x-topic/subscriptions/x-sub'), 1, 'sent before the response');
  assert.equal(store.tableRows('x_widget').length, 1);
  assert.ok(!diagnostics.some((entry) => /SYNC_UNSUPPORTED|SENT_BEFORE_ROLLBACK/.test(entry.code)));
});

test('a synchronous emulator step whose send fails answers the error and rolls the Web API create back', async (t) => {
  const { store, request, diagnostics } = await world(t, { mode: 0, entity: 'x-missing' });
  const answer = await request('POST', '/x_widgets', { x_name: 'alpha' });
  assert.equal(answer.status, 400);
  assert.match(answer.json.error.message, /Invented step.*x-missing/s);
  assert.equal(store.tableRows('x_widget').length, 0, 'nothing is committed');
  assert.ok(diagnostics.some((entry) => entry.code === 'SERVICE_ENDPOINT_SEND_FAILED' && entry.stepId === STEP));
});

test('the portal /_api entry (records.createInternal) awaits a synchronous emulator send and fails with it', async (t) => {
  const portal = { identity: { admin: true }, portal: true, caller: null, method: 'POST', headers: {} };
  const options = { authorized: true, writeOptions: { portalRequest: true, dataverseWebApi: false } };
  const sent = await world(t, { mode: 0 });
  await sent.store.transact(() =>
    sent.store.recordPipeline.createInternal(portal, 'x_widget', { x_name: 'portal' }, options),
  );
  assert.equal(sent.broker.count('x-queue'), 1);
  assert.equal(sent.store.tableRows('x_widget').length, 1);
  const refused = await world(t, { mode: 0, entity: 'x-missing' });
  await assert.rejects(
    refused.store.transact(() =>
      refused.store.recordPipeline.createInternal(portal, 'x_widget', { x_name: 'portal' }, options),
    ),
    (error) => error.code === 'ServiceEndpointFailed',
  );
  assert.equal(refused.store.tableRows('x_widget').length, 0);
});

test('a send that succeeded before a later step failed cannot be recalled: the create rolls back and says so', async (t) => {
  const { store, broker, request, diagnostics } = await world(t, { mode: 0, second: 'x-missing' });
  const answer = await request('POST', '/x_widgets', { x_name: 'alpha' });
  assert.equal(answer.status, 400);
  assert.equal(store.tableRows('x_widget').length, 0, 'the data operation rolled back');
  assert.equal(broker.count('x-queue'), 1, 'the first step posted before the second failed');
  const note = diagnostics.find((entry) => entry.code === 'SERVICE_ENDPOINT_SENT_BEFORE_ROLLBACK');
  assert.equal(note?.stepId, STEP);
  assert.equal(note.target, 'sb/x-queue');
  assert.doesNotMatch(JSON.stringify(diagnostics), new RegExp(KEY), 'no key in any diagnostic');
});

test('a contract 5 topic endpoint fans out to the subscription', async (t) => {
  const { store, broker, runner } = await world(t, { contract: 5, entity: 'x-topic' });
  await create(store);
  await runner.drain();
  assert.equal(broker.count('x-topic/subscriptions/x-sub'), 1);
});

test('an endpoint mapped to an entity the emulator does not know fails its System Job with the AMQP error', async (t) => {
  const { store, runner, job } = await world(t, { entity: 'x-missing' });
  await create(store);
  await runner.drain();
  assert.equal(job().statuscode, 31, 'the System Job failed');
  assert.match(String(job().message ?? job().friendlymessage ?? ''), /x-missing/);
});
