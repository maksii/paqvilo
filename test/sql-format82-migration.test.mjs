// @test-kind tooling: The fixed SQL error migration must preserve all other calls and reject missing or wrong errors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { compileFunction } from 'node:vm';
import fs from 'node:fs';
import { parseTestKinds, kindsAt } from '../scripts/check-test-tags.mjs';
import {
  SQL_FORMAT_82_CALL,
  verifySqlFormat82Call,
  verifyCurrentSqlFormat82Call,
  verifySqlFormat82Outcome,
} from '../scripts/parity-sql-format82.mjs';

const { parse } = createRequire(import.meta.url)('espree');
const parseModule = (source) => parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
const before = parseModule('const call = (name, args, ctx) => callFunction(name, args, ctx);');
const current = parseModule(SQL_FORMAT_82_CALL);

test('the migration pins the complete before and after call wrappers', () => {
  verifySqlFormat82Call(before, current);
  verifyCurrentSqlFormat82Call(current);
  assert.throws(
    () => verifyCurrentSqlFormat82Call(parseModule(SQL_FORMAT_82_CALL.replace('9818', '9819'))),
    /sql-format82-call-invalid/,
  );
  assert.throws(
    () => verifySqlFormat82Call(parseModule('const call = () => null;'), current),
    /sql-format82-call-invalid/,
  );
});

test('the exact case must throw 9818; every other call delegates unchanged', () => {
  const args = [1234.5, 'N2', 'not a culture'];
  const makeCall = (implementation) =>
    compileFunction(`${SQL_FORMAT_82_CALL}\nreturn call;`, ['callFunction', 'assert'])(implementation, assert);
  const correct = makeCall(() => {
    throw { number: 9818 };
  });
  assert.deepEqual(correct('FORMAT', args), { sqlError: 9818 });
  const wrong = makeCall(() => {
    throw { number: 123 };
  });
  assert.throws(() => wrong('FORMAT', args));
  const returnedMarker = makeCall(() => ({ sqlError: 9818 }));
  assert.throws(() => returnedMarker('FORMAT', args), /Missing expected exception/);
  const sentinel = {};
  const ordinary = makeCall(() => sentinel);
  assert.equal(ordinary('FORMAT', [1234.5, 'N2', 'en-US']), sentinel);
  assert.equal(ordinary('OTHER', args), sentinel);
  assert.equal(ordinary('FORMAT', args, {}), sentinel);
});

test('the native fact must contain the fixed error and corrected expectation', () => {
  const before = { type: 'null' },
    after = { type: 'object', value: { sqlError: { type: 'number', value: 9818 } } };
  const fact = {
    priorExpected: null,
    currentExpected: { sqlError: 9818 },
    typedOutcome: { outcome: 'sql-error', errors: [{ number: 9818 }] },
  };
  verifySqlFormat82Outcome(before, after, fact);
  for (const changed of [
    { ...fact, typedOutcome: { outcome: 'result', errors: [{ number: 9818 }] } },
    { ...fact, typedOutcome: { outcome: 'sql-error', errors: [{ number: 9819 }] } },
    { ...fact, typedOutcome: { outcome: 'sql-error', errors: [{ number: 9818 }, { number: 9818 }] } },
    { ...fact, currentExpected: { sqlError: 9819 } },
  ])
    assert.throws(() => verifySqlFormat82Outcome(before, after, changed), /sql-format82-outcome-mismatch/);
  assert.throws(() => verifySqlFormat82Outcome(before, { type: 'null' }, fact), /sql-format82-outcome-mismatch/);
});

test('the generated guard marks the dedicated error assertion as parity-protected', () => {
  const source = fs.readFileSync(
    new URL('../mirage/test/dataverse-tds-sql-functions.test.mjs', import.meta.url),
    'utf8',
  );
  const line =
    source
      .split(/\r?\n/u)
      .findIndex((text) => text.includes('assert.throws(() => callFunction(name, args, ctx), { number: 9818 })')) + 1;
  assert.ok(line > 0);
  const tags = parseTestKinds(source);
  assert.deepEqual(tags.errors, []);
  assert.ok(kindsAt(tags, line).includes('parity'));
});
