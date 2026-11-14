// @test-kind contract: DateTime parsing and formatting follow .NET semantics, including the sub-millisecond ticks of an ISO timestamp with or without a UTC offset.
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatNetDate, parseNetDate } from '../lib/liquid-dotnet.mjs';

test('an ISO timestamp with Z or without an offset keeps its sub-millisecond ticks', () => {
  const zulu = parseNetDate('2026-01-02T03:04:05.1234567Z');
  assert.equal(zulu.toISOString(), '2026-01-02T03:04:05.123Z');
  assert.equal(formatNetDate(zulu, 'fffffff'), '1234567');
  const local = parseNetDate('2026-01-02T03:04:05.1234567');
  assert.equal(local.toISOString(), '2026-01-02T03:04:05.123Z');
  assert.equal(formatNetDate(local, 'fffffff'), '1234567');
});

test('an ISO timestamp with a UTC offset converts to UTC and keeps its sub-millisecond ticks', () => {
  const offset = parseNetDate('2026-01-02T03:04:05.1234567+02:00');
  assert.equal(offset.toISOString(), '2026-01-02T01:04:05.123Z');
  assert.equal(formatNetDate(offset, 'fffffff'), '1234567');
});
