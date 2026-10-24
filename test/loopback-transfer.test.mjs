import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { loopbackFetch } from '../mirage/lib/dataverse-webhooks.mjs';

test('local state transfers reject remote destinations before sending fixture data', () => {
  const options = { method: 'POST', body: '{"invented":"local-only"}' };
  for (const url of ['https://example.invalid/import', 'http://127.0.0.1.example.invalid/import']) {
    assert.throws(() => loopbackFetch(url, options), /Endpoint unavailable/);
  }
});

test('local state transfers never follow redirects with their body or credentials', async (t) => {
  let destinationRequests = 0;
  let received;
  const server = http.createServer(async (request, response) => {
    if (request.url === '/destination') {
      destinationRequests++;
      return response.writeHead(200).end();
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = { body: Buffer.concat(chunks).toString('utf8'), token: request.headers['x-sim-csrf'] };
    response.writeHead(307, { location: '/destination' }).end();
  });
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const body = '{"invented":"local-only"}';
  await assert.rejects(
    loopbackFetch(`http://127.0.0.1:${server.address().port}/import`, {
      method: 'POST',
      body,
      headers: { 'x-sim-csrf': 'invented-fixture-csrf' },
    }),
    /fetch failed/,
  );
  assert.deepEqual(received, { body, token: 'invented-fixture-csrf' });
  assert.equal(destinationRequests, 0);
});
