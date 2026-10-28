import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCodeAppDevServers } from '../lense/code-app-dev-servers.mjs';
import { stopCodeAppDevServer } from '../lense/code-app-dev-stop.mjs';
import { childStdioGate, assertChildStdioDrain } from '../test-browser/helpers/child-stdio-gate.mjs';
import { ownedFixture, removeFixtureDirectory } from '../mirage/testing/owned-fixture.mjs';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const close = (server) => {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
};

test('Code App shutdown waits for actual stdio closure after its owner exits', { timeout: 15000 }, async (t) => {
  const child = spawn(process.execPath, ['-e', 'process.stdout.write("owned-output")'], {
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const gate = childStdioGate(t, child);
  await assertChildStdioDrain(gate, stopCodeAppDevServer);
});

test('readiness refuses external, non-HTTP and credential-bearing URLs before any request', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = () => assert.fail('refused destinations must never be requested');
  for (const localAppUrl of [
    'https://outside.example.test/',
    'http://127.0.0.1@outside.example.test/',
    'http://name:invented@localhost:5199/',
    'file:///invented/app',
  ])
    await assert.rejects(
      startCodeAppDevServers(
        [
          {
            name: 'refused',
            dir: '.',
            localAppUrl,
            devServer: { command: ['must-not-start'] },
          },
        ],
        { output: () => {} },
      ),
      /loopback/,
    );
});

test('readiness does not follow a configured loopback listener redirect', { timeout: 15000 }, async (t) => {
  let redirected = 0;
  const destination = http.createServer((_req, res) => {
    redirected++;
    res.end('unexpected');
  });
  await listen(destination);
  const listener = http.createServer((_req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${destination.address().port}/private` });
    res.end();
  });
  await listen(listener);
  t.after(async () => {
    listener.closeAllConnections();
    destination.closeAllConnections();
    await Promise.all([close(listener), close(destination)]);
  });
  await assert.rejects(
    startCodeAppDevServers(
      [
        {
          name: 'redirected',
          dir: '.',
          localAppUrl: `http://127.0.0.1:${listener.address().port}/mounted`,
          devServer: { command: ['definitely-missing-code-app-command'], timeoutMs: 1000 },
        },
      ],
      { output: () => {} },
    ),
    /could not start/,
  );
  assert.equal(redirected, 0);
});

test('readiness probing releases a response whose body does not finish', { timeout: 15000 }, async (t) => {
  let observedClose;
  const closed = new Promise((resolve) => {
    observedClose = resolve;
  });
  const server = http.createServer((_req, res) => {
    res.once('close', observedClose);
    res.writeHead(200);
    res.write('ongoing');
  });
  await listen(server);
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const session = await startCodeAppDevServers(
    [
      {
        name: 'external',
        dir: '.',
        localAppUrl: `http://127.0.0.1:${server.address().port}/`,
        devServer: { command: ['must-not-start'] },
      },
    ],
    { output: () => {} },
  );
  await closed;
  assert.equal(session.owned, 0);
  await session.close();
});

test('mirage rejects unsafe starting paths before opening a runtime', () => {
  const cli = fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url));
  for (const value of ['https://example.test/', '//example.test/', '/\\example.test/', '/bad\npath']) {
    const result = spawnSync(process.execPath, [cli, 'mirage', 'dev', '--path', value], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /origin-relative path/);
  }
});

test(
  'multiple app servers start, reuse external listeners and stop only owned children',
  { timeout: 20000 },
  async (t) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'code-app-supervisor-')));
    ownedFixture(t).remove(() => removeFixtureDirectory(root));
    const external = http.createServer((_req, res) => res.end('external'));
    await listen(external);
    ownedFixture(t).add(() => close(external));
    const reservation = http.createServer();
    await listen(reservation);
    const port = reservation.address().port;
    await close(reservation);
    const script = path.join(root, 'server.mjs');
    await fs.writeFile(
      script,
      "import http from 'node:http'; http.createServer((req,res)=>res.end(JSON.stringify({ app: process.env.PAQVILO_CODE_APP, origin: process.env.PAQVILO_MIRAGE_URL }))).listen(Number(process.env.APP_PORT),'127.0.0.1');",
    );
    const apps = [
      {
        name: 'external',
        dir: root,
        localAppUrl: `http://127.0.0.1:${external.address().port}`,
        devServer: { command: [process.execPath, script] },
      },
      {
        name: 'owned',
        dir: root,
        localAppUrl: `http://127.0.0.1:${port}`,
        devServer: { command: [process.execPath, script], env: { APP_PORT: String(port) } },
      },
    ];
    const session = await startCodeAppDevServers(apps, { output: () => {}, mirageUrl: 'http://127.0.0.1:4321' });
    ownedFixture(t).add(() => session.close());
    assert.equal(session.owned, 1);
    assert.deepEqual(await (await fetch(apps[1].localAppUrl)).json(), {
      app: 'owned',
      origin: 'http://127.0.0.1:4321',
    });
    await session.close();
    await assert.rejects(fetch(apps[1].localAppUrl));
    assert.equal(await (await fetch(apps[0].localAppUrl)).text(), 'external');
  },
);

test('failed startup drains already owned apps and never invokes a shell', { timeout: 20000 }, async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'code-app-supervisor-fail-')));
  ownedFixture(t).remove(() => removeFixtureDirectory(root));
  const server = http.createServer();
  await listen(server);
  const port = server.address().port;
  await close(server);
  const target = `http://127.0.0.1:${port}`;
  const firstReservation = http.createServer();
  await listen(firstReservation);
  const firstPort = firstReservation.address().port;
  await close(firstReservation);
  const script = path.join(root, 'first.mjs');
  await fs.writeFile(
    script,
    "import http from 'node:http'; http.createServer((req,res)=>res.end('first')).listen(Number(process.env.APP_PORT),'127.0.0.1');",
  );
  await assert.rejects(
    startCodeAppDevServers(
      [
        {
          name: 'first',
          dir: root,
          localAppUrl: `http://127.0.0.1:${firstPort}`,
          devServer: { command: [process.execPath, script], env: { APP_PORT: String(firstPort) } },
        },
        {
          name: 'missing',
          dir: root,
          localAppUrl: target,
          devServer: { command: ['definitely-missing-code-app-command'], timeoutMs: 1000 },
        },
      ],
      { output: () => {} },
    ),
    /could not start/,
  );
  await assert.rejects(fetch(`http://127.0.0.1:${firstPort}`));
});

test('an exited app launcher does not orphan its listening descendant', { timeout: 20000 }, async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'code-app-tree-')));
  ownedFixture(t).remove(() => removeFixtureDirectory(root));
  const reservation = http.createServer();
  await listen(reservation);
  const port = reservation.address().port;
  await close(reservation);
  const worker = path.join(root, 'worker.mjs');
  const launcher = path.join(root, 'launcher.mjs');
  await fs.writeFile(
    worker,
    "import http from 'node:http'; http.createServer((req,res)=>res.end('worker')).listen(Number(process.env.APP_PORT),'127.0.0.1',()=>process.send('ready'));",
  );
  await fs.writeFile(
    launcher,
    "import { fork } from 'node:child_process'; const child=fork(process.argv[2],{stdio:['ignore','ignore','ignore','ipc']}); child.once('message',()=>process.exit(1));",
  );
  let failed;
  const failure = new Promise((resolve) => {
    failed = resolve;
  });
  let session;
  try {
    session = await startCodeAppDevServers(
      [
        {
          name: 'tree',
          dir: root,
          localAppUrl: `http://127.0.0.1:${port}`,
          devServer: {
            command: [process.execPath, launcher, worker],
            env: { APP_PORT: String(port) },
            timeoutMs: 4000,
          },
        },
      ],
      { output: () => {}, onFailure: failed },
    );
    await failure;
  } catch (error) {
    assert.match(error.message, /exited/);
  } finally {
    await session?.close();
  }
  await assert.rejects(fetch(`http://127.0.0.1:${port}`));
});

test('cancelling startup closes an owned server that never becomes ready', { timeout: 20000 }, async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'code-app-cancel-')));
  ownedFixture(t).remove(() => removeFixtureDirectory(root));
  const reservation = http.createServer();
  await listen(reservation);
  const port = reservation.address().port;
  await close(reservation);
  const childScript = path.join(root, 'waiting.mjs');
  await fs.writeFile(childScript, "console.log('waiting'); setInterval(()=>{},1000);");
  const controller = new AbortController();
  let observed;
  const started = new Promise((resolve) => {
    observed = resolve;
  });
  const pending = startCodeAppDevServers(
    [
      {
        name: 'waiting',
        dir: root,
        localAppUrl: `http://127.0.0.1:${port}`,
        devServer: { command: [process.execPath, childScript], timeoutMs: 10000 },
      },
    ],
    {
      signal: controller.signal,
      output: (text) => {
        if (text.includes('waiting')) observed();
      },
    },
  );
  ownedFixture(t).add(async () => {
    controller.abort(new Error('cancelled during fixture cleanup'));
    await pending.catch(() => {});
  });
  await started;
  controller.abort(new Error('cancelled by test'));
  await assert.rejects(pending, /cancelled|abort/i);
  await assert.rejects(fetch(`http://127.0.0.1:${port}`));
});
