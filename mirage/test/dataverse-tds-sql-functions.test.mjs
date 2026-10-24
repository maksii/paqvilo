import test from 'node:test';
import assert from 'node:assert/strict';
import { FUNCTIONS, callFunction, castValue, returnType, systemVariable } from '../lib/dataverse-tds-sql-functions.mjs';

const utc = (y, mo, d, h = 0, mi = 0, s = 0, ms = 0) => new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms));
const dec = (decimal) => ({ decimal });
const call = (name, args, ctx) => callFunction(name, args, ctx);
const fails = (number, message) => (e) => e.number === number && (message === undefined || e.message === message);

const REQUIRED = [
  'LEN',
  'DATALENGTH',
  'LEFT',
  'RIGHT',
  'SUBSTRING',
  'CHARINDEX',
  'PATINDEX',
  'REPLACE',
  'REPLICATE',
  'REVERSE',
  'LOWER',
  'UPPER',
  'LTRIM',
  'RTRIM',
  'TRIM',
  'CONCAT',
  'CONCAT_WS',
  'STUFF',
  'SPACE',
  'STR',
  'FORMAT',
  'QUOTENAME',
  'ASCII',
  'CHAR',
  'UNICODE',
  'NCHAR',
  'GETDATE',
  'GETUTCDATE',
  'SYSDATETIME',
  'SYSUTCDATETIME',
  'DATEADD',
  'DATEDIFF',
  'DATEPART',
  'DATENAME',
  'YEAR',
  'MONTH',
  'DAY',
  'EOMONTH',
  'DATEFROMPARTS',
  'ISDATE',
  'ABS',
  'CEILING',
  'FLOOR',
  'ROUND',
  'POWER',
  'SQRT',
  'SQUARE',
  'SIGN',
  'EXP',
  'LOG',
  'LOG10',
  'PI',
  'RAND',
  'ISNULL',
  'COALESCE',
  'NULLIF',
  'IIF',
  'CHOOSE',
  'NEWID',
  'CONVERT',
  'TRY_CONVERT',
  'ISNUMERIC',
  'ROWCOUNT_BIG',
  'GETANSINULL',
];

test('every required function is registered and refuses a call outside its arity with 174', () => {
  for (const name of REQUIRED) {
    const f = FUNCTIONS.get(name);
    assert.ok(f, `missing ${name}`);
    for (const count of [f.minArgs - 1, f.maxArgs + 1].filter((n) => n >= 0)) {
      assert.throws(() => call(name, Array(count).fill(1)), fails(174), `${name} with ${count} arguments`);
    }
  }
});

const cases = [
  // NULL propagation
  ['LEN', [null], null],
  ['LEFT', [null, 2], null],
  ['DATEADD', ['day', null, utc(2026, 1, 1)], null],
  ['ROUND', [dec('1.5'), null], null],
  ['CONCAT', ['a', null, 'b'], 'ab'],
  ['CONCAT_WS', [',', 'a', null, 'b'], 'a,b'],
  ['CONCAT_WS', [null, 'a', 'b'], null],
  ['ISNULL', [null, 'x'], 'x'],
  ['ISNULL', ['y', 'x'], 'y'],
  ['COALESCE', [null, null, 3], 3],
  ['NULLIF', [1, 1], null],
  ['NULLIF', [1, null], 1],
  ['NULLIF', [null, 1], null],
  ['IIF', [null, 1, 2], 2],
  ['IIF', [true, 1, 2], 1],
  ['CHOOSE', [2, 'a', 'b', 'c'], 'b'],
  ['CHOOSE', [4, 'a'], null],
  ['CHOOSE', [null, 'a'], null],
  ['ISNUMERIC', [null], 0],
  ['ISDATE', [null], 0],

  // strings
  ['LEN', ['abc   '], 3],
  ['LEN', [''], 0],
  ['DATALENGTH', ['abc'], 6],
  ['DATALENGTH', [utc(2026, 1, 1)], 8],
  ['LEFT', ['abcdef', 2], 'ab'],
  ['LEFT', ['ab', 5], 'ab'],
  ['RIGHT', ['abcdef', 2], 'ef'],
  ['RIGHT', ['ab', 0], ''],
  ['SUBSTRING', ['abcdef', 2, 3], 'bcd'],
  ['SUBSTRING', ['abc', 0, 2], 'a'],
  ['SUBSTRING', ['abc', 5, 2], ''],
  ['CHARINDEX', ['bicycle', 'Reflectors are vital safety components of your bicycle.'], 48],
  ['CHARINDEX', ['vital', 'Reflectors are vital safety components of your bicycle.', 5], 16],
  ['CHARINDEX', ['bike', 'Reflectors are vital safety components of your bicycle.'], 0],
  ['CHARINDEX', ['vital', 'Reflectors are vital safety components of your bicycle.', 17], 0],
  ['CHARINDEX', ['TEST', 'This is a Test'], 11],
  ['CHARINDEX', ['TEST', 'This is a Test', 1], 0, { caseSensitive: true }],
  ['PATINDEX', ['%[0-9]%', 'abc4'], 4],
  ['PATINDEX', ['a_c', 'zabc'], 2],
  ['PATINDEX', ['%x%', 'abc'], 0],
  ['REPLACE', ['abcabc', 'B', 'X'], 'aXcaXc'],
  ['REPLACE', ['abcabc', 'B', 'X'], 'abcabc', { caseSensitive: true }],
  ['REPLICATE', ['ab', 3], 'ababab'],
  ['REPLICATE', ['a', -1], null],
  ['REVERSE', ['abc'], 'cba'],
  ['LTRIM', ['  a '], 'a '],
  ['RTRIM', ['  a '], '  a'],
  ['TRIM', ['  a  '], 'a'],
  ['TRIM', ['x', 'xxaxx'], 'a'],
  ['STUFF', ['abcdef', 2, 3, 'XY'], 'aXYef'],
  ['STUFF', ['abc', 2, 0, 'X'], 'aXbc'],
  ['STUFF', ['abc', 4, 0, 'x'], null],
  ['SPACE', [3], '   '],
  ['SPACE', [-1], null],
  ['STR', [123.456], '       123'],
  ['STR', [123.456, 6, 2], '123.46'],
  ['STR', [12345, 3], '***'],
  ['QUOTENAME', ['abc[]def'], '[abc[]]def]'],
  ['QUOTENAME', ["user's", "'"], "'user''s'"],
  ['QUOTENAME', ['x', '%'], null],
  ['QUOTENAME', ['a'.repeat(129)], null],
  ['ASCII', ['A'], 65],
  ['ASCII', [''], null],
  ['CHAR', [65], 'A'],
  ['CHAR', [256], null],
  ['UNICODE', ['é'], 233],
  ['NCHAR', [0x20ac], '€'],
  ['NCHAR', [70000], null],
  ['CONCAT', ['a', 1], 'a1'],
  ['FORMAT', [1234.5, '#,##0.00'], '1,234.50'],
  ['FORMAT', [0.5, '0.00'], '0.50'],
  ['FORMAT', [utc(2026, 10, 19, 15, 4, 5), 'yyyy-MM-dd HH:mm:ss'], '2026-10-19 15:04:05'],
  ['FORMAT', [utc(2026, 10, 19), 'dddd'], 'Monday'],
  ['FORMAT', [1234.5, 'N2', 'en-US'], '1,234.50'],
  ['FORMAT', [1234.5, 'N2', 'de-DE'], '1.234,50'],
  ['FORMAT', [1234.5, '#,##0.00', 'de-DE'], '1.234,50'],
  ['FORMAT', [1234.5, 'C', 'en-US'], '$1,234.50'],
  ['FORMAT', [0.5, 'P0', 'en-US'], '50%'],
  ['FORMAT', [utc(2026, 10, 19), 'd'], '10/19/2026'],
  ['FORMAT', [utc(2026, 10, 19), 'd', 'de-DE'], '19.10.2026'],
  ['FORMAT', [utc(2026, 10, 19), 'dddd, dd MMMM yyyy', 'de-DE'], 'Montag, 19 Oktober 2026'],
  ['FORMAT', [1234.5, 'N2', 'xx-YY'], null],
  ['FORMAT', [1234.5, 'N2', 'not a culture'], null],

  // date and time
  ['DATEDIFF', ['day', '2036-03-01', '2036-02-28'], -2],
  ['DATEDIFF', ['day', '2007-05-06 23:59:59.999', '2007-05-07 00:00:00'], 1],
  ['DATEDIFF', ['year', '2000-12-31', '2001-01-01'], 1],
  ['DATEDIFF', ['month', '2026-01-31', '2026-02-01'], 1],
  ['DATEDIFF', ['week', '2026-10-17', '2026-10-18'], 1],
  ['DATEDIFF', ['hour', '2026-01-01 00:59', '2026-01-01 01:00'], 1],
  ['DATEDIFF', ['second', '2026-01-01 00:00:00', '2026-01-01 00:01:30'], 90],
  ['DATEADD', ['month', 1, '2026-01-31'], utc(2026, 2, 28)],
  ['DATEADD', ['day', 1, '2026-02-28'], utc(2026, 3, 1)],
  ['DATEADD', ['year', -1, '2024-02-29'], utc(2023, 2, 28)],
  ['DATEADD', ['hour', 25, '2026-01-01'], utc(2026, 1, 2, 1)],
  ['DATEADD', ['millisecond', 1500, '2026-01-01 00:00:00'], utc(2026, 1, 1, 0, 0, 1, 500)],
  ['DATEPART', ['weekday', utc(2026, 10, 19)], 2],
  ['DATEPART', ['dayofyear', utc(2026, 10, 19)], 292],
  ['DATEPART', ['week', utc(2026, 1, 1)], 1],
  ['DATEPART', ['week', utc(2026, 1, 4)], 2],
  ['DATENAME', ['month', utc(2026, 10, 19)], 'October'],
  ['DATENAME', ['weekday', utc(2026, 10, 19)], 'Monday'],
  ['DATENAME', ['quarter', utc(2026, 10, 19)], '4'],
  ['YEAR', [utc(2026, 10, 19)], 2026],
  ['MONTH', [utc(2026, 10, 19)], 10],
  ['DAY', [utc(2026, 10, 19)], 19],
  ['EOMONTH', ['2026-02-10'], utc(2026, 2, 28)],
  ['EOMONTH', ['2026-02-10', 1], utc(2026, 3, 31)],
  ['EOMONTH', ['2024-02-10'], utc(2024, 2, 29)],
  ['DATEFROMPARTS', [2024, 2, 29], utc(2024, 2, 29)],
  ['ISDATE', ['2026-02-28'], 1],
  ['ISDATE', ['2026-02-30'], 0],

  // math
  ['ABS', [-5], 5],
  ['ABS', [dec('-1.50')], dec('1.50')],
  ['ABS', [-7n], 7n],
  ['CEILING', [dec('1.20')], dec('2')],
  ['FLOOR', [dec('-1.20')], dec('-2')],
  ['CEILING', [-1.5], -1],
  ['FLOOR', [1.5], 1],
  ['ROUND', [dec('123.9994'), 3], dec('123.9990')],
  ['ROUND', [dec('123.9995'), 3], dec('124.0000')],
  ['ROUND', [dec('123.4545'), 2], dec('123.4500')],
  ['ROUND', [dec('123.45'), -2], dec('100.00')],
  ['ROUND', [dec('748.58'), -1], dec('750.00')],
  ['ROUND', [dec('748.58'), -2], dec('700.00')],
  ['ROUND', [dec('748.58'), -4], dec('0.00')],
  ['ROUND', [dec('150.75'), 0], dec('151.00')],
  ['ROUND', [dec('150.75'), 0, 1], dec('150.00')],
  ['ROUND', [dec('1.15'), 1], dec('1.20')],
  ['ROUND', [dec('-1.15'), 1], dec('-1.20')],
  ['ROUND', [2.5, 0], 3],
  ['ROUND', [-2.5, 0], -3],
  ['ROUND', [123.45, -2], 100],
  ['SIGN', [-3], -1],
  ['SIGN', [dec('0.0')], dec('0')],
  ['POWER', [2, 10], 1024],
  ['SQRT', [16], 4],
  ['SQUARE', [3], 9],
  ['EXP', [0], 1],
  ['LOG10', [1000], 3],
  ['PI', [], Math.PI],
];

for (const [name, args, expected, ctx] of cases) {
  test(`${name}(${args.map((a) => (a instanceof Date ? a.toISOString() : typeof a === 'bigint' ? `${a}n` : JSON.stringify(a))).join(', ')})${ctx ? ` ${JSON.stringify(ctx)}` : ''}`, () => {
    assert.deepStrictEqual(call(name, args, ctx), expected);
  });
}

test('error cases carry SQL Server numbers', () => {
  assert.throws(() => call('LEFT', ['ab', -1]), fails(536));
  assert.throws(() => call('SUBSTRING', ['abc', 1, -1]), fails(537));
  assert.throws(() => call('ROUND', [dec('748.58'), -3]), fails(8115));
  assert.throws(() => call('POWER', [-8, 1 / 3]), fails(3623));
  assert.throws(() => call('SQRT', [-1]), fails(3623));
  assert.throws(() => call('LOG', [0]), fails(3623));
  assert.throws(() => call('DATEADD', ['year', 8000, '2026-01-01']), fails(517));
  assert.throws(() => call('DATEDIFF', ['millisecond', '1753-01-01', '9999-12-31']), fails(535));
  assert.throws(() => call('DATEFROMPARTS', [2026, 2, 30]), fails(289));
  assert.throws(() => call('DATEADD', ['microsecond', 1, '2026-01-01']), fails(155));
  assert.throws(() => call('FORMAT', ['x', '0']), fails(8116));
  assert.throws(() => call('LEN', []), fails(174));
  assert.throws(() => call('ISNULL', [null]), fails(174));
});

test('unknown and unsupported functions are rejected with the documented shape', () => {
  assert.throws(() => call('NOPE', []), fails(195, "'NOPE' is not a recognized built-in function name."));
  for (const name of ['ROW_NUMBER', 'OBJECT_ID', 'ERROR_MESSAGE', 'STRING_SPLIT', 'JSON_VALUE', 'SERVERPROPERTY']) {
    assert.throws(() => call(name, []), fails(195, `'${name}' is not supported in Dataverse SQL.`));
  }
  assert.equal(call('len', ['ab']), 2);
});

test('datetime functions read the statement clock and seeded RAND is repeatable', () => {
  const now = utc(2026, 1, 2, 3, 4, 5);
  assert.deepStrictEqual(call('GETDATE', [], { now }), now);
  assert.deepStrictEqual(call('SYSUTCDATETIME', [], { now: () => now }), now);
  const a = {};
  const first = call('RAND', [42], a);
  assert.equal(call('RAND', [], a) < 1, true);
  assert.equal(call('RAND', [42], {}), first);
  const id = call('NEWID', [], { newId: () => 'FIXED' });
  assert.equal(id, 'FIXED');
  assert.match(call('NEWID', []), /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
  assert.equal(call('ROWCOUNT_BIG', [], { rowCount: 5 }), 5n);
});

const FORMATMESSAGE_CASES = [
  ['%s-%s', ['a', 'b'], 'a-b'],
  ['%5d|', [42], '   42|'],
  ['[%-10s]', ['ab'], `[${'ab'.padEnd(10)}]`],
  ['%.3s', ['abcdef'], 'abc'],
  ['%x %X %o', [255, 255, 8], 'ff FF 10'],
  ['%05d %+d', [42, 5], '00042 +5'],
  ['100%%', [], '100%'],
  ['%s|%d', [null, dec('12.9')], '(null)|12'],
  ['%u %i', [-1, 7n], '4294967295 7'],
];
for (const [message, args, expected] of FORMATMESSAGE_CASES) {
  test(`FORMATMESSAGE(${JSON.stringify(message)}, ${args.length} args)`, () => {
    assert.equal(call('FORMATMESSAGE', [message, ...args]), expected);
  });
}

test('FORMATMESSAGE rejects a message number and missing parameters', () => {
  assert.throws(
    () => call('FORMATMESSAGE', [50001, 'x']),
    fails(195, "'FORMATMESSAGE' is not supported in Dataverse SQL."),
  );
  assert.throws(() => call('FORMATMESSAGE', ['%s %s', 'a']), fails(2787));
});

// Byte order that SQL Server uses for uniqueidentifier comparison: the node bytes first, then the rest.
const sqlGuidOrder = (g) => {
  const bytes = g.replace(/-/g, '').match(/../g);
  return [10, 11, 12, 13, 14, 15, 3, 2, 1, 0, 5, 4, 7, 6, 8, 9].map((i) => bytes[i]).join('');
};
test('NEWSEQUENTIALID returns increasing GUIDs in SQL Server order', () => {
  const guid = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;
  const first = call('NEWSEQUENTIALID', []);
  const second = call('NEWSEQUENTIALID', []);
  assert.match(first, guid);
  assert.match(second, guid);
  assert.ok(sqlGuidOrder(second) > sqlGuidOrder(first));
});

test('systemVariable exposes @@VERSION and @@ROWCOUNT and rejects unsupported variables', () => {
  assert.equal(systemVariable('@@VERSION'), 'Microsoft SQL Azure (RTM) - 12.0.2000.8');
  assert.equal(systemVariable('@@ROWCOUNT', { rowCount: 3 }), 3);
  assert.throws(() => systemVariable('@@ERROR'), fails(195));
});

test('castValue follows CAST rules and raises the T-SQL conversion errors', () => {
  assert.equal(castValue(' -7 ', 'int'), -7);
  assert.equal(castValue(12.9, 'int'), 12);
  assert.equal(castValue(dec('-12.9'), 'int'), -12);
  assert.equal(castValue(7, 'bigint'), 7n);
  assert.throws(
    () => castValue('12.5', 'int'),
    fails(245, "Conversion failed when converting the nvarchar value '12.5' to data type int."),
  );
  assert.throws(
    () => castValue('abc', 'int'),
    fails(245, "Conversion failed when converting the nvarchar value 'abc' to data type int."),
  );
  assert.throws(() => castValue('3000000000', 'int'), fails(8115));
  assert.deepStrictEqual(castValue('12.345', 'decimal(10,2)'), dec('12.35'));
  assert.throws(() => castValue('1234567890123', 'decimal(5,2)'), fails(8115));
  assert.throws(() => castValue('x', 'decimal(5,2)'), fails(8114));
  assert.equal(castValue('1.5', 'float'), 1.5);
  assert.throws(() => castValue('abc', 'float'), fails(8114));
  assert.equal(castValue('bigtext', 'varchar(3)'), 'big');
  assert.equal(castValue(123, 'varchar'), '123');
  assert.equal(castValue(dec('10.50'), 'nvarchar(10)'), '10.50');
  assert.equal(castValue(true, 'nvarchar'), '1');
  assert.equal(castValue(null, 'int'), null);
  assert.equal(
    castValue('0f8fad5b-d9cb-469f-a165-70867728950e', 'uniqueidentifier'),
    '0F8FAD5B-D9CB-469F-A165-70867728950E',
  );
  assert.throws(() => castValue('nope', 'uniqueidentifier'), fails(8169));
  assert.deepStrictEqual(castValue('1', 'binary'), Buffer.from([0x31]));
  assert.deepStrictEqual(castValue('2026-10-19', 'datetime'), utc(2026, 10, 19));
  assert.deepStrictEqual(castValue('2026-10-19 13:45:10.5', 'datetime'), utc(2026, 10, 19, 13, 45, 10, 500));
  assert.throws(() => castValue('2026-02-30', 'datetime'), fails(241));
  assert.throws(() => castValue('1752-12-31', 'datetime'), fails(242));
});

const STYLE_CASES = [
  ['101', '10/19/2026', utc(2026, 10, 19)],
  ['103', '19/10/2026', utc(2026, 10, 19)],
  ['112', '20261019', utc(2026, 10, 19)],
  ['120', '2026-10-19 13:45:10', utc(2026, 10, 19, 13, 45, 10)],
  ['121', '2026-10-19 13:45:10.123', utc(2026, 10, 19, 13, 45, 10, 123)],
  ['126', '2026-10-19T13:45:10.123', utc(2026, 10, 19, 13, 45, 10, 123)],
];
for (const [style, text, expected] of STYLE_CASES) {
  test(`CONVERT(datetime, '${text}', ${style})`, () => {
    assert.deepStrictEqual(call('CONVERT', ['datetime', text, Number(style)]), expected);
  });
}

const OUT_STYLE_CASES = [
  [0, 'Oct 19 2026 01:45PM'],
  [101, '10/19/2026'],
  [103, '19/10/2026'],
  [112, '20261019'],
  [120, '2026-10-19 13:45:10'],
  [121, '2026-10-19 13:45:10.123'],
  [126, '2026-10-19T13:45:10.123'],
];
for (const [style, expected] of OUT_STYLE_CASES) {
  test(`CONVERT(nvarchar(30), datetime, ${style})`, () => {
    assert.equal(call('CONVERT', ['nvarchar(30)', utc(2026, 10, 19, 13, 45, 10, 123), style]), expected);
  });
}

test('CONVERT and TRY_CONVERT edge cases', () => {
  assert.equal(call('CONVERT', ['int', '12']), 12);
  assert.equal(call('TRY_CONVERT', ['int', 'abc']), null);
  assert.equal(call('TRY_CONVERT', ['int', '12']), 12);
  assert.throws(() => call('TRY_CONVERT', ['nosuchtype', 'x']), fails(2715));
  assert.throws(() => call('CONVERT', ['datetime', '2026-10-19', 999]), fails(9809));
  assert.equal(call('CONVERT', ['nvarchar(3)', 'abcdef']), 'abc');
});

// Binary conversions: text as bytes (varchar single-byte, nvarchar UTF-16LE), integers big-endian, binary(n) pads.
const hex = (buf) => (buf === null ? null : Buffer.from(buf).toString('hex'));
const binaryCases = [
  ['nvarchar text to varbinary is UTF-16LE', () => hex(castValue('ab', 'varbinary(8)')), '61006200'],
  [
    'varchar text to varbinary is single-byte',
    () => hex(castValue('ab', 'varbinary(8)', { fromType: 'varchar' })),
    '6162',
  ],
  ['varbinary truncates text bytes', () => hex(castValue('abcd', 'varbinary(3)', { fromType: 'varchar' })), '616263'],
  ['binary(n) pads with zero bytes', () => hex(castValue('a', 'binary(4)', { fromType: 'varchar' })), '61000000'],
  ['binary(n) truncates', () => hex(castValue('abcd', 'binary(2)', { fromType: 'varchar' })), '6162'],
  ['int is four big-endian bytes', () => hex(castValue(1, 'varbinary(4)')), '00000001'],
  ['negative int keeps two-complement bytes', () => hex(castValue(-1, 'varbinary(4)')), 'ffffffff'],
  ['int padded to binary(8) is zero-filled on the right', () => hex(castValue(258, 'binary(8)')), '0000010200000000'],
  ['bigint is eight big-endian bytes', () => hex(castValue(258n, 'varbinary(8)')), '0000000000000102'],
  ['bit true is one byte', () => hex(castValue(true, 'binary(2)')), '0100'],
  ['bit false pads', () => hex(castValue(false, 'varbinary(2)')), '00'],
  [
    'binary to varbinary(max) keeps all bytes',
    () => hex(castValue(Buffer.from('0102', 'hex'), 'varbinary(max)')),
    '0102',
  ],
  ['binary to binary(4) pads on the right', () => hex(castValue(Buffer.from('0102', 'hex'), 'binary(4)')), '01020000'],
  ['binary to varbinary(1) truncates', () => hex(castValue(Buffer.from('0102', 'hex'), 'varbinary(1)')), '01'],
  ['bare binary is one byte', () => hex(castValue('ab', 'binary', { fromType: 'varchar' })), '61'],
  ['bare varbinary is thirty bytes', () => castValue('x'.repeat(40), 'varbinary', { fromType: 'varchar' }).length, 30],
  ['NULL stays NULL', () => castValue(null, 'varbinary(4)'), null],
  ['binary back to int reads big-endian', () => castValue(Buffer.from('00000102', 'hex'), 'int'), 258],
  ['binary back to nvarchar reads UTF-16LE', () => castValue(Buffer.from('6100', 'hex'), 'nvarchar(4)'), 'a'],
];
for (const [label, run, expected] of binaryCases) {
  test(`binary conversion: ${label}`, () => {
    assert.equal(run(), expected);
  });
}
test('binary(max) is a syntax error (102)', () => {
  assert.throws(() => castValue('a', 'binary(max)'), fails(102));
});
test('dates and decimals do not convert to binary (8114)', () => {
  assert.throws(() => castValue(utc(2026, 10, 19), 'binary(8)'), fails(8114));
  assert.throws(() => castValue(dec('1.5'), 'binary(4)'), fails(8114));
});

// Static return types. Each entry: [label, name, argument types, extra, expected type object or null].
const typeCases = [
  ['LEN is int', 'LEN', [{ type: 'nvarchar', length: 9 }], {}, { type: 'int' }],
  ['UPPER keeps the input length', 'UPPER', [{ type: 'varchar', length: 9 }], {}, { type: 'nvarchar', length: 9 }],
  ['UPPER of a non-text is nvarchar(4000)', 'UPPER', [{ type: 'int' }], {}, { type: 'nvarchar', length: 4000 }],
  [
    'LEFT keeps the input length',
    'LEFT',
    [{ type: 'nvarchar', length: 12 }, { type: 'int' }],
    {},
    { type: 'nvarchar', length: 12 },
  ],
  [
    'CONCAT is nvarchar(4000)',
    'CONCAT',
    [{ type: 'nvarchar', length: 3 }, { type: 'int' }],
    {},
    { type: 'nvarchar', length: 4000 },
  ],
  ['CHAR is nvarchar(1)', 'CHAR', [{ type: 'int' }], {}, { type: 'nvarchar', length: 1 }],
  [
    'DATENAME is nvarchar(4000)',
    'DATENAME',
    [{ type: 'nvarchar' }, { type: 'datetime' }],
    {},
    { type: 'nvarchar', length: 4000 },
  ],
  [
    'ABS keeps a decimal type and scale',
    'ABS',
    [{ type: 'decimal', precision: 10, scale: 2 }],
    {},
    { type: 'decimal', precision: 10, scale: 2 },
  ],
  ['ROUND keeps an int', 'ROUND', [{ type: 'int' }, { type: 'int' }], {}, { type: 'int' }],
  ['CEILING keeps bigint', 'CEILING', [{ type: 'bigint' }], {}, { type: 'bigint' }],
  ['ABS of a string is float', 'ABS', [{ type: 'varchar', length: 5 }], {}, { type: 'float' }],
  ['SQRT of an int is float', 'SQRT', [{ type: 'int' }], {}, { type: 'float' }],
  ['LOG is float', 'LOG', [{ type: 'decimal', precision: 9, scale: 1 }], {}, { type: 'float' }],
  [
    'DATEADD is datetime',
    'DATEADD',
    [{ type: 'nvarchar' }, { type: 'int' }, { type: 'datetime' }],
    {},
    { type: 'datetime' },
  ],
  [
    'DATEDIFF is int',
    'DATEDIFF',
    [{ type: 'nvarchar' }, { type: 'datetime' }, { type: 'datetime' }],
    {},
    { type: 'int' },
  ],
  ['DATEPART is int', 'DATEPART', [{ type: 'nvarchar' }, { type: 'datetime' }], {}, { type: 'int' }],
  ['GETDATE is datetime', 'GETDATE', [], {}, { type: 'datetime' }],
  ['NEWID is uniqueidentifier', 'NEWID', [], {}, { type: 'uniqueidentifier' }],
  ['ROWCOUNT_BIG is bigint', 'ROWCOUNT_BIG', [], {}, { type: 'bigint' }],
  [
    'ISNULL takes the first argument type',
    'ISNULL',
    [{ type: 'nvarchar', length: 5 }, { type: 'int' }],
    {},
    { type: 'nvarchar', length: 5 },
  ],
  ['ISNULL of a NULL takes the second', 'ISNULL', [{ type: 'null' }, { type: 'int' }], {}, { type: 'int' }],
  ['NULLIF takes the first argument type', 'NULLIF', [{ type: 'bigint' }, { type: 'int' }], {}, { type: 'bigint' }],
  [
    'COALESCE takes the highest precedence branch',
    'COALESCE',
    [{ type: 'int' }, { type: 'bigint' }],
    {},
    { type: 'bigint' },
  ],
  [
    'COALESCE of text takes the longer length',
    'COALESCE',
    [
      { type: 'nvarchar', length: 3 },
      { type: 'varchar', length: 9 },
    ],
    {},
    { type: 'nvarchar', length: 9 },
  ],
  [
    'IIF ignores the condition type',
    'IIF',
    [{ type: 'bit' }, { type: 'decimal', precision: 5, scale: 2 }, { type: 'int' }],
    {},
    { type: 'decimal', precision: 5, scale: 2 },
  ],
  [
    'CONVERT takes the target type',
    'CONVERT',
    [{ type: 'nvarchar' }, { type: 'int' }],
    { target: 'varbinary(4)' },
    { type: 'varbinary', length: 4 },
  ],
  [
    'TRY_CONVERT takes the target precision',
    'TRY_CONVERT',
    [{ type: 'nvarchar' }, { type: 'int' }],
    { target: 'decimal(10,3)' },
    { type: 'decimal', precision: 10, scale: 3 },
  ],
  ['an unknown function has no static type', 'NO_SUCH_FUNCTION', [], {}, null],
];
for (const [label, name, args, extra, expected] of typeCases) {
  test(`return type: ${label}`, () => {
    assert.deepEqual(returnType(name, args, extra), expected);
  });
}
