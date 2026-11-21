// @test-kind contract: Paqvilo's acceptance runner rules for requests a document replacement ends, on invented records
import test from 'node:test';
import assert from 'node:assert/strict';
import { cancelNavigationRequests } from '../lib/navigation-cancellations.mjs';
import { simulatorBackgroundRequest } from '../acceptance-api.mjs';

test('detached document requests without terminal events leave pending and retain cancellation evidence', () => {
  const requests = Array.from({ length: 2 }, () => ({ failure: () => null }));
  const records = new Map(
    requests.map((request, i) => [
      request,
      { order: i + 1, method: i ? 'POST' : 'PATCH', url: `http://127.0.0.1:8787/synthetic/${i}`, started: 100 },
    ]),
  );
  const pending = new Map(records);
  const unrelated = { failure: () => null };
  pending.set(unrelated, { method: 'GET' });
  const cancelled = cancelNavigationRequests(requests, pending, records, { reason: 'frame-detached', at: 185 });
  assert.equal(pending.size, 1);
  assert.equal(pending.has(unrelated), true);
  assert.equal(cancelled.length, 2);
  assert.equal(cancelled[0].at, new Date(185).toISOString());
  assert.equal(records.get(requests[0]).durationMs, 85);
  assert.equal(cancelNavigationRequests(requests, pending, records, { reason: 'frame-detached' }).length, 0);
});

test('a wall clock step between the request and its cancellation does not change its duration', () => {
  const request = { failure: () => null };
  const record = { order: 1, method: 'GET', url: 'http://127.0.0.1:8787/synthetic', started: 100 };
  Object.defineProperty(record, 'startedTicks', { value: 5000 });
  const records = new Map([[request, record]]);
  // Cancelled 85 ms later on the runner's monotonic clock, after the wall clock stepped back 1.2 s.
  cancelNavigationRequests([request], new Map(records), records, { reason: 'frame-detached', at: -1015, ticks: 5085 });
  assert.equal(record.durationMs, 85);
  assert.equal(
    record.navigationCancellation.at,
    new Date(-1015).toISOString(),
    'the reported time stays the wall time',
  );
});

test('document replacement never disguises completed HTTP errors or unrelated network failures', () => {
  const finished = { failure: () => null },
    httpError = { failure: () => null },
    networkError = { failure: () => ({ errorText: 'net::ERR_CONNECTION_RESET' }) };
  const records = new Map([
    [finished, { finished: true }],
    [httpError, { status: 500 }],
    [networkError, {}],
  ]);
  const pending = new Map(records);
  assert.deepEqual(
    cancelNavigationRequests([...records.keys()], pending, records, { reason: 'document-replaced' }),
    [],
  );
  assert.equal(pending.size, 3);
});

test('public background rule remains confined to exact owned loopback lifecycle paths', () => {
  const origin = 'http://127.0.0.1:8787';
  assert.equal(simulatorBackgroundRequest('/__sim/events', origin), true);
  assert.equal(simulatorBackgroundRequest('/__sim/frame-ready/12345678-1234-1234-1234-123456789abc', origin), true);
  assert.equal(
    simulatorBackgroundRequest(
      origin + '/__sim/frame-ready/12345678-1234-1234-1234-123456789abc?reason=dom-ready',
      origin,
    ),
    true,
  );
  for (const value of [
    '/__sim/events/extra',
    'https://foreign.invalid/__sim/frame-ready/12345678-1234-1234-1234-123456789abc',
    '/__sim/frame-ready/not-a-token',
    '/_api/contacts',
    'http://127.0.0.1:9999/__sim/events',
    'https://external.example.test/__sim/events',
  ])
    assert.equal(simulatorBackgroundRequest(value, origin), false, value);
});
