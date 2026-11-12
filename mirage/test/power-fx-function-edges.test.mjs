import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { FxEnum, LAZY, equals, evaluateFx, fromFx, parse, powerFxEngine } from '../lib/power-fx.mjs';

const evaluate = (formula) => powerFxEngine.evaluateSync(formula, { host: {} }).value;
const shown = (formula) => fromFx(evaluate(formula));

// The evaluation runs in a worker so the test can end it: a synchronous evaluation on this thread cannot be interrupted.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
import(workerData.moduleUrl).then(({ powerFxEngine }) => {
  parentPort.postMessage(powerFxEngine.evaluateSync(workerData.formula, { host: {} }).value);
});`;
async function evaluateInWorker(formula) {
  const moduleUrl = new URL('../lib/power-fx.mjs', import.meta.url).href;
  const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { formula, moduleUrl } });
  try {
    return await new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });
  } finally {
    await worker.terminate();
  }
}
// The first-occurrence scan that Distinct used before its buckets: each value is kept unless equals finds a kept value.
// The values are the raw Power Fx values (evaluateFx), so equals sees the same types the engine compares.
function referenceDistinct(values, fx) {
  const kept = [];
  for (const value of values) if (!kept.some((seen) => equals(seen, value, fx))) kept.push(value);
  return kept;
}

// @test-kind security: colour names and date units are looked up as own properties, so prototype keys are unknown names
test('prototype keys are not colour names or date units and keep the error value', () => {
  assert.equal(evaluate('IsError(ColorValue("constructor"))'), true);
  assert.equal(evaluate('IsError(ColorValue("__proto__"))'), true);
  assert.equal(evaluate('IsError(DateAdd(Now(), 1, "constructor"))'), true);
  assert.equal(evaluate('IsError(DateDiff(Now(), Now(), "toString"))'), true);
});

// @test-kind security: the own-property lookup keeps the documented colour names and date units working
test('listed colour names and date units still resolve after the prototype-key guard', () => {
  assert.equal(evaluate('IsError(ColorValue("Red"))'), false);
  assert.equal(evaluate('Text(DateAdd(Date(2024, 1, 31), 1, TimeUnit.Months), "yyyy-mm-dd")'), '2024-02-29');
});

// @test-kind contract: an invalid language tag on a date format answers BadLanguageCode (kind 14) like number formatting, not a host exception
test('Text of a date with an invalid language tag answers BadLanguageCode', () => {
  assert.equal(evaluate('IsError(Text(Now(), "mmmm", "not a tag!!"))'), true);
  assert.equal(evaluate('IfError(Text(Now(), "mmmm", "not a tag!!"), FirstError.Kind)'), '14');
});

// @test-kind contract: a valid language tag still formats the month name in that language
test('Text of a date with a valid language tag formats in that language', () => {
  assert.equal(evaluate('Text(Date(2024, 1, 31), "mmmm", "fr-FR")'), 'janvier');
});

// @test-kind contract: rounding a number JavaScript prints in exponent form (below 1e-6) keeps its digits, not 0
test('rounding functions keep the digits of numbers printed in exponent form', () => {
  assert.equal(evaluate('RoundUp(0.0000001234, 9)'), 0.000000124);
  assert.equal(evaluate('RoundDown(0.0000001234, 9)'), 0.000000123);
  assert.equal(evaluate('Round(Float("1.5e-7"), 7)'), 2e-7);
});

// @test-kind contract: Learn "Date, DateTime, and Time functions", Date: "If Year is between 0 and 1899 (inclusive), the function adds that value to 1900 to calculate the year."
test('Date adds 1900 to a year from 0 to 1899', () => {
  assert.equal(evaluate('Year(Date(150, 1, 1))'), 2050);
  assert.equal(evaluate('Year(Date(70, 1, 1))'), 1970);
  assert.equal(evaluate('Year(Date(1899, 12, 31))'), 3799);
  assert.equal(evaluate('Year(Date(1900, 1, 1))'), 1900);
});

// @test-kind contract: Learn "Date, DateTime, and Time functions", Date: a month above 12 or a day above the month length rolls into the following period
test('Date keeps month and day rollover', () => {
  assert.equal(evaluate('Text(Date(2024, 13, 1), "yyyy-mm-dd")'), '2025-01-01');
  assert.equal(evaluate('Text(Date(2024, 1, 32), "yyyy-mm-dd")'), '2024-02-01');
});

// @test-kind contract: the existing rounding results for numbers printed in plain decimal form stay as they are
test('rounding functions keep their results for plain decimal numbers', () => {
  assert.equal(evaluate('Round(1.005, 2)'), 1.01);
  assert.equal(evaluate('Round(-2.5, 0)'), -3);
  assert.equal(evaluate('RoundDown(-1.29, 1)'), -1.2);
  assert.equal(evaluate('RoundUp(1.21, 1)'), 1.3);
  assert.equal(evaluate('Round(1234.5678, -2)'), 1200);
});

// @test-kind contract: Learn "DateValue": the language argument gives the day and month order of slash-style text (fr-FR is day first)
test('DateValue with a day-first language reads slash-style text day first', () => {
  assert.equal(evaluate('Text(DateValue("13/01/2024", "fr-FR"), "yyyy-mm-dd")'), '2024-01-13');
  assert.equal(evaluate('Text(DateValue("02/03/2024", "fr-FR"), "yyyy-mm-dd")'), '2024-03-02');
});

// @test-kind contract: Learn "DateValue": en-US reads slash-style text month first, the same order as the argument-free form
test('DateValue with a month-first language and without a language keep the month-first order', () => {
  assert.equal(evaluate('Text(DateValue("02/03/2024", "en-US"), "yyyy-mm-dd")'), '2024-02-03');
  assert.equal(evaluate('Text(DateValue("02/03/2024"), "yyyy-mm-dd")'), '2024-02-03');
});

// @test-kind contract: DateTimeValue and TimeValue apply the same language order to the date part of slash-style text
test('DateTimeValue and TimeValue apply the language order to the date part', () => {
  assert.equal(evaluate('Text(DateTimeValue("02/03/2024 10:30", "fr-FR"), "yyyy-mm-dd hh:mm")'), '2024-03-02 10:30');
  assert.equal(evaluate('Text(TimeValue("13/01/2024 10:30", "fr-FR"), "hh:mm")'), '10:30');
});

// @test-kind contract: Learn "Distinct": the result column is Value and the first occurrence of each value keeps its place
test('Distinct keeps first-occurrence order, the Value column and case-sensitive text', () => {
  assert.equal(evaluate('CountRows(Distinct(Sequence(50000), Mod(Value, 7)))'), 7);
  assert.equal(evaluate('CountRows(Distinct(Table({V:"a"}, {V:"A"}, {V:"a"}), V))'), 2);
  assert.equal(evaluate('Text(First(Distinct(Table({V:3}, {V:1}, {V:3}), V)).Value)'), '3');
});

// @test-kind contract: the Distinct results for numbers, text, Booleans, dates, GUIDs, choices, records and tables are fixed by the captured table
test('Distinct returns the captured results for the mixed-type inputs', () => {
  const cases = [
    ['CountRows(Distinct(Table({V:1}, {V:1.0}), V))', 1],
    ['Distinct(Table({V:"a"}, {V:"A"}, {V:"a"}), V)', [{ Value: 'a' }, { Value: 'A' }]],
    ['Distinct(Table({V:Blank()}, {V:Blank()}, {V:""}), V)', [{ Value: null }, { Value: '' }]],
    ['Distinct(Table({V:true}, {V:false}, {V:true}), V)', [{ Value: true }, { Value: false }]],
    [
      'Distinct(Table({V:Date(2024,1,1)}, {V:Date(2024,1,1)}, {V:Date(2024,1,2)}), V)',
      [{ Value: '2024-01-01' }, { Value: '2024-01-02' }],
    ],
    [
      'Distinct(Table({V:DateTimeValue("2024-01-01T10:00:00Z")}, {V:DateTimeValue("2024-01-01T10:00:00Z")}, {V:DateTimeValue("2024-01-01T11:00:00Z")}), V)',
      [{ Value: '2024-01-01T10:00:00.000Z' }, { Value: '2024-01-01T11:00:00.000Z' }],
    ],
    ['Distinct(Table({V:{a:1}}, {V:{a:1}}, {V:{a:2}}), V)', [{ Value: { a: 1 } }, { Value: { a: 2 } }]],
    [
      'Distinct(Table({V:GUID("ABCDEF00-0000-0000-0000-000000000001")}, {V:GUID("abcdef00-0000-0000-0000-000000000001")}), V)',
      [{ Value: 'abcdef00-0000-0000-0000-000000000001' }],
    ],
    ['Distinct(Table({V:Float(0.1)}, {V:0.1}, {V:Float(0.2)}), V)', [{ Value: 0.1 }, { Value: 0.2 }]],
    [
      'Distinct(Table({V:TimeUnit.Hours}, {V:TimeUnit.Hours}, {V:TimeUnit.Days}), V)',
      [{ Value: 'Hours' }, { Value: 'Days' }],
    ],
    ['Distinct(Table({V:1}, {V:"1"}), V)', [{ Value: 1 }]],
    ['Distinct(Table({V:1.50}, {V:1.5}, {V:-0.0}, {V:0}), V)', [{ Value: 1.5 }, { Value: 0 }]],
    ['Distinct(Table(), V)', []],
    [
      'Distinct(Table({V:Table({a:1})}, {V:Table({a:1})}, {V:Table({a:2})}), V)',
      [{ Value: [{ a: 1 }] }, { Value: [{ a: 2 }] }],
    ],
    ['Distinct(Table({V:Date(2024,1,1)}, {V:DateTimeValue("2024-01-01T00:00:00Z")}), V)', [{ Value: '2024-01-01' }]],
    [
      'Distinct(Table({V:1}, {V:2}, {V:1}, {V:2.5}, {V:-7}), V)',
      [{ Value: 1 }, { Value: 2 }, { Value: 2.5 }, { Value: -7 }],
    ],
    ['Distinct(Table({V:"x"}, {V:Blank()}, {V:"x"}, {V:Blank()}), V)', [{ Value: 'x' }, { Value: null }]],
    [
      'Distinct(Table({V:Time(1,2,3)}, {V:Time(1,2,3)}, {V:Time(1,2,4)}), V)',
      [{ Value: '01:02:03.000' }, { Value: '01:02:04.000' }],
    ],
  ];
  for (const [formula, expected] of cases) assert.deepEqual(shown(formula), expected, formula);
});

// @test-kind unproven: the time of day wraps within 24 hours for DateAdd with a sub-day unit, as Time() and time plus a number do
test('DateAdd with a sub-day unit wraps a Time value within the day in both directions', () => {
  assert.equal(evaluate('DateAdd(Time(23,0,0), 2, TimeUnit.Hours) = Time(1,0,0)'), true);
  assert.equal(evaluate('DateAdd(Time(1,0,0), -2, TimeUnit.Hours) = Time(23,0,0)'), true);
});

// @test-kind contract: Learn "Text function": a Float beyond the decimal exponent bound formats its shortest digits, so 1e300 has 301 digits
test('Text with a format string formats a Float beyond the decimal exponent bound', () => {
  assert.equal(evaluate('Len(Text(Float("1e300"), "0"))'), 301);
  assert.equal(evaluate('Left(Text(Float("1e300"), "0"), 3)'), '100');
  assert.equal(evaluate('IsError(Text(Float("1e300"), "0"))'), false);
  assert.equal(evaluate('Text(Float("1e-300"), "0")'), '0');
});

// @test-kind contract: Distinct over 50,000 distinct values keeps all of them; the worker's test timeout is the hang guard, not an assertion on time
test('Distinct over 50,000 distinct values keeps every value', async () => {
  assert.equal(await evaluateInWorker('CountRows(Distinct(Sequence(50000), Value))'), 50000);
});

// Mixed scalars that equals relates in every way the bucket keys must respect: numbers, numeric text, Booleans, dates and GUIDs.
const DISTINCT_POOL = [
  '1',
  '1.0',
  '-0',
  '0',
  '2.5',
  '1.50',
  '1.5',
  '-7',
  '0.1',
  'Float(0.1)',
  'Float(1)',
  '"1"',
  '"1.0"',
  '" 1"',
  '"1E0"',
  '"1e0"',
  '"0.1"',
  '"-0"',
  '"abc"',
  '"ABC"',
  '"Abc"',
  '""',
  '"true"',
  '"0"',
  'Blank()',
  'true',
  'false',
  'Date(2024, 1, 1)',
  'Date(2024, 1, 2)',
  'Date(2024, 7, 1)',
  'DateTimeValue("2024-01-01T00:00:00Z")',
  'DateTimeValue("2024-01-01T10:00:00Z")',
  'DateTimeValue("2024-01-01T05:00:00Z")',
  'DateTimeValue("2024-07-01T04:00:00Z")',
  'Time(0, 0, 0)',
  'GUID("abcdef00-0000-0000-0000-000000000001")',
  'GUID("ABCDEF00-0000-0000-0000-000000000001")',
  'ChoiceOneAlpha',
  'ChoiceOneBeta',
  'ChoiceOneOne',
  'ChoiceTwoAlpha',
  'ChoiceTwoOne',
];
// Choice values from two option sets, bound as names in the formula (a choice equals its underlying value within one set).
const DISTINCT_CHOICES = (() => {
  const one = new FxEnum('EnumOne', { Alpha: 'alpha', Beta: 'beta', One: 1 });
  const two = new FxEnum('EnumTwo', { Alpha: 'alpha', One: 1 });
  return {
    ChoiceOneAlpha: one.entries.get('alpha'),
    ChoiceOneBeta: one.entries.get('beta'),
    ChoiceOneOne: one.entries.get('one'),
    ChoiceTwoAlpha: two.entries.get('alpha'),
    ChoiceTwoOne: two.entries.get('one'),
  };
})();

// @test-kind contract: Distinct keeps the values and order of the first-occurrence equals scan on 1,500 seeded random tables, in UTC and in a zone with offset datetimes
test('Distinct matches the first-occurrence equals scan on seeded random tables', () => {
  let seed = 20260101;
  const next = (bound) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % bound;
  };
  for (let round = 0; round < 1500; round++) {
    const literals = Array.from({ length: next(41) }, () => DISTINCT_POOL[next(DISTINCT_POOL.length)]);
    const rows = literals.map((literal) => `{V:${literal}}`).join(', ');
    const host = round % 2 ? { timeZone: 'America/New_York' } : {};
    const { value: tableValue, fx } = evaluateFx(`Table(${rows})`, { values: DISTINCT_CHOICES, host });
    const expected = referenceDistinct(
      tableValue.map((row) => row.V),
      fx,
    );
    const { value: distinct } = evaluateFx(`Distinct(Table(${rows}), V)`, { values: DISTINCT_CHOICES, host });
    assert.deepEqual(
      fromFx(distinct, fx),
      expected.map((value) => ({ Value: fromFx(value, fx) })),
      `Distinct(Table(${rows}), V)`,
    );
  }
});

// @test-kind contract: a choice equals the plain value it holds within its option set, but not a choice of another option set
test('Distinct keeps a choice apart from a choice of another option set and merges it with its plain value', () => {
  const { value } = evaluateFx(
    'CountRows(Distinct(Table({V: ChoiceOneAlpha}, {V: "alpha"}, {V: ChoiceTwoAlpha}), V))',
    {
      values: DISTINCT_CHOICES,
    },
  );
  assert.equal(value, 2);
});

// @test-kind contract: an offset datetime equals a date with the same wall-clock day, so the two share one distinct value
test('Distinct merges an offset datetime with a date that has its wall-clock day', () => {
  const { value } = evaluateFx(
    'CountRows(Distinct(Table({V: DateTimeValue("2024-01-01T05:00:00Z")}, {V: Date(2024, 1, 1)}, {V: DateTimeValue("2024-01-01T05:00:00Z")}), V))',
    { host: { timeZone: 'America/New_York' } },
  );
  assert.equal(value, 1);
});

// The choice rows come from a generated option set built in the worker: a Choice cannot be sent across the thread boundary.
const CHOICE_WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
import(workerData.moduleUrl).then(({ FxEnum, evaluateFx, fromFx }) => {
  const entries = {};
  for (let index = 0; index < workerData.count; index++) entries['member' + index] = index;
  const rows = [...new FxEnum('Generated', entries).entries.values()].map((choice) => ({ V: choice }));
  parentPort.postMessage(fromFx(evaluateFx('CountRows(Distinct(Rows, V))', { values: { Rows: rows }, host: {} }).value));
});`;
async function countDistinctChoicesInWorker(count) {
  const moduleUrl = new URL('../lib/power-fx.mjs', import.meta.url).href;
  const worker = new Worker(CHOICE_WORKER_SOURCE, { eval: true, workerData: { count, moduleUrl } });
  try {
    return await new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });
  } finally {
    await worker.terminate();
  }
}

// @test-kind contract: Distinct over 20,000 rows of distinct choice values keeps every value; the worker's test timeout is the hang guard, not an assertion on time
test('Distinct over 20,000 distinct choice values keeps every value', async () => {
  assert.equal(await countDistinctChoicesInWorker(20000), 20000);
});

// @test-kind contract: an invalid language tag on DateValue answers BadLanguageCode (kind 14), as Text does for dates
test('DateValue with an invalid language tag answers BadLanguageCode', () => {
  assert.equal(evaluate('IsError(DateValue("02/03/2024", "not a tag!!"))'), true);
  assert.equal(evaluate('IfError(Text(DateValue("02/03/2024", "not a tag!!"), "yyyy-mm-dd"), FirstError.Kind)'), '14');
});

const nestedParentheses = (depth) => `${'('.repeat(depth)}1${')'.repeat(depth)}`;

// @test-kind security: parentheses nested 5,000 deep are a PowerFxSyntaxError (400), not a stack overflow
test('a formula nested 5,000 parentheses deep is a syntax error', () => {
  assert.throws(
    () => parse(nestedParentheses(5000)),
    (error) => error.code === 'PowerFxSyntaxError' && error.status === 400,
  );
});

// @test-kind security: 20,000 prefix minus signs are a PowerFxSyntaxError (400), not a stack overflow
test('a chain of 20,000 prefix minus signs is a syntax error', () => {
  assert.throws(
    () => parse(`${'-'.repeat(20000)}1`),
    (error) => error.code === 'PowerFxSyntaxError' && error.status === 400,
  );
});

// @test-kind security: the checker reports the nesting limit as a syntax diagnostic with its position, not a host exception
test('checkSync reports a deeply nested formula as a syntax diagnostic with a position', () => {
  const result = powerFxEngine.checkSync(nestedParentheses(5000));
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0].code, 'POWERFX_SYNTAX');
  assert.equal(typeof result.diagnostics[0].position, 'number');
});

// @test-kind security: interpolation islands nested 5,000 deep count toward the same nesting limit
test('interpolation islands nested 5,000 deep are a syntax error', () => {
  let formula = '1';
  for (let level = 0; level < 5000; level++) formula = `$"{${formula}}"`;
  assert.throws(
    () => parse(formula),
    (error) => error.code === 'PowerFxSyntaxError' && error.status === 400,
  );
});

// @test-kind security: a formula nested 200 parentheses deep still evaluates to its value
test('a formula nested 200 parentheses deep still evaluates', () => {
  assert.equal(evaluate(nestedParentheses(200)), 1);
});

// @test-kind security: the evaluator and the function checker walk the deepest tree the parser accepts without overflowing
test('the deepest accepted nesting of calls and parentheses evaluates and checks', () => {
  const formula = `${'Abs('.repeat(250)}${nestedParentheses(249)}${')'.repeat(250)}`;
  assert.equal(evaluate(formula), 1);
  assert.equal(powerFxEngine.checkSync(formula).ok, true);
});

// @test-kind contract: a left-deep chain of 10,000 terms evaluates for arithmetic, And and As, in the same order as a short chain
test('a left-deep chain of 10,000 terms evaluates', () => {
  assert.equal(evaluate(`1${'+1'.repeat(9999)}`), 10000);
  assert.equal(evaluate(`true${' && true'.repeat(9999)}`), true);
  assert.equal(evaluate(`1${' As a'.repeat(9999)}`), 1);
});

// @test-kind contract: a member chain of 10,000 terms (x and 9,999 names) reads a record nested that deep without a recursion per name
test('a member chain of 10,000 terms reads a record nested that deep', () => {
  // Lazy records (LAZY) are passed through unconverted, so the input itself does not recurse 9,999 levels deep.
  let record = 1;
  for (let depth = 0; depth < 9999; depth += 1) {
    const inner = record;
    record = {
      [LAZY]: true,
      get a() {
        return inner;
      },
    };
  }
  const result = powerFxEngine.evaluateSync(`x${'.a'.repeat(9999)}`, { host: {}, values: { x: record } });
  assert.equal(result.value, 1);
  assert.doesNotThrow(() => parse(`x${'.a'.repeat(9998)}.Abs(1)`));
});

// @test-kind security: a left-deep chain of more than 10,000 terms is a PowerFxSyntaxError (400) in every link kind
test('a left-deep chain of 10,001 terms is a syntax error for operators, member names and As', () => {
  const syntaxError = (error) => error.code === 'PowerFxSyntaxError' && error.status === 400;
  assert.throws(() => parse(`1${'+1'.repeat(10000)}`), syntaxError);
  assert.throws(() => parse(`x${'.a'.repeat(10000)}`), syntaxError);
  assert.throws(() => parse(`1${' As a'.repeat(10000)}`), syntaxError);
});

// @test-kind security: a formula of 200,000 terms is a PowerFxSyntaxError (400) when evaluated, not a RangeError from the stack
test('a left-deep chain of 200,000 terms is a syntax error when evaluated', () => {
  assert.throws(
    () => evaluate(`1${'+1'.repeat(200000)}`),
    (error) => error.code === 'PowerFxSyntaxError' && error.status === 400,
  );
});
