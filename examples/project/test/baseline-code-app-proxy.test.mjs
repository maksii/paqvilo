import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startCodeApp } from './code-app-process.mjs';

test(
  'code app proxy confines request targets and rebases only trusted browser origins',
  { timeout: 180_000 },
  async (t) => {
    const calls = [];
    const upstream = http.createServer((req, res) => {
      calls.push({
        path: req.url,
        host: req.headers.host,
        origin: req.headers.origin,
        csrf: req.headers['x-sim-csrf'],
      });
      res.end('{}');
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    t.after(
      () =>
        new Promise((resolve) => {
          upstream.closeAllConnections();
          upstream.close(resolve);
        }),
    );
    const target = `http://127.0.0.1:${upstream.address().port}`;
    const { port } = await startCodeApp(t, { MIRAGE_URL: target, CODE_APP_PORT: '0' });
    const origin = `http://127.0.0.1:${port}`;
    const request = (path, headers = {}) =>
      new Promise((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            method: 'POST',
            path,
            headers: {
              host: `127.0.0.1:${port}`,
              origin,
              'x-sim-csrf': 'local-csrf',
              ...headers,
            },
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
          },
        );
        req.on('error', reject);
        req.end();
      });
    for (const path of [
      `${target}/_apps/code/a/context`,
      `//127.0.0.1:${upstream.address().port}/_apps/code/a/context`,
      '/\\127.0.0.1/_apps/code/a/context',
    ])
      assert.equal(await request(path), 400, path);
    assert.equal(await request('/_apps/code/a/dataverse/items', { origin: 'https://untrusted.example.test' }), 403);
    assert.equal(await request('/_apps/code/a/dataverse/items', { host: 'untrusted.example.test' }), 403);
    assert.deepEqual(calls, [], 'refused requests never reach an upstream');
    assert.equal(await request('/_apps/code/a/dataverse/items?$select=name'), 200);
    assert.deepEqual(calls, [
      {
        path: '/_apps/code/a/dataverse/items?$select=name',
        host: new URL(target).host,
        origin: target,
        csrf: 'local-csrf',
      },
    ]);
  },
);

test('code app proxy closes a truncated upstream response', { timeout: 180_000 }, async (t) => {
  let upstreamResponse;
  const upstream = http.createServer((_req, res) => {
    upstreamResponse = res;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"partial":');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        upstream.closeAllConnections();
        upstream.close(resolve);
      }),
  );
  const target = `http://127.0.0.1:${upstream.address().port}`;
  const { port } = await startCodeApp(t, { MIRAGE_URL: target, CODE_APP_PORT: '0' });
  const completed = new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/_apps/code/a/context`, (res) => {
      res.once('data', () => upstreamResponse.destroy());
      res.once('aborted', () => resolve('aborted'));
      res.once('end', () => resolve('ended'));
      res.on('error', () => {});
    });
    req.on('error', reject);
  });
  assert.equal(await completed, 'aborted');
});

test('code app proxy cancels upstream when the client disconnects before headers', { timeout: 180_000 }, async (t) => {
  let arrived;
  let closed;
  const requestArrived = new Promise((resolve) => {
    arrived = resolve;
  });
  const responseClosed = new Promise((resolve) => {
    closed = resolve;
  });
  const upstream = http.createServer((_req, res) => {
    res.once('close', closed);
    arrived();
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        upstream.closeAllConnections();
        upstream.close(resolve);
      }),
  );
  const target = `http://127.0.0.1:${upstream.address().port}`;
  const { port } = await startCodeApp(t, { MIRAGE_URL: target, CODE_APP_PORT: '0' });
  const request = http.get(`http://127.0.0.1:${port}/_apps/code/a/context`);
  request.on('error', () => {});
  await requestArrived;
  request.destroy();
  await responseClosed;
});
