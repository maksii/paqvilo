// @test-kind compatibility: Learn documents that DateTime/DateFormat accepts .NET custom date format strings
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// The grid's formatter lives inside the browser runtime; extract it the same way the browser
// evaluates it, from the helper block before isoLocal.
const source = fs.readFileSync(new URL('../lib/entity-grid-compat.js', import.meta.url), 'utf8');
const formatLocal = new Function(
  source.slice(source.indexOf('  const pad = (value'), source.indexOf('  function isoLocal')) + '\nreturn formatLocal;',
)();

const dates = [new Date(2024, 0, 5, 15, 7, 9), new Date(2024, 11, 31, 0, 0, 0), new Date(2009, 6, 4, 12, 30, 1)];

function formatAll(pattern) {
  return dates.map((date) => formatLocal(date, pattern));
}

test('grid date formatting keeps the numeric patterns used by existing sites byte-identical', () => {
  assert.deepEqual(formatAll('M/d/yyyy'), ['1/5/2024', '12/31/2024', '7/4/2009']);
  assert.deepEqual(formatAll('h:mm tt'), ['3:07 PM', '12:00 AM', '12:30 PM']);
  assert.deepEqual(formatAll('M/d/yyyy h:mm tt'), ['1/5/2024 3:07 PM', '12/31/2024 12:00 AM', '7/4/2009 12:30 PM']);
  assert.deepEqual(formatAll('dd/MM/yyyy'), ['05/01/2024', '31/12/2024', '04/07/2009']);
  assert.deepEqual(formatAll('dd.MM.yyyy HH:mm'), ['05.01.2024 15:07', '31.12.2024 00:00', '04.07.2009 12:30']);
  assert.deepEqual(formatAll('yyyy-MM-dd h:mm tt'), [
    '2024-01-05 3:07 PM',
    '2024-12-31 12:00 AM',
    '2009-07-04 12:30 PM',
  ]);
  assert.deepEqual(formatAll('MM/dd/yyyy hh:mm tt'), [
    '01/05/2024 03:07 PM',
    '12/31/2024 12:00 AM',
    '07/04/2009 12:30 PM',
  ]);
  assert.deepEqual(formatAll('dd/MM/yyyy HH:mm:ss'), [
    '05/01/2024 15:07:09',
    '31/12/2024 00:00:00',
    '04/07/2009 12:30:01',
  ]);
  assert.deepEqual(formatAll("yyyy-MM-dd'T'HH:mm"), ['2024-01-05T15:07', '2024-12-31T00:00', '2009-07-04T12:30']);
  assert.deepEqual(formatAll("yyyy-MM-dd 'day' HH:mm tt"), [
    '2024-01-05 day 15:07 PM',
    '2024-12-31 day 00:00 AM',
    '2009-07-04 day 12:30 PM',
  ]);
  assert.deepEqual(formatAll('yy-M-d H:m:s'), ['24-1-5 15:7:9', '24-12-31 0:0:0', '09-7-4 12:30:1']);
  assert.deepEqual(formatAll('M/d/yyyy H:mm'), ['1/5/2024 15:07', '12/31/2024 0:00', '7/4/2009 12:30']);
  assert.deepEqual(formatAll('hh:mm tt'), ['03:07 PM', '12:00 AM', '12:30 PM']);
  assert.deepEqual(formatAll('d/M/yy'), ['5/1/24', '31/12/24', '4/7/09']);
  assert.deepEqual(formatAll('yyyy'), ['2024', '2024', '2009']);
  assert.deepEqual(formatAll('M'), ['1', '12', '7']);
});

test('grid date formatting renders month and weekday names instead of splitting the tokens', () => {
  assert.equal(formatLocal(dates[0], 'dd MMM yyyy'), '05 Jan 2024');
  assert.equal(formatLocal(dates[0], 'dddd, MMMM d, yyyy'), 'Friday, January 5, 2024');
  assert.equal(formatLocal(dates[0], 'ddd, dd/MM/yyyy'), 'Fri, 05/01/2024');
  assert.equal(formatLocal(dates[1], 'MMMM yyyy'), 'December 2024');
});

test('grid date formatting uses the page language for month and weekday names', () => {
  const previous = globalThis.document;
  globalThis.document = { documentElement: { lang: 'de-DE' } };
  try {
    assert.equal(formatLocal(dates[0], 'dddd, dd. MMMM yyyy'), 'Freitag, 05. Januar 2024');
  } finally {
    globalThis.document = previous;
  }
});

test('grid date formatting falls back to en-US names for an invalid page language', () => {
  const previous = globalThis.document;
  globalThis.document = { documentElement: { lang: 'not a language tag!' } };
  try {
    assert.equal(formatLocal(dates[0], 'MMM d'), 'Jan 5');
  } finally {
    globalThis.document = previous;
  }
});

test('grid date formatting falls back to en-US names for a well-formed tag that Intl refuses', () => {
  const previous = globalThis.document;
  try {
    for (const lang of ['en-a', 'en-x', 'en-US-']) {
      globalThis.document = { documentElement: { lang } };
      assert.equal(formatLocal(dates[0], 'MMMM d'), 'January 5', lang);
      assert.equal(formatLocal(dates[0], 'dddd'), 'Friday', lang);
    }
  } finally {
    globalThis.document = previous;
  }
});

test('grid date formatting builds one name formatter per language and token', () => {
  const RealDateTimeFormat = Intl.DateTimeFormat;
  let constructed = 0;
  // A fresh evaluation starts with an empty formatter cache.
  const freshFormatLocal = new Function(
    source.slice(source.indexOf('  const pad = (value'), source.indexOf('  function isoLocal')) +
      '\nreturn formatLocal;',
  )();
  const previous = globalThis.document;
  Intl.DateTimeFormat = function DateTimeFormat(...args) {
    constructed += 1;
    return new RealDateTimeFormat(...args);
  };
  try {
    globalThis.document = { documentElement: { lang: 'de-DE' } };
    const results = dates.map((date) => freshFormatLocal(date, 'dddd, dd. MMMM yyyy'));
    assert.equal(results[0], 'Freitag, 05. Januar 2024');
    assert.equal(constructed, 2, 'one formatter for dddd and one for MMMM, reused for every cell');
  } finally {
    Intl.DateTimeFormat = RealDateTimeFormat;
    globalThis.document = previous;
  }
});

test('grid date formatting supports fractions, the single-letter meridiem, quoted literals and escapes', () => {
  const withMilliseconds = new Date(2024, 0, 5, 15, 7, 9, 456);
  assert.equal(formatLocal(withMilliseconds, 'ss.fff'), '09.456');
  assert.equal(formatLocal(withMilliseconds, 'ss.ff'), '09.45');
  assert.equal(formatLocal(withMilliseconds, 'ss.f'), '09.4');
  assert.equal(formatLocal(withMilliseconds, 'h t'), '3 P');
  assert.equal(formatLocal(dates[0], "'Date:' dd"), 'Date: 05');
  assert.equal(formatLocal(dates[0], '"at" HH:mm'), 'at 15:07');
  assert.equal(formatLocal(dates[0], String.raw`dd\M\M yyyy`), '05MM 2024');
  assert.equal(formatLocal(dates[0], 'y yyy'), '24 2024');
});
