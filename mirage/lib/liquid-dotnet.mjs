// .NET Framework value semantics used by the Power Pages Liquid engine.
//
// Power Pages renders Liquid with DotLiquid on .NET Framework (the live portal serves
// WebResource.axd/ScriptResource.axd and formats platform comments with en-US "G" dates).
// These helpers reproduce the observable .NET behaviour Liquid output depends on:
// numeric kinds and decimal arithmetic, culture formatting (en-US), DateTime parsing and
// format strings, WebUtility/SecurityElement/AntiXSS encoders, Convert.ChangeType and the
// .NET regular-expression dialect used by DotLiquid's legacy `replace`.

export class LiquidError extends Error {
  constructor(message, netType = "System.Exception") {
    super(message);
    this.netType = netType;
  }
}
export class LiquidSyntaxError extends LiquidError {
  constructor(message) {
    super(message, "DotLiquid.Exceptions.SyntaxException");
  }
}
export const formatError = () =>
  new LiquidError("Input string was not in a correct format.", "System.FormatException");
export const invalidCast = (from, to) =>
  new LiquidError(
    from && to
      ? `Invalid cast from '${from}' to '${to}'.`
      : "Specified cast is not valid.",
    "System.InvalidCastException",
  );
const overflow = () =>
  new LiquidError("Arithmetic operation resulted in an overflow.", "System.OverflowException");
const divideByZero = () =>
  new LiquidError("Attempted to divide by zero.", "System.DivideByZeroException");

// ---------------------------------------------------------------------------
// Numbers: JS integers model Int32/Int64; NetDecimal models System.Decimal.
// ---------------------------------------------------------------------------
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const DECIMAL_MAX_MANTISSA = 79228162514264337593543950335n;

/** System.Decimal value with exact base-10 digits (scale kept for Convert.ToString). */
export class NetDecimal {
  constructor(mantissa, scale = 0) {
    this.mantissa = BigInt(mantissa);
    this.scale = Number(scale);
  }
  static from(value) {
    if (value instanceof NetDecimal) return value;
    if (typeof value === "bigint") return new NetDecimal(value, 0);
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw overflow();
      return NetDecimal.parse(plainNumber(value));
    }
    return NetDecimal.parse(String(value));
  }
  static parse(text) {
    const match = /^\s*([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?\s*$/.exec(String(text));
    if (!match || (!match[2] && !match[3])) throw formatError();
    let digits = (match[2] || "") + (match[3] || "");
    let scale = (match[3] || "").length - Number(match[4] || 0);
    if (scale < 0) {
      digits += "0".repeat(-scale);
      scale = 0;
    }
    let mantissa = BigInt(digits || "0");
    while (scale > 28) {
      mantissa = roundHalfEven(mantissa, 10n);
      scale--;
    }
    if (mantissa > DECIMAL_MAX_MANTISSA) throw overflow();
    return new NetDecimal(match[1] === "-" ? -mantissa : mantissa, scale);
  }
  valueOf() {
    return Number(this.toFixedString());
  }
  /** Exact digits with the stored scale (Convert.ToString / decimal.ToString()). */
  toFixedString() {
    const negative = this.mantissa < 0n;
    const digits = (negative ? -this.mantissa : this.mantissa)
      .toString()
      .padStart(this.scale + 1, "0");
    const text = this.scale
      ? `${digits.slice(0, -this.scale)}.${digits.slice(-this.scale)}`
      : digits;
    return negative && /[1-9]/.test(text) ? `-${text}` : text;
  }
  /** DotLiquid output format "0.#############################" (no trailing zeros). */
  toString() {
    const text = this.toFixedString();
    return text.includes(".") ? text.replace(/\.?0+$/, "") : text;
  }
  isIntegral() {
    return this.mantissa % 10n ** BigInt(this.scale) === 0n;
  }
}
function roundHalfEven(value, divisor) {
  const quotient = value / divisor;
  const remainder = value % divisor;
  const twice = (remainder < 0n ? -remainder : remainder) * 2n;
  if (twice > divisor || (twice === divisor && quotient % 2n !== 0n))
    return quotient + (value < 0n ? -1n : 1n);
  return quotient;
}
function aligned(a, b) {
  const scale = Math.max(a.scale, b.scale);
  return [
    a.mantissa * 10n ** BigInt(scale - a.scale),
    b.mantissa * 10n ** BigInt(scale - b.scale),
    scale,
  ];
}
function fitDecimal(mantissa, scale) {
  while ((mantissa > DECIMAL_MAX_MANTISSA || mantissa < -DECIMAL_MAX_MANTISSA) && scale > 0) {
    mantissa = roundHalfEven(mantissa, 10n);
    scale--;
  }
  if (mantissa > DECIMAL_MAX_MANTISSA || mantissa < -DECIMAL_MAX_MANTISSA) throw overflow();
  return new NetDecimal(mantissa, scale);
}
export function decimalAdd(a, b, sign = 1n) {
  const [x, y, scale] = aligned(NetDecimal.from(a), NetDecimal.from(b));
  return fitDecimal(x + sign * y, scale);
}
export function decimalMultiply(a, b) {
  const x = NetDecimal.from(a),
    y = NetDecimal.from(b);
  let mantissa = x.mantissa * y.mantissa,
    scale = x.scale + y.scale;
  while (scale > 28) {
    mantissa = roundHalfEven(mantissa, 10n);
    scale--;
  }
  return fitDecimal(mantissa, scale);
}
export function decimalDivide(a, b) {
  const x = NetDecimal.from(a),
    y = NetDecimal.from(b);
  if (y.mantissa === 0n) throw divideByZero();
  // Compute 30 fractional digits, then round to the largest scale (<= 28) that fits.
  const [n, d] = aligned(x, y);
  const extra = 30n;
  let quotient = (n * 10n ** extra) / d;
  let remainder = (n * 10n ** extra) % d;
  let scale = 30;
  // Remove exact trailing zeros (System.Decimal keeps the smallest exact scale).
  if (remainder === 0n)
    while (scale > 0 && quotient % 10n === 0n) {
      quotient /= 10n;
      scale--;
    }
  while (scale > 28) {
    quotient = roundHalfEven(quotient, 10n);
    scale--;
  }
  return fitDecimal(quotient, scale);
}
export function decimalModulo(a, b) {
  const [x, y, scale] = aligned(NetDecimal.from(a), NetDecimal.from(b));
  if (y === 0n) throw divideByZero();
  return fitDecimal(x % y, scale);
}

export const isNetDecimal = (value) => value instanceof NetDecimal;
export const isNumber = (value) =>
  (typeof value === "number" && Number.isFinite(value)) || value instanceof NetDecimal;
/** .NET kind of a numeric runtime value: int (Int32), long (Int64) or decimal. */
export function numberKind(value) {
  if (value instanceof NetDecimal) return "decimal";
  if (typeof value !== "number") return null;
  if (!Number.isInteger(value)) return "decimal";
  return value >= INT32_MIN && value <= INT32_MAX ? "int" : "long";
}
export function toNumber(value) {
  return value instanceof NetDecimal ? value.valueOf() : Number(value);
}
/** Decimal values that are mathematically integral stay NetDecimal; others become JS numbers. */
export function normalizeDecimal(result) {
  return result instanceof NetDecimal ? result : NetDecimal.from(result);
}

/** Render a JS number without exponent notation. */
export function plainNumber(value) {
  if (Object.is(value, -0)) return "0";
  const text = String(value);
  if (!/e/i.test(text)) return text;
  const [mantissa, exponentText] = text.toLowerCase().split("e");
  const exponent = Number(exponentText);
  const negative = mantissa.startsWith("-");
  const [whole, fraction = ""] = mantissa.replace("-", "").split(".");
  let digits = whole + fraction,
    point = whole.length + exponent;
  if (point <= 0) digits = "0".repeat(1 - point) + digits, (point = 1);
  if (point >= digits.length) digits += "0".repeat(point - digits.length);
  const result = `${digits.slice(0, point)}${point < digits.length ? "." + digits.slice(point) : ""}`;
  return (negative ? "-" : "") + result.replace(/^0+(?=\d)/, "");
}

/** Convert.ToString(number, en-US) (decimal keeps its scale). */
export function numberToNetString(value) {
  if (value instanceof NetDecimal) return value.toFixedString();
  if (Number.isInteger(value)) return plainNumber(value);
  return plainNumber(value);
}
/** DotLiquid Variable output of numbers (decimal "0.####", others ToString). */
export function numberToOutput(value) {
  if (value instanceof NetDecimal) return value.toString();
  return plainNumber(value);
}

/** Standard Int32 parsing (NumberStyles.Integer, en-US). */
export function parseInt32(text) {
  const match = /^\s*([+-]?)(\d+)\s*$/.exec(String(text));
  if (!match) throw formatError();
  const value = Number(match[1] + match[2]);
  if (value < INT32_MIN || value > INT32_MAX) throw overflow();
  return value;
}
/** Decimal parsing (NumberStyles.Number: sign, thousands separators, decimal point). */
export function parseNetDecimal(text) {
  const match = /^\s*([+-]?)((?:\d{1,3}(?:,\d{3})+|\d+)?)(?:\.(\d+))?\s*$/.exec(String(text));
  if (!match || (!match[2] && !match[3])) throw formatError();
  return NetDecimal.parse(`${match[1]}${(match[2] || "0").replace(/,/g, "")}${match[3] ? "." + match[3] : ""}`);
}
/** Convert.ToInt32 for numbers: round half to even, checked. */
export function toInt32(value) {
  if (value == null) return 0;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") return parseInt32(value);
  if (value instanceof Date) throw invalidCast("System.DateTime", "System.Int32");
  if (!isNumber(value)) throw invalidCast(netTypeName(value), "System.Int32");
  const decimal = NetDecimal.from(value);
  const scaled = decimal.scale ? roundHalfEven(decimal.mantissa, 10n ** BigInt(decimal.scale)) : decimal.mantissa;
  if (scaled < BigInt(INT32_MIN) || scaled > BigInt(INT32_MAX)) throw overflow();
  return Number(scaled);
}
export function toNetDecimal(value) {
  if (value == null) return new NetDecimal(0n, 0);
  if (typeof value === "boolean") return new NetDecimal(value ? 1n : 0n, 0);
  if (typeof value === "string") return parseNetDecimal(value);
  if (isNumber(value)) return NetDecimal.from(value);
  throw invalidCast(netTypeName(value), "System.Decimal");
}

// ---------------------------------------------------------------------------
// Culture (en-US) and DateTime formatting
// ---------------------------------------------------------------------------
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const STANDARD_DATE_FORMATS = {
  d: "M/d/yyyy",
  D: "dddd, MMMM d, yyyy",
  f: "dddd, MMMM d, yyyy h:mm tt",
  F: "dddd, MMMM d, yyyy h:mm:ss tt",
  g: "M/d/yyyy h:mm tt",
  G: "M/d/yyyy h:mm:ss tt",
  m: "MMMM d",
  M: "MMMM d",
  o: "yyyy'-'MM'-'dd'T'HH':'mm':'ss'.'fffffffK",
  O: "yyyy'-'MM'-'dd'T'HH':'mm':'ss'.'fffffffK",
  r: "ddd, dd MMM yyyy HH':'mm':'ss 'GMT'",
  R: "ddd, dd MMM yyyy HH':'mm':'ss 'GMT'",
  s: "yyyy'-'MM'-'dd'T'HH':'mm':'ss",
  t: "h:mm tt",
  T: "h:mm:ss tt",
  u: "yyyy'-'MM'-'dd HH':'mm':'ss'Z'",
  U: "dddd, MMMM d, yyyy h:mm:ss tt",
  y: "MMMM yyyy",
  Y: "MMMM yyyy",
};
/** Liquid DateTime values are UTC (Dataverse values and `now`); the server zone is UTC. */
export function isDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime());
}
function dateParts(date) {
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth(),
    day: date.getUTCDate(),
    weekday: date.getUTCDay(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
    ms: date.getUTCMilliseconds(),
    ticks: date.__netTicks ?? 0,
  };
}
const pad = (value, width) => String(value).padStart(width, "0");
/** DateTime.ToString(format, en-US) including standard and custom format strings. */
export function formatNetDate(date, format) {
  if (!isDate(date)) throw new LiquidError("Not a DateTime value", "System.ArgumentException");
  let pattern = format == null || format === "" ? "G" : String(format);
  if (pattern.length === 1) {
    if (!Object.hasOwn(STANDARD_DATE_FORMATS, pattern)) throw formatError();
    pattern = STANDARD_DATE_FORMATS[pattern];
  }
  const p = dateParts(date);
  const fraction = pad(p.ms, 3) + pad(p.ticks, 4);
  let out = "";
  for (let i = 0; i < pattern.length; ) {
    const ch = pattern[i];
    let run = 1;
    while (pattern[i + run] === ch) run++;
    switch (ch) {
      case "d":
        out += run === 1 ? p.day : run === 2 ? pad(p.day, 2) : run === 3 ? DAY_NAMES[p.weekday].slice(0, 3) : DAY_NAMES[p.weekday];
        break;
      case "f":
      case "F": {
        if (run > 7) throw formatError();
        let digits = fraction.slice(0, run);
        if (ch === "F") {
          digits = digits.replace(/0+$/, "");
          if (!digits && out.endsWith(".")) out = out.slice(0, -1);
        }
        out += digits;
        break;
      }
      case "g":
        out += "A.D.";
        break;
      case "h": {
        const h = p.hour % 12 || 12;
        out += run === 1 ? h : pad(h, 2);
        break;
      }
      case "H":
        out += run === 1 ? p.hour : pad(p.hour, 2);
        break;
      case "K":
        out += "Z";
        break;
      case "m":
        out += run === 1 ? p.minute : pad(p.minute, 2);
        break;
      case "M":
        out += run === 1 ? p.month + 1 : run === 2 ? pad(p.month + 1, 2) : run === 3 ? MONTH_NAMES[p.month].slice(0, 3) : MONTH_NAMES[p.month];
        break;
      case "s":
        out += run === 1 ? p.second : pad(p.second, 2);
        break;
      case "t":
        out += run === 1 ? (p.hour < 12 ? "A" : "P") : p.hour < 12 ? "AM" : "PM";
        break;
      case "y":
        out += run === 1 ? p.year % 100 : run === 2 ? pad(p.year % 100, 2) : pad(p.year, run);
        break;
      case "z":
        out += run === 1 ? "+0" : run === 2 ? "+00" : "+00:00";
        break;
      case ":":
      case "/":
        out += ch.repeat(run);
        break;
      case "'":
      case '"': {
        const end = pattern.indexOf(ch, i + 1);
        if (end < 0) throw formatError();
        out += pattern.slice(i + 1, end);
        i = end + 1;
        continue;
      }
      case "%":
        if (i + 1 >= pattern.length || pattern[i + 1] === "%") throw formatError();
        i += 1;
        continue;
      case "\\":
        if (i + 1 >= pattern.length) throw formatError();
        out += pattern[i + 1];
        i += 2;
        continue;
      default:
        out += ch.repeat(run);
    }
    i += run;
  }
  return out;
}
/** DateTime.ToString() with the en-US general pattern. */
export const dateToNetString = (date) => formatNetDate(date, "G");

const MONTH_LOOKUP = new Map(
  MONTH_NAMES.flatMap((name, index) => [
    [name.toLowerCase(), index],
    [name.slice(0, 3).toLowerCase(), index],
  ]),
);
function utcDate(year, month, day, hour = 0, minute = 0, second = 0, ms = 0) {
  if (month < 0 || month > 11 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(Date.UTC(year, month, day, hour, minute, second, ms));
  if (year < 100) date.setUTCFullYear(year);
  return date.getUTCMonth() === month && date.getUTCDate() === day ? date : null;
}
function twelveHour(hour, designator) {
  if (!designator) return hour;
  if (hour < 1 || hour > 12) return NaN;
  return designator.toUpperCase().startsWith("P") ? (hour % 12) + 12 : hour % 12;
}
/**
 * DateTime.TryParse(value, en-US, DateTimeStyles.None) for the forms used by portal
 * code: ISO 8601 (offsets convert to the UTC server clock), US short dates with optional
 * time, month-name dates and RFC 1123. Returns null when .NET would fail.
 */
export function parseNetDate(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,7}))?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(text);
  if (m) {
    const ms = m[7] ? Number(m[7].padEnd(7, "0").slice(0, 3)) : 0;
    const date = utcDate(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0), ms);
    if (!date) return null;
    if (m[7]) date.__netTicks = Number(m[7].padEnd(7, "0").slice(3, 7));
    if (m[8] && m[8].toUpperCase() !== "Z") {
      const offset = m[8].replace(":", "");
      const minutes = (offset[0] === "-" ? -1 : 1) * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(3, 5)));
      return new Date(date.getTime() - minutes * 60000);
    }
    return date;
  }
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm]?)?)?$/.exec(text);
  if (m) {
    let year = Number(m[3]);
    if (m[3].length === 2) year += year < 50 ? 2000 : 1900;
    const hour = twelveHour(+(m[4] ?? 0), m[7]);
    return Number.isNaN(hour) ? null : utcDate(year, +m[1] - 1, +m[2], hour, +(m[5] ?? 0), +(m[6] ?? 0));
  }
  m = /^(?:(?:sun|mon|tue|wed|thu|fri|sat)[a-z]*,?\s+)?([a-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm]?)?)?$/i.exec(text);
  if (m && MONTH_LOOKUP.has(m[1].toLowerCase())) {
    const hour = twelveHour(+(m[4] ?? 0), m[7]);
    return Number.isNaN(hour) ? null : utcDate(+m[3], MONTH_LOOKUP.get(m[1].toLowerCase()), +m[2], hour, +(m[5] ?? 0), +(m[6] ?? 0));
  }
  m = /^(?:(?:sun|mon|tue|wed|thu|fri|sat)[a-z]*,?\s+)?(\d{1,2})\s+([a-z]+)\.?,?\s+(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(GMT|UTC|Z|[AaPp][Mm])?)?$/i.exec(text);
  if (m && MONTH_LOOKUP.has(m[2].toLowerCase())) {
    const designator = /^[ap]/i.test(m[7] ?? "") ? m[7] : undefined;
    const hour = twelveHour(+(m[4] ?? 0), designator);
    return Number.isNaN(hour) ? null : utcDate(+m[3], MONTH_LOOKUP.get(m[2].toLowerCase()), +m[1], hour, +(m[5] ?? 0), +(m[6] ?? 0));
  }
  m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (m) return utcDate(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm]?)?$/.exec(text);
  if (m) {
    const now = new Date();
    const hour = twelveHour(+m[1], m[4]);
    return Number.isNaN(hour) ? null : utcDate(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, +m[2], +(m[3] ?? 0));
  }
  return null;
}
/** Strict ISO date/time strings produced by the local data store are Dataverse DateTime values. */
export const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,7})?)?(?:Z|[+-]\d{2}:\d{2})$/;

// ---------------------------------------------------------------------------
// Encoders
// ---------------------------------------------------------------------------
/** System.Net.WebUtility.HtmlEncode (.NET Framework 4.5+, Strict conformance). */
export function htmlEncode(value) {
  const text = String(value);
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0);
    if (char === "<") out += "&lt;";
    else if (char === ">") out += "&gt;";
    else if (char === '"') out += "&quot;";
    else if (char === "'") out += "&#39;";
    else if (char === "&") out += "&amp;";
    else if ((code >= 160 && code < 256) || code > 0xffff) out += `&#${code};`;
    else out += char;
  }
  return out;
}
const NAMED_ENTITIES = {
  quot: 34, amp: 38, apos: 39, lt: 60, gt: 62, nbsp: 160, iexcl: 161, cent: 162, pound: 163, curren: 164,
  yen: 165, brvbar: 166, sect: 167, uml: 168, copy: 169, ordf: 170, laquo: 171, not: 172, shy: 173,
  reg: 174, macr: 175, deg: 176, plusmn: 177, sup2: 178, sup3: 179, acute: 180, micro: 181, para: 182,
  middot: 183, cedil: 184, sup1: 185, ordm: 186, raquo: 187, frac14: 188, frac12: 189, frac34: 190,
  iquest: 191, Agrave: 192, Aacute: 193, Acirc: 194, Atilde: 195, Auml: 196, Aring: 197, AElig: 198,
  Ccedil: 199, Egrave: 200, Eacute: 201, Ecirc: 202, Euml: 203, Igrave: 204, Iacute: 205, Icirc: 206,
  Iuml: 207, ETH: 208, Ntilde: 209, Ograve: 210, Oacute: 211, Ocirc: 212, Otilde: 213, Ouml: 214,
  times: 215, Oslash: 216, Ugrave: 217, Uacute: 218, Ucirc: 219, Uuml: 220, Yacute: 221, THORN: 222,
  szlig: 223, agrave: 224, aacute: 225, acirc: 226, atilde: 227, auml: 228, aring: 229, aelig: 230,
  ccedil: 231, egrave: 232, eacute: 233, ecirc: 234, euml: 235, igrave: 236, iacute: 237, icirc: 238,
  iuml: 239, eth: 240, ntilde: 241, ograve: 242, oacute: 243, ocirc: 244, otilde: 245, ouml: 246,
  divide: 247, oslash: 248, ugrave: 249, uacute: 250, ucirc: 251, uuml: 252, yacute: 253, thorn: 254,
  yuml: 255, OElig: 338, oelig: 339, Scaron: 352, scaron: 353, Yuml: 376, fnof: 402, circ: 710,
  tilde: 732, Alpha: 913, Beta: 914, Gamma: 915, Delta: 916, Epsilon: 917, Zeta: 918, Eta: 919,
  Theta: 920, Iota: 921, Kappa: 922, Lambda: 923, Mu: 924, Nu: 925, Xi: 926, Omicron: 927, Pi: 928,
  Rho: 929, Sigma: 931, Tau: 932, Upsilon: 933, Phi: 934, Chi: 935, Psi: 936, Omega: 937, alpha: 945,
  beta: 946, gamma: 947, delta: 948, epsilon: 949, zeta: 950, eta: 951, theta: 952, iota: 953,
  kappa: 954, lambda: 955, mu: 956, nu: 957, xi: 958, omicron: 959, pi: 960, rho: 961, sigmaf: 962,
  sigma: 963, tau: 964, upsilon: 965, phi: 966, chi: 967, psi: 968, omega: 969, thetasym: 977,
  upsih: 978, piv: 982, ensp: 8194, emsp: 8195, thinsp: 8201, zwnj: 8204, zwj: 8205, lrm: 8206,
  rlm: 8207, ndash: 8211, mdash: 8212, lsquo: 8216, rsquo: 8217, sbquo: 8218, ldquo: 8220, rdquo: 8221,
  bdquo: 8222, dagger: 8224, Dagger: 8225, bull: 8226, hellip: 8230, permil: 8240, prime: 8242,
  Prime: 8243, lsaquo: 8249, rsaquo: 8250, oline: 8254, frasl: 8260, euro: 8364, image: 8465,
  weierp: 8472, real: 8476, trade: 8482, alefsym: 8501, larr: 8592, uarr: 8593, rarr: 8594, darr: 8595,
  harr: 8596, crarr: 8629, lArr: 8656, uArr: 8657, rArr: 8658, dArr: 8659, hArr: 8660, forall: 8704,
  part: 8706, exist: 8707, empty: 8709, nabla: 8711, isin: 8712, notin: 8713, ni: 8715, prod: 8719,
  sum: 8721, minus: 8722, lowast: 8727, radic: 8730, prop: 8733, infin: 8734, ang: 8736, and: 8743,
  or: 8744, cap: 8745, cup: 8746, int: 8747, there4: 8756, sim: 8764, cong: 8773, asymp: 8776,
  ne: 8800, equiv: 8801, le: 8804, ge: 8805, sub: 8834, sup: 8835, nsub: 8836, sube: 8838, supe: 8839,
  oplus: 8853, otimes: 8855, perp: 8869, sdot: 8901, lceil: 8968, rceil: 8969, lfloor: 8970,
  rfloor: 8971, lang: 9001, rang: 9002, loz: 9674, spades: 9824, clubs: 9827, hearts: 9829, diams: 9830,
};
/** System.Net.WebUtility.HtmlDecode (HTML 4 named entities and numeric references). */
export function htmlDecode(value) {
  return String(value).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (entity, body) => {
    let code;
    if (body[0] === "#")
      code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : Number(body.slice(1));
    else code = NAMED_ENTITIES[body];
    if (code === undefined || code > 0x10ffff) return entity;
    return String.fromCodePoint(code);
  });
}
/** System.Security.SecurityElement.Escape (xml_escape). */
export function securityElementEscape(value) {
  return String(value).replace(/[<>"'&]/g, (char) => ({ "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;", "&": "&amp;" })[char]);
}
const utf8 = new TextEncoder();
function percentEncode(value, safe, { space = "%20", lower = false } = {}) {
  let out = "";
  for (const byte of utf8.encode(String(value))) {
    const char = String.fromCharCode(byte);
    if (byte < 128 && safe.test(char)) out += char;
    else if (byte === 0x20 && space) out += space;
    else {
      const hex = byte.toString(16).padStart(2, "0");
      out += "%" + (lower ? hex : hex.toUpperCase());
    }
  }
  return out;
}
/** System.Net.WebUtility.UrlEncode (url_encode / url_escape). */
export const webUrlEncode = (value) => percentEncode(value, /[A-Za-z0-9\-_.!*()]/, { space: "+" });
/** Uri.EscapeDataString (RFC 3986 unreserved characters only). */
export const escapeDataString = (value) => percentEncode(value, /[A-Za-z0-9\-_.~]/);
/** System.Web.HttpUtility.UrlEncode (lower-case hex, '+' for spaces). */
export const httpUtilityUrlEncode = (value) => percentEncode(value, /[A-Za-z0-9\-_.!*()]/, { space: "+", lower: true });
/** Microsoft AntiXSS Encoder.UrlEncode (query rebuilt by add_query/remove_query). */
export const antiXssUrlEncode = (value) => percentEncode(value, /[A-Za-z0-9\-_.~]/, { lower: true });
function decodeBytes(text, { plus, unicodeEscapes }) {
  const bytes = [];
  let out = "";
  const flush = () => {
    if (bytes.length) out += new TextDecoder("utf-8").decode(new Uint8Array(bytes.splice(0)));
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "+" && plus) {
      flush();
      out += " ";
    } else if (char === "%" && unicodeEscapes && /^[uU][0-9a-fA-F]{4}$/.test(text.slice(i + 1, i + 6))) {
      flush();
      out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
      i += 5;
    } else if (char === "%" && /^[0-9a-fA-F]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      flush();
      out += char;
    }
  }
  flush();
  return out;
}
/** System.Uri.ToString(): unescape percent-encoded characters that carry no reserved meaning. */
const RESERVED_URI_CHARACTERS = "%:/?#[]@!$&'()*+,;=\"<>`^{|}\\";
export function uriToDisplayString(href) {
  return String(href).replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    let decoded;
    try {
      decoded = decodeURIComponent(run);
    } catch {
      return run;
    }
    let out = "";
    for (const char of decoded) {
      const code = char.codePointAt(0);
      if (code < 0x21 && code !== 0x20) out += encodeURIComponent(char);
      else if (RESERVED_URI_CHARACTERS.includes(char))
        out += encodeURIComponent(char).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
      else out += char;
    }
    return out;
  });
}
/** System.Net.WebUtility.UrlDecode. */
export const webUrlDecode = (value) => decodeBytes(String(value), { plus: true, unicodeEscapes: false });
/** System.Web.HttpUtility.UrlDecode (also accepts %uXXXX). */
export const httpUtilityUrlDecode = (value) => decodeBytes(String(value), { plus: true, unicodeEscapes: true });

// ---------------------------------------------------------------------------
// Type names, Convert.ChangeType and comparisons
// ---------------------------------------------------------------------------
export function netTypeName(value) {
  if (value == null) return "null";
  if (typeof value === "string") return "System.String";
  if (typeof value === "boolean") return "System.Boolean";
  if (value instanceof NetDecimal) return "System.Decimal";
  if (typeof value === "number") return numberKind(value) === "int" ? "System.Int32" : numberKind(value) === "long" ? "System.Int64" : "System.Decimal";
  if (isDate(value)) return "System.DateTime";
  if (Array.isArray(value)) return "System.Object[]";
  return value?.constructor?.netTypeName ?? "DotLiquid.Drop";
}
function kindOf(value) {
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "bool";
  if (isNumber(value)) return numberKind(value);
  if (isDate(value)) return "date";
  return "object";
}
/** Convert.ChangeType(value, typeof(target)) for the kinds Liquid values can have. */
export function changeType(value, target) {
  const kind = kindOf(value);
  switch (target) {
    case "string":
      if (kind === "string") return value;
      if (kind === "bool") return value ? "True" : "False";
      if (kind === "date") return dateToNetString(value);
      if (kind === "int" || kind === "long" || kind === "decimal") return numberToNetString(value);
      throw invalidCast(netTypeName(value), "System.String");
    case "int":
    case "long": {
      if (kind === "string") {
        const match = /^\s*([+-]?)(\d+)\s*$/.exec(value);
        if (!match) throw formatError();
        const parsed = Number(match[1] + match[2]);
        if (target === "int" && (parsed < INT32_MIN || parsed > INT32_MAX)) throw overflow();
        return parsed;
      }
      if (kind === "bool") return value ? 1 : 0;
      if (kind === "int" || kind === "long" || kind === "decimal") return toInt32Checked(value, target);
      throw invalidCast(netTypeName(value), target === "int" ? "System.Int32" : "System.Int64");
    }
    case "decimal":
      if (kind === "string") return parseNetDecimal(value);
      if (kind === "bool") return new NetDecimal(value ? 1n : 0n, 0);
      if (kind === "int" || kind === "long" || kind === "decimal") return NetDecimal.from(value);
      throw invalidCast(netTypeName(value), "System.Decimal");
    case "bool":
      if (kind === "bool") return value;
      if (kind === "string") {
        const text = value.trim().toLowerCase();
        if (text === "true") return true;
        if (text === "false") return false;
        throw new LiquidError("String was not recognized as a valid Boolean.", "System.FormatException");
      }
      if (kind === "int" || kind === "long" || kind === "decimal") return toNumber(value) !== 0;
      throw invalidCast(netTypeName(value), "System.Boolean");
    case "date":
      if (kind === "date") return value;
      if (kind === "string") {
        const parsed = parseNetDate(value);
        if (!parsed) throw new LiquidError("String was not recognized as a valid DateTime.", "System.FormatException");
        return parsed;
      }
      throw invalidCast(netTypeName(value), "System.DateTime");
    default:
      throw invalidCast(netTypeName(value), "System.Object");
  }
}
function toInt32Checked(value, target) {
  const decimal = NetDecimal.from(value);
  const scaled = decimal.scale ? roundHalfEven(decimal.mantissa, 10n ** BigInt(decimal.scale)) : decimal.mantissa;
  const min = target === "int" ? BigInt(INT32_MIN) : -(2n ** 63n);
  const max = target === "int" ? BigInt(INT32_MAX) : 2n ** 63n - 1n;
  if (scaled < min || scaled > max) throw overflow();
  return Number(scaled);
}
export const valueKind = kindOf;

/** Object.Equals between two values of the same .NET kind. */
function sameKindEquals(a, b) {
  if (isNumber(a) && isNumber(b)) {
    const x = NetDecimal.from(a),
      y = NetDecimal.from(b);
    const [m, n] = aligned(x, y);
    return m === n;
  }
  if (isDate(a) && isDate(b)) return a.getTime() === b.getTime();
  return a === b;
}
/** DotLiquid ObjectExtensionMethods.SafeTypeInsensitiveEqual. */
export function safeTypeInsensitiveEqual(a, b) {
  if (a == null) return b == null;
  if (b == null) return false;
  if (typeof a !== "string" && typeof b !== "string" && Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((item, index) => safeTypeInsensitiveEqual(item, b[index]));
  const ka = kindOf(a),
    kb = kindOf(b);
  if (ka === kb) return ka === "object" ? a === b : sameKindEquals(a, b);
  try {
    return sameKindEquals(changeType(b, ka === "long" ? "long" : ka), a);
  } catch {
    try {
      return sameKindEquals(changeType(a, kb === "long" ? "long" : kb), b);
    } catch {
      return false;
    }
  }
}
/** BackCompatSafeTypeInsensitiveEqual: numbers and strings never compare equal. */
export function backCompatEqual(a, b) {
  if (a != null && b != null) {
    const ka = kindOf(a),
      kb = kindOf(b);
    const numeric = (k) => k === "int" || k === "long" || k === "decimal";
    const textual = (k) => k === "string";
    if (ka !== kb && !(numeric(ka) && numeric(kb)) && !(textual(ka) && textual(kb))) return false;
  }
  return safeTypeInsensitiveEqual(a, b);
}
const collator = new Intl.Collator("en-US", { sensitivity: "variant" });
/** Comparer<object>.Default.Compare after Convert.ChangeType(right, left type). */
export function netCompare(left, right) {
  const kind = kindOf(left);
  if (kind === "object") throw new LiquidError("At least one object must implement IComparable.", "System.ArgumentException");
  const converted = changeType(right, kind === "long" ? "long" : kind);
  if (kind === "string") return Math.sign(collator.compare(left, converted));
  if (kind === "bool") return left === converted ? 0 : left ? 1 : -1;
  if (kind === "date") return Math.sign(left.getTime() - converted.getTime());
  const [m, n] = aligned(NetDecimal.from(left), NetDecimal.from(converted));
  return m === n ? 0 : m > n ? 1 : -1;
}

// ---------------------------------------------------------------------------
// .NET regular expressions (DotLiquid 2.x legacy `replace`/`replace_first`)
// ---------------------------------------------------------------------------
/** Translate the common .NET regex dialect into an equivalent JavaScript RegExp. */
export function netRegex(pattern, flags = "g") {
  let source = String(pattern);
  let jsFlags = flags;
  const inline = /^\(\?([imsx]+)\)/.exec(source);
  if (inline) {
    for (const flag of inline[1]) if (flag !== "x" && !jsFlags.includes(flag)) jsFlags += flag;
    source = source.slice(inline[0].length);
  }
  let out = "",
    inClass = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === "\\") {
      const next = source[i + 1];
      if (next === undefined) throw new LiquidError(`parsing "${pattern}" - Illegal \\ at end of pattern.`, "System.ArgumentException");
      if (!inClass && next === "A") out += "^";
      else if (!inClass && next === "z") out += "$";
      else if (!inClass && next === "Z") out += "(?=\\n?$)";
      else out += char + next;
      i++;
      continue;
    }
    if (inClass) {
      if (char === "]") inClass = false;
      out += char;
      continue;
    }
    if (char === "[") {
      inClass = true;
      out += char;
      if (source[i + 1] === "^") out += source[++i];
      if (source[i + 1] === "]") out += "\\" + source[++i];
      continue;
    }
    if (char === "(" && source.startsWith("(?>", i)) {
      out += "(?:";
      i += 2;
      continue;
    }
    if (char === "." && !jsFlags.includes("s")) {
      out += "[^\\n]";
      continue;
    }
    if (char === "$" && !jsFlags.includes("m")) {
      out += "(?=\\n?$)";
      continue;
    }
    out += char;
  }
  try {
    return new RegExp(out, jsFlags.replace("x", ""));
  } catch (error) {
    throw new LiquidError(`parsing "${pattern}" - ${netRegexErrorText(error.message)}`, "System.ArgumentException");
  }
}
/** .NET Framework RegexParser texts for the parse errors JavaScript reports differently. */
function netRegexErrorText(message) {
  if (/Unterminated group/i.test(message)) return "Not enough )'s.";
  if (/Unmatched '\)'/i.test(message)) return "Too many )'s.";
  if (/Unterminated character class/i.test(message)) return "Unterminated [] set.";
  if (/Nothing to repeat/i.test(message)) return "Quantifier {x,y} following nothing.";
  return message.replace(/^Invalid regular expression: \/.*\/[a-z]*: /, "");
}
/** Regex.Replace with .NET substitution syntax ($1, ${name}, $$, $&, $`, $', $+, $_). */
export function netRegexReplace(input, pattern, replacement, { first = false } = {}) {
  const regex = netRegex(pattern, "g");
  const template = String(replacement ?? "");
  let replaced = false;
  return String(input).replace(regex, (...args) => {
    const hasGroups = typeof args.at(-1) === "object";
    const groups = hasGroups ? args.at(-1) : undefined;
    const whole = args[0];
    const offset = hasGroups ? args.at(-3) : args.at(-2);
    const subject = hasGroups ? args.at(-2) : args.at(-1);
    const captures = args.slice(1, hasGroups ? -3 : -2);
    if (first && replaced) return whole;
    replaced = true;
    return template.replace(/\$(\$|&|`|'|\+|_|\d+|\{([^}]+)\})/g, (token, body, name) => {
      if (body === "$") return "$";
      if (body === "&") return whole;
      if (body === "`") return subject.slice(0, offset);
      if (body === "'") return subject.slice(offset + whole.length);
      if (body === "+") return captures.length ? (captures.at(-1) ?? "") : "";
      if (body === "_") return subject;
      if (name !== undefined) {
        if (/^\d+$/.test(name)) return Number(name) === 0 ? whole : (captures[Number(name) - 1] ?? token);
        return groups && Object.hasOwn(groups, name) ? (groups[name] ?? "") : token;
      }
      const index = Number(body);
      if (index === 0) return whole;
      return index <= captures.length ? (captures[index - 1] ?? "") : token;
    });
  });
}
