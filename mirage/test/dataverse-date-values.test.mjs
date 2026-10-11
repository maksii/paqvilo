import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDateValue } from '../lib/dataverse-values.mjs';

test('date literals preserve years below 100 before platform range validation', () => {
  for (const value of ['0000-01-01', '0001-01-01', '0026-01-01', '0099-12-31']) {
    const parsed = parseDateValue(value);
    assert.equal(new Date(parsed.ms).toISOString(), value + 'T00:00:00.000Z');
    assert.equal(parsed.dateOnly, true);
  }
  assert.equal(new Date(parseDateValue('0099-01-01T12:00:00Z').ms).toISOString(), '0099-01-01T12:00:00.000Z');
  assert.equal(new Date(parseDateValue('0026-01-01T12:00:00+03:00').ms).toISOString(), '0026-01-01T09:00:00.000Z');
  assert.equal(new Date(parseDateValue('0026-01-01', { timeZoneOffsetMinutes: 180 }).ms).toISOString(), '0025-12-31T21:00:00.000Z');
});

test('calendar validation uses the literal Gregorian year for leap dates', () => {
  for (const value of ['0000-02-29', '0004-02-29', '0096-02-29', '2000-02-29']) {
    assert.equal(new Date(parseDateValue(value).ms).toISOString().slice(0, 10), value);
    assert.equal(new Date(parseDateValue(value + 'T12:00:00Z').ms).toISOString().slice(0, 10), value);
  }
  for (const value of ['0001-02-29', '0026-02-29', '0100-02-29', '1900-02-29', '2026-04-31']) {
    assert.equal(parseDateValue(value), null, value);
    assert.equal(parseDateValue(value + 'T12:00:00Z'), null, value);
  }
});
