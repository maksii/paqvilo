// Read-only Cosmos SQL subset for ExecuteCosmosSqlQuery. No JavaScript evaluation, SQL engine or external connection.
// Supports scalar JSON paths, typed parameters, boolean/comparison/arithmetic expressions, IN, projections,
// DISTINCT, TOP, ORDER BY and OFFSET/LIMIT. Joins, subqueries, user functions and aggregates are explicitly refused.
import { DataError } from "./data-error.mjs";

const invalid = (message) => new DataError(message, 400, "InvalidRequest", { innerCode: "0x80040203" });
const unsupported = () => new DataError("This Cosmos SQL expression is not simulated.", 501, "NotImplemented", { innerCode: "0x80040216" });
const own = (object, key) => object != null && Object.hasOwn(Object(object), key) ? object[key] : undefined;
const PRECEDENCE = { OR: 1, AND: 2, "=": 3, "!=": 3, "<>": 3, "<": 3, "<=": 3, ">": 3, ">=": 3, IN: 3, "+": 4, "-": 4, "*": 5, "/": 5, "%": 5 };
const FUNCTIONS = {
  IS_DEFINED: (value) => value !== undefined,
  IS_NULL: (value) => value === null,
  IS_NUMBER: (value) => typeof value === "number",
  IS_STRING: (value) => typeof value === "string",
  IS_BOOL: (value) => typeof value === "boolean",
  IS_ARRAY: Array.isArray,
  IS_OBJECT: (value) => value !== null && typeof value === "object" && !Array.isArray(value),
  CONTAINS: (value, search, insensitive = false) => typeof value === "string" && typeof search === "string" && (insensitive ? value.toLowerCase().includes(search.toLowerCase()) : value.includes(search)),
  STARTSWITH: (value, search) => typeof value === "string" && typeof search === "string" && value.startsWith(search),
  ENDSWITH: (value, search) => typeof value === "string" && typeof search === "string" && value.endsWith(search),
  LOWER: (value) => typeof value === "string" ? value.toLowerCase() : undefined,
  UPPER: (value) => typeof value === "string" ? value.toUpperCase() : undefined,
  LENGTH: (value) => typeof value === "string" ? value.length : undefined,
  ARRAY_LENGTH: (value) => Array.isArray(value) ? value.length : undefined,
  ARRAY_CONTAINS: (value, search) => Array.isArray(value) && value.some((item) => JSON.stringify(item) === JSON.stringify(search)),
  ABS: (value) => typeof value === "number" ? Math.abs(value) : undefined,
  CEILING: (value) => typeof value === "number" ? Math.ceil(value) : undefined,
  FLOOR: (value) => typeof value === "number" ? Math.floor(value) : undefined,
};

function tokensOf(text) {
  const tokens = [];
  let at = 0;
  while (at < text.length) {
    const rest = text.slice(at);
    const whitespace = /^\s+/.exec(rest);
    if (whitespace) { at += whitespace[0].length; continue; }
    const match = /^(?:'((?:''|[^'])*)'|"((?:\\.|[^"\\])*)"|(@[a-zA-Z_][\w]*)|(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([a-zA-Z_][\w]*)|(!=|<>|<=|>=|[=<>+*/%(),.\[\]-]))/.exec(rest);
    if (!match) throw invalid("Invalid Cosmos SQL syntax.");
    at += match[0].length;
    if (match[1] !== undefined) tokens.push({ type: "literal", value: match[1].replaceAll("''", "'") });
    else if (match[2] !== undefined) {
      try { tokens.push({ type: "literal", value: JSON.parse(`"${match[2]}"`) }); }
      catch { throw invalid("Invalid Cosmos SQL string."); }
    } else if (match[3]) tokens.push({ type: "parameter", value: match[3] });
    else if (match[4]) tokens.push({ type: "literal", value: Number(match[4]) });
    else tokens.push({ type: match[5] ? "word" : "symbol", value: match[5] ?? match[6] });
    if (tokens.length > 10000) throw invalid("Cosmos SQL query is too complex.");
  }
  return tokens;
}

export function cosmosParameters(collection) {
  if (collection == null) return {};
  if (!Array.isArray(collection.Keys) || !Array.isArray(collection.Values) || collection.Keys.length !== collection.Values.length)
    throw invalid("QueryParameters must have matching Keys and Values collections.");
  const params = Object.create(null);
  collection.Keys.forEach((key, index) => {
    if (typeof key !== "string" || !/^@[A-Za-z_]\w*$/.test(key) || Object.hasOwn(params, key)) throw invalid("Invalid query parameter name.");
    const typed = collection.Values[index];
    const value = typed?.Value;
    const type = typed?.Type;
    if (value == null) { params[key] = null; return; }
    if (["System.String", "System.Guid", "System.DateTime"].includes(type)) params[key] = String(value);
    else if (["System.Int16", "System.Int32", "System.Int64", "System.Decimal", "System.Double", "System.Single"].includes(type)) {
      if (String(value).trim() === "" || !Number.isFinite(Number(value))) throw invalid(`Invalid numeric query parameter ${key}.`);
      params[key] = Number(value);
    } else if (type === "System.Boolean") {
      if (![true, false, "true", "false"].includes(value)) throw invalid(`Invalid boolean query parameter ${key}.`);
      params[key] = value === true || value === "true";
    } else throw unsupported();
  });
  return params;
}

export function compileCosmosQuery(text, parameters = {}) {
  if (typeof text !== "string" || !text.trim()) throw invalid("QueryText is required.");
  const tokens = tokensOf(text);
  let position = 0, depth = 0;
  const peek = (value) => String(tokens[position]?.value).toUpperCase() === value;
  const take = (value) => { if (peek(value)) { position++; return true; } return false; };
  const expect = (value) => { if (!take(value)) throw invalid(`Expected ${value} in Cosmos SQL query.`); };
  const name = () => { const token = tokens[position++]; if (token?.type !== "word") throw invalid("Expected a name in Cosmos SQL query."); return token.value; };
  const integer = () => { const token = tokens[position++]; if (token?.type !== "literal" || !Number.isSafeInteger(token.value) || token.value < 0) throw invalid("Expected a non-negative integer in Cosmos SQL query."); return token.value; };
  const expression = (minimum = 0) => {
    if (++depth > 64) throw invalid("Cosmos SQL expression is too deeply nested.");
    let left;
    if (take("NOT")) left = { unary: "NOT", value: expression(6) };
    else if (take("-")) left = { unary: "-", value: expression(6) };
    else if (take("(")) { left = expression(); expect(")"); }
    else {
      const token = tokens[position++];
      if (!token) throw invalid("Incomplete Cosmos SQL expression.");
      if (token.type === "literal") left = { literal: token.value };
      else if (token.type === "parameter") {
        if (!Object.hasOwn(parameters, token.value)) throw invalid(`Missing query parameter ${token.value}.`);
        left = { literal: parameters[token.value] };
      } else if (token.type === "word") {
        const upper = token.value.toUpperCase();
        if (["TRUE", "FALSE", "NULL"].includes(upper)) left = { literal: upper === "NULL" ? null : upper === "TRUE" };
        else if (take("(")) {
          if (!Object.hasOwn(FUNCTIONS, upper)) throw unsupported();
          const args = [];
          if (!take(")")) { do { args.push(expression()); } while (take(",")); expect(")"); }
          left = { call: upper, args };
        } else {
          const path = [token.value];
          while (peek(".") || peek("[")) {
            if (take(".")) path.push(name());
            else { expect("["); const key = tokens[position++]; if (key?.type !== "literal" || !["string", "number"].includes(typeof key.value)) throw invalid("Invalid JSON path."); path.push(key.value); expect("]"); }
          }
          left = { path };
        }
      } else throw unsupported();
    }
    while (position < tokens.length) {
      const operator = String(tokens[position].value).toUpperCase();
      const precedence = PRECEDENCE[operator];
      if (precedence === undefined || precedence < minimum) break;
      position++;
      if (operator === "IN") {
        const values = []; expect("("); do { values.push(expression(4)); } while (take(",")); expect(")");
        left = { operator, left, values };
      } else left = { operator, left, right: expression(precedence + 1) };
    }
    depth--;
    return left;
  };
  expect("SELECT");
  const distinct = take("DISTINCT");
  const top = take("TOP") ? integer() : null;
  const scalar = take("VALUE");
  const star = take("*");
  const selections = [];
  if (!star) {
    do {
      const value = expression();
      const alias = take("AS") ? name() : value.path?.at(-1) ?? `$${selections.length + 1}`;
      selections.push({ value, alias });
      if (scalar) break;
    } while (take(","));
  }
  expect("FROM");
  const root = name();
  const where = take("WHERE") ? expression() : null;
  const order = [];
  if (take("ORDER")) {
    expect("BY");
    do { const value = expression(); const descending = take("DESC"); if (!descending) take("ASC"); order.push({ value, descending }); } while (take(","));
  }
  let offset = 0, limit = null;
  if (take("OFFSET")) { offset = integer(); expect("LIMIT"); limit = integer(); }
  if (position !== tokens.length) throw unsupported();
  const assertAliases = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.path && node.path[0] !== root) throw invalid("Unknown Cosmos SQL document alias.");
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(assertAliases);
      else if (value && typeof value === "object") assertAliases(value);
    }
  };
  selections.forEach(({ value }) => assertAliases(value));
  assertAliases(where);
  order.forEach(({ value }) => assertAliases(value));
  const evaluate = (node, document) => {
    if (Object.hasOwn(node, "literal")) return node.literal;
    if (node.path) { if (node.path[0] !== root) throw invalid("Unknown Cosmos SQL document alias."); return node.path.slice(1).reduce(own, document); }
    if (node.call) return FUNCTIONS[node.call](...node.args.map((arg) => evaluate(arg, document)));
    if (node.unary) { const value = evaluate(node.value, document); return node.unary === "NOT" ? typeof value === "boolean" ? !value : undefined : typeof value === "number" ? -value : undefined; }
    const left = evaluate(node.left, document);
    if (node.operator === "IN") return left !== undefined && node.values.some((item) => left === evaluate(item, document));
    const right = evaluate(node.right, document);
    if (node.operator === "AND") return left === true && right === true;
    if (node.operator === "OR") return left === true || right === true;
    if (left === undefined || right === undefined || typeof left !== typeof right) return undefined;
    switch (node.operator) {
      case "=": return left === right;
      case "!=": case "<>": return left !== right;
      case "<": return left < right;
      case "<=": return left <= right;
      case ">": return left > right;
      case ">=": return left >= right;
      case "+": return typeof left === "number" ? left + right : undefined;
      case "-": return typeof left === "number" ? left - right : undefined;
      case "*": return typeof left === "number" ? left * right : undefined;
      case "/": return typeof left === "number" && right !== 0 ? left / right : undefined;
      case "%": return typeof left === "number" && right !== 0 ? left % right : undefined;
      default: throw unsupported();
    }
  };
  // The JSON paths the query compares (WHERE and ORDER BY), for the caller's column-security operand rule.
  const operands = [];
  const collect = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.path) operands.push(node.path);
    for (const value of Object.values(node)) if (value && typeof value === "object") (Array.isArray(value) ? value : [value]).forEach(collect);
  };
  collect(where);
  order.forEach(({ value }) => collect(value));
  const run = (documents) => {
    let rows = documents.filter((document) => !where || evaluate(where, document) === true);
    if (order.length) rows.sort((left, right) => {
      for (const item of order) {
        const a = evaluate(item.value, left), b = evaluate(item.value, right);
        const compared = a === b ? 0 : a == null ? -1 : b == null ? 1 : a < b ? -1 : 1;
        if (compared) return item.descending ? -compared : compared;
      }
      return 0;
    });
    rows = rows.map((document) => star ? document : scalar ? evaluate(selections[0].value, document)
      : Object.fromEntries(selections.map(({ alias, value }) => [alias, evaluate(value, document)]).filter(([, value]) => value !== undefined)));
    if (distinct) { const seen = new Set(); rows = rows.filter((row) => { const key = JSON.stringify(row); if (seen.has(key)) return false; seen.add(key); return true; }); }
    if (top != null) rows = rows.slice(0, top);
    return rows.slice(offset, limit == null ? undefined : offset + limit);
  };
  run.operands = operands;
  return run;
}
