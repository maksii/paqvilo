// @test-kind security: the Code Apps Vite proxy answers a foreign Origin itself and forwards no browser-only request metadata
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { codeApps } from '../lib/code-apps-vite.mjs';

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(resolve));

// A dev server whose only middleware is the plugin's; a request the plugin lets through is forwarded to the target.
async function devServer(t, targetPort) {
  const plugin = codeApps({ app: 'invented-app', mirageUrl: `http://127.0.0.1:${targetPort}`, enabled: true });
  plugin.config();
  let middleware;
  const forward = (req, res) => {
    const upstream = http.request(
      { host: '127.0.0.1', port: targetPort, method: req.method, path: req.url, headers: req.headers },
      (answer) => {
        res.writeHead(answer.statusCode, answer.headers);
        answer.pipe(res);
      },
    );
    req.pipe(upstream);
  };
  const vite = http.createServer((req, res) => middleware(req, res, () => forward(req, res)));
  t.after(() => close(vite));
  const port = await listen(vite);
  plugin.configureServer({
    config: { root: '.', server: { https: false } },
    httpServer: vite,
    middlewares: {
      use: (handler) => {
        middleware = handler;
      },
    },
    watcher: { add: () => {}, on: () => {}, off: () => {} },
    ws: { on: () => {}, off: () => {} },
  });
  return port;
}

function get(port, path, headers) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path, headers }, (answer) => {
      answer.resume();
      answer.on('end', () => resolve(answer.statusCode));
    });
    request.on('error', reject);
    request.end();
  });
}

// The stub proxy target records the headers of every request it receives.
async function stubTarget(t) {
  const received = [];
  const target = http.createServer((req, res) => {
    received.push(req.headers);
    res.end('ok');
  });
  t.after(() => close(target));
  return { received, port: await listen(target) };
}

test('a request that passes the plugin origin check reaches the target without origin or sec-fetch headers', async (t) => {
  const target = await stubTarget(t);
  const port = await devServer(t, target.port);
  const status = await get(port, '/_apps/code/invented-app/context', {
    origin: `http://127.0.0.1:${port}`,
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    'sec-fetch-user': '?1',
  });
  assert.equal(status, 200);
  assert.equal(target.received.length, 1);
  assert.equal(target.received[0].origin, undefined);
  assert.deepEqual(
    Object.keys(target.received[0]).filter((name) => name.startsWith('sec-fetch-')),
    [],
  );
});

test('a foreign Origin is answered 403 by the plugin and never reaches the target', async (t) => {
  const target = await stubTarget(t);
  const port = await devServer(t, target.port);
  const status = await get(port, '/_apps/code/invented-app/context', { origin: 'http://evil.invalid' });
  assert.equal(status, 403);
  assert.deepEqual(target.received, []);
});
