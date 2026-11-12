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
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { startCodeAppDevServers, launchOf, CODE_APP_STARTUP_CANCELLED } from '../lense/code-app-dev-servers.mjs';
import { stopCodeAppDevServer } from '../lense/code-app-dev-stop.mjs';
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
});

test('failed startup drains already owned apps and never invokes a shell', async (t) => {
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
          devServer: { command: ['definitely-missing-code-app-command'] },
        },
      ],
      { output: () => {} },
    ),
    /could not start/,
  );
  await assert.rejects(fetch(`http://127.0.0.1:${firstPort}`));
});

test('an exited app launcher does not orphan its listening descendant', async (t) => {
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
            timeoutMs: 60_000,
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

// Starts a dev server that prints and then stays alive without answering on its port. Resolves once it has printed.
async function startSilentServer(t, prefix, name) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
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
        name,
        dir: root,
        localAppUrl: `http://127.0.0.1:${port}`,
        devServer: { command: [process.execPath, childScript], timeoutMs: 60_000 },
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
  return { port, controller, pending };
}

test('cancelling startup closes an owned server that never becomes ready', async (t) => {
  const { port, controller, pending } = await startSilentServer(t, 'code-app-cancel-', 'waiting');
  controller.abort(new Error('cancelled by test'));
  await assert.rejects(pending, /cancelled|abort/i);
  await assert.rejects(fetch(`http://127.0.0.1:${port}`));
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

test(
  'a Windows .cmd shim receives every argument verbatim through the command interpreter (win32 only)',
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
    // The controlled PATH keeps the interpreter's system directory, which the stop path needs to find taskkill.
    const system32 = path.join(process.env.SystemRoot ?? String.raw`C:\Windows`, 'System32');
    process.env.PATH = [bin, path.dirname(process.execPath), system32].join(path.delimiter);
    await assertEchoServerArguments(root, 'shim', 'http://127.0.0.1:5397/');
  },
);

// @test-kind security: a control character ends the cmd.exe line early and drops later arguments, so it must be refused before spawn.
test(
  'a .cmd shim refuses a control character in any command element before spawning, naming its 1-based position (win32 only)',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'code-app-shim-control-')));
    ownedFixture(t).remove(() => removeFixtureDirectory(root));
    const shim = path.join(root, 'x.cmd');
    await fs.writeFile(shim, '@echo off\r\n');
    const refusals = [
      [[shim, 'a\nb'], /argument 2 contains a line feed/],
      [[shim, 'a\rb'], /argument 2 contains a carriage return/],
      [[shim, 'a\0b'], /argument 2 contains a NUL/],
      [[shim, 'a', 'b\nc'], /argument 3 contains a line feed/],
    ];
    for (const [command, pattern] of refusals) assert.throws(() => launchOf(command, root), pattern);
  },
);

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
    t.after(() => {
      if (wrapper.exitCode === null && wrapper.signalCode === null)
        spawnSync('taskkill', ['/pid', String(wrapper.pid), '/t', '/f']);
    });
    wrapper.stderr.resume();
    const line = `"${launcher}"`;
    wrapper.send({
      command: [process.env.ComSpec || 'cmd.exe', '/d', '/s', '/c', `"${line}"`],
      cwd: root,
      verbatim: true,
    });
    const output = await new Promise((resolve) => {
      wrapper.stdout.once('data', (chunk) => resolve(String(chunk)));
      exited.then(() => resolve(''));
    });
    const pid = Number(/pid (\d+)/.exec(output)?.[1]);
    assert.ok(pid > 0, `the launcher reports its descendant pid, got: ${JSON.stringify(output)}`);
    wrapper.disconnect();
    await exited;
    await untilProcessGone(pid);
  },
);

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

// Grace timers are fired by the test in order, so escalation is observed without waiting on the clock.
function graceTimers() {
  const pending = [];
  return {
    pending,
    schedule: (callback) => {
      pending.push(callback);
      return () => {};
    },
    fire: () => pending.shift()(),
  };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

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
  await settle();
  timers.fire();
  await settle();
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  timers.fire();
  await rejected;
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
    await settle();
    timers.fire();
    await stopping;
    assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  },
);

test('a dev server that exits during startup is reported with its exit status, not as an abort', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'code-app-startup-exit-')));
  ownedFixture(t).remove(() => removeFixtureDirectory(root));
  const reservation = http.createServer();
  await listen(reservation);
  const port = reservation.address().port;
  await close(reservation);
  const script = path.join(root, 'exits.mjs');
  await fs.writeFile(script, "process.stdout.write('starting\\n'); process.exit(3);");
  const controller = new AbortController();
  await assert.rejects(
    startCodeAppDevServers(
      [
        {
          name: 'exiting',
          dir: root,
          localAppUrl: `http://127.0.0.1:${port}`,
          devServer: { command: [process.execPath, script], timeoutMs: 60_000 },
        },
      ],
      { signal: controller.signal, onFailure: (error) => controller.abort(error), output: () => {} },
    ),
    (error) =>
      error.message.startsWith('Code app exiting dev server exited (3). Command: ') &&
      error.message.includes('exits.mjs'),
  );
});

test('an interrupt during startup is reported as a cancellation with its own code', async (t) => {
  const { port, controller, pending } = await startSilentServer(t, 'code-app-interrupt-', 'interrupted');
  const interrupt = new Error('Code App development stopped.');
  controller.abort(interrupt);
  const error = await pending.then(
    () => assert.fail('startup must not succeed after an interrupt'),
    (failure) => failure,
  );
  assert.equal(error.code, CODE_APP_STARTUP_CANCELLED);
  assert.equal(error.cause, interrupt);
  await assert.rejects(fetch(`http://127.0.0.1:${port}`));
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
  const session = await startCodeAppDevServers(
    [
      {
        name: 'late',
        dir: '.',
        localAppUrl: 'http://127.0.0.1:5398/',
        devServer: { command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'] },
      },
    ],
    { output: () => {}, connect, sleep },
  );
  ownedFixture(t).add(() => session.close());
  assert.equal(session.owned, 1);
});

test('a server that never answers ends startup with the named hang guard and the time it waited', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const connect = (_options) => {
    const request = new EventEmitter();
    request.end = () => {
      t.mock.timers.tick(1000);
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
    { output: () => {}, connect, sleep },
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
