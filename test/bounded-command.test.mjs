// @test-kind tooling: finite CLI batches retain per-command guards, cancellation and process ownership while waiting for shared execution slots.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { boundedCommand, COMMAND_HANG_GUARD_MS, RUNTIME_COMMAND_HANG_GUARD_MS } from './helpers/bounded-command.mjs';
import { STARTUP_ABSOLUTE_CAP } from '../lense/commands/mirage.mjs';
import { withProcessSlot } from '../mirage/test/process-slots.mjs';
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';

function context(t) {
  const controller = new AbortController();
  const hooks = [];
  const fixture = { signal: controller.signal, after: (hook) => hooks.push(hook) };
  let draining;
  const close = () => (draining ??= Promise.all(hooks.map((hook) => hook())));
  t.after(close);
  return { fixture, controller, close };
}

function commands() {
  const calls = [];
  const started = [];
  const execute = (_file, _args, options, callback) => {
    assert.equal(options.timeout, COMMAND_HANG_GUARD_MS);
    const child = new EventEmitter();
    Object.assign(child, { exitCode: null, signalCode: null });
    const call = {
      child,
      options,
      answer(error = null, stdout = 'result', stderr = '') {
        callback(error, stdout, stderr);
      },
      close(code = 0) {
        child.exitCode = code;
        child.emit('close', code, child.signalCode);
      },
    };
    child.kill = () => {
      child.signalCode = 'SIGTERM';
      call.answer(Object.assign(Error('aborted'), { code: 'ABORT_ERR' }));
      call.close(null);
      return true;
    };
    options.signal.addEventListener('abort', () => child.kill(), { once: true });
    calls.push(call);
    started[calls.length - 1]?.resolve(call);
    return child;
  };
  const slot = (start, _limit, options) => withProcessSlot(start, 1, options);
  return { calls, execute, slot, started };
}

test('a command keeps its slot after its callback until its process closes, then every queued command executes', async (t) => {
  const { fixture } = context(t);
  const f = commands();
  f.started[1] = Promise.withResolvers();
  const first = boundedCommand(fixture, 'invented', [], {}, f);
  const second = boundedCommand(fixture, 'invented', [], {}, f);
  assert.equal(f.calls.length, 1);
  f.calls[0].answer(null, 'first');
  await Promise.resolve();
  assert.equal(f.calls.length, 1, 'the callback does not prove that the process has closed');
  f.calls[0].close();
  await f.started[1].promise;
  f.calls[1].answer(null, 'second');
  f.calls[1].close();
  assert.deepEqual(
    (await Promise.all([first, second])).map((result) => result.stdout),
    ['first', 'second'],
  );
});

test('cancellation ends an executing child and removes queued work without starting it', async (t) => {
  const { fixture, controller } = context(t);
  const f = commands();
  const first = boundedCommand(fixture, 'invented', [], {}, f);
  const second = boundedCommand(fixture, 'invented', [], {}, f);
  const rejected = assert.rejects(second, { name: 'AbortError' });
  controller.abort();
  assert.equal((await first).error.code, 'ABORT_ERR');
  await rejected;
  assert.equal(f.calls.length, 1);
});

test('fixture cleanup drains the owned child before deleting state and preserves command diagnostics', async (t) => {
  const { fixture, close } = context(t);
  const f = commands();
  let removed = false;
  ownedFixture(fixture).remove(() => {
    removed = true;
  });
  const running = boundedCommand(fixture, 'invented', [], {}, f);
  f.calls[0].answer(Object.assign(Error('invented failure'), { code: 7 }), 'out', 'diagnostic');
  f.calls[0].child.kill = () => {
    assert.equal(removed, false);
    f.calls[0].child.signalCode = 'SIGTERM';
    return true;
  };
  const draining = close();
  await Promise.resolve();
  assert.equal(removed, false);
  f.calls[0].close(7);
  const result = await running;
  await draining;
  assert.equal(result.status, 7);
  assert.equal(result.stdout, 'out');
  assert.equal(result.stderr, 'diagnostic');
  assert.equal(removed, true);
});

test('a runtime command is ended by the guard its caller names, not by the default one', async (t) => {
  const { fixture } = context(t);
  let seen;
  const execute = (_file, _args, options, callback) => {
    seen = options.timeout;
    const child = Object.assign(new EventEmitter(), { exitCode: 0, signalCode: null });
    queueMicrotask(() => {
      callback(null, 'started', '');
      child.emit('close', 0, null);
    });
    return child;
  };
  const slot = (start, _limit, options) => withProcessSlot(start, 1, options);
  const guardMs = RUNTIME_COMMAND_HANG_GUARD_MS;
  const result = await boundedCommand(fixture, 'invented', [], {}, { execute, slot, guardMs });
  assert.equal(result.status, 0);
  assert.equal(seen, RUNTIME_COMMAND_HANG_GUARD_MS);
  assert.ok(RUNTIME_COMMAND_HANG_GUARD_MS > STARTUP_ABSOLUTE_CAP, 'above the start-up cap of mirage start');
});

test('a CI test job outlasts one hung test and its hung cleanup, so the failure is still printed', async () => {
  const { parse } = await import('yaml');
  const { readFileSync } = await import('node:fs');
  const { CLEANUP_HANG_GUARD_MS } = await import('../mirage/testing/owned-fixture.mjs');
  const { SCENARIO_HANG_GUARD_MS } = await import('./helpers/bounded-command.mjs');
  const { jobs } = parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  // The lane itself: the slowest one takes about a quarter of an hour on a hosted runner.
  const lane = 15 * 60_000;
  for (const name of ['test', 'browser', 'windows']) {
    const limit = jobs[name]['timeout-minutes'] * 60_000;
    assert.ok(limit >= SCENARIO_HANG_GUARD_MS + CLEANUP_HANG_GUARD_MS + lane, `${name}: ${limit} ms`);
  }
});
