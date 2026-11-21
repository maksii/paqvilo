// @test-kind tooling: stopped-agent checks distinguish the owned listener from a reused endpoint and drain a never-answering request on cancellation.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import { servesAgentSession } from '../test-browser/helpers/agent-endpoint.mjs';

async function endpoint(t, handler) {
  const server = http.createServer(handler);
  ownedFixture(t).add(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { endpoint: `http://127.0.0.1:${server.address().port}`, token: 'invented-agent-token' };
}

test('an agent listener still answering the exact session remains visible', async (t) => {
  const discovery = await endpoint(t, (request, response) => {
    assert.equal(request.url, '/v1/session');
    assert.equal(request.headers.authorization, 'Bearer invented-agent-token');
    response.writeHead(200).end('{}');
  });
  assert.equal(await servesAgentSession(discovery), true);
});

test('an unrelated listener reusing the endpoint cannot answer the owned session', async (t) => {
  const discovery = await endpoint(t, (_request, response) => response.writeHead(401).end());
  assert.equal(await servesAgentSession(discovery), false);
});

test('a cancelled never-answering listener check throws and releases its connection', async (t) => {
  const arrived = Promise.withResolvers(),
    closed = Promise.withResolvers();
  const discovery = await endpoint(t, (request) => {
    request.resume();
    request.socket.once('close', closed.resolve);
    arrived.resolve();
  });
  const controller = new AbortController();
  const reason = new Error('invented operation guard expired');
  const check = servesAgentSession(discovery, { signal: controller.signal });
  const rejected = assert.rejects(check, (error) => error === reason);
  await arrived.promise;
  controller.abort(reason);
  await rejected;
  await closed.promise;
});
