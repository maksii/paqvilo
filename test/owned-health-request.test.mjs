// @test-kind tooling: runtime-owner health requests consume the full response and expose the owned socket-close boundary separately.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import { ownedHealthRequest } from './helpers/owned-health-request.mjs';

test('completed health response does not claim the runtime connection has already closed', async (t) => {
  const server = http.createServer((request, response) => {
    assert.equal(request.headers.connection, 'keep-alive');
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.write('first chunk');
    response.end('last chunk');
  });
  // This fixture closes only at the explicit shutdown gate, even when the
  // workstation pauses between the completed response and the assertion.
  server.keepAliveTimeout = 0;
  ownedFixture(t).add(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const health = await ownedHealthRequest(t, `http://127.0.0.1:${server.address().port}/status`);
  assert.equal(health.status, 200);
  let closed = false;
  void health.closed.then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false, 'the response body is complete while its connection remains owned');
  server.closeAllConnections();
  await health.closed;
  assert.equal(closed, true, 'shutdown delivery has been observed before cleanup can assert port release');
});

test('a truncated health response remains a failure and cannot qualify runtime cleanup', async (t) => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-length': '100' });
    response.write('incomplete');
    response.flushHeaders();
    request.socket.destroy();
  });
  ownedFixture(t).add(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  await assert.rejects(ownedHealthRequest(t, `http://127.0.0.1:${server.address().port}/status`));
});
