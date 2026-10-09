// OData query parsing and evaluation for the local Dataverse store.
// Dialect "dataverse" accepts only what the Dataverse Web API documents;
// dialect "extended" keeps the simulator's internal convenience functions
// (tolower, length, OData 4.01 "in") for plugin predicates and admin reads.
import { DataError } from "./data-error.mjs";
import {
  CRM_FUNCTIONS,
  compileOperator,
  stringFunctionMatcher,
} from "./dataverse-conditions.mjs";
import {
  compareForFilter,
  compareSortKeys,
  fieldKind,
  guidKey,
  looksLikeDate,
  makeSortKey,
  own,
  parseDateValue,
  scalar,
  sqlGuidSortKey,
  valuesEqual,
} from "./dataverse-values.mjs";

export const ODATA_LIMITS = Object.freeze({
  navigationDepth: 32,
  conditions: 500,
  aggregateRecords: 50000,
  expandDepth: 10,
});
export const ODATA_COMPARISON = new Set(["eq", "ne", "gt", "ge", "lt", "le"]);
export const ODATA_STRING_FUNCTIONS = new Set(["contains", "startswith", "endswith"]);
export const ODATA_EXTENDED_FUNCTIONS = new Set([
  "tolower", "toupper", "trim", "length", "concat", "substring", "year", "month", "day",
]);
// Dataverse documents sum/average/min/max and $count; distinct counting is
// explicitly unavailable through OData ("Get distinct number with CountColumn").
export const ODATA_APPLY_METHODS = new Set(["sum", "average", "min", "max"]);
export const ODATA_QUERY_OPTIONS = new Set([
  "$filter", "$select", "$expand", "$orderby", "$top", "$skip", "$count", "$apply",
]);

const fail = (message, status = 400, code = "InvalidQuery", details) => {
  throw new DataError(message, status, code, details);
};
const unsupported = (message) => fail(message, 400, "UnsupportedQuery");

// ---------------------------------------------------------------------------
// Tokenizer
const TOKEN = new RegExp(
  [
    "(?<string>'(?:[^']|'')*')",
    '(?<dstring>"(?:[^"\\\\]|\\\\.)*")',
    "(?<guid>[\\da-fA-F]{8}-[\\da-fA-F]{4}-[\\da-fA-F]{4}-[\\da-fA-F]{4}-[\\da-fA-F]{12}(?![\\w-]))",
    "(?<datetime>\\d{4}-\\d{2}-\\d{2}(?:T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?(?:Z|[+-]\\d{2}:\\d{2})?)?(?![\\w:-]))",
    "(?<number>-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?[mMdDfFlL]?(?![\\w]))",
    "(?<alias>@[A-Za-z_]\\w*)",
    "(?<ident>[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_][\\w]*)*)",
    "(?<punct>[()/,:=\\[\\]])",
  ].join("|"),
  "y",
);
function tokenize(source) {
  const tokens = [];
  const text = String(source);
  let index = 0;
  while (index < text.length) {
    if (/\s/.test(text[index])) {
      index++;
      continue;
    }
    TOKEN.lastIndex = index;
    const match = TOKEN.exec(text);
    if (!match)
      unsupported(`Unsupported OData filter near ${text.slice(index, index + 50)}`);
    const [kind, value] = Object.entries(match.groups).find(([, v]) => v !== undefined);
    tokens.push({ kind, value, at: index });
    index = TOKEN.lastIndex;
  }
  return tokens;
}

const KEYWORDS = new Set(["and", "or", "not", "eq", "ne", "gt", "ge", "lt", "le", "in", "null", "true", "false", "has", "add", "sub", "mul", "div", "mod"]);

/** Parse an OData expression into an AST. */
export function parseODataExpression(source, { dialect = "dataverse", aliases = {} } = {}) {
  const tokens = tokenize(source);
  let pos = 0;
  let conditions = 0;
  const peek = (offset = 0) => tokens[pos + offset];
  const peekWord = (offset = 0) => {
    const token = peek(offset);
    return token?.kind === "ident" ? token.value.toLowerCase() : token?.value;
  };
  const take = () => tokens[pos++];
  const expect = (value) => {
    const token = take();
    if (!token || token.value !== value)
      unsupported(`Malformed OData expression: expected '${value}' near ${token?.value ?? "end of input"}`);
    return token;
  };
  const literalFromToken = (token) => {
    switch (token.kind) {
      case "string":
        return { type: "literal", kind: "string", value: token.value.slice(1, -1).replace(/''/g, "'") };
      case "dstring":
        return { type: "literal", kind: "string", value: JSON.parse(token.value) };
      case "guid":
        return { type: "literal", kind: "guid", value: token.value.toLowerCase() };
      case "datetime":
        return { type: "literal", kind: "datetime", value: token.value };
      case "number":
        return { type: "literal", kind: "number", value: Number(token.value.replace(/[mdflMDFL]$/, "")) };
      default:
        return null;
    }
  };
  const resolveAlias = (token) => {
    const raw = aliases[token.value];
    if (raw == null) fail(`Parameter alias ${token.value} is not defined.`);
    const parsed = parseODataExpression(raw, { dialect, aliases: {} });
    if (parsed.type !== "literal" && parsed.type !== "array")
      fail(`Parameter alias ${token.value} must be a literal value.`);
    return parsed;
  };
  const arrayLiteral = () => {
    expect("[");
    const items = [];
    if (peek()?.value !== "]") {
      do {
        const token = take();
        const literal = token && (literalFromToken(token) ?? (token.kind === "ident" && ["true", "false", "null"].includes(token.value.toLowerCase()) ? { type: "literal", kind: "keyword", value: { true: true, false: false, null: null }[token.value.toLowerCase()] } : null));
        if (!literal) unsupported("OData array values must be literals");
        items.push(literal.value);
        if (peek()?.value !== ",") break;
        take();
      } while (true);
    }
    expect("]");
    return { type: "array", values: items };
  };
  const pathSegments = (first) => {
    const segments = [first];
    while (peek()?.value === "/" && peek(1)?.kind === "ident") {
      const next = peek(1).value;
      if (["any", "all"].includes(next.toLowerCase()) && peek(2)?.value === "(") break;
      take();
      segments.push(take().value);
    }
    return segments;
  };
  const lambda = (segments) => {
    take(); // '/'
    const kind = take().value.toLowerCase();
    expect("(");
    if (peek()?.value === ")") {
      take();
      if (kind === "all") unsupported("The all lambda operator requires a predicate");
      return { type: "lambda", kind, path: segments, variable: null, body: null };
    }
    const variable = take();
    if (variable?.kind !== "ident") unsupported("Malformed lambda expression");
    expect(":");
    const body = or();
    expect(")");
    return { type: "lambda", kind, path: segments, variable: variable.value, body };
  };
  const functionCall = (name) => {
    expect("(");
    const lower = name.toLowerCase();
    if (/^microsoft\.dynamics\.crm\./i.test(name)) {
      const short = name.split(".").at(-1);
      const definition = Object.entries(CRM_FUNCTIONS).find(([key]) => key.toLowerCase() === short.toLowerCase());
      if (!definition) unsupported(`Unsupported Dataverse query function ${name}`);
      const params = {};
      if (peek()?.value !== ")") {
        do {
          const key = take();
          if (key?.kind !== "ident") unsupported(`Malformed parameters for ${name}`);
          expect("=");
          let value;
          if (peek()?.value === "[") value = arrayLiteral();
          else {
            const token = take();
            if (token?.kind === "alias") value = resolveAlias(token);
            else value = token && literalFromToken(token);
            if (!value) unsupported(`Malformed parameter ${key.value} for ${name}`);
          }
          params[key.value] = value;
          if (peek()?.value !== ",") break;
          take();
        } while (true);
      }
      expect(")");
      conditions++;
      return { type: "crm", name: definition[0], operator: definition[1].operator, shape: definition[1].values, params };
    }
    const args = [];
    if (peek()?.value !== ")") {
      do {
        args.push(or());
        if (peek()?.value !== ",") break;
        take();
      } while (true);
    }
    expect(")");
    if (ODATA_STRING_FUNCTIONS.has(lower)) {
      if (args.length !== 2) unsupported(`The function ${name} requires two arguments`);
      conditions++;
      return { type: "string", name: lower, args };
    }
    if (dialect === "extended" && ODATA_EXTENDED_FUNCTIONS.has(lower)) return { type: "call", name: lower, args };
    unsupported(`Unsupported OData function ${name}`);
  };
  const primary = () => {
    const token = peek();
    if (!token) unsupported("Incomplete OData filter");
    if (token.value === "(") {
      take();
      const expression = or();
      expect(")");
      return expression;
    }
    if (token.value === "[") return arrayLiteral();
    if (token.kind === "alias") {
      take();
      return resolveAlias(token);
    }
    const literal = literalFromToken(token);
    if (literal) {
      take();
      return literal;
    }
    if (token.kind === "ident") {
      const lower = token.value.toLowerCase();
      if (["null", "true", "false"].includes(lower)) {
        take();
        return { type: "literal", kind: lower === "null" ? "null" : "boolean", value: { null: null, true: true, false: false }[lower] };
      }
      if (KEYWORDS.has(lower)) unsupported(`Unexpected OData keyword ${token.value}`);
      take();
      if (peek()?.value === "(") return functionCall(token.value);
      const segments = pathSegments(token.value);
      if (peek()?.value === "/" && ["any", "all"].includes(String(peek(1)?.value).toLowerCase())) {
        conditions++;
        return lambda(segments);
      }
      return { type: "path", segments };
    }
    unsupported(`Unsupported OData syntax near ${token.value}`);
  };
  const unary = () => {
    if (peekWord() === "not") {
      take();
      return { type: "not", operand: unary() };
    }
    return primary();
  };
  const compare = () => {
    const left = unary();
    const op = peekWord();
    if (ODATA_COMPARISON.has(op)) {
      take();
      conditions++;
      return { type: "compare", op, left, right: unary() };
    }
    if (op === "in") {
      if (dialect !== "extended")
        unsupported("The OData 'in' operator isn't supported by the Dataverse Web API; use Microsoft.Dynamics.CRM.In.");
      take();
      expect("(");
      const values = [];
      do {
        values.push(unary());
        if (peek()?.value !== ",") break;
        take();
      } while (true);
      expect(")");
      conditions++;
      return { type: "in", left, values };
    }
    if (["has", "add", "sub", "mul", "div", "mod"].includes(op))
      unsupported(`The OData operator ${op} isn't supported by the Dataverse Web API.`);
    return left;
  };
  const and = () => {
    let left = compare();
    while (peekWord() === "and") {
      take();
      left = { type: "and", left, right: compare() };
    }
    return left;
  };
  function or() {
    let left = and();
    while (peekWord() === "or") {
      take();
      left = { type: "or", left, right: and() };
    }
    return left;
  }
  if (!tokens.length) return { type: "literal", kind: "boolean", value: true };
  const result = or();
  if (pos !== tokens.length)
    unsupported(`Unsupported OData syntax: ${tokens.slice(pos).map((t) => t.value).join(" ")}`);
  if (conditions > ODATA_LIMITS.conditions)
    fail("Number of conditions in query exceeded maximum limit.", 400, "UnsupportedQuery", { innerCode: "0x8004430c" });
  return result;
}

/** Every property path an expression reads, with lambda paths qualified from the root. */
export function expressionPaths(ast, prefix = [], variables = new Map()) {
  const out = [];
  const visit = (node, scope) => {
    if (!node || typeof node !== "object") return;
    switch (node.type) {
      case "path": {
        const [head, ...rest] = node.segments;
        if (scope.has(head)) {
          if (rest.length) out.push([...scope.get(head), ...rest]);
        } else out.push([...prefix, ...node.segments]);
        break;
      }
      case "lambda": {
        const [head, ...rest] = node.path;
        const base = scope.has(head) ? [...scope.get(head), ...rest] : [...prefix, ...node.path];
        out.push(base);
        if (node.body) visit(node.body, new Map([...scope, [node.variable, base]]));
        break;
      }
      case "crm": {
        const name = node.params.PropertyName;
        if (name?.type === "literal" && typeof name.value === "string")
          out.push([...prefix, ...String(name.value).split("/")]);
        break;
      }
      default:
        for (const key of ["left", "right", "operand", "body"]) if (node[key]) visit(node[key], scope);
        for (const list of [node.args, node.values]) if (Array.isArray(list)) list.forEach((item) => visit(item, scope));
    }
  };
  visit(ast, variables);
  return out;
}

// ---------------------------------------------------------------------------
// Evaluation

/** Read a column value; supports _lookup_value aliases and stored lookups. */
export function columnValue(row, name) {
  if (row == null) return undefined;
  if (own(row, name)) return row[name];
  const lookup = /^_(.+)_value$/.exec(name);
  if (lookup && own(row, lookup[1])) return scalar(row[lookup[1]]);
  if (!lookup && own(row, `_${name}_value`)) return row[`_${name}_value`];
  return undefined;
}
const isEmpty = (value) => value == null || value === "" || (Array.isArray(value) && !value.length);

/**
 * Compile an AST into a predicate over store rows.
 * ctx: { mapping, navigate(mapping,row,name) -> {mapping,value,many}, definition(logical,attr), identity, settings, now }
 */
export function compileODataPredicate(ast, mapping, ctx) {
  const settings = ctx.settings ?? {};
  const options = (definition) => ({
    kind: fieldKind(definition) ?? undefined,
    collation: settings.collation ?? "CI_AI",
    timeZoneOffsetMinutes: Number(settings.timeZoneOffsetMinutes ?? 0),
  });
  // Resolve a path to { value, definition } for a row in scope.
  const resolvePath = (segments, row, rowMapping, scope, depth = 0) => {
    let [head, ...rest] = segments;
    let currentRow = row,
      currentMapping = rowMapping;
    if (scope.has(head)) {
      ({ row: currentRow, mapping: currentMapping } = scope.get(head));
      if (!rest.length) return { value: currentRow, definition: null, entity: true };
      [head, ...rest] = rest;
    }
    while (rest.length) {
      if (depth++ > ODATA_LIMITS.navigationDepth)
        unsupported(`OData navigation exceeds ${ODATA_LIMITS.navigationDepth} relationship levels`);
      const navigation = ctx.navigate(currentMapping, currentRow, head);
      if (!navigation) {
        if (ctx.dialect === "dataverse")
          fail(`Could not find a navigation property named '${head}' on ${currentMapping.logicalName}.`, 400, "InvalidAttribute");
        return { value: undefined, definition: null };
      }
      if (navigation.many)
        unsupported(`Collection-valued navigation property ${head} can only be filtered with any or all.`);
      currentRow = navigation.value;
      currentMapping = navigation.mapping;
      [head, ...rest] = rest;
      if (currentRow == null) return { value: undefined, definition: ctx.definition(currentMapping.logicalName, head) };
    }
    if (currentRow == null) return { value: undefined, definition: null };
    const nav = currentMapping.relationships?.[head];
    if (nav && !own(currentRow, head)) {
      const navigation = ctx.navigate(currentMapping, currentRow, head);
      if (navigation?.many)
        unsupported(`Collection-valued navigation property ${head} can only be filtered with any or all.`);
      // A single-valued navigation compares by the related record's key.
      const target = navigation?.value;
      return {
        value: target == null ? null : target[navigation.mapping.idColumn],
        definition: { dataverseType: "lookup" },
      };
    }
    return { value: columnValue(currentRow, head), definition: ctx.definition(currentMapping.logicalName, head) };
  };
  const collection = (segments, row, rowMapping, scope) => {
    let [head, ...rest] = segments;
    let currentRow = row,
      currentMapping = rowMapping;
    if (scope.has(head)) {
      ({ row: currentRow, mapping: currentMapping } = scope.get(head));
      [head, ...rest] = rest;
    }
    while (rest.length) {
      const navigation = ctx.navigate(currentMapping, currentRow, head);
      if (!navigation || navigation.many)
        unsupported("Lambda operators can't be applied to collections nested in another navigation property.");
      if (scope.size === 0 && ctx.dialect === "dataverse")
        unsupported(
          "Conditions on collection-valued navigation properties nested in a lookup navigation property aren't supported.",
        );
      currentRow = navigation.value;
      currentMapping = navigation.mapping;
      [head, ...rest] = rest;
      if (currentRow == null) return { rows: [], mapping: currentMapping };
    }
    const navigation = ctx.navigate(currentMapping, currentRow, head);
    if (!navigation) fail(`Could not find a navigation property named '${head}' on ${currentMapping.logicalName}.`, 400, "InvalidAttribute");
    if (!navigation.many) unsupported(`Lambda operators require a collection-valued navigation property; ${head} is single-valued.`);
    return { rows: navigation.value ?? [], mapping: navigation.mapping };
  };
  const boundPath = (segments) => {
    if (segments.length - 1 > ODATA_LIMITS.navigationDepth)
      unsupported(`OData navigation exceeds ${ODATA_LIMITS.navigationDepth} relationship levels`);
    return segments;
  };
  // $filter follows SQL three-valued logic, as Dataverse evaluates it: a predicate is
  // true, false or unknown (null). A null column read as a Boolean, and a comparison,
  // `in` or function with a null operand, are unknown; `not` keeps unknown; and/or
  // follow Kleene logic; only rows whose filter is true match.
  const truthOf = (value) => {
    const v = scalar(value);
    return isEmpty(v) ? null : Boolean(v);
  };
  const truth = (node) => {
    const fn = compile(node);
    return ["path", "literal", "call"].includes(node.type)
      ? (row, m, s) => truthOf(fn(row, m, s))
      : fn;
  };
  const compile = (node) => {
    switch (node.type) {
      case "literal":
        return () => node.value;
      case "array":
        return () => node.values;
      case "path":
        boundPath(node.segments);
        return (row, rowMapping, scope) => resolvePath(node.segments, row, rowMapping, scope).value;
      case "not": {
        // Three-valued logic: not of an unknown (null) operand stays unknown.
        if (node.operand.type === "path" && ctx.dialect === "dataverse") {
          return (row, rowMapping, scope) => {
            const resolved = resolvePath(node.operand.segments, row, rowMapping, scope);
            const kind = fieldKind(resolved.definition);
            if (kind && kind !== "boolean")
              fail(`A unary operator with an incompatible type was detected. Found operand type '${kind}' for operator kind 'Not'.`);
            const value = truthOf(resolved.value);
            return value == null ? null : !value;
          };
        }
        const operand = truth(node.operand);
        return (row, rowMapping, scope) => {
          const value = operand(row, rowMapping, scope);
          return value == null ? null : !value;
        };
      }
      case "and": {
        // Kleene conjunction: false wins, then unknown.
        const left = truth(node.left),
          right = truth(node.right);
        return (row, m, s) => {
          const a = left(row, m, s);
          if (a === false) return false;
          const b = right(row, m, s);
          if (b === false) return false;
          return a == null || b == null ? null : true;
        };
      }
      case "or": {
        // Kleene disjunction: true wins, then unknown.
        const left = truth(node.left),
          right = truth(node.right);
        return (row, m, s) => {
          const a = left(row, m, s);
          if (a === true) return true;
          const b = right(row, m, s);
          if (b === true) return true;
          return a == null || b == null ? null : false;
        };
      }
      case "compare": {
        for (const side of [node.left, node.right]) if (side.type === "path") boundPath(side.segments);
        const pathSide = node.left.type === "path" ? node.left : node.right.type === "path" ? node.right : null;
        const left = compile(node.left),
          right = compile(node.right);
        return (row, rowMapping, scope) => {
          let definition = null;
          let x, y;
          if (pathSide) {
            const resolvedLeft = node.left.type === "path" ? resolvePath(node.left.segments, row, rowMapping, scope) : null;
            const resolvedRight = node.right.type === "path" ? resolvePath(node.right.segments, row, rowMapping, scope) : null;
            x = resolvedLeft ? resolvedLeft.value : left(row, rowMapping, scope);
            y = resolvedRight ? resolvedRight.value : right(row, rowMapping, scope);
            definition = resolvedLeft?.definition ?? resolvedRight?.definition ?? null;
          } else {
            x = left(row, rowMapping, scope);
            y = right(row, rowMapping, scope);
          }
          // Literal operands are null only for the null keyword; stored empty
          // strings are null because Dataverse never stores empty text.
          const isNull = (operand, value) =>
            operand.type === "literal" ? operand.kind === "null" : isEmpty(scalar(value));
          const leftNull = isNull(node.left, x),
            rightNull = isNull(node.right, y);
          if (node.op === "eq" && (node.left.kind === "null" || node.right.kind === "null")) return leftNull && rightNull;
          if (node.op === "ne" && (node.left.kind === "null" || node.right.kind === "null")) return !(leftNull && rightNull);
          // SQL semantics: a comparison with a null operand is unknown, so neither it
          // nor its negation matches.
          if (leftNull || rightNull) return null;
          const opts = options(definition);
          switch (node.op) {
            case "eq":
              return valuesEqual(x, y, opts);
            case "ne":
              return !valuesEqual(x, y, opts);
            default: {
              const result = compareForFilter(x, y, opts);
              if (Number.isNaN(result)) return false;
              return node.op === "gt" ? result > 0 : node.op === "ge" ? result >= 0 : node.op === "lt" ? result < 0 : result <= 0;
            }
          }
        };
      }
      case "in": {
        const left = compile(node.left);
        const values = node.values.map(compile);
        return (row, m, s) => {
          const x = left(row, m, s);
          if (isEmpty(scalar(x))) return null;
          return values.some((value) => valuesEqual(x, value(row, m, s), options(null)));
        };
      }
      case "string": {
        const [subject, pattern] = node.args;
        const subjectFn = compile(subject);
        if (pattern.type !== "literal" || typeof pattern.value !== "string")
          unsupported(`The second argument of ${node.name} must be a string literal`);
        const matcher = stringFunctionMatcher(node.name, pattern.value, settings.collation ?? "CI_AI");
        return (row, m, s) => {
          const value = subjectFn(row, m, s);
          return isEmpty(value) ? null : matcher(value);
        };
      }
      case "crm": {
        const name = node.params.PropertyName;
        if (name?.type !== "literal" || typeof name.value !== "string")
          fail(`${node.name} requires a PropertyName string parameter.`);
        const spec = CRM_FUNCTIONS[node.name];
        if (spec.rejection)
          fail(spec.rejection.message, spec.rejection.status, spec.rejection.code, { innerCode: spec.rejection.innerCode });
        if (spec.unsupported) unsupported(`Dataverse query function ${node.name} is not supported locally: ${spec.unsupported}.`);
        const segments = String(name.value).split("/");
        const valueParam = (key) => {
          const param = node.params[key];
          if (!param) return undefined;
          return param.type === "array" ? param.values : param.value;
        };
        let values;
        if (node.shape === "list") {
          const list = valueParam("PropertyValues");
          if (!Array.isArray(list)) fail(`${node.name} requires a PropertyValues array.`);
          values = list.map((item) => (item == null ? item : String(item)));
        } else if (node.shape === "pair")
          values = [valueParam("PropertyValue1"), valueParam("PropertyValue2")].map((item) => (item == null ? item : String(item)));
        else if (node.shape === "one") {
          const value = valueParam("PropertyValue");
          if (value === undefined) fail(`${node.name} requires a PropertyValue parameter.`);
          values = [String(value)];
        } else values = [];
        const cache = new Map();
        return (row, rowMapping, scope) => {
          const resolved = resolvePath(segments, row, rowMapping, scope);
          const key = `${rowMapping.logicalName}.${segments.join("/")}`;
          if (!cache.has(key))
            cache.set(
              key,
              compileOperator(node.operator, {
                attribute: segments.join("/"),
                values,
                definition: resolved.definition,
                identity: ctx.identity,
                settings,
                now: ctx.now,
              }),
            );
          const result = cache.get(key)(resolved.value);
          // A null column is unknown for every operator except the null tests.
          if (!result && isEmpty(scalar(resolved.value)) && node.operator !== "null" && node.operator !== "not-null") return null;
          return Boolean(result);
        };
      }
      case "lambda": {
        boundPath(node.path);
        const body = node.body ? truth(node.body) : null;
        return (row, rowMapping, scope) => {
          const { rows, mapping: targetMapping } = collection(node.path, row, rowMapping, scope);
          if (!body) return rows.length > 0;
          const test = (item) => body(item, targetMapping, new Map([...scope, [node.variable, { row: item, mapping: targetMapping }]]));
          // any: true if one item is true; all: false if one item is false; else
          // unknown when an item is unknown.
          const decisive = node.kind === "any";
          let unknown = false;
          for (const item of rows) {
            const value = test(item);
            if (value === decisive) return decisive;
            if (value == null) unknown = true;
          }
          return unknown ? null : !decisive;
        };
      }
      case "call": {
        const args = node.args.map(compile);
        const functions = {
          tolower: (a) => String(a ?? "").toLowerCase(),
          toupper: (a) => String(a ?? "").toUpperCase(),
          trim: (a) => String(a ?? "").trim(),
          length: (a) => String(a ?? "").length,
          concat: (a, b) => String(a ?? "") + String(b ?? ""),
          substring: (a, b, c) => String(a ?? "").slice(b, c == null ? undefined : b + c),
          year: (a) => new Date(a).getUTCFullYear(),
          month: (a) => new Date(a).getUTCMonth() + 1,
          day: (a) => new Date(a).getUTCDate(),
        };
        return (row, m, s) => functions[node.name](...args.map((arg) => scalar(arg(row, m, s))));
      }
      default:
        unsupported(`Unsupported OData expression ${node.type}`);
    }
  };
  const predicate = truth(ast);
  return (row) => predicate(row, mapping, new Map()) === true;
}

// ---------------------------------------------------------------------------
// Query options

/** Split on a separator outside parentheses and quoted strings. */
export function splitTopLevel(text, separator = ",") {
  const out = [];
  let start = 0,
    depth = 0,
    quote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'") {
      if (quote && text[i + 1] === "'") {
        i++;
        continue;
      }
      quote = !quote;
    }
    if (quote) continue;
    if (c === "(" || c === "[") depth++;
    if (c === ")" || c === "]") depth--;
    if (c === separator && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(text.slice(start).trim());
  return out.filter(Boolean);
}

/** $orderby: comma-separated property [asc|desc]. */
export function parseOrderBy(text, { dialect = "dataverse" } = {}) {
  if (text == null || text === "") return [];
  return splitTopLevel(String(text)).map((spec) => {
    const match = /^([A-Za-z_][\w]*(?:\/[A-Za-z_][\w]*)*)(?:\s+(asc|desc))?$/i.exec(spec.trim());
    if (!match) unsupported(`Unsupported order ${spec}`);
    if (dialect === "dataverse" && match[1].includes("/"))
      unsupported(`Ordering by related table columns (${match[1]}) isn't supported by the Dataverse Web API.`);
    return { path: match[1].split("/"), descending: match[2]?.toLowerCase() === "desc" };
  });
}

/** $select: comma-separated properties. */
export function parseSelect(text) {
  if (text == null || text === "" || text === "*") return null;
  return splitTopLevel(String(text)).map((item) => {
    if (!/^[A-Za-z_][\w]*$/.test(item)) unsupported(`Unsupported $select item ${item}`);
    return item;
  });
}

/** $expand: nav($select=..;$filter=..;$orderby=..;$top=..;$expand=..) */
export function parseExpand(text, depth = 0) {
  if (text == null || text === "") return [];
  if (depth > ODATA_LIMITS.expandDepth) unsupported("$expand nesting is too deep");
  return splitTopLevel(String(text)).map((spec) => {
    const match = /^([A-Za-z_][\w]*)(?:\(([\s\S]*)\))?$/.exec(spec.trim());
    if (!match) unsupported(`Malformed expand ${spec}`);
    const options = {};
    for (const pair of splitTopLevel(match[2] ?? "", ";")) {
      const at = pair.indexOf("=");
      if (at < 0) unsupported(`Malformed expand option ${pair}`);
      const key = pair.slice(0, at).trim();
      if (!["$select", "$filter", "$orderby", "$top", "$expand"].includes(key))
        unsupported(`Unsupported expand option ${key}`);
      options[key] = pair.slice(at + 1).trim();
    }
    return {
      navigation: match[1],
      select: options.$select,
      filter: options.$filter,
      orderby: options.$orderby,
      top: options.$top,
      expand: options.$expand ? parseExpand(options.$expand, depth + 1) : [],
    };
  });
}

/** $apply: filter(...)/groupby((...),aggregate(...))/aggregate(...) */
export function parseApply(text, { dialect = "dataverse", aliases = {} } = {}) {
  const steps = [];
  const source = String(text ?? "").trim();
  if (!source) unsupported("Empty $apply");
  const parts = splitTopLevel(source, "/");
  for (const part of parts) {
    const match = /^(filter|groupby|aggregate)\(([\s\S]*)\)$/i.exec(part);
    if (!match) unsupported(`Unsupported OData $apply transformation ${part}`);
    const kind = match[1].toLowerCase();
    const body = match[2].trim();
    if (kind === "filter") steps.push({ kind, ast: parseODataExpression(body, { dialect, aliases }), source: body });
    else if (kind === "aggregate") steps.push({ kind, aggregates: parseAggregates(body) });
    else {
      const groupMatch = /^\(([^()]*)\)(?:\s*,\s*aggregate\(([\s\S]*)\))?$/i.exec(body);
      if (!groupMatch) unsupported(`Unsupported OData groupby ${body}`);
      const properties = splitTopLevel(groupMatch[1]).map((item) => {
        if (!/^[A-Za-z_][\w]*(?:\/[A-Za-z_][\w]*)*$/.test(item)) unsupported(`Unsupported groupby property ${item}`);
        return item.split("/");
      });
      steps.push({ kind, properties, aggregates: groupMatch[2] ? parseAggregates(groupMatch[2]) : [] });
    }
  }
  return steps;
}
function parseAggregates(text) {
  return splitTopLevel(text).map((item) => {
    let match = /^\$count\s+as\s+([A-Za-z_]\w*)$/i.exec(item);
    if (match) return { method: "$count", alias: match[1] };
    match = /^([A-Za-z_][\w]*(?:\/[A-Za-z_][\w]*)*)\s+with\s+([A-Za-z]+)\s+as\s+([A-Za-z_]\w*)$/i.exec(item);
    if (!match) unsupported(`Unsupported OData aggregate expression ${item}`);
    const method = match[2].toLowerCase();
    if (!ODATA_APPLY_METHODS.has(method)) unsupported(`Unsupported OData aggregate method ${match[2]}`);
    return { method, path: match[1].split("/"), alias: match[3] };
  });
}

/** Paths read by $apply (for Web API column policy). */
export function applyPaths(steps) {
  const out = [];
  for (const step of steps) {
    if (step.kind === "filter") out.push(...expressionPaths(step.ast));
    if (step.properties) out.push(...step.properties);
    for (const aggregate of step.aggregates ?? []) if (aggregate.path) out.push(aggregate.path);
  }
  return out;
}

/** Sort rows by $orderby with Dataverse semantics and a primary-key tie breaker. */
export function sortRows(rows, specs, { mapping, valueOf, definition, lookupName, collation = "CI_AI", rawChoice = false, tieBreak = true }) {
  const keyed = rows.map((row, index) => ({
    row,
    index,
    keys: specs.map((spec) =>
      makeSortKey(valueOf(row, spec.path), { definition: definition(spec.path), rawChoice, lookupName }),
    ),
    pk: tieBreak ? makeSortKey(row?.[mapping.idColumn], { definition: { dataverseType: "primarykey" } }) : null,
  }));
  keyed.sort((a, b) => {
    for (let i = 0; i < specs.length; i++) {
      const result = compareSortKeys(a.keys[i], b.keys[i], collation);
      if (result) return specs[i].descending ? -result : result;
    }
    if (tieBreak) {
      const result = compareSortKeys(a.pk, b.pk, collation);
      if (result) return result;
    }
    return a.index - b.index;
  });
  return keyed.map((entry) => entry.row);
}

/** Apply $apply group/aggregate steps over already permission-filtered rows. */
export function evaluateApply(steps, rows, ctx) {
  let current = rows;
  let grouped = false;
  for (const step of steps) {
    if (step.kind === "filter") {
      if (grouped) unsupported("filter after groupby or aggregate isn't supported");
      const predicate = compileODataPredicate(step.ast, ctx.mapping, ctx);
      current = current.filter(predicate);
      continue;
    }
    if (grouped) unsupported("Only one groupby or aggregate transformation is supported");
    if (current.length > ODATA_LIMITS.aggregateRecords)
      fail("AggregateQueryRecordLimit exceeded. Cannot perform this operation.", 400, "AggregateQueryRecordLimit", {
        innerCode: "0x8004e023",
      });
    const properties = step.properties ?? [];
    const keyOf = (segments) =>
      segments.length === 1
        ? segments[0]
        : `${ctx.targetLogicalName(segments.slice(0, -1))}_${segments.at(-1)}`;
    const valueOf = (row, segments) => ctx.pathValue(row, segments);
    for (const segments of properties) {
      const definition = ctx.pathDefinition(segments);
      if (fieldKind(definition) === "datetime")
        unsupported("groupby with datetime values isn't supported.");
    }
    const buckets = new Map();
    for (const row of current) {
      const values = properties.map((segments) => valueOf(row, segments));
      if (properties.some((segments, index) => fieldKind(ctx.pathDefinition(segments)) == null && typeof values[index] === "string" && looksLikeDate(values[index])))
        unsupported("groupby with datetime values isn't supported.");
      const signature = JSON.stringify(values.map((value) => {
        const raw = scalar(value);
        return raw == null || raw === "" ? null : (guidKey(raw) ?? raw);
      }));
      if (!buckets.has(signature)) buckets.set(signature, { values, rows: [] });
      buckets.get(signature).rows.push(row);
    }
    if (!properties.length && !buckets.size) buckets.set("[]", { values: [], rows: [] });
    current = [...buckets.values()].map((bucket) => {
      const out = {};
      properties.forEach((segments, index) => {
        const value = bucket.values[index];
        if (!isEmpty(scalar(value))) out[keyOf(segments)] = structuredClone(value);
      });
      for (const aggregate of step.aggregates ?? []) {
        if (aggregate.method === "$count") {
          out[aggregate.alias] = bucket.rows.length;
          continue;
        }
        const values = bucket.rows
          .map((row) => valueOf(row, aggregate.path))
          .filter((value) => !isEmpty(scalar(value)));
        const numbers = values.map((value) => Number(scalar(value))).filter(Number.isFinite);
        let result = null;
        switch (aggregate.method) {
          case "sum":
            result = numbers.reduce((a, b) => a + b, 0);
            break;
          case "average":
            result = numbers.length ? numbers.reduce((a, b) => a + b, 0) / numbers.length : null;
            break;
          case "min":
          case "max": {
            if (!values.length) break;
            const definition = ctx.pathDefinition(aggregate.path);
            const keyed = values.map((value) => ({ value, key: makeSortKey(value, { definition, rawChoice: true }) }));
            keyed.sort((a, b) => compareSortKeys(a.key, b.key, ctx.settings?.collation));
            result = scalar(aggregate.method === "min" ? keyed[0].value : keyed.at(-1).value);
            const date = typeof result === "string" ? parseDateValue(result) : null;
            if (date && !date.dateOnly) result = new Date(date.ms).toISOString().replace(/\.\d{3}Z$/, "Z");
            break;
          }
        }
        if (result != null) out[aggregate.alias] = result;
      }
      return out;
    });
    grouped = true;
  }
  return { rows: current, grouped };
}

export { sqlGuidSortKey };
