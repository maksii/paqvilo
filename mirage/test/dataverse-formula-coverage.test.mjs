// Formula columns (lib/dataverse-formula.mjs, lib/power-fx-formula-columns.mjs): a coverage matrix of every function of
// "Formula reference - Dataverse formula columns" and every operator of "Work with formula columns". Each row is one
// formula column of an invented table read through the Web API: it either evaluates to the documented result (the
// function reference's own examples where it has them) or reads null with FORMULA_UNSUPPORTED naming the documented
// restriction it breaks.
// @test-kind compatibility: Learn https://learn.microsoft.com/power-platform/power-fx/formula-reference-formula-columns, https://learn.microsoft.com/power-apps/maker/data-platform/formula-columns and the Power Fx function reference pages each row cites
import test from 'node:test';
import assert from 'node:assert/strict';
import { EXTENSION } from '../lib/dataverse-formula.mjs';
import { checkFormulaColumn } from '../lib/power-fx-formula-columns.mjs';
import { FxFloat, evaluateFx } from '../lib/power-fx.mjs';
import { contractModuleFixture } from './contract-module-fixture.mjs';

/** Functions of "Formula reference - Dataverse formula columns", in the article's order. */
const FORMULA_COLUMN_FUNCTIONS = Object.freeze([
  'Abs',
  'And',
  'Average',
  'Blank',
  'Char',
  'Concatenate',
  'DateAdd',
  'DateDiff',
  'Day',
  'Decimal',
  'EndsWith',
  'Error',
  'Exp',
  'Float',
  'Hour',
  'If',
  'IfError',
  'Int',
  'IsBlank',
  'IsError',
  'ISOWeekNum',
  'IsUTCToday',
  'Left',
  'Len',
  'Ln',
  'Lower',
  'Max',
  'Mid',
  'Min',
  'Minute',
  'Mod',
  'Month',
  'Not',
  'Now',
  'Or',
  'Power',
  'Replace',
  'Right',
  'Round',
  'RoundDown',
  'RoundUp',
  'Second',
  'Sqrt',
  'StartsWith',
  'Substitute',
  'Sum',
  'Switch',
  'Text',
  'Trim',
  'Trunc',
  'TrimEnds',
  'Upper',
  'UTCNow',
  'UTCToday',
  'Value',
  'Weekday',
  'WeekNum',
  'Year',
]);

/** Operators of "Work with formula columns" (Operators), plus the && || ! and ^ operators the function reference names. */
const FORMULA_COLUMN_OPERATORS = Object.freeze(['+', '-', '*', '/', '%', 'in', 'exactin', '&', '&&', '||', '!', '^']);

/** The documented maximum formula expression length (power-fx-formula-columns.mjs refuses a longer formula). */
const FORMULA_MAX_LENGTH = 1000;

const ROW = '66666666-6666-4666-8666-6666666666c1';
const PARENT = '66666666-6666-4666-8666-6666666666c2';
// Learn "Now, Today, IsToday, UTCNow, UTCToday, and IsUTCToday": the examples' instant (8:58 PM, July 11, 2021, UTC-8).
const CLOCK = Date.parse('2021-07-12T04:58:00Z');

const INPUTS = {
  x_name: { dataverseType: 'nvarchar' },
  x_num: { dataverseType: 'decimal' },
  x_whole: { dataverseType: 'int' },
  x_none: { dataverseType: 'decimal' },
  x_flag: { dataverseType: 'bit' },
  x_yes: { dataverseType: 'bit' },
  x_when: { dataverseType: 'datetime', dateTimeBehavior: 'TimeZoneIndependent' },
  x_local: { dataverseType: 'datetime', dateTimeBehavior: 'UserLocal' },
  x_day: { dataverseType: 'datetime', dateTimeBehavior: 'DateOnly' },
  x_newyear: { dataverseType: 'datetime', dateTimeBehavior: 'DateOnly' },
  x_jan: { dataverseType: 'datetime', dateTimeBehavior: 'DateOnly' },
  x_price: { dataverseType: 'money' },
  x_price_base: { dataverseType: 'money' },
  x_huge: { dataverseType: 'money' },
  x_choice: { dataverseType: 'picklist' },
  x_parentid: { dataverseType: 'lookup', targets: ['x_parent'] },
};
const VALUES = {
  // Learn "Left, Mid, and Right": the examples' "E. E. Cummings".
  x_name: 'E. E. Cummings',
  x_num: 4,
  x_whole: 25, // Learn "If and Switch": Slider1.Value = 25
  x_none: null,
  x_flag: false, // Learn "And, Or, and Not": a = false, b = true
  x_yes: true,
  x_when: '2015-04-09T15:59:37Z', // Learn "Day, Month, Year, Hour, Minute, Second, and Weekday": 3:59:37 PM, April 9, 2015
  x_local: '2015-04-09T15:59:37Z',
  x_day: '2013-07-15T00:00:00Z', // Learn "DateAdd, DateDiff": July 15, 2013
  x_newyear: '2014-01-01T00:00:00Z',
  x_jan: '2021-01-03T00:00:00Z', // Learn "WeekNum and ISOWeekNum": Sun Jan 3, 2021
  x_price: 12.5,
  x_price_base: 12.5,
  x_huge: 200000000000,
  x_choice: 1,
};

// One matrix row: [covers, formula, column type, expected]. covers names the documented function or operator; expected is
// the value read, or { unsupported: construct }, or { error: ErrorKind name } (the formula answers an error: it reads null
// with FORMULA_ERROR). A decimal column has precision 10.
const unsupported = (construct) => ({ unsupported: construct });
const error = (kind) => ({ error: kind });
const MATRIX = [
  // Operators ("Work with formula columns", Operators; Learn "Operators and Identifiers").
  ['+', 'x_num + x_whole', 'decimal', 29],
  // "If there's a numeric column that's null then it's considered 0 in the intermediate operation ... 0 + 2 + 3 = 5."
  ['+', 'x_none + 2 + 3', 'decimal', 5],
  ['-', 'x_whole - x_num', 'decimal', 21],
  ['*', 'x_num * x_whole', 'decimal', 100],
  ['*', 'x_none * 3', 'decimal', 0],
  ['/', '7 / 2', 'decimal', 3.5],
  ['/', 'x_num / (x_whole - 25)', 'decimal', error('Div0')],
  ['%', 'x_num * 50%', 'decimal', 2],
  ['in', '"The" in "the keyboard and the monitor"', 'bit', true],
  ['exactin', '"Windows" exactin "the Windows operating system"', 'bit', true],
  ['exactin', '"windows" exactin "the Windows operating system"', 'bit', false],
  ['&', 'x_name & "!"', 'nvarchar', 'E. E. Cummings!'],
  // "Formula columns don't support using numbers ... In the implicit formulas, such as 12 & "foo""
  ['&', '12 & "foo"', 'nvarchar', unsupported('text-coercion')],
  ['&', 'x_num & "x"', 'nvarchar', unsupported('text-coercion')],
  ['&', 'x_when & ""', 'nvarchar', unsupported('text-coercion')],
  // "Options of a choice can't be passed as an argument to string functions."
  ['&', 'x_choice & ""', 'nvarchar', unsupported('text-coercion')],
  ['&&', 'x_flag && x_yes', 'bit', false],
  ['||', 'x_flag || x_yes', 'bit', true],
  ['!', '!x_flag', 'bit', true],
  ['^', '2 ^ 3', 'decimal', 8],

  // Functions, in the order of "Formula reference - Dataverse formula columns".
  ['Abs', 'Abs(-55)', 'decimal', 55],
  ['And', 'And(x_flag, x_yes)', 'bit', false],
  ['Average', 'Average(1, 2, 6)', 'decimal', 3],
  ['Blank', 'If(x_whole > 1000, 1, Blank())', 'decimal', null],
  ['Char', 'Char(65)', 'nvarchar', 'A'],
  ['Concatenate', 'Concatenate("Doe", ", ", "Jane")', 'nvarchar', 'Doe, Jane'],
  ['Concatenate', 'Concatenate(Text(123, "#"), "ab")', 'nvarchar', '123ab'],
  ['Concatenate', 'Concatenate("n", x_num)', 'nvarchar', unsupported('string-argument')],
  // "Work with formula columns", function example.
  ['DateAdd', 'DateAdd(UTCNow(), -1, TimeUnit.Years)', 'datetime', '2020-07-12T04:58:00Z'],
  ['DateAdd', 'DateAdd(x_when, 4, TimeUnit.Hours)', 'datetime', '2015-04-09T19:59:37Z'],
  ['DateDiff', 'DateDiff(x_day, x_newyear)', 'int', 170],
  ['DateDiff', 'DateDiff(x_day, x_newyear, TimeUnit.Months)', 'int', 6],
  // "User local behavior column can't be compared or used with a DateTime(TZI)/DateOnly behavior column."
  ['DateDiff', 'DateDiff(x_local, x_day)', 'int', unsupported('date-behaviour')],
  ['Day', 'Day(x_when)', 'int', 9],
  ['Decimal', 'Decimal("123.456")', 'decimal', 123.456],
  ['Decimal', 'Decimal(x_price) * 2', 'decimal', 25],
  ['EndsWith', 'EndsWith("Hello World", "world")', 'bit', true],
  ['EndsWith', 'EndsWith("Bye bye", "")', 'bit', true],
  ['Error', 'Error({ Kind: ErrorKind.Validation })', 'decimal', error('Validation')],
  ['Exp', 'Exp(2)', 'decimal', 7.3890560989],
  ['Float', 'Float(x_num) / 3', 'double', 4 / 3],
  ['Hour', 'Hour(x_when)', 'int', 15],
  ['If', 'If(x_whole = 25, "Result1", "Result2")', 'nvarchar', 'Result1'],
  ['If', 'If(x_whole > 1000, "Result1")', 'nvarchar', null],
  ['If', 'If(x_whole > 1000, "Result1", x_whole > 50, "Result2", "Result3")', 'nvarchar', 'Result3'],
  ['IfError', 'IfError(1/0, 2)', 'decimal', 2],
  ['IfError', 'IfError(10, 20, 30)', 'decimal', 30],
  ['Int', 'Int(-7.9)', 'decimal', -8],
  ['IsBlank', 'IsBlank(x_none)', 'bit', true],
  ['IsError', 'IsError(1/0)', 'bit', true],
  ['IsError', 'IsError(Blank())', 'bit', false],
  ['ISOWeekNum', 'ISOWeekNum(x_jan)', 'int', 53],
  ['IsUTCToday', 'IsUTCToday(UTCNow())', 'bit', true],
  ['IsUTCToday', 'IsUTCToday(UTCToday())', 'bit', true],
  ['Left', 'Left(x_name, 5)', 'nvarchar', 'E. E.'],
  ['Len', 'Len(x_name)', 'int', 14],
  ['Len', 'Len("")', 'int', 0],
  // "Formula columns don't support using numbers ... In string functions ... Len"
  ['Len', 'Len(x_whole)', 'int', unsupported('string-argument')],
  // "Date time columns and date time functions UTCNow(), Now() can't be passed as a parameter to string functions."
  ['Len', 'Len(Now())', 'int', unsupported('string-argument')],
  ['Ln', 'Ln(100)', 'decimal', 4.605170186],
  ['Lower', 'Lower("ABC")', 'nvarchar', 'abc'],
  ['Max', 'Max(1, 5, 3)', 'decimal', 5],
  ['Mid', 'Mid(x_name, 7, 4)', 'nvarchar', 'Cumm'],
  ['Mid', 'Mid(x_name, 7)', 'nvarchar', 'Cummings'],
  ['Min', 'Min(4, 2)', 'decimal', 2],
  ['Minute', 'Minute(x_when)', 'int', 59],
  ['Mod', 'Mod(25, -4)', 'decimal', -3],
  ['Mod', 'Mod(-25, 4)', 'decimal', 3],
  ['Month', 'Month(x_when)', 'int', 4],
  ['Not', 'Not(x_flag)', 'bit', true],
  ['Now', 'Now()', 'datetime', '2021-07-12T04:58:00Z'],
  ['Or', 'Or(x_flag, x_yes)', 'bit', true],
  ['Power', 'Power(5, 3)', 'decimal', 125],
  ['Replace', 'Replace("abcdefghijk", 6, 5, "*")', 'nvarchar', 'abcde*k'],
  ['Right', 'Right(x_name, 5)', 'nvarchar', 'mings'],
  ['Round', 'Round(430.125, 2)', 'decimal', 430.13],
  ['Round', 'Round(-7.5, 0)', 'decimal', -8],
  ['RoundDown', 'RoundDown(430.128, 2)', 'decimal', 430.12],
  ['RoundUp', 'RoundUp(430.123, 2)', 'decimal', 430.13],
  ['Second', 'Second(x_when)', 'int', 37],
  ['Sqrt', 'Sqrt(9)', 'decimal', 3],
  ['StartsWith', 'StartsWith("Hello World", "hello")', 'bit', true],
  ['StartsWith', 'StartsWith(x_num, "4")', 'bit', unsupported('string-argument')],
  ['Substitute', 'Substitute("Quarter 1, 2011", "1", "2", 3)', 'nvarchar', 'Quarter 1, 2012'],
  ['Substitute', 'Substitute("Quarter 1, 2011", "1", "2")', 'nvarchar', 'Quarter 2, 2022'],
  ['Sum', 'Sum(1, 2, 3)', 'decimal', 6],
  ['Sum', 'Sum(x_none, 2)', 'decimal', 2],
  ['Switch', 'Switch(x_whole, 20, "Result1", 25, "Result2", 30, "Result3")', 'nvarchar', 'Result2'],
  ['Switch', 'Switch(x_whole, 20, "Result1", 10, "Result2", "DefaultResult")', 'nvarchar', 'DefaultResult'],
  // "Work with formula columns": Text(Number, Format) converts a number to text; its two examples.
  ['Text', 'Text(123, "#")', 'nvarchar', '123'],
  ['Text', 'Text(123, "#") & "foo"', 'nvarchar', '123foo'],
  ['Text', 'Text(x_when, "yyyy-mm-dd")', 'nvarchar', '2015-04-09'],
  ['Text', 'Text(x_num)', 'nvarchar', unsupported('text-number')],
  ['Text', 'Text(x_name, "#")', 'nvarchar', unsupported('text-format')],
  ['Text', 'Text(x_num, "#,##0.00")', 'nvarchar', unsupported('locale-format')],
  ['Trim', 'Trim("  Hello   World  ")', 'nvarchar', 'Hello World'],
  ['Trunc', 'Trunc(-7.9)', 'decimal', -7],
  ['TrimEnds', 'TrimEnds("  Hello   World  ")', 'nvarchar', 'Hello   World'],
  ['Upper', 'Upper(x_name)', 'nvarchar', 'E. E. CUMMINGS'],
  ['Upper', 'Upper(x_choice)', 'nvarchar', unsupported('string-argument')],
  ['UTCNow', 'UTCNow()', 'datetime', '2021-07-12T04:58:00Z'],
  ['UTCNow', 'Hour(UTCNow())', 'int', 4],
  ['UTCToday', 'Day(UTCToday())', 'int', 12],
  ['Value', 'Value("12")', 'decimal', 12],
  // "The Text and Value functions only work with whole numbers, where no decimal separator is involved."
  ['Value', 'Value("12.5")', 'decimal', unsupported('value-separator')],
  ['Weekday', 'Weekday(x_when)', 'int', 5],
  // "StartOfWeek argument isn't supported for the WeekNum and Weekday functions in formula columns."
  ['Weekday', 'Weekday(x_when, StartOfWeek.Wednesday)', 'int', unsupported('start-of-week')],
  ['WeekNum', 'WeekNum(x_jan)', 'int', 2],
  ['WeekNum', 'WeekNum(x_jan, StartOfWeek.Wednesday)', 'int', unsupported('start-of-week')],
  ['Year', 'Year(x_when)', 'int', 2015],

  // Data types ("Work with formula columns", Data types): whole number, choice and a related table's column.
  ['type:int', 'x_whole * 2', 'int', 50],
  ['type:picklist', 'x_choice', 'picklist', 1],
  ['type:lookup', 'x_parentid.x_rate * x_num', 'decimal', 12],
  // Guidelines and limitations.
  ['currency', 'x_price * 2', 'decimal', unsupported('currency')],
  ['currency', 'Decimal(x_parentid.x_cost)', 'decimal', unsupported('related-currency')],
  ['currency', 'Decimal(x_price_base)', 'decimal', unsupported('base-currency')],
  ['date-behaviour', 'x_when > x_day', 'bit', true],
  ['date-behaviour', 'x_local > x_day', 'bit', unsupported('date-behaviour')],
  ['range', '200000000000 + 1', 'decimal', unsupported('literal-range')],
  ['length', `1${' + 1'.repeat(FORMULA_MAX_LENGTH / 4)}`, 'decimal', unsupported('length')],
];

const columnName = (index) => `x_f${String(index).padStart(3, '0')}`;
const layout = () => ({
  mappings: {
    x_parent: {
      logicalName: 'x_parent',
      entitySet: 'x_parents',
      idColumn: 'x_parentid',
      nameColumn: 'x_name',
      fields: {
        x_name: { dataverseType: 'nvarchar' },
        x_rate: { dataverseType: 'decimal' },
        x_cost: { dataverseType: 'money' },
      },
    },
    x_sheet: {
      logicalName: 'x_sheet',
      entitySet: 'x_sheets',
      idColumn: 'x_sheetid',
      nameColumn: 'x_name',
      relationships: { x_parent: { many: false, from: 'x_parentid', to: 'x_parentid', entity: 'x_parent' } },
      fields: {
        ...INPUTS,
        ...Object.fromEntries(
          MATRIX.map(([, formula, dataverseType], index) => [
            columnName(index),
            { dataverseType, precision: 10, columnMetadata: { sourceType: 3, formulaDefinition: formula } },
          ]),
        ),
      },
    },
  },
  tables: {
    x_parent: [{ x_parentid: PARENT, x_name: 'Invented parent', x_rate: 3, x_cost: 7 }],
    x_sheet: [
      { x_sheetid: ROW, ...VALUES, x_parentid: { id: PARENT, logical_name: 'x_parent' }, statecode: 0, statuscode: 1 },
    ],
  },
});

async function readSheet(t) {
  const diagnostics = [];
  const captured = {};
  const extension = {
    ...EXTENSION,
    install: (api, options) => {
      captured.api = api;
      return EXTENSION.install(api, options);
    },
  };
  const fixture = await contractModuleFixture(t, {
    ...layout(),
    extension,
    options: { diagnostic: (entry) => diagnostics.push(entry) },
  });
  captured.api.clock = () => CLOCK;
  const row = await fixture.json(await fixture.request('GET', `/x_sheets(${ROW})`), 200);
  return { row, diagnostics };
}

const instant = (value) => (typeof value === 'string' ? new Date(value).toISOString() : value);

test('every documented formula column function and operator has a matrix row', () => {
  const covered = new Set(MATRIX.map(([covers]) => covers));
  assert.deepEqual(
    FORMULA_COLUMN_FUNCTIONS.filter((name) => !covered.has(name)),
    [],
  );
  assert.deepEqual(
    FORMULA_COLUMN_OPERATORS.filter((name) => !covered.has(name)),
    [],
  );
  assert.equal(FORMULA_COLUMN_FUNCTIONS.length, 58, 'the 58 functions of the formula reference');
});

test('each matrix formula evaluates to the documented result or is refused with FORMULA_UNSUPPORTED', async (t) => {
  const { row, diagnostics } = await readSheet(t);
  const byColumn = (code, column) => diagnostics.filter((entry) => entry.code === code && entry.column === column);
  const failures = [];
  MATRIX.forEach(([covers, formula, type, expected], index) => {
    const column = columnName(index);
    const actual = row[column];
    const label = `${covers}: ${formula.slice(0, 80)} (${type})`;
    if (expected && typeof expected === 'object' && 'unsupported' in expected) {
      const refused = byColumn('FORMULA_UNSUPPORTED', column);
      if (actual !== null || refused.length !== 1 || refused[0].construct !== expected.unsupported)
        failures.push(
          `${label}: expected refusal ${expected.unsupported}, got ${JSON.stringify(actual)} ${JSON.stringify(refused)}`,
        );
      return;
    }
    if (byColumn('FORMULA_UNSUPPORTED', column).length)
      failures.push(`${label}: refused ${JSON.stringify(byColumn('FORMULA_UNSUPPORTED', column))}`);
    if (expected && typeof expected === 'object' && 'error' in expected) {
      const errors = byColumn('FORMULA_ERROR', column);
      if (actual !== null || errors.length !== 1 || errors[0].kind !== expected.error)
        failures.push(
          `${label}: expected error ${expected.error}, got ${JSON.stringify(actual)} ${JSON.stringify(errors)}`,
        );
      return;
    }
    const value = type === 'datetime' ? instant(actual) : actual;
    const wanted = type === 'datetime' ? instant(expected) : expected;
    if (value !== wanted) failures.push(`${label}: expected ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`);
  });
  assert.deepEqual(failures, []);
  assert.deepEqual(
    diagnostics.filter((entry) => !['FORMULA_UNSUPPORTED', 'FORMULA_ERROR'].includes(entry.code)),
    [],
  );
});

// "Create formula columns with decimal, whole number, float, and choice data types" (guidelines for float columns).
test('a numeric function is typed by its first argument; Float, Sqrt, Ln, Power, Exp and ^ return a float', () => {
  const typeOf = (expression) =>
    evaluateFx(expression, { host: { formulaColumn: true } }).value instanceof FxFloat ? 'float' : 'decimal';
  const cases = {
    '1 + 2 + Float(1)': 'float', // "If an operand involved in an arithmetic operation is of float type ..."
    'Sum(1, 2, Float(1))': 'decimal',
    'Sum(Float(1), 1, 2)': 'float',
    'Max(Float(0.1), 0.2)': 'float',
    'Max(0.1, Float(0.2))': 'decimal',
    'Min(Float(3), 4)': 'float',
    'Average(1, Float(2))': 'decimal',
    'Abs(Float(-1.5))': 'float',
    'Round(Float(2.345), 2)': 'float',
    'Mod(5, Float(2))': 'decimal',
    'Mod(Float(5), 2)': 'float',
    'Float(1)': 'float',
    'Sqrt(16)': 'float',
    'Ln(1)': 'float',
    'Power(2, 3)': 'float',
    'Exp(0)': 'float',
    '2 ^ 3': 'float',
    '0.1 + 0.2': 'decimal',
  };
  assert.deepEqual(Object.fromEntries(Object.keys(cases).map((expression) => [expression, typeOf(expression)])), cases);
  // The decimal result is exact: Sum(0.1, Float(0.2)) is the decimal 0.3, not the float 0.30000000000000004.
  assert.equal(Number(evaluateFx('Sum(0.1, Float(0.2))', { host: { formulaColumn: true } }).value), 0.3);
});

// @test-kind unproven: the documented decimal range (-100000000000 to 100000000000) is applied to the final value and to Decimal(); Learn states the range and that Decimal() of an out-of-range currency value makes the formula return null, but not the outcome for another out-of-range result
test('a decimal result or a Decimal() of a currency value outside the documented range reads null', async (t) => {
  const formulas = {
    x_over: 'x_num * 30000000000',
    x_huge_decimal: 'Decimal(x_huge)',
    x_inside: 'x_num * 20000000000',
  };
  const own = layout();
  for (const [name, formula] of Object.entries(formulas))
    own.mappings.x_sheet.fields[name] = {
      dataverseType: 'decimal',
      columnMetadata: { sourceType: 3, formulaDefinition: formula },
    };
  const diagnostics = [];
  const { request, json } = await contractModuleFixture(t, {
    ...own,
    extension: EXTENSION,
    options: { diagnostic: (entry) => diagnostics.push(entry) },
  });
  const row = await json(await request('GET', `/x_sheets(${ROW})?$select=x_over,x_huge_decimal,x_inside`), 200);
  assert.deepEqual([row.x_over, row.x_huge_decimal, row.x_inside], [null, null, 80000000000]);
  assert.deepEqual(
    diagnostics
      .filter((entry) => ['x_over', 'x_huge_decimal'].includes(entry.column))
      .map((entry) => [entry.column, entry.code]),
    [
      ['x_over', 'FORMULA_OUT_OF_RANGE'],
      ['x_huge_decimal', 'FORMULA_ERROR'],
    ],
  );
});

// @test-kind contract: Paqvilo's design: functions outside the documented list are evaluated, not refused, and a formula the parser rejects is left to the evaluator
test('the checker refuses only documented restrictions', () => {
  const columnsOf = () => ({ x_num: { dataverseType: 'decimal' }, x_name: { dataverseType: 'nvarchar' } });
  const check = (expression) => checkFormulaColumn(expression, { table: 'x_sheet', column: 'x_out', columnsOf });
  assert.equal(check('Coalesce(x_num, 1)'), null);
  assert.equal(check('If(x_num > 1, x_num, 2) & "x"'), null, 'an untyped node is never refused');
  assert.equal(check('x_num +'), null);
  assert.equal(check('Text(x_num, "0")'), null);
});
