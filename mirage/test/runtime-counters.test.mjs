import test from 'node:test';
import assert from 'node:assert/strict';
import { createCounters } from '../lib/runtime-counters.mjs';

test('counters increment by name, snapshot sorted copies and move tick only on a change', () => {
  const counters = createCounters();
  assert.deepEqual(counters.snapshot(), {});
  assert.equal(counters.tick, 0);
  counters.increment('webhooks.failed');
  counters.increment('storage.local.bytes', 12);
  counters.increment('storage.local.bytes', -2);
  counters.increment('storage.local.objects', 0);
  assert.equal(counters.tick, 3, 'a zero increment is not a change');
  const snapshot = counters.snapshot();
  assert.deepEqual(Object.keys(snapshot), ['storage.local.bytes', 'webhooks.failed']);
  assert.deepEqual(snapshot, { 'storage.local.bytes': 10, 'webhooks.failed': 1 });
  snapshot['webhooks.failed'] = 99;
  assert.equal(counters.get('webhooks.failed'), 1, 'the snapshot is a copy');
  assert.equal(counters.get('missing'), 0);
});
