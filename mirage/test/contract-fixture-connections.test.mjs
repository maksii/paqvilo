// @test-kind tooling: contract fixtures isolate authentication and write connections without retrying an operation.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { ownedFixture } from '../testing/owned-fixture.mjs';
import { loopbackFetch } from './contract-module-fixture.mjs';

async function connectionFixture(t, { resetOperation = false } = {}) {
  const exchanges = [];
  let operations = 0;
  const server = http.createServer((request, response) => {
    request.resume();
    request.once('end', () => {
      exchanges.push({ socket: request.socket, connection: request.headers.connection });
      if (request.url === '/operation') {
        operations++;
        // The operation reached the server: retrying it could duplicate a write.
        if (resetOperation) return request.socket.resetAndDestroy();
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ operations }));
    });
  });
  ownedFixture(t).add(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { origin: `http://127.0.0.1:${server.address().port}`, operations: () => operations, exchanges };
}

const post = { method: 'POST', body: '{}' };

test('a connection reset after admitting the write preserves its diagnostic and never retries it', async (t) => {
  const fixture = await connectionFixture(t, { resetOperation: true });
  await assert.rejects(loopbackFetch(fixture.origin + '/operation', post), (error) => {
    assert.ok(['ECONNRESET', 'UND_ERR_SOCKET'].includes(error.cause?.code));
    assert.ok(error.message.includes(error.cause.code));
    return true;
  });
  assert.equal(fixture.operations(), 1, 'a failed write is never retried');
});

test('fixture authentication and write exchanges own fresh connections and preserve caller headers', async (t) => {
  const fixture = await connectionFixture(t);
  const headers = new Headers({ 'content-type': 'application/json' });
  const options = { ...post, headers };
  await (await loopbackFetch(fixture.origin + '/warm-a', options)).text();
  await (await loopbackFetch(fixture.origin + '/warm-b', options)).text();
  const response = await loopbackFetch(fixture.origin + '/operation', options);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { operations: 1 });
  assert.equal(fixture.operations(), 1);
  assert.deepEqual(
    fixture.exchanges.map((exchange) => exchange.connection),
    ['close', 'close', 'close'],
  );
  assert.equal(new Set(fixture.exchanges.map((exchange) => exchange.socket)).size, 3);
  assert.equal(headers.has('connection'), false, 'caller headers remain unchanged');
});

test('an explicit mixed-case connection policy remains caller-owned', async (t) => {
  const fixture = await connectionFixture(t);
  const headers = { CoNnEcTiOn: 'keep-alive' };
  const response = await loopbackFetch(fixture.origin + '/override', { headers });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { operations: 0 });
  assert.equal(fixture.exchanges[0].connection, 'keep-alive');
  assert.deepEqual(headers, { CoNnEcTiOn: 'keep-alive' });
});
