// Tasks 68 and 69: a retry policy retries 408 like 429 and 5xx; an HTTP 202 with Location is polled (Retry-After honoured,
// loopback only, bounded by the run deadline) to its final answer unless the action disables the asynchronous pattern.
// Loopback servers only.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createConnectorRuntime } from '../lib/connector-runtime.mjs';
import { executeFlowDefinition } from '../lib/flow-runtime.mjs';

const manual = { manual: { type: 'Request', kind: 'Button', inputs: { schema: { type: 'object' } } } };
async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('a retry policy retries a 408 answer (408 -> 200)', async () => {
  let calls = 0;
  const store = await new DataStore({ state: emptyState() }).init();
  const connectors = createConnectorRuntime({ store, packs: [{ id: 'x-pack', connectors: { x_api: { operations: { Op: () => ({ statusCode: ++calls === 1 ? 408 : 200, body: { calls } }) } } } }] });
  const definition = { triggers: manual, actions: {
    op: { type: 'OpenApiConnection', inputs: { host: { apiId: '/providers/Microsoft.PowerApps/apis/x_api', operationId: 'Op' }, parameters: {}, retryPolicy: { type: 'fixed', count: 2, interval: 'PT0S' } } },
    reply: { type: 'Response', runAfter: { op: ['Succeeded'] }, inputs: { statusCode: 200, body: "@body('op')" } } } };
  assert.deepEqual(await executeFlowDefinition({ definition, input: {}, store, connectors }), { status: 200, body: { calls: 2 } });
});

test('a 202 with Location is polled after Retry-After until the final answer, whose body is the result', async t => {
  const seen = [];
  const origin = await listen(t, (req, res) => {
    seen.push(req.method + ' ' + req.url);
    if (req.url === '/start') { res.writeHead(202, { location: origin + '/status/1', 'retry-after': '0' }); return res.end(); }
    if (req.url === '/status/1') { res.writeHead(202, { location: '/status/2', 'retry-after': '0' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"done":true}');
  });
  const connectors = createConnectorRuntime({});
  const action = extra => ({ triggers: manual, actions: { call: { type: 'Http', ...extra, inputs: { method: 'POST', uri: origin + '/start' } },
    reply: { type: 'Response', runAfter: { call: ['Succeeded'] }, inputs: { statusCode: 200, body: { code: "@outputs('call')?['statusCode']", body: "@body('call')" } } } } });
  assert.deepEqual(await executeFlowDefinition({ definition: action({}), input: {}, connectors }), { status: 200, body: { code: 200, body: { done: true } } });
  assert.deepEqual(seen, ['POST /start', 'GET /status/1', 'GET /status/2']);
  // DisableAsyncPattern answers the 202 as is.
  seen.length = 0;
  assert.deepEqual(await executeFlowDefinition({ definition: action({ operationOptions: 'DisableAsyncPattern' }), input: {}, connectors }), { status: 200, body: { code: 202, body: null } });
  assert.deepEqual(seen, ['POST /start']);
});

test('a status URL outside loopback is refused and a Retry-After beyond the run deadline times the action out', async t => {
  const remote = await listen(t, (req, res) => { res.writeHead(202, { location: 'https://status.example.test/poll', 'retry-after': '0' }); res.end(); });
  const slow = await listen(t, (req, res) => { res.writeHead(202, { location: '/again', 'retry-after': '3600' }); res.end(); });
  const connectors = createConnectorRuntime({});
  const call = uri => connectors.invoke({ connectorId: 'http', operationId: 'Http', parameters: { method: 'GET', uri }, context: { timeoutMs: 2000 } });
  await assert.rejects(call(remote + '/x'), { code: 'ProviderUnavailable' });
  await assert.rejects(call(slow + '/x'), { code: 'ProviderTimeout' });
});

// RC4b-04: a relative Location resolves against the URI of the response that carried it (RFC 9110 section 10.2.2), so a
// chain across two loopback origins polls the second origin, not the first request's.
test('a relative Location in a 202 chain resolves against the previous status URL on another loopback origin', async t => {
  const seen = [];
  const b = await listen(t, (req, res) => {
    seen.push('B ' + req.url);
    if (req.url === '/s1') { res.writeHead(202, { location: 's2', 'retry-after': '0' }); return res.end(); }
    if (req.url === '/s2') { res.writeHead(202, { location: '/s3', 'retry-after': '0' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"from":"B"}');
  });
  const a = await listen(t, (req, res) => {
    seen.push('A ' + req.url);
    if (req.url === '/start') { res.writeHead(202, { location: b + '/s1', 'retry-after': '0' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"from":"A"}');
  });
  const definition = { triggers: manual, actions: { call: { type: 'Http', inputs: { method: 'POST', uri: a + '/start' } },
    reply: { type: 'Response', runAfter: { call: ['Succeeded'] }, inputs: { statusCode: 200, body: "@body('call')" } } } };
  assert.deepEqual(await executeFlowDefinition({ definition, input: {}, connectors: createConnectorRuntime({}) }), { status: 200, body: { from: 'B' } });
  assert.deepEqual(seen, ['A /start', 'B /s1', 'B /s2', 'B /s3']);
});
