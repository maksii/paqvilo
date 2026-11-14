// @test-kind security+contract: local reconfiguration must isolate cached app context, CSRF and request sessions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { configure, dataClient, getContext } from '../lib/code-apps-client.js';

test('new configuration clears resolved context and its request credentials', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    const app = url.includes('/first/') ? 'first' : 'second';
    return url.endsWith('/context')
      ? new Response(JSON.stringify({ app: { appId: app, queryParams: {} } }), {
          headers: { 'x-sim-csrf': `${app}-token` },
        })
      : new Response('{"value":[]}');
  };
  configure({ app: 'first' });
  const first = await getContext();
  assert.equal(await getContext(), first);
  configure({ app: 'second' });
  const second = await getContext();
  assert.notEqual(second, first);
  assert.equal(second.app.appId, 'second');
  await dataClient.getAll('inventeds');
  assert.equal(requests.length, 3);
  assert.equal(requests[2].init.headers['x-sim-csrf'], 'second-token');
  assert.notEqual(
    requests[0].init.headers['x-paqvilo-code-app-session'],
    requests[2].init.headers['x-paqvilo-code-app-session'],
  );
});

// @test-kind contract: transient context failures remain retryable and cannot populate the resolved cache.
test('failed context fetch does not poison the resolved cache', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let calls = 0;
  globalThis.fetch = async () =>
    ++calls === 1
      ? new Response('{"error":{"message":"fixture unavailable"}}', { status: 503 })
      : new Response(JSON.stringify({ app: { queryParams: {} } }), { headers: { 'x-sim-csrf': 'invented' } });
  configure({ app: 'invented-retry' });
  await assert.rejects(getContext(), /fixture unavailable/);
  const context = await getContext();
  assert.equal(await getContext(), context);
  assert.equal(calls, 2);
});
