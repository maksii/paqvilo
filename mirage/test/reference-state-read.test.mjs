// @test-kind contract: a refused local state read names its HTTP status and JSON error code, never the body, and keeps a fetch failure as its cause; the local runtime is a fake loopback server
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { compareReferenceContracts } from '../reference-parity.mjs';

// A loopback server that answers every request with the given response writer; closed when the test ends.
async function fakeRuntime(t, respond) {
  const server = http.createServer(respond);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

// The options compareReferenceContracts needs before it reads the local state. The reference bridge must never be reached.
const options = (localUrl) => ({
  localUrl,
  origin: 'https://reference.invalid',
  outputDir: 'unused-evidence',
  contracts: [{ id: 'state', path: '/_api/widgets' }],
  bridge: {
    request: async () => {
      throw new Error('the reference bridge must not be reached before the local state is read');
    },
  },
});

test('a refused local state read names its HTTP status and JSON error code, and never copies the body', async (t) => {
  const localUrl = await fakeRuntime(t, (request, response) => {
    response.writeHead(403, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({ error: { code: 'AdminOriginRequired', message: 'body text that must not be copied' } }),
    );
  });
  await assert.rejects(
    compareReferenceContracts(options(localUrl)),
    new Error('Local runtime state is unavailable (HTTP 403 AdminOriginRequired).'),
  );
});

test('a local state read that fails with a non-JSON body names only its HTTP status', async (t) => {
  const localUrl = await fakeRuntime(t, (request, response) => {
    response.writeHead(500, { 'content-type': 'text/html' });
    response.end('<html>internal page with a stack trace</html>');
  });
  await assert.rejects(
    compareReferenceContracts(options(localUrl)),
    new Error('Local runtime state is unavailable (HTTP 500).'),
  );
});

test('a refused connection to the local runtime keeps its own error as the cause, and the message names the origin only', async () => {
  const probe = http.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const localUrl = `http://127.0.0.1:${probe.address().port}`;
  await new Promise((resolve) => probe.close(resolve));
  await assert.rejects(compareReferenceContracts(options(localUrl)), (error) => {
    assert.equal(error.message, `Local runtime state request to ${localUrl} failed.`);
    assert.ok(error.cause, 'the fetch failure is kept as the cause');
    return true;
  });
});
