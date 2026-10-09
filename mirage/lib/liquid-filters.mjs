// Liquid filters with Power Pages semantics.
//
// The catalogue combines DotLiquid StandardFilters at SyntaxCompatibility.DotLiquid20 with
// the portal filters Power Pages registers after them (Adxstudio Filters, DateFilters,
// EnumerableFilters, MathFilters, TypeFilters, StringFilters, NumberFormatFilters,
// UrlFilters, SearchFilterOptionFilters, EntityListFilters) and the documented
// html_safe_escape. Portal registrations replace DotLiquid filters with the same name
// (default, round, ceil, floor, concat, where). Parameter handling follows DotLiquid's
// Strainer: IConvertible arguments are converted with Convert.ChangeType and other
// mismatches raise the .NET exception that renders as "Liquid error: ...".
import {
  LiquidError,
  NetDecimal,
  isNumber,
  isDate,
  numberKind,
  toNumber,
  changeType,
  netTypeName,
  toInt32,
  toNetDecimal,
  decimalAdd,
  decimalMultiply,
  decimalDivide,
  decimalModulo,
  formatNetDate,
  dateToNetString,
  parseNetDate,
  htmlEncode,
  htmlDecode,
  securityElementEscape,
  webUrlEncode,
  webUrlDecode,
  antiXssUrlEncode,
  httpUtilityUrlDecode,
  netRegex,
  netRegexReplace,
  safeTypeInsensitiveEqual,
  numberToNetString,
  plainNumber,
} from "./liquid-dotnet.mjs";
import {
  LiquidHash,
  KeyValuePair,
  LiquidDrop,
  isEnumerable,
  toList,
  formatItem,
  isPlainObject,
  ownKey,
} from "./liquid-engine.mjs";

// ---------------------------------------------------------------------------
// Strainer signatures
// ---------------------------------------------------------------------------
/**
 * The parameter lists Power Pages' Strainer holds for each filter name: DotLiquid `master`
 * StandardFilters, then the Adxstudio classes in LiquidExtensions registration order (Filters,
 * DateFilters, EntityListFilters, EnumerableFilters, MathFilters, TypeFilters, StringFilters,
 * NumberFormatFilters, UrlFilters, SearchFilterOptionFilters), where a class replaces a name when
 * one of its methods has the same non-Context parameter count as an existing overload
 * (Strainer.Extend) and otherwise adds its overloads. One string per overload, in Strainer order:
 * `@context` is a Context parameter, `?` marks a parameter with a default value, and the first
 * other parameter is the filter input. LiquidContext.invokeFilter applies Strainer.Invoke's
 * argument-count rules with them; filters without an entry (json, html_safe_escape) are not checked.
 */
export const FILTER_SIGNATURES = Object.freeze({
  abs: ["@context, input"],
  add_query: ["url, parameterName, value"],
  all: ["input"],
  append: ["input, string"],
  at_least: ["@context, input, atLeast"],
  at_most: ["@context, input, atMost"],
  base: ["url"],
  base_currency: ["@context, value, format?"],
  base64_decode: ["input"],
  base64_encode: ["input"],
  base64_url_safe_decode: ["input"],
  base64_url_safe_encode: ["input"],
  batch: ["input, batchSize"],
  boolean: ["input"],
  capitalize: ["@context, input"],
  category_number: ["input, categoryNumber"],
  ceil: ["value"],
  compact: ["input"],
  concat: ["first, second"],
  currency: ["@context, input, languageTag?", "@context, value, record, attribute, format?"],
  current_sort: ["sortExpression, attribute"],
  date: ["@context, input, format"],
  date_add_days: ["date, value"],
  date_add_hours: ["date, value"],
  date_add_minutes: ["date, value"],
  date_add_months: ["date, value"],
  date_add_seconds: ["date, value"],
  date_add_years: ["date, value"],
  date_to_iso8601: ["date"],
  date_to_local: ["date"],
  date_to_rfc822: ["date"],
  date_to_utc: ["date"],
  date_to_xml_schema: ["date"],
  decimal: ["input"],
  decimals: ["number, decimals, culture?"],
  default: ["input, default"],
  divided_by: ["@context, input, operand"],
  downcase: ["input"],
  escape: ["input"],
  escape_once: ["input"],
  except: ["input, key, value"],
  file_size: ["value, precision?"],
  first: ["array"],
  floor: ["value"],
  format: ["number, format, culture?"],
  group_by: ["input, key"],
  h: ["input"],
  has_role: ["user, roleName"],
  host: ["url"],
  integer: ["input"],
  invariant_culture_decimal_value: ["number, decimals"],
  is_sitemap_ancestor: ["@context, url"],
  is_sitemap_current: ["@context, url"],
  join: ["input, glue?"],
  last: ["array"],
  liquid: ["@context, input"],
  lstrip: ["input"],
  map: ["enumerableInput, property"],
  max_decimals: ["number, decimals, culture?"],
  metafilters: ["entityList, query?, entityView?"],
  minus: ["@context, input, operand"],
  modulo: ["@context, input, operand"],
  newline_to_br: ["input"],
  order_by: ["input, key, direction?"],
  orderby: ["input, key, direction?"],
  paginate: ["input, index, count"],
  path: ["url"],
  path_and_query: ["url"],
  plus: ["@context, input, operand"],
  popular: ["input, pageSize, lang"],
  port: ["url"],
  prepend: ["input, string"],
  random: ["@context, input"],
  recent: ["input, pageSize, lang"],
  related: ["input, categoryIdString, pageSize"],
  remove: ["input, string"],
  remove_first: ["@context, input, string"],
  remove_query: ["url, parameterName"],
  replace: ["@context, input, string, replacement?"],
  replace_first: ["@context, input, string, replacement?"],
  reverse: ["input"],
  reverse_sort: ["sortDirection"],
  round: ["value, decimals?"],
  rstrip: ["input"],
  scheme: ["url"],
  search_filter_options: ["input"],
  select: ["input, key"],
  shuffle: ["@context, input"],
  size: ["input"],
  skip: ["input, count"],
  slice: ["@context, input, offset, length?"],
  sort: ["@context, input, property?"],
  sort_natural: ["input, property?"],
  split: ["input, pattern"],
  string: ["input"],
  strip: ["input"],
  strip_html: ["input"],
  strip_newlines: ["input"],
  take: ["input, count"],
  text_to_html: ["input, linkifyUrls?"],
  then_by: ["input, key, direction?"],
  thenby: ["input, key, direction?"],
  times: ["@context, input, operand"],
  top: ["input, pageSize, lang"],
  top_level: ["input, pageSize"],
  truncate: ["input, length?, truncateString?"],
  truncate_words: ["input, words?, truncateString?"],
  uniq: ["input"],
  upcase: ["input"],
  url_decode: ["input"],
  url_encode: ["input"],
  url_escape: ["input"],
  web_template: ["@context, input"],
  where: ["input, key, value"],
  xml_escape: ["input"],
});
// ---------------------------------------------------------------------------
// Strainer parameter conversion
// ---------------------------------------------------------------------------
const isConvertible = (value) =>
  typeof value === "string" || typeof value === "boolean" || isNumber(value) || isDate(value);
function cannotConvert(value, target) {
  return new LiquidError(`Object of type '${netTypeName(value)}' cannot be converted to type '${target}'.`, "System.ArgumentException");
}
/** Parameter of type System.String. */
export function asString(value) {
  if (value == null || typeof value === "string") return value ?? null;
  if (isConvertible(value)) return changeType(value, "string");
  throw cannotConvert(value, "System.String");
}
/** Parameter of type System.Int32 (null -> default(int) = 0). */
export function asInt(value) {
  if (value == null) return 0;
  if (isConvertible(value)) return toInt32(value);
  throw cannotConvert(value, "System.Int32");
}
/** Parameter of type System.Double. */
function asDouble(value) {
  if (value == null) return 0;
  if (typeof value === "string") return toNumber(changeType(value, "decimal"));
  if (typeof value === "boolean") return value ? 1 : 0;
  if (isNumber(value)) return toNumber(value);
  throw cannotConvert(value, "System.Double");
}
/** Parameter of type System.Collections.IEnumerable. */
function asEnumerable(value) {
  if (value == null) return null;
  if (isEnumerable(value)) return toList(value);
  if (isConvertible(value)) throw new LiquidError(`Invalid cast from '${netTypeName(value)}' to 'System.Collections.IEnumerable'.`, "System.InvalidCastException");
  throw cannotConvert(value, "System.Collections.IEnumerable");
}
/** Parameter of type System.Nullable<DateTime>. */
function asNullableDate(value) {
  if (value == null) return null;
  if (isDate(value)) return value;
  if (isConvertible(value))
    throw new LiquidError(
      `Invalid cast from '${netTypeName(value)}' to 'System.Nullable\`1[[System.DateTime, mscorlib, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089]]'.`,
      "System.InvalidCastException",
    );
  throw cannotConvert(value, "System.Nullable`1[System.DateTime]");
}
const isNullOrWhiteSpace = (value) => value == null || !String(value).trim();

// ---------------------------------------------------------------------------
// Math (DotLiquid DoMathsOperation, DotLiquid20 string rules)
// ---------------------------------------------------------------------------
function integerResult(value, kindA, kindB) {
  if (!Number.isSafeInteger(value)) throw new LiquidError("Arithmetic operation resulted in an overflow.", "System.OverflowException");
  if (kindA === "int" && kindB === "int" && (value < -2147483648 || value > 2147483647))
    throw new LiquidError("Arithmetic operation resulted in an overflow.", "System.OverflowException");
  return value;
}
function mathOperation(input, operand, operation) {
  if (input == null || operand == null) return null;
  const kindA = numberKind(input),
    kindB = numberKind(operand);
  if (!kindA || !kindB) {
    const symbol = { add: "Add", subtract: "Subtract", multiply: "Multiply", divide: "Divide", modulo: "Modulo" }[operation];
    throw new LiquidError(
      `The binary operator ${symbol} is not defined for the types '${netTypeName(input)}' and '${netTypeName(operand)}'.`,
      "System.InvalidOperationException",
    );
  }
  if (kindA === "decimal" || kindB === "decimal") {
    const result =
      operation === "add"
        ? decimalAdd(input, operand)
        : operation === "subtract"
          ? decimalAdd(input, operand, -1n)
          : operation === "multiply"
            ? decimalMultiply(input, operand)
            : operation === "divide"
              ? decimalDivide(input, operand)
              : decimalModulo(input, operand);
    return result;
  }
  const a = Number(input),
    b = Number(operand);
  switch (operation) {
    case "add":
      return integerResult(a + b, kindA, kindB);
    case "subtract":
      return integerResult(a - b, kindA, kindB);
    case "multiply":
      return integerResult(a * b, kindA, kindB);
    case "divide":
      if (b === 0) throw new LiquidError("Attempted to divide by zero.", "System.DivideByZeroException");
      return Math.trunc(a / b);
    default:
      if (b === 0) throw new LiquidError("Attempted to divide by zero.", "System.DivideByZeroException");
      return a % b;
  }
}
/** Math.Round(decimal, int) uses MidpointRounding.ToEven. */
function roundDecimal(value, decimals) {
  const decimal = NetDecimal.from(value);
  if (decimal.scale <= decimals) return decimal;
  const factor = 10n ** BigInt(decimal.scale - decimals);
  const quotient = decimal.mantissa / factor;
  const remainder = decimal.mantissa % factor;
  const twice = (remainder < 0n ? -remainder : remainder) * 2n;
  let rounded = quotient;
  if (twice > factor || (twice === factor && quotient % 2n !== 0n)) rounded += decimal.mantissa < 0n ? -1n : 1n;
  return new NetDecimal(rounded, decimals);
}
const toDecimalValue = (value) => (typeof value === "string" ? toNetDecimal(value) : toNetDecimal(value));
const decimalToInt = (decimal) => {
  const value = Number(decimal.toFixedString());
  if (value < -2147483648 || value > 2147483647) throw new LiquidError("Value was either too large or too small for an Int32.", "System.OverflowException");
  return value;
};

// ---------------------------------------------------------------------------
// Members used by where/except/group_by/order_by/select (EnumerableFilters.Get)
// ---------------------------------------------------------------------------
async function memberOf(item, key, context) {
  if (item == null || key == null) return null;
  if (item instanceof LiquidHash) return item.get(key) ?? null;
  if (isPlainObject(item) || item instanceof LiquidDrop) {
    const dot = key.indexOf(".");
    if (dot > 0 && dot < key.length - 1) return memberOf(await memberOf(item, key.slice(0, dot), context), key.slice(dot + 1), context);
    if (typeof item.liquidGet === "function") return (await item.liquidGet(key, context)) ?? null;
    const property = ownKey(item, key);
    return property === undefined ? null : (item[property] ?? null);
  }
  return null;
}
/** object.Equals without conversion (EnumerableFilters.KeyEquals). */
function strictEquals(a, b) {
  if (a == null) return b == null;
  if (b == null) return false;
  if (isNumber(a) && isNumber(b)) return numberKind(a) === numberKind(b) && safeTypeInsensitiveEqual(a, b);
  if (isDate(a) && isDate(b)) return a.getTime() === b.getTime();
  return a === b;
}
/** Comparer<object>.Default ordering used by LINQ OrderBy. */
function compareForOrder(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (isNumber(a) && isNumber(b)) return Math.sign(toNumber(a) - toNumber(b));
  if (isDate(a) && isDate(b)) return Math.sign(a.getTime() - b.getTime());
  if (typeof a === "string" && typeof b === "string") return Math.sign(COLLATOR.compare(a, b));
  if (typeof a === "boolean" && typeof b === "boolean") return a === b ? 0 : a ? 1 : -1;
  if (typeof a === typeof b) return 0;
  throw new LiquidError("Failed to compare two elements in the array.", "System.InvalidOperationException");
}
const COLLATOR = new Intl.Collator("en-US", { sensitivity: "variant" });
/**
 * StandardFilters.Sort/SortNatural at DotLiquid20: StringComparer.OrdinalIgnoreCase.Compare(object,
 * object) inside List.Sort. Strings compare ignoring case, characters ordinally, and values that are
 * not IComparable (hashes, arrays, drops) fail with List.Sort's "Failed to compare two elements".
 */
function sortCompare(a, b, characters) {
  if (a === b) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === "string" && typeof b === "string") {
    const left = characters ? a : a.toUpperCase(),
      right = characters ? b : b.toUpperCase();
    return left < right ? -1 : left > right ? 1 : 0;
  }
  const comparable = (item) => typeof item === "string" || typeof item === "boolean" || isNumber(item) || isDate(item);
  if (!comparable(a) || !comparable(b)) throw new LiquidError("Failed to compare two elements in the array.", "System.InvalidOperationException");
  return compareForOrder(a, b);
}
class OrderedList extends Array {}
async function orderBy(items, key, direction, context, previous) {
  const desc = /^(desc|descending)$/i.test(String(direction ?? ""));
  const keyed = [];
  for (const [index, item] of items.entries()) keyed.push({ item, index, value: await memberOf(item, key, context), prior: previous?.get(item) });
  keyed.sort((x, y) => {
    if (x.prior !== undefined && y.prior !== undefined && x.prior !== y.prior) return x.prior - y.prior;
    const order = compareForOrder(x.value, y.value);
    return (desc ? -order : order) || x.index - y.index;
  });
  const result = OrderedList.from(keyed.map((entry) => entry.item));
  const ranks = new Map();
  let rank = -1,
    last;
  keyed.forEach((entry, index) => {
    const signature = `${entry.prior}|${index === 0 ? "" : compareForOrder(last.value, entry.value)}`;
    if (index === 0 || entry.prior !== last.prior || compareForOrder(last.value, entry.value) !== 0) rank++;
    ranks.set(entry.item, rank);
    last = entry;
    void signature;
  });
  result.ranks = ranks;
  return result;
}

// ---------------------------------------------------------------------------
// URL helpers (Microsoft.Xrm.Portal UrlBuilder / QueryStringCollection)
// ---------------------------------------------------------------------------
const PLACEHOLDER = "http://example.com";
function parseUrl(url) {
  const text = String(url);
  try {
    if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return { absolute: true, url: new URL(text) };
    return { absolute: false, url: new URL(text, `${PLACEHOLDER}/`) };
  } catch {
    return null;
  }
}
function queryPairs(search) {
  const pairs = [];
  const query = search.startsWith("?") ? search.slice(1) : search;
  if (!query) return pairs;
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const index = pair.indexOf("=");
    if (index >= 0) pairs.push([httpUtilityUrlDecode(pair.slice(0, index)), httpUtilityUrlDecode(pair.slice(index + 1))]);
    else pairs.push([null, httpUtilityUrlDecode(pair)]);
  }
  return pairs;
}
function buildQuery(pairs) {
  // NameValueCollection groups values by case-insensitive key in first-seen order.
  const groups = [];
  for (const [key, value] of pairs) {
    const group = groups.find((entry) => (entry.key ?? "").toLowerCase() === (key ?? "").toLowerCase() && (entry.key == null) === (key == null));
    if (group) group.values.push(value);
    else groups.push({ key, values: [value] });
  }
  const parts = [];
  for (const group of groups)
    for (const value of group.values)
      if (group.key) parts.push(`${antiXssUrlEncode(group.key)}=${value == null ? "" : antiXssUrlEncode(value)}`);
      else parts.push(antiXssUrlEncode(value ?? ""));
  return parts.length ? `?${parts.join("&")}` : "";
}
/**
 * add_query/remove_query: the query is rebuilt through QueryStringCollection (decoded, then
 * AntiXSS-encoded). Absolute input yields Uri.AbsoluteUri; relative input keeps its own
 * path text and fragment (portal navigation may prefix the result with "../").
 */
function rebuild(url, mutate) {
  if (url == null) return null;
  const text = String(url);
  const hashIndex = text.indexOf("#");
  const fragment = hashIndex >= 0 ? text.slice(hashIndex) : "";
  const beforeHash = hashIndex >= 0 ? text.slice(0, hashIndex) : text;
  const queryIndex = beforeHash.indexOf("?");
  const path = queryIndex >= 0 ? beforeHash.slice(0, queryIndex) : beforeHash;
  const search = queryIndex >= 0 ? beforeHash.slice(queryIndex) : "";
  try {
    const query = buildQuery(mutate(queryPairs(search)));
    if (/^[a-z][a-z0-9+.-]*:/i.test(text)) {
      const parsed = new URL(text);
      return `${parsed.origin}${parsed.pathname}${query}${parsed.hash}`;
    }
    return `${path}${query}${fragment}`;
  } catch {
    return text;
  }
}
const portOf = (url) => {
  if (url.port) return Number(url.port);
  return { "http:": 80, "https:": 443, "ftp:": 21 }[url.protocol] ?? -1;
};

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------
/** TextInfo.ToTitleCase (en-US): words in all capitals are kept. */
function toTitleCase(input) {
  return input.replace(/[\p{L}\p{Mn}\p{Nd}']+/gu, (word) => {
    if (word === word.toUpperCase() && /\p{L}/u.test(word)) return word;
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  });
}
/** Adxstudio SimpleHtmlFormatter (text_to_html). */
function simpleHtml(input, linkify = true) {
  let text = htmlEncode(input);
  if (linkify)
    text = text.replace(/http(s?):\/\/\S+[/\p{L}\p{Mn}\p{Nd}\p{Pc}]/giu, (match) => {
      try {
        const url = new URL(match);
        return `<a href="${htmlEncode(url.href)}" rel="nofollow">${htmlEncode(url.href)}</a>`;
      } catch {
        return match;
      }
    });
  return text
    .split(/\r\n\r\n|\n\n/)
    .filter((block) => block !== "")
    .map((block) => `<p>${block.replace(/\r\n/g, "<br />").replace(/\n/g, "<br />")}</p>`)
    .join("");
}
/** Adxstudio FileSize.ToString(precision). */
function fileSize(value, precision) {
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  const bytes = Math.max(0, Math.trunc(toNumber(value)));
  let pow = Math.floor((bytes > 0 ? Math.log(bytes) : 0) / Math.log(1024));
  pow = Math.min(pow, units.length - 1);
  const scaled = bytes / 1024 ** pow;
  return `${pow === 0 ? scaled.toFixed(0) : scaled.toFixed(precision)} ${units[pow]}`;
}
/** decimal.ToString("N<decimals>", en-US) with AwayFromZero midpoint formatting. */
function formatN(value, decimals) {
  const decimal = NetDecimal.from(value);
  const scaled = decimal.scale > decimals ? (() => {
    const factor = 10n ** BigInt(decimal.scale - decimals);
    let q = decimal.mantissa / factor;
    const r = decimal.mantissa % factor;
    if ((r < 0n ? -r : r) * 2n >= factor) q += decimal.mantissa < 0n ? -1n : 1n;
    return new NetDecimal(q, decimals);
  })() : new NetDecimal(decimal.mantissa * 10n ** BigInt(decimals - decimal.scale), decimals);
  const text = scaled.toFixedString();
  const negative = text.startsWith("-");
  const [whole, fraction] = text.replace("-", "").split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${fraction ? `.${fraction}` : ""}`;
}
/** .NET numeric format strings used by the `format` filter (subset: N/F/C/P/D and custom 0/#). */
function formatNumberString(value, format) {
  const decimal = NetDecimal.from(value);
  const m = /^([NnFfCcPpDd])(\d*)$/.exec(format ?? "");
  if (m) {
    const precision = m[2] === "" ? (/[Dd]/.test(m[1]) ? 0 : 2) : Number(m[2]);
    if (/[Nn]/.test(m[1])) return formatN(decimal, precision);
    if (/[Ff]/.test(m[1])) return formatN(decimal, precision).replace(/,/g, "");
    if (/[Cc]/.test(m[1])) {
      const text = formatN(decimal, precision);
      return text.startsWith("-") ? `($${text.slice(1)})` : `$${text}`;
    }
    if (/[Pp]/.test(m[1])) return `${formatN(decimalMultiply(decimal, 100), precision)} %`;
    return String(Math.trunc(decimal.valueOf())).padStart(precision, "0");
  }
  if (/^[0#,.]+$/.test(format ?? "")) {
    const [, fractionPattern = ""] = format.split(".");
    const required = (fractionPattern.match(/0/g) ?? []).length;
    const optional = (fractionPattern.match(/#/g) ?? []).length;
    let text = formatN(decimal, required + optional);
    if (!format.includes(",")) text = text.replace(/,/g, "");
    if (optional) {
      const [whole, fraction = ""] = text.split(".");
      const trimmed = fraction.slice(0, required) + fraction.slice(required).replace(/0+$/, "");
      text = trimmed ? `${whole}.${trimmed}` : whole;
    }
    return text;
  }
  throw new LiquidError("Format specifier was invalid.", "System.FormatException");
}

// ---------------------------------------------------------------------------
// html_safe_escape: closest local equivalent of the managed HTML sanitizer.
// ---------------------------------------------------------------------------
function sanitizeHtml(input) {
  return String(input)
    // Unsafe elements are dropped with their content, then any unpaired unsafe tag.
    .replace(/<(script|style|iframe|object|embed|applet|frame|frameset)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<\/?(script|style|iframe|object|embed|applet|frame|frameset|meta|link|base)\b[^>]*>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s+(href|src|action|formaction)\s*=\s*(["']?)\s*(?:javascript|vbscript|data):[^"'>\s]*\2/gi, "");
}

// ---------------------------------------------------------------------------
// json (observed on reference-portal, parity probes liquid-json-* and liquid-reports-*):
// - a value from a user or request root (the values the platform HTML-encodes on output) passes
//   through verbatim: untrimmed, unquoted, unescaped ('-', ' - ', '"-"', '[]', 'true', '1.50', '01');
//   the output is then HTML-encoded like other request output;
// - other strings lose their surrounding whitespace and are wrapped in double quotes without any
//   escaping: a capture holding only the line breaks DotLiquid20 whitespace control leaves renders
//   "", the report configurations render "" "" (stored " ") and "`…"…"…`" (a backtick-delimited
//   multi-line text with inner double quotes, raw newlines and tabs, no backslash);
// - other values are written like Json.NET defaults: nil as null, booleans and numbers as JSON, ISO
//   dates, nested arrays and objects; a self-referencing graph raises Json.NET's loop error.
// ---------------------------------------------------------------------------
// Json.NET also escapes NEL, LINE SEPARATOR and PARAGRAPH SEPARATOR.
const JSON_EXTRA_ESCAPES = new RegExp(`[${String.fromCharCode(0x85, 0x2028, 0x2029)}]`, "g");
const jsonString = (text) =>
  JSON.stringify(text).replace(JSON_EXTRA_ESCAPES, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
function jsonDate(date) {
  const iso = date.toISOString();
  return iso.endsWith(".000Z") ? `${iso.slice(0, -5)}Z` : iso;
}
function jsonSerialize(value, seen, property = null) {
  if (value == null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (isNumber(value)) return numberToNetString(value);
  if (isDate(value)) return jsonString(jsonDate(value));
  if (typeof value === "string") return jsonString(value);
  if (typeof value !== "object") return "null";
  if (seen.has(value))
    throw new LiquidError(`Self referencing loop detected${property ? ` for property '${property}'` : ""}.`, "Newtonsoft.Json.JsonSerializationException");
  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => jsonSerialize(item, seen)).join(",")}]`;
    if (value instanceof KeyValuePair) return `{"Key":${jsonString(String(value.key))},"Value":${jsonSerialize(value.value, seen, "Value")}}`;
    const entries =
      value instanceof LiquidHash
        ? [...value.entries()]
        : value instanceof LiquidDrop
          ? []
          : Object.entries(value).filter(([key, item]) => !key.startsWith("__") && typeof item !== "function" && item !== undefined);
    return `{${entries.map(([key, item]) => `${jsonString(String(key))}:${jsonSerialize(item, seen, key)}`).join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

// ---------------------------------------------------------------------------
// Filter catalogue
// ---------------------------------------------------------------------------
/** `this` is the LiquidContext for every filter. */
export function createFilters(host = {}) {
  const filters = {
    // ---- DotLiquid StandardFilters (DotLiquid20) ----
    size: (input) => (typeof input === "string" ? input.length : isEnumerable(input) ? toList(input).length : 0),
    slice(input, offset, length = 1) {
      const start = asInt(offset),
        len = asInt(length ?? 1);
      if (typeof input === "string") {
        let s = start,
          l = len;
        if (s > input.length) return null;
        if (s < 0) {
          s += input.length;
          if (s < 0) {
            l = Math.max(0, l + s);
            s = 0;
          }
        }
        if (s + l > input.length) l = input.length - s;
        return input.substr(s, l);
      }
      if (isEnumerable(input)) {
        const list = toList(input);
        let skip = start,
          take = len;
        if (start < 0) {
          if (Math.abs(start) < list.length) skip = list.length + start;
          else {
            skip = 0;
            take = list.length + start + len;
          }
        }
        return list.slice(skip, skip + Math.max(0, take));
      }
      return input;
    },
    downcase: (input) => {
      const s = asString(input);
      return s == null ? s : s.toLowerCase();
    },
    upcase: (input) => {
      const s = asString(input);
      return s == null ? s : s.toUpperCase();
    },
    url_encode: (input) => {
      const s = asString(input);
      return s == null ? s : webUrlEncode(s);
    },
    url_decode: (input) => {
      const s = asString(input);
      return s == null ? s : webUrlDecode(s);
    },
    capitalize: (input) => {
      const s = asString(input);
      return isNullOrWhiteSpace(s) ? s : toTitleCase(s);
    },
    escape: (input) => {
      const s = asString(input);
      return s == null || s === "" ? s : htmlEncode(s);
    },
    // StandardFilters.H: alias of Escape (documented by Power Pages as "h").
    h: (input) => {
      const s = asString(input);
      return s == null || s === "" ? s : htmlEncode(s);
    },
    escape_once: (input) => {
      const s = asString(input);
      return s == null || s === "" ? s : htmlEncode(htmlDecode(s));
    },
    truncate(input, length = 50, truncateString = "...") {
      const s = asString(input);
      if (s == null || s === "") return s;
      const max = arguments.length > 1 ? asInt(length) : 50;
      const tail = arguments.length > 2 ? (asString(truncateString) ?? "") : "...";
      if (max < 0) return tail;
      const keep = max - tail.length;
      return s.length > max ? s.slice(0, keep < 0 ? 0 : keep) + tail : s;
    },
    truncate_words(input, words = 15, truncateString = "...") {
      const s = asString(input);
      if (s == null || s === "") return s;
      const count = arguments.length > 1 ? asInt(words) : 15;
      const tail = arguments.length > 2 ? (asString(truncateString) ?? "") : "...";
      if (count <= 0) return tail;
      const list = s.split(" ");
      return list.length > count ? list.slice(0, count).join(" ") + tail : s;
    },
    split(input, pattern) {
      const s = asString(input);
      if (isNullOrWhiteSpace(s)) return [s];
      const separator = asString(pattern);
      if (separator == null || separator === "") return [...s];
      return s.split(separator).filter((part) => part !== "");
    },
    strip_html: (input) => {
      const s = asString(input);
      if (isNullOrWhiteSpace(s)) return s;
      return s.replace(/<script[\s\S]*?<\/script>|<!--[\s\S]*?-->|<style[\s\S]*?<\/style>/gi, "").replace(/<[\s\S]*?>/g, "");
    },
    strip: (input) => {
      const s = asString(input);
      return s == null ? s : s.trim();
    },
    lstrip: (input) => {
      const s = asString(input);
      return s == null ? s : s.trimStart();
    },
    rstrip: (input) => {
      const s = asString(input);
      return s == null ? s : s.trimEnd();
    },
    strip_newlines: (input) => {
      const s = asString(input);
      return isNullOrWhiteSpace(s) ? s : s.replace(/\r?\n/g, "");
    },
    join(input, glue = " ") {
      const list = asEnumerable(input);
      if (list == null) return null;
      const separator = arguments.length > 1 ? (asString(glue) ?? "") : " ";
      return list.map(formatItem).join(separator);
    },
    sort(input, property) {
      if (input == null) return null;
      const list = isEnumerable(input) ? [...toList(input)].flat(Infinity) : [input];
      const key = asString(property);
      // A string input sorts its characters, which compare ordinally (char.CompareTo).
      const characters = typeof input === "string";
      const value = (item) => (key ? (item instanceof LiquidHash ? item.get(key) : isPlainObject(item) ? item[ownKey(item, key) ?? key] : null) : item);
      return list
        .map((item, index) => ({ item, index }))
        .sort((x, y) => sortCompare(value(x.item), value(y.item), characters) || x.index - y.index)
        .map((entry) => entry.item);
    },
    sort_natural(input, property) {
      return filters.sort.call(this, input, property);
    },
    async map(input, property) {
      const list = asEnumerable(input);
      if (list == null) return null;
      const key = asString(property);
      const result = [];
      for (const item of list) result.push(await memberOf(item, key, this));
      return result;
    },
    replace(input, search, replacement = "") {
      const s = asString(input),
        pattern = asString(search);
      if (s == null || s === "" || pattern == null || pattern === "") return s;
      return netRegexReplace(s, pattern, asString(replacement) ?? "");
    },
    replace_first(input, search, replacement = "") {
      const s = asString(input),
        pattern = asString(search);
      if (s == null || s === "" || pattern == null || pattern === "") return s;
      return netRegexReplace(s, pattern, asString(replacement) ?? "", { first: true });
    },
    remove(input, search) {
      const s = asString(input);
      if (isNullOrWhiteSpace(s)) return s;
      const pattern = asString(search);
      if (pattern == null || pattern === "") throw new LiquidError("String cannot be of zero length.\r\nParameter name: oldValue", "System.ArgumentException");
      return s.split(pattern).join("");
    },
    remove_first(input, search) {
      const s = asString(input);
      if (isNullOrWhiteSpace(s)) return s;
      return filters.replace_first.call(this, s, search, "");
    },
    // master: $"{input}{@string}" and $"{@string}{input}" (nil renders as nothing).
    append(input, value) {
      const s = asString(input) ?? "";
      return s + (asString(value) ?? "");
    },
    prepend(input, value) {
      const s = asString(input) ?? "";
      return (asString(value) ?? "") + s;
    },
    newline_to_br: (input) => {
      const s = asString(input);
      return isNullOrWhiteSpace(s) ? s : s.replace(/(\r?\n)/g, "<br />$1");
    },
    date(input, format) {
      if (input == null) return null;
      const pattern = asString(format);
      if (isDate(input)) return isNullOrWhiteSpace(pattern) ? dateToNetString(input) : formatNetDate(input, pattern);
      const value = formatItem(input);
      let date;
      if (/^(now|today)$/i.test(value)) {
        date = new Date();
        if (isNullOrWhiteSpace(pattern)) return dateToNetString(date);
      } else {
        date = parseNetDate(value);
        if (!date) return value;
      }
      if (isNullOrWhiteSpace(pattern)) return value;
      return formatNetDate(date, pattern);
    },
    first(input) {
      const list = asEnumerable(input);
      return list == null ? null : (list[0] ?? null);
    },
    last(input) {
      const list = asEnumerable(input);
      return list == null ? null : (list.at(-1) ?? null);
    },
    plus(input, operand) {
      // DotLiquid20: a string input concatenates (string.Concat uses object.ToString()).
      if (typeof input === "string") return input + netToString(operand);
      return mathOperation(input, operand, "add");
    },
    minus: (input, operand) => mathOperation(input, operand, "subtract"),
    times(input, operand) {
      if (typeof input === "string" && numberKind(operand) && numberKind(operand) !== "decimal")
        return Array.from({ length: Math.max(0, Number(operand)) }, () => input);
      return mathOperation(input, operand, "multiply");
    },
    divided_by: (input, operand) => mathOperation(input, operand, "divide"),
    modulo: (input, operand) => mathOperation(input, operand, "modulo"),
    uniq(input) {
      if (input == null) return null;
      const list = isEnumerable(input) ? [...toList(input)].flat(Infinity) : [input];
      const result = [];
      for (const item of list) if (!result.some((existing) => strictEquals(existing, item) || existing === item)) result.push(item);
      return result;
    },
    abs(input) {
      const parsed = Number(String(formatItem(input)).replace(/,/g, ""));
      return Number.isFinite(parsed) ? Math.abs(parsed) : 0;
    },
    at_least(input, minimum) {
      const n = Number(formatItem(input)),
        min = Number(formatItem(minimum));
      return Number.isFinite(n) && Number.isFinite(min) ? Math.max(n, min) : input;
    },
    at_most(input, maximum) {
      const n = Number(formatItem(input)),
        max = Number(formatItem(maximum));
      return Number.isFinite(n) && Number.isFinite(max) ? Math.min(n, max) : input;
    },
    compact(input) {
      if (input == null) return null;
      const list = isEnumerable(input) ? [...toList(input)].flat(Infinity) : [input];
      return list.filter((item) => item != null);
    },
    reverse(input) {
      if (input == null || typeof input === "string") return input;
      const list = asEnumerable(input);
      return [...list].reverse();
    },
    base64_encode: (input) => (input == null ? "" : Buffer.from(asString(input), "utf8").toString("base64")),
    base64_decode(input) {
      if (input == null) return "";
      const text = asString(input);
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) throw new LiquidError("Invalid base64 provided to base64_decode", "System.ArgumentException");
      return Buffer.from(text, "base64").toString("utf8");
    },
    base64_url_safe_encode: (input) => (input == null ? "" : Buffer.from(asString(input), "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_")),
    base64_url_safe_decode(input) {
      if (input == null || input === "") return "";
      let text = asString(input).replace(/_/g, "/").replace(/-/g, "+");
      if (!text.endsWith("=")) text += text.length % 4 === 2 ? "==" : text.length % 4 === 3 ? "=" : "";
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) throw new LiquidError("Invalid base64 provided to base64_url_safe_decode", "System.ArgumentException");
      return Buffer.from(text, "base64").toString("utf8");
    },
    currency(input, languageTag) {
      if (input == null) return null;
      void languageTag;
      if (isNumber(input)) return formatNumberString(input, "C");
      try {
        return formatNumberString(toNetDecimal(String(input).replace(/[$\s]/g, "")), "C");
      } catch {
        return formatItem(input);
      }
    },

    // ---- Adxstudio Filters ----
    default: (input, fallback) => input ?? fallback ?? null,
    file_size(value, precision = 1) {
      if (value == null) return null;
      return fileSize(asDouble(value), arguments.length > 1 ? asInt(precision) : 1);
    },
    has_role(user, roleName) {
      if (user == null) return false;
      if (typeof user.liquidHasRole === "function") return user.liquidHasRole(asString(roleName));
      const roles = isPlainObject(user) ? user.roles : null;
      return (Array.isArray(roles) ? roles : []).some((role) => (typeof role === "object" && role ? role.name : role) === asString(roleName));
    },
    async liquid(input) {
      if (input == null) return null;
      return host.renderLiquid ? host.renderLiquid(formatItem(input), this) : formatItem(input);
    },
    async web_template(input) {
      if (input == null || !host.renderWebTemplate) return null;
      const id = isPlainObject(input) ? input.id : formatItem(input);
      return host.renderWebTemplate(id, this);
    },

    // ---- Adxstudio DateFilters ----
    date_add_days: (date, value) => addTime(date, asDouble(value) * 86400000),
    date_add_hours: (date, value) => addTime(date, asDouble(value) * 3600000),
    date_add_minutes: (date, value) => addTime(date, asDouble(value) * 60000),
    date_add_seconds: (date, value) => addTime(date, asDouble(value) * 1000),
    date_add_months: (date, value) => addMonths(date, asInt(value)),
    date_add_years: (date, value) => addMonths(date, asInt(value) * 12),
    date_to_local: (date) => asNullableDate(date),
    date_to_utc: (date) => asNullableDate(date),
    date_to_iso8601(date) {
      const value = asNullableDate(date);
      return value == null ? null : `${formatNetDate(value, "s")}Z`;
    },
    date_to_xml_schema(date) {
      const value = asNullableDate(date);
      return value == null ? null : `${formatNetDate(value, "s")}Z`;
    },
    date_to_rfc822(date) {
      const value = asNullableDate(date);
      return value == null ? null : formatNetDate(value, "ddd, dd MMM yyyy HH:mm:ss 'Z'");
    },

    // ---- Adxstudio EntityListFilters ----
    current_sort(sortExpression, attribute) {
      const expression = asString(sortExpression),
        name = asString(attribute);
      if (!expression || !name) return null;
      const match = netRegex(`${name} (?<direction>ASC|DESC)`, "i").exec(expression);
      return match ? match.groups.direction.toUpperCase() : null;
    },
    reverse_sort(direction) {
      const value = asString(direction);
      if (!value) return null;
      if (value.trim().toLowerCase() === "asc") return "DESC";
      if (value.trim().toLowerCase() === "desc") return "ASC";
      return null;
    },
    async metafilters(entityList, query, entityView) {
      return host.metafilters ? host.metafilters(entityList, asString(query), entityView, this) : [];
    },

    // ---- Adxstudio EnumerableFilters ----
    all: (input) => input,
    batch(input, batchSize) {
      const list = asEnumerable(input) ?? [];
      const size = asInt(batchSize);
      if (size <= 0) throw new LiquidError("Specified argument was out of the range of valid values.\r\nParameter name: size", "System.ArgumentOutOfRangeException");
      const batches = [];
      for (let index = 0; index < list.length; index += size) batches.push(list.slice(index, index + size));
      return batches;
    },
    concat(first, second) {
      const left = first == null ? [] : asEnumerable(first);
      return isEnumerable(second) ? [...left, ...toList(second)] : [...left, second];
    },
    async except(input, key, value) {
      const list = asEnumerable(input) ?? [];
      const result = [];
      for (const item of list) if (!strictEquals(await memberOf(item, asString(key), this), value)) result.push(item);
      return result;
    },
    async group_by(input, key) {
      const list = asEnumerable(input) ?? [];
      const groups = [];
      for (const item of list) {
        const groupKey = await memberOf(item, asString(key), this);
        let group = groups.find((entry) => strictEquals(entry.key, groupKey));
        if (!group) groups.push((group = { key: groupKey, items: [] }));
        group.items.push(item);
      }
      return groups.map((group) => new LiquidHash({ key: group.key, items: group.items }));
    },
    async order_by(input, key, direction = "asc") {
      if (!isEnumerable(input) && !Array.isArray(input)) return input;
      return orderBy(toList(input), asString(key), asString(direction), this);
    },
    async orderby(input, key, direction = "asc") {
      return filters.order_by.call(this, input, key, direction);
    },
    async then_by(input, key, direction = "asc") {
      if (!(input instanceof OrderedList))
        throw new LiquidError(`Object of type '${netTypeName(input)}' cannot be converted to type 'System.Linq.IOrderedEnumerable\`1[System.Object]'.`, "System.ArgumentException");
      return orderBy([...input], asString(key), asString(direction), this, input.ranks);
    },
    async thenby(input, key, direction = "asc") {
      return filters.then_by.call(this, input, key, direction);
    },
    paginate(input, index, count) {
      if (!isEnumerable(input)) return input;
      const start = asInt(index);
      return toList(input).slice(Math.max(0, start), Math.max(0, start) + Math.max(0, asInt(count)));
    },
    random(input) {
      const list = asEnumerable(input) ?? [];
      if (!list.length) throw new LiquidError("Specified argument was out of the range of valid values.", "System.ArgumentOutOfRangeException");
      return list[Math.floor(Math.random() * list.length)];
    },
    async select(input, key) {
      const list = asEnumerable(input) ?? [];
      const result = [];
      for (const item of list) result.push(await memberOf(item, asString(key), this));
      return result;
    },
    shuffle(input) {
      const list = [...(asEnumerable(input) ?? [])];
      for (let i = 0; i < list.length; i++) {
        const j = i + Math.floor(Math.random() * (list.length - i));
        [list[i], list[j]] = [list[j], list[i]];
      }
      return list;
    },
    skip: (input, count) => (isEnumerable(input) ? toList(input).slice(Math.max(0, asInt(count))) : input),
    take: (input, count) => (isEnumerable(input) ? toList(input).slice(0, Math.max(0, asInt(count))) : input),
    async where(input, key, value) {
      const list = asEnumerable(input) ?? [];
      const result = [];
      for (const item of list) if (strictEquals(await memberOf(item, asString(key), this), value)) result.push(item);
      return result;
    },
    top_level(input, pageSize) {
      return host.knowledge?.topLevel ? host.knowledge.topLevel(input, asInt(pageSize)) : input;
    },
    category_number(input, categoryNumber) {
      return host.knowledge?.categoryNumber ? host.knowledge.categoryNumber(input, asString(categoryNumber)) : input;
    },
    related: (input) => input,
    top: (input) => input,
    recent: (input) => input,
    popular: (input) => input,

    // ---- Adxstudio MathFilters ----
    ceil(value) {
      if (value == null) return 0;
      const decimal = toDecimalValue(value);
      const scaled = decimal.scale ? decimal.mantissa / 10n ** BigInt(decimal.scale) : decimal.mantissa;
      const ceiling = decimal.scale && decimal.mantissa > 0n && decimal.mantissa % 10n ** BigInt(decimal.scale) !== 0n ? scaled + 1n : scaled;
      return decimalToInt(new NetDecimal(ceiling, 0));
    },
    floor(value) {
      if (value == null) return 0;
      const decimal = toDecimalValue(value);
      const scaled = decimal.scale ? decimal.mantissa / 10n ** BigInt(decimal.scale) : decimal.mantissa;
      const floor = decimal.scale && decimal.mantissa < 0n && decimal.mantissa % 10n ** BigInt(decimal.scale) !== 0n ? scaled - 1n : scaled;
      return decimalToInt(new NetDecimal(floor, 0));
    },
    round(value, decimals = 0) {
      if (value == null) return 0;
      const places = arguments.length > 1 ? asInt(decimals) : 0;
      const number = toDecimalValue(value);
      // Math.Round(decimal, int) accepts 0 to 28 decimals.
      if (places < 0 || places > 28)
        throw new LiquidError("Decimal can only round to between 0 and 28 digits of precision.\r\nParameter name: decimals", "System.ArgumentOutOfRangeException");
      const rounded = roundDecimal(number, places);
      return places === 0 ? decimalToInt(rounded) : rounded;
    },

    // ---- Adxstudio TypeFilters ----
    boolean(input) {
      if (input == null) return null;
      try {
        if (typeof input === "boolean") return input;
        if (isNumber(input)) return toNumber(input) !== 0;
        if (typeof input === "string") {
          const text = input.trim().toLowerCase();
          if (text === "true") return true;
          if (text === "false") return false;
        }
      } catch {
        // FormatException/InvalidCastException fall through to the named values.
      }
      const mapped = { on: true, enabled: true, yes: true, off: false, disabled: false, no: false }[formatItem(input).toLowerCase()];
      return mapped ?? null;
    },
    decimal(input) {
      if (input == null) return null;
      try {
        if (isDate(input) || !isConvertibleForNumber(input)) return null;
        return toNetDecimal(input);
      } catch {
        return null;
      }
    },
    integer(input) {
      if (input == null) return null;
      try {
        if (!isConvertibleForNumber(input)) return null;
        return toInt32(input);
      } catch {
        return null;
      }
    },
    string(input) {
      if (input == null) return "";
      if (typeof input === "string") return input;
      if (typeof input === "boolean") return input ? "True" : "False";
      if (isNumber(input)) return numberToNetString(input);
      if (isDate(input)) return dateToNetString(input);
      return formatItem(input);
    },

    // ---- Adxstudio StringFilters ----
    text_to_html(input, linkifyUrls = true) {
      const s = asString(input);
      if (s == null) return null;
      return simpleHtml(s, arguments.length > 1 ? linkifyUrls !== false && linkifyUrls !== "false" : true);
    },
    url_escape: (input) => {
      const s = asString(input);
      return s == null ? null : webUrlEncode(s);
    },
    json(input) {
      if (typeof input !== "string") return jsonSerialize(input, new Set());
      if (this?.encodedFilterSource) return input;
      return `"${input.trim()}"`;
    },
    xml_escape: (input) => {
      const s = asString(input);
      return s == null ? null : securityElementEscape(s);
    },
    html_safe_escape: (input) => {
      const s = asString(input);
      return s == null ? null : sanitizeHtml(s);
    },

    // ---- Adxstudio NumberFormatFilters (en-US current UI culture) ----
    format(number, format) {
      return formatNumberString(toNetDecimal(number), asString(format));
    },
    decimals(number, decimals) {
      return formatN(toNetDecimal(number), asInt(decimals));
    },
    max_decimals(number, decimals) {
      let result = formatN(toNetDecimal(number), asInt(decimals));
      if (result.includes(".")) result = result.replace(/0+$/, "").replace(/\.$/, "");
      return result;
    },
    invariant_culture_decimal_value(number, decimals) {
      if (arguments.length < 2) throw new LiquidError("Error - Filter 'invariant_culture_decimal_value' does not have a default value for 'decimals' and no value was supplied", "DotLiquid.Exceptions.SyntaxException");
      return roundDecimal(toNetDecimal(number ?? 0), asInt(decimals)).toFixedString();
    },
    base_currency: (value) => formatNumberString(toNetDecimal(value ?? 0), "C"),

    // ---- Adxstudio UrlFilters ----
    add_query(url, parameterName, value) {
      const target = asString(url);
      if (target == null) return null;
      const name = asString(parameterName);
      if (isNullOrWhiteSpace(name)) return target;
      const text = value == null ? "" : formatItem(value);
      return rebuild(target, (pairs) => {
        const existing = pairs.filter(([key]) => key != null && key.toLowerCase() === name.toLowerCase());
        if (existing.length) {
          const first = pairs.indexOf(existing[0]);
          const remaining = pairs.filter((pair) => !existing.includes(pair));
          remaining.splice(first - pairs.slice(0, first).filter((pair) => existing.includes(pair)).length, 0, [existing[0][0], text]);
          return remaining;
        }
        return [...pairs, [name, text]];
      });
    },
    remove_query(url, parameterName) {
      const target = asString(url);
      if (target == null) return null;
      const name = asString(parameterName);
      if (isNullOrWhiteSpace(name)) return target;
      return rebuild(target, (pairs) => pairs.filter(([key]) => key == null || key.toLowerCase() !== name.toLowerCase()));
    },
    base(url) {
      const target = asString(url);
      if (target == null) return null;
      try {
        if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) return null;
        const parsed = new URL(target);
        return `${parsed.protocol}//${parsed.host}`;
      } catch {
        return null;
      }
    },
    host(url) {
      return urlPart(url, this, (u) => u.hostname);
    },
    path(url) {
      return urlPart(url, this, (u) => u.pathname);
    },
    port(url) {
      return urlPart(url, this, (u) => portOf(u));
    },
    path_and_query(url) {
      // UrlBuilder.PathWithQueryString re-encodes the query through QueryStringCollection.
      return urlPart(url, this, (u) => u.pathname + buildQuery(queryPairs(u.search)));
    },
    scheme(url) {
      return urlPart(url, this, (u) => u.protocol.replace(/:$/, ""));
    },
    is_sitemap_ancestor(url) {
      return host.isSitemapAncestor ? host.isSitemapAncestor(asString(url), this) : false;
    },
    is_sitemap_current(url) {
      return host.isSitemapCurrent ? host.isSitemapCurrent(asString(url), this) : false;
    },

    // ---- Adxstudio SearchFilterOptionFilters ----
    search_filter_options(input) {
      const text = input == null ? "" : formatItem(input);
      if (!text) return null;
      const options = [];
      for (const m of text.matchAll(/\s*([^:;]+?)\s*:\s*([^;]+)\s*/g)) {
        const value = m[2].replace(/ /g, "");
        options.push({ display_name: host.localizeRecordType ? host.localizeRecordType(value.split(",")[0]) : value.split(",")[0], value });
      }
      return options.length ? options : null;
    },
  };
  return filters;
}
function isConvertibleForNumber(value) {
  return typeof value === "string" || typeof value === "boolean" || isNumber(value);
}
function addTime(date, milliseconds) {
  const value = asNullableDate(date);
  if (value == null) return null;
  // DateTime.Add* rounds the double argument to the nearest millisecond.
  return new Date(value.getTime() + Math.round(milliseconds));
}
function addMonths(date, months) {
  const value = asNullableDate(date);
  if (value == null) return null;
  const year = value.getUTCFullYear(),
    month = value.getUTCMonth() + months;
  const targetYear = year + Math.floor(month / 12),
    targetMonth = ((month % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const result = new Date(value.getTime());
  result.setUTCFullYear(targetYear, targetMonth, Math.min(value.getUTCDate(), lastDay));
  return result;
}
/**
 * new UrlBuilder(url): rooted paths ("/", "~/") take the current request's scheme, host and
 * port; other strings are parsed by UriBuilder (which treats "a/b" as host "a").
 */
function urlPart(url, context, select) {
  const target = asString(url);
  if (target == null) return null;
  try {
    let parsed;
    if (target.startsWith("/") || target.startsWith("~/")) {
      const origin = context?.engine?.requestOrigin?.(context) ?? `${PLACEHOLDER}`;
      parsed = new URL(target.startsWith("~/") ? target.slice(1) : target, `${origin}/`);
    } else if (/^[a-z][a-z0-9+.-]*:/i.test(target)) parsed = new URL(target);
    else parsed = new URL(`http://${target}`);
    return select(parsed);
  } catch {
    return null;
  }
}
/** Convert.ToString / object.ToString used by string.Concat. */
function netToString(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "True" : "False";
  if (isNumber(value)) return numberToNetString(value);
  if (isDate(value)) return dateToNetString(value);
  return formatItem(value);
}
export { plainNumber, KeyValuePair };
