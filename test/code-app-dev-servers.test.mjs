// @test-kind contract: Code App dev-server supervision (startup, readiness, ownership, shutdown) designed by Paqvilo.
// Startup has no elapsed-time deadline: readiness, a child failure or cancellation ends it. A missing command reports
// "could not start" only after the Windows launcher wrapper (a Node process) has started. The start-up hang guard
// (CODE_APP_START_HANG_GUARD_MS, or devServer.timeoutMs) is the only bound on a server that never answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter, once } from 'node:events';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { startCodeAppDevServers, launchOf, CODE_APP_STARTUP_CANCELLED } from '../lense/code-app-dev-servers.mjs';
import { stopCodeAppDevServer } from '../lense/code-app-dev-stop.mjs';
import { runWrapper } from '../lense/code-app-dev-wrapper.mjs';
import { childStdioGate, assertChildStdioDrain } from '../test-browser/helpers/child-stdio-gate.mjs';
import { ownedFixture, removeFixtureDirectory } from '../mirage/testing/owned-fixture.mjs';

const CLI_HANG_GUARD_MS = 170_000; // hang guard only: a blocked synchronous child cannot be ended by the test runner

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const close = (server) => {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
};

test('Code App shutdown waits for actual stdio closure after its owner exits', async (t) => {
  const child = spawn(process.execPath, ['-e', 'process.stdout.write("owned-output")'], {
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const gate = childStdioGate(t, child);
  await assertChildStdioDrain(gate, stopCodeAppDevServer);
  assert.equal(child.stdout.destroyed && child.stderr.destroyed, true, 'both pipes are closed after the stop');
});

// @test-kind security: loopback-only readiness probing; refused destinations are never requested.
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

test('every loopback spelling reaches the readiness check, including 127.x and *.localhost', async () => {
  const connected = [];
  const connect = (options, onResponse) => {
    connected.push(options);
    const request = new EventEmitter();
    request.end = () => onResponse({ statusCode: 200, destroy() {} });
    return request;
  };
  const lookup = async () => [{ address: '127.0.0.1', family: 4 }];
  for (const localAppUrl of ['http://127.0.0.2:5299/', 'http://app.localhost:5299/']) {
    const output = [];
    const session = await startCodeAppDevServers(
      [{ name: 'loop', dir: '.', localAppUrl, devServer: { command: ['must-not-start'] } }],
      { output: (text) => output.push(text), lookup, connect },
    );
    assert.match(output.join(''), /using existing/);
    await session.close();
  }
  assert.deepEqual(
    connected.map((options) => [options.hostname, options.headers.host]),
    [
      ['127.0.0.2', '127.0.0.2:5299'],
      ['127.0.0.1', 'app.localhost:5299'],
    ],
  );
});

test('apps that declare the same loopback listener are refused before any server starts or is probed', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'code-app-shared-listener-')));
  ownedFixture(t).remove(() => removeFixtureDirectory(root));
  const marker = path.join(root, 'started');
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let probes = 0;
  globalThis.fetch = async () => {
    probes += 1;
    return new Response(null, { status: 200 });
  };
  const command = [process.execPath, '-e', "require('node:fs').writeFileSync(process.env.MARKER, '')"];
  const apps = [
    {
      name: 'alpha',
      dir: root,
      localAppUrl: 'http://127.0.0.1:5199/',
      devServer: { command, env: { MARKER: marker } },
    },
    { name: 'beta', dir: root, localAppUrl: 'http://localhost:5199/', devServer: { command, env: { MARKER: marker } } },
  ];
  await assert.rejects(
    startCodeAppDevServers(apps, { output: () => {} }),
    /share the dev server http:\/\/localhost:5199/,
  );
  assert.equal(probes, 0);
  await assert.rejects(fs.access(marker));
});

test('apps without a devServer are not refused for loopback spellings or a shared user-run listener', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let probes = 0;
  globalThis.fetch = async () => {
    probes += 1;
    return new Response(null, { status: 200 });
  };
  const output = [];
  const result = await startCodeAppDevServers(
    [
      { name: 'gamma', dir: '.', localAppUrl: 'http://127.0.0.2:5299/' },
      { name: 'delta', dir: '.', localAppUrl: 'http://localhost:5300/' },
      { name: 'epsilon', dir: '.', localAppUrl: 'http://localhost:5300/' },
    ],
    { output: (text) => output.push(text) },
  );
  assert.deepEqual(output, []);
  assert.equal(probes, 0);
  assert.equal(result.owned, 0);
  await result.close();
});

// @test-kind security: readiness never follows a redirect to another listener.
test('readiness does not follow a configured loopback listener redirect', async (t) => {
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
          devServer: { command: ['definitely-missing-code-app-command'] },
        },
      ],
      { output: () => {} },
    ),
    /could not start/,
  );
  assert.equal(redirected, 0);
});

test('readiness probing releases a response whose body does not finish', async (t) => {
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

// @test-kind security: unsafe starting paths are rejected before a runtime opens.
test('mirage rejects unsafe starting paths before opening a runtime', () => {
  const cli = fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url));
  for (const value of ['https://example.test/', '//example.test/', '/\\example.test/', '/bad\npath']) {
    const result = spawnSync(process.execPath, [cli, 'mirage', 'dev', '--path', value], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_HANG_GUARD_MS,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /origin-relative path/);
  }
});

test('multiple app servers start, reuse external listeners and stop only owned children', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'code-app-supervisor-')));
  ownedFixture(t).remove(() => removeFixtureDirectory(root));
  const external = http.createServer((_req, res) => res.end('external'));
  await listen(external);
  ownedFixture(t).add(() => close(external));
  // The owned app must really listen, so its port is reserved and released a moment before it starts. This is the only
  // test that keeps a real listener: it asserts that the started app answers, which a stand-in cannot show.
  const reservation = http.createServer();
  await listen(reservation);
  const port = reservation.address().port;
  await close(reservation);
  const script = path.join(root, 'server.mjs');
  await fs.writeFile(
    script,
    "import http from 'node:http'; http.createServer((req,res)=>res.end(JSON.stringify({ app: process.env.PAQVILO_CODE_APP, origin: process.env.PAQVILO_MIRAGE_URL }))).listen(Number(process.env.APP_PORT),'127.0.0.1');",
  );
  const children = [];
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
  const session = await startCodeAppDevServers(apps, {
    output: () => {},
    mirageUrl: 'http://127.0.0.1:4321',
    spawnChild: observedSpawn(children),
  });
  ownedFixture(t).add(() => session.close());
  assert.equal(session.owned, 1);
  assert.deepEqual(await (await fetch(apps[1].localAppUrl)).json(), {
    app: 'owned',
    origin: 'http://127.0.0.1:4321',
  });
  await session.close();
  await children[0].closed;
  assert.ok(children[0].child.exitCode !== null || children[0].child.signalCode !== null, 'the owned child has exited');
  assert.equal(await (await fetch(apps[0].localAppUrl)).text(), 'external');
});

test('failed startup drains already owned apps and never invokes a shell', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'code-app-supervisor-fail-')));
  ownedFixture(t).remove(() => removeFixtureDirectory(root));
  const script = path.join(root, 'first.mjs');
  await fs.writeFile(script, 'setInterval(() => {}, 1000);');
  const children = [];
  // The first app is ready once it has been started; the missing app's address never answers.
  const connect = answersWhen((port) => port === 5387 && children.length > 0);
  await assert.rejects(
    startCodeAppDevServers(
      [
        {
          name: 'first',
          dir: root,
          localAppUrl: 'http://127.0.0.1:5387/',
          devServer: { command: [process.execPath, script] },
        },
        {
          name: 'missing',
          dir: root,
          localAppUrl: 'http://127.0.0.1:5386/',
          devServer: { command: ['definitely-missing-code-app-command'] },
        },
      ],
      { output: () => {}, connect, spawnChild: observedSpawn(children) },
    ),
    /could not start/,
  );
  assert.ok(
    children[0].child.exitCode !== null || children[0].child.signalCode !== null,
    'the owned first app was drained before startup rejected',
  );
  await children[0].closed;
});

test('an exited app launcher does not orphan its descendant', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'code-app-tree-')));
  ownedFixture(t).remove(() => removeFixtureDirectory(root));
  const worker = path.join(root, 'worker.mjs');
  const launcher = path.join(root, 'launcher.mjs');
  // The worker reports its pid on the output the launcher passes through, and keeps running until it is ended.
  await fs.writeFile(
    worker,
    "console.log(`worker ${process.pid}`); process.send('ready'); setInterval(() => {}, 1000);",
  );
  await fs.writeFile(
    launcher,
    "import { fork } from 'node:child_process'; const child=fork(process.argv[2],{stdio:['ignore','inherit','inherit','ipc']}); child.once('message',()=>process.exit(1));",
  );
  const output = [];
  await assert.rejects(
    startCodeAppDevServers(
      [
        {
          name: 'tree',
          dir: root,
          localAppUrl: 'http://127.0.0.1:5385/',
          devServer: { command: [process.execPath, launcher, worker], timeoutMs: 60_000 },
        },
      ],
      { output: (text) => output.push(text), connect: refuseAll },
    ),
    /dev server exited/,
  );
  const pid = Number(/worker (\d+)/.exec(output.join(''))?.[1]);
  assert.ok(pid > 0, `the worker reports its pid, got: ${JSON.stringify(output.join(''))}`);
  await untilProcessGone(pid);
});

// The start-up loop waits through `sleep`. The double reports its first wait and holds it until the test releases it. A
// second wait means the child's report did not end startup, so it is refused and the test fails rather than hangs.
function heldFirstPoll() {
  let polls = 0;
  let markHeld;
  let release;
  const held = new Promise((resolve) => {
    markHeld = resolve;
  });
  const released = new Promise((resolve) => {
    release = resolve;
  });
  return {
    held,
    release: () => release(),
    sleep: () => {
      polls += 1;
      if (polls > 1) return Promise.reject(new Error('startup polled again after the child reported'));
      markHeld();
      return released;
    },
  };
}

// Starts one app whose launch is wrapped (the Windows path) with a fake child, then delivers `message` from the child.
// The child reports its message and its close while startup waits, so the test controls every step.
async function startWrappedFake(message) {
  const children = [];
  const polls = heldFirstPoll();
  const starting = startCodeAppDevServers(
    [
      {
        name: 'wrapped',
        dir: os.tmpdir(),
        localAppUrl: 'http://127.0.0.1:5390/',
        devServer: { command: ['invented-code-app-tool', '--flag'] },
      },
    ],
    {
      platform: 'win32',
      output: () => {},
      connect: refuseAll,
      sleep: polls.sleep,
      spawnChild: () => {
        const child = fakeChild();
        children.push(child);
        return child;
      },
    },
  );
  await Promise.race([polls.held, starting]);
  const [child] = children;
  child.emit('message', message);
  child.emit('close');
  polls.release();
  return { child, starting };
}

test('a wrapped launch reports its exit as the startup failure and sends the command once', async () => {
  const { child, starting } = await startWrappedFake({ type: 'exit', code: 3 });
  await assert.rejects(starting, (error) => error.message.startsWith('Code app wrapped dev server exited (3)'));
  const cwd = await fs.realpath(os.tmpdir());
  assert.deepEqual(child.sent, [{ command: ['invented-code-app-tool', '--flag'], verbatim: false, cwd }]);
});

test('a wrapped launch that reports a spawn error fails startup naming the error', async () => {
  const { starting } = await startWrappedFake({ type: 'error', message: 'invented' });
  await assert.rejects(starting, /could not start: invented/);
});

// A wrapper double: an EventEmitter with the IPC members the wrapper uses. `sent` records each report to the
// supervisor.
function wrapperSource() {
  const source = new EventEmitter();
  source.connected = true;
  source.sent = [];
  source.send = (message) => source.sent.push(message);
  return source;
}

// Runs the wrapper on `source` and delivers the supervisor's launch message. The spawn double records its child and the
// stop double records each child it is asked to end.
function startWrapper(source) {
  const children = [];
  const stops = [];
  runWrapper({
    source,
    spawnChild: () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
    stop: (child) => {
      stops.push(child);
      return Promise.resolve();
    },
  });
  source.emit('message', { command: ['invented-wrapped-tool'], cwd: '.', verbatim: false });
  const [child] = children;
  return { child, stops };
}

test('the wrapper reports its child exit while the supervisor is connected', () => {
  const source = wrapperSource();
  const { child } = startWrapper(source);
  child.emit('exit', 3, null);
  assert.deepEqual(source.sent, [{ type: 'exit', code: 3, signal: null }]);
});

test('the wrapper ends a live child once when the supervisor disconnects', () => {
  const source = wrapperSource();
  const { child, stops } = startWrapper(source);
  source.connected = false;
  source.emit('disconnect');
  assert.deepEqual(stops, [child]);
});

test('the wrapper does not end a child that has already exited when the supervisor disconnects', () => {
  const source = wrapperSource();
  const { child, stops } = startWrapper(source);
  child.exitCode = 0;
  child.emit('exit', 0, null);
  source.connected = false;
  source.emit('disconnect');
  assert.deepEqual(stops, []);
});

test('the wrapper sends nothing to the supervisor after it disconnects', () => {
  const source = wrapperSource();
  const { child } = startWrapper(source);
  source.connected = false;
  source.emit('disconnect');
  child.emit('exit', 1, null);
  assert.deepEqual(source.sent, []);
});

// Readiness double for tests that never open a socket: a loopback port answers when `ready(port)` says so.
function answersWhen(ready) {
  return (options, onResponse) => {
    const request = new EventEmitter();
    request.end = () => {
      if (ready(Number(options.port))) onResponse({ statusCode: 200, destroy() {} });
      else request.emit('error', new Error('not listening'));
    };
    return request;
  };
}
const refuseAll = answersWhen(() => false);

// Starts real children through the real spawn and records each with its close event, created at spawn so none is missed.
function observedSpawn(children) {
  return (file, args, options) => {
    const child = spawn(file, args, options);
    children.push({ child, closed: new Promise((resolve) => child.once('close', resolve)) });
    return child;
  };
}

// A child double for logic tests. It has no pid, so the product signals nothing, and the test emits the close event that
// the product's stop waits for. The product does not end a child through child.kill(), so the double has no kill().
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.sent = [];
  child.send = (message) => child.sent.push(message);
  return child;
}

// Starts a dev server that prints and then stays alive without answering. Resolves once it has printed.
async function startSilentServer(t, prefix, name) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  ownedFixture(t).remove(() => removeFixtureDirectory(root));
  const childScript = path.join(root, 'waiting.mjs');
  await fs.writeFile(childScript, "console.log('waiting'); setInterval(()=>{},1000);");
  const controller = new AbortController();
  let observed;
  const started = new Promise((resolve) => {
    observed = resolve;
  });
  const children = [];
  const pending = startCodeAppDevServers(
    [
      {
        name,
        dir: root,
        localAppUrl: 'http://127.0.0.1:5389/',
        devServer: { command: [process.execPath, childScript], timeoutMs: 60_000 },
      },
    ],
    {
      signal: controller.signal,
      connect: refuseAll,
      spawnChild: observedSpawn(children),
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
  return { controller, pending, ...children[0] };
}

test('cancelling startup closes an owned server that never becomes ready', async (t) => {
  const { controller, pending, child, closed } = await startSilentServer(t, 'code-app-cancel-', 'waiting');
  controller.abort(new Error('cancelled by test'));
  await assert.rejects(pending, /cancelled|abort/i);
  await closed;
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'the owned child has exited');
});

// The launched command writes its received arguments; readiness is granted only once that file exists.
const ECHO_SCRIPT = `const fs = require('node:fs');
const target = process.env.ECHO_OUT;
fs.writeFileSync(target + '.tmp', JSON.stringify(process.argv.slice(2)));
fs.renameSync(target + '.tmp', target);
setInterval(() => {}, 1000);
`;
function probeAfterFile(file) {
  return (_options, onResponse) => {
    const request = new EventEmitter();
    request.end = () => {
      if (existsSync(file)) onResponse({ statusCode: 200, destroy() {} });
      else request.emit('error', new Error('not written yet'));
    };
    return request;
  };
}
const ARGUMENTS = [
  'a b',
  'x&y',
  'say "hi"',
  '%PATH%',
  'c^d',
  'e|f',
  'trail\\',
  '(p)',
  '!bang',
  '& echo pwned > marker.txt',
];
// Each ARGUMENTS entry as it appears in the .cmd command line: escaped for cmd.exe, then escaped again for the shim's own
// argument parsing. The order matches ARGUMENTS.
const ESCAPED_ARGUMENTS = [
  String.raw`^^^"a^^^ b^^^"`,
  String.raw`^^^"x^^^&y^^^"`,
  String.raw`^^^"say^^^ \^^^"hi\^^^"^^^"`,
  String.raw`^^^"^^^%PATH^^^%^^^"`,
  String.raw`^^^"c^^^^d^^^"`,
  String.raw`^^^"e^^^|f^^^"`,
  String.raw`^^^"trail\\^^^"`,
  String.raw`^^^"^^^(p^^^)^^^"`,
  String.raw`^^^"^^^!bang^^^"`,
  String.raw`^^^"^^^&^^^ echo^^^ pwned^^^ ^^^>^^^ marker.txt^^^"`,
];

// Runs the echo command as a dev server, then checks the arguments it received and that no marker file was written.
async function assertEchoServerArguments(root, name, localAppUrl) {
  const echoed = path.join(root, 'echoed.json');
  const session = await startCodeAppDevServers(
    [
      {
        name,
        dir: root,
        localAppUrl,
        devServer: { command: ['tool', ...ARGUMENTS], env: { ECHO_OUT: echoed } },
      },
    ],
    { output: () => {}, connect: probeAfterFile(echoed) },
  );
  try {
    assert.deepEqual(JSON.parse(await fs.readFile(echoed, 'utf8')), ARGUMENTS);
    await assert.rejects(fs.access(path.join(root, 'marker.txt')));
  } finally {
    await session.close();
  }
}

// Runs a real .cmd shim through cmd.exe. The command line it is given is checked on every OS by the escaping test.
test(
  'a real .cmd shim runs through cmd.exe and receives every argument verbatim (runs a real shim; win32 only)',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'code-app-shim-')));
    ownedFixture(t).remove(() => removeFixtureDirectory(root));
    const bin = path.join(root, 'bin');
    await fs.mkdir(bin);
    await fs.writeFile(path.join(bin, 'tool.cmd'), '@echo off\r\nnode "%~dp0echo.js" %*\r\n');
    await fs.writeFile(path.join(bin, 'echo.js'), ECHO_SCRIPT);
    const originalPath = process.env.PATH;
    t.after(() => {
      process.env.PATH = originalPath;
    });
    process.env.PATH = [bin, path.dirname(process.execPath)].join(path.delimiter);
    await assertEchoServerArguments(root, 'shim', 'http://127.0.0.1:5397/');
  },
);

// @test-kind security: a control character ends the cmd.exe line early and drops later arguments, so it must be refused before spawn.
test('a .cmd shim refuses a control character in any command element before spawning, naming its 1-based position', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'code-app-shim-control-')));
  ownedFixture(t).remove(() => removeFixtureDirectory(root));
  const shim = path.join(root, 'x.cmd');
  await fs.writeFile(shim, '@echo off\r\n');
  const windows = { platform: 'win32', env: { PATH: '', PATHEXT: '.CMD' } };
  const refusals = [
    [[shim, 'a\nb'], /argument 2 contains a line feed/],
    [[shim, 'a\rb'], /argument 2 contains a carriage return/],
    [[shim, 'a\0b'], /argument 2 contains a NUL/],
    [[shim, 'a', 'b\nc'], /argument 3 contains a line feed/],
  ];
  for (const [command, pattern] of refusals) assert.throws(() => launchOf(command, root, windows), pattern);
});

// @test-kind contract: a resolved .cmd shim runs through cmd.exe, each argument escaped for cmd.exe and then for the shim.
test('a .cmd shim command line names the resolved file and escapes every verbatim argument twice', () => {
  const shim = path.join('bin', 'tool.CMD');
  const comSpec = String.raw`C:\invented\cmd.exe`;
  const launch = launchOf(['tool', ...ARGUMENTS], os.tmpdir(), {
    platform: 'win32',
    env: { PATH: 'bin', PATHEXT: '.CMD', ComSpec: comSpec },
    isFile: (file) => file === shim,
  });
  const line = [shim, ...ESCAPED_ARGUMENTS].join(' ');
  assert.deepEqual(launch.message, {
    command: [comSpec, '/d', '/s', '/c', `"${line}"`],
    verbatim: true,
  });
});

// @test-kind security: a control character is only a shim hazard, so a plain executable keeps its arguments exactly as given.
test('a non-shim executable keeps a newline argument unchanged in its launch descriptor', () => {
  const command = [process.execPath, 'a\nb'];
  const launch = launchOf(command, os.tmpdir());
  const argv = launch.message ? launch.message.command : [launch.file, ...launch.args];
  assert.deepEqual(argv, command);
});

test(
  'a Windows launcher under the wrapper ends its process tree when the wrapper parent disconnects (win32 only)',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'code-app-wrapper-')));
    ownedFixture(t).remove(() => removeFixtureDirectory(root));
    await fs.writeFile(
      path.join(root, 'report.js'),
      'process.stdout.write(`pid ${process.pid}\\n`);\nsetInterval(() => {}, 1000);\n',
    );
    const launcher = path.join(root, 'launch.cmd');
    await fs.writeFile(launcher, `@echo off\r\n"${process.execPath}" "%~dp0report.js"\r\n`);
    const wrapperFile = fileURLToPath(new URL('../lense/code-app-dev-wrapper.mjs', import.meta.url));
    const wrapper = spawn(process.execPath, [wrapperFile], {
      cwd: root,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const exited = new Promise((resolve) => wrapper.once('exit', resolve));
    const closed = new Promise((resolve) => wrapper.once('close', resolve));
    // Only a failed assertion leaves the wrapper running here; the product's own stop then ends its tree.
    t.after(() => {
      if (wrapper.exitCode === null && wrapper.signalCode === null) return stopCodeAppDevServer(wrapper, closed);
    });
    wrapper.stderr.resume();
    const line = `"${launcher}"`;
    wrapper.send({
      command: [process.env.ComSpec || 'cmd.exe', '/d', '/s', '/c', `"${line}"`],
      cwd: root,
      verbatim: true,
    });
    // A pid is read from a complete line only: a data chunk may end inside the number.
    const lines = createInterface({ input: wrapper.stdout });
    const [report = ''] = await Promise.race([once(lines, 'line'), exited.then(() => [])]);
    const pid = Number(/pid (\d+)/.exec(report)?.[1]);
    assert.ok(pid > 0, `the launcher reports its descendant pid, got: ${JSON.stringify(report)}`);
    wrapper.disconnect();
    await exited;
    await untilProcessGone(pid);
  },
);

test('the wrapper runs its launch when started through a linked path', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'code-app-linked-')));
  const link = path.join(root, 'linked');
  // A directory link (a junction on Windows) to the lense folder. Only the link is removed, and never recursively.
  await fs.symlink(fileURLToPath(new URL('../lense', import.meta.url)), link, 'junction');
  const wrapper = spawn(process.execPath, [path.join(link, 'code-app-dev-wrapper.mjs')], {
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const exited = new Promise((resolve) => wrapper.once('exit', resolve));
  t.after(async () => {
    if (wrapper.connected) wrapper.disconnect();
    await exited;
    await fs.rm(link, { force: true });
    await fs.rmdir(root);
  });
  const reported = new Promise((resolve) => wrapper.once('message', resolve));
  wrapper.send({ command: [process.execPath, '-e', ''], cwd: process.cwd(), verbatim: false });
  const report = await reported;
  assert.deepEqual(report, { type: 'exit', code: 0, signal: null });
});

// The launcher's descendant is not a child of this process, so it has no exit event; the wait ends when the pid is gone.
async function untilProcessGone(pid) {
  while (processExists(pid)) await new Promise((resolve) => setTimeout(resolve, 50));
}
function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

test(
  'a POSIX command runs directly from PATH with its arguments unchanged (skipped on win32)',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'code-app-direct-')));
    ownedFixture(t).remove(() => removeFixtureDirectory(root));
    const bin = path.join(root, 'bin');
    await fs.mkdir(bin);
    await fs.writeFile(path.join(bin, 'echo.js'), ECHO_SCRIPT);
    await fs.writeFile(
      path.join(bin, 'tool'),
      `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/echo.js" "$@"\n`,
      { mode: 0o755 },
    );
    const originalPath = process.env.PATH;
    t.after(() => {
      process.env.PATH = originalPath;
    });
    process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
    await assertEchoServerArguments(root, 'direct', 'http://127.0.0.1:5396/');
  },
);

// Grace timers are fired by the test in order, so escalation is observed without waiting on the clock. `armed(n)` resolves
// when the product has armed its n-th grace timer, so a test waits for that call rather than for a turn of the event loop.
function graceTimers() {
  const pending = [];
  const waiting = [];
  const delays = [];
  let armedCount = 0;
  return {
    delays,
    schedule: (callback, ms) => {
      pending.push(callback);
      delays.push(ms);
      armedCount += 1;
      for (const check of waiting.splice(0)) check();
      return () => {};
    },
    armed: (count) =>
      new Promise((resolve) => {
        const check = () => {
          if (armedCount >= count) resolve();
          else waiting.push(check);
        };
        check();
      }),
    fire: () => pending.shift()(),
  };
}

test('stop escalates from SIGTERM to SIGKILL only after the grace period expires', async () => {
  const signals = [];
  let closeChild;
  const closed = new Promise((resolve) => {
    closeChild = resolve;
  });
  const timers = graceTimers();
  const kill = (pid, signal) => {
    signals.push([pid, signal]);
    if (signal === 'SIGKILL') closeChild();
  };
  const stopping = stopCodeAppDevServer({ pid: 4321 }, closed, { platform: 'linux', kill, schedule: timers.schedule });
  assert.deepEqual(signals, [[-4321, 'SIGTERM']]);
  timers.fire();
  await stopping;
  assert.deepEqual(signals, [
    [-4321, 'SIGTERM'],
    [-4321, 'SIGKILL'],
  ]);
});

test('stop never sends SIGKILL to a child that closes after SIGTERM', async () => {
  const signals = [];
  let closeChild;
  const closed = new Promise((resolve) => {
    closeChild = resolve;
  });
  const kill = (_pid, signal) => {
    signals.push(signal);
    if (signal === 'SIGTERM') closeChild();
  };
  await stopCodeAppDevServer({ pid: 4321 }, closed, { platform: 'linux', kill, schedule: graceTimers().schedule });
  assert.deepEqual(signals, ['SIGTERM']);
});

test('stop rejects naming the pid only after SIGKILL also fails to close the streams', async () => {
  const signals = [];
  const timers = graceTimers();
  const kill = (_pid, signal) => signals.push(signal);
  const stopping = stopCodeAppDevServer({ pid: 4321 }, new Promise(() => {}), {
    platform: 'linux',
    kill,
    schedule: timers.schedule,
  });
  const rejected = assert.rejects(stopping, /pid 4321 did not close its output streams/);
  await timers.armed(1);
  timers.fire();
  await timers.armed(2);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  // The first wait is the grace period; the last wait after SIGKILL is the hang guard, not the grace period.
  assert.deepEqual(timers.delays, [5000, 60000]);
  timers.fire();
  await rejected;
});

// @test-kind contract: on POSIX a process group that already ended is not an error, while any other signal failure is.
test('the POSIX stop treats an ended process group as stopped and rethrows other signal failures', async () => {
  const signals = [];
  const ended = Object.assign(new Error('no such process'), { code: 'ESRCH' });
  const kill = (_pid, signal) => {
    signals.push(signal);
    throw ended;
  };
  await stopCodeAppDevServer({ pid: 4321 }, Promise.resolve(), {
    platform: 'linux',
    kill,
    schedule: graceTimers().schedule,
  });
  assert.deepEqual(signals, ['SIGTERM']);
  const denied = Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
  await assert.rejects(
    stopCodeAppDevServer({ pid: 4321 }, new Promise(() => {}), {
      platform: 'linux',
      kill: () => {
        throw denied;
      },
      schedule: graceTimers().schedule,
    }),
    (error) => error === denied,
  );
});

// @test-kind contract: the Windows stop asks the injected tree killer for the child's pid, then waits for its close.
test('the Windows stop ends the child tree through the injected killer and waits for its close', async () => {
  const killed = [];
  let closeChild;
  const closed = new Promise((resolve) => {
    closeChild = resolve;
  });
  const killTree = (pid) => {
    killed.push(pid);
    closeChild();
  };
  // A pid no process holds, so a run that ignores the injected killer cannot end a real process.
  const child = { pid: 2147483646, exitCode: null, signalCode: null };
  await stopCodeAppDevServer(child, closed, { platform: 'win32', killTree });
  assert.deepEqual(killed, [2147483646]);
});

test(
  'stop ends a real child that ignores SIGTERM (skipped on win32: POSIX process groups)',
  { skip: process.platform === 'win32' },
  async (t) => {
    const child = spawn(
      process.execPath,
      ['-e', "process.on('SIGTERM', () => {}); process.stdout.write('ignoring\\n'); setInterval(() => {}, 1000);"],
      { detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    ownedFixture(t).add(() => child.kill('SIGKILL'));
    const closed = new Promise((resolve) => child.once('close', resolve));
    await new Promise((resolve) => child.stdout.once('data', resolve));
    const timers = graceTimers();
    const stopping = stopCodeAppDevServer(child, closed, { schedule: timers.schedule });
    await timers.armed(1);
    timers.fire();
    await stopping;
    assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  },
);

test('a dev server that exits during startup is reported with its exit status, not as an abort', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'code-app-startup-exit-')));
  ownedFixture(t).remove(() => removeFixtureDirectory(root));
  const script = path.join(root, 'exits.mjs');
  await fs.writeFile(script, "process.stdout.write('starting\\n'); process.exit(3);");
  const controller = new AbortController();
  await assert.rejects(
    startCodeAppDevServers(
      [
        {
          name: 'exiting',
          dir: root,
          localAppUrl: 'http://127.0.0.1:5388/',
          devServer: { command: [process.execPath, script], timeoutMs: 60_000 },
        },
      ],
      {
        signal: controller.signal,
        connect: refuseAll,
        onFailure: (error) => controller.abort(error),
        output: () => {},
      },
    ),
    (error) =>
      error.message.startsWith('Code app exiting dev server exited (3). Command: ') &&
      error.message.includes('exits.mjs'),
  );
});

test('an interrupt during startup is reported as a cancellation with its own code', async (t) => {
  const { controller, pending, child, closed } = await startSilentServer(t, 'code-app-interrupt-', 'interrupted');
  const interrupt = new Error('Code App development stopped.');
  controller.abort(interrupt);
  const error = await pending.then(
    () => assert.fail('startup must not succeed after an interrupt'),
    (failure) => failure,
  );
  assert.equal(error.code, CODE_APP_STARTUP_CANCELLED);
  assert.equal(error.cause, interrupt);
  await closed;
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'the owned child has exited');
});

test('startup ends on readiness however late the server answers', async (t) => {
  // Each readiness probe and each poll pause advances the mocked clock. The server answers only after 35 s have passed,
  // so start-up waits past that point for readiness.
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const started = Date.now();
  const connect = (_options, onResponse) => {
    const request = new EventEmitter();
    request.end = () => {
      t.mock.timers.tick(1000);
      if (Date.now() - started >= 35_000) onResponse({ statusCode: 200, destroy() {} });
      else request.emit('error', new Error('not listening yet'));
    };
    return request;
  };
  const sleep = (ms) => {
    t.mock.timers.tick(ms);
    return Promise.resolve();
  };
  const child = fakeChild();
  const session = await startCodeAppDevServers(
    [
      {
        name: 'late',
        dir: '.',
        localAppUrl: 'http://127.0.0.1:5398/',
        devServer: { command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'] },
      },
    ],
    { output: () => {}, connect, sleep, spawnChild: () => child },
  );
  assert.equal(session.owned, 1);
  child.emit('close', 0, null);
  await session.close();
});

test('a server that never answers ends startup with the named hang guard and the time it waited', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const started = Date.now();
  const child = fakeChild();
  const connect = (_options) => {
    const request = new EventEmitter();
    request.end = () => {
      t.mock.timers.tick(1000);
      // The hang guard expires during this tick. The product's stop waits only for close, so the double closes here.
      if (Date.now() - started >= 120_000) child.emit('close', 0, null);
      request.emit('error', new Error('never listening'));
    };
    return request;
  };
  const sleep = (ms) => {
    t.mock.timers.tick(ms);
    return Promise.resolve();
  };
  const startup = startCodeAppDevServers(
    [
      {
        name: 'silent',
        dir: '.',
        localAppUrl: 'http://127.0.0.1:5397/',
        devServer: { command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'] },
      },
    ],
    { output: () => {}, connect, sleep, spawnChild: () => child },
  );
  ownedFixture(t).add(() =>
    startup.then(
      (session) => session.close(),
      () => {},
    ),
  );
  await assert.rejects(startup, (error) => {
    assert.match(error.message, /after waiting 120000ms\. This is the start-up hang guard/);
    return true;
  });
});
