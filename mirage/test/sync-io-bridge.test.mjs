// The synchronous I/O bridge (sync-io-bridge.mjs): a synchronous plug-in step that posts (a Service Bus emulator send, a web
// hook) on the synchronous SDK drive - a plug-in's own SDK call - runs inside the operation through
// a worker thread and fails it when the post fails (a synchronous registered plug-in gets an exception). The broker and the
// receiver run on their own threads: the main thread waits.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Worker } from 'node:worker_threads';
import { DataStore, emptyState } from '../lib/data.mjs';
import { serviceEndpointDelivery } from '../lib/dataverse-webhooks.mjs';
import {
  createLocalMessageBus,
  createServiceBusEmulatorBus,
  mappedEntities,
  messagingSettings,
} from '../lib/message-bus.mjs';
import { pluginPhaseRequiresCheckpoint, runPluginPhase } from '../lib/exported-plugins.mjs';
import { localOrganizationService } from '../lib/local-organization-service.mjs';
import { createConnectorRuntime } from '../lib/connector-runtime.mjs';
import { closeSyncIoBridge, syncIo } from '../lib/sync-io-bridge.mjs';

const KEY = 'invented-key-pl1-4c2d',
  VARIABLE = 'FX_PL1_SB';
const ENDPOINT = '77777777-7777-4777-8777-777777777a01',
  SEND_STEP = '77777777-7777-4777-8777-777777777a02';
const HANDLER_STEP = '77777777-7777-4777-8777-777777777a03',
  PARENT = '77777777-7777-4777-8777-777777777a04',
  WIDGET = '77777777-7777-4777-8777-777777777a05';
const profile = {
  userId: '77777777-7777-4777-8777-777777777a06',
  evidence: 'Invented test grants',
  grants: [{ entity: 'x_widget', operations: ['create', 'read', 'update', 'delete'] }],
};
process.env[VARIABLE] =
  `Endpoint=sb://127.0.0.1;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=${KEY};UseDevelopmentEmulator=true;`;
test.after(() => closeSyncIoBridge());

// A worker thread that answers { id, ... } requests; ready() resolves with its first message.
function thread(t, code, workerData) {
  const worker = new Worker(code, { eval: true, workerData });
  const ready = new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
  });
  let next = 0;
  const ask = (message) =>
    new Promise((resolve) => {
      const id = ++next;
      const on = (answer) => {
        if (answer.id === id) {
          worker.off('message', on);
          resolve(answer.value);
        }
      };
      worker.on('message', on);
      worker.postMessage({ id, ...message });
    });
  t.after(async () => {
    await ask({ close: true });
    await worker.terminate();
  });
  return { ready, ask };
}
// The fake AMQP broker (testing/amqp-fake-broker.mjs) on its own thread.
async function threadBroker(t) {
  const { ready, ask } = thread(
    t,
    `
    const { parentPort, workerData } = require('node:worker_threads');
    import(workerData.url).then(async ({ startFakeBroker }) => {
      const broker = await startFakeBroker({ key: workerData.key, queues: ['x-queue'] });
      parentPort.on('message', async ({ id, close, count }) => {
        if (close) await broker.close();
        parentPort.postMessage({ id, value: close ? null : broker.count(count) });
      });
      parentPort.postMessage({ port: broker.port });
    });`,
    { url: new URL('../testing/amqp-fake-broker.mjs', import.meta.url).href, key: KEY },
  );
  const { port } = await ready;
  return { port, count: (entity) => ask({ count: entity }) };
}
// A loopback web hook receiver on its own thread: /status/<code> answers that code; log() lists the paths it received.
async function threadReceiver(t) {
  const { ready, ask } = thread(
    t,
    `
    const { parentPort } = require('node:worker_threads');
    const server = require('node:http').createServer((req, res) => {
      req.resume();
      req.on('end', () => { log.push(req.url); res.writeHead(Number(req.url.split('/').pop()) || 200); res.end(); });
    });
    const log = [];
    server.listen(0, '127.0.0.1', () => parentPort.postMessage({ port: server.address().port }));
    parentPort.on('message', ({ id, close }) => {
      if (close) server.close(() => parentPort.postMessage({ id, value: null }));
      else parentPort.postMessage({ id, value: [...log] });
    });`,
  );
  const { port } = await ready;
  return { origin: `http://127.0.0.1:${port}`, log: () => ask({}) };
}

// x_parent and x_widget; a synchronous (mode 0) PostOperation step on x_widget Create whose service endpoint is `endpoint`;
// and a trusted handler on x_parent Create that creates an x_widget through the SDK service (the nested synchronous drive a
// CLR plug-in's service.Create takes: localOrganizationService -> store.createRecord).
async function world(t, { endpoint, brokerPort = 9, entity = 'x-queue' }) {
  const state = emptyState();
  for (const name of ['x_parent', 'x_widget'])
    state.mappings[name] = {
      logicalName: name,
      entitySet: `${name}s`,
      idColumn: `${name}id`,
      nameColumn: 'x_name',
      userConfigured: true,
      fields: { x_name: { dataverseType: 'nvarchar' } },
      relationships: {},
    };
  Object.assign(state.tables, {
    x_parent: [],
    x_widget: [],
    serviceendpoint: [
      { serviceendpointid: ENDPOINT, name: 'Invented endpoint', authtype: 5, authvalue: '', ...endpoint },
    ],
  });
  const store = await new DataStore({ state }).init();
  const diagnostics = [],
    diagnostic = (entry) => diagnostics.push(entry);
  const settings = messagingSettings({
    sb: { kind: 'servicebus-emulator', connectionString: `env:${VARIABLE}`, amqpPort: brokerPort },
    endpoints: { [ENDPOINT]: `sb/${entity}` },
  });
  const emulator = createServiceBusEmulatorBus({
    id: 'sb',
    settings: settings.sb,
    entities: mappedEntities(settings, 'sb'),
  });
  t.after(() => emulator.close());
  const webhooks = serviceEndpointDelivery(store, {
    messaging: {
      bus: createLocalMessageBus({ store }),
      buses: { sb: emulator },
      settings,
      organizationUri: 'https://invented.example.test',
    },
  });
  const sdk = localOrganizationService(store, profile, undefined, { diagnostic });
  const step = (id, name, table, mode, extra) => ({
    id,
    name,
    enabled: true,
    mode,
    entity: table,
    message: 'Create',
    stage: 40,
    rank: 1,
    contract: { mode: 0 },
    filteringAttributes: [],
    images: [],
    ...extra,
  });
  const items = [
    step(SEND_STEP, 'Invented sync send step', 'x_widget', 'webhook', { serviceEndpointId: ENDPOINT }),
    step(HANDLER_STEP, 'Invented nested create', 'x_parent', 'handler', { typeName: 'Invented.Nested' }),
  ];
  const handlers = new Map([
    [
      HANDLER_STEP,
      () => {
        sdk.create('x_widget', { x_widgetid: WIDGET, x_name: 'nested' });
      },
    ],
  ]);
  store.setPluginPipeline(
    (context) => runPluginPhase({ ...context, store, items, handlers, webhooks, diagnostic }),
    ({ entity: table, operation }) =>
      items.some((item) => item.entity === table && item.message.toLowerCase() === operation),
    (context) => pluginPhaseRequiresCheckpoint(items, context),
  );
  const createParent = () => store.create('x_parent', { x_parentid: PARENT, x_name: 'outer' }, { admin: true });
  return { store, diagnostics, createParent, rows: (table) => store.tableRows(table).length };
}

test('the bridge answers a web hook POST from a receiver on another thread, and its status', async (t) => {
  const receiver = await threadReceiver(t);
  const post = (code) =>
    syncIo('http-post', {
      url: `${receiver.origin}/status/${code}`,
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
  assert.equal(post(200), 200);
  assert.equal(post(500), 500);
  assert.deepEqual(await receiver.log(), ['/status/200', '/status/500']);
});

test('the bridge gives up at its deadline with 504 SyncIoTimeout, and the next call gets a new worker', async (t) => {
  // A receiver on the waiting main thread can never answer: the call ends at the deadline.
  const server = http.createServer((req, res) => res.end());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  // The message names the deadline that ended the call, so the 10 s default cannot pass for the requested 300 ms.
  assert.throws(
    () =>
      syncIo(
        'http-post',
        { url: `http://127.0.0.1:${server.address().port}/hang`, headers: {}, body: '{}' },
        { timeoutMs: 300 },
      ),
    (error) => error.status === 504 && error.code === 'SyncIoTimeout' && /within 300 ms/.test(error.message),
  );
  const receiver = await threadReceiver(t);
  assert.equal(syncIo('http-post', { url: `${receiver.origin}/status/204`, headers: {}, body: '{}' }), 204);
});

test('a plug-in SDK create whose synchronous step sends to the emulator posts through the bridge inside the operation', async (t) => {
  const broker = await threadBroker(t);
  const { createParent, rows, diagnostics } = await world(t, { endpoint: { contract: 2 }, brokerPort: broker.port });
  await createParent();
  assert.equal(await broker.count('x-queue'), 1, 'the message was sent before the nested create returned');
  assert.deepEqual([rows('x_parent'), rows('x_widget')], [1, 1]);
  assert.ok(!diagnostics.some((entry) => entry.code === 'SERVICE_ENDPOINT_SENT_BEFORE_ROLLBACK'));
});

test('a failed bridge send fails the nested create and the outer operation, which roll back', async (t) => {
  const broker = await threadBroker(t);
  const { createParent, rows, diagnostics } = await world(t, {
    endpoint: { contract: 2 },
    brokerPort: broker.port,
    entity: 'x-missing',
  });
  await assert.rejects(
    createParent(),
    (error) =>
      error.code === 'ServiceEndpointFailed' &&
      /Invented sync send step/.test(error.message) &&
      /x-missing/.test(error.message),
  );
  assert.deepEqual([rows('x_parent'), rows('x_widget')], [0, 0], 'nothing is committed');
  assert.ok(diagnostics.some((entry) => entry.code === 'SERVICE_ENDPOINT_SEND_FAILED' && entry.stepId === SEND_STEP));
  assert.ok(!diagnostics.some((entry) => entry.code === 'SERVICE_ENDPOINT_SYNC_UNSUPPORTED'));
});

test('a synchronous web hook on the nested SDK drive posts through the bridge: 2xx commits, 500 rolls back', async (t) => {
  const receiver = await threadReceiver(t);
  const ok = await world(t, { endpoint: { contract: 8, url: `${receiver.origin}/status/200` } });
  await ok.createParent();
  assert.deepEqual([ok.rows('x_parent'), ok.rows('x_widget')], [1, 1]);
  const failing = await world(t, { endpoint: { contract: 8, url: `${receiver.origin}/status/500` } });
  await assert.rejects(failing.createParent(), /Endpoint unavailable/);
  assert.deepEqual([failing.rows('x_parent'), failing.rows('x_widget')], [0, 0]);
  assert.deepEqual(await receiver.log(), ['/status/200', '/status/500']);
});

test('a flow Dataverse CreateRecord action (the asynchronous drive) awaits the send and fails with it', async (t) => {
  const broker = await threadBroker(t);
  const sent = await world(t, { endpoint: { contract: 2 }, brokerPort: broker.port });
  const invoke = (store) =>
    createConnectorRuntime({ store }).invoke({
      connectorId: 'shared_commondataserviceforapps',
      operationId: 'CreateRecord',
      parameters: { entityName: 'x_widgets', 'item/x_name': 'from a flow' },
      context: { principal: profile },
    });
  assert.equal((await invoke(sent.store)).statusCode, 201);
  assert.equal(await broker.count('x-queue'), 1);
  assert.equal(sent.rows('x_widget'), 1);
  const refused = await world(t, { endpoint: { contract: 2 }, brokerPort: broker.port, entity: 'x-missing' });
  await assert.rejects(
    async () => invoke(refused.store),
    (error) => error.code === 'ServiceEndpointFailed',
  );
  assert.equal(refused.rows('x_widget'), 0);
});
