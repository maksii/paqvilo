import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDateValue,isoUtc,isDateOnlyField,formattedValue } from '../lib/dataverse-values.mjs';

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

test('sub-millisecond precision truncates without carrying into the next second or day',()=>{
  for(const value of ['2025-02-07T10:30:45.9999Z','2025-02-07T23:59:59.9999999Z']) {
    const parsed=parseDateValue(value);assert.ok(parsed);assert.equal(new Date(parsed.ms).getUTCMilliseconds(),999);
    assert.equal(isoUtc(parsed.ms),value.replace(/\..*Z$/,'Z'));
  }
});

test('date-only display never changes explicitly declared instant storage',()=>{
  for (const behavior of ['UserLocal',1,{Value:'UserLocal'},'TimeZoneIndependent',3,{Value:'TimeZoneIndependent'}])
    assert.equal(isDateOnlyField({dateTimeBehavior:behavior,format:'DateOnly'}),false);
  for(const behavior of ['DateOnly',2,{Value:'DateOnly'}])assert.equal(isDateOnlyField({behavior}),true);
  const settings={timeZoneOffsetMinutes:120};
  assert.equal(formattedValue('2025-02-06T22:30:00Z',{type:'datetime',behavior:'UserLocal',format:'DateOnly'},settings),'2/7/2025');
  assert.equal(formattedValue('2025-02-06T22:30:00Z',{type:'datetime',behavior:'TimeZoneIndependent',format:'DateOnly'},settings),'2/6/2025');
  assert.equal(formattedValue('2025-02-06T22:30:00Z',{type:'datetime',behavior:'TimeZoneIndependent'},settings),'2/6/2025 10:30 PM');
  assert.equal(formattedValue('2025-02-07',{type:'datetime',behavior:'DateOnly'},settings),'2/7/2025');
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

test('Solution date format controls display independently of instant behavior', () => {
  for (const behavior of [1, 3]) {
    const definition = { type: 'datetime', behavior, format: 'date' };
    assert.equal(isDateOnlyField(definition), false);
    assert.equal(formattedValue('2025-02-07T00:00:00Z', definition), '2/7/2025');
    assert.equal(formattedValue('2025-02-07T00:00:00Z', {...definition, format:'datetime'}), '2/7/2025 12:00 AM');
  }
});
