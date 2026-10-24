import test from 'node:test';
import assert from 'node:assert/strict';
import {compileFormattedTimeZone} from '../lib/formatted-time-zone.mjs';
import {formattedValue} from '../lib/dataverse-values.mjs';

// A zone at UTC+4 in winter and UTC+5 in summer. Last Sunday transitions.
const rule={effectivedatetime:'1753-01-01T00:00:00Z',bias:-240,standardbias:0,daylightbias:-60,
  daylightyear:0,daylightmonth:3,daylightday:5,daylightdayofweek:0,daylighthour:3,daylightminute:0,daylightsecond:0,
  standardyear:0,standardmonth:10,standardday:5,standarddayofweek:0,standardhour:4,standardminute:0,standardsecond:0};
const profile=rules=>({evidence:'Invented timezone boundary regression',rules});
test('explicit timezone rules handle both transition boundaries and literal historical years',()=>{
  const offset=compileFormattedTimeZone(profile([rule]));
  for(const [date,minutes] of [['1753-01-01',240],['2025-01-01',240],['2025-07-01',300],['2025-03-29T22:59:59Z',240],['2025-03-29T23:00:00Z',300],['2025-10-25T22:59:59Z',300],['2025-10-25T23:00:00Z',240]])assert.equal(offset(Date.parse(date)),minutes,date);
  const settings={formattedValueTimeZone:profile([rule])};
  assert.equal(formattedValue('1753-01-01T00:00:00Z',{type:'datetime',behavior:'UserLocal'},settings),'1/1/1753 4:00 AM');
  assert.equal(formattedValue('2025-07-01T00:00:00Z',{type:'datetime',behavior:'UserLocal'},settings),'7/1/2025 5:00 AM');
  assert.equal(formattedValue('2025-07-01T00:00:00Z',{type:'datetime',behavior:'TimeZoneIndependent'},settings),'7/1/2025 12:00 AM');
});
test('southern seasons, fixed zones and effective rule changes remain project-owned',()=>{
  const southern={...rule,daylightmonth:10,standardmonth:3};
  const offset=compileFormattedTimeZone(profile([southern]));
  assert.equal(offset(Date.parse('2025-01-01')),300);assert.equal(offset(Date.parse('2025-07-01')),240);
  const next={...rule,effectivedatetime:'2026-01-01T00:00:00Z',bias:120,standardmonth:0,daylightmonth:0};
  const changed=compileFormattedTimeZone(profile([next,rule]));
  assert.equal(changed(Date.parse('2025-07-01')),300);assert.equal(changed(Date.parse('2026-07-01')),-120);
});
test('invalid or ambiguous timezone profiles fail explicitly',()=>{
  for (const value of [{rules:[rule]},profile([]),profile([rule,rule]),profile([{...rule,daylightmonth:13}]),profile([{...rule,daylightday:6}]),profile([{...rule,standardmonth:0}])])assert.throws(()=>compileFormattedTimeZone(value),/formattedValueTimeZone/);
});

test('absolute transition dates apply only within their declared interval',()=>{
  const fixed={...rule,daylightyear:2025,daylightmonth:3,daylightday:16,standardyear:2025,standardmonth:10,standardday:12};
  const offset=compileFormattedTimeZone(profile([fixed]));
  assert.equal(offset(Date.parse('2024-07-01')),240);assert.equal(offset(Date.parse('2025-07-01')),300);assert.equal(offset(Date.parse('2026-07-01')),240);
  assert.throws(()=>compileFormattedTimeZone(profile([{...fixed,daylightmonth:2,daylightday:31}])),/formattedValueTimeZone/);
  assert.throws(()=>compileFormattedTimeZone(profile([{...fixed,effectivedatetime:'2025-02-31T00:00:00Z'}])),/formattedValueTimeZone/);
});
