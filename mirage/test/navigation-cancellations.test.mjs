import test from 'node:test';
import assert from 'node:assert/strict';
import { cancelNavigationRequests } from '../lib/navigation-cancellations.mjs';
import { simulatorBackgroundRequest } from '../acceptance-api.mjs';

test('detached document requests without terminal events leave pending and retain cancellation evidence', () => {
  const requests = Array.from({length: 2}, () => ({failure: () => null}));
  const records = new Map(requests.map((request, i) => [request, {order: i + 1, method: i ? 'POST' : 'PATCH', url: `http://127.0.0.1:8787/synthetic/${i}`, started: 100}]));
  const pending = new Map(records);
  const unrelated = {failure: () => null}; pending.set(unrelated, {method: 'GET'});
  const cancelled = cancelNavigationRequests(requests, pending, records, {reason: 'frame-detached', at: 185});
  assert.equal(pending.size, 1); assert.equal(pending.has(unrelated), true);
  assert.equal(cancelled.length, 2);
  assert.equal(cancelled[0].at, new Date(185).toISOString());
  assert.equal(records.get(requests[0]).durationMs, 85);
  assert.equal(cancelNavigationRequests(requests, pending, records, {reason: 'frame-detached'}).length, 0);
});

test('document replacement never disguises completed HTTP errors or unrelated network failures', () => {
  const finished = {failure: () => null}, httpError = {failure: () => null}, networkError = {failure: () => ({errorText: 'net::ERR_CONNECTION_RESET'})};
  const records = new Map([[finished, {finished: true}], [httpError, {status: 500}], [networkError, {}]]);
  const pending = new Map(records);
  assert.deepEqual(cancelNavigationRequests([...records.keys()], pending, records, {reason: 'document-replaced'}), []);
  assert.equal(pending.size, 3);
});

test('public background rule remains confined to exact owned loopback lifecycle paths', () => {
  const origin = 'http://127.0.0.1:8787';
  assert.equal(simulatorBackgroundRequest('/__sim/events', origin), true);
  assert.equal(simulatorBackgroundRequest('/__sim/frame-ready/12345678-1234-1234-1234-123456789abc', origin), true);
  assert.equal(simulatorBackgroundRequest(origin + '/__sim/frame-ready/12345678-1234-1234-1234-123456789abc?reason=dom-ready', origin), true);
  for (const value of ['/__sim/events/extra', 'https://foreign.invalid/__sim/frame-ready/12345678-1234-1234-1234-123456789abc', '/__sim/frame-ready/not-a-token', '/_api/contacts', 'http://127.0.0.1:9999/__sim/events', 'https://external.example.test/__sim/events']) assert.equal(simulatorBackgroundRequest(value, origin), false, value);
});
