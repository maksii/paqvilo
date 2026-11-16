// @test-kind tooling: benchmark supervision follows finite phase progress and rejects stalls, replays and incomplete work without wall-clock sleeps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { observeBenchmarkProgress } from './helpers/benchmark-progress.mjs';

function fixture() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = child.stderr.setEncoding = () => {};
  let kills = 0;
  child.kill = () => {
    kills++;
  };
  const armed = new Map(),
    history = [];
  const timers = {
    setTimeout(callback, guard) {
      assert.equal(guard, 170_000);
      const id = history.push(callback);
      armed.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      armed.delete(id);
    },
  };
  const emit = (phase, status) =>
    child.stderr.emit(
      'data',
      JSON.stringify({ type: 'benchmark-progress', phase, sample: 1, samples: 1, status }) + '\n',
    );
  const start = () => observeBenchmarkProgress(child, { phases: ['one', 'two'], guardMs: 170_000, timers });
  return {
    child,
    emit,
    start,
    history,
    armed,
    get kills() {
      return kills;
    },
  };
}

test('each real phase advances the guard, stale guards cannot cancel progress, and completion removes observers', async () => {
  const f = fixture();
  const result = f.start();
  for (const phase of ['one', 'two']) {
    for (const status of ['started', 'complete']) {
      const previous = f.history.at(-1);
      f.emit(phase, status);
      previous();
    }
  }
  f.child.stdout.emit('data', '{"complete":true}');
  f.child.emit('close', 0, null);
  assert.equal((await result).progress, 4);
  assert.equal(f.kills, 0);
  assert.equal(f.armed.size, 0);
  assert.equal(f.child.stdout.listenerCount('data'), 0);
  assert.equal(f.child.stderr.listenerCount('data'), 0);
  assert.equal(f.child.listenerCount('close'), 0);
});

test('a stalled phase is still failed and its owned process is stopped', async () => {
  const f = fixture();
  const result = f.start();
  const rejected = assert.rejects(result, /one sample 1 complete.*170000 ms guard/);
  f.emit('one', 'started');
  f.history.at(-1)();
  await rejected;
  assert.equal(f.kills, 1);
  assert.equal(f.armed.size, 0);
});

test('repeated progress cannot keep a stuck command alive and an incomplete successful exit fails', async () => {
  for (const repeated of [true, false]) {
    const f = fixture();
    const result = f.start();
    const rejected = assert.rejects(result, /unexpected, repeated|without completing every expected phase/);
    f.emit('one', 'started');
    if (repeated) f.emit('one', 'started');
    else f.child.emit('close', 0, null);
    await rejected;
    assert.equal(f.kills, 1);
  }
});
