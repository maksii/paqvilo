// @test-kind security: SQL conversions and space trimming handle long attacker-controlled strings without super-linear backtracking.
import test from 'node:test';
import assert from 'node:assert/strict';
import { callFunction, castValue } from '../lib/dataverse-tds-sql-functions.mjs';

test('SQL text functions preserve space-only trimming for long inputs', () => {
  const spaces = ' '.repeat(100_000);
  assert.equal(callFunction('RTRIM', [`${spaces}x`]), `${spaces}x`);
  assert.equal(callFunction('LEN', [`x${spaces}`]), 1);
  assert.equal(callFunction('TRIM', [`${spaces}x${spaces}`]), 'x');
  assert.equal(callFunction('RTRIM', ['x \n']), 'x \n');
  assert.equal(callFunction('TRIM', [` x${spaces}y `]), `x${spaces}y`);
  assert.equal(callFunction('TRIM', [' \t x \n ']), '\t x \n');
});

test('SQL type and numeric parsing rejects long malformed inputs', () => {
  assert.equal(callFunction('ISNUMERIC', [`${'1'.repeat(100_000)}x`]), 0);
  assert.equal(callFunction('ISNUMERIC', ['12.5e-2']), 1);
  assert.equal(castValue('abcdef', ' nvarchar( 3 ) '), 'abc');
  assert.throws(() => castValue('x', `varchar(${' '.repeat(100_000)}x`));
});
import { executeBatch } from '../lib/dataverse-tds-sql-eval.mjs';

test('SQL DISTINCT handles long untrimmed row values and trailing spaces', async () => {
  const padded = `${' '.repeat(100_000)}x`;
  const catalog = {
    tables: new Map([
      [
        't',
        {
          logicalName: 't',
          columns: [{ name: 'v', sqlType: 'nvarchar', length: null, precision: null, scale: null, nullable: true }],
        },
      ],
    ]),
  };
  const scan = async () => [{ v: padded }, { v: `${padded} ` }, { v: 'y' }];
  const result = await executeBatch('SELECT DISTINCT t.v FROM t', { catalog, scan });
  assert.deepEqual(result.resultSets[0].rows, [[padded], ['y']]);
});

test('FORMATMESSAGE handles long invalid width prefixes without backtracking', () => {
  const invalid = `%${'0'.repeat(100_000)}q`;
  assert.equal(callFunction('FORMATMESSAGE', [invalid]), invalid);
  assert.equal(callFunction('FORMATMESSAGE', ['%05d', 12]), '00012');
});

test('FORMAT groups wide numeric patterns with the original grouping positions', () => {
  const pattern = `,${'0'.repeat(20_000)}`;
  const actual = callFunction('FORMAT', [12, pattern, 'en-US']);
  assert.equal(actual.length, 20_000 + Math.floor((20_000 - 1) / 3));
  assert.ok(actual.startsWith('00,000,000,'));
  assert.ok(actual.endsWith(',000,012'));
  assert.equal(callFunction('FORMAT', [1234.5, '#,##0.00', 'en-US']), '1,234.50');
});
import { createServiceProtection } from '../lib/dataverse-limits.mjs';

test('service protection formats a long string-valued limit without repeated scans', () => {
  const digits = '0'.repeat(20_000);
  const admission = createServiceProtection({ executionMsPer300s: digits }).admit('user');
  assert.equal(admission.ok, false);
  assert.ok(admission.error.message.includes('00,000,000,'));
});
