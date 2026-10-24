/**
 * Dataverse TDS SQL lexer and expression parser (T-SQL subset).
 *
 * Pure functions: no store, protocol or HTTP knowledge.
 *
 * Tokens: { type, value, raw, pos, end, line, col, ...fields }
 *   keyword         value: upper-case reserved word (SELECT, AND, CASE, ...)
 *   identifier      value: name without delimiters; quoting: "none" | "bracket" | "double"
 *   string          value: unescaped text; national: boolean (N'...')
 *   number          value: source text; numberType: "int" | "bigint" | "decimal" | "float" | "binary"
 *   variable        value: "@name"
 *   globalVariable  value: "@@name"
 *   operator        value: = <> != < > <= >= !< !> + - * / % & | ^ ~
 *   punct           value: ( ) , . ;
 *   batchSeparator  value: "GO"; count: repeat count (default 1). Only when GO stands alone on its line.
 * Comments (-- and nested block comments) produce no tokens.
 *
 * Errors: TdsSqlError { number, message, line, pos, unsupported }
 *   102 "Incorrect syntax near '...'"; 105 unclosed string; 113 unclosed block comment;
 *   153 zero-length delimited identifier; 2715 unknown data type.
 *   unsupported: true marks constructs the Dataverse endpoint rejects (OVER clauses, subqueries without a hook).
 *
 * Expression parser: parseExpression(input, { parseSubquery })
 *   input: a token array (must be consumed completely), or a stream { tokens, pos }
 *   (parses one expression starting at pos and leaves pos on the first unconsumed token).
 *   parseSubquery(stream) is supplied by the SELECT parser. It is called with stream.pos on
 *   the SELECT keyword, parses the query, leaves stream.pos on the closing ")" and returns
 *   the query node. Without the hook a subquery raises an unsupported error.
 *
 * Precedence, loosest first. Operators in one row bind equally and associate left:
 *   OR | AND | NOT | IS, IN, LIKE, BETWEEN | = <> != < > <= >= !< !> | + - & | ^ | * / %
 *   | unary + - (operand takes * and / only) | unary ~ (operand is a primary)
 *   Predicates sit above NOT and AND, as in ANSI SQL, so NOT a IN (1) is NOT (a IN (1)).
 *
 * AST nodes:
 *   Literal        { kind: "number", numberType, text } | { kind: "string", value, national }
 *                  | { kind: "binary", text } | { kind: "null" }
 *   ColumnRef      { parts: string[] }                 a | a.b | a.b.c | a.b.c.d
 *   Variable       { name }                            @name
 *   GlobalVariable { name }                            @@name
 *   Unary          { operator: "-" | "+" | "~" | "NOT", operand }
 *   Binary         { operator, left, right }           + - * / % & | ^ = <> != < > <= >= !< !> AND OR (as written)
 *   IsNull         { operand, negated }
 *   In             { operand, negated, list: Expr[] | null, subquery: node | null }
 *   Between        { operand, negated, low, high }
 *   Like           { operand, negated, pattern, escape: Expr | null }
 *   Exists         { subquery }
 *   Subquery       { query }                           scalar subquery
 *   Case           { operand: Expr | null, whens: [{ when, then }], elseExpr: Expr | null }
 *   Cast           { operand, targetType, tryCast }
 *   Convert        { targetType, operand, style: Expr | null, tryConvert }
 *   FunctionCall   { name, distinct, star, args: Expr[], withinGroup }   COUNT(*) and COUNT_BIG(*) set star;
 *                  withinGroup: [{ expr, direction }] | undefined, from STRING_AGG(...) WITHIN GROUP (ORDER BY ...)
 *   targetType     { name, length: number | "MAX" | null, scale: number | null }
 */

export class TdsSqlError extends Error {
  constructor(number, message, { pos = null, line = null, unsupported = false } = {}) {
    super(message);
    this.name = "TdsSqlError";
    this.number = number;
    this.pos = pos;
    this.line = line;
    this.unsupported = unsupported;
  }
}

const WHITESPACE = /[ \t\r\n\f\v]/;
const DIGIT = /[0-9]/;
const HEX_DIGIT = /[0-9a-fA-F]/;
const IDENT_START = /[\p{L}_]/u;
const IDENT_PART = /[\p{L}\p{N}_$#]/u;

const KEYWORDS = new Set([
  "ALL", "ALTER", "AND", "ANY", "AS", "ASC", "BETWEEN", "BY", "CASE", "COLLATE", "CREATE", "CROSS",
  "DECLARE", "DELETE", "DESC", "DISTINCT", "DROP", "ELSE", "END", "EXEC", "EXECUTE", "EXISTS", "FOR",
  "FROM", "FULL", "GROUP", "HAVING", "IF", "IN", "INNER", "INSERT", "INTO", "IS", "JOIN", "LEFT", "LIKE",
  "MERGE", "NOT", "NULL", "OPTION", "OR", "ORDER", "OUTER", "OUTPUT", "OVER", "RIGHT", "SELECT", "SET",
  "SOME", "THEN", "TOP", "UNION", "UPDATE", "USE", "VALUES", "WHEN", "WHERE", "WHILE", "WITH",
]);
const TWO_CHAR_OPERATORS = new Set(["<>", "!=", "<=", ">=", "!<", "!>"]);
const ONE_CHAR_OPERATORS = new Set("=<>+-*/%&|^~");
const PUNCTUATION = new Set("(),.;");

// Keywords that are also built-in functions and so may start a call.
const FUNCTION_KEYWORDS = new Set(["LEFT", "RIGHT"]);
const AGGREGATES = new Set(["COUNT", "COUNT_BIG", "SUM", "AVG", "MIN", "MAX", "STDEV", "STDEVP", "VAR", "VARP"]);
const TYPE_NAMES = new Set([
  "BIGINT", "BINARY", "BIT", "CHAR", "DATE", "DATETIME", "DATETIME2", "DATETIMEOFFSET", "DECIMAL", "FLOAT",
  "INT", "INTEGER", "MONEY", "NCHAR", "NUMERIC", "NVARCHAR", "REAL", "SMALLDATETIME", "SMALLINT",
  "SMALLMONEY", "TIME", "TINYINT", "UNIQUEIDENTIFIER", "VARBINARY", "VARCHAR",
]);

// Binding powers, higher binds tighter.
const BP = Object.freeze({
  OR: 10, AND: 20, NOT: 30, PREDICATE: 40, UNARY_SIGN: 61, UNARY_TILDE: 80,
});
const OPERATOR_BP = new Map([
  ["=", 50], ["<>", 50], ["!=", 50], ["<", 50], [">", 50], ["<=", 50], [">=", 50], ["!<", 50], ["!>", 50],
  ["+", 60], ["-", 60], ["&", 60], ["|", 60], ["^", 60],
  ["*", 70], ["/", 70], ["%", 70],
]);
const PREDICATE_KEYWORDS = new Set(["IN", "LIKE", "BETWEEN"]);

/** Tokenize SQL text. Throws TdsSqlError on lexical errors. */
export function tokenize(sql) {
  if (typeof sql !== "string") throw new TypeError("tokenize expects a SQL string.");
  const starts = lineStarts(sql);
  let tokens;
  try {
    tokens = scan(sql);
  } catch (err) {
    if (err instanceof TdsSqlError && err.line === null) err.line = locate(starts, err.pos).line;
    throw err;
  }
  for (const tok of tokens) {
    const { line, col } = locate(starts, tok.pos);
    tok.line = line;
    tok.col = col;
  }
  return tokens;
}

/**
 * Split SQL into batches at GO separators. Each batch is { sql, repeat, line }; repeat is the
 * count given to the GO that ends it. Batches with no tokens are dropped.
 */
export function splitBatches(sql) {
  const starts = lineStarts(sql);
  const batches = [];
  let start = 0;
  for (const tok of tokenize(sql)) {
    if (tok.type !== "batchSeparator") continue;
    batches.push({ sql: sql.slice(start, tok.pos), repeat: tok.count, line: locate(starts, start).line });
    start = tok.end;
  }
  batches.push({ sql: sql.slice(start), repeat: 1, line: locate(starts, start).line });
  return batches.filter((batch) => tokenize(batch.sql).length > 0);
}

/**
 * Parse one expression. See the module header for input forms and the hook contract.
 * Returns the AST node.
 */
export function parseExpression(input, { parseSubquery = null } = {}) {
  const wholeArray = Array.isArray(input);
  const stream = wholeArray ? { tokens: input, pos: 0 } : input;
  if (!stream || !Array.isArray(stream.tokens)) throw new TypeError("parseExpression expects tokens or a stream.");
  const ast = parseBinding(stream, 0, { parseSubquery });
  if (wholeArray && stream.pos < stream.tokens.length) throw syntaxError(stream.tokens[stream.pos]);
  return ast;
}

// ---- lexer

function scan(sql) {
  const n = sql.length;
  const at = (k) => (k < n ? sql[k] : "");
  const tokens = [];
  let i = 0;
  while (i < n) {
    const ch = sql[i];
    if (WHITESPACE.test(ch)) {
      i++;
      continue;
    }
    if (ch === "-" && at(i + 1) === "-") {
      const newline = sql.indexOf("\n", i);
      i = newline === -1 ? n : newline;
      continue;
    }
    if (ch === "/" && at(i + 1) === "*") {
      i = skipBlockComment(sql, i);
      continue;
    }
    const start = i;
    if (ch === "'" || ((ch === "N" || ch === "n") && at(i + 1) === "'")) {
      const national = ch !== "'";
      const { value, end } = readString(sql, national ? i + 1 : i);
      tokens.push(token("string", sql, start, end, { value, national }));
      i = end;
      continue;
    }
    if (ch === '"' || ch === "[") {
      const { value, end } = readQuotedIdentifier(sql, i);
      tokens.push(token("identifier", sql, start, end, { value, quoting: ch === '"' ? "double" : "bracket" }));
      i = end;
      continue;
    }
    if (ch === "@") {
      const global = at(i + 1) === "@";
      const nameStart = i + (global ? 2 : 1);
      let end = nameStart;
      while (end < n && IDENT_PART.test(sql[end])) end++;
      if (end === nameStart) throw new TdsSqlError(102, "Incorrect syntax near '@'.", { pos: i });
      tokens.push(token(global ? "globalVariable" : "variable", sql, start, end, { value: sql.slice(start, end) }));
      i = end;
      continue;
    }
    if (DIGIT.test(ch) || (ch === "." && DIGIT.test(at(i + 1)))) {
      const { end, numberType } = readNumber(sql, i);
      tokens.push(token("number", sql, start, end, { value: sql.slice(start, end), numberType }));
      i = end;
      continue;
    }
    if (IDENT_START.test(ch)) {
      let end = i + 1;
      while (end < n && IDENT_PART.test(sql[end])) end++;
      const word = sql.slice(i, end);
      const upper = word.toUpperCase();
      const separator = upper === "GO" ? batchSeparatorAt(sql, i, end) : null;
      if (separator) {
        tokens.push(token("batchSeparator", sql, start, separator.end, { value: "GO", count: separator.count }));
        i = separator.end;
        continue;
      }
      if (KEYWORDS.has(upper)) tokens.push(token("keyword", sql, start, end, { value: upper }));
      else tokens.push(token("identifier", sql, start, end, { value: word, quoting: "none" }));
      i = end;
      continue;
    }
    const pair = sql.slice(i, i + 2);
    if (TWO_CHAR_OPERATORS.has(pair)) {
      tokens.push(token("operator", sql, start, i + 2, { value: pair }));
      i += 2;
    } else if (ONE_CHAR_OPERATORS.has(ch)) {
      tokens.push(token("operator", sql, start, i + 1, { value: ch }));
      i++;
    } else if (PUNCTUATION.has(ch)) {
      tokens.push(token("punct", sql, start, i + 1, { value: ch }));
      i++;
    } else {
      throw new TdsSqlError(102, `Incorrect syntax near '${ch}'.`, { pos: i });
    }
  }
  return tokens;
}

function token(type, sql, start, end, fields) {
  return { type, ...fields, raw: sql.slice(start, end), pos: start, end, line: null, col: null };
}

function lineStarts(sql) {
  const starts = [0];
  for (let i = 0; i < sql.length; i++) if (sql[i] === "\n") starts.push(i + 1);
  return starts;
}

function locate(starts, pos) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, col: pos - starts[lo] + 1 };
}

function skipBlockComment(sql, from) {
  let depth = 0;
  let j = from;
  while (j < sql.length) {
    if (sql[j] === "/" && sql[j + 1] === "*") {
      depth++;
      j += 2;
    } else if (sql[j] === "*" && sql[j + 1] === "/") {
      depth--;
      j += 2;
      if (depth === 0) return j;
    } else {
      j++;
    }
  }
  throw new TdsSqlError(113, "Missing end comment mark '*/'.", { pos: from });
}

// `open` is the index of the opening quote. '' escapes a quote.
function readString(sql, open) {
  let j = open + 1;
  let value = "";
  for (;;) {
    if (j >= sql.length) {
      throw new TdsSqlError(105, `Unclosed quotation mark after the character string '${sql.slice(open + 1)}'.`, { pos: open });
    }
    const c = sql[j];
    if (c === "'") {
      if (sql[j + 1] === "'") {
        value += "'";
        j += 2;
        continue;
      }
      return { value, end: j + 1 };
    }
    value += c;
    j++;
  }
}

// `start` is the index of the opening " or [. Doubled closing delimiters escape.
function readQuotedIdentifier(sql, start) {
  const close = sql[start] === '"' ? '"' : "]";
  let j = start + 1;
  let value = "";
  for (;;) {
    if (j >= sql.length) throw new TdsSqlError(102, `Incorrect syntax near '${sql.slice(start)}'.`, { pos: start });
    const c = sql[j];
    if (c === close) {
      if (sql[j + 1] === close) {
        value += close;
        j += 2;
        continue;
      }
      if (value === "") throw new TdsSqlError(153, "Zero-length delimited identifier.", { pos: start });
      return { value, end: j + 1 };
    }
    value += c;
    j++;
  }
}

function readNumber(sql, start) {
  const at = (k) => (k < sql.length ? sql[k] : "");
  if (sql[start] === "0" && (at(start + 1) === "x" || at(start + 1) === "X")) {
    let end = start + 2;
    while (HEX_DIGIT.test(at(end))) end++;
    if (end === start + 2) throw new TdsSqlError(102, "Incorrect syntax near '0x'.", { pos: start });
    return { end, numberType: "binary" };
  }
  let end = start;
  while (DIGIT.test(at(end))) end++;
  let decimal = false;
  if (at(end) === "." && DIGIT.test(at(end + 1))) {
    decimal = true;
    end++;
    while (DIGIT.test(at(end))) end++;
  }
  let float = false;
  if (at(end) === "e" || at(end) === "E") {
    const signed = at(end + 1) === "+" || at(end + 1) === "-";
    if (DIGIT.test(at(end + (signed ? 2 : 1)))) {
      float = true;
      end += signed ? 2 : 1;
      while (DIGIT.test(at(end))) end++;
    }
  }
  if (float) return { end, numberType: "float" };
  if (decimal) return { end, numberType: "decimal" };
  // Integer literals widen like SQL Server: int, then bigint, then numeric.
  const value = BigInt(sql.slice(start, end));
  if (value <= 2147483647n) return { end, numberType: "int" };
  if (value <= 9223372036854775807n) return { end, numberType: "bigint" };
  return { end, numberType: "decimal" };
}

// GO must stand alone on its line: only blanks before it, and after it an optional
// repeat count, blanks and an optional -- comment. Returns { end, count } or null.
function batchSeparatorAt(sql, start, end) {
  let k = start - 1;
  while (k >= 0 && (sql[k] === " " || sql[k] === "\t" || sql[k] === "\r")) k--;
  if (k >= 0 && sql[k] !== "\n") return null;
  const skipBlanks = (j) => {
    let m = j;
    while (sql[m] === " " || sql[m] === "\t" || sql[m] === "\r") m++;
    return m;
  };
  let m = skipBlanks(end);
  let count = 1;
  let stop = end;
  if (DIGIT.test(sql[m] ?? "")) {
    let d = m;
    while (DIGIT.test(sql[d] ?? "")) d++;
    count = Number(sql.slice(m, d));
    stop = d;
    m = skipBlanks(d);
  }
  const atLineEnd = m >= sql.length || sql[m] === "\n" || (sql[m] === "-" && sql[m + 1] === "-");
  return atLineEnd ? { end: stop, count } : null;
}

// ---- parser

const peek = (s, k = 0) => s.tokens[s.pos + k];
const advance = (s) => s.tokens[s.pos++];
const isKeyword = (tok, value) => tok?.type === "keyword" && tok.value === value;
const isPunct = (tok, value) => tok?.type === "punct" && tok.value === value;
const isOperator = (tok, value) => tok?.type === "operator" && tok.value === value;
const isWord = (tok, value) => tok?.type === "identifier" && tok.quoting === "none" && tok.value.toUpperCase() === value;

function syntaxError(tok) {
  if (!tok) return new TdsSqlError(102, "Incorrect syntax near the end of the statement.");
  return new TdsSqlError(102, `Incorrect syntax near '${tok.raw}'.`, { pos: tok.pos, line: tok.line });
}

function expectPunct(s, value) {
  if (!isPunct(peek(s), value)) throw syntaxError(peek(s));
  return advance(s);
}

function expectKeyword(s, value) {
  if (!isKeyword(peek(s), value)) throw syntaxError(peek(s));
  return advance(s);
}

function bindingPower(tok) {
  if (!tok) return null;
  if (tok.type === "operator") return OPERATOR_BP.get(tok.value) ?? null;
  if (tok.type !== "keyword") return null;
  if (tok.value === "AND") return BP.AND;
  if (tok.value === "OR") return BP.OR;
  if (tok.value === "IS" || PREDICATE_KEYWORDS.has(tok.value)) return BP.PREDICATE;
  return null;
}

// NOT is infix only when it negates a following IN, LIKE or BETWEEN.
function infixBindingPower(s) {
  const tok = peek(s);
  if (isKeyword(tok, "NOT")) {
    const next = peek(s, 1);
    return next?.type === "keyword" && PREDICATE_KEYWORDS.has(next.value) ? BP.PREDICATE : null;
  }
  return bindingPower(tok);
}

function parseBinding(s, minBp, ctx) {
  let left = parsePrefix(s, ctx);
  for (;;) {
    const bp = infixBindingPower(s);
    if (bp === null || bp <= minBp) return left;
    left = parseInfix(s, left, ctx);
  }
}

function parsePrefix(s, ctx) {
  const tok = peek(s);
  if (isKeyword(tok, "NOT")) {
    advance(s);
    return { type: "Unary", operator: "NOT", operand: parseBinding(s, BP.NOT, ctx) };
  }
  if (isOperator(tok, "-") || isOperator(tok, "+")) {
    advance(s);
    return { type: "Unary", operator: tok.value, operand: parseBinding(s, BP.UNARY_SIGN, ctx) };
  }
  if (isOperator(tok, "~")) {
    advance(s);
    return { type: "Unary", operator: "~", operand: parseBinding(s, BP.UNARY_TILDE, ctx) };
  }
  return parsePrimary(s, ctx);
}

function parseInfix(s, left, ctx) {
  const tok = advance(s);
  if (tok.type === "operator" || isKeyword(tok, "AND") || isKeyword(tok, "OR")) {
    const right = parseBinding(s, bindingPower(tok), ctx);
    return { type: "Binary", operator: tok.value, left, right };
  }
  if (isKeyword(tok, "IS")) {
    const negated = isKeyword(peek(s), "NOT");
    if (negated) advance(s);
    expectKeyword(s, "NULL");
    return { type: "IsNull", operand: left, negated };
  }
  let negated = false;
  let kw = tok;
  if (isKeyword(tok, "NOT")) {
    negated = true;
    kw = advance(s);
  }
  if (kw.value === "IN") {
    expectPunct(s, "(");
    if (isKeyword(peek(s), "SELECT")) {
      const subquery = parseSubqueryHere(s, ctx);
      expectPunct(s, ")");
      return { type: "In", operand: left, negated, list: null, subquery };
    }
    const list = [];
    do {
      list.push(parseBinding(s, 0, ctx));
    } while (eatPunct(s, ","));
    expectPunct(s, ")");
    return { type: "In", operand: left, negated, list, subquery: null };
  }
  if (kw.value === "LIKE") {
    const pattern = parseBinding(s, BP.PREDICATE, ctx);
    let escape = null;
    if (isWord(peek(s), "ESCAPE")) {
      advance(s);
      escape = parseBinding(s, BP.PREDICATE, ctx);
    }
    return { type: "Like", operand: left, negated, pattern, escape };
  }
  // BETWEEN: the bounds stop before AND so that "x BETWEEN 1 AND 2 AND y" splits correctly.
  const low = parseBinding(s, BP.AND, ctx);
  expectKeyword(s, "AND");
  const high = parseBinding(s, BP.AND, ctx);
  return { type: "Between", operand: left, negated, low, high };
}

function eatPunct(s, value) {
  if (!isPunct(peek(s), value)) return false;
  advance(s);
  return true;
}

function parsePrimary(s, ctx) {
  const tok = peek(s);
  if (!tok) throw syntaxError(null);
  switch (tok.type) {
    case "number":
      advance(s);
      if (tok.numberType === "binary") return { type: "Literal", kind: "binary", text: tok.value };
      return { type: "Literal", kind: "number", numberType: tok.numberType, text: tok.value };
    case "string":
      advance(s);
      return { type: "Literal", kind: "string", value: tok.value, national: tok.national };
    case "variable":
      advance(s);
      return { type: "Variable", name: tok.value };
    case "globalVariable":
      advance(s);
      return { type: "GlobalVariable", name: tok.value };
    case "identifier":
      return parseIdentifierExpression(s, ctx);
    case "punct":
      if (tok.value !== "(") throw syntaxError(tok);
      advance(s);
      if (isKeyword(peek(s), "SELECT")) {
        const query = parseSubqueryHere(s, ctx);
        expectPunct(s, ")");
        return { type: "Subquery", query };
      }
      {
        const inner = parseBinding(s, 0, ctx);
        expectPunct(s, ")");
        return inner;
      }
    case "keyword":
      return parseKeywordExpression(s, ctx, tok);
    default:
      throw syntaxError(tok);
  }
}

function parseKeywordExpression(s, ctx, tok) {
  if (tok.value === "NULL") {
    advance(s);
    return { type: "Literal", kind: "null" };
  }
  if (tok.value === "CASE") return parseCase(s, ctx);
  if (tok.value === "EXISTS") {
    advance(s);
    expectPunct(s, "(");
    const subquery = parseSubqueryHere(s, ctx);
    expectPunct(s, ")");
    return { type: "Exists", subquery };
  }
  if (FUNCTION_KEYWORDS.has(tok.value) && isPunct(peek(s, 1), "(")) {
    advance(s);
    return parseCall(s, ctx, tok.value);
  }
  throw syntaxError(tok);
}

function parseSubqueryHere(s, ctx) {
  const tok = peek(s);
  if (!isKeyword(tok, "SELECT")) throw syntaxError(tok);
  if (typeof ctx.parseSubquery !== "function") {
    throw new TdsSqlError(102, "Subqueries are not supported in this expression.", { pos: tok.pos, line: tok.line, unsupported: true });
  }
  return ctx.parseSubquery(s);
}

function parseIdentifierExpression(s, ctx) {
  const first = advance(s);
  if (first.quoting === "none" && isPunct(peek(s), "(")) {
    const upper = first.value.toUpperCase();
    if (upper === "CAST" || upper === "TRY_CAST") return parseCast(s, ctx, upper === "TRY_CAST");
    if (upper === "CONVERT" || upper === "TRY_CONVERT") return parseConvert(s, ctx, upper === "TRY_CONVERT");
    return parseCall(s, ctx, first.value);
  }
  const parts = [first.value];
  while (parts.length < 4 && isPunct(peek(s), ".") && peek(s, 1)?.type === "identifier") {
    advance(s);
    parts.push(advance(s).value);
  }
  return { type: "ColumnRef", parts };
}

// A predicate (WHERE, HAVING, ON, searched CASE WHEN) must be boolean-valued. A bare column, literal or
// arithmetic expression is error 4145; "near" names the token after the expression.
const PREDICATE_OPS = new Set(["=", "<>", "!=", "<", ">", "<=", ">=", "!<", "!>", "AND", "OR"]);
const PREDICATE_NODES = new Set(["IsNull", "In", "Between", "Like", "Exists", "Quantified"]);
export function checkPredicate(s, node) {
  const boolean = node.type === "Unary" ? node.operator === "NOT"
    : node.type === "Binary" ? PREDICATE_OPS.has(node.operator)
      : PREDICATE_NODES.has(node.type) || (node.type === "FunctionCall" && /^(CONTAINS|FREETEXT)$/i.test(node.name));
  if (boolean) return node;
  const tok = s.tokens[s.pos] ?? s.tokens[s.pos - 1];
  throw new TdsSqlError(4145, `An expression of non-boolean type specified in a context where a condition is expected, near '${tok?.raw ?? ""}'.`, {
    pos: tok?.pos ?? null, line: tok?.line ?? null,
  });
}

function parseCase(s, ctx) {
  advance(s);
  const operand = isKeyword(peek(s), "WHEN") ? null : parseBinding(s, 0, ctx);
  const whens = [];
  while (isKeyword(peek(s), "WHEN")) {
    advance(s);
    const when = operand === null ? checkPredicate(s, parseBinding(s, 0, ctx)) : parseBinding(s, 0, ctx);
    expectKeyword(s, "THEN");
    whens.push({ when, then: parseBinding(s, 0, ctx) });
  }
  if (whens.length === 0) throw syntaxError(peek(s));
  let elseExpr = null;
  if (isKeyword(peek(s), "ELSE")) {
    advance(s);
    elseExpr = parseBinding(s, 0, ctx);
  }
  expectKeyword(s, "END");
  return { type: "Case", operand, whens, elseExpr };
}

function parseCast(s, ctx, tryCast) {
  expectPunct(s, "(");
  const operand = parseBinding(s, 0, ctx);
  expectKeyword(s, "AS");
  const targetType = parseTypeSpec(s);
  expectPunct(s, ")");
  return { type: "Cast", operand, targetType, tryCast };
}

function parseConvert(s, ctx, tryConvert) {
  expectPunct(s, "(");
  const targetType = parseTypeSpec(s);
  expectPunct(s, ",");
  const operand = parseBinding(s, 0, ctx);
  const style = eatPunct(s, ",") ? parseBinding(s, 0, ctx) : null;
  expectPunct(s, ")");
  return { type: "Convert", targetType, operand, style, tryConvert };
}

function parseTypeSpec(s) {
  const tok = advance(s);
  if (tok?.type !== "identifier") throw syntaxError(tok);
  const name = tok.value.toUpperCase();
  if (!TYPE_NAMES.has(name)) throw new TdsSqlError(2715, `Cannot find data type ${tok.value}.`, { pos: tok.pos, line: tok.line });
  let length = null;
  let scale = null;
  if (eatPunct(s, "(")) {
    const first = advance(s);
    length = isWord(first, "MAX") ? "MAX" : intLiteral(first);
    if (eatPunct(s, ",")) scale = intLiteral(advance(s));
    expectPunct(s, ")");
  }
  return { name, length, scale };
}

function intLiteral(tok) {
  if (tok?.type !== "number" || tok.numberType !== "int") throw syntaxError(tok);
  return Number(tok.value);
}

// Name already consumed; the next token is "(".
function parseCall(s, ctx, name) {
  expectPunct(s, "(");
  const upper = name.toUpperCase();
  if (isOperator(peek(s), "*")) {
    if (upper !== "COUNT" && upper !== "COUNT_BIG") throw syntaxError(peek(s));
    advance(s);
    expectPunct(s, ")");
    return finishCall(s, ctx, { type: "FunctionCall", name, distinct: false, star: true, args: [] });
  }
  let distinct = false;
  if (isKeyword(peek(s), "DISTINCT")) {
    if (!AGGREGATES.has(upper)) throw syntaxError(peek(s));
    advance(s);
    distinct = true;
  }
  const args = [];
  if (!isPunct(peek(s), ")")) {
    do {
      args.push(parseBinding(s, 0, ctx));
    } while (eatPunct(s, ","));
  }
  expectPunct(s, ")");
  return finishCall(s, ctx, { type: "FunctionCall", name, distinct, star: false, args });
}

// Window functions are not supported on the Dataverse endpoint (no OVER clause).
// The only ordered-set form supported is STRING_AGG(expr, sep) WITHIN GROUP (ORDER BY ...).
function finishCall(s, ctx, node) {
  const tok = peek(s);
  if (isKeyword(tok, "OVER")) {
    throw new TdsSqlError(102, "The OVER clause is not supported by the Dataverse SQL endpoint.", { pos: tok.pos, line: tok.line, unsupported: true });
  }
  if (isWord(tok, "WITHIN") && isKeyword(peek(s, 1), "GROUP")) {
    if (node.name.toUpperCase() !== "STRING_AGG") throw syntaxError(tok);
    advance(s);
    advance(s);
    expectPunct(s, "(");
    expectKeyword(s, "ORDER");
    expectKeyword(s, "BY");
    const withinGroup = [];
    do {
      const expr = parseBinding(s, 0, ctx);
      const direction = isKeyword(peek(s), "ASC") || isKeyword(peek(s), "DESC") ? advance(s).value : null;
      withinGroup.push({ expr, direction });
    } while (eatPunct(s, ","));
    expectPunct(s, ")");
    node.withinGroup = withinGroup;
  }
  return node;
}
