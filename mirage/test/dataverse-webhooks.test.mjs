// Web hooks: a step whose eventhandler is a contract 8 service endpoint POSTs the RemoteExecutionContext to a loopback URL.
// The shared receiver is a separate test process (one per file; each test posts under its own path prefix and reads only its
// own entries); one test uses a receiver in the test's own process, which the asynchronous pipeline (store.create) awaits.
import { describe, it, before, after, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DataStore, emptyState } from '../lib/data.mjs';
import { install as installRegistration } from '../lib/dataverse-plugin-registration.mjs';
import { isLoopbackUrl, loopbackFetch, serviceEndpointDelivery, webhookDelivery } from '../lib/dataverse-webhooks.mjs';
import { createLocalMessageBus } from '../lib/message-bus.mjs';
import { createCounters } from '../lib/runtime-counters.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { widgetApi, wireRegisteredSteps } from './support/service-endpoint-pipeline.mjs';

const WIDGET = 'bbbbbbbb-0000-4000-8000-000000000021';
const ENDPOINT = 'cccccccc-0000-4000-8000-000000000021';
const STEP = 'dddddddd-0000-4000-8000-000000000021';
const KEY = 'invented-key-7f3a';
// The 27 documented RemoteExecutionContext properties, in the order of the documented sample.
const PROPERTIES = [
  'BusinessUnitId',
  'CorrelationId',
  'Depth',
  'InitiatingUserId',
  'InputParameters',
  'IsExecutingOffline',
  'IsInTransaction',
  'IsOfflinePlayback',
  'IsolationMode',
  'MessageName',
  'Mode',
  'OperationCreatedOn',
  'OperationId',
  'OrganizationId',
  'OrganizationName',
  'OutputParameters',
  'OwningExtension',
  'ParentContext',
  'PostEntityImages',
  'PreEntityImages',
  'PrimaryEntityId',
  'PrimaryEntityName',
  'RequestId',
  'SecondaryEntityName',
  'SharedVariables',
  'Stage',
  'UserId',
];

// The receiver runs as its own Node process. A path ending /status/<code> answers that code; one ending /flaky answers 503 once
// and then 200. /__log returns what it received (not itself recorded).
const RECEIVER = `
import { createServer } from 'node:http';
const log = [];
const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/__log') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(log)); return; }
    const text = Buffer.concat(chunks).toString('utf8');
    const earlier = log.filter((entry) => entry.path === url.pathname).length;
    log.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body: text ? JSON.parse(text) : null });
    const status = url.pathname.endsWith('/flaky') ? (earlier === 0 ? 503 : 200) : Number(url.pathname.split('/').at(-1));
    res.writeHead(status); res.end('{"ignored":true}');
  });
});
server.listen(0, '127.0.0.1', () => console.log('PORT ' + server.address().port));
`;

async function startReceiver() {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-webhook-'));
  const file = path.join(dir, 'receiver.mjs');
  await fs.writeFile(file, RECEIVER);
  const child = childProcess.spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = /PORT (\d+)/.exec(output);
      if (match) resolve(Number(match[1]));
    });
    child.on('exit', (code) => reject(new Error(`receiver exited with ${code}`)));
  });
  return {
    origin: `http://127.0.0.1:${port}`,
    log: async (prefix) =>
      (await (await fetch(`http://127.0.0.1:${port}/__log`)).json()).filter((entry) =>
        entry.path.startsWith(`${prefix}/`),
      ),
    async stop() {
      // The receiver has exited before its directory goes (a running process can hold it busy on Windows).
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill();
        await exited;
      }
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

// A store with the Dataverse API, the registration rows and the pipeline wired the way server.mjs wires it. The endpoint and the
// step are rows, so each test writes them and can change the endpoint's URL and authentication by editing its row.
async function world({ mode = 0, delivery = webhookDelivery } = {}) {
  const diagnostics = [];
  const diagnostic = (entry) => diagnostics.push(entry);
  const { store, api, messageId, filterId } = await widgetApi('contoso');
  await store.create(
    'serviceendpoint',
    {
      serviceendpointid: ENDPOINT,
      name: 'Invented hook',
      url: 'http://127.0.0.1:9/hook',
      authtype: 5,
      contract: 8,
      authvalue: '',
    },
    { admin: true },
  );
  await store.create(
    'sdkmessageprocessingstep',
    {
      sdkmessageprocessingstepid: STEP,
      name: 'Invented webhook step',
      sdkmessageid: messageId,
      sdkmessagefilterid: filterId,
      eventhandler: { id: ENDPOINT, logical_name: 'serviceendpoint' }, // the bound table, as eventhandler_serviceendpoint@odata.bind writes it
      stage: 40,
      mode,
      rank: 1,
      statecode: 0,
      supporteddeployment: 0,
    },
    { admin: true },
  );
  const webhooks = delivery(store);
  const runner = wireRegisteredSteps(store, webhooks, diagnostic);
  // Points the endpoint row at a URL, and sets its authentication (authtype and the stored authvalue).
  const endpoint = (fields) =>
    store.transact(() =>
      Object.assign(
        store.state.tables.serviceendpoint.find((row) => row.serviceendpointid === ENDPOINT),
        fields,
      ),
    );
  return {
    store,
    api,
    runner,
    diagnostics,
    endpoint,
    close: async () => {
      await runner.close();
      await api.close();
    },
  };
}

let receiver;
before(async () => {
  receiver = await startReceiver();
});
after(() => receiver?.stop());
let routes = 0;
// A path prefix of the shared receiver that no other test uses.
const route = () => `/t${++routes}`;

const create = (store, name = 'alpha') =>
  store.create('contoso_widget', { contoso_widgetid: WIDGET, contoso_name: name }, { admin: true });
const rowsOf = (store) => store.tableRows('contoso_widget');

describe('loopback guard (shared with TriggerServiceEndpointCheck)', () => {
  it('accepts localhost, *.localhost, 127.0.0.0/8 and ::1 over http or https, and nothing else', () => {
    for (const url of ['http://localhost:1/x', 'https://api.localhost/x', 'http://127.0.0.2/x', 'http://[::1]:8080/x'])
      assert.equal(isLoopbackUrl(url), true, url);
    for (const url of [
      'https://example.test/x',
      'http://localhost.example.test/x',
      'http://127.0.0.1.example.test/x',
      'ftp://127.0.0.1/x',
      'not a url',
    ])
      assert.equal(isLoopbackUrl(url), false, url);
  });
});

describe('synchronous web hooks', () => {
  let session;
  afterEach(async () => {
    mock.restoreAll();
    await session?.close();
    session = null;
  });

  it('posts the documented RemoteExecutionContext with the header authentication, and its 200 lets the create commit', async () => {
    const at = route();
    session = await world();
    await session.endpoint({
      url: `${receiver.origin}${at}/status/200`,
      authtype: 5,
      authvalue: `<settings><setting name="x-contoso-key" value="${KEY}" /></settings>`,
    });
    await create(session.store);
    assert.equal(rowsOf(session.store).length, 1, 'the create committed');
    const [entry] = await receiver.log(at);
    assert.equal(entry.method, 'POST');
    assert.equal(entry.path, `${at}/status/200`);
    assert.equal(entry.headers['x-contoso-key'], KEY);
    assert.equal(entry.headers['content-type'], 'application/json');
    assert.equal(entry.headers['x-ms-dynamics-entity-name'], 'contoso_widget');
    assert.equal(entry.headers['x-ms-dynamics-request-name'], 'Create');
    assert.match(entry.headers['x-ms-correlation-request-id'], /^[0-9a-f-]{36}$/);
    assert.deepEqual(Object.keys(entry.body), PROPERTIES);
    assert.equal(entry.body.MessageName, 'Create');
    assert.equal(entry.body.Stage, 40);
    assert.equal(entry.body.Mode, 0);
    assert.equal(entry.body.PrimaryEntityName, 'contoso_widget');
    assert.equal(entry.body.PrimaryEntityId, WIDGET);
    assert.equal(entry.body.InputParameters[0].key, 'Target');
    assert.match(
      entry.body.InputParameters[0].value.__type,
      /^Entity:http:\/\/schemas\.microsoft\.com\/xrm\/2011\/Contracts$/,
    );
    assert.deepEqual(entry.body.OutputParameters, [{ key: 'id', value: WIDGET }]);
    assert.deepEqual(entry.body.OwningExtension, {
      Id: STEP,
      KeyAttributes: [],
      LogicalName: 'sdkmessageprocessingstep',
      Name: null,
      RowVersion: null,
    });
  });

  it('sends a WebhookKey as the code query string', async () => {
    const at = route();
    session = await world();
    await session.endpoint({ url: `${receiver.origin}${at}/status/200`, authtype: 4, authvalue: KEY });
    await create(session.store);
    const [entry] = await receiver.log(at);
    assert.equal(entry.query.code, KEY);
  });

  it('a 500 fails the create with the endpoint fault and rolls it back', async () => {
    const at = route();
    session = await world();
    await session.endpoint({ url: `${receiver.origin}${at}/status/500` });
    await assert.rejects(
      create(session.store),
      (error) =>
        error.status === 400 && error.message === 'Endpoint unavailable' && error.details?.innerCode === '0x80040265',
    );
    assert.equal(rowsOf(session.store).length, 0, 'the create rolled back');
    assert.equal((await receiver.log(at)).length, 1, 'the endpoint was called once');
  });

  it('retries a 503 once, as Learn documents, and the second answer decides', async () => {
    const at = route();
    session = await world();
    await session.endpoint({ url: `${receiver.origin}${at}/flaky` });
    await create(session.store);
    assert.equal(rowsOf(session.store).length, 1);
    assert.equal((await receiver.log(at)).length, 2);
  });

  it('a payload over 256 KB drops ParentContext, InputParameters, PreEntityImages and PostEntityImages and says so in a header', async () => {
    const at = route();
    session = await world();
    await session.endpoint({ url: `${receiver.origin}${at}/status/200` });
    await create(session.store, 'x'.repeat(300 * 1024));
    const [entry] = await receiver.log(at);
    assert.equal(entry.headers['x-ms-dynamics-msg-size-exceeded'] !== undefined, true);
    for (const removed of ['ParentContext', 'InputParameters', 'PreEntityImages', 'PostEntityImages'])
      assert.equal(Object.hasOwn(entry.body, removed), false, removed);
    assert.equal(entry.body.MessageName, 'Create');
  });

  it('a non-loopback URL is never contacted: the create succeeds, and a diagnostic names only the host', async () => {
    session = await world();
    const secret = 'invented-authvalue-9d2c';
    await session.endpoint({
      url: 'https://hooks.contoso.invalid/hook?code=invented-query-secret',
      authtype: 4,
      authvalue: secret,
    });
    session.store.counters = createCounters();
    const fetchSpy = mock.method(globalThis, 'fetch');
    await create(session.store);
    assert.equal(rowsOf(session.store).length, 1, 'the create committed');
    const toHost = (input) => String(input ?? '').includes('contoso.invalid');
    assert.equal(
      fetchSpy.mock.calls.filter((call) => toHost(String(call.arguments[0]))).length,
      0,
      'fetch never reached it',
    );
    const diagnostic = session.diagnostics.find((entry) => entry.code === 'WEBHOOK_NOT_CONTACTED');
    assert.equal(diagnostic.reason, 'non-loopback');
    assert.equal(diagnostic.host, 'hooks.contoso.invalid');
    // An uncontacted step never counts or reports as delivered.
    assert.doesNotMatch(diagnostic.message, /treated as delivered/);
    assert.deepEqual(session.store.counters.snapshot(), { 'webhooks.notContacted': 1 });
    const text = JSON.stringify(session.diagnostics);
    assert.equal(text.includes(secret), false, 'the authvalue is in no diagnostic');
    assert.equal(text.includes('invented-query-secret'), false, 'the URL path and query are in no diagnostic');
  });

  it("a receiver in Mirage's own process answers: the asynchronous pipeline awaits the POST instead of blocking the event loop", async () => {
    session = await world();
    const received = [];
    const server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        received.push(req.url);
        res.writeHead(req.url.endsWith('500') ? 500 : 200);
        res.end();
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      await session.endpoint({ url: `${origin}/status/500` });
      await assert.rejects(create(session.store), /Endpoint unavailable/);
      assert.equal(rowsOf(session.store).length, 0);
      await session.endpoint({ url: `${origin}/status/200` });
      await create(session.store);
      assert.equal(rowsOf(session.store).length, 1);
      assert.deepEqual(received, ['/status/500', '/status/200']);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('a contract other than 8 is not simulated and never contacted, and the create succeeds', async () => {
    session = await world();
    await session.endpoint({ url: 'http://127.0.0.1:9/queue', contract: 2 });
    await create(session.store);
    assert.equal(rowsOf(session.store).length, 1);
    assert.ok(
      session.diagnostics.some(
        (entry) => entry.code === 'WEBHOOK_NOT_DELIVERED' && entry.reason === 'contract-not-simulated',
      ),
    );
  });
});

describe('asynchronous web hooks', () => {
  let session;
  afterEach(async () => {
    mock.restoreAll();
    await session?.close();
    session = null;
  });

  it('is delivered after commit and its asyncoperation row ends Succeeded', async () => {
    const at = route();
    session = await world({ mode: 1 });
    await session.endpoint({
      url: `${receiver.origin}${at}/status/200`,
      authtype: 5,
      authvalue: `<settings><setting name="x-contoso-key" value="${KEY}" /></settings>`,
    });
    await create(session.store);
    await session.runner.drain();
    assert.equal(rowsOf(session.store).length, 1);
    const [entry] = await receiver.log(at);
    assert.equal(entry.body.PrimaryEntityId, WIDGET);
    assert.equal(entry.body.Mode, 1);
    assert.equal(entry.headers['x-contoso-key'], KEY);
    const [job] = session.store.tableRows('asyncoperation');
    assert.equal(job.statuscode, 30);
    assert.equal(job.owningextensionid.id, STEP);
    assert.equal(job.operationtype, 1);
  });

  it('a 500 ends the System Job Failed with the fault code and its message', async () => {
    const at = route();
    session = await world({ mode: 1 });
    await session.endpoint({ url: `${receiver.origin}${at}/status/500` });
    await create(session.store);
    await session.runner.drain();
    assert.equal(rowsOf(session.store).length, 1, 'the create is not rolled back');
    const [job] = session.store.tableRows('asyncoperation');
    assert.equal(job.statuscode, 31);
    assert.equal(job.message, 'Endpoint unavailable');
    assert.equal(Number.isInteger(job.errorcode), true);
  });

  // An uncontacted endpoint ends Canceled (32), as for an endpoint contract the simulator does not deliver; Succeeded (30)
  // would report a delivery that never happened.
  it('a non-loopback URL is never contacted and its job is Canceled, with the not-contacted diagnostic', async () => {
    session = await world({ mode: 1 });
    await session.endpoint({ url: 'https://hooks.contoso.invalid/hook' });
    const fetchSpy = mock.method(globalThis, 'fetch');
    await create(session.store);
    await session.runner.drain();
    assert.equal(fetchSpy.mock.calls.filter((call) => String(call.arguments[0]).includes('contoso.invalid')).length, 0);
    const [job] = session.store.tableRows('asyncoperation');
    assert.equal(job.statuscode, 32);
    assert.equal(job.message, 'Simulator: endpoint not contacted (loopback webhooks only)');
    assert.ok(
      session.diagnostics.some(
        (entry) =>
          entry.code === 'WEBHOOK_NOT_CONTACTED' &&
          entry.host === 'hooks.contoso.invalid' &&
          !/treated as delivered/.test(entry.message),
      ),
    );
  });

  it('a contract other than 8 is never contacted and its job is Canceled (32) with the documented-shape message', async () => {
    session = await world({ mode: 1 });
    await session.endpoint({ url: 'http://127.0.0.1:9/queue', contract: 2 });
    const fetchSpy = mock.method(globalThis, 'fetch');
    await create(session.store);
    await session.runner.drain();
    assert.equal(rowsOf(session.store).length, 1);
    assert.equal(fetchSpy.mock.calls.filter((call) => String(call.arguments[0]).includes('127.0.0.1:9')).length, 0);
    const [job] = session.store.tableRows('asyncoperation');
    assert.equal(job.statuscode, 32);
    assert.equal(job.statecode, 3);
    assert.equal(job.message, 'Simulator: endpoint not delivered (loopback webhooks only)');
    assert.ok(
      session.diagnostics.some(
        (entry) => entry.code === 'WEBHOOK_NOT_DELIVERED' && entry.reason === 'contract-not-simulated',
      ),
    );
  });
});

describe('TriggerServiceEndpointCheck probes loopback endpoints only', () => {
  function action() {
    const ops = [];
    installRegistration({
      store: new DataStore({ state: emptyState() }),
      recordHooks: { add() {} },
      registry: { register: (op) => ops.push(op) },
      principals: {},
      settings: {},
    });
    return ops.find((op) => op.name === 'TriggerServiceEndpointCheck');
  }
  const probe = (row) => action().handle({ target: { id: 'row', row }, body: {}, user: { systemuserid: 'x' } });

  it('answers 204 for a loopback contract 8 endpoint that accepts the probe, and refuses the others', async () => {
    const at = route();
    assert.deepEqual(await probe({ contract: 8, url: `${receiver.origin}${at}/status/200` }), { status: 204 });
    await assert.rejects(
      probe({ contract: 8, url: 'https://hooks.contoso.invalid/hook' }),
      (error) => error.status === 400,
    );
    await assert.rejects(
      probe({ contract: 2, url: `${receiver.origin}${at}/status/200` }),
      (error) => error.status === 400,
    );
    assert.equal((await receiver.log(at)).length, 1, 'only the loopback probe reached the receiver');
  });
});

describe('loopback guard by resolved address', () => {
  afterEach(() => mock.restoreAll());

  it('refuses a *.localhost name that resolves to a routable address, without a connection', async () => {
    const fetchSpy = mock.method(globalThis, 'fetch');
    const lookups = [];
    const lookup = async (host, options) => {
      lookups.push([host, options]);
      return [{ address: '203.0.113.5', family: 4 }];
    };
    await assert.rejects(
      loopbackFetch('http://fx.localhost:1/', { method: 'POST', lookup }),
      (error) => error.message === 'Endpoint unavailable',
    );
    assert.deepEqual(lookups, [['fx.localhost', { all: true }]]);
    assert.equal(fetchSpy.mock.callCount(), 0, 'no request was sent');
    const mixed = async () => [
      { address: '127.0.0.1', family: 4 },
      { address: '203.0.113.5', family: 4 },
    ];
    await assert.rejects(loopbackFetch('http://fx.localhost:1/', { lookup: mixed }), /Endpoint unavailable/);
    assert.equal(fetchSpy.mock.callCount(), 0);
  });
});

describe('service endpoint bus steps', () => {
  let session;
  afterEach(async () => {
    await session?.close();
    session = null;
  });

  it('a sync bus step whose send the bus would refuse fails the operation and rolls it back', async () => {
    let bus = null;
    // A bare bus with unvalidated settings.endpoints: the mapped entity name fails the bus's entity rule.
    session = await world({
      delivery: (store) => {
        bus = createLocalMessageBus({ store });
        bus.settings = { endpoints: { [ENDPOINT]: 'local/not a valid entity!' } };
        return serviceEndpointDelivery(store, { messaging: bus });
      },
    });
    await session.endpoint({ contract: 2, url: null });
    await assert.rejects(create(session.store), /Endpoint unavailable/);
    assert.equal(rowsOf(session.store).length, 0, 'the create rolled back');
    assert.ok(session.diagnostics.some((entry) => entry.code === 'SERVICE_ENDPOINT_SEND_FAILED'));
  });
});
