// @test-kind contract: Paqvilo's connector runtime design: connection resolution, provider dispatch, pack providers and diagnostics
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  createConnectorRuntime,
  connectionSettings,
  CONNECTOR_PACK_EXPORTS,
  DEFAULT_CONNECTOR_TIMEOUT_MS,
} from '../lib/connector-runtime.mjs';
import { MAX_TIMER_DELAY } from '../lib/runtime-clock.mjs';
import { DataStore, emptyState } from '../lib/data.mjs';

const USER = '77777777-7777-4777-8777-777777777777';
const profile = {
  userId: USER,
  evidence: 'Invented connection owner',
  grants: [{ entity: 'x_item', operations: ['read'] }],
};
const store = (rows) => ({ state: { tables: { connectionreference: rows } } });
const references = {
  x_conn: { connection: { connectionReferenceLogicalName: 'x_widgetref' }, api: { name: 'x_widgets' } },
};

async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
const rejectsWith = (promise, code, status) =>
  assert.rejects(promise, (error) => error.code === code && error.status === status);
function throwsWith(fn, code, status) {
  assert.throws(fn, (error) => error.code === code && error.status === status);
}

test('resolution chain follows reference, row, project connection and named pack principal', () => {
  const pack = {
    id: 'x-pack',
    connectionPrincipals: { owner: profile },
    connectors: { x_widgets: { operations: { List: () => ({ statusCode: 200, body: {} }) } } },
  };
  const runtime = createConnectorRuntime({
    store: store([{ connectionreferencelogicalname: 'X_WidgetRef', connectionid: 'conn-1' }]),
    packs: [pack],
    connections: {
      'conn-1': { connector: 'x_widgets', provider: 'pack:x-pack', principal: { pack: 'x-pack', identity: 'owner' } },
    },
  });
  const resolved = runtime.resolve({
    apiId: '/providers/Microsoft.PowerApps/apis/x_widgets',
    connectionName: 'x_conn',
    connectionReferences: references,
  });
  assert.equal(resolved.connectorId, 'x_widgets');
  assert.equal(resolved.referenceLogicalName, 'x_widgetref');
  assert.equal(resolved.connectionId, 'conn-1');
  assert.equal(resolved.provider, 'pack:x-pack');
  assert.equal(resolved.principal, profile);
  assert.equal(resolved.bound, true);
  // A per-flow override (flowIdentities) wins over the connection principal.
  const override = { ...profile, userId: '88888888-8888-4888-8888-888888888888' };
  assert.equal(
    runtime.resolve({
      connectorId: 'x_widgets',
      connectionName: 'x_conn',
      connectionReferences: references,
      principal: override,
    }).principal,
    override,
  );
});

test('unbound references answer ConnectionNotBound; a Dataverse flow override still binds', () => {
  const unbound = createConnectorRuntime({
    store: store([{ connectionreferencelogicalname: 'x_widgetref', connectionid: null }]),
  });
  throwsWith(
    () => unbound.resolve({ connectorId: 'x_widgets', connectionName: 'x_conn', connectionReferences: references }),
    'ConnectionNotBound',
    409,
  );
  throwsWith(
    () => unbound.resolve({ connectorId: 'x_widgets', connectionName: 'missing', connectionReferences: references }),
    'ConnectionNotBound',
    409,
  );
  const noConnection = createConnectorRuntime({
    store: store([{ connectionreferencelogicalname: 'x_widgetref', connectionid: 'conn-9' }]),
  });
  throwsWith(
    () =>
      noConnection.resolve({ connectorId: 'x_widgets', connectionName: 'x_conn', connectionReferences: references }),
    'ConnectionNotBound',
    409,
  );
  const dataverse = unbound.resolve({
    connectorId: 'shared_commondataserviceforapps',
    connectionName: 'x_conn',
    connectionReferences: references,
    principal: profile,
  });
  assert.equal(dataverse.provider, 'dataverse');
  assert.equal(dataverse.bound, true);
  const missingPrincipal = createConnectorRuntime({
    store: store([{ connectionreferencelogicalname: 'x_widgetref', connectionid: 'conn-1' }]),
    connections: { 'conn-1': { connector: 'shared_commondataserviceforapps', principal: 'nobody' } },
  });
  throwsWith(
    () =>
      missingPrincipal.resolve({
        connectorId: 'shared_commondataserviceforapps',
        connectionName: 'x_conn',
        connectionReferences: references,
      }),
    'ConnectionUnauthorized',
    401,
  );
  assert.equal(createConnectorRuntime().resolve({ connectorId: 'shared_commondataserviceforapps' }).bound, false);
});

// @test-kind contract+security: diagnostics name the operation and never carry parameter values
test('provider dispatch passes the caller context and maps errors to documented codes without values in diagnostics', async () => {
  const notes = [],
    seen = [];
  const pack = {
    id: 'x-pack',
    connectionPrincipals: { owner: profile },
    connectors: {
      x_widgets: {
        operations: {
          List: (request, context) => {
            seen.push({ request, context });
            return { statusCode: 200, body: { value: [1] } };
          },
          Broken: () => {
            throw new TypeError('x-hidden-value');
          },
          Shapeless: () => ({ body: 'no status' }),
        },
      },
    },
  };
  const runtime = createConnectorRuntime({
    packs: [pack],
    diagnostic: (note) => notes.push(note),
    connections: { x_widgets: { provider: 'pack:x-pack', principal: 'owner' } },
  });
  const result = await runtime.invoke({
    connectorId: 'x_widgets',
    operationId: 'List',
    parameters: { filter: 'x-hidden-value' },
    context: { caller: 'flow', correlationId: 'corr-1', actionPath: 'list' },
  });
  assert.deepEqual(result, { statusCode: 200, body: { value: [1] } });
  assert.equal(seen[0].request.parameters.filter, 'x-hidden-value');
  assert.equal(seen[0].context.caller, 'flow');
  assert.equal(seen[0].context.principal, profile);
  assert.equal(seen[0].context.correlationId, 'corr-1');
  await rejectsWith(runtime.invoke({ connectorId: 'x_widgets', operationId: 'Broken' }), 'ProviderFailed', 502);
  await rejectsWith(runtime.invoke({ connectorId: 'x_widgets', operationId: 'Shapeless' }), 'ProviderFailed', 502);
  throwsWith(() => runtime.invoke({ connectorId: 'x_widgets', operationId: 'Missing' }), 'OperationUnsupported', 501);
  throwsWith(() => runtime.invoke({ connectorId: 'x_unknown', operationId: 'Any' }), 'ConnectorNotConfigured', 501);
  // The http provider serves only the http connector: a custom connector bound to it is unsupported here.
  const custom = createConnectorRuntime({ connections: { x_custom: { provider: 'http' } } });
  throwsWith(() => custom.invoke({ connectorId: 'x_custom', operationId: 'Call' }), 'OperationUnsupported', 501);
  const invokes = notes.filter((n) => n.code === 'CONNECTOR_INVOKE');
  assert.equal(invokes.length, 5);
  assert.deepEqual(Object.keys(invokes[0]).sort(), [
    'caller',
    'code',
    'connectionId',
    'connectorId',
    'correlationId',
    'durationMs',
    'entity',
    'message',
    'name',
    'operationId',
    'principalId',
    'provider',
    'reference',
    'status',
  ]);
  // The human facts (D-M-2 Findings) name the operation, never a parameter value.
  assert.equal(invokes[0].name, invokes[0].operationId);
  assert.equal(invokes[0].principalId, USER);
  assert.equal(invokes[1].error, 'ProviderFailed');
  assert.doesNotMatch(JSON.stringify(notes), /x-hidden-value/);
});

test('pagination follows nextLink only when asked and stops at maxPages with a truncation diagnostic', async () => {
  const notes = [];
  let calls = 0;
  const pack = {
    id: 'x-pack',
    connectors: {
      x_pages: {
        operations: {
          List: (request) => {
            calls++;
            const page = request.nextLink ? Number(request.nextLink.split('=')[1]) : 0;
            return { statusCode: 200, body: { value: [page] }, nextLink: `x-next?page=${page + 1}` };
          },
        },
      },
    },
  };
  const runtime = createConnectorRuntime({ packs: [pack], diagnostic: (note) => notes.push(note) });
  const single = await runtime.invoke({ connectorId: 'x_pages', operationId: 'List' });
  assert.deepEqual(single.body.value, [0]);
  assert.equal(calls, 1);
  const enough = await runtime.invoke({
    connectorId: 'x_pages',
    operationId: 'List',
    pagination: { minimumItemCount: 3 },
  });
  assert.deepEqual(enough.body.value, [0, 1, 2]);
  assert.equal(enough.nextLink, undefined);
  const bounded = await runtime.invoke({
    connectorId: 'x_pages',
    operationId: 'List',
    pagination: { minimumItemCount: 100 },
  });
  assert.equal(bounded.body.value.length, 10);
  assert.ok(bounded.nextLink);
  assert.equal(notes.filter((n) => n.code === 'CONNECTOR_PAGINATION_TRUNCATED').length, 1);
});

// @test-kind contract+security: the http provider reaches loopback services only and refuses redirects
test('http provider applies rewrites to loopback, refuses other hosts and refuses loopback redirects', async (t) => {
  const escaped = [];
  const other = await listen(t, (req, res) => {
    escaped.push(req.url);
    res.end('{}');
  });
  const hits = [];
  const local = await listen(t, (req, res) => {
    hits.push(req.url);
    if (req.url.startsWith('/api/moved')) {
      res.writeHead(307, { location: other + '/stolen' });
      return res.end();
    }
    if (req.url === '/api/local-moved') {
      res.writeHead(302, { location: '/api/echo' });
      return res.end();
    }
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ path: req.url, method: req.method, received: JSON.parse(body || 'null') }));
    });
  });
  const runtime = createConnectorRuntime({
    connections: {
      http: {
        connector: 'http',
        provider: 'http',
        settings: { rewrites: { 'https://func.example.test/api/': local + '/api/' } },
      },
    },
  });
  const answer = await runtime.invoke({
    connectorId: 'http',
    operationId: 'Http',
    parameters: { method: 'POST', uri: 'https://func.example.test/api/echo', queries: { q: '1' }, body: { x: 1 } },
  });
  assert.equal(answer.statusCode, 200);
  assert.deepEqual(answer.body, { path: '/api/echo?q=1', method: 'POST', received: { x: 1 } });
  await rejectsWith(
    runtime.invoke({
      connectorId: 'http',
      operationId: 'Http',
      parameters: { uri: 'https://elsewhere.example.test/api' },
    }),
    'ProviderUnavailable',
    503,
  );
  await rejectsWith(
    runtime.invoke({
      connectorId: 'http',
      operationId: 'Http',
      parameters: { uri: 'https://func.example.test/api/moved' },
    }),
    'ProviderFailed',
    502,
  );
  await rejectsWith(
    runtime.invoke({
      connectorId: 'http',
      operationId: 'Http',
      parameters: { uri: 'https://func.example.test/api/local-moved' },
    }),
    'ProviderFailed',
    502,
  );
  assert.deepEqual(escaped, []);
  assert.deepEqual(hits, ['/api/echo?q=1', '/api/moved', '/api/local-moved'], 'neither redirect is followed');
});

test('a loopback call that the caller cancels after the request reached the service rejects with the cancellation, not a timeout', async (t) => {
  let arrive;
  const arrived = new Promise((resolve) => {
    arrive = resolve;
  });
  const local = await listen(t, () => arrive());
  const runtime = createConnectorRuntime({});
  const run = new AbortController();
  const call = runtime.invoke({
    connectorId: 'http',
    operationId: 'Http',
    parameters: { method: 'GET', uri: local + '/api/slow' },
    context: { signal: run.signal },
  });
  await arrived;
  run.abort();
  await assert.rejects(call, (error) => error.code === 'FlowRunCancelled' && error.status === 409);
});

// The mocked clock fires a deadline only on tick(), so a budget that is not clamped or defaulted cannot end a call before the
// test ticks: the test ticks 1 ms (what a 1 ms budget would need) once the request has reached the server, and releases the
// answer after that tick. A regression that arms a 1 ms deadline fails here deterministically.
test('a loopback call with a budget above the timer limit or a non-finite budget is not aborted by a 1 ms deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let requests = 0,
    current = null;
  const local = await listen(t, async (req, res) => {
    requests++;
    current.arrive();
    await current.gate;
    res.setHeader('content-type', 'application/json');
    res.setHeader('connection', 'close');
    res.end('{}');
  });
  const runtime = createConnectorRuntime({
    connections: {
      http: {
        connector: 'http',
        provider: 'http',
        settings: { rewrites: { 'https://func.example.test/api/': local + '/api/' } },
      },
    },
  });
  const callTickedInFlight = async (timeoutMs) => {
    let arrive, release;
    const arrived = new Promise((resolve) => (arrive = resolve));
    const gate = new Promise((resolve) => (release = resolve));
    current = { arrive, gate };
    const call = runtime
      .invoke({
        connectorId: 'http',
        operationId: 'Http',
        parameters: { method: 'GET', uri: 'https://func.example.test/api/echo' },
        context: { timeoutMs },
      })
      .then(
        (answer) => ({ answer }),
        (error) => ({ error }),
      );
    await arrived;
    t.mock.timers.tick(1);
    release();
    return call;
  };
  const clamped = await callTickedInFlight(3e9);
  assert.equal(requests, 1, 'the request reached the server before the tick');
  assert.equal(clamped.error, undefined, 'a 3e9 budget is not aborted by a 1 ms deadline');
  assert.equal(clamped.answer.statusCode, 200);
  const defaulted = await callTickedInFlight(Number.NaN);
  assert.equal(requests, 2);
  assert.equal(defaulted.error, undefined, 'a non-finite budget is not aborted by a 1 ms deadline');
  assert.equal(defaulted.answer.statusCode, 200);
});

// An asynchronous (202 with Location) operation polls under a finite budget: a non-finite one takes the default, and a budget
// above the timer limit is clamped to it. The poll is held until the test has read the budget it was given.
test('an asynchronous operation polls under a finite budget for a non-finite or an oversized timeoutMs', async (t) => {
  let current = null;
  const budgets = [];
  const provider = {
    id: 'x-async',
    connectors: ['x_async'],
    operations: ['Go'],
    capability: {},
    async invoke() {
      return { statusCode: 202, headers: { location: 'https://x-async.example.test/status/1', 'retry-after': '0' } };
    },
    async poll(url, request, ctx) {
      budgets.push(ctx.timeoutMs);
      current.arrive();
      await current.gate;
      return { statusCode: 200, body: {} };
    },
  };
  const runtime = createConnectorRuntime({ providers: [provider] });
  const polledUnder = async (timeoutMs) => {
    let arrive, release;
    const arrived = new Promise((resolve) => (arrive = resolve));
    const gate = new Promise((resolve) => (release = resolve));
    current = { arrive, gate };
    t.after(() => release());
    const call = runtime.invoke({ connectorId: 'x_async', operationId: 'Go', context: { timeoutMs } });
    await arrived;
    const budget = budgets.at(-1);
    release();
    await call;
    return budget;
  };
  const defaulted = await polledUnder(Number.NaN);
  assert.ok(Number.isFinite(defaulted), `a non-finite budget polls under a finite budget, got ${defaulted}`);
  assert.ok(defaulted > 0 && defaulted <= DEFAULT_CONNECTOR_TIMEOUT_MS, `default budget ${defaulted}`);
  const clamped = await polledUnder(3e9);
  assert.ok(clamped <= MAX_TIMER_DELAY, `an oversized budget is clamped to the timer limit, got ${clamped}`);
});

// A budget longer than the timer limit: the deadline is armed in steps of at most MAX_TIMER_DELAY.
const OVERSIZED_BUDGET = MAX_TIMER_DELAY + 5000;
// Records the delays, armed handles and cleared handles of the timers a test uses (the mocked timers are enabled first).
function recordTimers(t) {
  const timers = { delays: [], armed: [], cleared: [] };
  const { setTimeout: schedule, clearTimeout: cancel } = globalThis;
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...rest) => {
    timers.delays.push(delay);
    const handle = schedule(callback, delay, ...rest);
    timers.armed.push(handle);
    return handle;
  });
  t.mock.method(globalThis, 'clearTimeout', (handle) => {
    timers.cleared.push(handle);
    return cancel(handle);
  });
  return timers;
}
// A loopback fetch that stays pending until the test answers it or its signal aborts; arrived resolves when it is called.
function holdLoopbackFetch(t) {
  const held = {};
  let arrive;
  held.arrived = new Promise((resolve) => (arrive = resolve));
  t.mock.method(
    globalThis,
    'fetch',
    (url, init) =>
      new Promise((resolve, reject) => {
        held.answer = () =>
          resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        arrive();
      }),
  );
  return held;
}
const loopbackCall = (runtime, timeoutMs) =>
  runtime.invoke({
    connectorId: 'http',
    operationId: 'Http',
    parameters: { method: 'GET', uri: 'http://127.0.0.1:9/item' },
    context: { timeoutMs },
  });

test('a loopback call with a budget above the timer limit times out only after the whole budget', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const timers = recordTimers(t);
  const held = holdLoopbackFetch(t);
  const call = loopbackCall(createConnectorRuntime({}), OVERSIZED_BUDGET).then(
    () => 'answered',
    (error) => error.code,
  );
  await held.arrived;
  assert.deepEqual(timers.delays, [MAX_TIMER_DELAY], 'the first step of the deadline is the timer limit');
  t.mock.timers.tick(MAX_TIMER_DELAY);
  await new Promise((resolve) => setImmediate(resolve));
  const settled = await Promise.race([call, 'still pending']);
  assert.equal(settled, 'still pending', 'the call is not cut at the timer limit');
  assert.deepEqual(timers.delays, [MAX_TIMER_DELAY, 5000], 'the remainder of the budget is armed under the limit');
  t.mock.timers.tick(5000);
  assert.equal(await call, 'ProviderTimeout');
});

test('answering a loopback call with a budget above the timer limit clears the re-armed deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const timers = recordTimers(t);
  const held = holdLoopbackFetch(t);
  const call = loopbackCall(createConnectorRuntime({}), OVERSIZED_BUDGET);
  await held.arrived;
  t.mock.timers.tick(MAX_TIMER_DELAY);
  assert.equal(timers.armed.length, 2, 'the first step fired and armed the remainder');
  held.answer();
  assert.equal((await call).statusCode, 200);
  assert.ok(timers.cleared.includes(timers.armed.at(-1)), 'the pending remainder is cleared when the call answers');
});

// @test-kind security: a name that is an Object.prototype member is not found, as an unknown name is, and never resolves to a function
test('connector, operation, connection and trigger names that are Object.prototype members are not found', async () => {
  const store = await new DataStore({ state: { ...emptyState(), simulator: { connectionTokens: {} } } }).init();
  const pack = {
    id: 'x-pack',
    connectors: { x_widgets: { operations: { List: () => ({ statusCode: 200, body: {} }) } } },
  };
  const runtime = createConnectorRuntime({ store, packs: [pack] });
  // The error code and status of an attempt, or 'answered' when it succeeds.
  const attempt = (fn) =>
    Promise.resolve()
      .then(fn)
      .then(
        () => 'answered',
        (error) => `${error.code}/${error.status}`,
      );
  const unknown = {
    connector: await attempt(() => runtime.invoke({ connectorId: 'x_unknown', operationId: 'List' })),
    operation: await attempt(() => runtime.invoke({ connectorId: 'x_widgets', operationId: 'x_unknown' })),
    authorize: await attempt(() => runtime.oauth.authorize('x_unknown')),
    bound: await attempt(() => runtime.resolve({ connectorId: 'x_widgets', connectionId: 'x_unknown' })),
  };
  for (const name of ['constructor', '__proto__', 'toString']) {
    assert.equal(
      await attempt(() => runtime.invoke({ connectorId: name, operationId: 'List' })),
      unknown.connector,
      name,
    );
    assert.equal(
      await attempt(() => runtime.invoke({ connectorId: 'x_widgets', operationId: name })),
      unknown.operation,
    );
    assert.equal(await attempt(() => runtime.oauth.authorize(name)), unknown.authorize, name);
    assert.equal(await attempt(() => runtime.resolve({ connectorId: 'x_widgets', connectionId: name })), unknown.bound);
    // An operation named like an Object member, on a connector named like one: both answer null, not a function.
    assert.equal(runtime.flowTriggers(name, 'toString'), null, name);
    assert.equal(runtime.flowTriggers(name, name), null, name);
    assert.equal(runtime.flowTriggers('x_widgets', name), null, name);
    assert.equal(runtime.oauth.status(name).signedIn, false, name);
  }
});

// @test-kind security: a Dataverse column named __proto__ is refused as an invalid name and sets no prototype
test('a Dataverse column named __proto__ is refused as an invalid name, as constructor is, and sets no prototype', async () => {
  const profile = {
    userId: '77777777-7777-4777-8777-000000000100',
    evidence: 'Invented flow owner',
    grants: [{ entity: 'x_parent', operations: ['create', 'read'] }],
  };
  const store = await new DataStore({
    state: {
      version: 1,
      mappings: {
        x_parent: { entitySet: 'x_parents', idColumn: 'x_parentid', fields: { x_name: { type: 'string' } } },
      },
      tables: { x_parent: [] },
      permissions: [],
      plugins: [],
      settings: { permissionMode: 'enforce' },
    },
  }).init();
  const runtime = createConnectorRuntime({ store });
  const createWith = async (column) => {
    try {
      const answer = await runtime.invoke({
        connectorId: 'shared_commondataserviceforapps',
        operationId: 'CreateRecord',
        parameters: { entityName: 'x_parents', 'item/x_name': 'row', [`item/${column}`]: 'invented' },
        context: { principal: profile },
      });
      return {
        statusCode: answer.statusCode,
        ownColumn: Object.hasOwn(answer.body, column),
        prototypeIntact: Object.getPrototypeOf(answer.body) === Object.prototype,
      };
    } catch (error) {
      return { error: `${error.code}/${error.status}` };
    }
  };
  const refused = { error: 'InvalidRequest/400' };
  assert.deepEqual(await createWith('constructor'), refused);
  assert.deepEqual(await createWith('__proto__'), refused);
  assert.deepEqual(store.snapshot().tables.x_parent, [], 'a refused column writes no row');
  assert.equal({}.invented, undefined);
});

test('fixture provider answers deterministically from pack httpFixtures without network', async () => {
  const pack = {
    id: 'x-pack',
    httpFixtures: [
      {
        id: 'echo',
        method: 'GET',
        url: /^https:\/\/api\.example\.test\/items\/(\d+)$/,
        respond: (req) => ({ status: 200, body: { url: req.url } }),
      },
    ],
  };
  const runtime = createConnectorRuntime({ packs: [pack], connections: { http: { provider: 'fixture' } } });
  const call = () =>
    runtime.invoke({
      connectorId: 'http',
      operationId: 'Http',
      parameters: { method: 'GET', uri: 'https://api.example.test/items/7' },
    });
  assert.deepEqual(await call(), await call());
  assert.deepEqual((await call()).body, { url: 'https://api.example.test/items/7' });
  await rejectsWith(
    runtime.invoke({
      connectorId: 'http',
      operationId: 'Http',
      parameters: { method: 'POST', uri: 'https://api.example.test/items/7' },
    }),
    'ConnectorNotConfigured',
    501,
  );
});

test('approvals and memory-queue providers support their documented operations and describe native parity at contract level', async () => {
  const runtime = createConnectorRuntime();
  assert.equal(runtime.supports('shared_approvals', 'StartAndWaitForAnApproval'), true);
  assert.equal(runtime.supports('shared_servicebus', 'SendMessage'), true);
  assert.equal(runtime.supports('shared_servicebus', 'SendMessageToTopic'), false);
  assert.equal(runtime.supports('shared_commondataserviceforapps', 'CreateRecord'), true);
  // Without a flow run that can suspend, a waiting action never reports success; without a bus the queue is unavailable.
  await rejectsWith(
    runtime.invoke({
      connectorId: 'shared_approvals',
      operationId: 'WaitForAnApproval',
      parameters: { approvalName: 'x' },
    }),
    'ProviderUnavailable',
    503,
  );
  await rejectsWith(
    runtime.invoke({
      connectorId: 'shared_servicebus',
      operationId: 'SendMessage',
      parameters: { entityName: 'x_queue' },
    }),
    'ProviderUnavailable',
    503,
  );
  const records = runtime.describe();
  for (const name of ['dataverse', 'http', 'fixture', 'memory-queue', 'approvals']) {
    const record = records.find((r) => r.name === name);
    assert.ok(record, name);
    assert.deepEqual(Object.keys(record).sort(), [
      'kind',
      'level',
      'lifecycle',
      'name',
      'operations',
      'principal',
      'requires',
      'stateOwner',
      'version',
    ]);
    assert.equal(record.kind, 'provider');
    assert.equal(record.level, 'behaviour');
  }
  for (const name of ['memory-queue', 'approvals'])
    assert.ok(
      records.find((r) => r.name === name).operations.some((op) => op.level === 'contract'),
      name,
    );
});

// @test-kind contract+security: connection settings and connector pack exports never hold credentials
test('connection settings and connector pack exports reject credentials and malformed entries', () => {
  const valid = {
    'conn-1': {
      connector: 'x_widgets',
      provider: 'http',
      principal: { pack: 'x-pack', identity: 'owner' },
      evidence: 'Invented',
      settings: { rewrites: { 'https://func.example.test/api/': 'http://localhost:7071/api/' } },
    },
  };
  assert.deepEqual(connectionSettings(valid), valid);
  assert.deepEqual(connectionSettings(undefined), {});
  assert.throws(() => connectionSettings({ c: { settings: { apiKey: 'literal' } } }), /settings\.apiKey/);
  assert.throws(() => connectionSettings({ c: { principal: { identity: 'owner', token: 'literal' } } }), /principal/);
  assert.throws(() => connectionSettings({ c: { password: 'literal' } }), /not a connection setting/);
  assert.throws(
    () =>
      connectionSettings({
        c: { settings: { rewrites: { 'https://func.example.test/api/?code=literal': 'http://localhost:7071/api/' } } },
      }),
    /without credentials/,
  );
  assert.throws(
    () =>
      connectionSettings({
        c: { settings: { rewrites: { 'https://func.example.test/': 'http://user:pass@localhost:7071/' } } },
      }),
    /without credentials/,
  );
  assert.throws(() => connectionSettings({ c: { provider: 'cloud' } }), /provider/);
  assert.throws(() => connectionSettings([]), /must map/);
  CONNECTOR_PACK_EXPORTS.connectors.check({ x_widgets: { operations: { List() {} } } }, 'x-pack');
  assert.throws(
    () => CONNECTOR_PACK_EXPORTS.connectors.check({ http: { operations: { List() {} } } }, 'x-pack'),
    /x-pack/,
  );
  assert.throws(
    () => CONNECTOR_PACK_EXPORTS.connectors.check({ x_widgets: { operations: { List: 1 } } }, 'x-pack'),
    /function/,
  );
  CONNECTOR_PACK_EXPORTS.httpFixtures.check([{ id: 'a', method: 'GET', url: /x/, respond() {} }], 'x-pack');
  assert.throws(
    () => CONNECTOR_PACK_EXPORTS.httpFixtures.check([{ id: 'a', method: 'GET', url: /x/g, respond() {} }], 'x-pack'),
    /RegExp/,
  );
  assert.throws(
    () =>
      CONNECTOR_PACK_EXPORTS.httpFixtures.check(
        [
          { id: 'a', method: 'GET', url: /x/, respond() {} },
          { id: 'a', method: 'GET', url: /y/, respond() {} },
        ],
        'x-pack',
      ),
    /unique/,
  );
  CONNECTOR_PACK_EXPORTS.connectionPrincipals.check({ owner: profile }, 'x-pack');
  assert.throws(() => CONNECTOR_PACK_EXPORTS.connectionPrincipals.check({ owner: { userId: 'x' } }, 'x-pack'), /owner/);
});
