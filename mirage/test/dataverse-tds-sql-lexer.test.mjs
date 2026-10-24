import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TdsSqlError, parseExpression, splitBatches, tokenize } from '../lib/dataverse-tds-sql-lexer.mjs';

// Compact S-expression rendering so precedence is visible in the expected strings.
function sx(node) {
  switch (node.type) {
    case 'Literal':
      if (node.kind === 'null') return 'NULL';
      if (node.kind === 'string') return `${node.national ? 'N' : ''}'${node.value}'`;
      return node.text;
    case 'ColumnRef':
      return node.parts.join('.');
    case 'Variable':
    case 'GlobalVariable':
      return node.name;
    case 'Unary':
      return `(${node.operator === 'NOT' ? 'NOT' : `u${node.operator}`} ${sx(node.operand)})`;
    case 'Binary':
      return `(${node.operator} ${sx(node.left)} ${sx(node.right)})`;
    case 'IsNull':
      return `(IS ${node.negated ? 'NOT ' : ''}NULL ${sx(node.operand)})`;
    case 'In':
      return `(${node.negated ? 'NOT ' : ''}IN ${sx(node.operand)} ${node.list ? node.list.map(sx).join(' ') : sx(node.subquery)})`;
    case 'Between':
      return `(${node.negated ? 'NOT ' : ''}BETWEEN ${sx(node.operand)} ${sx(node.low)} ${sx(node.high)})`;
    case 'Like':
      return `(${node.negated ? 'NOT ' : ''}LIKE ${sx(node.operand)} ${sx(node.pattern)}${node.escape ? ` ${sx(node.escape)}` : ''})`;
    case 'Exists':
      return '(EXISTS)';
    case 'Subquery':
      return '(SUBQ)';
    case 'FunctionCall': {
      const parts = [node.name];
      if (node.distinct) parts.push('DISTINCT');
      if (node.star) parts.push('*');
      return `(${[...parts, ...node.args.map(sx)].join(' ')})`;
    }
    case 'Case': {
      const parts = ['CASE'];
      if (node.operand) parts.push(sx(node.operand));
      for (const w of node.whens) parts.push(`(WHEN ${sx(w.when)} ${sx(w.then)})`);
      if (node.elseExpr) parts.push(`(ELSE ${sx(node.elseExpr)})`);
      return `(${parts.join(' ')})`;
    }
    default:
      return `<${node.type}>`;
  }
}

const expr = (sql, options) => parseExpression(tokenize(sql), options);
const render = (sql) => sx(expr(sql));

function assertSyntaxError(fn, number, pattern) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof TdsSqlError, `expected TdsSqlError, got ${err}`);
    assert.equal(err.number, number);
    assert.match(err.message, pattern);
    return true;
  });
}

test('keywords are case-insensitive and reserved words are upper-cased', () => {
  const tokens = tokenize('select SeLeCt from');
  assert.deepEqual(
    tokens.map((t) => [t.type, t.value]),
    [
      ['keyword', 'SELECT'],
      ['keyword', 'SELECT'],
      ['keyword', 'FROM'],
    ],
  );
});

test('identifiers: plain, bracketed and double-quoted, with escapes', () => {
  const cases = [
    ['Name', 'Name', 'none'],
    ['[Full Name]', 'Full Name', 'bracket'],
    ['[a]]b]', 'a]b', 'bracket'],
    ['"x""y"', 'x"y', 'double'],
    ['_col$1#', '_col$1#', 'none'],
  ];
  for (const [sql, value, quoting] of cases) {
    const [tok] = tokenize(sql);
    assert.equal(tok.type, 'identifier', sql);
    assert.equal(tok.value, value, sql);
    assert.equal(tok.quoting, quoting, sql);
  }
});

test('string literals unescape doubled quotes and N prefix marks national strings', () => {
  const [plain] = tokenize("'it''s'");
  assert.deepEqual([plain.type, plain.value, plain.national], ['string', "it's", false]);
  const [national] = tokenize("N'ünï'");
  assert.deepEqual([national.type, national.value, national.national], ['string', 'ünï', true]);
  const [empty] = tokenize("''");
  assert.equal(empty.value, '');
});

test('numbers: int widens to bigint and decimal, decimals, exponents and 0x binary', () => {
  const cases = [
    ['42', 'int'],
    ['2147483647', 'int'],
    ['2147483648', 'bigint'],
    ['9223372036854775808', 'decimal'],
    ['1.5', 'decimal'],
    ['.5', 'decimal'],
    ['1e3', 'float'],
    ['2.5E-2', 'float'],
    ['0xFF', 'binary'],
  ];
  for (const [sql, numberType] of cases) {
    const [tok] = tokenize(sql);
    assert.equal(tok.type, 'number', sql);
    assert.equal(tok.numberType, numberType, sql);
    assert.equal(tok.value, sql, sql);
  }
});

test('variables and global variables', () => {
  const tokens = tokenize('@x @@ROWCOUNT');
  assert.deepEqual(
    tokens.map((t) => [t.type, t.value]),
    [
      ['variable', '@x'],
      ['globalVariable', '@@ROWCOUNT'],
    ],
  );
});

test('operators, punctuation and two-character operators', () => {
  const ops = '= <> != < > <= >= + - * / % & | ^ ~ !< !>'.split(' ');
  const tokens = tokenize(ops.join(' '));
  assert.deepEqual(
    tokens.map((t) => t.value),
    ops,
  );
  assert.ok(tokens.every((t) => t.type === 'operator'));
  assert.deepEqual(
    tokenize('( ) , . ;').map((t) => [t.type, t.value]),
    [
      ['punct', '('],
      ['punct', ')'],
      ['punct', ','],
      ['punct', '.'],
      ['punct', ';'],
    ],
  );
});

test('line and nested block comments produce no tokens', () => {
  const tokens = tokenize('1 -- trailing\n+ /* outer /* inner */ still comment */ 2');
  assert.deepEqual(
    tokens.map((t) => t.value),
    ['1', '+', '2'],
  );
  assert.equal(tokenize('/* only */ -- and this').length, 0);
  assert.equal(tokenize("'-- not a comment'")[0].value, '-- not a comment');
});

test('GO is a batch separator only when it stands alone on its line', () => {
  const types = tokenize('SELECT 1\nGO\nSELECT 2').map((t) => t.type);
  assert.deepEqual(types, ['keyword', 'number', 'batchSeparator', 'keyword', 'number']);
  assert.equal(tokenize('GO 3').find((t) => t.type === 'batchSeparator').count, 3);
  assert.equal(tokenize('  GO  -- end').find((t) => t.type === 'batchSeparator').count, 1);
  assert.equal(
    tokenize("SELECT 'GO'").some((t) => t.type === 'batchSeparator'),
    false,
  );
  assert.equal(
    tokenize('SELECT go').some((t) => t.type === 'batchSeparator'),
    false,
  );
  assert.equal(tokenize('[GO]')[0].type, 'identifier');
});

test('splitBatches honours repeat counts and drops empty batches', () => {
  const batches = splitBatches('SELECT 1\nGO 2\nSELECT 2\nGO\n');
  assert.deepEqual(
    batches.map((b) => [b.sql, b.repeat, b.line]),
    [
      ['SELECT 1\n', 2, 1],
      ['\nSELECT 2\n', 1, 2],
    ],
  );
});

test('lexical errors carry SQL Server numbers and line numbers', () => {
  assert.throws(
    () => tokenize("SELECT 1\n'abc"),
    (err) => err.number === 105 && err.line === 2,
  );
  assert.throws(
    () => tokenize('/* open'),
    (err) => err.number === 113,
  );
  assert.throws(
    () => tokenize('[]'),
    (err) => err.number === 153,
  );
  assert.throws(
    () => tokenize('a # b'),
    (err) => err.number === 102 && /Incorrect syntax near '#'/.test(err.message),
  );
  assert.throws(
    () => tokenize('0x'),
    (err) => err.number === 102,
  );
});

test('precedence: arithmetic, comparison, logical and unary operators', () => {
  const cases = [
    ['1 + 2 * 3', '(+ 1 (* 2 3))'],
    ['1 * 2 + 3', '(+ (* 1 2) 3)'],
    ['1 - 2 - 3', '(- (- 1 2) 3)'],
    ['8 / 4 % 3', '(% (/ 8 4) 3)'],
    ['(1 + 2) * 3', '(* (+ 1 2) 3)'],
    ['1 | 2 + 3', '(+ (| 1 2) 3)'],
    ['a + b = c', '(= (+ a b) c)'],
    ['a = 1 OR b = 2', '(OR (= a 1) (= b 2))'],
    ['a OR b AND c', '(OR a (AND b c))'],
    ['a AND b OR c', '(OR (AND a b) c)'],
    ['NOT a AND b', '(AND (NOT a) b)'],
    ['NOT a = b', '(NOT (= a b))'],
    ['-a * b', '(u- (* a b))'],
    ['-a + b', '(+ (u- a) b)'],
    ['~a + 1', '(+ (u~ a) 1)'],
    ['~a * b', '(* (u~ a) b)'],
    ['a != b', '(!= a b)'],
  ];
  for (const [sql, expected] of cases) assert.equal(render(sql), expected, sql);
});

test('predicates: IS NULL, IN, BETWEEN and LIKE', () => {
  const cases = [
    ['a IS NULL OR b IS NOT NULL', '(OR (IS NULL a) (IS NOT NULL b))'],
    ['a IN (1, 2) AND b', '(AND (IN a 1 2) b)'],
    ['a NOT IN (1)', '(NOT IN a 1)'],
    ['NOT a IN (1)', '(NOT (IN a 1))'],
    ['a NOT BETWEEN 1 AND 2 AND b', '(AND (NOT BETWEEN a 1 2) b)'],
    ['x BETWEEN 1 AND 2 OR y', '(OR (BETWEEN x 1 2) y)'],
    ["a LIKE 'x' + 'y'", "(LIKE a (+ 'x' 'y'))"],
    ["a NOT LIKE 'x%'", "(NOT LIKE a 'x%')"],
  ];
  for (const [sql, expected] of cases) assert.equal(render(sql), expected, sql);
});

test('LIKE ESCAPE stores the escape expression', () => {
  const ast = expr("a LIKE 'x!%%' ESCAPE '!'");
  assert.equal(ast.type, 'Like');
  assert.equal(ast.pattern.value, 'x!%%');
  assert.equal(ast.escape.value, '!');
  assert.equal(render("a LIKE 'x!%' ESCAPE '!' AND b"), "(AND (LIKE a 'x!%' '!') b)");
});

test('literals and identifiers', () => {
  assert.equal(render('NULL'), 'NULL');
  assert.equal(render("N'x'"), "N'x'");
  assert.equal(render('0x1F'), '0x1F');
  assert.equal(expr('12.50').numberType, 'decimal');
  assert.equal(expr('9223372036854775808').numberType, 'decimal');
  assert.deepEqual(expr('a.b.c').parts, ['a', 'b', 'c']);
  assert.deepEqual(expr('[Full Name]').parts, ['Full Name']);
  assert.deepEqual(expr('@p').name, '@p');
  assert.deepEqual(expr('@@VERSION'), { type: 'GlobalVariable', name: '@@VERSION' });
});

test('CASE: simple and searched forms', () => {
  assert.equal(render("CASE x WHEN 1 THEN 'a' WHEN 2 THEN 'b' END"), "(CASE x (WHEN 1 'a') (WHEN 2 'b'))");
  assert.equal(render('CASE WHEN a = 1 THEN 1 ELSE 2 END'), '(CASE (WHEN (= a 1) 1) (ELSE 2))');
  assert.throws(
    () => expr('CASE WHEN a THEN 1 END'),
    (e) => e.number === 4145,
  );
  assertSyntaxError(() => expr('CASE x END'), 102, /Incorrect syntax near 'END'/);
});

test('CAST, TRY_CAST, CONVERT and TRY_CONVERT carry target types', () => {
  const cast = expr('CAST(x AS NVARCHAR(50))');
  assert.deepEqual(
    [cast.type, cast.tryCast, cast.targetType],
    ['Cast', false, { name: 'NVARCHAR', length: 50, scale: null }],
  );
  const tryCast = expr('try_cast(1 AS decimal(18,4))');
  assert.deepEqual([tryCast.tryCast, tryCast.targetType], [true, { name: 'DECIMAL', length: 18, scale: 4 }]);
  assert.deepEqual(expr('CAST(x AS VARCHAR(MAX))').targetType, { name: 'VARCHAR', length: 'MAX', scale: null });
  const convert = expr('CONVERT(VARCHAR(10), d, 126)');
  assert.equal(convert.type, 'Convert');
  assert.equal(convert.tryConvert, false);
  assert.deepEqual(convert.targetType, { name: 'VARCHAR', length: 10, scale: null });
  assert.equal(convert.operand.parts[0], 'd');
  assert.equal(convert.style.text, '126');
  const tryConvert = expr("TRY_CONVERT(INT, '5')");
  assert.deepEqual([tryConvert.tryConvert, tryConvert.style], [true, null]);
  assertSyntaxError(() => expr('CAST(x AS FOO)'), 2715, /Cannot find data type FOO/);
});

test('function calls: COUNT(*), DISTINCT on aggregates, zero-argument and keyword functions', () => {
  assert.equal(render('COUNT(*)'), '(COUNT *)');
  assert.equal(render('COUNT(DISTINCT a)'), '(COUNT DISTINCT a)');
  assert.equal(render('SUM(DISTINCT x)'), '(SUM DISTINCT x)');
  assert.equal(render('NEWID()'), '(NEWID)');
  assert.equal(render('ISNULL(a, 0) + 1'), '(+ (ISNULL a 0) 1)');
  assert.equal(render('LEFT(name, 3)'), '(LEFT name 3)');
  assertSyntaxError(() => expr('LEN(DISTINCT x)'), 102, /Incorrect syntax near 'DISTINCT'/);
  assertSyntaxError(() => expr('SUM(*)'), 102, /Incorrect syntax near '\*'/);
});

test('OVER clauses are rejected as unsupported', () => {
  assert.throws(
    () => expr('ROW_NUMBER() OVER (ORDER BY a)'),
    (err) => err.number === 102 && err.unsupported === true && /OVER/.test(err.message),
  );
});

test('subqueries go through the injected parseSubquery hook', () => {
  const seen = [];
  const parseSubquery = (s) => {
    seen.push(s.tokens[s.pos].value);
    while (!(s.tokens[s.pos].type === 'punct' && s.tokens[s.pos].value === ')')) s.pos++;
    return { type: 'StubSelect' };
  };
  const inList = expr('a IN (SELECT 1)', { parseSubquery });
  assert.equal(inList.subquery.type, 'StubSelect');
  assert.equal(inList.list, null);
  assert.equal(expr('EXISTS (SELECT 1)', { parseSubquery }).subquery.type, 'StubSelect');
  assert.equal(expr('(SELECT 1) + 1', { parseSubquery }).left.type, 'Subquery');
  assert.deepEqual(seen, ['SELECT', 'SELECT', 'SELECT']);
  assert.throws(
    () => expr('a IN (SELECT 1)'),
    (err) => err.unsupported === true,
  );
});

test('stream input parses one expression and leaves the position on the next token', () => {
  const stream = { tokens: tokenize('a + 1 , b'), pos: 0 };
  const ast = parseExpression(stream);
  assert.equal(sx(ast), '(+ a 1)');
  assert.equal(stream.pos, 3);
  assert.equal(stream.tokens[stream.pos].value, ',');
});

test('syntax errors use SQL Server wording and the offending token', () => {
  assertSyntaxError(() => expr('1 +'), 102, /^Incorrect syntax near the end of the statement\.$/);
  assertSyntaxError(() => expr('1 FROM'), 102, /^Incorrect syntax near 'FROM'\.$/);
  assertSyntaxError(() => expr('a b'), 102, /^Incorrect syntax near 'b'\.$/);
  assertSyntaxError(() => expr('SELECT'), 102, /^Incorrect syntax near 'SELECT'\.$/);
  assertSyntaxError(() => expr('a IS 1'), 102, /^Incorrect syntax near '1'\.$/);
  assertSyntaxError(() => expr('a GO'), 102, /Incorrect syntax near 'GO'/);
  assertSyntaxError(() => expr('(1, 2)'), 102, /Incorrect syntax near ','/);
  assertSyntaxError(() => parseExpression(tokenize('1\nGO')), 102, /near 'GO'/);
});

// COUNT_BIG(*) parses like COUNT(*); STRING_AGG ... WITHIN GROUP (ORDER BY ...) is the only ordered-set call.
const callCases = [
  [
    'COUNT_BIG(*) is a star call',
    'COUNT_BIG(*)',
    (n) => n.name === 'COUNT_BIG' && n.star === true && n.args.length === 0,
  ],
  ['COUNT_BIG(DISTINCT x) keeps DISTINCT', 'COUNT_BIG(DISTINCT x)', (n) => n.distinct === true && n.star === false],
  ['COUNT_BIG takes a plain argument', 'COUNT_BIG(x)', (n) => n.args.length === 1 && n.star === false],
  [
    'STRING_AGG without WITHIN GROUP has no ordering',
    "STRING_AGG(a, ',')",
    (n) => n.withinGroup === undefined && n.args.length === 2,
  ],
  [
    'WITHIN GROUP with one ASC-default key',
    "STRING_AGG(a, ',') WITHIN GROUP (ORDER BY b)",
    (n) => n.withinGroup.length === 1 && n.withinGroup[0].direction === null && n.withinGroup[0].expr.parts[0] === 'b',
  ],
  [
    'WITHIN GROUP keeps DESC and ASC per key',
    "STRING_AGG(a, ',') WITHIN GROUP (ORDER BY b DESC, c ASC)",
    (n) => n.withinGroup.map((t) => t.direction).join() === 'DESC,ASC',
  ],
  [
    'WITHIN GROUP key may be an expression',
    "STRING_AGG(a, ',') WITHIN GROUP (ORDER BY b + 1)",
    (n) => n.withinGroup[0].expr.type === 'Binary' && n.withinGroup[0].expr.operator === '+',
  ],
  [
    'WITHIN GROUP is case-insensitive',
    "string_agg(a, ',') within group (order by b desc)",
    (n) => n.withinGroup[0].direction === 'DESC',
  ],
  [
    'STRING_AGG WITHIN GROUP inside an expression',
    "STRING_AGG(a, ',') WITHIN GROUP (ORDER BY b) + 'x'",
    (n) => n.type === 'Binary' && n.left.withinGroup.length === 1,
  ],
];
for (const [label, sql, ok] of callCases) {
  test(`call parsing: ${label}`, () => {
    assert.ok(ok(expr(sql)), sql);
  });
}

const callErrors = [
  ['WITHIN GROUP on SUM is rejected', 'SUM(a) WITHIN GROUP (ORDER BY b)', 102],
  ['WITHIN GROUP needs ORDER BY', "STRING_AGG(a, ',') WITHIN GROUP (b)", 102],
  ['WITHIN GROUP needs parentheses', "STRING_AGG(a, ',') WITHIN GROUP ORDER BY b", 102],
  ['WITHIN GROUP with OVER is unsupported', "STRING_AGG(a, ',') WITHIN GROUP (ORDER BY b) OVER (PARTITION BY c)", 102],
];
for (const [label, sql, number] of callErrors) {
  test(`call parsing: ${label}`, () => {
    assert.throws(
      () => expr(sql),
      (e) => e instanceof TdsSqlError && e.number === number,
      sql,
    );
  });
}

// Binary types: CAST and CONVERT targets, and 0x literals.
const binaryTargetCases = [
  ['CAST to varbinary(8)', 'CAST(x AS varbinary(8))', 'VARBINARY', 8],
  ['CAST to binary(16)', 'CAST(x AS binary(16))', 'BINARY', 16],
  ['CAST to varbinary(MAX)', 'CAST(x AS varbinary(max))', 'VARBINARY', 'MAX'],
  ['CONVERT to binary(4)', 'CONVERT(binary(4), x)', 'BINARY', 4],
  ['TRY_CAST to varbinary', 'TRY_CAST(x AS varbinary)', 'VARBINARY', null],
];
for (const [label, sql, name, length] of binaryTargetCases) {
  test(`binary target: ${label}`, () => {
    const node = expr(sql);
    assert.equal(node.targetType.name, name);
    assert.equal(node.targetType.length, length);
  });
}
test('0x literal is a binary literal', () => {
  assert.deepEqual(expr('0x0A1B'), { type: 'Literal', kind: 'binary', text: '0x0A1B' });
});
