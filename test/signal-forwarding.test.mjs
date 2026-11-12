// @test-kind contract: the shutdown signal counter gives every long-running command the same first, absorbed and forced-exit rule
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shutdownSignalCounter } from '../lense/signal-forwarding.mjs';

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
