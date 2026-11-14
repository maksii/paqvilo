// @test-kind contract: the shutdown signal counter gives every long-running command the same first, absorbed and forced-exit rule
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { forwardTerminationSignals, shutdownSignalCounter } from '../lense/signal-forwarding.mjs';

function childRecorder() {
  const kills = [];
  return { kills, child: { kill: (signal) => kills.push(signal) } };
}

function counterWithRecords() {
  const records = { first: [], lines: [], exits: [] };
  const onSignal = shutdownSignalCounter({
    onFirst: (signal) => records.first.push(signal),
    write: (line) => records.lines.push(line),
    exit: (code) => records.exits.push(code),
  });
  return { onSignal, records };
}

test('the first shutdown signal runs the first-signal action once with its name', () => {
  const { onSignal, records } = counterWithRecords();
  onSignal('SIGINT');
  assert.deepEqual(records.first, ['SIGINT']);
  assert.deepEqual(records.lines, []);
  assert.deepEqual(records.exits, []);
});

test('a second shutdown signal is absorbed without running the first-signal action again', () => {
  const { onSignal, records } = counterWithRecords();
  onSignal('SIGINT');
  onSignal('SIGTERM');
  assert.deepEqual(records.first, ['SIGINT']);
  assert.deepEqual(records.lines, []);
  assert.deepEqual(records.exits, []);
});

test('a third SIGINT writes the forced-exit line and exits with 130', () => {
  const { onSignal, records } = counterWithRecords();
  onSignal('SIGINT');
  onSignal('SIGINT');
  onSignal('SIGINT');
  assert.deepEqual(records.first, ['SIGINT']);
  assert.deepEqual(records.lines, ['Forced exit: cleanup did not finish.']);
  assert.deepEqual(records.exits, [130]);
});

test('a third SIGTERM exits with 143 and the first-signal action is not run again', () => {
  const { onSignal, records } = counterWithRecords();
  onSignal('SIGTERM');
  onSignal('SIGTERM');
  onSignal('SIGTERM');
  assert.deepEqual(records.first, ['SIGTERM']);
  assert.deepEqual(records.lines, ['Forced exit: cleanup did not finish.']);
  assert.deepEqual(records.exits, [143]);
});

test('on POSIX a terminal SIGINT is not forwarded to the child, because the process group already delivers it', () => {
  const source = new EventEmitter();
  const { kills, child } = childRecorder();
  const stop = forwardTerminationSignals(child, { platform: 'linux', source });
  source.emit('SIGINT');
  assert.deepEqual(kills, []);
  stop();
  assert.equal(source.listenerCount('SIGINT'), 0);
  assert.equal(source.listenerCount('SIGTERM'), 0);
});

test('on POSIX a SIGTERM is forwarded to the child exactly once with the same signal', () => {
  const source = new EventEmitter();
  const { kills, child } = childRecorder();
  const stop = forwardTerminationSignals(child, { platform: 'linux', source });
  source.emit('SIGTERM');
  assert.deepEqual(kills, ['SIGTERM']);
  stop();
});

test('on Windows neither SIGINT nor SIGTERM is forwarded to the child', () => {
  const source = new EventEmitter();
  const { kills, child } = childRecorder();
  const stop = forwardTerminationSignals(child, { platform: 'win32', source });
  source.emit('SIGINT');
  source.emit('SIGTERM');
  assert.deepEqual(kills, []);
  stop();
});
