// The HTTP Request trigger's signed callback URL (per-flow HMAC key sealed in state, method restriction, body schema,
// 401 on a bad signature) and "When an action is performed" matching by catalog and category assignment.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createScheduler, fixedClock, sequentialIds, storeScheduler } from '../lib/runtime-clock.mjs';
import { createConnectorRuntime } from '../lib/connector-runtime.mjs';
import { createHostFlowRuns } from '../lib/flow-runs.mjs';
import { createFlowTriggerRunner } from '../lib/flow-triggers.mjs';
import { operationCatalogue } from '../lib/operation-catalogue.mjs';
import { createFlowRoutes } from '../lib/sim-flow-routes.mjs';

const HTTP_FLOW = '77777777-7777-4777-8777-0000000000b4',
  PERFORMED = '77777777-7777-4777-8777-0000000000b5',
  CSRF = 'invented-csrf';
const wrap = (definition) => ({
  file: '/invented/flow.json',
  active: true,
  definition: { properties: { definition } },
});
const HTTP_DEFINITION = {
  triggers: {
    request: {
      type: 'Request',
      kind: 'Http',
      inputs: {
        method: 'POST',
        schema: { type: 'object', required: ['x_name'], properties: { x_name: { type: 'string' } } },
      },
    },
  },
  actions: {
    Reply: {
      type: 'Response',
      runAfter: {},
      inputs: { statusCode: 200, body: { hello: "@triggerBody()?['x_name']" } },
    },
  },
};
const performed = {
  triggers: {
    performed: {
      type: 'OpenApiConnectionWebhook',
      inputs: {
        host: {
          apiId: '/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps',
          operationId: 'BusinessEventsTrigger',
        },
        parameters: { catalog: 'x_invented', category: 'x_events', entityname: 'none', sdkmessagename: 'x_Notify' },
      },
    },
  },
  actions: { Note: { type: 'Compose', runAfter: {}, inputs: 'fired' } },
};

async function host(t, { httpDefinition = HTTP_DEFINITION } = {}) {
  const clock = fixedClock(),
    notes = [];
  const store = await new DataStore({ state: emptyState(), clock, ids: sequentialIds() }).init();
  const scheduler = createScheduler({ clock, manual: true });
  storeScheduler(store, scheduler);
  t.after(() => scheduler.close());
  const connectors = createConnectorRuntime({ store, scheduler, clock });
  const workflows = new Map([
      [HTTP_FLOW, wrap(httpDefinition)],
      [PERFORMED, wrap(performed)],
    ]),
    identities = new Map();
  const overrides = {
    ['cloud-flow:' + HTTP_FLOW]: { mode: 'exported' },
    ['cloud-flow:' + PERFORMED]: { mode: 'exported', activation: 'local-enabled' },
  };
  const items = () =>
    operationCatalogue({ portal: {}, workflows, handlers: { flowIdentities: identities }, overrides, connectors });
  const cloudFlow = (id) => {
    const item = items().find((i) => i.processId === id);
    return workflows.has(id)
      ? {
          definition: workflows.get(id).definition.properties.definition,
          mode: item?.mode ?? 'placeholder',
          connectors,
        }
      : null;
  };
  const runs = createHostFlowRuns({ store, clock, scheduler, flowOf: cloudFlow });
  const api = { store, providers: { connectors } };
  runs.attach(api);
  t.after(() => runs.close());
  const runner = createFlowTriggerRunner({
    store,
    items,
    workflows: () => workflows,
    identities: () => identities,
    connectors,
    diagnostic: (n) => notes.push(n),
  });
  t.after(() => runner.close());
  const routes = createFlowRoutes({ api, csrf: () => CSRF });
  const server = http.createServer(async (req, res) => {
    if (!(await routes(req, res, new URL(req.url, 'http://' + req.headers.host)))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, headers = {}) => {
    const response = await fetch(new URL(url, origin), {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  return { store, runs, runner, notes, call, scheduler, origin, routes };
}

test('callback and on-demand HTTP inputs and responses preserve exact numeric tokens', async (t) => {
  const httpDefinition = structuredClone(HTTP_DEFINITION);
  httpDefinition.triggers.request.inputs.schema = {
    type: 'object',
    required: ['x_count', 'x_fraction'],
    properties: { x_count: { type: 'integer' }, x_fraction: { type: 'number' } },
  };
  httpDefinition.actions.Reply.inputs.body = {
    count: "@triggerBody()?['x_count']",
    text: "@string(triggerBody()?['x_count'])",
    fraction: "@triggerBody()?['x_fraction']",
    next: "@add(triggerBody()?['x_count'], 1)",
  };
  const { call, origin } = await host(t, { httpDefinition });
  const issued = await call('POST', `/_sim/api/flow-triggers/${HTTP_FLOW}/callback-url`, undefined, {
    'x-sim-csrf': CSRF,
  });
  const input = '{"x_count":9007199254740993,"x_fraction":0.1000000000000000000000000001}';
  const expected =
    '{"count":9007199254740993,"text":"9007199254740993","fraction":0.1000000000000000000000000001,"next":9007199254740994}';
  for (const [path, payload, status] of [
    [issued.body.url, input, 200],
    [`${origin}/_sim/api/flow-runs`, `{"processId":"${HTTP_FLOW}","input":${input}}`, 201],
  ]) {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sim-csrf': CSRF },
      body: payload,
    });
    assert.equal(response.status, status);
    const text = await response.text();
    assert.ok(text.includes(expected), 'exact input digits and response tokens survive the actual route');
    assert.ok(!text.includes('DataverseNumeric'), 'internal numeric records never escape in public JSON');
  }
});

test('exact numeric JSON scalars cannot masquerade as callback bodies or manual trigger input objects', async (t) => {
  for (const schema of [undefined, {}])
    await t.test(schema ? 'empty schema' : 'absent schema', async (inner) => {
      const httpDefinition = structuredClone(HTTP_DEFINITION);
      if (schema) httpDefinition.triggers.request.inputs.schema = schema;
      else delete httpDefinition.triggers.request.inputs.schema;
      const { call, runs, origin } = await host(inner, { httpDefinition });
      const issued = await call('POST', `/_sim/api/flow-triggers/${HTTP_FLOW}/callback-url`, undefined, {
        'x-sim-csrf': CSRF,
      });
      for (const number of ['1', '9007199254740993', '0.1000000000000000000000000001']) {
        for (const [path, body] of [
          [issued.body.url, number],
          [`${origin}/_sim/api/flow-runs`, `{"processId":"${HTTP_FLOW}","input":${number}}`],
        ]) {
          const response = await fetch(path, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-sim-csrf': CSRF },
            body,
          });
          assert.equal(response.status, 400);
          assert.equal((await response.json()).error.code, 'InvalidRequest');
        }
      }
      assert.equal(runs.list().length, 0);
    });
});

test('flow request chunks preserve split UTF-8 characters and enforce the limit on received bytes', async (t) => {
  const { call, routes, runs, origin } = await host(t);
  const issued = await call('POST', `/_sim/api/flow-triggers/${HTTP_FLOW}/callback-url`, undefined, {
    'x-sim-csrf': CSRF,
  });
  const request = async (chunks) => {
    const req = Object.assign(Readable.from(chunks), { method: 'POST', headers: { host: new URL(origin).host } });
    let status, text;
    await routes(
      req,
      {
        writeHead(code) {
          status = code;
        },
        end(value) {
          text = value;
        },
      },
      new URL(issued.body.url),
    );
    return { status, body: JSON.parse(text) };
  };
  const name = 'caf\u00e9 \u{1f680}',
    bytes = Buffer.from(JSON.stringify({ x_name: name })),
    splitAccent = bytes.indexOf(Buffer.from('\u00e9')) + 1,
    splitEmoji = bytes.indexOf(Buffer.from('\u{1f680}')) + 2;
  assert.deepEqual(
    await request([
      bytes.subarray(0, splitAccent),
      bytes.subarray(splitAccent, splitEmoji),
      bytes.subarray(splitEmoji),
    ]),
    { status: 200, body: { hello: name } },
  );
  const oversized = JSON.stringify({ x_name: '\u6f22'.repeat(22000) });
  assert.ok(oversized.length < 64 * 1024 && Buffer.byteLength(oversized) > 64 * 1024);
  const rejected = await request([Buffer.from(oversized)]);
  assert.equal(rejected.status, 413);
  assert.equal(rejected.body.error.code, 'PayloadTooLarge');
  assert.equal(runs.list().length, 1, 'the refused body starts no second flow run');
});

test('the signed callback URL runs the flow; a bad signature, another method or a body outside the schema is refused', async (t) => {
  const { store, runs, call } = await host(t);
  assert.equal(
    (await call('POST', `/_sim/api/flow-triggers/${HTTP_FLOW}/callback-url`)).status,
    403,
    'issuing the URL needs the simulator CSRF token',
  );
  const issued = await call('POST', `/_sim/api/flow-triggers/${HTTP_FLOW}/callback-url`, undefined, {
    'x-sim-csrf': CSRF,
  });
  assert.equal(issued.status, 200);
  assert.equal(issued.body.method, 'POST');
  const url = new URL(issued.body.url);
  assert.deepEqual(
    [url.pathname, url.searchParams.get('api-version'), url.searchParams.get('sp'), url.searchParams.get('sv')],
    [
      `/_sim/api/flow-triggers/${HTTP_FLOW}/triggers/request/paths/invoke`,
      '2016-06-01',
      '/triggers/request/run',
      '1.0',
    ],
  );
  // The per-flow key is sealed in state; the signature is not readable from it.
  const sealed = store.state.simulator.flowCallbackKeys[HTTP_FLOW];
  assert.equal(sealed.alg, 'A256GCM');
  assert.ok(!JSON.stringify(store.state).includes(url.searchParams.get('sig')));

  assert.deepEqual(
    await call('POST', url.href, { x_name: 'invented' }),
    { status: 200, body: { hello: 'invented' } },
    'no CSRF token: the signature authorises it',
  );
  const tampered = new URL(url);
  tampered.searchParams.set(
    'sig',
    url.searchParams.get('sig').replace(/^./, (c) => (c === 'A' ? 'B' : 'A')),
  );
  assert.equal((await call('POST', tampered.href, { x_name: 'invented' })).status, 401);
  const unsigned = new URL(url);
  unsigned.searchParams.delete('sig');
  assert.equal((await call('POST', unsigned.href, { x_name: 'invented' })).status, 401);
  assert.equal((await call('PUT', url.href, { x_name: 'invented' })).status, 405);
  const before = runs.list({ processId: HTTP_FLOW }).length;
  const invalid = await call('POST', url.href, { x_other: 1 });
  assert.deepEqual([invalid.status, invalid.body.error.code], [400, 'InvalidRequest']);
  assert.equal(runs.list({ processId: HTTP_FLOW }).length, before, 'a body outside the schema starts no run');
  // The same URL keeps working (the key is created once).
  assert.equal(
    (await call('POST', `/_sim/api/flow-triggers/${HTTP_FLOW}/callback-url`, undefined, { 'x-sim-csrf': CSRF })).body
      .url,
    issued.body.url,
  );
});

test('an action trigger fires only for an action assigned to its catalog and category', async (t) => {
  const { store, runs, runner, notes, scheduler } = await host(t);
  await runner.syncTriggers();
  const perform = () =>
    store.transact(() =>
      store.recordCommittedEvent('', 'action', {}, [], { message: 'x_Notify', table: null, inputs: {}, outputs: {} }),
    );
  // The committed action event stages a job; the manual scheduler's runDue() runs it and returns once its run settled.
  const settle = () => scheduler.runDue();
  const ROOT = '77777777-7777-4777-8777-00000000c001',
    EVENTS = '77777777-7777-4777-8777-00000000c002',
    OTHER = '77777777-7777-4777-8777-00000000c003',
    API = '77777777-7777-4777-8777-00000000c004';
  await store.transact(() => {
    store.state.tables.catalog = [
      { catalogid: ROOT, uniquename: 'x_invented', name: 'Invented' },
      { catalogid: EVENTS, uniquename: 'x_events', name: 'Events', parentcatalogid: ROOT },
      { catalogid: OTHER, uniquename: 'x_other', name: 'Other', parentcatalogid: ROOT },
    ];
    store.state.tables.customapi = [{ customapiid: API, uniquename: 'x_Notify', name: 'x_Notify' }];
    store.state.tables.catalogassignment = [
      {
        catalogassignmentid: '77777777-7777-4777-8777-00000000c005',
        catalogid: OTHER,
        object: API,
        name: 'Notify elsewhere',
      },
    ];
  });
  await perform();
  await settle();
  assert.equal(runs.list({ processId: PERFORMED }).length, 0, 'assigned to another category: no run');
  assert.ok(notes.some((n) => n.code === 'FLOW_TRIGGER_NOT_CATALOGED'));
  await store.transact(() => {
    store.state.tables.catalogassignment.push({
      catalogassignmentid: '77777777-7777-4777-8777-00000000c006',
      catalogid: EVENTS,
      object: API,
      name: 'Notify',
    });
  });
  await perform();
  await settle();
  assert.deepEqual(
    runs.list({ processId: PERFORMED }).map((r) => r.status),
    ['Succeeded'],
  );
});
