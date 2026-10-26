import test from 'node:test';
import assert from 'node:assert/strict';
import { configure, dataClient } from '../lib/code-apps-client.js';

test('client sends context token and documented query options with paging', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/context')) return new Response('{}', { headers: { 'x-sim-csrf': 'local-token' } });
    return new Response(JSON.stringify({ value: [{ name: 'A' }], '@odata.nextLink': '/_api/items?$skiptoken=next' }));
  };
  configure({ app: 'sample' });
  const result = await dataClient.getAll('items', {
    select: ['name'],
    filter: "name eq 'A'",
    orderBy: ['name desc'],
    top: 2,
    maxPageSize: 1,
  });
  assert.deepEqual(result, { data: [{ name: 'A' }], skipToken: 'next' });
  const params = new URL(calls[1].url, 'http://localhost').searchParams;
  assert.equal(params.get('$filter'), "name eq 'A'");
  assert.equal(params.get('$orderby'), 'name desc');
  assert.equal(params.get('$top'), '2');
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
  globalThis.location = { href: 'http://localhost:3000/app', origin: 'http://localhost:3000' };
  assert.throws(() => configure({ app: '' }), /non-empty app name/);
  assert.throws(() => configure({ app: 'sample', origin: 'https://example.invalid' }), /current origin/);
  assert.doesNotThrow(() => configure({ app: 'sample', origin: 'http://localhost:3000' }));
});
