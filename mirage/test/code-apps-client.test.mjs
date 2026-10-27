import test from 'node:test';
import assert from 'node:assert/strict';
import { configure, dataClient, getStatus } from '../lib/code-apps-client.js';

test('debug events omit payloads and query values, preserve failures and isolate per-load sessions', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const events = [],
    requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    if (url.endsWith('/status')) return new Response('{}');
    if (url.endsWith('/context')) return new Response('{}', { headers: { 'x-sim-csrf': 'private-token' } });
    if (init.method === 'PATCH') return new Response('{"error":{"message":"private-message"}}', { status: 403 });
    return new Response('{"value":[]}');
  };
  configure({ app: 'first', onEvent: (event) => events.push(event) });
  await getStatus();
  assert.equal(requests.length, 1, 'public diagnostics do not require a context request');
  await dataClient.getAll('x_items', { filter: "x_name eq 'private-filter'" });
  await assert.rejects(dataClient.update('x_items', 'private-record', { x_name: 'private-body' }), /private-message/);
  assert.equal(events.at(-1).kind, 'request-error');
  assert.equal(events.at(-1).status, 403);
  assert.equal(events.at(-1).path, '/_apps/code/first/dataverse/x_items(...)');
  assert.doesNotMatch(JSON.stringify(events), /private-/);
  const session = requests[0].init.headers['x-paqvilo-code-app-session'];
  assert.ok(requests.every((r) => r.init.headers['x-paqvilo-code-app-session'] === session));
  configure({
    app: 'second',
    onEvent: () => {
      throw new Error('observer failure');
    },
  });
  await getStatus();
  assert.notEqual(requests.at(-1).init.headers['x-paqvilo-code-app-session'], session);
});

test('client sends context token and documented query options with paging', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/context')) return new Response('{}', { headers: { 'x-sim-csrf': 'local-token' } });
    return new Response(
      JSON.stringify({ value: [{ name: 'A' }], '@odata.count': 3, '@odata.nextLink': '/_api/items?$skiptoken=next' }),
    );
  };
  configure({ app: 'sample' });
  const result = await dataClient.getAll('items', {
    select: ['name'],
    filter: "name eq 'A'",
    orderBy: ['name desc'],
    top: 2,
    maxPageSize: 1,
    count: true,
  });
  assert.deepEqual(result, { data: [{ name: 'A' }], count: 3, skipToken: 'next' });
  const params = new URL(calls[1].url, 'http://localhost').searchParams;
  assert.equal(params.get('$filter'), "name eq 'A'");
  assert.equal(params.get('$orderby'), 'name desc');
  assert.equal(params.get('$top'), '2');
  assert.equal(params.get('$count'), 'true');
  assert.match(calls[1].init.headers.prefer, /odata.maxpagesize=1/);
  assert.equal(calls[1].init.headers['x-sim-csrf'], 'local-token');
  await dataClient.getAll('items', { skipToken: result.skipToken });
  assert.equal(new URL(calls[2].url, 'http://localhost').searchParams.get('$skiptoken'), 'next');
});

test('unsupported options fail instead of silently changing the query', async () => {
  configure({ app: 'sample' });
  await assert.rejects(dataClient.getAll('items', { skip: 1 }), /does not support skip/);
  await assert.rejects(dataClient.getAll('items', { expand: 'owner' }), /Unsupported Mirage query option: expand/);
  await assert.rejects(dataClient.getAll('items', { maxPageSize: 0 }), /positive integer/);
  await assert.rejects(dataClient.getAll('items', { count: 'yes' }), /count must be a boolean/);
});

test('HTTP errors preserve status even when the response is not JSON', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async (url) =>
    url.endsWith('/context')
      ? new Response('{}', { headers: { 'x-sim-csrf': 'token' } })
      : new Response('<html>failure</html>', { status: 502, statusText: 'Bad Gateway' });
  configure({ app: 'sample' });
  await assert.rejects(dataClient.getAll('items'), (error) => error.status === 502 && error.message === 'Bad Gateway');
});

test('configuration rejects missing app names and cross-origin browser targets', (t) => {
  const original = globalThis.location;
  t.after(() => {
    if (original === undefined) delete globalThis.location;
    else globalThis.location = original;
  });
  globalThis.location = { href: 'http://localhost:3000/app', origin: 'http://localhost:3000', search: '' };
  assert.throws(() => configure({ app: '' }), /non-empty app name/);
  assert.throws(() => configure({ app: 'sample', origin: 'https://example.invalid' }), /current origin/);
  assert.doesNotThrow(() => configure({ app: 'sample', origin: 'http://localhost:3000' }));
});

test('reconfiguration while context is in flight never reuses the previous app token', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const requests = [];
  let release;
  let started;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const arrived = new Promise((resolve) => {
    started = resolve;
  });
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    if (url === '/_apps/code/first/context') {
      started();
      await pending;
      return new Response('{}', { headers: { 'x-sim-csrf': 'first-token' } });
    }
    if (url === '/_apps/code/second/context') return new Response('{}', { headers: { 'x-sim-csrf': 'second-token' } });
    return new Response('{"value":[]}');
  };
  configure({ app: 'first' });
  const oldRequest = dataClient.getAll('items');
  await arrived;
  configure({ app: 'second' });
  release();
  await assert.rejects(oldRequest, /configuration changed/);
  await dataClient.getAll('items');
  assert.deepEqual(
    requests.map((request) => request.url),
    ['/_apps/code/first/context', '/_apps/code/second/context', '/_apps/code/second/dataverse/items'],
  );
  assert.equal(requests[2].init.headers['x-sim-csrf'], 'second-token');
});

test('optional SDK query fields set to undefined do not reject a valid read', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async (url) =>
    url.endsWith('/context')
      ? new Response('{}', { headers: { 'x-sim-csrf': 'token' } })
      : new Response('{"value":[]}');
  configure({ app: 'sample' });
  assert.deepEqual(await dataClient.getAll('items', { partitionId: undefined, skip: undefined }), { data: [] });
});

test('reconfiguration rejects an old app data response already in flight', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let release, started;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const arrived = new Promise((resolve) => {
    started = resolve;
  });
  globalThis.fetch = async (url) => {
    if (url.endsWith('/context')) return new Response('{}', { headers: { 'x-sim-csrf': 'token' } });
    started();
    await pending;
    return new Response('{"value":[{"name":"old app"}]}');
  };
  configure({ app: 'first' });
  const oldRequest = dataClient.getAll('items');
  await arrived;
  configure({ app: 'second' });
  release();
  await assert.rejects(oldRequest, /configuration changed/);
});

test('entity set names cannot escape the Dataverse proxy path', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = () => assert.fail('invalid entity set must not issue a request');
  configure({ app: 'sample' });
  for (const name of ['../context', 'items?x=1', 'items/other', ''])
    await assert.rejects(dataClient.getAll(name), /Entity set must be a Dataverse identifier/);
});

test('explicit origins are canonicalized and invalid origin prefixes are rejected before fetch', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalLocation = globalThis.location;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalLocation === undefined) delete globalThis.location;
    else globalThis.location = originalLocation;
  });
  globalThis.location = { href: 'http://localhost:3000/app', origin: 'http://localhost:3000', search: '' };
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url);
    return url.endsWith('/context')
      ? new Response('{}', { headers: { 'x-sim-csrf': 'token' } })
      : new Response('{"value":[]}');
  };
  configure({ app: 'sample', origin: 'http://localhost:3000/' });
  await dataClient.getAll('items');
  assert.deepEqual(urls, [
    'http://localhost:3000/_apps/code/sample/context',
    'http://localhost:3000/_apps/code/sample/dataverse/items',
  ]);
  for (const origin of [
    null,
    1,
    'http://localhost:3000/path',
    'http://localhost:3000/?q=1',
    'http://localhost:3000/#x',
    'http://user:pass@localhost:3000/',
    'ftp://localhost/',
  ])
    assert.throws(() => configure({ app: 'sample', origin }), /Origin must be/);
  assert.equal(urls.length, 2);
});

test('metadata requests select local entity metadata and filter requested columns', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url);
    if (url.endsWith('/context')) return new Response('{}', { headers: { 'x-sim-csrf': 'token' } });
    return new Response(
      JSON.stringify({ LogicalName: 'x_item', Attributes: [{ LogicalName: 'x_a' }, { LogicalName: 'x_b' }] }),
    );
  };
  configure({ app: 'sample' });
  const result = await dataClient.getEntityMetadata('x_item', {
    metadata: ['LogicalName'],
    schema: { columns: ['x_b'], oneToMany: true },
  });
  assert.deepEqual(result.data.Attributes, [{ LogicalName: 'x_b' }]);
  const url = new URL(urls[1], 'http://localhost');
  assert.equal(url.pathname, "/_apps/code/sample/dataverse/EntityDefinitions(LogicalName='x_item')");
  assert.equal(url.searchParams.get('$select'), 'LogicalName');
  assert.equal(url.searchParams.get('$expand'), 'Attributes,OneToManyRelationships');
  await assert.rejects(dataClient.getEntityMetadata('x_item', { schema: { columns: ['bad/name'] } }), /identifiers/);
});
