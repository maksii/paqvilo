// Shared Mirage test doubles: console output capture, promise latches and a loopback runtime that answers its status probe.
import http from 'node:http';
import { ownedFixture } from '../../mirage/testing/owned-fixture.mjs';

export function captureConsoleOutput() {
  const output = { errors: [], logs: [] };
  const original = { error: console.error, log: console.log };
  console.error = (line) => output.errors.push(line);
  console.log = (line) => output.logs.push(line);
  return {
    output,
    restore: () => {
      console.error = original.error;
      console.log = original.log;
    },
  };
}

export function openLatch() {
  let open;
  const promise = new Promise((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

// Starts a loopback runtime that reports itself as model-driven, calls onRequest for each request and closes with the test.
export async function readyRuntime(t, onRequest) {
  const server = http.createServer((_req, res) => {
    onRequest();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ runtime: { kind: 'model-driven' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  ownedFixture(t).add(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return `http://127.0.0.1:${server.address().port}`;
}
