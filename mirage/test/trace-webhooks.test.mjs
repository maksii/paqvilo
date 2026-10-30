// @test-kind contract: Paqvilo's tracing and activity design (docs/design/tracing.md)
// Tracing of service endpoint deliveries (D-R3-5, DV-A-5, DV-A-15, DV-C-7): a web hook POST is an http-out span that, at
// level full, carries the RemoteExecutionContext it sent and the receiver's answer on every drive (the asynchronous
// pipeline, after commit, and the synchronous I/O bridge); a Service Bus queue or topic send is a `webhook` span with
// transport 'servicebus'; TriggerServiceEndpointCheck is an http-out span; a secret span names its vault and secret, never
// the value. The receiver is its own process (the bridge blocks this thread while it posts). Invented schema only.
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DataStore, emptyState } from '../lib/data.mjs';
import { install as installRegistration, overlayRegisteredSteps } from '../lib/dataverse-plugin-registration.mjs';
import { serviceEndpointDelivery } from '../lib/dataverse-webhooks.mjs';
import { createLocalMessageBus } from '../lib/message-bus.mjs';
import { createSecretResolver } from '../lib/secret-resolver.mjs';
import { pluginCatalogue } from '../lib/exported-plugins.mjs';
import { createTraceStore } from '../lib/trace-store.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { widgetApi, wireRegisteredSteps } from './support/service-endpoint-pipeline.mjs';

const WIDGET = 'bbbbbbbb-0000-4000-8000-0000000000a1';
const ENDPOINT = 'cccccccc-0000-4000-8000-0000000000a1';
const STEP = 'dddddddd-0000-4000-8000-0000000000a1';
const CODE = 'invented-hook-code-31c9';

// A path ending /status/<code> answers that code with a JSON body naming the path; /__log lists what arrived.
const RECEIVER = `
import { createServer } from 'node:http';
const log = [];
createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const url = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/__log') return res.end(JSON.stringify(log));
    log.push({ path: url.pathname, headers: req.headers });
    res.writeHead(Number(url.pathname.split('/').at(-1)));
    res.end(JSON.stringify({ receivedBy: 'invented receiver', path: url.pathname }));
  });
}).listen(0, '127.0.0.1', function () { console.log('PORT ' + this.address().port); });
`;

let receiver;
before(async () => {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-trace-webhooks-'));
  await fs.writeFile(path.join(dir, 'receiver.mjs'), RECEIVER);
  const child = childProcess.spawn(process.execPath, [path.join(dir, 'receiver.mjs')], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = /PORT (\d+)/.exec(output);
      if (match) resolve(Number(match[1]));
    });
    child.on('exit', (code) => reject(new Error(`receiver exited with ${code}`)));
  });
  receiver = {
    origin: `http://127.0.0.1:${port}`,
    log: async (prefix) =>
      (await (await fetch(`http://127.0.0.1:${port}/__log`)).json()).filter((entry) => entry.path.startsWith(prefix)),
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill();
        await exited;
      }
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
});
after(() => receiver?.stop());
let routes = 0;
const route = () => `/t${++routes}`;

// The store, the Dataverse API, one service endpoint and one step on Create of contoso_widget, wired as server.mjs wires
// them; level full. bus: a local message bus mapping the endpoint to `local/<queue>`.
async function world({ mode = 0, contract = 8, url = null, queue = null } = {}) {
  const { store, api, messageId, filterId } = await widgetApi('contoso');
  await store.create(
    'serviceendpoint',
    { serviceendpointid: ENDPOINT, name: 'Invented endpoint', url, authtype: 4, contract, authvalue: CODE },
    { admin: true },
  );
  await store.create(
    'sdkmessageprocessingstep',
    {
      sdkmessageprocessingstepid: STEP,
      name: 'Invented endpoint step',
      sdkmessageid: messageId,
      sdkmessagefilterid: filterId,
      eventhandler: { id: ENDPOINT, logical_name: 'serviceendpoint' },
      stage: 40,
      mode,
      rank: 1,
      statecode: 0,
      supporteddeployment: 0,
    },
    { admin: true },
  );
  let bus = null;
  if (queue) {
    bus = createLocalMessageBus({ store });
    bus.settings = { endpoints: { [ENDPOINT]: `local/${queue}` } };
  }
  const webhooks = serviceEndpointDelivery(store, { messaging: bus });
  const runner = wireRegisteredSteps(store, webhooks);
  store.traces = createTraceStore({ settings: { level: 'full' } });
  const traces = store.traces;
  // One create inside a request span; resolves to that span (its trace holds the delivery).
  const create = async () => {
    const request = traces.start({ kind: 'http', name: 'POST /invented/widgets' });
    await traces
      .run(request, () =>
        store.create('contoso_widget', { contoso_widgetid: WIDGET, contoso_name: 'Hooked' }, { admin: true }),
      )
      .catch(() => {});
    request.end();
    await runner.drain();
    return request;
  };
  return {
    store,
    traces,
    webhooks,
    create,
    close: async () => {
      await runner.close();
      await api.close();
    },
  };
}

describe('web hook and Service Bus delivery spans', () => {
  let session;
  afterEach(async () => {
    await session?.close();
    session = null;
  });
  const spansOf = (request, kind) => session.traces.tree(request.traceId).spans.filter((span) => span.kind === kind);

  it('a synchronous web hook step records the context it sent and the answer, without the endpoint authentication', async () => {
    const at = route();
    session = await world({ url: `${receiver.origin}${at}/status/200` });
    const request = await session.create();
    const [post] = spansOf(request, 'http-out');
    assert.equal(post.module, 'webhooks');
    assert.equal(post.entity, 'contoso_widget');
    assert.equal(post.recordId, WIDGET);
    assert.equal(post.attributes.stepName, 'Invented endpoint step');
    assert.equal(post.input.url, `${receiver.origin}${at}/status/200`);
    assert.equal(post.input.headers['x-ms-dynamics-request-name'], 'Create');
    assert.equal(post.input.body.MessageName, 'Create');
    assert.equal(post.input.body.PrimaryEntityId, WIDGET);
    assert.deepEqual(post.output, {
      status: 200,
      body: { receivedBy: 'invented receiver', path: `${at}/status/200` },
    });
    const [arrived] = await receiver.log(at);
    assert.equal(arrived.headers['x-sim-parent-trace'], post.spanId);
    assert.equal(JSON.stringify(session.traces.export({})).includes(CODE), false, 'no span holds the WebhookKey code');
  });

  it('a 500 answer is the span error with the status, and the answer body is kept', async () => {
    const at = route();
    session = await world({ url: `${receiver.origin}${at}/status/500` });
    const request = await session.create();
    const [post] = spansOf(request, 'http-out');
    assert.equal(post.status, 'error');
    assert.deepEqual([post.error.code, post.error.status], ['Http500', 500]);
    assert.equal(post.output.status, 500);
    assert.equal(post.output.body.receivedBy, 'invented receiver');
  });

  it('an asynchronous web hook job records the answer of its delivery after commit', async () => {
    const at = route();
    session = await world({ mode: 1, url: `${receiver.origin}${at}/status/202` });
    const request = await session.create();
    const [job] = spansOf(request, 'job');
    const [post] = spansOf(request, 'http-out');
    assert.equal(post.parentSpanId, job.spanId);
    assert.equal(post.input.body.Mode, 1);
    assert.deepEqual(post.output, { status: 202, body: { receivedBy: 'invented receiver', path: `${at}/status/202` } });
  });

  it('the synchronous I/O bridge drive records the answer the worker read', async () => {
    const at = route();
    session = await world({ url: `${receiver.origin}${at}/status/200` });
    const item = pluginCatalogue({
      plugins: overlayRegisteredSteps({ steps: [], types: [], assemblies: [] }, session.store),
      handlers: new Map(),
    }).find((step) => step.id === STEP);
    const request = session.traces.start({ kind: 'http', name: 'POST /invented/sdk' });
    session.traces.run(request, () =>
      session.webhooks.sync({
        item,
        entity: 'contoso_widget',
        operation: 'create',
        stage: 40,
        target: { contoso_name: 'Bridged' },
        record: { contoso_widgetid: WIDGET, contoso_name: 'Bridged' },
        identity: null,
        depth: 1,
        correlationId: 'eeeeeeee-0000-4000-8000-0000000000a1',
      }),
    );
    request.end();
    const [post] = spansOf(request, 'http-out');
    assert.equal(post.attributes.statusCode, 200);
    assert.deepEqual(post.output, { status: 200, body: { receivedBy: 'invented receiver', path: `${at}/status/200` } });
  });

  it('a Service Bus queue step is a webhook span with transport servicebus and the message at full', async () => {
    session = await world({ contract: 2, queue: 'invented-orders' });
    const request = await session.create();
    const [send] = spansOf(request, 'webhook');
    assert.ok(send, 'the bus send has its own span');
    assert.equal(send.name, 'Send local/invented-orders');
    assert.equal(send.module, 'webhooks');
    assert.equal(send.status, 'ok');
    assert.equal(send.recordId, WIDGET);
    assert.equal(send.attributes.transport, 'servicebus');
    assert.equal(send.attributes.channel, 'queue');
    assert.equal(send.attributes.queue, 'invented-orders');
    assert.equal(send.attributes.contract, 2);
    assert.equal(send.attributes.messageId, send.input.messageId);
    assert.equal(send.input.body.MessageName, 'Create');
    assert.equal(send.input.properties.requestName, 'Create');
    assert.equal(typeof send.attributes.sequenceNumber, 'number');
    const [step] = spansOf(request, 'plugin-step');
    assert.equal(send.parentSpanId, step.spanId, 'the send nests in its step');
  });

  it('a Service Bus topic step delivered after commit is a webhook span under its job span', async () => {
    session = await world({ mode: 1, contract: 5, queue: 'invented-topic' });
    const request = await session.create();
    const [job] = spansOf(request, 'job');
    const [send] = spansOf(request, 'webhook');
    assert.equal(send.parentSpanId, job.spanId);
    assert.equal(send.attributes.channel, 'topic');
    assert.equal(send.attributes.mode, 'async');
    assert.equal(send.input.body.Mode, 1);
  });

  it('a refused bus send fails its webhook span', async () => {
    session = await world({ contract: 2, queue: 'invented-orders' });
    // The local bus refuses nothing here, so make its send fail as a broker would.
    const failing = createLocalMessageBus({ store: session.store });
    failing.settings = { endpoints: { [ENDPOINT]: 'local/invented-orders' } };
    failing.send = async () => {
      throw Object.assign(new Error('Invented broker failure'), { code: 'InventedBrokerFailure' });
    };
    const delivery = serviceEndpointDelivery(session.store, { messaging: failing });
    const item = pluginCatalogue({
      plugins: overlayRegisteredSteps({ steps: [], types: [], assemblies: [] }, session.store),
      handlers: new Map(),
    }).find((step) => step.id === STEP);
    const request = session.traces.start({ kind: 'http', name: 'POST /invented/failing' });
    await assert.rejects(
      session.traces.run(request, () =>
        delivery.afterCommit({
          item,
          entity: 'contoso_widget',
          operation: 'create',
          stage: 40,
          target: { contoso_name: 'Failing' },
          record: { contoso_widgetid: WIDGET, contoso_name: 'Failing' },
          identity: null,
          depth: 1,
          correlationId: 'eeeeeeee-0000-4000-8000-0000000000a2',
        }),
      ),
      /Invented broker failure/,
    );
    request.end();
    const [send] = spansOf(request, 'webhook');
    assert.equal(send.status, 'error');
    assert.deepEqual([send.error.code, send.error.message], ['InventedBrokerFailure', 'Invented broker failure']);
  });
});

describe('endpoint check and secret spans', () => {
  it('TriggerServiceEndpointCheck is an http-out span with the endpoint answer', async () => {
    const at = route();
    const ops = [];
    const store = new DataStore({ state: emptyState() });
    store.traces = createTraceStore({ settings: { level: 'full' } });
    installRegistration({
      store,
      recordHooks: { add() {} },
      registry: { register: (op) => ops.push(op) },
      principals: {},
      settings: {},
    });
    const check = ops.find((op) => op.name === 'TriggerServiceEndpointCheck');
    const request = store.traces.start({ kind: 'http', name: 'POST /invented/check' });
    const answer = await store.traces.run(request, () =>
      check.handle({
        target: {
          id: ENDPOINT,
          row: { serviceendpointid: ENDPOINT, contract: 8, url: `${receiver.origin}${at}/status/200` },
        },
        body: {},
        user: { systemuserid: 'x' },
      }),
    );
    request.end();
    assert.deepEqual(answer, { status: 204 });
    const [probe] = store.traces.tree(request.traceId).spans.filter((span) => span.kind === 'http-out');
    assert.equal(probe.module, 'webhooks');
    assert.equal(probe.operation, 'check');
    assert.equal(probe.parentSpanId, request.spanId);
    assert.equal(probe.attributes.status, 200);
    assert.equal(probe.input.body.MessageName, 'TriggerServiceEndpointCheck');
    assert.equal((await receiver.log(at))[0].headers['x-sim-parent-trace'], probe.spanId);
  });

  it('a secret span names the vault, secret and version and keeps the status only', async () => {
    const VARIABLE = 'PAQVILO_TRACE_WEBHOOKS_SECRET';
    const APP_ONE = 'eeeeeeee-0000-4000-8000-0000000000b1',
      APP_TWO = 'eeeeeeee-0000-4000-8000-0000000000b2';
    process.env[VARIABLE] = 'invented-secret-value-58ad';
    const traces = createTraceStore({ settings: { level: 'full' } });
    const resolver = createSecretResolver({
      secrets: { 'invented-vault/invented-key': { source: 'environment', variable: VARIABLE, allow: [APP_ONE] } },
      traces,
    });
    try {
      const answer = await resolver.resolve('https://invented-vault.vault.azure.net/secrets/invented-key', {
        principalId: APP_ONE,
        purpose: 'invented purpose',
      });
      assert.equal(answer.status, 'resolved');
      const denied = await resolver.resolve('https://invented-vault.vault.azure.net/secrets/invented-key', {
        principalId: APP_TWO,
      });
      assert.equal(denied.status, 'denied');
    } finally {
      delete process.env[VARIABLE];
    }
    const [resolved, refused] = traces.spans({ kind: 'secret', order: 'asc' }).items;
    for (const span of [resolved, refused]) {
      assert.equal(span.attributes.vault, 'invented-vault');
      assert.equal(span.attributes.secretName, 'invented-key');
      assert.equal(span.input ?? null, null, 'no input');
      assert.equal(span.output ?? null, null, 'no output');
    }
    assert.equal(resolved.status, 'ok');
    assert.equal(refused.status, 'denied');
    assert.equal(JSON.stringify(traces.export({})).includes('invented-secret-value-58ad'), false);
  });
});
