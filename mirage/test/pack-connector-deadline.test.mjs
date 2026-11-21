// @test-kind contract: a connector call that runs a data pack's connector operation or http fixture ends at the call's budget when that project code never settles
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createConnectorRuntime, DEFAULT_CONNECTOR_TIMEOUT_MS } from '../lib/connector-runtime.mjs';

const never = () => new Promise(() => {});
const entered = () => new Promise((resolve) => setImmediate(resolve));

function packRuntime(operation) {
  return createConnectorRuntime({
    packs: [{ id: 'x-pack', connectors: { x_widgets: { operations: { List: operation } } } }],
    connections: { 'conn-1': { connector: 'x_widgets', provider: 'pack:x-pack' } },
  });
}
const listCall = (runtime, context) =>
  runtime.invoke({ connectorId: 'x_widgets', connectionId: 'conn-1', operationId: 'List', parameters: {}, context });

test('a pack connector operation that never settles fails its call with ProviderTimeout at the default budget', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  let calls = 0;
  const pending = listCall(
    packRuntime(() => (calls++, never())),
    {},
  );
  const refused = assert.rejects(pending, (error) => {
    assert.equal(error.status, 504);
    assert.equal(error.code, 'ProviderTimeout');
    assert.equal(
      error.message,
      'The pack connector operation x_widgets.List did not answer within the action time limit.',
    );
    return true;
  });
  await entered();
  mock.timers.tick(DEFAULT_CONNECTOR_TIMEOUT_MS);
  await refused;
  assert.equal(calls, 1);
});

test('a pack connector operation is bounded by the timeoutMs its caller supplies', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const refused = assert.rejects(listCall(packRuntime(never), { timeoutMs: 1000 }), {
    status: 504,
    code: 'ProviderTimeout',
  });
  await entered();
  mock.timers.tick(1000);
  await refused;
});

test('a pack connector operation that settles answers as before, and what it throws is passed on', async () => {
  const answer = { statusCode: 200, body: { value: [] } };
  assert.deepEqual(
    await listCall(
      packRuntime(async () => answer),
      {},
    ),
    answer,
  );
  assert.deepEqual(
    await listCall(
      packRuntime(() => answer),
      {},
    ),
    answer,
  );
  const failure = Object.assign(new Error('invented operation failure'), { code: 'InventedFailure' });
  await assert.rejects(
    listCall(
      packRuntime(() => {
        throw failure;
      }),
      {},
    ),
    (error) => error.status === 502 && error.code === 'ProviderFailed' && error.cause === failure,
  );
});

test('a pack http fixture that never settles fails its call with ProviderTimeout, naming the fixture', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const runtime = createConnectorRuntime({
    packs: [
      {
        id: 'x-pack',
        httpFixtures: [{ id: 'stuck', method: 'GET', url: /^https:\/\/api\.example\.test\/stuck$/, respond: never }],
      },
    ],
    connections: { http: { provider: 'fixture' } },
  });
  const refused = assert.rejects(
    runtime.invoke({
      connectorId: 'http',
      operationId: 'Http',
      parameters: { method: 'GET', uri: 'https://api.example.test/stuck' },
    }),
    (error) => {
      assert.equal(error.status, 504);
      assert.equal(error.code, 'ProviderTimeout');
      assert.equal(error.message, 'The pack http fixture stuck did not answer within the action time limit.');
      return true;
    },
  );
  await entered();
  mock.timers.tick(DEFAULT_CONNECTOR_TIMEOUT_MS);
  await refused;
});
