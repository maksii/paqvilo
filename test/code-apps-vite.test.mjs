import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { codeApps } from '../mirage/lib/code-apps-vite.mjs';

test('Vite integration only activates for configured local development and validates its origin and app', () => {
  const plugin = codeApps({ app: 'invented', mirageUrl: 'http://127.0.0.1:8787' });
  assert.equal(plugin.apply({}, { command: 'build', mode: 'mirage' }), false);
  assert.equal(plugin.apply({}, { command: 'serve', mode: 'mirage' }), true);
  const config = plugin.config();
  assert.equal(config.server.host, '127.0.0.1');
  assert.equal(config.server.strictPort, true);
  assert.equal(config.server.proxy['/_apps/code/'].target, 'http://127.0.0.1:8787');
  for (const mirageUrl of [
    'https://outside.example.test',
    'http://localhost:8787/path',
    'http://name:secret@localhost:8787',
    'http://localhost:8787/?token=secret',
  ])
    assert.throws(() => codeApps({ app: 'invented', mirageUrl }).config(), /loopback/);
  assert.throws(() => codeApps({ app: '../bad', mirageUrl: 'http://localhost:8787' }).config(), /app option/);
  assert.throws(() => plugin.configResolved({ root: '.', plugins: [{ name: 'powerApps' }] }), /do not enable both/);
});

test('Vite proxy guards Host, Origin and origin-form paths and rewrites approved Origin', () => {
  const plugin = codeApps({ app: 'invented', mirageUrl: 'http://127.0.0.1:8787' });
  plugin.config();
  let middleware;
  const watcher = new EventEmitter();
  watcher.add = () => {};
  const server = {
    middlewares: {
      use: (fn) => {
        middleware = fn;
      },
    },
    httpServer: Object.assign(new EventEmitter(), { address: () => ({ port: 5173 }) }),
    config: { root: '.', server: {} },
    watcher,
    ws: Object.assign(new EventEmitter(), { send() {} }),
  };
  plugin.configureServer(server);
  const request = (url, host, origin) => {
    const req = { url, headers: { host, ...(origin ? { origin } : {}) } };
    const res = {
      code: null,
      writeHead(code) {
        this.code = code;
      },
      end() {},
    };
    let next = false;
    middleware(req, res, () => {
      next = true;
    });
    return { req, res, next };
  };
  for (const url of [
    'http://outside.example/_apps/code/invented/context',
    '//outside.example/_apps/code/invented/context',
    '/\\outside',
  ])
    assert.equal(request(url, '127.0.0.1:5173').res.code, 400);
  assert.equal(request('/_apps/code/invented/context', 'outside.example:5173').res.code, 403);
  assert.equal(request('/_apps/code/invented/context', '127.0.0.1:5173', 'https://outside.example').res.code, 403);
  const allowed = request('/_apps/code/invented/context', '127.0.0.1:5173', 'http://127.0.0.1:5173');
  assert.equal(allowed.next, true);
  assert.equal(allowed.req.headers.origin, 'http://127.0.0.1:8787');
  assert.equal(request('/src/app.js', 'outside.example:5173').next, true);
  server.httpServer.emit('close');
  for (const event of ['change', 'add', 'unlink']) assert.equal(watcher.listenerCount(event), 0);
  assert.equal(server.ws.listenerCount('paqvilo:config-check'), 0);
});

test('Vite module entry wrappers install bootstrap before the application entry', async () => {
  const plugin = codeApps({ app: 'invented', mirageUrl: 'http://localhost:8787' });
  plugin.config();
  const { html } = plugin.transformIndexHtml.handler('<script type="module" src="./src/main.js"></script>', {
    path: '/index.html',
  });
  const encoded = html.match(/src="\/@id\/__x00__(.*?)"/)[1];
  const module = plugin.load('\0' + encoded);
  assert.match(
    module,
    /^import \{ inOrder \} from "virtual:paqvilo-code-app-order"; await inOrder\(async \(\) => \{ await import\("virtual:paqvilo-code-app-bootstrap"\); await import\("\/src\/main.js"\); \}\);$/,
  );
  // Entries share one queue, so the page's module scripts evaluate in document order.
  const order = plugin.load(plugin.resolveId('virtual:paqvilo-code-app-order'));
  const { inOrder } = await import('data:text/javascript,' + encodeURIComponent(order));
  const evaluated = [];
  let releaseFirst;
  const first = inOrder(async () => {
    await new Promise((resolve) => (releaseFirst = resolve));
    evaluated.push('first');
    throw new Error('Invented failing script');
  });
  const second = inOrder(async () => evaluated.push('second'));
  await Promise.resolve();
  assert.deepEqual(evaluated, []);
  releaseFirst();
  await assert.rejects(first, /Invented failing script/);
  await second;
  assert.deepEqual(evaluated, ['first', 'second']);
});

test('published Vite and browser client declarations typecheck a consumer', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  const compiler = fileURLToPath(import.meta.resolve('typescript/bin/tsc'));
  const fixture = fileURLToPath(new URL('./fixtures/code-apps-consumer.mts', import.meta.url));
  await promisify(execFile)(process.execPath, [
    compiler,
    '--noEmit',
    '--strict',
    '--skipLibCheck',
    '--module',
    'nodenext',
    '--moduleResolution',
    'nodenext',
    '--target',
    'es2022',
    fixture,
  ]);
});

test('inline module scripts are gated separately and relative imports resolve from their HTML file', async () => {
  const plugin = codeApps({ app: 'invented', mirageUrl: 'http://localhost:8787' });
  plugin.config();
  const input =
    '<script type="module">import "./local.js"; globalThis.count++;</script><script type="module">import "./local.js"; globalThis.count++;</script>';
  const { html: transformed } = plugin.transformIndexHtml.handler(input, {
    path: '/pages/index.html',
    filename: '/project/pages/index.html',
  });
  const ids = [...transformed.matchAll(/src="\/@id\/__x00__(.*?)"/g)].map((match) => match[1]);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1], 'distinct inline tags must execute independently');
  const targets = ids.map(
    (id) => plugin.load('\0' + id).match(/await import\("(virtual:paqvilo-code-app-inline\/[^"]+)"\)/)[1],
  );
  assert.notEqual(targets[0], targets[1]);
  assert.match(plugin.load('\0' + targets[0]), /import "\.\/local\.js"/);
  const calls = [];
  await plugin.resolveId.call(
    {
      resolve: (...args) => {
        calls.push(args);
        return { id: '/project/pages/local.js' };
      },
    },
    './local.js',
    '\0' + targets[0],
  );
  assert.deepEqual(calls, [['./local.js', '/project/pages/index.html', { skipSelf: true }]]);
});

test('external module scripts remain external but run after bootstrap', () => {
  const plugin = codeApps({ app: 'invented', mirageUrl: 'http://localhost:8787' });
  plugin.config();
  const { html: transformed } = plugin.transformIndexHtml.handler(
    '<script type="module" src="https://cdn.example.test/app.js"></script>',
    { path: '/index.html', filename: '/project/index.html' },
  );
  const id = transformed.match(/src="\/@id\/__x00__(.*?)"/)[1];
  assert.match(
    plugin.load('\0' + id),
    /await inOrder\(async \(\) => \{ await import\("virtual:paqvilo-code-app-bootstrap"\); await import\("https:\/\/cdn\.example\.test\/app\.js"\); \}\);$/,
  );
});

test('an unreadable configuration renders an unknown stamp and reloads once its bytes are readable', async (t) => {
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const root = mkdtempSync(path.join(tmpdir(), 'paqvilo-code-app-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // A directory at the configuration path makes every read fail with a non-ENOENT error.
  const configFile = path.join(root, 'power.config.json');
  mkdirSync(configFile);
  const plugin = codeApps({ app: 'invented', mirageUrl: 'http://127.0.0.1:8787' });
  plugin.config();
  const watcher = Object.assign(new EventEmitter(), { add() {} });
  const server = {
    middlewares: { use() {} },
    httpServer: Object.assign(new EventEmitter(), { address: () => ({ port: 5173 }) }),
    config: { root, server: {} },
    watcher,
    ws: Object.assign(new EventEmitter(), { send() {} }),
  };
  plugin.configureServer(server);
  t.after(() => server.httpServer.emit('close'));
  const stamp = (html) => html.tags.find((tag) => tag.attrs.name === 'paqvilo-code-app-config').attrs.content;
  const rendered = stamp(plugin.transformIndexHtml.handler('<p></p>', { path: '/index.html' }));
  assert.equal(rendered, 'unknown');
  const sent = [];
  let reloaded;
  const reload = new Promise((resolve) => {
    reloaded = resolve;
  });
  const client = {
    send(message) {
      sent.push(message);
      reloaded();
    },
  };
  // The check arrives while the bytes are still unreadable: nothing is sent yet.
  server.ws.emit('paqvilo:config-check', { stamp: rendered }, client);
  assert.deepEqual(sent, []);
  // The swap completes before the retry timer can run.
  rmSync(configFile, { recursive: true });
  writeFileSync(configFile, '{"appId":"invented"}');
  await reload;
  assert.deepEqual(sent, [{ type: 'full-reload', path: '*' }]);
  // A document rendered from the readable bytes is current.
  const current = stamp(plugin.transformIndexHtml.handler('<p></p>', { path: '/index.html' }));
  assert.match(current, /^[a-f0-9]{64}$/);
  server.ws.emit('paqvilo:config-check', { stamp: current }, client);
  assert.equal(sent.length, 1);
});
