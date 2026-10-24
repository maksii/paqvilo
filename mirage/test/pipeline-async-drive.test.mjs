// The asynchronous drive for every write that is not a plug-in's own SDK call (a synchronous web hook
// runs inside its operation): a flow Dataverse action, the Assign cascade and CalculateRollupField post a synchronous web
// hook step in process, so Mirage keeps serving while the step waits and a receiver in Mirage's own process answers. The
// synchronous I/O bridge (plug-in SDK calls only) reports a post that may have been delivered, takes web hook authentication
// as an env: reference only, and reports a worker crash within the call.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { MessagePort, Worker } from 'node:worker_threads';
import { DataStore, emptyState } from '../lib/data.mjs';
import { serviceEndpointDelivery } from '../lib/dataverse-webhooks.mjs';
import { pluginPhaseRequiresCheckpoint, runPluginPhase } from '../lib/exported-plugins.mjs';
import { createConnectorRuntime } from '../lib/connector-runtime.mjs';
import { localOrganizationService } from '../lib/local-organization-service.mjs';
import { closeSyncIoBridge, syncIo, syncIoWorker } from '../lib/sync-io-bridge.mjs';
import { EXTENSION as CASCADE } from '../lib/dataverse-cascade.mjs';
import { EXTENSION as ROLLUP, recalculate } from '../lib/dataverse-rollup.mjs';
import { contractModuleFixture } from './contract-module-fixture.mjs';

const ENDPOINT = '77777777-7777-4777-8777-777777777b01',
  STEP = '77777777-7777-4777-8777-777777777b02';
const PARENT = '77777777-7777-4777-8777-777777777b03',
  CHILD = '77777777-7777-4777-8777-777777777b04';
const USER_ONE = '77777777-7777-4777-8777-777777777b05',
  USER_TWO = '77777777-7777-4777-8777-777777777b06';
const SECRET = 'invented-hook-secret-5d1e';
const profile = {
  userId: '77777777-7777-4777-8777-777777777b07',
  evidence: 'Invented test grants',
  grants: [{ entity: 'x_widget', operations: ['create', 'read', 'update', 'delete'] }],
};
test.after(() => closeSyncIoBridge());

// A receiver in this process that answers after `delayMs`; ticks() counts timer callbacks that ran meanwhile.
async function inProcessReceiver(t, { delayMs = 300 } = {}) {
  const received = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      received.push(req.url);
      setTimeout(() => res.writeHead(200).end(), delayMs);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}/hook`, received };
}
const ticking = () => {
  let ticks = 0;
  const timer = setInterval(() => ticks++, 25);
  return () => {
    clearInterval(timer);
    return ticks;
  };
};
// A loopback receiver on its own thread: /drop reads the request and drops the connection; /slow answers after 3 s; any
// other path answers 200. log() lists [path, header x-invented-key] it received.
async function threadReceiver(t) {
  const worker = new Worker(
    `
    const { parentPort } = require('node:worker_threads');
    const log = [];
    const server = require('node:http').createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        log.push([req.url.split('?')[0], req.headers['x-invented-key'] ?? null, new URL(req.url, 'http://x').searchParams.get('key')]);
        if (req.url.startsWith('/drop')) req.socket.destroy();
        else if (req.url.startsWith('/slow')) setTimeout(() => res.writeHead(200).end(), 3000);
        else res.writeHead(200).end();
      });
    });
    server.listen(0, '127.0.0.1', () => parentPort.postMessage({ port: server.address().port }));
    parentPort.on('message', () => parentPort.postMessage({ log }));`,
    { eval: true },
  );
  const { port } = await new Promise((resolve) => worker.once('message', resolve));
  t.after(() => worker.terminate());
  return {
    origin: `http://127.0.0.1:${port}`,
    log: () =>
      new Promise((resolve) => {
        worker.once('message', (message) => resolve(message.log));
        worker.postMessage('log');
      }),
  };
}

// A store with x_widget and a synchronous PostOperation web hook step on `message` of `table`, wired as the hosts wire it.
async function widgetWorld(endpoint, { table = 'x_widget', message = 'Create' } = {}) {
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
  Object.assign(state.tables, {
    x_widget: [],
    serviceendpoint: [
      { serviceendpointid: ENDPOINT, name: 'Invented hook', contract: 8, authtype: 5, authvalue: '', ...endpoint },
    ],
  });
  const store = await new DataStore({ state }).init();
  const diagnostics = [];
  wire(store, diagnostics, table, message);
  return { store, diagnostics };
}
function wire(store, diagnostics, table, message) {
  const items = [
    {
      id: STEP,
      name: 'Invented sync hook',
      enabled: true,
      mode: 'webhook',
      entity: table,
      message,
      stage: 40,
      rank: 1,
      contract: { mode: 0 },
      filteringAttributes: [],
      images: [],
      serviceEndpointId: ENDPOINT,
    },
  ];
  const webhooks = serviceEndpointDelivery(store);
  store.setPluginPipeline(
    (context) =>
      runPluginPhase({
        ...context,
        store,
        items,
        handlers: new Map(),
        webhooks,
        diagnostic: (entry) => diagnostics.push(entry),
      }),
    ({ entity, operation }) => entity === table && operation === message.toLowerCase(),
    (context) => pluginPhaseRequiresCheckpoint(items, context),
  );
}

test(
  'a flow Dataverse CreateRecord whose synchronous web hook receiver runs in this process commits without freezing Mirage',
  { timeout: 30_000 },
  async (t) => {
    const receiver = await inProcessReceiver(t);
    const { store } = await widgetWorld({ url: receiver.url });
    const stop = ticking();
    const answer = await createConnectorRuntime({ store }).invoke({
      connectorId: 'shared_commondataserviceforapps',
      operationId: 'CreateRecord',
      parameters: { entityName: 'x_widgets', 'item/x_name': 'from a flow' },
      context: { principal: profile },
    });
    const ticks = stop();
    assert.equal(answer.statusCode, 201);
    assert.deepEqual([store.tableRows('x_widget').length, receiver.received], [1, ['/hook']]);
    assert.ok(ticks >= 5, `timers kept running while the step waited (${ticks} ticks)`);
  },
);

test(
  'the Assign cascade updates each child on the asynchronous drive: an in-process synchronous web hook on the child answers',
  { timeout: 30_000 },
  async (t) => {
    const receiver = await inProcessReceiver(t, { delayMs: 100 });
    const owner = (id) => ({ id, logical_name: 'systemuser', name: 'Invented user' });
    const link = { from: 'x_parentid', to: 'x_parentid', cascade: { assign: 'Cascade' } };
    const { request, json, store } = await contractModuleFixture(t, {
      extension: CASCADE,
      mappings: {
        x_parent: {
          logicalName: 'x_parent',
          entitySet: 'x_parents',
          idColumn: 'x_parentid',
          nameColumn: 'x_name',
          relationships: { children: { entity: 'x_child', many: true, ...link } },
          fields: { x_name: { dataverseType: 'nvarchar' }, ownerid: { dataverseType: 'owner' } },
        },
        x_child: {
          logicalName: 'x_child',
          entitySet: 'x_children',
          idColumn: 'x_childid',
          nameColumn: 'x_name',
          relationships: { parent: { entity: 'x_parent', many: false, ...link } },
          fields: {
            x_name: { dataverseType: 'nvarchar' },
            x_parentid: { dataverseType: 'lookup' },
            ownerid: { dataverseType: 'owner' },
          },
        },
      },
      tables: {
        systemuser: [
          { systemuserid: USER_ONE, fullname: 'Invented one', statecode: 0 },
          { systemuserid: USER_TWO, fullname: 'Invented two', statecode: 0 },
        ],
        x_parent: [{ x_parentid: PARENT, x_name: 'Invented parent', ownerid: owner(USER_ONE), statecode: 0 }],
        x_child: [
          {
            x_childid: CHILD,
            x_name: 'Invented child',
            x_parentid: { id: PARENT, logical_name: 'x_parent', name: 'Invented parent' },
            ownerid: owner(USER_ONE),
            statecode: 0,
          },
        ],
        serviceendpoint: [
          {
            serviceendpointid: ENDPOINT,
            name: 'Invented hook',
            contract: 8,
            authtype: 5,
            authvalue: '',
            url: receiver.url,
          },
        ],
      },
    });
    wire(store, [], 'x_child', 'Update');
    const stop = ticking();
    await json(
      await request('PATCH', `/x_parents(${PARENT})`, { 'ownerid@odata.bind': `/systemusers(${USER_TWO})` }),
      200,
    );
    const ticks = stop();
    assert.equal(store.tableRows('x_child')[0].ownerid.id, USER_TWO);
    assert.deepEqual(receiver.received, ['/hook']);
    assert.ok(ticks >= 2, `timers kept running while the child's step waited (${ticks} ticks)`);
  },
);

test(
  'CalculateRollupField writes on the asynchronous drive: an in-process synchronous web hook on the row answers',
  { timeout: 30_000 },
  async (t) => {
    const receiver = await inProcessReceiver(t, { delayMs: 100 });
    let internal = null;
    const extension = {
      ...ROLLUP,
      install: (api, options) => {
        internal = api;
        return ROLLUP.install(api, options);
      },
    };
    const formula =
      '<fetch aggregate="true"><entity name="x_child"><attribute name="x_childid" aggregate="count" alias="c"/><filter><condition attribute="x_parentid" operator="eq" value="{id}"/></filter></entity></fetch>';
    const { store } = await contractModuleFixture(t, {
      extension,
      mappings: {
        x_parent: {
          logicalName: 'x_parent',
          entitySet: 'x_parents',
          idColumn: 'x_parentid',
          nameColumn: 'x_name',
          fields: {
            x_name: { dataverseType: 'nvarchar' },
            x_count: { dataverseType: 'decimal', columnMetadata: { sourceType: 2, formulaDefinition: formula } },
            x_count_state: { dataverseType: 'int' },
            x_count_date: { dataverseType: 'datetime' },
          },
        },
        x_child: {
          logicalName: 'x_child',
          entitySet: 'x_children',
          idColumn: 'x_childid',
          nameColumn: 'x_name',
          relationships: { x_parentid: { entity: 'x_parent', from: 'x_parentid', to: 'x_parentid', many: false } },
          fields: {
            x_name: { dataverseType: 'nvarchar' },
            x_parentid: { dataverseType: 'lookup', targets: ['x_parent'] },
          },
        },
      },
      tables: {
        x_parent: [{ x_parentid: PARENT, x_name: 'Invented parent', x_count_state: 0, statecode: 0 }],
        x_child: [
          {
            x_childid: CHILD,
            x_name: 'Invented child',
            x_parentid: { id: PARENT, logical_name: 'x_parent', name: 'Invented parent' },
            statecode: 0,
          },
        ],
        serviceendpoint: [
          {
            serviceendpointid: ENDPOINT,
            name: 'Invented hook',
            contract: 8,
            authtype: 5,
            authvalue: '',
            url: receiver.url,
          },
        ],
      },
    });
    wire(store, [], 'x_parent', 'Update');
    const stop = ticking();
    const result = await recalculate(internal, 'x_parent', PARENT, 'x_count');
    const ticks = stop();
    assert.deepEqual([result.value, result.state, store.tableRows('x_parent')[0].x_count], [1, 1, 1]);
    assert.deepEqual(receiver.received, ['/hook']);
    assert.ok(ticks >= 2, `timers kept running while the step waited (${ticks} ticks)`);
  },
);

test('a bridge post that may have been delivered (the connection dropped after the request) notes SERVICE_ENDPOINT_SEND_INDETERMINATE when the operation rolls back', async (t) => {
  const receiver = await threadReceiver(t);
  const { store, diagnostics } = await widgetWorld({
    url: `${receiver.origin}/drop`,
    authvalue: `x-invented-key: ${SECRET}`,
  });
  const sdk = localOrganizationService(store, profile);
  assert.throws(() => sdk.create('x_widget', { x_name: 'nested' }), /Endpoint unavailable/);
  // The note runs when the outermost transaction rolls back; the SDK call above ran outside one, so run it inside one too.
  await assert.rejects(
    store.transact(() => sdk.create('x_widget', { x_name: 'in a transaction' })),
    /Endpoint unavailable/,
  );
  assert.equal(store.tableRows('x_widget').length, 0);
  const notes = diagnostics.filter((entry) => entry.code === 'SERVICE_ENDPOINT_SEND_INDETERMINATE');
  assert.equal(notes.length, 1);
  assert.deepEqual([notes[0].indeterminate, notes[0].target, notes[0].stepId], [true, '127.0.0.1', STEP]);
  assert.ok(!JSON.stringify(diagnostics).includes(SECRET), 'no authentication value in a diagnostic');
  assert.deepEqual(
    (await receiver.log()).map(([path]) => path),
    ['/drop', '/drop'],
  );
});

test('a web hook authentication value never crosses the bridge: the worker resolves its env: reference', async (t) => {
  const receiver = await threadReceiver(t);
  const posted = [],
    original = MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage = function capture(message, ...rest) {
    posted.push(JSON.stringify(message));
    return original.call(this, message, ...rest);
  };
  t.after(() => {
    MessagePort.prototype.postMessage = original;
  });
  const header = await widgetWorld({
    url: `${receiver.origin}/ok`,
    authtype: 5,
    authvalue: `<settings><setting name="x-invented-key" value="${SECRET}" /></settings>`,
  });
  localOrganizationService(header.store, profile).create('x_widget', { x_name: 'header auth' });
  const query = await widgetWorld({ url: `${receiver.origin}/query`, authtype: 6, authvalue: `key=${SECRET}` });
  localOrganizationService(query.store, profile).create('x_widget', { x_name: 'query auth' });
  MessagePort.prototype.postMessage = original;
  assert.deepEqual(await receiver.log(), [
    ['/ok', SECRET, null],
    ['/query', null, SECRET],
  ]);
  const bridge = posted.filter((text) => text.includes('"http-post"'));
  assert.equal(bridge.length, 2);
  for (const text of bridge) {
    assert.ok(!text.includes(SECRET), text);
    assert.match(text, /"ref":"env:PAQVILO_SYNC_IO_AUTH_[0-9a-f]{32}"/);
  }
  assert.ok(
    !Object.keys(process.env).some((name) => name.startsWith('PAQVILO_SYNC_IO_AUTH_')),
    'the reference lives for its call only',
  );
});

test('a worker crash is reported to the waiting caller within the call, and the next call gets a new worker', async (t) => {
  const receiver = await threadReceiver(t);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mirage-sync-io-crash-'));
  const crashing = path.join(dir, 'crashing-worker.mjs');
  const real = syncIoWorker.url;
  await fs.writeFile(
    crashing,
    `import { workerData } from 'node:worker_threads';\nawait import(${JSON.stringify(real.href)});\nworkerData.port.on('message', () => setTimeout(() => { throw new Error('invented worker crash'); }, 50));\n`,
  );
  t.after(async () => {
    syncIoWorker.url = real;
    await closeSyncIoBridge();
    await fs.rm(dir, { recursive: true, force: true });
  });
  await closeSyncIoBridge();
  syncIoWorker.url = new URL(`file:///${crashing.replaceAll('\\', '/').replace(/^\//, '')}`);
  const started = Date.now();
  assert.throws(
    () => syncIo('http-post', { url: `${receiver.origin}/slow`, headers: {}, body: '{}' }, { timeoutMs: 20_000 }),
    (error) => error.code === 'SyncIoWorkerFailed' && /invented worker crash/.test(error.message),
  );
  assert.ok(Date.now() - started < 2500, `answered within the call (${Date.now() - started} ms), not at the deadline`);
  syncIoWorker.url = real;
  assert.equal(syncIo('http-post', { url: `${receiver.origin}/ok`, headers: {}, body: '{}' }), 200);
});
