import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executeBatch } from '../lib/dataverse-tds-sql-eval.mjs';

// Schema and rows: contoso_widget and contoso_part.

const col = (name, sqlType, extra = {}) => ({
  name,
  sqlType,
  length: null,
  precision: null,
  scale: null,
  nullable: true,
  ...extra,
});

const catalog = {
  tables: new Map([
    [
      'contoso_widget',
      {
        logicalName: 'contoso_widget',
        columns: [
          col('contoso_widgetid', 'uniqueidentifier', { nullable: false }),
          col('contoso_name', 'nvarchar', { length: 100 }),
          col('contoso_ownerid', 'uniqueidentifier'),
          col('contoso_owneridname', 'nvarchar', { length: 160 }),
          col('contoso_status', 'int'),
          col('contoso_statusname', 'nvarchar', { length: 100 }),
          col('contoso_price', 'money', { precision: 19, scale: 4 }),
          col('contoso_quantity', 'int'),
          col('contoso_active', 'bit'),
          col('contoso_created', 'datetime'),
        ],
      },
    ],
    [
      'contoso_part',
      {
        logicalName: 'contoso_part',
        columns: [
          col('contoso_partid', 'uniqueidentifier', { nullable: false }),
          col('contoso_widgetid', 'uniqueidentifier'),
          col('contoso_widgetidname', 'nvarchar', { length: 160 }),
          col('contoso_code', 'nvarchar', { length: 20 }),
          col('contoso_cost', 'int'),
        ],
      },
    ],
  ]),
};

const W1 = '00000000-0000-0000-0000-000000000001';
const W2 = '00000000-0000-0000-0000-000000000002';
const W3 = '00000000-0000-0000-0000-000000000003';
const W4 = '00000000-0000-0000-0000-000000000004';
const ANN = '00000000-0000-0000-0000-0000000000A1';
const BOB = '00000000-0000-0000-0000-0000000000B2';

const widgets = [
  {
    contoso_widgetid: W1,
    contoso_name: 'Bolt',
    contoso_ownerid: ANN,
    contoso_owneridname: 'Ann',
    contoso_status: 1,
    contoso_statusname: 'Active',
    contoso_price: { decimal: '2.5000' },
    contoso_quantity: 10,
    contoso_active: true,
    contoso_created: new Date('2026-01-02T03:04:05Z'),
  },
  {
    contoso_widgetid: W2,
    contoso_name: 'Nut',
    contoso_ownerid: BOB,
    contoso_owneridname: 'Bob',
    contoso_status: 2,
    contoso_statusname: 'Inactive',
    contoso_price: { decimal: '1.2500' },
    contoso_quantity: 0,
    contoso_active: false,
    contoso_created: new Date('2026-02-01T00:00:00Z'),
  },
  {
    contoso_widgetid: W3,
    contoso_name: 'Gear',
    contoso_ownerid: null,
    contoso_owneridname: null,
    contoso_status: 1,
    contoso_statusname: 'Active',
    contoso_price: { decimal: '10.0000' },
    contoso_quantity: null,
    contoso_active: null,
    contoso_created: null,
  },
  {
    contoso_widgetid: W4,
    contoso_name: 'bolt pack',
    contoso_ownerid: ANN,
    contoso_owneridname: 'Ann',
    contoso_status: null,
    contoso_statusname: null,
    contoso_price: { decimal: '0.5000' },
    contoso_quantity: 3,
    contoso_active: true,
    contoso_created: null,
  },
];

const parts = [
  { contoso_partid: 'P1', contoso_widgetid: W1, contoso_widgetidname: 'Bolt', contoso_code: 'X-1', contoso_cost: 4 },
  { contoso_partid: 'P2', contoso_widgetid: W1, contoso_widgetidname: 'Bolt', contoso_code: 'X-2', contoso_cost: 9 },
  { contoso_partid: 'P3', contoso_widgetid: W3, contoso_widgetidname: 'Gear', contoso_code: 'Y-1', contoso_cost: 1 },
  { contoso_partid: 'P4', contoso_widgetid: null, contoso_widgetidname: null, contoso_code: null, contoso_cost: null },
];

const data = { contoso_widget: widgets, contoso_part: parts };
const NOW = new Date('2026-06-15T12:00:00Z');

// Scan stub: counts calls per table and returns copies keyed by column name.
function makeScan(source = data) {
  const calls = {};
  const scan = async (name) => {
    calls[name] = (calls[name] ?? 0) + 1;
    return (source[name] ?? []).map((row) => ({ ...row }));
  };
  return { scan, calls };
}

const run = (sql, options = {}) => {
  const { scan } = makeScan();
  return executeBatch(sql, { catalog, scan, now: NOW, ...options });
};

// Readable form of a value: decimals as text, dates as ISO, bigints with an "n" suffix.
const plain = (value) => {
  if (value !== null && typeof value === 'object' && 'decimal' in value) return value.decimal;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return `${value}n`;
  return value;
};
const rowsOf = (result, index = 0) => result.resultSets[index].rows.map((row) => row.map(plain));

// expected is an array of rows, or { error: number }.
async function check(sql, expected) {
  if (Array.isArray(expected)) assert.deepEqual(rowsOf(await run(sql)), expected);
  else await assert.rejects(run(sql), { number: expected.error });
}

// [label, sql, expected]: expected is an array of rows, or { error: number }.
const cases = [
  [
    'WHERE and ORDER BY alias',
    'SELECT w.contoso_name AS n FROM contoso_widget w WHERE w.contoso_status = 1 ORDER BY n',
    [['Bolt'], ['Gear']],
  ],
  [
    'scan order without ORDER BY',
    'SELECT p.contoso_code AS c FROM contoso_part p',
    [['X-1'], ['X-2'], ['Y-1'], [null]],
  ],
  [
    'p.* keeps the row',
    "SELECT p.* FROM contoso_part p WHERE p.contoso_partid = 'P4'",
    [['P4', null, null, null, null]],
  ],
  [
    'schema-qualified, upper-case table name',
    "SELECT x.contoso_code AS c FROM DBO.CONTOSO_PART x WHERE x.contoso_partid = 'P3'",
    [['Y-1']],
  ],
  ['upper-case column name', "SELECT p.CONTOSO_CODE AS c FROM contoso_part p WHERE p.contoso_partid = 'P1'", [['X-1']]],
  ['NULL equality is unknown', 'SELECT p.contoso_partid AS id FROM contoso_part p WHERE p.contoso_cost = NULL', []],
  [
    'NOT of unknown stays unknown',
    'SELECT p.contoso_partid AS id FROM contoso_part p WHERE NOT (p.contoso_cost > 3)',
    [['P3']],
  ],
  ['IS NULL', 'SELECT p.contoso_partid AS id FROM contoso_part p WHERE p.contoso_cost IS NULL', [['P4']]],
  [
    'IS NOT NULL with DESC',
    'SELECT p.contoso_partid AS id FROM contoso_part p WHERE p.contoso_cost IS NOT NULL ORDER BY id DESC',
    [['P3'], ['P2'], ['P1']],
  ],
  [
    'IN with a NULL item',
    'SELECT p.contoso_partid AS id FROM contoso_part p WHERE p.contoso_cost IN (1, NULL)',
    [['P3']],
  ],
  [
    'NOT IN with a NULL item',
    'SELECT p.contoso_partid AS id FROM contoso_part p WHERE p.contoso_cost NOT IN (1, NULL)',
    [],
  ],
  [
    'BETWEEN',
    'SELECT p.contoso_partid AS id FROM contoso_part p WHERE p.contoso_cost BETWEEN 2 AND 9 ORDER BY id',
    [['P1'], ['P2']],
  ],
  [
    'NOT BETWEEN',
    'SELECT p.contoso_partid AS id FROM contoso_part p WHERE p.contoso_cost NOT BETWEEN 2 AND 9',
    [['P3']],
  ],
  [
    'LIKE with % and _ is case-insensitive',
    "SELECT w.contoso_name AS n FROM contoso_widget w WHERE w.contoso_name LIKE 'b_lt%' ORDER BY n",
    [['Bolt'], ['bolt pack']],
  ],
  [
    'LIKE with a character list',
    "SELECT w.contoso_name AS n FROM contoso_widget w WHERE w.contoso_name LIKE '[GN]%' ORDER BY n",
    [['Gear'], ['Nut']],
  ],
  [
    'LIKE with a negated character list',
    "SELECT w.contoso_name AS n FROM contoso_widget w WHERE w.contoso_name LIKE '[^BG]%'",
    [['Nut']],
  ],
  [
    'LIKE with ESCAPE matches a literal %',
    "SELECT x.s AS s FROM (SELECT 'a%b' AS s) AS x WHERE x.s LIKE 'a!%b' ESCAPE '!'",
    [['a%b']],
  ],
  [
    'LIKE with ESCAPE does not wildcard the %',
    "SELECT x.s AS s FROM (SELECT 'axb' AS s) AS x WHERE x.s LIKE 'a!%b' ESCAPE '!'",
    [],
  ],
  [
    'equality is case-insensitive',
    "SELECT w.contoso_name AS n FROM contoso_widget w WHERE w.contoso_name = 'BOLT'",
    [['Bolt']],
  ],
  [
    'CONTAINS is a substring match',
    "SELECT w.contoso_name AS n FROM contoso_widget w WHERE CONTAINS(w.contoso_name, 'BOLT')",
    [['Bolt'], ['bolt pack']],
  ],
  [
    'searched CASE with NULL branch',
    "SELECT w.contoso_name AS n, CASE WHEN w.contoso_quantity > 5 THEN 'many' WHEN w.contoso_quantity IS NULL THEN 'unknown' ELSE 'few' END AS q FROM contoso_widget w ORDER BY n",
    [
      ['Bolt', 'many'],
      ['bolt pack', 'few'],
      ['Gear', 'unknown'],
      ['Nut', 'few'],
    ],
  ],
  [
    'simple CASE',
    "SELECT CASE w.contoso_status WHEN 1 THEN 'A' WHEN 2 THEN 'I' ELSE 'N' END AS s FROM contoso_widget w",
    [['A'], ['I'], ['A'], ['N']],
  ],
  [
    'CAST to nvarchar',
    'SELECT CAST(w.contoso_quantity AS nvarchar(10)) AS q FROM contoso_widget w WHERE w.contoso_quantity = 10',
    [['10']],
  ],
  ['TRY_CAST returns NULL on failure', "SELECT TRY_CAST('abc' AS int) AS v", [[null]]],
  ['CONVERT text to int', "SELECT CONVERT(int, '42') AS v", [[42]]],
  [
    'ISNULL over a lookup name',
    "SELECT ISNULL(w.contoso_owneridname, 'none') AS o FROM contoso_widget w",
    [['Ann'], ['Bob'], ['none'], ['Ann']],
  ],
  ['@@VERSION', 'SELECT @@VERSION AS v', [['Microsoft SQL Azure (RTM) - 12.0.2000.8']]],
  ['@@ROWCOUNT before any rows', 'SELECT @@ROWCOUNT AS rc', [[0]]],
  ['FROM-less arithmetic', "SELECT 1 + 2 AS total, 'x' + 'y' AS s", [[3, 'xy']]],
  ['integer division and modulo', 'SELECT 7 / 2 AS q, -7 % 3 AS m', [[3, -1]]],
  ['division by zero', 'SELECT 1 / 0 AS x', { error: 8134 }],
  ['bigint arithmetic', 'SELECT CAST(5 AS bigint) + 1 AS b', [['6n']]],
  ['decimal literal keeps its scale', 'SELECT 1.50 AS d', [['1.50']]],
  [
    'money column text',
    "SELECT w.contoso_price AS p FROM contoso_widget w WHERE w.contoso_widgetid = '00000000-0000-0000-0000-000000000002'",
    [['1.2500']],
  ],
  [
    'date comparison with a string',
    "SELECT w.contoso_name AS n FROM contoso_widget w WHERE w.contoso_created > '2026-01-15'",
    [['Nut']],
  ],
  [
    'bit equals 1',
    'SELECT w.contoso_name AS n FROM contoso_widget w WHERE w.contoso_active = 1',
    [['Bolt'], ['bolt pack']],
  ],
  ['TOP n', 'SELECT TOP 2 p.contoso_partid AS id FROM contoso_part p ORDER BY p.contoso_partid', [['P1'], ['P2']]],
  [
    'TOP n PERCENT rounds up',
    'SELECT TOP 30 PERCENT p.contoso_partid AS id FROM contoso_part p ORDER BY id',
    [['P1'], ['P2']],
  ],
  [
    'TOP (variable)',
    'DECLARE @n int = 1; SELECT TOP (@n) p.contoso_partid AS id FROM contoso_part p ORDER BY id',
    [['P1']],
  ],
  [
    'DISTINCT keeps the first occurrence',
    'SELECT DISTINCT p.contoso_widgetidname AS n FROM contoso_part p',
    [['Bolt'], ['Gear'], [null]],
  ],
  [
    'ORDER BY ordinal sorts NULL first',
    'SELECT p.contoso_partid AS id, p.contoso_cost AS c FROM contoso_part p ORDER BY 2',
    [
      ['P4', null],
      ['P3', 1],
      ['P1', 4],
      ['P2', 9],
    ],
  ],
  [
    'ORDER BY DESC puts NULL last',
    'SELECT p.contoso_partid AS id FROM contoso_part p ORDER BY p.contoso_cost DESC',
    [['P2'], ['P1'], ['P3'], ['P4']],
  ],
  [
    'ORDER BY alias with NULL first',
    'SELECT p.contoso_partid AS id, p.contoso_cost AS c FROM contoso_part p ORDER BY c',
    [
      ['P4', null],
      ['P3', 1],
      ['P1', 4],
      ['P2', 9],
    ],
  ],
  ['ORDER BY ordinal out of range', 'SELECT p.contoso_partid AS id FROM contoso_part p ORDER BY 2', { error: 149 }],
  [
    'UNION removes duplicates, case-insensitively',
    'SELECT p.contoso_widgetidname AS n FROM contoso_part p UNION SELECT w.contoso_name AS n FROM contoso_widget w',
    [['Bolt'], ['Gear'], [null], ['Nut'], ['bolt pack']],
  ],
  ['UNION ALL keeps duplicates', 'SELECT 1 AS a UNION ALL SELECT 1 AS a', [[1], [1]]],
  ['UNION with ORDER BY ordinal', 'SELECT 2 AS a UNION SELECT 1 AS a ORDER BY 1', [[1], [2]]],
  ['UNION column count mismatch', 'SELECT 1 AS a UNION SELECT 1 AS a, 2 AS b', { error: 205 }],
  [
    'UNION ORDER BY expression',
    'SELECT p.contoso_partid AS id FROM contoso_part p UNION SELECT p.contoso_partid AS id FROM contoso_part p ORDER BY p.contoso_partid',
    { error: 104 },
  ],
  [
    'derived table',
    'SELECT d.n AS n FROM (SELECT w.contoso_name AS n FROM contoso_widget w WHERE w.contoso_status = 1) AS d ORDER BY n',
    [['Bolt'], ['Gear']],
  ],
  [
    'INNER JOIN',
    'SELECT w.contoso_name AS n, p.contoso_code AS c FROM contoso_widget w INNER JOIN contoso_part p ON p.contoso_widgetid = w.contoso_widgetid ORDER BY c',
    [
      ['Bolt', 'X-1'],
      ['Bolt', 'X-2'],
      ['Gear', 'Y-1'],
    ],
  ],
  [
    'LEFT JOIN null-extends',
    'SELECT w.contoso_name AS n, p.contoso_code AS c FROM contoso_widget w LEFT JOIN contoso_part p ON p.contoso_widgetid = w.contoso_widgetid ORDER BY n',
    [
      ['Bolt', 'X-1'],
      ['Bolt', 'X-2'],
      ['bolt pack', null],
      ['Gear', 'Y-1'],
      ['Nut', null],
    ],
  ],
  [
    'RIGHT JOIN keeps unmatched right rows',
    'SELECT w.contoso_name AS n, p.contoso_partid AS id FROM contoso_widget w RIGHT JOIN contoso_part p ON p.contoso_widgetid = w.contoso_widgetid ORDER BY id',
    [
      ['Bolt', 'P1'],
      ['Bolt', 'P2'],
      ['Gear', 'P3'],
      [null, 'P4'],
    ],
  ],
  [
    'FULL JOIN keeps both sides',
    'SELECT w.contoso_name AS n, p.contoso_partid AS id FROM contoso_widget w FULL JOIN contoso_part p ON p.contoso_widgetid = w.contoso_widgetid',
    [
      ['Bolt', 'P1'],
      ['Bolt', 'P2'],
      ['Nut', null],
      ['Gear', 'P3'],
      ['bolt pack', null],
      [null, 'P4'],
    ],
  ],
  [
    'CROSS JOIN',
    'SELECT w.contoso_widgetid AS a, p.contoso_partid AS b FROM contoso_widget w CROSS JOIN contoso_part p',
    crossRows(),
  ],
  [
    'comma join with WHERE',
    "SELECT w.contoso_name AS n, p.contoso_partid AS id FROM contoso_widget w, contoso_part p WHERE p.contoso_widgetid = w.contoso_widgetid AND p.contoso_partid = 'P3'",
    [['Gear', 'P3']],
  ],
  [
    'OUTER APPLY null-extends',
    "SELECT w.contoso_name AS n, x.code AS c FROM contoso_widget w OUTER APPLY (SELECT p.contoso_code AS code FROM contoso_part p WHERE p.contoso_widgetid = w.contoso_widgetid AND p.contoso_partid = 'P2') AS x WHERE w.contoso_status = 1 ORDER BY n",
    [
      ['Bolt', 'X-2'],
      ['Gear', null],
    ],
  ],
  [
    'CROSS APPLY',
    "SELECT w.contoso_name AS n, x.code AS c FROM contoso_widget w CROSS APPLY (SELECT p.contoso_code AS code FROM contoso_part p WHERE p.contoso_widgetid = w.contoso_widgetid) AS x WHERE w.contoso_name = 'Bolt' ORDER BY c",
    [
      ['Bolt', 'X-1'],
      ['Bolt', 'X-2'],
    ],
  ],
  [
    'correlated scalar subquery',
    'SELECT w.contoso_name AS n, (SELECT TOP 1 p.contoso_code AS code FROM contoso_part p WHERE p.contoso_widgetid = w.contoso_widgetid ORDER BY p.contoso_partid) AS c FROM contoso_widget w',
    [
      ['Bolt', 'X-1'],
      ['Nut', null],
      ['Gear', 'Y-1'],
      ['bolt pack', null],
    ],
  ],
  [
    'scalar subquery with more than one row',
    'SELECT (SELECT p.contoso_code AS code FROM contoso_part p) AS c',
    { error: 512 },
  ],
  [
    'scalar subquery with two columns',
    "SELECT (SELECT p.contoso_code AS code, p.contoso_cost AS cost FROM contoso_part p WHERE p.contoso_partid = 'P1') AS c",
    { error: 116 },
  ],
  [
    'correlated EXISTS',
    'SELECT w.contoso_name AS n FROM contoso_widget w WHERE EXISTS (SELECT 1 AS one FROM contoso_part p WHERE p.contoso_widgetid = w.contoso_widgetid)',
    [['Bolt'], ['Gear']],
  ],
  [
    'correlated NOT EXISTS',
    'SELECT w.contoso_name AS n FROM contoso_widget w WHERE NOT EXISTS (SELECT 1 AS one FROM contoso_part p WHERE p.contoso_widgetid = w.contoso_widgetid)',
    [['Nut'], ['bolt pack']],
  ],
  [
    'IN subquery',
    'SELECT w.contoso_name AS n FROM contoso_widget w WHERE w.contoso_widgetid IN (SELECT p.contoso_widgetid AS wid FROM contoso_part p)',
    [['Bolt'], ['Gear']],
  ],
  [
    '> ANY subquery with NULL',
    'SELECT w.contoso_name AS n FROM contoso_widget w WHERE w.contoso_quantity > ANY (SELECT p.contoso_cost AS c FROM contoso_part p)',
    [['Bolt'], ['bolt pack']],
  ],
  [
    '> ALL subquery',
    'SELECT w.contoso_name AS n FROM contoso_widget w WHERE w.contoso_quantity > ALL (SELECT p.contoso_cost AS c FROM contoso_part p WHERE p.contoso_cost IS NOT NULL)',
    [['Bolt']],
  ],
  [
    'variable in WHERE',
    "DECLARE @s nvarchar(20) = 'Bolt'; SELECT w.contoso_name AS n FROM contoso_widget w WHERE w.contoso_name = @s",
    [['Bolt']],
  ],
  [
    'SET after DECLARE',
    'DECLARE @n int; SET @n = 2; SELECT w.contoso_name AS n FROM contoso_widget w WHERE w.contoso_status = @n',
    [['Nut']],
  ],
  ['undeclared variable', 'SELECT @nope AS x', { error: 137 }],
  ['unknown table', 'SELECT x.a AS a FROM nope x', { error: 208 }],
  ['unknown column', 'SELECT w.nope AS n FROM contoso_widget w', { error: 207 }],
  ['unknown column with no rows', 'SELECT w.nope AS n FROM contoso_widget w WHERE 1 = 0', { error: 207 }],
  ['ambiguous column', 'SELECT contoso_name AS n FROM contoso_widget w, contoso_widget v', { error: 209 }],
  ['syntax error', 'SELECT FROM contoso_widget', { error: 102 }],
];

// Cross product in scan order: four widgets, then four parts per widget.
function crossRows() {
  const out = [];
  for (const w of widgets) for (const p of parts) out.push([w.contoso_widgetid, p.contoso_partid]);
  return out;
}

for (const [label, sql, expected] of cases) {
  test(`evaluates: ${label}`, () => check(sql, expected));
}

// T-SQL semantics: exact numerics, type precedence, declared types, predicates, date and binary values,
// DISTINCT ordering, duplicate star columns and aggregates in ON. Same shape as `cases`.
const semanticCases = [
  // 1. Exact numeric arithmetic
  ['decimal division keeps scale 6 for an integer literal divisor', 'SELECT 7.0 / 2 AS d', [['3.500000']]],
  ['decimal 1 / 3.0 has scale 6', 'SELECT 1 / 3.0 AS d', [['0.333333']]],
  ['decimal 10 / 3.0', 'SELECT 10 / 3.0 AS d', [['3.333333']]],
  ['negative decimal division truncates toward zero', 'SELECT -7.0 / 2 AS d', [['-3.500000']]],
  ['decimal multiplication adds scales', 'SELECT 7.0 * 2.5 AS d', [['17.50']]],
  ['decimal subtraction is exact', 'SELECT 7.5 - 0.25 AS d', [['7.25']]],
  ['decimal modulo', 'SELECT 7 % 3.0 AS d', [['1.0']]],
  ['a float literal divides as float', 'SELECT 7.0E0 / 2 AS d', [[3.5]]],
  ['CAST to float divides as float', 'SELECT CAST(1 AS float) / 4 AS d', [[0.25]]],
  [
    'declared decimal(10,2) variable divides exactly',
    'DECLARE @p decimal(10,2) = 7; SELECT @p / 2 AS d',
    [['3.500000']],
  ],
  ['int overflow is 8115', 'SELECT 2147483647 + 1 AS d', { error: 8115 }],
  ['bigint overflow is 8115', 'SELECT 9223372036854775807 + 1 AS d', { error: 8115 }],
  ['bigint product in range', 'SELECT 2147483647 * 4294967296 AS d', [['9223372032559808512n']]],
  [
    'decimal overflow is 8115',
    "SELECT CAST('99999999999999999999999999999999999999' AS decimal(38,0)) * 10 AS d",
    { error: 8115 },
  ],
  ['decimal divide by zero is 8134', 'SELECT 1.0 / 0 AS d', { error: 8134 }],
  // 2. Data type precedence and implicit conversion
  ['string converts to int in arithmetic', "SELECT '5' + 1 AS d", [[6]]],
  ['non-numeric string in arithmetic is 245', "SELECT 'x' + 1 AS d", { error: 245 }],
  ['string with a fraction against int is 245', "SELECT '2.5' * 2 AS d", { error: 245 }],
  ['string against decimal converts to decimal', "SELECT '2.5' * 2.0 AS d", [['5.00']]],
  ['string compares with int', "SELECT 1 = '1' AS d", [[true]]],
  ['string compares with decimal', "SELECT 2.5 = '2.50' AS d", [[true]]],
  ['non-numeric string compared with int is 245', "SELECT 'abc' = 1 AS d", { error: 245 }],
  [
    'malformed date string compared with datetime is 241',
    "SELECT '2020-13-01' = CAST('2020-01-01' AS datetime) AS d",
    { error: 241 },
  ],
  // 3. Declared types
  ['DECLARE int converts the string', "DECLARE @n int = '5'; SELECT @n AS n", [[5]]],
  ['DECLARE nvarchar(3) truncates', "DECLARE @s nvarchar(3) = 'abcdef'; SELECT @s AS s", [['abc']]],
  ['DECLARE decimal(10,2) keeps scale', 'DECLARE @p decimal(10,2) = 7; SELECT @p AS p', [['7.00']]],
  ['DECLARE int overflow is 8115', 'DECLARE @n int = 3000000000; SELECT @n AS n', { error: 8115 }],
  ['SET converts to the declared type', "DECLARE @n int; SET @n = '7'; SELECT @n AS n", [[7]]],
  [
    'SELECT assignment truncates to the declared type',
    "DECLARE @s nvarchar(2); SELECT @s = 'xyz'; SELECT @s AS s",
    [['xy']],
  ],
  // 4. Non-boolean predicates
  [
    'WHERE on a bare int column is 4145',
    'SELECT w.contoso_name AS n FROM contoso_widget w WHERE w.contoso_quantity',
    { error: 4145 },
  ],
  ['WHERE on arithmetic is 4145', 'SELECT 1 AS d WHERE 1 + 1', { error: 4145 }],
  ['searched CASE WHEN on a literal is 4145', "SELECT CASE WHEN 1 THEN 'y' END AS d", { error: 4145 }],
  [
    'ON on a bare column is 4145',
    'SELECT w.contoso_name AS n FROM contoso_widget w JOIN contoso_part p ON p.contoso_cost',
    { error: 4145 },
  ],
  ['HAVING on a literal is 4145', 'SELECT p.contoso_code AS c FROM contoso_part p HAVING 1', { error: 4145 }],
  ['a comparison predicate is still boolean', 'SELECT 1 AS d WHERE 1 = 1', [[1]]],
  // 5. Date arithmetic and binary values
  ['datetime plus days', "DECLARE @d datetime = '2020-01-01'; SELECT @d + 1 AS d", [['2020-01-02T00:00:00.000Z']]],
  ['int plus datetime', "DECLARE @d datetime = '2020-01-01'; SELECT 1 + @d AS d", [['2020-01-02T00:00:00.000Z']]],
  [
    'datetime minus a fractional day',
    "DECLARE @d datetime = '2020-01-01 12:00'; SELECT @d - 0.5 AS d",
    [['2020-01-01T00:00:00.000Z']],
  ],
  ['datetime plus days past 9999 is 517', "DECLARE @d datetime = '9999-12-31'; SELECT @d + 1 AS d", { error: 517 }],
  ['datetime times int is 8117', "DECLARE @d datetime = '2020-01-01'; SELECT @d * 2 AS d", { error: 8117 }],
  ['datetime plus datetime is 206', "DECLARE @d datetime = '2020-01-01'; SELECT @d + @d AS d", { error: 206 }],
  ['binary literal equals the int it encodes', 'SELECT 0x0102 = 258 AS d', [[true]]],
  ["CAST binary to int reads two's complement", 'SELECT CAST(0xFFFFFFFF AS int) AS d', [[-1]]],
  ['odd-length binary literal pads with a zero', 'SELECT CAST(0x1 AS int) AS d', [[1]]],
  ['binary arithmetic is 402', 'SELECT 0x41 + 1 AS d', { error: 402 }],
  // 6. DISTINCT and ORDER BY
  [
    'DISTINCT with ORDER BY a column outside the list is 145',
    'SELECT DISTINCT p.contoso_code AS c FROM contoso_part p ORDER BY p.contoso_cost',
    { error: 145 },
  ],
  [
    'DISTINCT with ORDER BY a listed column by name passes',
    'SELECT DISTINCT p.contoso_code AS c FROM contoso_part p ORDER BY p.contoso_code',
    [[null], ['X-1'], ['X-2'], ['Y-1']],
  ],
  [
    'DISTINCT with ORDER BY an ordinal passes',
    'SELECT DISTINCT p.contoso_code AS c FROM contoso_part p ORDER BY 1',
    [[null], ['X-1'], ['X-2'], ['Y-1']],
  ],
  // 7. Duplicate column names from a star
  [
    'star over a JOIN with a shared column name is 40000',
    'SELECT * FROM contoso_widget w JOIN contoso_part p ON p.contoso_widgetid = w.contoso_widgetid',
    { error: 40000 },
  ],
  [
    'a star inside EXISTS may repeat names',
    'SELECT 1 AS d WHERE EXISTS (SELECT * FROM contoso_widget w JOIN contoso_part p ON p.contoso_widgetid = w.contoso_widgetid)',
    [[1]],
  ],
  // 8. Aggregates in ON
  [
    'aggregate in ON is 147',
    'SELECT w.contoso_name AS n FROM contoso_widget w JOIN contoso_part p ON COUNT(*) > 0',
    { error: 147 },
  ],
  [
    'aggregate inside a subquery in ON is 147',
    'SELECT w.contoso_name AS n FROM contoso_widget w JOIN contoso_part p ON p.contoso_cost = (SELECT MAX(x.contoso_cost) AS m FROM contoso_part x)',
    { error: 147 },
  ],
];
for (const [label, sql, expected] of semanticCases) {
  test(`T-SQL semantics: ${label}`, () => check(sql, expected));
}

// Behaviour outside the table: options, batches, metadata, cancellation and scan reuse.

test('FROM-less SELECT gives an unnamed column the empty name', async () => {
  const result = await run('SELECT 1 + 2');
  assert.equal(result.resultSets[0].columns[0].name, '');
  assert.deepEqual(rowsOf(result), [[3]]);
});

test('SELECT @v = expr produces no result set', async () => {
  const sql =
    "DECLARE @v nvarchar(100); SELECT @v = w.contoso_name FROM contoso_widget w WHERE w.contoso_widgetid = '00000000-0000-0000-0000-000000000002'; SELECT @v AS v";
  const result = await run(sql);
  assert.equal(result.resultSets.length, 1);
  assert.deepEqual(rowsOf(result), [['Nut']]);
});

test('variables do not survive GO', async () => {
  await assert.rejects(run('DECLARE @x int = 5\nGO\nSELECT @x AS x'), { number: 137 });
});

test("@@ROWCOUNT is the previous statement's row count", async () => {
  const result = await run('SELECT w.contoso_name AS n FROM contoso_widget w; SELECT @@ROWCOUNT AS rc');
  assert.deepEqual(rowsOf(result, 1), [[4]]);
  assert.equal(result.rowCount, 1);
});

test('@@ROWCOUNT is 0 after DECLARE', async () => {
  const result = await run('SELECT 1 AS a; DECLARE @x int; SELECT @@ROWCOUNT AS rc');
  assert.deepEqual(rowsOf(result, 1), [[0]]);
});

test('@@ROWCOUNT carries across GO', async () => {
  const result = await run('SELECT 1 AS a\nGO\nSELECT @@ROWCOUNT AS rc');
  assert.deepEqual(rowsOf(result, 1), [[1]]);
});

test('GO with a repeat count runs the batch that many times', async () => {
  const result = await run('SELECT 1 AS a\nGO 2');
  assert.deepEqual([rowsOf(result, 0), rowsOf(result, 1), result.resultSets.length], [[[1]], [[1]], 2]);
});

test('sp_executesql parameters are visible', async () => {
  const result = await run('SELECT @p1 AS v', { params: { '@p1': 7 } });
  assert.deepEqual(rowsOf(result), [[7]]);
});

test('GETDATE uses the injected clock', async () => {
  const result = await run('SELECT GETDATE() AS d');
  assert.deepEqual(rowsOf(result), [[NOW.toISOString()]]);
});

test('empty input gives no result sets', async () => {
  const result = await run('');
  assert.deepEqual(result.resultSets, []);
});

test('SELECT * names match the catalog columns', async () => {
  const result = await run('SELECT * FROM contoso_part');
  assert.deepEqual(
    result.resultSets[0].columns.map((c) => c.name),
    catalog.tables.get('contoso_part').columns.map((c) => c.name),
  );
});

test('result columns carry catalog types and scales', async () => {
  const result = await run(
    "SELECT w.contoso_name AS n, w.contoso_price AS p, 1 AS one, 'ab' AS s FROM contoso_widget w WHERE w.contoso_widgetid = '00000000-0000-0000-0000-000000000001'",
  );
  const [n, p, one, s] = result.resultSets[0].columns;
  assert.deepEqual([n.type, n.length], ['nvarchar', 100]);
  assert.deepEqual([p.type, p.precision, p.scale], ['money', 19, 4]);
  assert.equal(one.type, 'int');
  assert.deepEqual([s.type, s.length], ['nvarchar', 2]);
});

test('decimal values in one column share a scale', async () => {
  const result = await run('SELECT 1.5 AS d UNION ALL SELECT 2.25 AS d');
  assert.deepEqual(rowsOf(result), [['1.50'], ['2.25']]);
  assert.equal(result.resultSets[0].columns[0].scale, 2);
});

test('zero-row CROSS APPLY still exposes its columns', async () => {
  const result = await run(
    'SELECT w.contoso_name AS n, x.code AS c FROM contoso_widget w CROSS APPLY (SELECT p.contoso_code AS code FROM contoso_part p WHERE 1 = 0) AS x',
  );
  assert.deepEqual(
    result.resultSets[0].columns.map((c) => c.name),
    ['n', 'c'],
  );
  assert.deepEqual(rowsOf(result), []);
});

test('a table is scanned once per batch', async () => {
  const { scan, calls } = makeScan();
  const result = await executeBatch('SELECT w.contoso_name AS n FROM contoso_widget w CROSS JOIN contoso_widget v', {
    catalog,
    scan,
    now: NOW,
  });
  assert.equal(result.resultSets[0].rows.length, 16);
  assert.equal(calls.contoso_widget, 1);
});

test('an aborted signal fails before any row', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(run('SELECT 1 AS a', { signal: controller.signal }), { number: 3617 });
});

test('abort during a scan stops the row loop', async () => {
  const controller = new AbortController();
  const scan = async () => {
    controller.abort();
    return parts.map((row) => ({ ...row }));
  };
  await assert.rejects(
    executeBatch('SELECT p.contoso_partid AS id FROM contoso_part p', { catalog, scan, signal: controller.signal }),
    { number: 3617 },
  );
});

// ---- Aggregates, GROUP BY and HAVING. Expected values follow SQL Server.
const aggregateCases = [
  ['COUNT(*) counts rows', 'SELECT COUNT(*) AS n FROM contoso_widget', [[4]]],
  ['COUNT(expr) skips NULLs', 'SELECT COUNT(w.contoso_quantity) AS n FROM contoso_widget w', [[3]]],
  ['COUNT of no rows is 0', 'SELECT COUNT(*) AS n FROM contoso_widget WHERE 1 = 0', [[0]]],
  ['COUNT_BIG returns bigint', 'SELECT COUNT_BIG(w.contoso_name) AS n FROM contoso_widget w', [['4n']]],
  ['COUNT(DISTINCT) skips NULLs', 'SELECT COUNT(DISTINCT w.contoso_status) AS n FROM contoso_widget w', [[2]]],
  ['SUM of int', 'SELECT SUM(w.contoso_quantity) AS s FROM contoso_widget w', [[13]]],
  ['SUM of no rows is NULL', 'SELECT SUM(w.contoso_quantity) AS s FROM contoso_widget w WHERE 1 = 0', [[null]]],
  ['SUM DISTINCT', 'SELECT SUM(DISTINCT w.contoso_status) AS s FROM contoso_widget w', [[3]]],
  ['SUM of money keeps four places', 'SELECT SUM(w.contoso_price) AS s FROM contoso_widget w', [['14.2500']]],
  [
    'SUM of NULL-only column is NULL',
    'SELECT SUM(w.contoso_quantity) AS q FROM contoso_widget w WHERE w.contoso_quantity IS NULL',
    [[null]],
  ],
  ['SUM of bigint is bigint', 'SELECT SUM(CAST(5 AS bigint)) AS s FROM contoso_part', [['20n']]],
  ['SUM of decimal keeps scale', 'SELECT SUM(CAST(1.25 AS decimal(5,2))) AS s FROM contoso_part', [['5.00']]],
  ['SUM int overflow is 8115', 'SELECT SUM(CAST(2147483647 AS int)) AS s FROM contoso_widget', { error: 8115 }],
  ['AVG of int is integer division', 'SELECT AVG(w.contoso_quantity) AS a FROM contoso_widget w', [[4]]],
  ['AVG of money', 'SELECT AVG(w.contoso_price) AS a FROM contoso_widget w', [['3.5625']]],
  ['AVG of no rows is NULL', 'SELECT AVG(p.contoso_cost) AS a FROM contoso_part p WHERE 1 = 0', [[null]]],
  ['MIN of strings', 'SELECT MIN(w.contoso_name) AS m FROM contoso_widget w', [['Bolt']]],
  ['MAX of strings compares case-insensitively', 'SELECT MAX(w.contoso_name) AS m FROM contoso_widget w', [['Nut']]],
  ['MIN ignores NULL', 'SELECT MIN(w.contoso_quantity) AS m FROM contoso_widget w', [[0]]],
  ['MAX of int', 'SELECT MAX(w.contoso_quantity) AS m FROM contoso_widget w', [[10]]],
  ['MIN of no rows is NULL', 'SELECT MIN(w.contoso_quantity) AS m FROM contoso_widget w WHERE 1 = 0', [[null]]],
  [
    'GROUP BY with COUNT, NULL group first',
    'SELECT w.contoso_status AS s, COUNT(*) AS n FROM contoso_widget w GROUP BY w.contoso_status ORDER BY s',
    [
      [null, 1],
      [1, 2],
      [2, 1],
    ],
  ],
  [
    'GROUP BY with SUM over a NULL group',
    'SELECT w.contoso_owneridname AS o, SUM(w.contoso_quantity) AS q FROM contoso_widget w GROUP BY w.contoso_owneridname ORDER BY o',
    [
      [null, null],
      ['Ann', 13],
      ['Bob', 0],
    ],
  ],
  [
    'HAVING on COUNT',
    'SELECT w.contoso_status AS s, COUNT(*) AS n FROM contoso_widget w GROUP BY w.contoso_status HAVING COUNT(*) > 1',
    [[1, 2]],
  ],
  [
    'HAVING on an aggregate not in the select list',
    'SELECT w.contoso_status AS s FROM contoso_widget w GROUP BY w.contoso_status HAVING SUM(w.contoso_quantity) > 5',
    [[1]],
  ],
  [
    'ORDER BY an aggregate',
    'SELECT w.contoso_status AS s, COUNT(*) AS n FROM contoso_widget w GROUP BY w.contoso_status ORDER BY COUNT(*) DESC, s',
    [
      [1, 2],
      [null, 1],
      [2, 1],
    ],
  ],
  [
    'ORDER BY an alias of an aggregate',
    'SELECT w.contoso_status AS s, COUNT(*) AS n FROM contoso_widget w GROUP BY w.contoso_status ORDER BY n DESC, s DESC',
    [
      [1, 2],
      [2, 1],
      [null, 1],
    ],
  ],
  [
    'no GROUP BY over no rows is one row',
    'SELECT COUNT(*) AS n, SUM(w.contoso_quantity) AS q FROM contoso_widget w WHERE 1 = 0',
    [[0, null]],
  ],
  [
    'GROUP BY over no rows is no rows',
    'SELECT w.contoso_status AS s, COUNT(*) AS n FROM contoso_widget w WHERE 1 = 0 GROUP BY w.contoso_status',
    [],
  ],
  ['HAVING without GROUP BY', 'SELECT COUNT(*) AS n FROM contoso_widget HAVING COUNT(*) > 3', [[4]]],
  ['aggregate inside an expression', 'SELECT COUNT(*) + 1 AS n FROM contoso_widget', [[5]]],
  [
    'int aggregates divide as integers',
    'SELECT SUM(w.contoso_quantity) / COUNT(w.contoso_quantity) AS a FROM contoso_widget w',
    [[4]],
  ],
  [
    'aggregate inside CASE',
    "SELECT CASE WHEN COUNT(*) > 3 THEN 'many' ELSE 'few' END AS v FROM contoso_widget",
    [['many']],
  ],
  [
    'aggregate assigned to a variable',
    'DECLARE @n int; SELECT @n = COUNT(*) FROM contoso_widget; SELECT @n AS n',
    [[4]],
  ],
  [
    'GROUP BY expression reused in the select list',
    'SELECT w.contoso_status + 0 AS s, COUNT(*) AS n FROM contoso_widget w GROUP BY w.contoso_status + 0 ORDER BY s',
    [
      [null, 1],
      [1, 2],
      [2, 1],
    ],
  ],
  [
    'GROUP BY over a join',
    'SELECT w.contoso_name AS n, COUNT(p.contoso_partid) AS c FROM contoso_widget w JOIN contoso_part p ON p.contoso_widgetid = w.contoso_widgetid GROUP BY w.contoso_name ORDER BY n',
    [
      ['Bolt', 2],
      ['Gear', 1],
    ],
  ],
  [
    'STRING_AGG joins non-NULL values',
    "SELECT STRING_AGG(w.contoso_name, ',') AS s FROM contoso_widget w WHERE w.contoso_status = 1",
    [['Bolt,Gear']],
  ],
  [
    'STRING_AGG skips NULLs',
    "SELECT STRING_AGG(w.contoso_owneridname, '/') AS s FROM contoso_widget w",
    [['Ann/Bob/Ann']],
  ],
  [
    'STRING_AGG of no rows is NULL',
    "SELECT STRING_AGG(w.contoso_name, ',') AS s FROM contoso_widget w WHERE 1 = 0",
    [[null]],
  ],
  [
    'VARP is the population variance',
    'SELECT VARP(p.contoso_cost) AS v FROM contoso_part p WHERE p.contoso_cost > 3',
    [[6.25]],
  ],
  [
    'VAR is the sample variance',
    'SELECT VAR(p.contoso_cost) AS v FROM contoso_part p WHERE p.contoso_cost > 3',
    [[12.5]],
  ],
  [
    'VAR of one row is NULL',
    "SELECT VAR(p.contoso_cost) AS v FROM contoso_part p WHERE p.contoso_partid = 'P1'",
    [[null]],
  ],
  [
    'STDEVP of one row is 0',
    "SELECT STDEVP(p.contoso_cost) AS v FROM contoso_part p WHERE p.contoso_partid = 'P1'",
    [[0]],
  ],
  [
    'column outside GROUP BY is 8120',
    'SELECT w.contoso_name AS n, COUNT(*) AS c FROM contoso_widget w GROUP BY w.contoso_status',
    { error: 8120 },
  ],
  [
    'HAVING column outside GROUP BY is 8120',
    "SELECT w.contoso_status AS s FROM contoso_widget w GROUP BY w.contoso_status HAVING w.contoso_name = 'x'",
    { error: 8120 },
  ],
  [
    'ORDER BY column outside GROUP BY is 8120',
    'SELECT COUNT(*) AS c FROM contoso_widget w ORDER BY w.contoso_name',
    { error: 8120 },
  ],
  [
    'star with GROUP BY is 8120 for ungrouped columns',
    'SELECT * FROM contoso_widget w GROUP BY w.contoso_status',
    { error: 8120 },
  ],
  ['aggregate in WHERE is 147', 'SELECT w.contoso_name AS n FROM contoso_widget w WHERE COUNT(*) > 1', { error: 147 }],
  ['nested aggregate is 130', 'SELECT SUM(COUNT(*)) AS s FROM contoso_widget', { error: 130 }],
  [
    'aggregate over a subquery is 130',
    'SELECT MAX((SELECT MAX(p.contoso_cost) AS m FROM contoso_part p)) AS m FROM contoso_widget',
    { error: 130 },
  ],
  ['aggregate in GROUP BY is 144', 'SELECT COUNT(*) AS c FROM contoso_widget GROUP BY COUNT(*)', { error: 144 }],
  ['wrong argument count is 174', 'SELECT SUM(w.contoso_quantity, 1) AS s FROM contoso_widget w', { error: 174 }],
  ['CHECKSUM_AGG is unsupported', 'SELECT CHECKSUM_AGG(w.contoso_quantity) AS c FROM contoso_widget w', { error: 195 }],
  [
    'GROUPING is unsupported',
    'SELECT GROUPING(w.contoso_status) AS g FROM contoso_widget w GROUP BY w.contoso_status',
    { error: 195 },
  ],
];

for (const [label, sql, expected] of aggregateCases) {
  test(`aggregate: ${label}`, () => check(sql, expected));
}

test('aggregate result columns carry SQL Server types', async () => {
  const result = await run(
    'SELECT COUNT(*) AS c, COUNT_BIG(w.contoso_name) AS cb, SUM(w.contoso_price) AS sp, AVG(w.contoso_quantity) AS aq, MIN(w.contoso_name) AS mn FROM contoso_widget w',
  );
  const [c, cb, sp, aq, mn] = result.resultSets[0].columns;
  assert.equal(c.type, 'int');
  assert.equal(cb.type, 'bigint');
  assert.deepEqual([sp.type, sp.precision, sp.scale], ['money', 19, 4]);
  assert.equal(aq.type, 'int');
  assert.deepEqual([mn.type, mn.length], ['nvarchar', 100]);
});

test('zero-row aggregate columns keep their static types', async () => {
  const result = await run(
    'SELECT SUM(w.contoso_quantity) AS s, MAX(w.contoso_name) AS m FROM contoso_widget w WHERE 1 = 0',
  );
  const [s, m] = result.resultSets[0].columns;
  assert.equal(s.type, 'int');
  assert.equal(m.type, 'nvarchar');
  assert.equal(m.length, 100);
});

// ---- Typing
test('a float variable with an integral value divides as float', async () => {
  const result = await run('DECLARE @f float = 7.0; SELECT @f / 2 AS d');
  assert.deepEqual(rowsOf(result), [[3.5]]);
  assert.equal(result.resultSets[0].columns[0].type, 'float');
});

test('a NULL-only and a zero-row decimal column get their static types', async () => {
  const result = await run('SELECT NULL AS x, CAST(NULL AS decimal(10,2)) AS d FROM contoso_widget WHERE 1 = 0');
  const [x, d] = result.resultSets[0].columns;
  assert.equal(x.type, 'int');
  assert.deepEqual([d.type, d.precision, d.scale], ['decimal', 10, 2]);
});

test('datetime minus datetime is a datetime from 1900-01-01', async () => {
  const result = await run("SELECT CAST('2020-01-03' AS datetime) - CAST('2020-01-01' AS datetime) AS d");
  assert.deepEqual(rowsOf(result), [['1900-01-03T00:00:00.000Z']]);
  assert.equal(result.resultSets[0].columns[0].type, 'datetime');
});

test("0x41 = 'A' is true, since a varchar string converts to single-byte varbinary", async () => {
  assert.deepEqual(rowsOf(await run("SELECT CASE WHEN 0x41 = 'A' THEN 1 ELSE 0 END AS v")), [[1]]);
});

test("0x41 = N'A' is false, since an nvarchar string converts to UTF-16LE", async () => {
  assert.deepEqual(rowsOf(await run("SELECT CASE WHEN 0x41 = N'A' THEN 1 ELSE 0 END AS v")), [[0]]);
});

test('a varbinary result column is error 40000', async () => {
  await assert.rejects(run('SELECT 0x41 AS b'), {
    number: 40000,
    message: 'The data type varbinary is not supported.',
  });
});

test('a varbinary result column is error 40000, even with no rows', async () => {
  await assert.rejects(run('SELECT 0x41 AS b FROM contoso_widget WHERE 1 = 0'), { number: 40000 });
});

// STRING_AGG ordering, COUNT_BIG(*), binary expressions and static column types (table-driven).
const orderedCases = [
  [
    'WITHIN GROUP ascending orders text case-insensitively',
    "SELECT STRING_AGG(w.contoso_name, ',') WITHIN GROUP (ORDER BY w.contoso_name) AS s FROM contoso_widget w",
    [['Bolt,bolt pack,Gear,Nut']],
  ],
  [
    'WITHIN GROUP descending reverses the order',
    "SELECT STRING_AGG(w.contoso_name, ',') WITHIN GROUP (ORDER BY w.contoso_name DESC) AS s FROM contoso_widget w",
    [['Nut,Gear,bolt pack,Bolt']],
  ],
  [
    'WITHIN GROUP orders by a key other than the value',
    "SELECT STRING_AGG(w.contoso_name, ',') WITHIN GROUP (ORDER BY w.contoso_quantity) AS s FROM contoso_widget w",
    [['Gear,Nut,bolt pack,Bolt']],
  ],
  [
    'WITHIN GROUP DESC puts NULL keys last',
    "SELECT STRING_AGG(w.contoso_name, ',') WITHIN GROUP (ORDER BY w.contoso_quantity DESC) AS s FROM contoso_widget w",
    [['Bolt,bolt pack,Nut,Gear']],
  ],
  [
    'WITHIN GROUP with two keys breaks ties',
    "SELECT STRING_AGG(w.contoso_name, ',') WITHIN GROUP (ORDER BY w.contoso_status, w.contoso_name DESC) AS s FROM contoso_widget w",
    [['bolt pack,Gear,Bolt,Nut']],
  ],
  [
    'WITHIN GROUP with a separator expression',
    "SELECT STRING_AGG(w.contoso_name, UPPER(';')) WITHIN GROUP (ORDER BY w.contoso_name) AS s FROM contoso_widget w",
    [['Bolt;bolt pack;Gear;Nut']],
  ],
  [
    'WITHIN GROUP per group',
    "SELECT w.contoso_status AS st, STRING_AGG(w.contoso_name, ';') WITHIN GROUP (ORDER BY w.contoso_quantity) AS s FROM contoso_widget w GROUP BY w.contoso_status ORDER BY w.contoso_status",
    [
      [null, 'bolt pack'],
      [1, 'Gear;Bolt'],
      [2, 'Nut'],
    ],
  ],
  [
    'STRING_AGG without WITHIN GROUP keeps row order',
    "SELECT STRING_AGG(w.contoso_name, ',') AS s FROM contoso_widget w",
    [['Bolt,Nut,Gear,bolt pack']],
  ],
  ['COUNT_BIG(*) counts rows as bigint', 'SELECT COUNT_BIG(*) AS c FROM contoso_widget', [['4n']]],
  ['COUNT_BIG(*) of no rows is zero', 'SELECT COUNT_BIG(*) AS c FROM contoso_widget WHERE 1 = 0', [['0n']]],
  [
    'COUNT_BIG(*) in HAVING',
    'SELECT w.contoso_status AS st FROM contoso_widget w GROUP BY w.contoso_status HAVING COUNT_BIG(*) > 1',
    [[1]],
  ],
  [
    'CAST text to varbinary and back to nvarchar',
    "SELECT CAST(CAST('ab' AS varbinary(8)) AS nvarchar(10)) AS s",
    [['ab']],
  ],
  ['binary bytes read as a big-endian int', 'SELECT CONVERT(int, CAST(0x00000102 AS binary(4))) AS n', [[258]]],
  ['DECLAREd binary pads a short literal', 'DECLARE @x binary(4) = 0x01; SELECT CAST(@x AS int) AS n', [[16777216]]],
  [
    'DECLAREd varbinary truncates a long literal',
    'DECLARE @x varbinary(2) = 0x010203; SELECT CAST(@x AS int) AS n',
    [[258]],
  ],
  [
    'binary values compare as bytes',
    "SELECT CASE WHEN CAST(1 AS binary(4)) = 0x00000001 THEN 'y' ELSE 'n' END AS s",
    [['y']],
  ],
];
for (const [label, sql, expected] of orderedCases) {
  test(`evaluates: ${label}`, () => check(sql, expected));
}

// Static column types of the result set (the type name and length of the first column).
const typeColumnCases = [
  [
    'scalar subquery takes its column type',
    "SELECT (SELECT w.contoso_name FROM contoso_widget w WHERE w.contoso_name = 'Nut') AS s",
    'nvarchar',
    100,
  ],
  [
    'scalar subquery of money keeps money',
    "SELECT (SELECT w.contoso_price FROM contoso_widget w WHERE w.contoso_name = 'Nut') AS p",
    'money',
    null,
  ],
  [
    'scalar subquery of an aggregate',
    'SELECT (SELECT MAX(w.contoso_status) AS mx FROM contoso_widget w) AS m',
    'int',
    null,
  ],
  [
    'scalar subquery with a correlated int',
    'SELECT (SELECT x.contoso_status FROM contoso_widget x WHERE x.contoso_widgetid = w.contoso_widgetid) AS c, w.contoso_name AS n FROM contoso_widget w',
    'int',
    null,
  ],
  ['UPPER of a column keeps its length', 'SELECT UPPER(w.contoso_name) AS u FROM contoso_widget w', 'nvarchar', 100],
  ['ABS of money keeps money', 'SELECT ABS(w.contoso_price) AS a FROM contoso_widget w', 'money', null],
  ['SQRT of an int is float', 'SELECT SQRT(w.contoso_quantity) AS r FROM contoso_widget w', 'float', null],
  [
    'COALESCE of int and money is money',
    'SELECT COALESCE(w.contoso_quantity, w.contoso_price) AS c FROM contoso_widget w',
    'money',
    null,
  ],
  [
    'CASE with a decimal literal is decimal',
    'SELECT CASE WHEN w.contoso_status = 1 THEN w.contoso_quantity ELSE 2.5 END AS c FROM contoso_widget w',
    'decimal',
    null,
  ],
  ['CONVERT to varchar(5)', 'SELECT CONVERT(varchar(5), w.contoso_name) AS v FROM contoso_widget w', 'varchar', 5],
  ['NEWID is a uniqueidentifier', 'SELECT NEWID() AS g', 'uniqueidentifier', null],
  ['COUNT_BIG(*) is bigint', 'SELECT COUNT_BIG(*) AS c FROM contoso_widget', 'bigint', null],
];
for (const [label, sql, type, length] of typeColumnCases) {
  test(`column type: ${label}`, async () => {
    const column = (await run(sql)).resultSets[0].columns[0];
    assert.deepEqual([column.type, column.length ?? null], [type, length]);
  });
}

// Pushdown: a scanner that honours the pushdown and column request, and one that ignores both.
// The honouring scanner applies each predicate with OData-like semantics that keep every row SQL keeps
// (a null is kept by <> and not by =), so results must match the full scan exactly.
const pcol = (name, sqlType, kind = 'attribute', extra = {}) => ({
  name,
  sqlType,
  length: null,
  precision: null,
  scale: null,
  nullable: true,
  source: { kind, attribute: name },
  ...extra,
});
const pcatalog = {
  tables: new Map([
    [
      'contoso_gizmo',
      {
        logicalName: 'contoso_gizmo',
        idColumn: 'contoso_gizmoid',
        columns: [
          pcol('contoso_gizmoid', 'uniqueidentifier', 'attribute', { nullable: false }),
          pcol('contoso_name', 'nvarchar', 'attribute', { length: 100 }),
          pcol('contoso_status', 'int'),
          pcol('contoso_quantity', 'int'),
          pcol('contoso_price', 'money', 'attribute', { precision: 19, scale: 4 }),
          pcol('contoso_active', 'bit'),
          pcol('contoso_ownerid', 'uniqueidentifier'),
          pcol('contoso_owneridname', 'nvarchar', 'lookupName', { length: 160 }),
          pcol('contoso_statusname', 'nvarchar', 'choiceName', { length: 100 }),
        ],
      },
    ],
  ]),
};
const G = (n) => `00000000-0000-0000-0000-00000000000${n}`;
const ANN_ID = '00000000-0000-0000-0000-0000000000A1';
const BOB_ID = '00000000-0000-0000-0000-0000000000b2';
const gizmos = [
  {
    contoso_gizmoid: G(1),
    contoso_name: 'Bolt',
    contoso_status: 1,
    contoso_quantity: 5,
    contoso_price: { decimal: '2.5000' },
    contoso_active: true,
    contoso_ownerid: ANN_ID,
    contoso_owneridname: 'Ann',
    contoso_statusname: 'Active',
  },
  {
    contoso_gizmoid: G(2),
    contoso_name: 'Nut',
    contoso_status: 2,
    contoso_quantity: 12,
    contoso_price: { decimal: '1.2500' },
    contoso_active: false,
    contoso_ownerid: BOB_ID,
    contoso_owneridname: 'Bob',
    contoso_statusname: 'Inactive',
  },
  {
    contoso_gizmoid: G(3),
    contoso_name: 'Gear',
    contoso_status: 1,
    contoso_quantity: 0,
    contoso_price: { decimal: '10.0000' },
    contoso_active: true,
    contoso_ownerid: null,
    contoso_owneridname: null,
    contoso_statusname: 'Active',
  },
  {
    contoso_gizmoid: G(4),
    contoso_name: 'bolt pack ',
    contoso_status: null,
    contoso_quantity: 7,
    contoso_price: { decimal: '0.5000' },
    contoso_active: null,
    contoso_ownerid: ANN_ID,
    contoso_owneridname: 'Ann',
    contoso_statusname: null,
  },
  {
    contoso_gizmoid: G(5),
    contoso_name: "'123 pack",
    contoso_status: 2,
    contoso_quantity: 3,
    contoso_price: { decimal: '7.0000' },
    contoso_active: true,
    contoso_ownerid: BOB_ID,
    contoso_owneridname: 'Bob',
    contoso_statusname: 'Inactive',
  },
  {
    contoso_gizmoid: G(6),
    contoso_name: '9-Spring',
    contoso_status: 1,
    contoso_quantity: 9,
    contoso_price: { decimal: '3.7500' },
    contoso_active: false,
    contoso_ownerid: ANN_ID,
    contoso_owneridname: 'Ann',
    contoso_statusname: 'Active',
  },
  {
    contoso_gizmoid: G(7),
    contoso_name: "O'Ring",
    contoso_status: null,
    contoso_quantity: null,
    contoso_price: null,
    contoso_active: null,
    contoso_ownerid: null,
    contoso_owneridname: null,
    contoso_statusname: null,
  },
];
const gizmoTables = { contoso_gizmo: gizmos };

const same = (a, b) =>
  typeof a === 'string'
    ? a.toLowerCase() === String(b).toLowerCase()
    : typeof a === 'boolean'
      ? a === b
      : num(a) === num(b);
const num = (v) => (v !== null && typeof v === 'object' ? Number(v.decimal) : Number(v));
const compareSql = (a, b) => (a === null && b === null ? 0 : a === null ? -1 : b === null ? 1 : num(a) - num(b));

function keepsRow(row, f) {
  const v = row[f.column] ?? null;
  switch (f.op) {
    case 'is-null':
      return v === null;
    case 'not-null':
      return v !== null;
    case '=':
      return v !== null && same(v, f.value);
    case '<>':
      return v === null || !same(v, f.value);
    case 'in':
      return v !== null && f.values.some((x) => same(v, x));
    case 'prefix':
      return typeof v === 'string' && v.startsWith(f.value);
    default: {
      if (v === null) return false;
      const c = num(v) - num(f.value);
      return { '<': c < 0, '<=': c <= 0, '>': c > 0, '>=': c >= 0 }[f.op];
    }
  }
}

function scanner(tables, { honour }) {
  const calls = [];
  const scan = async (logical, request = {}) => {
    calls.push({ logical, ...request });
    let rows = tables[logical].map((row) => ({ ...row }));
    if (!honour) return rows;
    const { pushdown, columns } = request;
    if (pushdown) {
      rows = rows.filter((row) => pushdown.filters.every((f) => keepsRow(row, f)));
      if (pushdown.orderBy) {
        rows.sort((a, b) =>
          pushdown.orderBy.reduce(
            (acc, o) => acc || (o.desc ? -1 : 1) * compareSql(a[o.column] ?? null, b[o.column] ?? null),
            0,
          ),
        );
      }
      if (pushdown.top !== null) rows = rows.slice(0, pushdown.top);
    }
    return columns
      ? rows.map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => columns.includes(k))))
      : rows;
  };
  return { scan, calls };
}

const W = 'SELECT contoso_name AS n FROM contoso_gizmo';
const pushdownQueries = [
  [`${W} WHERE contoso_status = 1`, {}],
  [`${W} WHERE contoso_status <> 1`, {}],
  [`${W} WHERE contoso_status < 2`, {}],
  [`${W} WHERE contoso_status >= 2 AND contoso_quantity > 0`, {}],
  [`${W} WHERE 3 < contoso_quantity`, {}],
  [`${W} WHERE contoso_status IS NULL`, {}],
  [`${W} WHERE contoso_status IS NOT NULL AND contoso_active = 1`, {}],
  [`${W} WHERE contoso_status IN (1, 2)`, {}],
  [`${W} WHERE contoso_status NOT IN (1)`, {}],
  [`${W} WHERE contoso_name LIKE '9%'`, {}],
  [`${W} WHERE contoso_name LIKE '''%'`, {}],
  [`${W} WHERE contoso_name LIKE 'b%'`, {}],
  [`${W} WHERE contoso_name <> '2 Gear'`, {}],
  [`${W} WHERE contoso_name = 'Gear'`, {}],
  [`${W} WHERE contoso_ownerid = @owner`, { '@owner': ANN_ID }],
  [`${W} WHERE contoso_ownerid <> 'not-a-guid'`, {}],
  [`${W} WHERE contoso_active = 0 OR contoso_quantity = 9`, {}],
  [`${W} WHERE contoso_price > 1.5`, {}],
  [`${W} WHERE contoso_price = 10`, {}],
  [`${W} WHERE contoso_status = @n`, { '@n': null }],
  [`SELECT TOP 2 contoso_name AS n FROM contoso_gizmo WHERE contoso_status = 1 ORDER BY contoso_quantity DESC`, {}],
  [`SELECT TOP 3 contoso_name AS n FROM contoso_gizmo ORDER BY contoso_name`, {}],
  [`SELECT TOP 2 contoso_name AS n FROM contoso_gizmo WHERE contoso_status <> 2 ORDER BY contoso_quantity`, {}],
  [`SELECT TOP 1 contoso_name AS n FROM contoso_gizmo WHERE contoso_status = 2`, {}],
  [`SELECT contoso_status, COUNT(*) AS n FROM contoso_gizmo WHERE contoso_active = 1 GROUP BY contoso_status`, {}],
  [`SELECT * FROM contoso_gizmo WHERE contoso_status = 1`, {}],
  [`SELECT DISTINCT contoso_status FROM contoso_gizmo WHERE contoso_quantity >= 0`, {}],
  [
    `SELECT g.contoso_name, h.contoso_name AS other FROM contoso_gizmo g JOIN contoso_gizmo h ON h.contoso_gizmoid = g.contoso_gizmoid WHERE g.contoso_status = 1`,
    {},
  ],
  [
    `SELECT x.n FROM (SELECT TOP 2 contoso_name AS n FROM contoso_gizmo WHERE contoso_status = 1 ORDER BY contoso_quantity) x`,
    {},
  ],
  [`${W} WHERE contoso_status IN (SELECT contoso_status FROM contoso_gizmo WHERE contoso_quantity > 3)`, {}],
  [
    `DECLARE @s int = 1; SELECT TOP 5 contoso_name AS n FROM contoso_gizmo WHERE contoso_status = @s ORDER BY contoso_quantity DESC`,
    {},
  ],
  [`SELECT COUNT(*) AS c FROM contoso_gizmo WHERE contoso_quantity > 3`, {}],
  [`${W} WHERE contoso_quantity > 3 AND contoso_quantity < 12`, {}],
  [`${W} WHERE contoso_status = 1 AND contoso_name LIKE '9%' ORDER BY contoso_quantity`, {}],
];

test('pushdown leaves the results of every query unchanged', async () => {
  for (const [sql, params] of pushdownQueries) {
    const full = scanner(gizmoTables, { honour: false });
    const pushed = scanner(gizmoTables, { honour: true });
    const expected = await executeBatch(sql, { catalog: pcatalog, scan: full.scan, params, now: NOW });
    const actual = await executeBatch(sql, { catalog: pcatalog, scan: pushed.scan, params, now: NOW });
    assert.deepEqual(actual.resultSets, expected.resultSets, sql);
    assert.equal(actual.rowCount, expected.rowCount, sql);
  }
});

async function scannedFor(sql, params = {}) {
  const { scan, calls } = scanner(gizmoTables, { honour: true });
  await executeBatch(sql, { catalog: pcatalog, scan, params, now: NOW });
  return calls.filter((c) => c.logical === 'contoso_gizmo');
}

test('pushdown: equality, IN, IS NULL and prefix reach the scan; text equality does not', async () => {
  const [eq] = await scannedFor(`${W} WHERE contoso_status = 1`);
  assert.deepEqual(eq.pushdown, {
    filters: [{ column: 'contoso_status', op: '=', value: 1, exact: true }],
    top: null,
    orderBy: null,
  });
  const [inList] = await scannedFor(`${W} WHERE contoso_status IN (1, 2) AND contoso_status IS NOT NULL`);
  assert.deepEqual(
    inList.pushdown.filters.map((f) => f.op),
    ['in', 'not-null'],
  );
  const [prefix] = await scannedFor(`${W} WHERE contoso_name LIKE '9%'`);
  assert.deepEqual(prefix.pushdown.filters, [{ column: 'contoso_name', op: 'prefix', value: '9', exact: true }]);
  const [text] = await scannedFor(`${W} WHERE contoso_name = 'Gear' AND contoso_quantity = 0`);
  assert.deepEqual(
    text.pushdown.filters.map((f) => f.column),
    ['contoso_quantity'],
  );
  const [cased] = await scannedFor(`${W} WHERE contoso_name LIKE 'b%'`);
  assert.equal(cased.pushdown, null);
});

test('pushdown: TOP pushes with ORDER BY on a plain numeric column only when the WHERE is exact', async () => {
  const [top] = await scannedFor(
    `SELECT TOP 2 contoso_name AS n FROM contoso_gizmo WHERE contoso_status = 1 ORDER BY contoso_quantity DESC`,
  );
  assert.equal(top.pushdown.top, 2);
  assert.deepEqual(top.pushdown.orderBy, [{ column: 'contoso_quantity', desc: true }]);
  const [text] = await scannedFor(`SELECT TOP 3 contoso_name AS n FROM contoso_gizmo ORDER BY contoso_name`);
  assert.equal(text.pushdown, null);
  const [inexact] = await scannedFor(
    `SELECT TOP 2 contoso_name AS n FROM contoso_gizmo WHERE contoso_status <> 2 ORDER BY contoso_quantity`,
  );
  assert.equal(inexact.pushdown.top, null);
});

test('pushdown: the columns requested are those the statement reads, plus the id', async () => {
  const [one] = await scannedFor(`${W} WHERE contoso_status = 1`);
  assert.deepEqual(one.columns, ['contoso_gizmoid', 'contoso_name', 'contoso_status']);
  const [star] = await scannedFor(`SELECT * FROM contoso_gizmo WHERE contoso_status = 1`);
  assert.equal(star.columns.length, pcatalog.tables.get('contoso_gizmo').columns.length);
  const [count] = await scannedFor(`SELECT COUNT(*) AS c FROM contoso_gizmo`);
  assert.deepEqual(count.columns, ['contoso_gizmoid']);
});

test('pushdown: joins and derived tables keep the outer scan whole', async () => {
  const [joined] = await scannedFor(
    `SELECT g.contoso_name FROM contoso_gizmo g JOIN contoso_gizmo h ON h.contoso_gizmoid = g.contoso_gizmoid WHERE g.contoso_status = 1`,
  );
  assert.equal(joined.pushdown, null);
  const calls = await scannedFor(
    `SELECT x.n FROM (SELECT contoso_name AS n FROM contoso_gizmo WHERE contoso_status = 1) x`,
  );
  assert.deepEqual(
    calls.map((c) => c.pushdown.filters.length),
    [1],
  );
});
