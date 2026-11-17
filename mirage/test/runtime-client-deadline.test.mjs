// @test-kind contract: the testing client's deadline option: 0 sets no client deadline for admin calls and sessions
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { connectRuntime } from '../testing/runtime.mjs';

// A loopback runtime that answers the status call at once and holds the personas call until the test releases it.
async function holdingRuntime(t) {
  const { promise: received, resolve: arrived } = Promise.withResolvers();
  const { promise: released, resolve: release } = Promise.withResolvers();
  const server = http.createServer(async (request, response) => {
    if (request.url === '/_sim/api/status') return response.end(JSON.stringify({ sourceDir: null }));
    if (request.url === '/_sim/api/personas') {
      arrived();
      await released;
      return response.end(JSON.stringify({ personas: [], scenarios: [] }));
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    release();
    server.closeAllConnections();
    server.close();
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, received, release };
}

test('connectRuntime timeoutMs 0 leaves a held admin call without a client deadline', async (t) => {
  t.mock.timers.enable({ apis: ['AbortSignal.timeout'] });
  const runtime = await holdingRuntime(t);
  const client = await connectRuntime({ origin: runtime.origin, timeoutMs: 0 });
  const pending = client.personas();
  await runtime.received;
  t.mock.timers.tick(30_000);
  runtime.release();
  assert.deepEqual(await pending, { personas: [], scenarios: [] });
});

test('connectRuntime without timeoutMs keeps the 30-second client deadline for a held admin call', async (t) => {
  t.mock.timers.enable({ apis: ['AbortSignal.timeout'] });
  const runtime = await holdingRuntime(t);
  const client = await connectRuntime({ origin: runtime.origin });
  const pending = client.personas();
  await runtime.received;
  t.mock.timers.tick(30_000);
  // The mocked AbortSignal.timeout aborts with AbortError; the real one reports TimeoutError.
  await assert.rejects(pending, (error) => error.name === 'AbortError' || error.name === 'TimeoutError');
});

// @test-kind contract: configuration CSRF refresh uses live status without requesting unrelated implementation evidence.
test('runtime writes refresh their CSRF token through status while explicit state evidence remains a separate read', async (t) => {
  let statusReads = 0;
  let stateReads = 0;
  const server = http.createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/_sim/api/status') {
      statusReads++;
      return response.end(JSON.stringify({ sourceDir: null, csrf: `invented-token-${statusReads}` }));
    }
    if (request.url.startsWith('/_sim/api/state')) {
      stateReads++;
      response.statusCode = 500;
      return response.end(
        JSON.stringify({
          error: { code: 'InventedEvidenceUnavailable', message: 'Implementation evidence is unavailable' },
        }),
      );
    }
    if (request.url === '/_sim/api/experiments' && request.method === 'POST') {
      request.resume();
      const accepted = request.headers['x-sim-csrf'] === 'invented-token-2';
      response.statusCode = accepted ? 201 : 403;
      return response.end(JSON.stringify({ accepted }));
    }
    response.statusCode = 404;
    response.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const client = await connectRuntime({ origin: `http://127.0.0.1:${server.address().port}` });
  assert.deepEqual(await client.saveExperiment({ name: 'Invented' }), { accepted: true });
  assert.equal(statusReads, 2, 'the mutation gets a current token instead of caching the connection token');
  assert.equal(stateReads, 0, 'a CSRF refresh must not request expensive implementation evidence');
  await assert.rejects(client.state({ summary: true }), { code: 'InventedEvidenceUnavailable', status: 500 });
  assert.equal(stateReads, 1, 'an explicit state read retains its evidence contract and failure');
});
