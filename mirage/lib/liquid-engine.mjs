// DotLiquid-compatible Liquid engine with Power Pages semantics.
//
// Power Pages renders Liquid with DotLiquid (SyntaxCompatibility.DotLiquid20) plus portal
// tags/filters. Observed live reference-portal HTML confirms DotLiquid20 whitespace control (`{%-`
// trims spaces/tabs only; `-%}` removes one following newline or one run of spaces/tabs).
// This module ports the DotLiquid parser and runtime semantics: regex-based tokenising and
// markup parsing, scopes, conditions (right-to-left and/or, Convert.ChangeType equality),
// inline "Liquid error:" handling, includes, extends/block, loops and output formatting.
// Portal-specific tags, objects and filters are registered by liquid.mjs/liquid-filters.mjs.
import {
  LiquidError,
  LiquidSyntaxError,
  NetDecimal,
  isNumber,
  isDate,
  numberToOutput,
  dateToNetString,
  safeTypeInsensitiveEqual,
  backCompatEqual,
  netCompare,
  netTypeName,
  toInt32,
  htmlEncode,
} from "./liquid-dotnet.mjs";

export { LiquidError, LiquidSyntaxError };

// ---------------------------------------------------------------------------
// DotLiquid regular expressions (Liquid.cs), translated to JavaScript.
// .NET \w is Unicode-aware; the u-flag classes below reproduce it.
// ---------------------------------------------------------------------------
const WC = "\\p{L}\\p{Mn}\\p{Nd}\\p{Pc}";
const QS = `"[^"]*"|'[^']*'`;
const QF = `${QS}|(?:[^\\s,|'"]|${QS})+`;
const QAF = `${QS}|(?:[^\\s|'"]|${QS})+`;
const VARIABLE_SIGNATURE = `\\(?[${WC}\\-.[\\]]\\)?`;
const re = (source, flags = "u") => new RegExp(source, flags);
const TAG_ATTRIBUTES = re(`([${WC}]+)\\s*:\\s*(${QF})`, "gu");
const VARIABLE_PARSER = re(`\\[[^\\]]+\\]|[${WC}\\-]+\\??`, "gu");
const FULL_TOKEN = re(`^\\{%\\s*([${WC}]+)\\s*(.*)?%\\}$`);
const CONTENT_OF_VARIABLE = /^\{\{(.*)\}\}$/u;
const QUOTED_ASSIGN_FRAGMENT = re(`\\s*(${QAF})(.*)`);
const FILTER_SEPARATOR = /\|\s*(.*)/u;
const FILTER_PARSER = re(`(?:\\s+|${QF}|,)+`, "gu");
const FILTER_ARG = re(`(?::|,)\\s*(${QF})`, "gu");
const FILTER_NAME = re(`\\s*([${WC}]+)`);
const SINGLE_QUOTED = /^'(.*)'$/;
const DOUBLE_QUOTED = /^"(.*)"$/;
const INTEGER = /^([+-]?\d+)$/;
const RANGE = /^\((\S+)\.\.(\S+)\)$/;
const NUMERIC = /^([+-]?\d[\d.|,]+)$/;
const IF_SYNTAX = re(`(${QF})\\s*([=!<>a-zA-Z_]+)?\\s*(${QF})?`);
const IF_EXPRESSIONS = re(
  `(?:\\b(?:\\s?and\\s?|\\s?or\\s?)\\b|(?:\\s*(?!\\b(?:\\s?and\\s?|\\s?or\\s?)\\b)(?:${QF}|\\S+)\\s*)+)`,
  "gu",
);
const scan = (text, regex) => {
  regex.lastIndex = 0;
  return [...String(text).matchAll(regex)].map((m) => (m.length === 2 ? m[1] : m[0]));
};
/** Tokenizer.GetAttributes: `name: value` pairs anywhere in a tag's markup. */
export function tagAttributes(markup) {
  const attributes = new Map();
  for (const m of String(markup).matchAll(TAG_ATTRIBUTES)) attributes.set(m[1].toLowerCase(), { key: m[1], value: m[2] });
  return attributes;
}
const TAG_END_TEXT = "(?-mix:\\%\\})";
const VARIABLE_END_TEXT = "(?-mix:\\}\\})";

// ---------------------------------------------------------------------------
// Runtime value model
// ---------------------------------------------------------------------------
/** DotLiquid Hash: ordered, case-insensitive (OrdinalIgnoreCase naming convention). */
export class LiquidHash {
  constructor(entries) {
    this.map = new Map();
    if (entries)
      for (const [key, value] of entries instanceof Map ? entries : Object.entries(entries)) this.set(key, value);
  }
  static from(value) {
    return value instanceof LiquidHash ? value : new LiquidHash(value ?? {});
  }
  has(key) {
    return this.map.has(String(key).toLowerCase());
  }
  get(key) {
    return this.map.get(String(key).toLowerCase())?.[1];
  }
  set(key, value) {
    const lower = String(key).toLowerCase();
    const existing = this.map.get(lower);
    this.map.set(lower, [existing ? existing[0] : String(key), value]);
  }
  delete(key) {
    this.map.delete(String(key).toLowerCase());
  }
  get size() {
    return this.map.size;
  }
  *entries() {
    for (const [key, value] of this.map.values()) yield [key, value];
  }
  [Symbol.iterator]() {
    return [...this.map.values()].map(([key, value]) => new KeyValuePair(key, value))[Symbol.iterator]();
  }
}
export class KeyValuePair {
  constructor(key, value) {
    this.key = key;
    this.value = value;
  }
}
/** Base class for drops (DotLiquid Drop: property access, renders empty, not enumerable). */
export class LiquidDrop {
  liquidGet() {
    return undefined;
  }
}
/** blank/empty literals resolve to DotLiquid.Util.Symbol instances (Context.Resolve). */
class LiquidSymbol {
  static netTypeName = "DotLiquid.Util.Symbol";
  constructor(name, test) {
    this.name = name;
    this.test = test;
  }
}
export class BreakInterrupt extends Error {}
export class ContinueInterrupt extends Error {}

const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
export const isPlainObject = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  !isDate(value) &&
  !(value instanceof NetDecimal) &&
  !(value instanceof LiquidHash) &&
  !(value instanceof KeyValuePair) &&
  !(value instanceof LiquidSymbol);
/** IEnumerable in .NET terms: strings, arrays, hashes. Drops/objects are not enumerable. */
export function isEnumerable(value) {
  return typeof value === "string" || Array.isArray(value) || value instanceof LiquidHash;
}
export function toList(value) {
  if (typeof value === "string") return [...value];
  if (Array.isArray(value)) return value;
  if (value instanceof LiquidHash) return [...value];
  return [];
}
export function ownKey(object, key) {
  if (UNSAFE_KEYS.has(key)) return undefined;
  if (Object.hasOwn(object, key)) return key;
  const lower = key.toLowerCase();
  for (const candidate of Object.keys(object)) if (candidate.toLowerCase() === lower) return candidate;
  return undefined;
}
/**
 * TryEvaluateHashOrArrayLikeObject + drop invocation. Returns { found, value }.
 * Plain JS objects behave as drops: case-insensitive property lookup, missing -> nil.
 */
export async function lookupMember(object, part, context) {
  if (object == null) return { found: false };
  if (object instanceof LiquidHash) {
    const key = String(part instanceof NetDecimal ? part.toString() : part);
    return object.has(key) ? { found: true, value: object.get(key) } : { found: false };
  }
  if (Array.isArray(object)) {
    if (!isNumber(part) || !Number.isInteger(Number(part))) return { found: false };
    let index = Number(part);
    if (index < 0) index += object.length;
    return index >= 0 && index < object.length ? { found: true, value: object[index] } : { found: false };
  }
  if (typeof object !== "object" || isDate(object) || object instanceof NetDecimal || object instanceof KeyValuePair || object instanceof LiquidSymbol)
    return { found: false };
  const key = part instanceof NetDecimal ? part.toString() : String(part);
  if (typeof object.liquidGet === "function") return { found: true, value: await object.liquidGet(key, context) };
  const hidden = object[LIQUID_HIDDEN];
  const properties = object[LIQUID_PROPERTIES];
  let property;
  if (properties) {
    // Entity drops: attribute names are exact (Dataverse AttributeCollection); drop
    // properties such as id, url or title follow the case-insensitive naming convention.
    if (Object.hasOwn(object, key) && !UNSAFE_KEYS.has(key) && !hidden?.has(key)) property = key;
    else if (properties.has(key.toLowerCase()))
      property = Object.keys(object).find((name) => name.toLowerCase() === key.toLowerCase() && !hidden?.has(name));
  } else {
    property = ownKey(object, key);
    if (property !== undefined && hidden?.has(property)) property = undefined;
  }
  if (property === undefined) return { found: true, value: undefined };
  const value = object[property];
  return { found: true, value: typeof value === "function" ? undefined : value };
}
/** Symbols marking drop property names (case-insensitive) and host-only keys. */
export const LIQUID_PROPERTIES = Symbol.for("paqvilo.liquid.properties");
export const LIQUID_HIDDEN = Symbol.for("paqvilo.liquid.hidden");

// ---------------------------------------------------------------------------
// Output formatting (DotLiquid Variable.Render on .NET Framework, en-US)
// ---------------------------------------------------------------------------
/** Item formatting inside IEnumerable output (IFormattable.ToString / object.ToString). */
export function formatItem(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "True" : "False";
  if (isNumber(value)) return numberToOutput(value);
  if (isDate(value)) return dateToNetString(value);
  if (value instanceof KeyValuePair) return `[${value.key}, ${formatItem(value.value)}]`;
  if (Array.isArray(value)) return "System.Object[]";
  if (value instanceof LiquidHash) return "DotLiquid.Hash";
  return value?.constructor?.netTypeName ?? "DotLiquid.Drop";
}
/** Top-level output of a {{ }} expression. */
export function formatOutput(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (isNumber(value)) return numberToOutput(value);
  if (isDate(value)) return dateToNetString(value);
  // Symbol is not ILiquidizable: Variable.Render writes object.ToString(), the type name.
  if (value instanceof LiquidSymbol) return LiquidSymbol.netTypeName;
  if (isEnumerable(value)) return toList(value).map(formatItem).join("");
  if (value instanceof KeyValuePair) return formatItem(value);
  return ""; // drops (ILiquidizable) render empty
}
/** DotLiquid condition truthiness: only nil and false are falsy. */
export const truthy = (value) => value != null && value !== false;

// ---------------------------------------------------------------------------
// Tokenizer (DotLiquid Tokenizer.Tokenize, SyntaxCompatibility.DotLiquid20)
// ---------------------------------------------------------------------------
export function tokenize(source, rawTags = new Set()) {
  if (source == null || source === "") return [];
  // Comment/literal shorthands only apply when they span the whole template.
  let text = String(source);
  let m = /^(?:\{\{\{\s?)(.*?)(?:\s*\}\}\})$/.exec(text);
  if (m) text = `{% literal %}${m[1]}{% endliteral %}`;
  m = /^(?:\{\s?#\s?)(.*?)(?:\s*#\s?\})$/.exec(text);
  if (m) text = `{% comment %}${m[1]}{% endcomment %}`;
  // Trailing whitespace control: one newline or one run of spaces/tabs, never both.
  text = text.replace(/-(\}\}|%\})(\n|\r\n|[ \t]+)?/g, "$1");
  const tokens = [];
  const start = /(\{\{|\{%)(-)?/g;
  let position = 0;
  let match;
  for (;;) {
    start.lastIndex = position;
    match = start.exec(text);
    if (!match) break;
    if (match.index > position) {
      let literal = text.slice(position, match.index);
      // Leading whitespace control: spaces and tabs only (DotLiquid20).
      if (match[2]) literal = literal.replace(/[\t ]+$/, "");
      if (literal !== "") tokens.push(literal);
    }
    const isTag = match[1] === "{%";
    let token = match[1];
    let i = match.index + match[0].length;
    let closed = false;
    while (i < text.length) {
      const ch = text[i++];
      token += ch;
      if (ch === "'" || ch === '"') {
        const end = text.indexOf(ch, i);
        if (end < 0) {
          token += text.slice(i);
          i = text.length;
          break;
        }
        token += text.slice(i, end + 1);
        i = end + 1;
      } else if ((isTag ? ch === "%" : ch === "}") && text[i] === "}") {
        token += "}";
        i++;
        closed = true;
        break;
      }
    }
    if (!closed)
      throw new LiquidSyntaxError(
        isTag
          ? `Tag '${token}' was not properly terminated with regexp: ${TAG_END_TEXT}`
          : `Variable '${token}' was not properly terminated with regexp: ${VARIABLE_END_TEXT}`,
      );
    tokens.push(token);
    position = i;
    if (isTag) {
      const name = re(`^\\{%\\s*([${WC}]+)`).exec(token)?.[1];
      if (name && rawTags.has(name)) {
        const end = new RegExp(`\\{%-?\\s*end${name}\\s*-?%\\}`, "g");
        end.lastIndex = position;
        const found = end.exec(text);
        if (!found) throw new LiquidSyntaxError(`${name} tag was never closed`);
        if (found.index > position) tokens.push(text.slice(position, found.index));
        position = found.index;
      }
    }
  }
  if (position < text.length) tokens.push(text.slice(position));
  return tokens;
}

// ---------------------------------------------------------------------------
// Variables and filters
// ---------------------------------------------------------------------------
const ENCODING_FILTERS = new Set(["escape", "h", "escape_once", "xml_escape"]);
export class Variable {
  constructor(markup) {
    this.markup = markup;
    this.name = null;
    this.filters = [];
    const match = QUOTED_ASSIGN_FRAGMENT.exec(markup);
    if (!match) return;
    this.name = match[1];
    const rest = FILTER_SEPARATOR.exec(match[2]);
    if (!rest) return;
    for (const segment of scan(rest[0], FILTER_PARSER)) {
      const name = FILTER_NAME.exec(segment)?.[1];
      if (name) this.filters.push({ name, args: scan(segment, FILTER_ARG) });
    }
  }
  /** Variable.Render(context) -> value after filters (no string conversion). */
  async evaluate(context) {
    if (this.name == null) return null;
    let output = await context.resolve(this.name);
    if (!this.filters.length) return output;
    // Filters see whether the value comes from a user or request root, the values the platform
    // HTML-encodes on output (the json filter writes such values verbatim).
    const roots = context.engine.autoEncodeRoots?.(context);
    const root = /^[^.[\s]+/.exec(this.name)?.[0]?.toLowerCase();
    const previous = context.encodedFilterSource;
    context.encodedFilterSource = Boolean(roots && root && roots.has(root));
    try {
      for (const filter of this.filters) {
        const args = [];
        for (const arg of filter.args) args.push(await context.resolve(arg));
        output = await context.invokeFilter(filter.name, output, args, this.markup);
      }
    } finally {
      context.encodedFilterSource = previous;
    }
    return output;
  }
  async render(context, out) {
    const value = await this.evaluate(context);
    let text = formatOutput(value);
    const roots = context.engine.autoEncodeRoots?.(context);
    if (text && roots && this.name) {
      const root = /^[^.[\s]+/.exec(this.name)?.[0]?.toLowerCase();
      const last = this.filters.at(-1)?.name.toLowerCase();
      // Power Pages 9.3.8.x+: user/request output is HTML encoded by default.
      if (roots.has(root) && !ENCODING_FILTERS.has(last)) text = htmlEncode(text);
    }
    out.push(text);
  }
}

// ---------------------------------------------------------------------------
// Conditions (DotLiquid Condition.cs)
// ---------------------------------------------------------------------------
function equalVariables(left, right) {
  if (left instanceof LiquidSymbol) return left.test(right);
  if (right instanceof LiquidSymbol) return right.test(left);
  return safeTypeInsensitiveEqual(left, right);
}
export const OPERATORS = {
  "==": (l, r) => equalVariables(l, r),
  "!=": (l, r) => !equalVariables(l, r),
  "<>": (l, r) => !equalVariables(l, r),
  "<": (l, r) => l != null && r != null && netCompare(l, r) === -1,
  ">": (l, r) => l != null && r != null && netCompare(l, r) === 1,
  "<=": (l, r) => l != null && r != null && netCompare(l, r) <= 0,
  ">=": (l, r) => l != null && r != null && netCompare(l, r) >= 0,
  contains: (l, r) => {
    if (typeof l === "string" && r != null) {
      if (typeof r !== "string")
        throw new LiquidError(`Unable to cast object of type '${netTypeName(r)}' to type 'System.String'.`, "System.InvalidCastException");
      return l.includes(r);
    }
    return isEnumerable(l) && toList(l).some((item) => backCompatEqual(item, r));
  },
  startswith: (l, r) =>
    Array.isArray(l) ? equalVariables(l[0] ?? null, r) : typeof l === "string" && typeof r === "string" && l.startsWith(r),
  endswith: (l, r) =>
    Array.isArray(l) ? equalVariables(l.at(-1) ?? null, r) : typeof l === "string" && typeof r === "string" && l.endsWith(r),
  haskey: (l, r) => r != null && l instanceof LiquidHash && l.has(r),
  hasvalue: (l, r) => l instanceof LiquidHash && [...l.entries()].some(([, v]) => v === r),
};
class Condition {
  constructor(left, operator, right) {
    this.left = left;
    this.operator = operator;
    this.right = right;
    this.relation = null;
    this.child = null;
    this.attachment = [];
  }
  async evaluate(context) {
    let result;
    if (!this.operator) {
      const value = await context.resolve(this.left, false);
      result = value != null && value !== false;
    } else {
      const left = await context.resolve(this.left);
      const right = await context.resolve(this.right);
      const op = OPERATORS[this.operator] ?? OPERATORS[this.operator.toLowerCase()];
      if (!op) throw new LiquidError(`Unknown operator ${this.operator}`, "DotLiquid.Exceptions.ArgumentException");
      result = op(left, right);
    }
    if (this.relation === "or") return result || (await this.child.evaluate(context));
    if (this.relation === "and") return result && (await this.child.evaluate(context));
    return result;
  }
}
class ElseCondition extends Condition {
  constructor() {
    super();
    this.isElse = true;
  }
  async evaluate() {
    return true;
  }
}
const conditionFrom = (match) =>
  new Condition(match[1].replace(/^\(+/, ""), match[2] ?? "", (match[3] ?? "").replace(/\)+$/, ""));
/** If.PushBlock: expressions are grouped right-to-left; there are no parentheses. */
export function parseCondition(markup) {
  const help = "Syntax Error in 'if' tag - Valid syntax: if [expression]";
  const expressions = scan(markup, IF_EXPRESSIONS);
  const syntax = expressions.at(-1);
  if (!syntax) throw new LiquidSyntaxError(help);
  const match = IF_SYNTAX.exec(syntax);
  if (!match) throw new LiquidSyntaxError(help);
  let condition = conditionFrom(match);
  let count = 1;
  for (let i = 1; i < expressions.length; i += 2) {
    const operator = expressions.at(-1 - i).trim();
    const expression = IF_SYNTAX.exec(expressions.at(-2 - i) ?? "");
    if (!expression) throw new LiquidSyntaxError(help);
    if (++count > 500) throw new LiquidSyntaxError("Syntax Error in 'if' tag - max 500 conditions are allowed");
    const next = conditionFrom(expression);
    if (operator === "and" || operator === "or") {
      next.relation = operator;
      next.child = condition;
    }
    condition = next;
  }
  return condition;
}

// ---------------------------------------------------------------------------
// Context (scopes, environments, registers, resolution, filters, errors)
// ---------------------------------------------------------------------------
const BLANK = new LiquidSymbol("blank", (value) =>
  value == null ||
  value === false ||
  (typeof value === "string" && !value.trim()) ||
  (isEnumerable(value) && toList(value).length === 0),
);
const EMPTY = new LiquidSymbol("empty", (value) => isEnumerable(value) && toList(value).length === 0);
/** One Strainer overload from its signature text ("@context, input, format?"). */
function parseFilterSignature(text) {
  const names = String(text)
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const params = names.filter((name) => name !== "@context").map((name) => ({ name: name.replace(/\?$/, ""), optional: name.endsWith("?") }));
  return { params, total: names.length };
}
/**
 * Strainer.Invoke argument rules. An overload whose non-Context parameter count equals the
 * argument count (input included) is invoked as is. Otherwise the overload with the most
 * parameters is used: a missing parameter without a default value raises a SyntaxException and
 * surplus arguments make MethodInfo.Invoke throw TargetParameterCountException.
 */
function checkFilterArguments(name, overloads, count) {
  if (!overloads?.length || overloads.some((overload) => overload.params.length === count)) return;
  const widest = overloads.reduce((best, overload) => (overload.total > best.total ? overload : best));
  if (count > widest.params.length) throw new LiquidError("Parameter count mismatch.", "System.Reflection.TargetParameterCountException");
  const missing = widest.params.slice(count).find((param) => !param.optional);
  if (missing) throw new LiquidSyntaxError(`Error - Filter '${name}' does not have a default value for '${missing.name}' and no value was supplied`);
}
export class LiquidContext {
  constructor(engine, { environment = {}, scope, registers, diagnostics, state } = {}) {
    this.engine = engine;
    this.environments = [LiquidHash.from(environment)];
    this.scopes = [scope instanceof LiquidHash ? scope : new LiquidHash(scope ?? {})];
    this.registers = registers ?? new Map();
    this.diagnostics = diagnostics ?? [];
    this.errors = [];
    this.state = state ?? { iterations: 0, started: Date.now(), diagnosticKeys: new Set() };
  }
  get outerScope() {
    return this.scopes.at(-1);
  }
  push(scope = new LiquidHash()) {
    if (this.scopes.length > 80) throw new LiquidError("Nesting too deep", "DotLiquid.Exceptions.StackLevelException");
    this.scopes.unshift(scope instanceof LiquidHash ? scope : new LiquidHash(scope));
  }
  pop() {
    if (this.scopes.length === 1) throw new LiquidError("Context exception", "DotLiquid.Exceptions.ContextException");
    return this.scopes.shift();
  }
  async stack(callback, scope) {
    this.push(scope);
    try {
      return await callback();
    } finally {
      this.pop();
    }
  }
  /** context[key] = value (innermost scope). */
  set(key, value) {
    this.scopes[0].set(key, value);
  }
  /** assign/capture/fetchxml: Scopes.Last() (outermost scope). */
  assignGlobal(key, value) {
    this.outerScope.set(key, value);
  }
  /** Merged view of all variables (innermost wins) for host components. */
  /** Merged plain-object view of all variables (innermost wins) for host components. */
  snapshot() {
    const result = {};
    const plain = (value) => (value instanceof LiquidHash ? Object.fromEntries(value.entries()) : value);
    for (const hash of [...this.environments].reverse().concat([...this.scopes].reverse()))
      for (const [key, value] of hash.entries()) result[key] = plain(value);
    if (result.request && typeof result.request === "object" && result.request.params instanceof LiquidHash)
      result.request = { ...result.request, params: plain(result.request.params) };
    return result;
  }
  async findVariable(key) {
    for (const scope of this.scopes) if (scope.has(key)) return { found: true, value: scope.get(key) };
    for (const environment of this.environments) if (environment.has(key)) return { found: true, value: environment.get(key) };
    return { found: false, value: null };
  }
  /** Context.Resolve: literals, ranges, numbers and variable paths. */
  async resolve(key, notifyNotFound = true) {
    switch (key) {
      case undefined:
      case null:
      case "nil":
      case "null":
      case "":
        return null;
      case "true":
        return true;
      case "false":
        return false;
      case "blank":
        return BLANK;
      case "empty":
        return EMPTY;
    }
    const first = key[0];
    if (first === "'") {
      const m = SINGLE_QUOTED.exec(key);
      if (m) return m[1];
    } else if (first === '"') {
      const m = DOUBLE_QUOTED.exec(key);
      if (m) return m[1];
    } else if (first === "(") {
      const m = RANGE.exec(key);
      if (m) {
        const from = toInt32(await this.resolve(m[1]));
        const to = toInt32(await this.resolve(m[2]));
        if (to - from > 1_000_000) throw new LiquidError("Range exceeds the local renderer limit of 1,000,000 items", "System.OverflowException");
        const range = [];
        for (let i = from; i <= to; i++) range.push(i);
        return range;
      }
    } else if (/[0-9+-]/.test(first)) {
      let m = INTEGER.exec(key);
      if (m) {
        const value = Number(m[1]);
        return Number.isSafeInteger(value) ? value : NetDecimal.parse(m[1]);
      }
      m = NUMERIC.exec(key);
      if (m) {
        const text = m[1];
        if (/^[+-]?\d+(?:\.\d+)?$/.test(text)) return NetDecimal.parse(text);
        if (/^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(text)) return NetDecimal.parse(text.replace(/,/g, ""));
        const parsed = Number(text.replace(/,/g, ""));
        if (Number.isFinite(parsed)) return parsed;
        throw new LiquidError("Input string was not in a correct format.", "System.FormatException");
      }
    }
    return this.variable(key, notifyNotFound);
  }
  async variable(markup, notifyNotFound) {
    const parts = scan(markup, VARIABLE_PARSER);
    let first = parts[0];
    if (first === undefined) return null;
    if (first[0] === "[") {
      // Context.TryGetVariable calls Resolve(...).ToString(): a root bracket that resolves to nil throws.
      const resolved = await this.resolve(first.slice(1, -1));
      if (resolved == null) throw new LiquidError("Object reference not set to an instance of an object.", "System.NullReferenceException");
      first = formatItem(resolved);
    }
    const found = await this.findVariable(first);
    if (!found.found) {
      if (notifyNotFound) this.errors.push(`Error - Variable '${markup}' could not be found`);
      return null;
    }
    let object = found.value ?? null;
    for (let i = 1; i < parts.length; i++) {
      const raw = parts[i];
      const bracketed = raw[0] === "[";
      const part = bracketed ? await this.resolve(raw.slice(1, -1)) : raw;
      if (object instanceof KeyValuePair) {
        const numeric = isNumber(part) ? Number(part) : null;
        if (numeric === 0 || part === "Key") {
          object = object.key;
          continue;
        }
        if (numeric === 1 || part === "Value" || part === object.key) {
          object = object.value ?? null;
          continue;
        }
      }
      const result = await lookupMember(object, part, this);
      if (result.found) {
        object = result.value ?? null;
        continue;
      }
      if (!bracketed && isEnumerable(object) && typeof part === "string") {
        const lower = part.toLowerCase();
        if (lower === "size") {
          object = typeof object === "string" ? object.length : toList(object).length;
          continue;
        }
        if (lower === "first") {
          object = toList(object)[0] ?? null;
          continue;
        }
        if (lower === "last") {
          object = toList(object).at(-1) ?? null;
          continue;
        }
      }
      return null;
    }
    return object ?? null;
  }
  async invokeFilter(name, input, args, markup) {
    const filter = this.engine.filters.get(name);
    if (!filter) {
      // DotLiquid20 Context.Invoke: an unknown filter returns its input unchanged.
      this.diagnostic(
        "liquid-unknown-filter",
        `Unknown Liquid filter '${name}' returned its input unchanged, as DotLiquid does.`,
        { filter: name, markup: String(markup ?? "").trim() },
      );
      return input;
    }
    checkFilterArguments(name, this.engine.filterSignatures?.get(name), args.length + 1);
    return filter.call(this, input, ...args);
  }
  diagnostic(code, message, extra = {}) {
    const key = `${code}|${message}`;
    if (this.state.diagnosticKeys.has(key)) return;
    this.state.diagnosticKeys.add(key);
    this.diagnostics.push({ code, message, ...extra });
  }
  handleError(error) {
    if (error instanceof BreakInterrupt || error instanceof ContinueInterrupt) throw error;
    if (error?.renderLimit) throw error;
    // Simulator infrastructure failures are not Liquid semantics: they abort the render.
    if (isInfrastructureError(error)) throw error;
    this.errors.push(error);
    const message = error?.message ?? String(error);
    if (error instanceof LiquidSyntaxError) {
      this.diagnostic("liquid-syntax-error", message);
      return `Liquid syntax error: ${message}`;
    }
    this.diagnostic(error instanceof LiquidError ? "liquid-error" : "liquid-runtime-error", message);
    return `Liquid error: ${message}`;
  }
  checkLimits() {
    if (++this.state.iterations > this.engine.maxIterations) {
      const error = new LiquidError(`Render Error - Maximum number of iterations ${this.engine.maxIterations} exceeded`);
      error.renderLimit = true;
      throw error;
    }
    if ((this.state.iterations & 1023) === 0 && Date.now() - this.state.started > this.engine.timeoutMs) {
      const error = new LiquidError(`Render Error - local render time limit of ${this.engine.timeoutMs} ms exceeded`);
      error.renderLimit = true;
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Parsing: Tag / Block / Document and the standard tags
// ---------------------------------------------------------------------------
export class Tag {
  initialize(engine, tagName, markup, tokens) {
    this.engine = engine;
    this.tagName = tagName;
    this.markup = markup ?? "";
    this.parse(tokens);
  }
  parse() {}
  async render() {}
  assertTagRules() {}
}
export class Block extends Tag {
  get blockDelimiter() {
    return `end${this.tagName}`;
  }
  parse(tokens) {
    this.nodeList ??= [];
    this.nodeList.length = 0;
    while (tokens.length) {
      const token = tokens.shift();
      if (token.startsWith("{%")) {
        const full = FULL_TOKEN.exec(token);
        if (!full) throw new LiquidSyntaxError(`Tag '${token}' was not properly terminated with regexp: ${TAG_END_TEXT}`);
        const [, name, args = ""] = full;
        if (name === this.blockDelimiter) {
          this.endTag();
          return;
        }
        const tag = this.engine.createTag(name);
        if (tag) {
          tag.initialize(this.engine, name, args, tokens);
          this.nodeList.push(tag);
          tag.assertTagRules(this.nodeList);
        } else this.unknownTag(name, args, tokens);
      } else if (token.startsWith("{{")) {
        const content = CONTENT_OF_VARIABLE.exec(token);
        if (!content) throw new LiquidSyntaxError(`Variable '${token}' was not properly terminated with regexp: ${VARIABLE_END_TEXT}`);
        this.nodeList.push(new Variable(content[1]));
      } else if (token !== "") this.nodeList.push(token);
    }
    this.assertMissingDelimitation();
  }
  endTag() {}
  unknownTag(tag) {
    if (tag === "else") throw new LiquidSyntaxError(`${this.tagName ?? ""} tag does not expect else tag`);
    if (tag === "end") throw new LiquidSyntaxError(`'end' is not a valid delimiter for ${this.tagName} tags. Use ${this.blockDelimiter}`);
    throw new LiquidSyntaxError(`Unknown tag '${tag}'`);
  }
  assertMissingDelimitation() {
    throw new LiquidSyntaxError(`${this.tagName} tag was never closed`);
  }
  async render(context, out) {
    await renderAll(this.nodeList, context, out);
  }
}
/**
 * Failures of the simulator rather than of the portal: live bridge errors (code LIVE_BRIDGE),
 * errors explicitly marked `infrastructure: true` and host errors that carry an HTTP status
 * (request, metadata and component errors). They propagate out of the render and become the
 * page's HTTP status. DotLiquid/.NET errors (LiquidError) and Dataverse-semantic store or
 * FetchXML faults (DataError) keep the inline "Liquid error: ..." rendering of Block.RenderAll.
 */
export function isInfrastructureError(error) {
  if (!error || typeof error !== "object" || error instanceof LiquidError) return false;
  if (error.code === "LIVE_BRIDGE" || error.infrastructure === true) return true;
  if (error.name === "DataError") return false;
  const status = Number(error.status ?? error.statusCode);
  return Number.isInteger(status) && status >= 400 && status <= 599;
}
/** Block.RenderAll: each failing node renders "Liquid error: ..." and rendering continues. */
export async function renderAll(nodes, context, out) {
  for (const node of nodes) {
    context.checkLimits();
    try {
      if (typeof node === "string") out.push(node);
      else await node.render(context, out);
    } catch (error) {
      out.push(context.handleError(error));
    }
  }
}
export class Document extends Block {
  constructor(engine, tokens) {
    super();
    this.engine = engine;
    this.tagName = null;
    this.parse(tokens);
  }
  get blockDelimiter() {
    return "";
  }
  assertMissingDelimitation() {}
  async render(context, out) {
    try {
      await renderAll(this.nodeList, context, out);
    } catch (error) {
      if (!(error instanceof BreakInterrupt || error instanceof ContinueInterrupt)) throw error;
    }
  }
}
/** Raw blocks keep their body as literal text (raw, comment, substitution). */
export class RawBlock extends Block {
  initialize(engine, tagName, markup, tokens) {
    if (String(markup ?? "").trim()) throw new LiquidSyntaxError(`Syntax Error in '${tagName}' tag - Valid syntax: ${tagName}`);
    super.initialize(engine, tagName, markup, tokens);
  }
  parse(tokens) {
    this.nodeList = [];
    while (tokens.length) {
      const token = tokens.shift();
      const full = FULL_TOKEN.exec(token);
      if (full && full[1] === this.blockDelimiter) return;
      this.nodeList.push(token);
    }
    this.assertMissingDelimitation();
  }
  get source() {
    return this.nodeList.join("");
  }
}
class RawTag extends RawBlock {
  async render(context, out) {
    out.push(...this.nodeList);
  }
}
export class CommentTag extends RawBlock {
  async render() {}
}
class LiteralTag extends Block {
  parse(tokens) {
    this.nodeList = [];
    while (tokens.length) {
      const token = tokens.shift();
      const full = FULL_TOKEN.exec(token);
      if (full && full[1] === this.blockDelimiter) return;
      this.nodeList.push(token);
    }
    this.assertMissingDelimitation();
  }
  async render(context, out) {
    out.push(...this.nodeList);
  }
}
const ASSIGN_SYNTAX = re(`((?:${VARIABLE_SIGNATURE})+)\\s*=\\s*(.*)\\s*`);
class AssignTag extends Tag {
  parse() {
    const m = ASSIGN_SYNTAX.exec(this.markup);
    if (!m) throw new LiquidSyntaxError("Syntax Error in 'assign' tag - Valid syntax: assign [var] = [source]");
    this.to = m[1];
    this.from = new Variable(m[2]);
  }
  async render(context) {
    context.assignGlobal(this.to, await this.from.evaluate(context));
  }
}
const WORD = re(`([${WC}]+)`);
// Capture names: Liquid.VariableSegmentRegex, \A\s*(?<Variable>[\w\-]+)\s*\Z (master).
const CAPTURE_SYNTAX = re(`^\\s*([${WC}\\-]+)\\s*$`);
class CaptureTag extends Block {
  parse(tokens) {
    const m = CAPTURE_SYNTAX.exec(this.markup);
    if (!m) throw new LiquidSyntaxError("Syntax Error in 'capture' tag - Valid syntax: capture [var]");
    this.to = m[1];
    super.parse(tokens);
  }
  async render(context) {
    const buffer = [];
    await renderAll(this.nodeList, context, buffer);
    context.assignGlobal(this.to, buffer.join(""));
  }
}
class IfTag extends Block {
  parse(tokens) {
    this.blocks = [];
    this.pushBlock("if", this.markup);
    super.parse(tokens);
  }
  pushBlock(tag, markup) {
    const block = tag === "else" ? new ElseCondition() : parseCondition(markup);
    this.blocks.push(block);
    this.nodeList = block.attachment;
  }
  unknownTag(tag, markup, tokens) {
    // DotLiquid accepts both elsif and the C#-friendly elseif.
    if (tag === "elsif" || tag === "elseif" || tag === "else") this.pushBlock(tag, markup);
    else super.unknownTag(tag, markup, tokens);
  }
  async render(context, out) {
    await context.stack(async () => {
      for (const block of this.blocks)
        if (await block.evaluate(context)) {
          await renderAll(block.attachment, context, out);
          return;
        }
    });
  }
}
class UnlessTag extends IfTag {
  async render(context, out) {
    await context.stack(async () => {
      const [first, ...rest] = this.blocks;
      if (!(await first.evaluate(context))) {
        await renderAll(first.attachment, context, out);
        return;
      }
      for (const block of rest)
        if (await block.evaluate(context)) {
          await renderAll(block.attachment, context, out);
          return;
        }
    });
  }
}
const CASE_SYNTAX = re(`(${QF})`);
const WHEN_SYNTAX = re(`(${QF})(?:(?:\\s+or\\s+|\\s*,\\s*)((?:${QF})[\\s\\S]*))?`);
class CaseTag extends Block {
  parse(tokens) {
    const m = CASE_SYNTAX.exec(this.markup);
    if (!m) throw new LiquidSyntaxError("Syntax Error in 'case' tag - Valid syntax: case [condition]");
    this.left = m[1];
    this.blocks = [];
    super.parse(tokens);
  }
  unknownTag(tag, markup, tokens) {
    this.nodeList = [];
    if (tag === "when") {
      let rest = markup;
      while (rest != null) {
        const m = WHEN_SYNTAX.exec(rest);
        if (!m) throw new LiquidSyntaxError("Syntax Error in 'case' tag - Valid when condition: {% when [condition] [or condition2...] %}");
        rest = m[2] || null;
        const block = new Condition(this.left, "==", m[1]);
        block.attachment = this.nodeList;
        this.blocks.push(block);
      }
    } else if (tag === "else") {
      if (markup.trim()) throw new LiquidSyntaxError("Syntax Error in 'case' tag - Valid else condition: {% else %} (no parameters)");
      const block = new ElseCondition();
      block.attachment = this.nodeList;
      this.blocks.push(block);
    } else super.unknownTag(tag, markup, tokens);
  }
  async render(context, out) {
    await context.stack(async () => {
      let executeElse = true;
      for (const block of this.blocks) {
        if (block.isElse) {
          if (executeElse) await renderAll(block.attachment, context, out);
        } else if (await block.evaluate(context)) {
          executeElse = false;
          await renderAll(block.attachment, context, out);
        }
      }
    });
  }
}
function registerOf(context, name) {
  if (!context.registers.has(name)) context.registers.set(name, new Map());
  return context.registers.get(name);
}
class LegacyKeyValueDrop extends LiquidDrop {
  constructor(key, value) {
    super();
    this.key = key;
    this.value = value;
  }
  liquidGet(name) {
    if (name === "0" || name === "Key" || name === "itemName") return this.key;
    if (name === "1" || name === "Value") return this.value;
    if (this.value instanceof LiquidHash) return this.value.get(name);
    const key = ownKey(this.value, name);
    return key === undefined ? null : this.value[key];
  }
}
const FOR_SYNTAX = re(`([${WC}]+)\\s+in\\s+((?:${QF})+)\\s*(reversed)?`);
class ForTag extends Block {
  parse(tokens) {
    const m = FOR_SYNTAX.exec(this.markup);
    if (!m) throw new LiquidSyntaxError("Syntax Error in 'for' tag - Valid syntax: for [item] in [collection]");
    this.variableName = m[1];
    this.collectionName = m[2];
    this.name = `${m[1]}-${m[2]}`;
    this.reversed = Boolean(m[3]);
    this.attributes = tagAttributes(this.markup);
    this.forBlock = [];
    this.elseBlock = null;
    this.nodeList = this.forBlock;
    super.parse(tokens);
  }
  unknownTag(tag, markup, tokens) {
    if (tag === "else") {
      this.elseBlock = [];
      this.nodeList = this.elseBlock;
      return;
    }
    super.unknownTag(tag, markup, tokens);
  }
  async render(context, out) {
    const collection = await context.resolve(this.collectionName);
    if (!isEnumerable(collection)) {
      if (this.elseBlock) await context.stack(() => renderAll(this.elseBlock, context, out));
      return;
    }
    const register = registerOf(context, "for");
    const offset = this.attributes.get("offset");
    const from = offset
      ? offset.value === "continue"
        ? toInt32(register.get(this.name) ?? 0)
        : toInt32(await context.resolve(offset.value))
      : 0;
    const limitAttribute = this.attributes.get("limit");
    const limit = limitAttribute ? toInt32(await context.resolve(limitAttribute.value)) : null;
    const to = limit != null ? limit + from : null;
    const items = toList(collection);
    const segment = [];
    for (let index = 0; index < items.length; index++) {
      if (to != null && to <= index) break;
      if (from <= index) segment.push(items[index]);
    }
    if (this.reversed) segment.reverse();
    register.set(this.name, from + segment.length);
    await context.stack(async () => {
      if (!segment.length) {
        if (this.elseBlock) await renderAll(this.elseBlock, context, out);
        return;
      }
      for (let index = 0; index < segment.length; index++) {
        context.checkLimits();
        const item = segment[index];
        context.set(
          this.variableName,
          item instanceof KeyValuePair && (item.value instanceof LiquidHash || isPlainObject(item.value))
            ? new LegacyKeyValueDrop(item.key, item.value)
            : item,
        );
        context.set(
          "forloop",
          new LiquidHash({
            name: this.name,
            length: segment.length,
            index: index + 1,
            index0: index,
            rindex: segment.length - index,
            rindex0: segment.length - index - 1,
            first: index === 0,
            last: index === segment.length - 1,
          }),
        );
        try {
          await renderAll(this.forBlock, context, out);
        } catch (error) {
          if (error instanceof BreakInterrupt) break;
          if (!(error instanceof ContinueInterrupt)) throw error;
        }
      }
    });
  }
}
class BreakTag extends Tag {
  async render() {
    throw new BreakInterrupt();
  }
}
class ContinueTag extends Tag {
  async render() {
    throw new ContinueInterrupt();
  }
}
const CYCLE_NAMED = re(`^(${QF})\\s*:\\s*([\\s\\S]*)`);
const CYCLE_SIMPLE = re(`^(?:${QF})+`);
const CYCLE_FRAGMENT = re(`\\s*(${QF})\\s*`);
class CycleTag extends Tag {
  parse() {
    const fragments = (text) =>
      text.split(",").map((part) => {
        const m = CYCLE_FRAGMENT.exec(part);
        return m && m[1] ? m[1] : null;
      });
    const named = CYCLE_NAMED.exec(this.markup);
    if (named) {
      this.variables = fragments(named[2]);
      this.name = named[1];
    } else if (CYCLE_SIMPLE.test(this.markup)) {
      this.variables = fragments(this.markup);
      this.name = `'${this.variables.join("")}'`;
    } else throw new LiquidSyntaxError("Syntax Error in 'cycle' tag - Valid syntax: cycle [name :] var [, var2, var3 ...]");
  }
  async render(context, out) {
    await context.stack(async () => {
      const key = formatItem(await context.resolve(this.name));
      const register = registerOf(context, "cycle");
      let iteration = register.get(key) ?? 0;
      out.push(formatItem(await context.resolve(this.variables[iteration])));
      iteration++;
      if (iteration >= this.variables.length) iteration = 0;
      register.set(key, iteration);
    });
  }
}
class IfChangedTag extends Block {
  async render(context, out) {
    await context.stack(async () => {
      const buffer = [];
      await renderAll(this.nodeList, context, buffer);
      const text = buffer.join("");
      if (text !== context.registers.get("ifchanged")) {
        context.registers.set("ifchanged", text);
        out.push(text);
      }
    });
  }
}
const COUNTER_SYNTAX = re(`^\\s*([${WC}\\-]+)\\s*$`);
class CounterTag extends Tag {
  parse() {
    const m = COUNTER_SYNTAX.exec(this.markup);
    if (!m) throw new LiquidSyntaxError(`Syntax Error in '${this.tagName}' tag - Valid syntax: ${this.tagName} [var]`);
    this.variable = m[1];
  }
  async render(context, out) {
    const environment = context.environments[0];
    const counter = toInt32(environment.has(this.variable) ? environment.get(this.variable) : 0);
    if (this.tagName === "increment") {
      environment.set(this.variable, counter + 1);
      out.push(String(counter));
    } else {
      environment.set(this.variable, counter - 1);
      out.push(String(counter - 1));
    }
  }
}
const TABLEROW_SYNTAX = re(`([${WC}]+)\\s+in\\s+((?:${VARIABLE_SIGNATURE})+)`);
class TableRowTag extends Block {
  parse(tokens) {
    const m = TABLEROW_SYNTAX.exec(this.markup);
    if (!m) throw new LiquidSyntaxError("Syntax Error in 'tablerow' tag - Valid syntax: tablerow [item] in [collection] cols=[number]");
    this.variableName = m[1];
    this.collectionName = m[2];
    this.attributes = tagAttributes(this.markup);
    super.parse(tokens);
  }
  async render(context, out) {
    const value = await context.resolve(this.collectionName);
    if (!isEnumerable(value)) return;
    let collection = toList(value);
    const offset = this.attributes.get("offset");
    if (offset) collection = collection.slice(Math.max(0, toInt32(await context.resolve(offset.value))));
    const limit = this.attributes.get("limit");
    if (limit) collection = collection.slice(0, Math.max(0, toInt32(await context.resolve(limit.value))));
    const length = collection.length;
    const cols = this.attributes.get("cols");
    const columns = cols ? toInt32(await context.resolve(cols.value)) : length;
    let row = 1,
      column = 0;
    // TextWriter.WriteLine on .NET Framework (Windows) emits CRLF.
    out.push('<tr class="row1">\r\n');
    await context.stack(async () => {
      for (let index = 0; index < collection.length; index++) {
        context.set(this.variableName, collection[index]);
        context.set(
          "tablerowloop",
          new LiquidHash({
            length,
            index: index + 1,
            index0: index,
            col: column + 1,
            col0: column,
            rindex: length - index,
            rindex0: length - index - 1,
            first: index === 0,
            last: index === length - 1,
            col_first: column === 0,
            col_last: column === columns - 1,
          }),
        );
        column++;
        const buffer = [];
        await renderAll(this.nodeList, context, buffer);
        out.push(`<td class="col${column}">${buffer.join("")}</td>`);
        if (column === columns && index !== length - 1) {
          column = 0;
          row++;
          out.push("</tr>\r\n", `<tr class="row${row}">`);
        }
      }
    });
    out.push("</tr>\r\n");
  }
}
const INCLUDE_SYNTAX = re(`((?:${QF})+)(\\s+(?:with|for)\\s+((?:${QF})+))?`);
class IncludeTag extends Tag {
  parse() {
    const m = INCLUDE_SYNTAX.exec(this.markup);
    if (!m) throw new LiquidSyntaxError("Syntax Error in 'include' tag - Valid syntax: include [template]");
    this.templateName = m[1];
    this.variableName = m[3] || null;
    this.attributes = [...String(this.markup).matchAll(TAG_ATTRIBUTES)].map((a) => [a[1], a[2]]);
  }
  async render(context, out) {
    const partial = await this.engine.loadTemplate(context, this.templateName);
    const shortened = this.templateName.slice(1, -1);
    const variable = await context.resolve(this.variableName ?? shortened, this.variableName != null);
    await context.stack(async () => {
      for (const [key, value] of this.attributes) context.set(key, await context.resolve(value));
      if (isEnumerable(variable)) {
        for (const item of toList(variable)) {
          context.set(shortened, item);
          await partial.renderInto(context, out);
        }
        return;
      }
      context.set(shortened, variable);
      await partial.renderInto(context, out);
    });
  }
}
// ---- extends / block (DotLiquid Tags/Extends.cs, Tags/Block.cs) ----
class BlockRenderState {
  constructor() {
    this.parents = new Map();
    this.nodeLists = new Map();
  }
  nodeList(block) {
    return this.nodeLists.has(block) ? this.nodeLists.get(block) : block.nodeList;
  }
  static find(context) {
    for (const scope of context.scopes) if (scope.has("blockstate")) return scope.get("blockstate");
    return null;
  }
}
class BlockDrop extends LiquidDrop {
  constructor(block, out) {
    super();
    this.block = block;
    this.out = out;
  }
  async liquidGet(name, context) {
    if (name.toLowerCase() === "super") {
      await this.block.callSuper(context, this.out);
      return null;
    }
    return undefined;
  }
}
class BlockTag extends Block {
  initialize(engine, tagName, markup, tokens) {
    const m = WORD.exec(markup ?? "");
    if (!m) throw new LiquidSyntaxError("Syntax Error in 'block' tag - Valid syntax: block [name]");
    this.blockName = m[1];
    if (tokens) super.initialize(engine, tagName, markup, tokens);
    else {
      this.engine = engine;
      this.tagName = tagName;
      this.markup = markup;
    }
  }
  assertTagRules(rootNodeList) {
    for (const node of rootNodeList)
      if (node instanceof BlockTag && rootNodeList.filter((other) => other instanceof BlockTag && other.blockName === node.blockName).length > 1)
        throw new LiquidSyntaxError(`Liquid Error - Block '${node.blockName}' already defined`);
  }
  async render(context, out) {
    const state = BlockRenderState.find(context);
    await context.stack(async () => {
      context.set("block", new BlockDrop(this, out));
      await renderAll(state ? state.nodeList(this) : this.nodeList, context, out);
    });
  }
  addParent(parents, nodeList) {
    if (parents.has(this)) parents.get(this).addParent(parents, nodeList);
    else {
      const parent = new BlockTag();
      parent.initialize(this.engine, this.tagName, this.blockName, null);
      parent.nodeList = [...nodeList];
      parents.set(this, parent);
    }
  }
  async callSuper(context, out) {
    const state = BlockRenderState.find(context);
    const parent = state?.parents.get(this);
    if (parent) await parent.render(context, out);
  }
}
const EXTENDS_SYNTAX = re(`^(${QF})`);
export class ExtendsTag extends Block {
  parse(tokens) {
    const m = EXTENDS_SYNTAX.exec(this.markup);
    if (!m) throw new LiquidSyntaxError("Syntax Error in 'extends' tag - Valid syntax: extends [template]");
    this.templateName = m[1];
    super.parse(tokens);
  }
  assertMissingDelimitation() {}
  assertTagRules(rootNodeList) {
    if (!(rootNodeList[0] instanceof ExtendsTag)) throw new LiquidSyntaxError("Liquid Error - 'extends' must be the first tag in an extending template");
    for (const node of this.nodeList)
      if (!((typeof node === "string" && !node.trim()) || node instanceof BlockTag || node instanceof CommentTag || node instanceof ExtendsTag))
        throw new LiquidSyntaxError("Liquid Error - Only 'comment' and 'block' tags are allowed in an extending template");
    if (this.nodeList.some((node) => node instanceof ExtendsTag)) throw new LiquidSyntaxError("Liquid Error - 'extends' tag can be used only once");
  }
  async render(context, out) {
    const template = await this.engine.loadTemplate(context, this.templateName);
    const parentBlocks = findBlocks(template.root);
    const orphaned = context.scopes[0].get("extends") ?? [];
    const state = BlockRenderState.find(context) ?? new BlockRenderState();
    await context.stack(async () => {
      context.set("blockstate", state);
      context.set("extends", []);
      for (const block of [...this.nodeList.filter((node) => node instanceof BlockTag), ...orphaned]) {
        const parentBlock = parentBlocks.find((candidate) => candidate.blockName === block.blockName);
        if (parentBlock) {
          if (state.parents.has(block)) state.parents.set(parentBlock, state.parents.get(block));
          parentBlock.addParent(state.parents, state.nodeList(parentBlock));
          state.nodeLists.set(parentBlock, state.nodeList(block));
        } else if (template.root.nodeList.some((node) => node instanceof ExtendsTag)) context.scopes[0].get("extends").push(block);
      }
      await template.renderInto(context, out);
    });
  }
}
function findBlocks(node, blocks = []) {
  for (const child of node.nodeList ?? []) {
    if (child instanceof BlockTag && !blocks.some((block) => block.blockName === child.blockName)) blocks.push(child);
    if (child && typeof child === "object" && Array.isArray(child.nodeList)) findBlocks(child, blocks);
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Template and engine
// ---------------------------------------------------------------------------
export class Template {
  constructor(engine, root, source) {
    this.engine = engine;
    this.root = root;
    this.source = source;
  }
  async renderInto(context, out) {
    await this.root.render(context, out);
  }
  async render(context) {
    const out = [];
    await this.renderInto(context, out);
    return out.join("");
  }
}
export const STANDARD_TAGS = {
  assign: AssignTag,
  block: BlockTag,
  capture: CaptureTag,
  case: CaseTag,
  comment: CommentTag,
  cycle: CycleTag,
  extends: ExtendsTag,
  for: ForTag,
  break: BreakTag,
  continue: ContinueTag,
  if: IfTag,
  ifchanged: IfChangedTag,
  include: IncludeTag,
  literal: LiteralTag,
  unless: UnlessTag,
  raw: RawTag,
  increment: CounterTag,
  decrement: CounterTag,
  tablerow: TableRowTag,
};
export class LiquidEngine {
  constructor({
    tags = {},
    filters = {},
    filterSignatures = {},
    loadTemplateSource,
    maxIterations = 5_000_000,
    timeoutMs = 60_000,
    autoEncodeRoots = null,
  } = {}) {
    this.tags = new Map(Object.entries({ ...STANDARD_TAGS, ...tags }));
    this.filters = new Map(Object.entries(filters));
    this.filterSignatures = new Map(Object.entries(filterSignatures).map(([name, overloads]) => [name, overloads.map(parseFilterSignature)]));
    this.loadTemplateSource = loadTemplateSource;
    this.maxIterations = maxIterations;
    this.timeoutMs = timeoutMs;
    this.autoEncodeRoots = autoEncodeRoots;
    this.cache = new Map();
  }
  get rawTags() {
    return new Set([...this.tags].filter(([, type]) => type.prototype instanceof RawBlock).map(([name]) => name));
  }
  registerTag(name, type) {
    this.tags.set(name, type);
    this.cache.clear();
  }
  /** Registers a filter; `signatures` (Strainer overload texts) replaces its argument rules, null removes them. */
  registerFilter(name, implementation, signatures) {
    this.filters.set(name, implementation);
    if (signatures === null) this.filterSignatures.delete(name);
    else if (signatures !== undefined) this.filterSignatures.set(name, signatures.map(parseFilterSignature));
  }
  createTag(name) {
    const type = this.tags.get(name);
    return type ? new type() : null;
  }
  /** Template.Parse (throws LiquidSyntaxError). Parsed templates are cached by source. */
  parse(source) {
    const key = String(source ?? "");
    const cached = this.cache.get(key);
    if (cached) return cached;
    const template = new Template(this, new Document(this, tokenize(key, this.rawTags)), key);
    if (this.cache.size > 4000) this.cache.clear();
    this.cache.set(key, template);
    return template;
  }
  /** Resolve an include/extends name expression and parse the referenced template. */
  async loadTemplate(context, nameMarkup) {
    const name = await context.resolve(nameMarkup);
    const source = await this.loadTemplateSource(name == null ? null : typeof name === "string" ? name : formatItem(name), context);
    return this.parse(source);
  }
}
