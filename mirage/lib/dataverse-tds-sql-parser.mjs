/**
 * Dataverse TDS SQL statement parser (read-only subset). Pure: no store, protocol or HTTP.
 * Built on dataverse-tds-sql-lexer.mjs, which parses expressions and subqueries.
 *
 * parseBatch(sql) -> { statements }
 *   Splits at GO (splitBatches) and returns the statements of all batches in order. There is no
 *   batch index; each statement has `line` (absolute, 1-based). Statements are separated by ";"
 *   or by a line break. Throws TdsSqlError.
 *
 * Statement AST (`type` names the node):
 *   Select       { distinct, top: { count, percent } | null, columns, from, where,
 *                  groupBy: Expr[] | null, having, orderBy: OrderItem[] | null }
 *   SetOperation { operator: "UNION", all, left: Query, right: Select, orderBy }
 *                Left-deep: "A UNION B UNION ALL C" is SetOperation(all, SetOperation(A, B), C).
 *                ORDER BY after a set operation sits on the outer node and applies to the whole result.
 *   Query        Select | SetOperation. Subqueries (scalar, IN, EXISTS, derived) hold a Query.
 *   columns      { kind: "Expr", expr, alias }
 *                | { kind: "Star", qualifier: string | null }
 *                | { kind: "Assign", name: "@v", expr }   SELECT @v = expr (variable assignment)
 *   from         { source, joins: (Join | Apply)[] }[] | null (one entry per comma-separated source)
 *   source       TableRef { schema: "dbo" | null, name, alias }
 *                | Derived { query, alias }  (alias required)
 *   Join         { kind: "INNER" | "LEFT" | "RIGHT" | "FULL" | "CROSS", source, on: Expr | null }
 *   Apply        { kind: "CROSS" | "OUTER", source: Derived }
 *   OrderItem    { expr, direction: "ASC" | "DESC" | null, ordinal: number | null }
 *   Declare      { variables: [{ name: "@v", dataType, value: Expr | null }] }
 *                dataType { name (upper), length: number | "MAX" | null, scale: number | null }
 *   Set          { name: "@v", value: Expr }   (only SET @variable = expression)
 *   Expressions come from the lexer (ColumnRef, Binary, In, Exists, Subquery, FunctionCall, ...),
 *   except:
 *   Quantified   { operator, quantifier: "ANY" | "ALL", left, query }
 *                left <op> ANY|SOME|ALL (subquery). SOME is stored as ANY. Replaces the Binary node.
 *
 * Errors: TdsSqlError { number, message, line, pos, unsupported }.
 *   Syntax errors: 102 "Incorrect syntax near '...'" (unsupported: false).
 *   Constructs the Dataverse endpoint rejects: 102 with unsupported: true, same as the lexer's OVER error.
 *   Unknown data types: 2715 (unsupported: true).
 *   The docs list the rejected constructs but not the endpoint's text, so those messages are guesses.
 *
 * Rejected by the endpoint (no AST): OFFSET/FETCH, WITH (CTEs and table hints), EXCEPT and
 * INTERSECT, INTO, OPTION, OUTPUT, FOR (XML/JSON), VALUES, PIVOT/UNPIVOT, FREETEXT, AT TIME ZONE,
 * GROUP BY ALL / () / CUBE / ROLLUP / GROUPING SETS, non-dbo schemas, three-part names, APPLY over
 * anything but a derived table, DML, DDL, EXEC and control flow, and data types outside the supported list.
 * Also rejected, in a SELECT with a FROM clause only: duplicate output names and expression columns without
 * an alias. Both are checked only when the name is known statically (plain column references and aliases);
 * SELECT * is exempt. A FROM-less SELECT (constants, variables, @@ functions such as SELECT @@version) is
 * allowed and its unnamed columns get the name "". The FROM-only scope of this rule is assumed, not observed.
 * Not enforced: function names other than FREETEXT and FREETEXTTABLE.
 */

import { TdsSqlError, checkPredicate, parseExpression, splitBatches, tokenize } from './dataverse-tds-sql-lexer.mjs';

// Data types the Dataverse SQL docs list as supported.
const SUPPORTED_TYPES = new Set([
  'BIGINT',
  'BINARY',
  'BIT',
  'CHAR',
  'DATETIME',
  'DECIMAL',
  'FLOAT',
  'INT',
  'MONEY',
  'NCHAR',
  'NUMERIC',
  'NVARCHAR',
  'REAL',
  'SMALLDATETIME',
  'SMALLINT',
  'SMALLMONEY',
  'TINYINT',
  'UNIQUEIDENTIFIER',
  'VARBINARY',
  'VARCHAR',
]);
const READ_ONLY = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE']);
const UNSUPPORTED_STATEMENTS = new Set([
  'ALTER',
  'CREATE',
  'DROP',
  'EXEC',
  'EXECUTE',
  'IF',
  'ELSE',
  'USE',
  'WHILE',
  'BACKUP',
  'BEGIN',
  'BREAK',
  'BULK',
  'CHECKPOINT',
  'CLOSE',
  'COMMIT',
  'CONTINUE',
  'DBCC',
  'DEALLOCATE',
  'DENY',
  'GOTO',
  'GRANT',
  'KILL',
  'OPEN',
  'PRINT',
  'RAISERROR',
  'RECONFIGURE',
  'RESTORE',
  'RETURN',
  'REVOKE',
  'ROLLBACK',
  'SAVE',
  'SHUTDOWN',
  'THROW',
  'TRUNCATE',
  'WAITFOR',
]);
// Keywords rejected wherever they appear. INTO directly after INSERT is exempt so INSERT reports its own error.
const REJECTED_KEYWORDS = new Set(['FOR', 'INTO', 'OPTION', 'OUTPUT', 'WITH']);
const QUANTIFIERS = new Set(['ANY', 'SOME', 'ALL']);
const COMPARISONS = new Set(['=', '<>', '!=', '<', '>', '<=', '>=', '!<', '!>']);
// Identifiers that end a table or column alias when written without AS.
const ALIAS_STOP = new Set(['ON', 'EXCEPT', 'INTERSECT']);

export function parseBatch(sql) {
  if (typeof sql !== 'string') throw new TypeError('parseBatch expects a SQL string.');
  const statements = [];
  for (const batch of splitBatches(sql)) {
    let tokens = [];
    try {
      tokens = prepareTokens(tokenize(batch.sql));
      const s = { tokens, pos: 0, quantified: new Map() };
      while (s.pos < tokens.length) {
        if (eatPunct(s, ';')) continue;
        const line = peek(s).line;
        const statement = parseStatement(s);
        statement.line = batch.line + line - 1;
        statements.push(statement);
        if (!eatPunct(s, ';') && s.pos < tokens.length) checkSeparator(s);
      }
    } catch (err) {
      if (err instanceof TdsSqlError) {
        const local = err.line ?? tokens.at(-1)?.line ?? 1;
        err.line = batch.line + local - 1;
      }
      throw err;
    }
  }
  return { statements };
}

// ---- token rules

// Runs before parsing. Clauses the endpoint rejects are reported at their own token, even when the
// lexer or statement parser would otherwise see a generic syntax error. ANY, SOME and ALL after a
// comparison operator are removed and marked on the "(" that opens the subquery; parseSubqueryHook
// records the mark and attachQuantifiers builds the Quantified node.
function prepareTokens(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const next = tokens[i + 1];
    const word = wordOf(tok);
    if (
      tok.type === 'keyword' &&
      REJECTED_KEYWORDS.has(tok.value) &&
      !(tok.value === 'INTO' && isKeyword(tokens[i - 1], 'INSERT'))
    ) {
      throw notSupported(tok, `The ${tok.value} clause is not supported by the Dataverse SQL endpoint.`);
    }
    if (
      tok.type === 'keyword' &&
      QUANTIFIERS.has(tok.value) &&
      tokens[i - 1]?.type === 'operator' &&
      COMPARISONS.has(tokens[i - 1].value) &&
      isPunct(next, '(') &&
      isKeyword(tokens[i + 2], 'SELECT')
    ) {
      next.quantifier = tok.value === 'ALL' ? 'ALL' : 'ANY';
      tokens.splice(i, 1);
      i -= 1;
      continue;
    }
    if ((word === 'FREETEXT' || word === 'FREETEXTTABLE') && isPunct(next, '(')) {
      throw notSupported(tok, `${word} is not supported by the Dataverse SQL endpoint.`);
    }
    if ((word === 'PIVOT' || word === 'UNPIVOT') && isPunct(next, '(')) {
      throw notSupported(tok, `${word} is not supported by the Dataverse SQL endpoint.`);
    }
    if (word === 'AT' && isWord(next, 'TIME') && isWord(tokens[i + 2], 'ZONE')) {
      throw notSupported(tok, 'AT TIME ZONE is not supported by the Dataverse SQL endpoint.');
    }
    if (word === 'OFFSET' && (next?.type === 'number' || next?.type === 'variable')) {
      throw notSupported(tok, 'The OFFSET clause is not supported by the Dataverse SQL endpoint.');
    }
    if (word === 'FETCH' && (isWord(next, 'NEXT') || isWord(next, 'FIRST'))) {
      throw notSupported(tok, 'The FETCH clause is not supported by the Dataverse SQL endpoint.');
    }
  }
  return tokens;
}

// ---- statements

function parseStatement(s) {
  const tok = peek(s);
  const word = wordOf(tok);
  if (word === 'SELECT') return parseQuery(s);
  if (word === 'DECLARE') return parseDeclare(s);
  if (word === 'SET') return parseSet(s);
  if (READ_ONLY.has(word))
    throw notSupported(tok, `${word} is not supported: the Dataverse SQL endpoint is read-only.`);
  if (UNSUPPORTED_STATEMENTS.has(word))
    throw notSupported(tok, `${word} is not supported by the Dataverse SQL endpoint.`);
  if (word === 'VALUES')
    throw notSupported(tok, 'The VALUES table value constructor is not supported by the Dataverse SQL endpoint.');
  throw syntaxError(tok);
}

// Statements end at ";" or at a line break. Anything else on the same line after a statement is an error.
function checkSeparator(s) {
  const next = peek(s);
  if (next.line === s.tokens[s.pos - 1].line) throw syntaxError(next);
}

function parseDeclare(s) {
  advance(s);
  const variables = [];
  do {
    const tok = peek(s);
    if (tok?.type !== 'variable') throw syntaxError(tok);
    advance(s);
    const dataType = parseDataType(s);
    let value = null;
    if (isOperator(peek(s), '=')) {
      advance(s);
      value = expr(s);
    }
    variables.push({ name: tok.value, dataType, value });
  } while (eatPunct(s, ','));
  return { type: 'Declare', variables };
}

function parseDataType(s) {
  const tok = peek(s);
  if (!isName(tok)) throw syntaxError(tok);
  advance(s);
  const name = tok.value.toUpperCase();
  if (!SUPPORTED_TYPES.has(name)) {
    throw new TdsSqlError(2715, `Data type '${tok.value}' is not supported by the Dataverse SQL endpoint.`, {
      pos: tok.pos,
      line: tok.line,
      unsupported: true,
    });
  }
  let length = null;
  let scale = null;
  if (eatPunct(s, '(')) {
    const first = peek(s);
    if (isWord(first, 'MAX')) {
      advance(s);
      length = 'MAX';
    } else {
      length = integerToken(s);
    }
    if (eatPunct(s, ',')) scale = integerToken(s);
    expectPunct(s, ')');
  }
  return { type: 'DataType', name, length, scale };
}

function integerToken(s) {
  const tok = peek(s);
  if (tok?.type !== 'number' || !/^\d+$/.test(tok.value)) throw syntaxError(tok);
  advance(s);
  return Number(tok.value);
}

// SET options (SET NOCOUNT ON, ...) are not supported; compound assignment (+=) is a syntax error here.
function parseSet(s) {
  const kw = advance(s);
  const tok = peek(s);
  if (!tok) throw syntaxError(kw);
  if (tok.type !== 'variable')
    throw notSupported(tok, 'SET options are not supported; only SET @variable = expression is.');
  advance(s);
  if (!isOperator(peek(s), '=')) throw syntaxError(peek(s));
  advance(s);
  return { type: 'Set', name: tok.value, value: expr(s) };
}

// ---- queries

// Used for top-level statements and for derived tables. Scalar, IN and EXISTS subqueries go through
// parseSubqueryHook, which the lexer calls with the stream on SELECT.
function parseQuery(s) {
  let query = parseSelect(s);
  while (isKeyword(peek(s), 'UNION')) {
    advance(s);
    const all = eatKeyword(s, 'ALL');
    const right = parseSelect(s);
    query = { type: 'SetOperation', operator: 'UNION', all, left: query, right, orderBy: null };
  }
  if (isWord(peek(s), 'EXCEPT') || isWord(peek(s), 'INTERSECT')) {
    throw notSupported(peek(s), `${wordOf(peek(s))} is not supported by the Dataverse SQL endpoint; only UNION is.`);
  }
  if (isKeyword(peek(s), 'ORDER')) query.orderBy = parseOrderBy(s);
  return query;
}

// The stream is on SELECT. The "(" before it may carry a quantifier mark from prepareTokens.
function parseSubqueryHook(s) {
  const open = s.tokens[s.pos - 1];
  const query = parseQuery(s);
  if (open?.quantifier) s.quantified.set(query, open.quantifier);
  return query;
}

function parseSelect(s) {
  expectKeyword(s, 'SELECT');
  const distinct = eatKeyword(s, 'DISTINCT');
  const top = isKeyword(peek(s), 'TOP') ? parseTop(s) : null;
  const starts = [];
  const columns = parseSelectList(s, starts);
  if (isKeyword(peek(s), 'FROM')) checkColumnNames(columns, starts);
  const from = isKeyword(peek(s), 'FROM') ? parseFrom(s) : null;
  const where = eatKeyword(s, 'WHERE') ? checkPredicate(s, expr(s)) : null;
  const groupBy = isKeyword(peek(s), 'GROUP') ? parseGroupBy(s) : null;
  const having = eatKeyword(s, 'HAVING') ? checkPredicate(s, expr(s)) : null;
  return { type: 'Select', distinct, top, columns, from, where, groupBy, having, orderBy: null };
}

// TOP count is parsed as a primary, not an expression: "TOP (10) * FROM" must not read "*" as multiplication.
function parseTop(s) {
  advance(s);
  const tok = peek(s);
  let count;
  if (eatPunct(s, '(')) {
    count = expr(s);
    expectPunct(s, ')');
  } else if (tok?.type === 'number') {
    advance(s);
    count = { type: 'Literal', kind: 'number', numberType: tok.numberType, text: tok.value };
  } else if (tok?.type === 'variable') {
    advance(s);
    count = { type: 'Variable', name: tok.value };
  } else {
    throw syntaxError(tok);
  }
  const percent = eatWord(s, 'PERCENT');
  return { count, percent };
}

// `starts` receives the first token of each column, parallel to the result, for error positions.
function parseSelectList(s, starts) {
  const columns = [];
  do {
    const tok = peek(s);
    starts.push(tok);
    if (isOperator(tok, '*')) {
      advance(s);
      columns.push({ kind: 'Star', qualifier: null });
    } else if (isName(tok) && isPunct(peek(s, 1), '.') && isOperator(peek(s, 2), '*')) {
      advance(s);
      advance(s);
      advance(s);
      columns.push({ kind: 'Star', qualifier: tok.value });
    } else if (tok?.type === 'variable' && isOperator(peek(s, 1), '=')) {
      advance(s);
      advance(s);
      columns.push({ kind: 'Assign', name: tok.value, expr: expr(s) });
    } else {
      const e = expr(s);
      columns.push({ kind: 'Expr', expr: e, alias: parseAlias(s) });
    }
  } while (eatPunct(s, ','));
  return columns;
}

// Output names must be unique and every expression column needs an alias. Only names known statically are
// compared: plain column references and aliases. SELECT * expands at run time, and assignments have no output.
// Called only for a SELECT with a FROM clause (the caller checks the next token).
function checkColumnNames(columns, starts) {
  const seen = new Set();
  columns.forEach((column, i) => {
    if (column.kind !== 'Expr') return;
    const tok = starts[i];
    const name = column.alias ?? (column.expr.type === 'ColumnRef' ? column.expr.parts.at(-1) : null);
    if (name === null) {
      throw notSupported(
        tok,
        'Without unique column name and alias: an expression column needs an alias in the Dataverse SQL endpoint.',
      );
    }
    const key = name.toLowerCase();
    if (seen.has(key))
      throw notSupported(tok, `Duplicate column name '${name}' is not supported by the Dataverse SQL endpoint.`);
    seen.add(key);
  });
}

function parseFrom(s) {
  advance(s);
  const items = [];
  do {
    const source = parseTableSource(s);
    const joins = [];
    for (let join = parseJoin(s); join; join = parseJoin(s)) joins.push(join);
    items.push({ source, joins });
  } while (eatPunct(s, ','));
  return items;
}

function parseTableSource(s) {
  const tok = peek(s);
  if (eatPunct(s, '(')) {
    if (isKeyword(peek(s), 'VALUES'))
      throw notSupported(peek(s), 'The VALUES table value constructor is not supported by the Dataverse SQL endpoint.');
    if (!isKeyword(peek(s), 'SELECT')) throw syntaxError(peek(s));
    const query = parseQuery(s);
    expectPunct(s, ')');
    const alias = parseAlias(s);
    if (alias === null) throw syntaxError(peek(s));
    return { type: 'Derived', query, alias };
  }
  if (!isName(tok)) throw syntaxError(tok);
  advance(s);
  let schema = null;
  let name = tok.value;
  if (eatPunct(s, '.')) {
    const second = peek(s);
    if (!isName(second)) throw syntaxError(second);
    advance(s);
    if (isPunct(peek(s), '.'))
      throw notSupported(peek(s), 'Three-part table names are not supported by the Dataverse SQL endpoint.');
    if (tok.value.toLowerCase() !== 'dbo') {
      throw notSupported(tok, `Schema '${tok.value}' is not supported; only dbo is.`);
    }
    schema = tok.value;
    name = second.value;
  }
  return { type: 'TableRef', schema, name, alias: parseAlias(s) };
}

// JOIN, INNER/LEFT/RIGHT/FULL [OUTER] JOIN, CROSS JOIN, CROSS APPLY, OUTER APPLY. Returns null if none.
function parseJoin(s) {
  const tok = peek(s);
  if (isKeyword(tok, 'CROSS')) {
    advance(s);
    if (eatWord(s, 'APPLY')) return parseApply(s, 'CROSS');
    expectKeyword(s, 'JOIN');
    return { type: 'Join', kind: 'CROSS', source: parseTableSource(s), on: null };
  }
  if (isKeyword(tok, 'OUTER')) {
    advance(s);
    if (!eatWord(s, 'APPLY')) throw syntaxError(peek(s));
    return parseApply(s, 'OUTER');
  }
  let kind;
  if (isKeyword(tok, 'JOIN')) {
    kind = 'INNER';
  } else if (isKeyword(tok, 'INNER')) {
    advance(s);
    kind = 'INNER';
  } else if (isKeyword(tok, 'LEFT') || isKeyword(tok, 'RIGHT') || isKeyword(tok, 'FULL')) {
    advance(s);
    eatKeyword(s, 'OUTER');
    kind = tok.value;
  } else {
    return null;
  }
  expectKeyword(s, 'JOIN');
  const source = parseTableSource(s);
  if (!eatWord(s, 'ON')) throw syntaxError(peek(s));
  return { type: 'Join', kind, source, on: checkPredicate(s, expr(s)) };
}

function parseApply(s, kind) {
  const tok = peek(s);
  const source = parseTableSource(s);
  if (source.type !== 'Derived') throw notSupported(tok, 'APPLY is supported only with a derived table (unverified).');
  return { type: 'Apply', kind, source };
}

function parseGroupBy(s) {
  advance(s);
  expectKeyword(s, 'BY');
  const tok = peek(s);
  if (isKeyword(tok, 'ALL')) throw notSupported(tok, 'GROUP BY ALL is not supported by the Dataverse SQL endpoint.');
  if (isWord(tok, 'CUBE') || isWord(tok, 'ROLLUP') || isWord(tok, 'GROUPING')) {
    throw notSupported(tok, 'CUBE, ROLLUP and GROUPING SETS are not supported by the Dataverse SQL endpoint.');
  }
  if (isPunct(tok, '(') && isPunct(peek(s, 1), ')'))
    throw notSupported(tok, 'GROUP BY () is not supported by the Dataverse SQL endpoint.');
  const items = [];
  do {
    items.push(expr(s));
  } while (eatPunct(s, ','));
  return items;
}

function parseOrderBy(s) {
  advance(s);
  expectKeyword(s, 'BY');
  const items = [];
  do {
    const e = expr(s);
    const direction = isKeyword(peek(s), 'ASC') || isKeyword(peek(s), 'DESC') ? advance(s).value : null;
    const ordinal = e.type === 'Literal' && e.kind === 'number' && /^\d+$/.test(e.text) ? Number(e.text) : null;
    items.push({ expr: e, direction, ordinal });
  } while (eatPunct(s, ','));
  return items;
}

// AS alias or a bare identifier. Keywords never reach here. Quoted identifiers may always be aliases.
function parseAlias(s) {
  if (eatKeyword(s, 'AS')) {
    const tok = peek(s);
    if (!isName(tok)) throw syntaxError(tok);
    advance(s);
    return tok.value;
  }
  const tok = peek(s);
  if (isName(tok) && !(tok.quoting === 'none' && ALIAS_STOP.has(tok.value.toUpperCase()))) {
    advance(s);
    return tok.value;
  }
  return null;
}

// ---- expressions

// Parses one expression through the lexer, then turns ANY/ALL-marked comparisons into Quantified nodes.
const expr = (s) => {
  const node = parseExpression(s, { parseSubquery: parseSubqueryHook });
  return s.quantified.size ? attachQuantifiers(node, s.quantified) : node;
};

// Replaces Binary(op, left, Subquery(query)) with Quantified when the query was marked by prepareTokens.
function attachQuantifiers(node, quantified) {
  if (Array.isArray(node)) return node.map((item) => attachQuantifiers(item, quantified));
  if (node === null || typeof node !== 'object') return node;
  for (const key of Object.keys(node)) node[key] = attachQuantifiers(node[key], quantified);
  if (node.type === 'Binary' && node.right?.type === 'Subquery' && quantified.has(node.right.query)) {
    return {
      type: 'Quantified',
      operator: node.operator,
      quantifier: quantified.get(node.right.query),
      left: node.left,
      query: node.right.query,
    };
  }
  return node;
}

// ---- stream helpers

const peek = (s, k = 0) => s.tokens[s.pos + k];
const advance = (s) => s.tokens[s.pos++];
const isName = (tok) => tok?.type === 'identifier';
const isKeyword = (tok, value) => tok?.type === 'keyword' && tok.value === value;
const isPunct = (tok, value) => tok?.type === 'punct' && tok.value === value;
const isOperator = (tok, value) => tok?.type === 'operator' && tok.value === value;
// Upper-case keyword value, or upper-case unquoted identifier. Null for anything else.
const wordOf = (tok) => {
  if (tok?.type === 'keyword') return tok.value;
  if (tok?.type === 'identifier' && tok.quoting === 'none') return tok.value.toUpperCase();
  return null;
};
const isWord = (tok, value) => wordOf(tok) === value;

function eatKeyword(s, value) {
  if (!isKeyword(peek(s), value)) return false;
  advance(s);
  return true;
}

function eatWord(s, value) {
  if (!isWord(peek(s), value)) return false;
  advance(s);
  return true;
}

function eatPunct(s, value) {
  if (!isPunct(peek(s), value)) return false;
  advance(s);
  return true;
}

function expectKeyword(s, value) {
  if (!isKeyword(peek(s), value)) throw syntaxError(peek(s));
  return advance(s);
}

function expectPunct(s, value) {
  if (!isPunct(peek(s), value)) throw syntaxError(peek(s));
  return advance(s);
}

function syntaxError(tok) {
  if (!tok) return new TdsSqlError(102, 'Incorrect syntax near the end of the statement.');
  return new TdsSqlError(102, `Incorrect syntax near '${tok.raw}'.`, { pos: tok.pos, line: tok.line });
}

function notSupported(tok, message, number = 102) {
  return new TdsSqlError(number, message, { pos: tok?.pos ?? null, line: tok?.line ?? null, unsupported: true });
}
