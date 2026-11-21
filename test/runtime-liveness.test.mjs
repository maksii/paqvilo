// @test-kind contract: a development session learns that a runtime it reused has ended, and is not misled by a dropped idle connection
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { watchRuntimeGone } from '../lense/runtime-liveness.mjs';
import { endSessionOnRuntimeExit, codeAppInterrupt, stopDevelopmentSession } from '../lense/commands/mirage.mjs';
import { captureConsoleOutput } from './helpers/mirage-session-doubles.mjs';

/** A process with a loopback listener that prints its port, as a runtime another command started would be. */
async function listeningProcess(t) {
  const child = spawn(
    process.execPath,
    [
      '-e',
      "const s=require('node:net').createServer(()=>{});s.listen(0,'127.0.0.1',()=>console.log(s.address().port));",
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  t.after(() => child.kill('SIGKILL'));
  const [line] = await once(child.stdout, 'data');
  return { child, port: Number(String(line).trim()) };
}

test('a reused runtime that is killed is reported gone, with nothing polling for it', async (t) => {
  const { child, port } = await listeningProcess(t);
  const accepted = [];
  const timers = [];
  const clock = { setTimeout: (...args) => (timers.push(args), {}), clearTimeout: () => {} };
  const watched = watchRuntimeGone(
    { pid: child.pid, url: `http://127.0.0.1:${port}` },
    {
      clock,
      connect: (options) => {
        const socket = net.connect(options);
        accepted.push(socket);
        return socket;
      },
    },
  );
  t.after(watched.stop);
  await once(accepted[0], 'connect');
  let gone = false;
  watched.gone.then(() => (gone = true));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gone, false, 'a running runtime is not reported gone');
  // The end no handler of that process can announce: the operating system closes its connections.
  child.kill('SIGKILL');
  await watched.gone;
  assert.equal(accepted.length, 1, 'one connection observed the runtime; it was not opened again');
  assert.deepEqual(timers, [], 'no timer waited for the end');
});

test('an idle connection the running runtime drops is opened again and is not an end', async (t) => {
  const connections = [];
  const sockets = [];
  const server = net.createServer((socket) => connections.push(socket));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const watched = watchRuntimeGone(
    { pid: process.pid, url: `http://127.0.0.1:${server.address().port}`, processIdentity: 'token:invented' },
    {
      identityNow: async () => 'token:invented',
      connect: (options) => {
        const socket = net.connect(options);
        sockets.push(socket);
        return socket;
      },
    },
  );
  let gone = false;
  watched.gone.then(() => (gone = true));
  await once(server, 'connection');
  const reopened = once(server, 'connection');
  connections[0].destroy();
  await reopened;
  assert.equal(gone, false);
  assert.equal(sockets.length, 2);
  watched.stop();
  await once(sockets[1], 'close');
  for (const socket of connections) socket.destroy();
  assert.equal(gone, false, 'stopping the observation reports nothing');
});

test('a process number that another program holds now means the recorded runtime is gone', async (t) => {
  const server = net.createServer((socket) => socket.destroy());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const asked = [];
  const watched = watchRuntimeGone(
    { pid: process.pid, url: `http://127.0.0.1:${server.address().port}`, processIdentity: 'token:recorded' },
    { identityNow: async (pid, recorded) => (asked.push([pid, recorded]), 'another process') },
  );
  await watched.gone;
  assert.deepEqual(asked, [[process.pid, 'token:recorded']]);
});

test('a running runtime whose listener refuses connections is looked at again later, not declared gone', async () => {
  const timers = [];
  const clock = { setTimeout: (fire, ms) => (timers.push({ fire, ms }), { unref() {} }), clearTimeout: () => {} };
  const opened = [];
  const connect = () => {
    const socket = Object.assign(new EventEmitter(), { destroy() {}, unref() {} });
    opened.push(socket);
    return socket;
  };
  let running = true;
  const watched = watchRuntimeGone(
    { pid: 4321, url: 'http://127.0.0.1:4100/' },
    { connect, clock, alive: () => running },
  );
  let gone = false;
  watched.gone.then(() => (gone = true));
  opened[0].emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
  opened[0].emit('close');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gone, false);
  assert.deepEqual(
    timers.map(({ ms }) => ms),
    [1000],
  );
  running = false;
  timers[0].fire();
  opened[1].emit('close');
  await watched.gone;
  assert.equal(opened.length, 2);
});

test('a development session on a reused runtime ends, and says why, when that runtime is gone', async (t) => {
  const saved = process.exitCode;
  t.after(() => {
    process.exitCode = saved;
  });
  process.exitCode = undefined;
  const gone = Promise.withResolvers();
  let stops = 0;
  const watch = (session) => {
    assert.equal(session.pid, 4321);
    return { gone: gone.promise, stop: () => void stops++ };
  };
  const session = { started: false, pid: 4321, url: 'http://127.0.0.1:4100/', log: 'invented-startup.log' };
  const { controller, runtimeEnded, runtimeStopped } = codeAppInterrupt();
  const runtime = endSessionOnRuntimeExit(session, controller, runtimeEnded, { watch });
  const { output, restore } = captureConsoleOutput();
  try {
    gone.resolve();
    await gone.promise;
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    restore();
  }
  assert.equal(controller.signal.aborted, true, 'the development run ends through its abort signal');
  assert.equal(runtimeStopped(), true);
  assert.deepEqual(output.logs, [
    'mirage   http://127.0.0.1:4100/ (pid 4321) is no longer running; ending this development session',
    'mirage   see the runtime log: invented-startup.log',
  ]);
  assert.equal(process.exitCode, 1);
  // The teardown ends the observation and, for a runtime it did not start, stops nothing.
  await stopDevelopmentSession(null, session, {}, 'hint', {
    runtime,
    stopSessions: async () => assert.fail('a reused runtime is not stopped by the session'),
  });
  assert.equal(stops, 1);
});

test('a session that ends first stops observing its reused runtime and reports nothing about it', async () => {
  const gone = Promise.withResolvers();
  let stops = 0;
  const session = { started: false, pid: 4321, url: 'http://127.0.0.1:4100/' };
  const { controller, runtimeEnded } = codeAppInterrupt();
  const runtime = endSessionOnRuntimeExit(session, controller, runtimeEnded, {
    watch: () => ({ gone: gone.promise, stop: () => void stops++ }),
  });
  const { output, restore } = captureConsoleOutput();
  try {
    await stopDevelopmentSession(null, session, {}, 'hint', { runtime });
    gone.resolve();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    restore();
  }
  assert.equal(stops, 1);
  assert.deepEqual(output.logs, []);
  assert.equal(controller.signal.aborted, false);
});

test('a runtime this command started is observed through its process, not through a connection', () => {
  const session = { started: true, pid: 4321, url: 'http://127.0.0.1:4100/', exited: new Promise(() => {}) };
  const { controller, runtimeEnded } = codeAppInterrupt();
  endSessionOnRuntimeExit(session, controller, runtimeEnded, {
    watch: () => assert.fail('a started runtime needs no connection'),
  });
});
