// Dataverse SQL scalar function library with T-SQL semantics for the TDS endpoint.
// Independent of the parser: callers pass evaluated argument values. The parser maps
// CAST(x AS t) to castValue(x, t); CONVERT and TRY_CONVERT are registered as functions.
//
// Value model:
//   NULL                      -> null (most functions return null on NULL input; noted per function)
//   bit                       -> boolean (predicate UNKNOWN -> null)
//   int / smallint / tinyint  -> number (integer)
//   bigint                    -> BigInt
//   float / real              -> number
//   decimal / numeric / money -> { decimal: "123.4500" } (exact text; scale = digits after the point)
//   nvarchar / varchar        -> string (UTF-16 code units; one model, so DATALENGTH counts 2 bytes per unit)
//   datetime / smalldatetime  -> Date in UTC, millisecond precision, no time zone
//   uniqueidentifier          -> uppercase GUID string
// ctx is one object per statement and is mutated (RAND keeps its seeded state there):
//   now (Date | () => Date), random (() => number), newId (() => string), rowCount (number),
//   version (string), caseSensitive (default false), ansiNulls (default true).
// Errors are thrown as plain { number, message } objects.
//
// Unverified: error numbers other than 245 (CAST/CONVERT doc) follow SQL Server from memory;
// Dataverse gives no documented text for unsupported functions, so 195 with a plain message is used;
// DATALENGTH of decimals is fixed at 17 bytes; ISNUMERIC accepts plain numeric text only;
// an empty CHARINDEX or REPLACE pattern is not verified (returns 0 and the input).
// FORMATMESSAGE's missing-parameter error 2787 is from memory; FORMAT currency codes cover common regions only.
import { randomUUID } from 'node:crypto';

const DAY = 86400000;
const EPOCH_1900 = Date.UTC(1900, 0, 1);
const DT_MIN = Date.UTC(1753, 0, 1);
const DT_MAX = Date.UTC(9999, 11, 31, 23, 59, 59, 997);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const INT_RANGE = {
  tinyint: [0n, 255n],
  smallint: [-32768n, 32767n],
  int: [-2147483648n, 2147483647n],
  bigint: [-(2n ** 63n), 2n ** 63n - 1n],
};
const TYPE_ALIAS = { numeric: 'decimal', dec: 'decimal', real: 'float', char: 'varchar', nchar: 'nvarchar', smalldatetime: 'datetime' };
const TYPE_TEXT = /^\s*([a-z]+)\s*(?:\(\s*([^)]*?)\s*\))?\s*$/i;
const DECIMAL_TEXT = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i;
const FLOAT_TEXT = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
const ISO_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.(\d{1,3}))?)?)?$/;
const US_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const COMPACT_DATE = /^(\d{4})(\d{2})(\d{2})$/;
const GUID_TEXT = /^\{?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}?$/i;
const CONVERSION_ERRORS = new Set([241, 242, 245, 8114, 8115, 8169, 9809]);
const QUOTES = {
  '[': ['[', ']'], ']': ['[', ']'], "'": ["'", "'"], '"': ['"', '"'], '(': ['(', ')'], ')': ['(', ')'],
  '<': ['<', '>'], '>': ['<', '>'], '{': ['{', '}'], '}': ['{', '}'], '`': ['`', '`'],
};
const DATE_PARTS = {
  year: ['year', 'yy', 'yyyy'], quarter: ['quarter', 'qq', 'q'], month: ['month', 'mm', 'm'],
  dayofyear: ['dayofyear', 'dy', 'y'], day: ['day', 'dd', 'd'], week: ['week', 'wk', 'ww'],
  weekday: ['weekday', 'dw', 'w'], hour: ['hour', 'hh'], minute: ['minute', 'mi', 'n'],
  second: ['second', 'ss', 's'], millisecond: ['millisecond', 'ms'],
};
const PART_BY_NAME = new Map(Object.entries(DATE_PARTS).flatMap(([part, names]) => names.map((n) => [n, part])));
// Named in Dataverse SQL's unsupported lists (analytic, ranking, cryptographic, metadata, security, ...).
const UNSUPPORTED = new Set([
  'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'NTILE', 'LAG', 'LEAD', 'FIRST_VALUE', 'LAST_VALUE',
  'PERCENT_RANK', 'CUME_DIST', 'PERCENTILE_CONT', 'PERCENTILE_DISC',
  'HASHBYTES', 'ENCRYPTBYKEY', 'DECRYPTBYKEY', 'ENCRYPTBYPASSPHRASE', 'DECRYPTBYPASSPHRASE',
  'ENCRYPTBYCERT', 'DECRYPTBYCERT', 'ENCRYPTBYASYMKEY', 'DECRYPTBYASYMKEY', 'SIGNBYCERT',
  'VERIFYSIGNEDBYCERT', 'SIGNBYASYMKEY', 'VERIFYSIGNEDBYASYMKEY', 'CERTENCODED', 'CERTPRIVATEKEY',
  'KEY_GUID', 'KEY_ID', 'KEY_NAME', 'CHECKSUM', 'BINARY_CHECKSUM', 'DECOMPRESS',
  'OPENQUERY', 'OPENROWSET', 'OPENDATASOURCE', 'OPENXML', 'OPENJSON', 'CONTAINSTABLE', 'FREETEXTTABLE',
  'STRING_SPLIT', 'TEXTPTR', 'TEXTVALID', 'TRIGGER_NESTLEVEL', 'COLUMNS_UPDATED', 'CURSOR_STATUS',
  'IDENTITY', 'ISJSON', 'SCOPE_IDENTITY', 'SERVERPROPERTY', 'STATS_DATE', 'PARSENAME', 'APP_NAME',
  'CONNECTIONPROPERTY', 'CONTEXT_INFO', 'CURRENT_REQUEST_ID', 'CURRENT_TRANSACTION_ID', 'HOST_ID',
  'HOST_NAME', 'SESSION_ID', 'XACT_STATE', 'MIN_ACTIVE_ROWVERSION', 'GET_FILESTREAM_TRANSACTION_CONTEXT',
  'ORIGINAL_LOGIN', 'SUSER_NAME', 'SUSER_SID', 'SUSER_SNAME', 'SUSER_ID', 'USER_NAME', 'USER_ID',
  'IS_MEMBER', 'IS_ROLEMEMBER', 'IS_SRVROLEMEMBER', 'HAS_PERMS_BY_NAME', 'PERMISSIONS',
]);
const UNSUPPORTED_FAMILY = /^(ERROR_|IDENT_|SQL_VARIANT_|JSON_|OBJECT_|DB_|COL_|COLUMNPROPERTY|DATABASEPROPERTY|OBJECTPROPERTY|TYPEPROPERTY|FILE|INDEX|TYPE_|SCHEMA_|FULLTEXT|APPLOCK_|ASSEMBLYPROPERTY|ORIGINAL_)/;

const FUNCTIONS = new Map();
const def = (name, minArgs, maxArgs, returns, fn) => FUNCTIONS.set(name, { minArgs, maxArgs, returns, fn });
// Static return types: returns(argTypes, extra) gives { type, length?, precision?, scale? } (length -1 is max).
// argTypes are the static types of the arguments; extra.target is the type text of CONVERT's first argument.
const STRING_KINDS = new Set(['nvarchar', 'varchar']);
const NUMERIC_KINDS = new Set(['int', 'bigint', 'smallint', 'tinyint', 'decimal', 'numeric', 'money', 'smallmoney', 'float', 'real']);
const TEXT = () => ({ type: 'nvarchar', length: 4000 });
const TEXT_OF_FIRST = ([a]) => (STRING_KINDS.has(a?.type) ? { type: 'nvarchar', length: a.length ?? 4000 } : TEXT());
const TEXT_ONE = () => ({ type: 'nvarchar', length: 1 });
const INT = () => ({ type: 'int' });
const BIGINT = () => ({ type: 'bigint' });
const FLOAT = () => ({ type: 'float' });
const DATETIME = () => ({ type: 'datetime' });
const GUID = () => ({ type: 'uniqueidentifier' });
const FIRST = ([a]) => ({ ...a });
const NUMERIC = ([a]) => (a.type === 'null' ? { type: 'int' } : NUMERIC_KINDS.has(a.type) ? { ...a } : { type: 'float' });
const ISNULL_TYPE = ([a, b]) => (a.type === 'null' ? { ...b } : { ...a });
const COMMON = (types) => commonType(types);

const PRECEDENCE = ['datetime', 'float', 'decimal', 'money', 'bigint', 'int', 'smallint', 'tinyint', 'bit',
  'uniqueidentifier', 'nvarchar', 'varchar', 'varbinary', 'binary'];
const RANK = new Map(PRECEDENCE.map((t, i) => [t, i]));
const aliasType = (t) => ({ real: 'float', numeric: 'decimal', char: 'varchar', nchar: 'nvarchar', smalldatetime: 'datetime' }[t] ?? t);

// Highest-precedence type among branch types; null when any branch type is unknown. A bare NULL takes no part.
export function commonType(metas) {
  if (metas.some((m) => m === null || m === undefined)) return null;
  const real = metas.filter((m) => m.type !== 'null').map((m) => ({ ...m, type: aliasType(m.type) }));
  if (!real.length) return { type: 'null' };
  const best = real.reduce((a, b) => ((RANK.get(b.type) ?? 99) < (RANK.get(a.type) ?? 99) ? b : a));
  if (STRING_KINDS.has(best.type)) {
    const strings = real.filter((m) => STRING_KINDS.has(m.type));
    const length = strings.reduce((max, m) => (max === -1 || m.length === -1 ? -1 : Math.max(max, m.length ?? 4000)), 0);
    return { type: strings.some((m) => m.type === 'nvarchar') ? 'nvarchar' : 'varchar', length };
  }
  return best;
}

// Static return type of a scalar function, or null when the name is unknown.
export function returnType(name, argTypes = [], extra = {}) {
  const fn = FUNCTIONS.get(String(name).toUpperCase());
  if (!fn) return null;
  return fn.returns(argTypes.map((a) => (typeof a === 'string' ? { type: a } : a)), extra);
}

const anyNull = (...xs) => xs.some((x) => x === null || x === undefined);
const fail = (number, message) => {
  throw { number, message };
};
const pad = (n, width = 2) => String(n).padStart(width, '0');
const fields = (d) => ({
  y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, day: d.getUTCDate(),
  h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), ms: d.getUTCMilliseconds(),
});
const daysIn = (y, month1) => new Date(Date.UTC(y, month1, 0)).getUTCDate();
const weekdaySun0 = (d) => (((Math.floor(d.getTime() / DAY) + 4) % 7) + 7) % 7;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&');

// Decimal text helpers: a value is { coef: BigInt, scale } meaning coef / 10^scale.
export function parseDecimal(text) {
  const m = DECIMAL_TEXT.exec(String(text).trim());
  if (!m || !(m[2] || m[3])) return null;
  const frac = m[3] ?? '';
  let coef = BigInt((m[2] || '0') + frac);
  let scale = frac.length - Number(m[4] ?? 0);
  if (scale < 0) {
    coef *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { coef: m[1] === '-' ? -coef : coef, scale };
}
export function formatDecimal({ coef, scale }) {
  const neg = coef < 0n;
  const digits = (neg ? -coef : coef).toString().padStart(scale + 1, '0');
  return (neg ? '-' : '') + (scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits);
}
const intDigits = (abs, scale) => {
  const ip = abs / 10n ** BigInt(scale);
  return ip === 0n ? 0 : ip.toString().length;
};
// Rounds to `length` places (negative: tens, hundreds, ...), keeping the input scale. Half away from zero
// unless truncate. `exact` (decimal input) rejects a carry that adds an integer digit.
function roundParts({ coef, scale }, length, truncate = false, exact = false) {
  if (length >= scale) return { coef, scale };
  const divisor = 10n ** BigInt(scale - length);
  const neg = coef < 0n;
  const abs = neg ? -coef : coef;
  let q = abs / divisor;
  if (!truncate && (abs % divisor) * 2n >= divisor) q += 1n;
  const result = q * divisor;
  if (exact && length < 0 && q > 0n && intDigits(result, scale) > intDigits(abs, scale)) {
    fail(8115, 'Arithmetic overflow error converting numeric to data type numeric.');
  }
  return { coef: neg ? -result : result, scale };
}
// Re-scales to `target` places, rounding half away from zero (CAST behaviour).
function rescale(p, target) {
  if (p.scale <= target) return { coef: p.coef * 10n ** BigInt(target - p.scale), scale: target };
  const r = roundParts(p, target);
  return { coef: r.coef / 10n ** BigInt(p.scale - target), scale: target };
}
const numericParts = (v) => {
  if (typeof v === 'number') return parseDecimal(String(v));
  if (typeof v === 'bigint') return { coef: v, scale: 0 };
  return parseDecimal(v.decimal);
};
// Argument coercion for numeric functions: strings convert to float, booleans to 0 or 1.
const numIn = (x) => {
  if (x instanceof Date) fail(8116, 'Argument data type datetime is invalid for argument 1 of numeric function.');
  if (typeof x === 'string') return toFloat(x, 'nvarchar');
  return typeof x === 'boolean' ? Number(x) : x;
};

// Datetime helpers. Date values are UTC; datetime range is 1753-01-01 to 9999-12-31.
const dtOf = (ms) => {
  if (!(ms >= DT_MIN && ms <= DT_MAX)) fail(517, "Adding a value to a 'datetime' column caused an overflow.");
  return new Date(ms);
};
const dateOf = (v) => (v instanceof Date ? v : toDatetime(v, undefined, 'nvarchar'));
function datepart(name) {
  const part = PART_BY_NAME.get(String(name).toLowerCase());
  if (!part) fail(155, `'${name}' is not a recognized datepart option.`);
  return part;
}
function addMonths(d, n) {
  const total = d.getUTCFullYear() * 12 + d.getUTCMonth() + n;
  const y = Math.floor(total / 12);
  const m = total - y * 12;
  if (y < 1753 || y > 9999) fail(517, "Adding a value to a 'datetime' column caused an overflow.");
  const day = Math.min(d.getUTCDate(), daysIn(y, m + 1));
  return dtOf(Date.UTC(y, m, day, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
}
function addPart(part, n, d) {
  const ms = d.getTime();
  switch (part) {
    case 'year': return addMonths(d, 12 * n);
    case 'quarter': return addMonths(d, 3 * n);
    case 'month': return addMonths(d, n);
    case 'dayofyear': case 'day': case 'weekday': return dtOf(ms + n * DAY);
    case 'week': return dtOf(ms + n * 7 * DAY);
    case 'hour': return dtOf(ms + n * 3600000);
    case 'minute': return dtOf(ms + n * 60000);
    case 'second': return dtOf(ms + n * 1000);
    default: return dtOf(ms + n);
  }
}
// Index of the datepart boundary that a date falls in; DATEDIFF subtracts two of these.
function boundary(part, d) {
  const ms = d.getTime();
  const day = Math.floor(ms / DAY);
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth();
  switch (part) {
    case 'year': return y;
    case 'quarter': return y * 4 + Math.floor(mo / 3);
    case 'month': return y * 12 + mo;
    case 'dayofyear': case 'day': case 'weekday': return day;
    case 'week': return Math.floor((day + 4) / 7); // Sunday-based weeks (DATEFIRST 7)
    case 'hour': return Math.floor(ms / 3600000);
    case 'minute': return Math.floor(ms / 60000);
    case 'second': return Math.floor(ms / 1000);
    default: return ms;
  }
}
function datePartValue(part, d) {
  const { y, mo, day, h, mi, s, ms } = fields(d);
  const days = Math.floor(d.getTime() / DAY);
  const jan1 = Date.UTC(y, 0, 1) / DAY;
  switch (part) {
    case 'year': return y;
    case 'quarter': return Math.floor((mo - 1) / 3) + 1;
    case 'month': return mo;
    case 'dayofyear': return days - jan1 + 1;
    case 'day': return day;
    case 'week': return Math.floor((days + 4) / 7) - Math.floor((jan1 + 4) / 7) + 1;
    case 'weekday': return weekdaySun0(d) + 1;
    case 'hour': return h;
    case 'minute': return mi;
    case 'second': return s;
    default: return ms;
  }
}

// Text and date formatting, used by CAST/CONVERT to string and by CONCAT, LEN and friends.
function formatDate(d, style) {
  const { y, mo, day, h, mi, s, ms } = fields(d);
  const date = `${pad(y, 4)}-${pad(mo)}-${pad(day)}`;
  const time = `${pad(h)}:${pad(mi)}:${pad(s)}`;
  switch (Number(style ?? 0)) {
    case 0: return `${MONTHS[mo - 1].slice(0, 3)} ${pad(day)} ${y} ${pad(h % 12 || 12)}:${pad(mi)}${h < 12 ? 'AM' : 'PM'}`;
    case 101: return `${pad(mo)}/${pad(day)}/${pad(y, 4)}`;
    case 103: return `${pad(day)}/${pad(mo)}/${pad(y, 4)}`;
    case 112: return `${pad(y, 4)}${pad(mo)}${pad(day)}`;
    case 120: return `${date} ${time}`;
    case 121: return `${date} ${time}.${pad(ms, 3)}`;
    case 126: return `${date}T${time}.${pad(ms, 3)}`;
    default: return fail(9809, `The style ${style} is not a valid style number for datetime.`);
  }
}
function textOf(value, style) {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(6)));
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return formatDate(value, style);
  return value.decimal;
}
export function toFloat(value, fromType) {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return (value.getTime() - EPOCH_1900) / DAY;
  if (typeof value === 'string') {
    const s = value.trim();
    if (FLOAT_TEXT.test(s)) return Number(s);
    return fail(8114, `Error converting data type ${fromType} to float.`);
  }
  return Number(value.decimal);
}
// varbinary to integer: big-endian two's complement, as CAST does. More than 8 bytes overflows.
function bytesToBigInt(buf) {
  if (buf.length > 8) fail(8115, 'Arithmetic overflow error converting expression to data type bigint.'); // unverified: from memory
  if (buf.length === 0) return 0n;
  let u = BigInt(`0x${buf.toString('hex')}`);
  if (buf[0] & 0x80) u -= 1n << BigInt(8 * buf.length);
  return u;
}
function toInteger(value, t, fromType) {
  let n;
  if (typeof value === 'string') {
    const s = value.trim();
    if (!/^[+-]?\d+$/.test(s)) fail(245, `Conversion failed when converting the ${fromType} value '${value}' to data type ${t.base}.`);
    n = BigInt(s);
  } else if (typeof value === 'boolean') n = value ? 1n : 0n;
  else if (value instanceof Date) n = BigInt(Math.floor((value.getTime() - EPOCH_1900) / DAY));
  else if (Buffer.isBuffer(value)) n = bytesToBigInt(value);
  else if (typeof value === 'bigint') n = value;
  else if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(8115, `Arithmetic overflow error converting expression to data type ${t.base}.`);
    n = BigInt(Math.trunc(value));
  } else {
    const p = parseDecimal(value.decimal);
    n = p.coef / 10n ** BigInt(p.scale); // truncates toward zero
  }
  const [min, max] = INT_RANGE[t.base];
  if (n < min || n > max) fail(8115, `Arithmetic overflow error converting expression to data type ${t.base}.`);
  return t.base === 'bigint' ? n : Number(n);
}
function toDecimal(value, t, fromType) {
  let parts;
  if (typeof value === 'string') parts = parseDecimal(value);
  else if (typeof value === 'boolean') parts = { coef: value ? 1n : 0n, scale: 0 };
  else if (value instanceof Date) parts = parseDecimal(String(toFloat(value)));
  else if (typeof value === 'object') parts = parseDecimal(value.decimal);
  else parts = parseDecimal(String(value));
  if (!parts) fail(8114, `Error converting data type ${fromType} to numeric.`);
  const r = rescale(parts, t.scale);
  const digits = (r.coef < 0n ? -r.coef : r.coef).toString().length;
  if (digits > t.precision) fail(8115, 'Arithmetic overflow error converting numeric to data type numeric.');
  return { decimal: formatDecimal(r) };
}
function toBit(value, fromType) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (FLOAT_TEXT.test(s)) return Number(s) !== 0;
    return fail(245, `Conversion failed when converting the ${fromType} value '${value}' to data type bit.`);
  }
  return toFloat(value, fromType) !== 0;
}
function toGuid(value) {
  const m = typeof value === 'string' ? GUID_TEXT.exec(value.trim()) : null;
  if (!m) fail(8169, 'Conversion failed when converting from a character string to uniqueidentifier.');
  return m[1].toUpperCase();
}
// Parses text per style. Unknown style numbers raise 9809; text that does not match raises 241.
function fromText(text, style) {
  const s = Number(style ?? 0);
  let m = null;
  let year; let month; let day;
  let [h, mi, sec, ms] = [0, 0, 0, 0];
  if (s === 101 || s === 103) {
    m = US_DATE.exec(text);
    if (m) {
      year = m[3];
      [month, day] = s === 101 ? [m[1], m[2]] : [m[2], m[1]];
    }
  } else if (s === 112) {
    m = COMPACT_DATE.exec(text);
    if (m) [year, month, day] = [m[1], m[2], m[3]];
  } else if (s === 0 || s === 120 || s === 121 || s === 126) {
    m = ISO_DATE.exec(text) ?? COMPACT_DATE.exec(text);
    if (m) {
      [year, month, day] = [m[1], m[2], m[3]];
      if (m[4] !== undefined) {
        h = Number(m[4]);
        mi = Number(m[5]);
        sec = m[6] === undefined ? 0 : Number(m[6]);
        ms = m[7] === undefined ? 0 : Number(m[7].padEnd(3, '0'));
      }
    }
  } else fail(9809, `The style ${style} is not a valid style number for datetime.`);
  if (!m) fail(241, 'Conversion failed when converting date and/or time from character string.');
  const [y, mo, d] = [Number(year), Number(month), Number(day)];
  if (y < 1753 || y > 9999) fail(242, 'The conversion of a varchar data type to a datetime data type resulted in an out-of-range value.');
  if (mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo) || h > 23 || mi > 59 || sec > 59) {
    fail(241, 'Conversion failed when converting date and/or time from character string.');
  }
  return new Date(Date.UTC(y, mo - 1, d, h, mi, sec, ms));
}
function toDatetime(value, style, fromType) {
  if (value instanceof Date) return new Date(value.getTime());
  if (typeof value === 'string') return fromText(value.trim(), style);
  if (typeof value === 'boolean') fail(8114, 'Error converting data type bit to datetime.');
  // Numbers are days since 1900-01-01 with an optional fraction of a day.
  const days = typeof value === 'object' ? Number(value.decimal) : Number(value);
  const whole = Math.trunc(days);
  const ms = EPOCH_1900 + whole * DAY + Math.round((days - whole) * DAY);
  if (!(ms >= DT_MIN && ms <= DT_MAX)) fail(8115, 'Arithmetic overflow error converting expression to data type datetime.');
  return new Date(ms);
}

// Parses a type spec such as "decimal(18,2)", "nvarchar(max)" or "int". Unknown types raise 2715.
// Static type of a CAST or CONVERT target spec such as 'varchar(10)' or 'decimal(10,2)'.
function metaOfTypeText(spec) {
  const t = parseType(spec);
  const meta = { type: t.base };
  if (t.length !== undefined) meta.length = t.length === Infinity ? -1 : t.length;
  if (t.precision !== undefined) Object.assign(meta, { precision: t.precision, scale: t.scale });
  return meta;
}

function parseType(spec) {
  const m = TYPE_TEXT.exec(String(spec));
  const raw = m ? m[1].toLowerCase() : '';
  if (raw === 'money' || raw === 'smallmoney') return { base: 'decimal', precision: raw === 'money' ? 19 : 10, scale: 4 };
  const base = TYPE_ALIAS[raw] ?? raw;
  const args = m?.[2] ? m[2].split(',').map((x) => x.trim()) : [];
  switch (base) {
    case 'decimal': return { base, precision: args[0] === undefined ? 18 : Number(args[0]), scale: args[1] === undefined ? 0 : Number(args[1]) };
    case 'varchar': case 'nvarchar': {
      let length = 30; // CAST and CONVERT default for character types without a length
      if (args[0] !== undefined) length = args[0].toLowerCase() === 'max' ? Infinity : Number(args[0]);
      return { base, length };
    }
    case 'binary': case 'varbinary': { // binary(n) defaults to 1 byte, varbinary(n) to 30; binary has no max
      const max = args[0] !== undefined && args[0].toLowerCase() === 'max';
      if (max && base === 'binary') fail(102, "Incorrect syntax near 'max'.");
      const length = args[0] === undefined ? (base === 'binary' ? 1 : 30) : max ? Infinity : Number(args[0]);
      return { base, length };
    }
    case 'int': case 'bigint': case 'smallint': case 'tinyint': case 'bit': case 'float': case 'datetime': case 'uniqueidentifier':
      return { base };
    default: return fail(2715, `Cannot find data type ${spec}.`);
  }
}

// Binary targets: text becomes its bytes (varchar single-byte, nvarchar UTF-16LE), integers big-endian (4 bytes,
// 8 when wider), bit one byte. binary(n) pads with zero bytes; both truncate to the length.
// ponytail: varchar uses latin1 (code units above 0xFF are cut), not the database code page.
function toBinary(value, t, fromType) {
  let bytes;
  if (Buffer.isBuffer(value)) bytes = value;
  else if (typeof value === 'string') bytes = Buffer.from(value, fromType === 'varchar' ? 'latin1' : 'utf16le');
  else if (typeof value === 'bigint') { bytes = Buffer.alloc(8); bytes.writeBigInt64BE(value); }
  else if (typeof value === 'number' && Number.isInteger(value)) {
    if (value >= -2147483648 && value <= 2147483647) { bytes = Buffer.alloc(4); bytes.writeInt32BE(value); }
    else { bytes = Buffer.alloc(8); bytes.writeBigInt64BE(BigInt(value)); }
  } else if (typeof value === 'boolean') bytes = Buffer.from([value ? 1 : 0]);
  else fail(8114, `Error converting data type ${fromType} to ${t.base}.`); // unverified: from memory
  if (t.base === 'binary') {
    const out = Buffer.alloc(t.length);
    bytes.copy(out, 0, 0, t.length);
    return out;
  }
  return Buffer.from(t.length === Infinity ? bytes : bytes.subarray(0, t.length));
}

// CAST and CONVERT. Strings truncate to the target length; text-to-number failures raise 245 (int) or 8114.
export function castValue(value, spec, { style, fromType = 'nvarchar' } = {}) {
  const t = parseType(spec);
  if (value === null || value === undefined) return null;
  if (t.base === 'binary' || t.base === 'varbinary') return toBinary(value, t, fromType);
  if (Buffer.isBuffer(value)) { // varbinary: text reads bytes as characters (utf16le for nvarchar), integers read big-endian
    if (t.base === 'varchar' || t.base === 'nvarchar') {
      return (t.base === 'nvarchar' ? value.toString('utf16le') : value.toString('latin1')).slice(0, t.length); // unverified: from memory
    }
    if (!['int', 'bigint', 'smallint', 'tinyint'].includes(t.base)) fail(8114, `Error converting data type varbinary to ${t.base}.`);
  }
  switch (t.base) {
    case 'int': case 'bigint': case 'smallint': case 'tinyint': return toInteger(value, t, fromType);
    case 'bit': return toBit(value, fromType);
    case 'decimal': return toDecimal(value, t, fromType);
    case 'float': return toFloat(value, fromType);
    case 'varchar': case 'nvarchar': return textOf(value, style).slice(0, t.length);
    case 'datetime': return toDatetime(value, style, fromType);
    default: return toGuid(value);
  }
}

// Ordering used by NULLIF and comparisons. Strings compare with trailing spaces ignored.
// Data type precedence: a string or varbinary operand converts to the type of the other operand.
// int/bigint/decimal/float follow the other operand's type; datetime and binary likewise.
function convertOperand(v, other) {
  if (typeof v === 'string' && !Buffer.isBuffer(other)) {
    if (typeof other === 'string') return v;
    if (other instanceof Date) return toDatetime(v, undefined, 'nvarchar');
    if (typeof other === 'bigint') return castValue(v, 'bigint');
    if (isDecimalValue(other)) {
      const p = parseDecimal(v);
      if (!p) fail(8114, 'Error converting data type nvarchar to numeric.');
      return { decimal: formatDecimal(p) };
    }
    if (typeof other === 'number' && !Number.isInteger(other)) return toFloat(v, 'nvarchar');
    return castValue(v, 'int');
  }
  if (Buffer.isBuffer(v)) {
    if (typeof other === 'string') return castValue(v, 'nvarchar');
    if (other instanceof Date) return castValue(v, 'datetime');
    if (typeof other === 'bigint') return castValue(v, 'bigint');
    if (isDecimalValue(other)) return castValue(v, 'decimal(38,0)');
    return castValue(v, 'int');
  }
  return v;
}
const isDecimalValue = (v) => v !== null && typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v) && 'decimal' in v;

export function compareValues(a, b, ctx, typeA = null, typeB = null) {
  const ord = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  // A string meets varbinary through its own encoding: varchar is single-byte, nvarchar is UTF-16LE.
  if (Buffer.isBuffer(a) && typeof b === 'string') b = Buffer.from(b, typeB === 'nvarchar' ? 'utf16le' : 'latin1');
  else if (Buffer.isBuffer(b) && typeof a === 'string') a = Buffer.from(a, typeA === 'nvarchar' ? 'utf16le' : 'latin1');
  if (Buffer.isBuffer(a) && Buffer.isBuffer(b)) return Buffer.compare(a, b);
  const x0 = convertOperand(a, b);
  const y0 = convertOperand(b, a);
  if (typeof x0 === 'string' && typeof y0 === 'string') {
    let x = x0.replace(/ +$/, '');
    let y = y0.replace(/ +$/, '');
    if (!ctx.caseSensitive) {
      x = x.toLowerCase();
      y = y.toLowerCase();
    }
    return ord(x, y);
  }
  if (x0 instanceof Date || y0 instanceof Date) return ord(dateOf(x0).getTime(), dateOf(y0).getTime());
  const numOf = (v) => (typeof v === 'boolean' ? Number(v) : v);
  const x = numericParts(numOf(x0));
  const y = numericParts(numOf(y0));
  const s = Math.max(x.scale, y.scale);
  return ord(x.coef * 10n ** BigInt(s - x.scale), y.coef * 10n ** BigInt(s - y.scale));
}

// String functions. Every one returns null for a NULL argument unless noted (CONCAT, CONCAT_WS).
const likeToRegExp = (pattern, ctx) => {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    const close = c === '[' ? pattern.indexOf(']', i + 1) : -1;
    if (c === '%') out += '[\\s\\S]*';
    else if (c === '_') out += '[\\s\\S]';
    else if (close > i + 1) {
      const negate = pattern[i + 1] === '^';
      const body = pattern.slice(i + 1 + (negate ? 1 : 0), close).replace(/[\\\]\[]/g, '\\$&');
      out += `[${negate ? '^' : ''}${body}]`;
      i = close;
    } else out += escapeRe(c);
  }
  return new RegExp(out, ctx.caseSensitive ? '' : 'i');
};
const dateFormatTokens = /yyyy|yy|MMMM|MMM|MM|M|dddd|ddd|dd|d|HH|H|hh|h|mm|m|ss|s|fff|tt|'[^']*'|[\s\S]/g;
function dateFormat(d, pattern, locale) {
  const { y, mo, day, h, mi, s, ms } = fields(d);
  const h12 = h % 12 || 12;
  const named = (opts) => new Intl.DateTimeFormat(locale, { timeZone: 'UTC', ...opts }).format(d);
  const map = {
    yyyy: pad(y, 4), yy: pad(y % 100), MMMM: named({ month: 'long' }), MMM: named({ month: 'short' }), MM: pad(mo), M: String(mo),
    dddd: named({ weekday: 'long' }), ddd: named({ weekday: 'short' }), dd: pad(day), d: String(day), HH: pad(h), H: String(h),
    hh: pad(h12), h: String(h12), mm: pad(mi), m: String(mi), ss: pad(s), s: String(s), fff: pad(ms, 3), tt: h < 12 ? 'AM' : 'PM',
  };
  return pattern.replace(dateFormatTokens, (t) => {
    if (t.length > 1 && t.startsWith("'")) return t.slice(1, -1);
    return Object.hasOwn(map, t) ? map[t] : t;
  });
}
function numberFormat(n, pattern, locale) {
  if (!/^[#0,.]+$/.test(pattern)) fail(195, `FORMAT pattern '${pattern}' is not supported by this library.`);
  const sep = separators(locale);
  const [intPat, fracPat = ''] = pattern.split('.');
  const minInt = (intPat.match(/0/g) ?? []).length;
  const minFrac = (fracPat.match(/0/g) ?? []).length;
  let [int, frac = ''] = Math.abs(n).toFixed(fracPat.length).split('.');
  while (frac.length > minFrac && frac.endsWith('0')) frac = frac.slice(0, -1);
  if (int === '0' && minInt === 0) int = '';
  int = int.padStart(minInt, '0');
  if (intPat.includes(',')) int = int.replace(/\B(?=(\d{3})+(?!\d))/g, sep.group);
  const body = (int + (frac ? `${sep.decimal}${frac}` : '')) || '0';
  return (n < 0 && /[1-9]/.test(body) ? '-' : '') + body;
}

def('LEN', 1, 1, INT, ([s]) => (s === null ? null : textOf(s).replace(/ +$/, '').length));
def('DATALENGTH', 1, 1, INT, ([v]) => {
  if (v === null) return null;
  if (typeof v === 'string') return 2 * v.length;
  if (typeof v === 'boolean') return 1;
  if (v instanceof Date || typeof v === 'bigint') return 8;
  if (typeof v === 'number') return Number.isInteger(v) && v >= -2147483648 && v <= 2147483647 ? 4 : 8;
  return 17; // decimal storage depends on the declared precision, which the value does not carry
});
def('LEFT', 2, 2, TEXT_OF_FIRST, ([s, n]) => {
  if (anyNull(s, n)) return null;
  if (Number(n) < 0) fail(536, 'Invalid length parameter passed to the LEFT function.');
  return textOf(s).slice(0, Number(n));
});
def('RIGHT', 2, 2, TEXT_OF_FIRST, ([s, n]) => {
  if (anyNull(s, n)) return null;
  if (Number(n) < 0) fail(536, 'Invalid length parameter passed to the RIGHT function.');
  const str = textOf(s);
  return str.slice(Math.max(0, str.length - Number(n)));
});
def('SUBSTRING', 3, 3, TEXT_OF_FIRST, ([s, start, len]) => {
  if (anyNull(s, start, len)) return null;
  if (Number(len) < 0) fail(537, 'Invalid length parameter passed to the substring function.');
  const str = textOf(s);
  const first = Math.max(Number(start), 1);
  const last = Math.min(Number(start) + Number(len) - 1, str.length);
  return last < first ? '' : str.slice(first - 1, last);
});
def('CHARINDEX', 2, 3, INT, ([find, s, start], ctx) => {
  if (find === null || s === null || start === null) return null;
  const needle = textOf(find);
  if (!needle) return 0;
  const fold = ctx.caseSensitive ? (x) => x : (x) => x.toLowerCase();
  const from = start === undefined ? 1 : Math.max(Number(start), 1);
  const at = fold(textOf(s)).indexOf(fold(needle), from - 1);
  return at < 0 ? 0 : at + 1;
});
def('PATINDEX', 2, 2, INT, ([pattern, s], ctx) => {
  if (anyNull(pattern, s)) return null;
  // Leading % wildcards do not move the reported start: '%[0-9]%' reports the first digit.
  const re = likeToRegExp(textOf(pattern).replace(/^%+/, ''), ctx);
  const m = re.exec(textOf(s));
  return m ? m.index + 1 : 0;
});
def('REPLACE', 3, 3, TEXT, ([s, from, to], ctx) => {
  if (anyNull(s, from, to)) return null;
  const pattern = textOf(from);
  const str = textOf(s);
  if (!pattern) return str;
  return str.replace(new RegExp(escapeRe(pattern), ctx.caseSensitive ? 'g' : 'gi'), () => textOf(to));
});
def('REPLICATE', 2, 2, TEXT, ([s, n]) => {
  if (anyNull(s, n) || Number(n) < 0) return null;
  return textOf(s).repeat(Number(n));
});
def('REVERSE', 1, 1, TEXT_OF_FIRST, ([s]) => (s === null ? null : Array.from(textOf(s)).reverse().join('')));
def('LOWER', 1, 1, TEXT_OF_FIRST, ([s]) => (s === null ? null : textOf(s).toLowerCase()));
def('UPPER', 1, 1, TEXT_OF_FIRST, ([s]) => (s === null ? null : textOf(s).toUpperCase()));
def('LTRIM', 1, 1, TEXT_OF_FIRST, ([s]) => (s === null ? null : textOf(s).replace(/^ +/, '')));
def('RTRIM', 1, 1, TEXT_OF_FIRST, ([s]) => (s === null ? null : textOf(s).replace(/ +$/, '')));
// TRIM(s) removes spaces. TRIM(characters, s) follows TRIM(characters FROM s): args are [characters, string].
def('TRIM', 1, 2, TEXT_OF_FIRST, (args) => {
  if (args.length === 1) return args[0] === null ? null : textOf(args[0]).replace(/^ +| +$/g, '');
  const [chars, s] = args;
  if (anyNull(chars, s)) return null;
  const set = textOf(chars);
  const str = textOf(s);
  let a = 0;
  let b = str.length;
  while (a < b && set.includes(str[a])) a += 1;
  while (b > a && set.includes(str[b - 1])) b -= 1;
  return str.slice(a, b);
});
// CONCAT treats NULL as an empty string; CONCAT_WS skips NULL arguments and returns NULL for a NULL separator.
def('CONCAT', 2, 254, TEXT, (args) => args.map((v) => (v === null ? '' : textOf(v))).join(''));
def('CONCAT_WS', 3, 254, TEXT, ([sep, ...rest]) => {
  if (sep === null) return null;
  return rest.filter((v) => v !== null).map((v) => textOf(v)).join(textOf(sep));
});
def('STUFF', 4, 4, TEXT, ([s, start, len, ins]) => {
  if (anyNull(s, start, len, ins)) return null;
  const str = textOf(s);
  const at = Number(start);
  const n = Number(len);
  if (at < 1 || n < 0 || at > str.length) return null;
  const take = Math.min(n, str.length - at + 1);
  return str.slice(0, at - 1) + textOf(ins) + str.slice(at - 1 + take);
});
def('SPACE', 1, 1, TEXT, ([n]) => (n === null || Number(n) < 0 ? null : ' '.repeat(Number(n))));
def('STR', 1, 3, TEXT, ([f, length, dec]) => {
  if (f === null) return null;
  const width = length === undefined ? 10 : length;
  const places = dec === undefined ? 0 : dec;
  if (anyNull(width, places)) return null;
  const text = toFloat(f, 'nvarchar').toFixed(Number(places));
  return text.length > Number(width) ? '*'.repeat(Number(width)) : text.padStart(Number(width));
});
// FORMAT(value, format [, culture]). Culture defaults to en-US. A NULL argument, or a culture Intl does not
// recognise, gives NULL. Standard formats N, C, P (numbers) and d, D (dates) plus custom patterns are culture-aware.
const NUMBER_STANDARD = /^([NCP])(\d{0,2})$/i;
const DATE_STANDARD = {
  d: { year: 'numeric', month: '2-digit', day: '2-digit' },
  D: { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' },
};
// ponytail: common regions only; a region not listed formats currency with the no-currency code XXX.
const CURRENCY_BY_REGION = {
  US: 'USD', GB: 'GBP', JP: 'JPY', IN: 'INR', CN: 'CNY', CA: 'CAD', AU: 'AUD', CH: 'CHF', BR: 'BRL', RU: 'RUB', KR: 'KRW',
  DE: 'EUR', FR: 'EUR', IT: 'EUR', ES: 'EUR', NL: 'EUR', AT: 'EUR', BE: 'EUR', IE: 'EUR', PT: 'EUR', FI: 'EUR', GR: 'EUR',
};
const cultureOf = (name) => {
  let tag;
  try {
    [tag] = Intl.getCanonicalLocales(String(name).trim());
  } catch (e) {
    return null;
  }
  return Intl.NumberFormat.supportedLocalesOf(tag).length ? tag : null;
};
function separators(locale) {
  const parts = new Intl.NumberFormat(locale).formatToParts(1000.5);
  return {
    group: parts.find((p) => p.type === 'group')?.value ?? ',',
    decimal: parts.find((p) => p.type === 'decimal')?.value ?? '.',
  };
}
function standardNumber(n, letter, precision, locale) {
  const opts = letter === 'C'
    ? { style: 'currency', currency: CURRENCY_BY_REGION[new Intl.Locale(locale).maximize().region] ?? 'XXX' }
    : { style: letter === 'P' ? 'percent' : 'decimal' };
  if (precision !== '') opts.minimumFractionDigits = opts.maximumFractionDigits = Number(precision);
  else if (letter !== 'C') opts.minimumFractionDigits = opts.maximumFractionDigits = 2; // N and P default to two places
  return new Intl.NumberFormat(locale, opts).format(n);
}
def('FORMAT', 2, 3, TEXT, ([v, fmt, culture]) => {
  if (v === null || fmt === null || culture === null) return null;
  const locale = cultureOf(culture === undefined ? 'en-US' : textOf(culture));
  if (!locale) return null;
  const pattern = textOf(fmt);
  if (v instanceof Date) {
    return Object.hasOwn(DATE_STANDARD, pattern)
      ? new Intl.DateTimeFormat(locale, { timeZone: 'UTC', ...DATE_STANDARD[pattern] }).format(v)
      : dateFormat(v, pattern, locale);
  }
  if (typeof v === 'string' || typeof v === 'boolean') {
    fail(8116, `Argument data type ${typeof v === 'string' ? 'nvarchar' : 'bit'} is invalid for argument 1 of format function.`);
  }
  const n = toFloat(v, 'nvarchar');
  const standard = NUMBER_STANDARD.exec(pattern);
  return standard ? standardNumber(n, standard[1].toUpperCase(), standard[2], locale) : numberFormat(n, pattern, locale);
});

// FORMATMESSAGE(msg, args...): printf-style %s %d %i %u %x %X %o %% with flags - 0 +, width and .precision.
// NULL arguments print as (null). A message number would read sys.messages, which this library does not have.
const PLACEHOLDER = /%([-0+]*)(\d*)(?:\.(\d+))?([sdiuxXo%])/g;
const RADIX = { d: 10, i: 10, u: 10, x: 16, X: 16, o: 8 };
function formatMessageArg(flags, width, precision, type, v) {
  let sign = '';
  let body;
  if (type === 's' || v === null) {
    body = v === null ? '(null)' : textOf(v);
    if (precision !== undefined) body = body.slice(0, Number(precision));
  } else {
    const n = castValue(v, 'bigint');
    const signed = type === 'd' || type === 'i';
    if (signed && n < 0n) sign = '-';
    else if (signed && flags.includes('+')) sign = '+';
    // Unsigned views of negative values use 32 bits when the value fits an int, else 64 bits.
    const magnitude = signed ? (n < 0n ? -n : n) : BigInt.asUintN(n < 0n && n >= -(2n ** 31n) ? 32 : 64, n);
    body = magnitude.toString(RADIX[type]);
    if (type === 'X') body = body.toUpperCase();
    if (precision !== undefined) body = body.padStart(Number(precision), '0');
    else if (flags.includes('0') && !flags.includes('-')) body = body.padStart(width - sign.length, '0');
  }
  const text = sign + body;
  return flags.includes('-') ? text.padEnd(width) : text.padStart(width);
}
def('FORMATMESSAGE', 1, 254, TEXT, ([msg, ...args]) => {
  if (msg === null) return null;
  if (typeof msg === 'number' || typeof msg === 'bigint') fail(195, "'FORMATMESSAGE' is not supported in Dataverse SQL.");
  let next = 0;
  return textOf(msg).replace(PLACEHOLDER, (_, flags, width, precision, type) => {
    if (type === '%') return '%';
    if (next >= args.length) fail(2787, 'The message string has more placeholders than parameters supplied.');
    return formatMessageArg(flags, Number(width || 0), precision, type, args[next++]);
  });
});
def('QUOTENAME', 1, 2, TEXT, ([s, q]) => {
  if (s === null || q === null) return null;
  const pair = QUOTES[q === undefined ? '[' : textOf(q)];
  if (!pair) return null;
  const str = textOf(s);
  if (str.length > 128) return null;
  const [open, close] = pair;
  return open + str.split(close).join(close + close) + close;
});
def('ASCII', 1, 1, INT, ([s]) => {
  if (s === null) return null;
  const str = textOf(s);
  if (!str) return null;
  const code = str.charCodeAt(0);
  return code <= 255 ? code : 63; // no single-byte code page value: the conversion yields '?'
});
def('CHAR', 1, 1, TEXT_ONE, ([n]) => {
  if (n === null || Number(n) < 0 || Number(n) > 255) return null;
  return String.fromCharCode(Number(n));
});
def('UNICODE', 1, 1, INT, ([s]) => {
  if (s === null) return null;
  const str = textOf(s);
  return str ? str.charCodeAt(0) : null;
});
def('NCHAR', 1, 1, TEXT_ONE, ([n]) => {
  if (n === null || Number(n) < 0 || Number(n) > 65535) return null;
  return String.fromCharCode(Number(n));
});

// Date functions. Dates are UTC; string arguments parse with the default datetime style.
const nowOf = (ctx) => {
  const src = ctx.now;
  const d = typeof src === 'function' ? src() : (src ?? new Date());
  return new Date(d.getTime());
};
def('GETDATE', 0, 0, DATETIME, (_, ctx) => nowOf(ctx));
def('GETUTCDATE', 0, 0, DATETIME, (_, ctx) => nowOf(ctx));
def('SYSDATETIME', 0, 0, DATETIME, (_, ctx) => nowOf(ctx));
def('SYSUTCDATETIME', 0, 0, DATETIME, (_, ctx) => nowOf(ctx));
def('DATEADD', 3, 3, DATETIME, ([part, n, d]) => {
  if (anyNull(part, n, d)) return null;
  return addPart(datepart(part), Math.trunc(Number(n)), dateOf(d));
});
// DATEDIFF counts boundaries crossed, not elapsed time: 23:59 and 00:01 the next day is one day.
def('DATEDIFF', 3, 3, INT, ([part, a, b]) => {
  if (anyNull(part, a, b)) return null;
  const p = datepart(part);
  const diff = boundary(p, dateOf(b)) - boundary(p, dateOf(a));
  if (Math.abs(diff) > 2147483647) {
    fail(535, 'The datediff function resulted in an overflow. The number of dateparts separating two date/time instances is too large. Try to use datediff with a less precise datepart.');
  }
  return diff;
});
def('DATEPART', 2, 2, INT, ([part, d]) => (anyNull(part, d) ? null : datePartValue(datepart(part), dateOf(d))));
def('DATENAME', 2, 2, TEXT, ([part, d]) => {
  if (anyNull(part, d)) return null;
  const p = datepart(part);
  const date = dateOf(d);
  if (p === 'month') return MONTHS[date.getUTCMonth()];
  if (p === 'weekday') return DAYS[weekdaySun0(date)];
  return String(datePartValue(p, date));
});
def('YEAR', 1, 1, INT, ([d]) => (d === null ? null : datePartValue('year', dateOf(d))));
def('MONTH', 1, 1, INT, ([d]) => (d === null ? null : datePartValue('month', dateOf(d))));
def('DAY', 1, 1, INT, ([d]) => (d === null ? null : datePartValue('day', dateOf(d))));
def('EOMONTH', 1, 2, DATETIME, ([d, offset]) => {
  if (d === null || offset === null) return null;
  const base = addMonths(dateOf(d), offset === undefined ? 0 : Number(offset));
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0));
});
def('DATEFROMPARTS', 3, 3, DATETIME, ([y, m, d]) => {
  if (anyNull(y, m, d)) return null;
  const [yy, mm, dd] = [Number(y), Number(m), Number(d)];
  if (yy < 1753 || yy > 9999 || mm < 1 || mm > 12 || dd < 1 || dd > daysIn(yy, mm)) {
    fail(289, 'Cannot construct data type date, some of the arguments have values which are not valid.');
  }
  return new Date(Date.UTC(yy, mm - 1, dd));
});
def('ISDATE', 1, 1, INT, ([v]) => {
  if (v === null) return 0;
  try {
    castValue(v, 'datetime');
    return 1;
  } catch (e) {
    return 0;
  }
});

// Math functions. Exact types (decimal, bigint) keep their type; float functions return float.
const floatOut = (r) => {
  if (Number.isNaN(r)) fail(3623, 'An invalid floating point operation occurred.');
  if (!Number.isFinite(r)) fail(3634, 'The floating point operation resulted in an overflow.');
  return r;
};
const positiveOrFail = (x) => {
  if (x <= 0) fail(3623, 'An invalid floating point operation occurred.');
  return x;
};
const mulberry32 = (seed) => {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = ((t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
function roundToInteger(x, mode) {
  if (x === null) return null;
  const v = numIn(x);
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return Math[mode](v);
  const { coef, scale } = parseDecimal(v.decimal);
  const div = 10n ** BigInt(scale);
  const q = coef / div;
  const rem = coef % div;
  const adjust = rem !== 0n && (mode === 'ceil' ? coef > 0n : coef < 0n);
  return { decimal: (adjust ? (mode === 'ceil' ? q + 1n : q - 1n) : q).toString() };
}
def('ABS', 1, 1, NUMERIC, ([x]) => {
  if (x === null) return null;
  const v = numIn(x);
  if (typeof v === 'bigint') return v < 0n ? -v : v;
  if (typeof v === 'number') return Math.abs(v);
  const p = parseDecimal(v.decimal);
  return { decimal: formatDecimal({ coef: p.coef < 0n ? -p.coef : p.coef, scale: p.scale }) };
});
def('CEILING', 1, 1, NUMERIC, ([x]) => roundToInteger(x, 'ceil'));
def('FLOOR', 1, 1, NUMERIC, ([x]) => roundToInteger(x, 'floor'));
def('ROUND', 2, 3, NUMERIC, ([x, len, fn]) => {
  if (x === null || len === null || fn === null) return null;
  const k = Number(len);
  const truncate = fn !== undefined && Number(fn) !== 0;
  const v = numIn(x);
  if (typeof v === 'bigint') return BigInt(formatDecimal(roundParts({ coef: v, scale: 0 }, k, truncate)));
  if (typeof v === 'number') return Number(formatDecimal(roundParts(parseDecimal(String(v)), k, truncate)));
  return { decimal: formatDecimal(roundParts(parseDecimal(v.decimal), k, truncate, true)) };
});
def('SIGN', 1, 1, NUMERIC, ([x]) => {
  if (x === null) return null;
  const v = numIn(x);
  if (typeof v === 'bigint') return v > 0n ? 1n : v < 0n ? -1n : 0n;
  if (typeof v === 'number') return Math.sign(v) || 0;
  const { coef } = parseDecimal(v.decimal);
  return { decimal: coef > 0n ? '1' : coef < 0n ? '-1' : '0' };
});
def('POWER', 2, 2, FLOAT, ([x, y]) => (anyNull(x, y) ? null : floatOut(toFloat(x, 'nvarchar') ** toFloat(y, 'nvarchar'))));
def('SQRT', 1, 1, FLOAT, ([x]) => (x === null ? null : floatOut(Math.sqrt(toFloat(x, 'nvarchar')))));
def('SQUARE', 1, 1, FLOAT, ([x]) => {
  if (x === null) return null;
  const v = toFloat(x, 'nvarchar');
  return floatOut(v * v);
});
def('EXP', 1, 1, FLOAT, ([x]) => (x === null ? null : floatOut(Math.exp(toFloat(x, 'nvarchar')))));
def('LOG', 1, 1, FLOAT, ([x]) => (x === null ? null : floatOut(Math.log(positiveOrFail(toFloat(x, 'nvarchar'))))));
def('LOG10', 1, 1, FLOAT, ([x]) => (x === null ? null : floatOut(Math.log10(positiveOrFail(toFloat(x, 'nvarchar'))))));
def('PI', 0, 0, FLOAT, () => Math.PI);
// RAND(seed) reseeds the statement's generator (ctx.rng) and returns its first value; RAND() continues it.
def('RAND', 0, 1, FLOAT, (args, ctx) => {
  if (args.length && args[0] === null) return null;
  if (args.length) ctx.rng = mulberry32(Math.trunc(Number(args[0])));
  if (ctx.rng) return ctx.rng();
  return (ctx.random ?? Math.random)();
});

// Logical functions.
def('ISNULL', 2, 2, ISNULL_TYPE, ([a, b]) => (a === null ? b : a));
def('COALESCE', 2, 254, COMMON, (args) => {
  const v = args.find((x) => x !== null);
  return v === undefined ? null : v;
});
def('NULLIF', 2, 2, FIRST, ([a, b], ctx) => (a === null || b === null || compareValues(a, b, ctx) !== 0 ? a : null));
def('IIF', 3, 3, (t) => commonType(t.slice(1)), ([cond, a, b]) => (cond === true ? a : b));
def('CHOOSE', 2, 254, (t) => commonType(t.slice(1)), ([i, ...values]) => {
  if (i === null) return null;
  const k = Math.trunc(Number(i));
  return k >= 1 && k <= values.length ? values[k - 1] : null;
});

// System functions. NEWID is random, not sequential.
def('NEWID', 0, 0, GUID, (_, ctx) => (ctx.newId ? ctx.newId() : randomUUID().toUpperCase()));
// NEWSEQUENTIALID: a random GUID prefix fixed per process, with a process-wide counter in the last 12 hex digits.
// ponytail: counter is process-wide, not per statement; the prefix is not reset between statements.
const SEQ_PREFIX = randomUUID().toUpperCase().slice(0, 24);
let seqCounter = 0;
def('NEWSEQUENTIALID', 0, 0, GUID, () => {
  seqCounter += 1;
  return SEQ_PREFIX + seqCounter.toString(16).toUpperCase().padStart(12, '0');
});
def('ROWCOUNT_BIG', 0, 0, BIGINT, (_, ctx) => BigInt(ctx.rowCount ?? 0));
def('GETANSINULL', 0, 1, INT, (_, ctx) => (ctx.ansiNulls === false ? 0 : 1));
def('ISNUMERIC', 1, 1, INT, ([v]) => {
  if (v === null || v instanceof Date) return 0;
  if (typeof v === 'string') return FLOAT_TEXT.test(v.trim()) ? 1 : 0;
  return 1;
});

// CONVERT(type, value, style) and TRY_CONVERT. The first argument is the type text.
def('CONVERT', 2, 3, (_t, extra) => metaOfTypeText(extra.target), ([type, v, style]) => castValue(v, type, { style }));
def('TRY_CONVERT', 2, 3, (_t, extra) => metaOfTypeText(extra.target), ([type, v, style]) => {
  try {
    return castValue(v, type, { style });
  } catch (e) {
    if (CONVERSION_ERRORS.has(e.number)) return null;
    throw e;
  }
});

// Keys are uppercase names; each entry is { minArgs, maxArgs, returns(argTypes, extra), fn(args, ctx) }.
export { FUNCTIONS };

// Calls a scalar function by name with evaluated arguments. Names are case-insensitive.
export function callFunction(name, args = [], ctx = {}) {
  const key = String(name).toUpperCase();
  const fn = FUNCTIONS.get(key);
  if (!fn) {
    if (UNSUPPORTED.has(key) || UNSUPPORTED_FAMILY.test(key)) fail(195, `'${key}' is not supported in Dataverse SQL.`);
    fail(195, `'${name}' is not a recognized built-in function name.`);
  }
  if (args.length < fn.minArgs || args.length > fn.maxArgs) {
    const expected = fn.minArgs === fn.maxArgs ? fn.minArgs : `between ${fn.minArgs} and ${fn.maxArgs}`;
    fail(174, `The ${key.toLowerCase()} function requires ${expected} argument(s).`);
  }
  return fn.fn(args, ctx);
}

// @@-variables. Unknown variables and the unsupported ones raise 195.
const UNSUPPORTED_VARIABLES = new Set(['@@ERROR', '@@IDENTITY', '@@PACK_RECEIVED', '@@TRANCOUNT']);
export function systemVariable(name, ctx = {}) {
  const key = String(name).toUpperCase();
  if (key === '@@VERSION') return ctx.version ?? 'Microsoft SQL Azure (RTM) - 12.0.2000.8';
  if (key === '@@ROWCOUNT') return ctx.rowCount ?? 0;
  if (UNSUPPORTED_VARIABLES.has(key)) fail(195, `'${key}' is not supported in Dataverse SQL.`);
  return fail(195, `'${name}' is not a recognized system variable.`);
}
