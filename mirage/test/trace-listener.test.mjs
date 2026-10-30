// Tracing of the Dataverse Web API listener (docs/design/tracing.md): the root keeps its request at full (query, headers,
// body) and names a handled or refused answer's error; built-in functions, registered functions and actions, and bulk
// messages open their own span named by the message; at level off the listener reads nothing for tracing. Invented schema.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createTraceStore } from '../lib/trace-store.mjs';
import { APP_ID, childrenOf, spanOf, startListener } from './support/trace-listener.mjs';

const API = '/api/data/v9.2/';
let listener;
before(async () => {
  listener = await startListener();
  listener.api.organization.registry.register({
    name: 'fx_Echo',
    kind: 'function',
    binding: 'unbound',
    csdl: '<Function Name="fx_Echo"><Parameter Name="Text" Type="Edm.String"/></Function>',
    handle: (ctx) => ({ status: 200, body: { Echoed: ctx.params.Text } }),
  });
});
after(() => listener?.close());

const rootOf = (tree) => tree.spans.find((span) => span.parentSpanId === null);

test('the listener root keeps its query, its answer-changing headers and its body at full, and names its caller', async () => {
  const created = await listener.request('POST', `${API}fx_widgets`, {
    body: { fx_name: 'Invented one' },
    headers: { prefer: 'return=representation' },
  });
  assert.equal(created.status, 201);
  const root = rootOf(await listener.tree(created.traceId));
  assert.deepEqual(root.input.body, { fx_name: 'Invented one' });
  assert.equal(root.input.headers.prefer, 'return=representation');
  assert.equal(root.attributes.contentType, 'application/json');
  assert.equal(root.attributes.contentLength, Buffer.byteLength(JSON.stringify({ fx_name: 'Invented one' })));
  assert.deepEqual([root.actor.kind, root.origin.host], ['app', 'dataverse-api']);
  assert.match(root.actor.id, /^[0-9a-f-]{36}$/);
  assert.equal(JSON.stringify(root).includes(listener.token), false, 'the bearer token never reaches a span');

  const read = await listener.request('GET', `${API}fx_widgets?$select=fx_name&$filter=fx_name eq 'Invented one'`);
  assert.equal(read.status, 200);
  const readRoot = rootOf(await listener.tree(read.traceId));
  assert.deepEqual(readRoot.input.query, { $select: 'fx_name', $filter: "fx_name eq 'Invented one'" });
  assert.equal(readRoot.input.body, undefined);
});

test('at level summary the listener root keeps the content type and length but no payload', async () => {
  listener.traces.configure({ level: 'summary' });
  try {
    const created = await listener.request('POST', `${API}fx_widgets`, { body: { fx_name: 'Summary one' } });
    assert.equal(created.status, 204);
    const root = rootOf(await listener.tree(created.traceId));
    assert.equal('input' in root, false);
    assert.equal(root.attributes.contentType, 'application/json');
    assert.equal(typeof root.attributes.contentLength, 'number');
  } finally {
    listener.traces.configure({ level: 'full' });
  }
});

test('a refused bearer names why on the denied root: no token, or the reason the token was refused', async () => {
  const missing = await listener.request('GET', `${API}WhoAmI`, { bearer: null });
  assert.equal(missing.status, 401);
  const root = rootOf(await listener.tree(missing.traceId));
  assert.equal(root.status, 'denied');
  assert.deepEqual([root.error.code, root.error.message], ['Unauthorized', 'The request carries no access token.']);
  const malformed = await listener.request('GET', `${API}WhoAmI`, { bearer: 'not-a-jwt' });
  assert.equal(malformed.status, 401);
  const refused = rootOf(await listener.tree(malformed.traceId));
  assert.deepEqual([refused.status, refused.error.message], ['denied', 'The access token was refused (malformed).']);
});

test('an error the listener answers itself (the Dataverse envelope) is the root error with its code and message', async () => {
  const answer = await listener.request('GET', `${API}fx_widgets`, { headers: { 'odata-version': '4.5' } });
  assert.equal(answer.status, 412);
  const root = rootOf(await listener.tree(answer.traceId));
  assert.equal(root.status, 'error');
  assert.equal(root.error.code, answer.json.error.code);
  assert.equal(root.error.message, answer.json.error.message);
  assert.equal(root.error.status, 412);
});

test('WhoAmI and RetrieveTotalRecordCount open a function span named by the message with its parameters and answer', async () => {
  const whoAmI = await listener.request('GET', `${API}WhoAmI`);
  assert.equal(whoAmI.status, 200);
  const tree = await listener.tree(whoAmI.traceId);
  const [fn] = childrenOf(tree, rootOf(tree));
  assert.deepEqual(
    [fn.kind, fn.name, fn.module, fn.operation, fn.status, fn.attributes.message, fn.attributes.statusCode],
    ['function', 'WhoAmI', 'dataverse', 'whoami', 'ok', 'WhoAmI', 200],
  );
  assert.equal(fn.output.UserId, whoAmI.json.UserId);
  assert.equal(fn.actor.kind, 'app', 'the function span runs as the caller');

  const counted = await listener.request('GET', `${API}RetrieveTotalRecordCount(EntityNames=['fx_widget'])`);
  assert.equal(counted.status, 200);
  const countTree = await listener.tree(counted.traceId);
  const count = spanOf(countTree, { kind: 'function', name: 'RetrieveTotalRecordCount' });
  assert.deepEqual(count.input.parameters, { EntityNames: ['fx_widget'] });
  assert.deepEqual(count.output.EntityRecordCountCollection.Keys, ['fx_widget']);
});

test('a registered function opens its span named by the operation; a failing one carries its error', async () => {
  const echoed = await listener.request('GET', `${API}fx_Echo(Text='invented')`);
  assert.equal(echoed.status, 200);
  const tree = await listener.tree(echoed.traceId);
  const fn = spanOf(tree, { kind: 'function', name: 'fx_Echo' });
  assert.equal(fn.parentSpanId, rootOf(tree).spanId);
  assert.deepEqual(
    [fn.input.parameters.Text, fn.output.Echoed, fn.attributes.binding],
    ['invented', 'invented', 'unbound'],
  );

  const unknown = await listener.request('GET', `${API}RetrieveTotalRecordCount(EntityNames=['fx_unknown'])`);
  assert.equal(unknown.status, 400);
  const failed = spanOf(await listener.tree(unknown.traceId), { kind: 'function' });
  assert.deepEqual([failed.status, failed.error.code], ['error', 'InvalidKey']);
});

test('CreateMultiple through the Web API opens one bulk span with the table and target count, no dispatch span', async () => {
  const answer = await listener.request('POST', `${API}fx_widgets/Microsoft.Dynamics.CRM.CreateMultiple`, {
    body: {
      Targets: [
        { '@odata.type': 'Microsoft.Dynamics.CRM.fx_widget', fx_name: 'Bulk one' },
        { '@odata.type': 'Microsoft.Dynamics.CRM.fx_widget', fx_name: 'Bulk two' },
      ],
    },
  });
  assert.equal(answer.status, 200, answer.text);
  const tree = await listener.tree(answer.traceId);
  const bulk = spanOf(tree, { kind: 'bulk' });
  assert.deepEqual(
    [bulk.name, bulk.module, bulk.operation, bulk.entity, bulk.status, bulk.parentSpanId],
    ['CreateMultiple fx_widget', 'dataverse', 'createmultiple', 'fx_widget', 'ok', rootOf(tree).spanId],
  );
  assert.deepEqual(
    [bulk.attributes.message, bulk.attributes.table, bulk.attributes.targets, bulk.attributes.action],
    ['CreateMultiple', 'fx_widget', 2, 'CreateMultiple'],
  );
  assert.deepEqual(bulk.output.ids, answer.json.Ids);
  assert.equal(
    tree.spans.some((span) => span.kind === 'dataverse' && span.operation === 'action'),
    false,
    'the bulk span replaces the generic action dispatch span',
  );
});

test('at level off the listener reads nothing from the trace store but its level', async () => {
  const off = createTraceStore({ settings: { level: 'off' } });
  const reads = [];
  const watched = new Proxy(off, {
    get(target, key) {
      reads.push(key);
      return Reflect.get(target, key);
    },
  });
  const quiet = await startListener({ level: 'off', traces: watched });
  try {
    reads.length = 0;
    const answer = await quiet.request('GET', `${API}WhoAmI`, {
      headers: { 'x-trace-id': '7a3c0000-0000-4000-8000-00000000c0de' },
    });
    assert.equal(answer.status, 200);
    assert.equal(answer.traceId, null);
    assert.deepEqual([...new Set(reads)], ['enabled'], 'no header parsing, span or current() lookup at level off');
  } finally {
    await quiet.close();
  }
});

test('the application caller is the actor of every span of a listener request', async () => {
  const answer = await listener.request('GET', `${API}fx_widgets?$select=fx_name`);
  const tree = await listener.tree(answer.traceId);
  const root = rootOf(tree);
  assert.deepEqual([root.attributes.actorKind, root.attributes.appId], ['app', APP_ID]);
  for (const span of tree.spans) assert.deepEqual([span.actor.kind, span.actor.id], ['app', root.actor.id], span.name);
});

test('a response the client closes before it completes ends the root with a ClientClosedRequest error (499)', async () => {
  // Gates: the operation signals when it runs and waits until the client has gone, so the close lands mid-response.
  let entered, release;
  const running = new Promise((resolve) => (entered = resolve));
  const held = new Promise((resolve) => (release = resolve));
  listener.api.organization.registry.register({
    name: 'fx_Hold',
    kind: 'function',
    binding: 'unbound',
    csdl: '<Function Name="fx_Hold"></Function>',
    handle: async () => {
      entered();
      await held;
      return { status: 200, body: { Held: true } };
    },
  });
  const ended = new Promise((resolve) => {
    const off = listener.traces.subscribe((event) => {
      if (event.type === 'span-end' && event.span.kind === 'http' && event.span.name.endsWith('/fx_Hold()')) {
        off();
        resolve(event.span);
      }
    });
  });
  const controller = new AbortController();
  const answer = fetch(`${listener.api.origin}${API}fx_Hold()`, {
    headers: { authorization: `Bearer ${listener.token}` },
    signal: controller.signal,
  }).catch((error) => error);
  await running;
  controller.abort();
  const root = await ended;
  release();
  assert.equal((await answer).name, 'AbortError');
  assert.deepEqual(
    [root.status, root.attributes.statusCode, root.error.code, root.error.message, root.error.status],
    ['error', 499, 'ClientClosedRequest', 'the client closed the connection before the response completed', 499],
  );
});
