// MS-TDS data type codecs for the Dataverse TDS endpoint: COLMETADATA (0x81),
// ROW (0xD1), NBCROW (0xD2) and typed RPC values (TYPE_INFO followed by the value).
// Pure functions, no I/O.
//
//   columnMetadata(columns)            -> Buffer, COLMETADATA token (0xFFFF count when empty)
//   row(columns, values)               -> Buffer, ROW token
//   nbcRow(columns, values)            -> Buffer, NBCROW token (null bitmap; NULL columns carry no data)
//   encodeTypedValue(column, value)    -> Buffer, TYPE_INFO + value (sp_executesql parameter form)
//   decodeTypedValue(buffer, offset)   -> { value, type, next }
//   decodeRow(columns, buffer, offset) -> { values, next } for ROW or NBCROW
//
// column: { name, type, length?, precision?, scale?, nullable? (default true) }
//   type: int bigint smallint tinyint bit float real money decimal numeric
//         datetime smalldatetime date datetime2 uniqueidentifier nvarchar
//   nvarchar: length 1-4000 characters; undefined or 'max' is NVARCHAR(MAX) (PLP, chunked)
//   decimal/numeric: precision 1-38 (default 18), scale 0-precision (default 0)
//   datetime2: scale 0-7 (default 7)
// Values (null or undefined is NULL):
//   bit: boolean. tinyint/smallint/int: number. bigint: BigInt (number accepted in, BigInt out).
//   real/float: number. money: decimal string with 4 fraction digits out.
//   decimal/numeric: decimal string such as '-12.3400', returned with exactly the column scale.
//   date: 'YYYY-MM-DD'. datetime2: 'YYYY-MM-DD hh:mm:ss[.f]' with `scale` fraction digits.
//   datetime: 'YYYY-MM-DD hh:mm:ss.sss' in 1/300 s ticks, rounded as SQL Server does.
//   smalldatetime: 'YYYY-MM-DD hh:mm:00' (minutes; seconds round to the nearest minute in).
//   uniqueidentifier: 'XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX' (decoded upper case).
//   nvarchar: string.
// ponytail: time, datetimeoffset, varchar, smallmoney and sql_variant are not implemented;
//   add each when a catalog column needs it.

const TYPE_ID = {
  intn: 0x26,
  bitn: 0x68,
  fltn: 0x6d,
  moneyn: 0x6e,
  decimaln: 0x6a,
  numericn: 0x6c,
  datetimen: 0x6f,
  date: 0x28,
  datetime2: 0x2a,
  guid: 0x24,
  nvarchar: 0xe7,
};
const INT_SIZE = { tinyint: 1, smallint: 2, int: 4, bigint: 8 };
const INT_TYPE = { 1: 'tinyint', 2: 'smallint', 4: 'int', 8: 'bigint' };
const COLLATION = Buffer.from([0x09, 0x04, 0xd0, 0x00, 0x34]); // Latin1_General_CI_AS
const PLP_NULL = 0xffffffffffffffffn;
const PLP_UNKNOWN = 0xfffffffffffffffen; // accepted on decode only
const PLP_CHUNK = 8000; // bytes; even, so chunks never split a UTF-16 code unit
const TICKS_PER_DAY = 25920000; // datetime ticks of 1/300 s

const DAYS_0001 = daysFromCivil(1, 1, 1);
const DAYS_1900 = daysFromCivil(1900, 1, 1);
const DATE_MAX = daysFromCivil(9999, 12, 31) - DAYS_0001;
const DATETIME_MIN = daysFromCivil(1753, 1, 1) - DAYS_1900;
const DATETIME_MAX = daysFromCivil(9999, 12, 31) - DAYS_1900;
const SMALLDATETIME_MAX = daysFromCivil(2079, 6, 6) - DAYS_1900;

export function columnMetadata(columns) {
  if (columns.length === 0) return Buffer.from([0x81, 0xff, 0xff]); // NoMetaData
  const head = Buffer.alloc(3);
  head[0] = 0x81;
  head.writeUInt16LE(columns.length, 1);
  const parts = [head];
  for (const d of columns.map(normalize)) {
    if (d.name.length > 255) throw new RangeError(`column name too long: ${d.name}`);
    const fixed = Buffer.alloc(6); // UserType (4 bytes, 0) and Flags (bit 0 = nullable)
    fixed.writeUInt16LE(d.nullable ? 1 : 0, 4);
    parts.push(fixed, typeInfo(d), Buffer.from([d.name.length]), Buffer.from(d.name, 'utf16le'));
  }
  return Buffer.concat(parts);
}

export function row(columns, values) {
  const ds = describe(columns, values);
  return Buffer.concat([Buffer.from([0xd1]), ...ds.map((d, i) => encodeValue(d, values[i]))]);
}

export function nbcRow(columns, values) {
  const ds = describe(columns, values);
  const bitmap = Buffer.alloc(Math.ceil(ds.length / 8));
  const data = [];
  ds.forEach((d, i) => {
    if (isNull(values[i])) {
      nullValue(d);
      bitmap[i >> 3] |= 1 << (i & 7);
    } else data.push(encodeValue(d, values[i]));
  });
  return Buffer.concat([Buffer.from([0xd2]), bitmap, ...data]);
}

export function encodeTypedValue(column, value) {
  const d = normalize(column);
  return Buffer.concat([typeInfo(d), encodeValue(d, value)]);
}

export function decodeTypedValue(buffer, offset = 0) {
  const { d, next } = parseTypeInfo(buffer, offset);
  const { value, next: end } = decodeValue(d, buffer, next);
  return { value, type: d.type, next: end };
}

export function decodeRow(columns, buffer, offset = 0) {
  const ds = columns.map(normalize);
  const token = buffer[offset];
  if (token !== 0xd1 && token !== 0xd2) throw new TypeError(`not a ROW token: 0x${token.toString(16)}`);
  const bitmapBytes = token === 0xd2 ? Math.ceil(ds.length / 8) : 0;
  let p = offset + 1 + bitmapBytes;
  const values = ds.map((d, i) => {
    if (bitmapBytes && (buffer[offset + 1 + (i >> 3)] >> (i & 7)) & 1) return null;
    const r = decodeValue(d, buffer, p);
    p = r.next;
    return r.value;
  });
  return { values, next: p };
}

// ---- column descriptors

function describe(columns, values) {
  if (columns.length !== values.length) throw new RangeError(`expected ${columns.length} values, got ${values.length}`);
  return columns.map(normalize);
}

// Normalized descriptor shared by encoders and decoders: id, type, size (wire length), precision,
// scale, plp, maxBytes, nullable, name.
function normalize(column) {
  const t = column.type;
  const d = { name: column.name ?? '', type: t, nullable: column.nullable !== false };
  if (Object.hasOwn(INT_SIZE, t)) Object.assign(d, { id: TYPE_ID.intn, size: INT_SIZE[t] });
  else if (t === 'bit') Object.assign(d, { id: TYPE_ID.bitn, size: 1 });
  else if (t === 'real' || t === 'float') Object.assign(d, { id: TYPE_ID.fltn, size: t === 'real' ? 4 : 8 });
  else if (t === 'money') Object.assign(d, { id: TYPE_ID.moneyn, size: 8 });
  else if (t === 'decimal' || t === 'numeric') {
    const precision = column.precision ?? 18;
    const scale = column.scale ?? 0;
    if (!Number.isInteger(precision) || precision < 1 || precision > 38)
      throw new RangeError(`precision ${precision} out of range`);
    if (!Number.isInteger(scale) || scale < 0 || scale > precision) throw new RangeError(`scale ${scale} out of range`);
    const size = precision <= 9 ? 5 : precision <= 19 ? 9 : precision <= 28 ? 13 : 17;
    Object.assign(d, { id: t === 'decimal' ? TYPE_ID.decimaln : TYPE_ID.numericn, size, precision, scale });
  } else if (t === 'datetime' || t === 'smalldatetime')
    Object.assign(d, { id: TYPE_ID.datetimen, size: t === 'datetime' ? 8 : 4 });
  else if (t === 'date') Object.assign(d, { id: TYPE_ID.date });
  else if (t === 'datetime2') {
    const scale = column.scale ?? 7;
    if (!Number.isInteger(scale) || scale < 0 || scale > 7)
      throw new RangeError(`datetime2 scale ${scale} out of range`);
    Object.assign(d, { id: TYPE_ID.datetime2, scale });
  } else if (t === 'uniqueidentifier') Object.assign(d, { id: TYPE_ID.guid, size: 16 });
  else if (t === 'nvarchar') {
    const plp = column.length === undefined || column.length === 'max';
    if (!plp && !(Number.isInteger(column.length) && column.length >= 1 && column.length <= 4000))
      throw new RangeError(`nvarchar length ${column.length} out of range`);
    Object.assign(d, { id: TYPE_ID.nvarchar, plp, maxBytes: plp ? 0xffff : column.length * 2 });
  } else throw new TypeError(`unsupported TDS column type: ${t}`);
  return d;
}

function typeInfo(d) {
  switch (d.id) {
    case TYPE_ID.date:
      return Buffer.from([d.id]);
    case TYPE_ID.datetime2:
      return Buffer.from([d.id, d.scale]);
    case TYPE_ID.decimaln:
    case TYPE_ID.numericn:
      return Buffer.from([d.id, d.size, d.precision, d.scale]);
    case TYPE_ID.nvarchar:
      return Buffer.concat([Buffer.from([d.id]), leBytes(d.maxBytes, 2), COLLATION]);
    default:
      return Buffer.from([d.id, d.size]);
  }
}

// Reads TYPE_INFO at o and returns the descriptor with the offset after it.
function parseTypeInfo(b, o) {
  const id = b[o];
  const d = { id, nullable: true };
  let next = o + 2;
  switch (id) {
    case TYPE_ID.intn:
      d.size = b[o + 1];
      d.type = INT_TYPE[d.size];
      break;
    case TYPE_ID.bitn:
      d.size = 1;
      d.type = 'bit';
      break;
    case TYPE_ID.fltn:
      d.size = b[o + 1];
      d.type = d.size === 4 ? 'real' : d.size === 8 ? 'float' : undefined;
      break;
    case TYPE_ID.moneyn:
      d.size = b[o + 1];
      d.type = d.size === 8 ? 'money' : undefined;
      break;
    case TYPE_ID.decimaln:
    case TYPE_ID.numericn:
      d.size = b[o + 1];
      d.precision = b[o + 2];
      d.scale = b[o + 3];
      d.type = id === TYPE_ID.decimaln ? 'decimal' : 'numeric';
      next = o + 4;
      break;
    case TYPE_ID.datetimen:
      d.size = b[o + 1];
      d.type = d.size === 8 ? 'datetime' : d.size === 4 ? 'smalldatetime' : undefined;
      break;
    case TYPE_ID.date:
      d.type = 'date';
      next = o + 1;
      break;
    case TYPE_ID.datetime2:
      d.scale = b[o + 1];
      d.type = 'datetime2';
      break;
    case TYPE_ID.guid:
      d.size = b[o + 1];
      d.type = 'uniqueidentifier';
      break;
    case TYPE_ID.nvarchar:
      d.maxBytes = b.readUInt16LE(o + 1);
      d.plp = d.maxBytes === 0xffff;
      d.type = 'nvarchar';
      next = o + 8; // 2-byte length, 5-byte collation
      break;
    default:
      throw new TypeError(`unsupported TDS type id 0x${id.toString(16)}`);
  }
  if (!d.type) throw new TypeError(`unsupported TDS type 0x${id.toString(16)} with length ${d.size}`);
  return { d, next };
}

// ---- values

const isNull = (v) => v === null || v === undefined;

function nullValue(d) {
  if (!d.nullable) throw new TypeError(`column ${d.name || '(unnamed)'} is not nullable`);
  if (d.id === TYPE_ID.nvarchar) return d.plp ? Buffer.alloc(8, 0xff) : Buffer.from([0xff, 0xff]);
  return Buffer.from([0]);
}

function encodeValue(d, v) {
  if (isNull(v)) return nullValue(d);
  switch (d.id) {
    case TYPE_ID.intn:
      return encodeInt(d.size, v);
    case TYPE_ID.bitn:
      return Buffer.from([1, v ? 1 : 0]);
    case TYPE_ID.fltn: {
      const b = Buffer.alloc(d.size + 1);
      b[0] = d.size;
      if (d.size === 4) b.writeFloatLE(Number(v), 1);
      else b.writeDoubleLE(Number(v), 1);
      return b;
    }
    case TYPE_ID.moneyn:
      return encodeMoney(v);
    case TYPE_ID.decimaln:
    case TYPE_ID.numericn:
      return encodeDecimal(d, v);
    case TYPE_ID.datetimen:
      return d.size === 8 ? encodeDatetime(v) : encodeSmalldatetime(v);
    case TYPE_ID.date:
      return Buffer.concat([
        Buffer.from([3]),
        leBytes(inRange(parseDateTime(v).days - DAYS_0001, 0, DATE_MAX, 'date'), 3),
      ]);
    case TYPE_ID.datetime2:
      return encodeDatetime2(d.scale, v);
    case TYPE_ID.guid:
      return Buffer.concat([Buffer.from([16]), guidWire(parseGuid(v))]);
    case TYPE_ID.nvarchar:
      return encodeNvarchar(d, v);
    default:
      throw new TypeError(`unsupported TDS type id 0x${d.id.toString(16)}`);
  }
}

function decodeValue(d, b, o) {
  if (d.id === TYPE_ID.nvarchar) return decodeNvarchar(d, b, o);
  const len = b[o];
  if (len === 0) return { value: null, next: o + 1 };
  const data = o + 1;
  const next = data + len;
  switch (d.id) {
    case TYPE_ID.intn:
      return { value: readInt(d.size, b, data), next };
    case TYPE_ID.bitn:
      return { value: b[data] !== 0, next };
    case TYPE_ID.fltn:
      return { value: d.size === 4 ? b.readFloatLE(data) : b.readDoubleLE(data), next };
    case TYPE_ID.moneyn: {
      const unscaled = BigInt(b.readInt32LE(data)) * 4294967296n + BigInt(b.readUInt32LE(data + 4));
      return { value: formatDecimal(unscaled, 4), next };
    }
    case TYPE_ID.decimaln:
    case TYPE_ID.numericn: {
      const magnitude = leBig(b.subarray(data + 1, next));
      return { value: formatDecimal(b[data] === 0 ? -magnitude : magnitude, d.scale), next };
    }
    case TYPE_ID.datetimen:
      return { value: d.size === 8 ? decodeDatetime(b, data) : decodeSmalldatetime(b, data), next };
    case TYPE_ID.date:
      return { value: formatDate(leNum(b, data, 3) + DAYS_0001), next };
    case TYPE_ID.datetime2: {
      const units = 10 ** d.scale;
      const ticks = leNum(b, data, len - 3);
      const days = leNum(b, data + len - 3, 3);
      const frac = d.scale ? '.' + String(ticks % units).padStart(d.scale, '0') : '';
      return { value: `${formatDate(days + DAYS_0001)} ${hms(Math.floor(ticks / units))}${frac}`, next };
    }
    case TYPE_ID.guid:
      return { value: formatGuid(guidWire(b.subarray(data, next))), next };
    default:
      throw new TypeError(`unsupported TDS type id 0x${d.id.toString(16)}`);
  }
}

function encodeInt(size, v) {
  const b = Buffer.alloc(size + 1);
  b[0] = size;
  if (size === 8) b.writeBigInt64LE(BigInt(v), 1);
  else if (size === 4) b.writeInt32LE(Number(v), 1);
  else if (size === 2) b.writeInt16LE(Number(v), 1);
  else b.writeUInt8(Number(v), 1);
  return b;
}

function readInt(size, b, o) {
  if (size === 8) return b.readBigInt64LE(o);
  if (size === 4) return b.readInt32LE(o);
  if (size === 2) return b.readInt16LE(o);
  return b[o];
}

function encodeMoney(v) {
  const u = parseDecimal(v, 4);
  const b = Buffer.alloc(9);
  b[0] = 8;
  b.writeInt32LE(Number(u >> 32n), 1); // MoneyHigh, then MoneyLow (both little-endian)
  b.writeUInt32LE(Number(u & 0xffffffffn), 5);
  return b;
}

function encodeDecimal(d, v) {
  const u = parseDecimal(v, d.scale);
  const magnitude = u < 0n ? -u : u;
  if (magnitude >= 10n ** BigInt(d.precision)) throw new RangeError(`${v} exceeds precision ${d.precision}`);
  const b = Buffer.alloc(d.size + 1);
  b[0] = d.size;
  b[1] = u < 0n ? 0 : 1; // sign: 0 negative, 1 positive
  for (let i = 0, m = magnitude; i < d.size - 1; i++, m >>= 8n) b[2 + i] = Number(m & 0xffn);
  return b;
}

function encodeDatetime(v) {
  const p = parseDateTime(v);
  let days = p.days - DAYS_1900;
  let ticks = Math.round(((p.sod * 1000 + Number(fraction(p.frac, 3))) * 300) / 1000);
  if (ticks >= TICKS_PER_DAY) {
    days += 1;
    ticks -= TICKS_PER_DAY;
  } // rounds up to the next midnight
  inRange(days, DATETIME_MIN, DATETIME_MAX, 'datetime');
  const b = Buffer.alloc(9);
  b[0] = 8;
  b.writeInt32LE(days, 1);
  b.writeUInt32LE(ticks, 5);
  return b;
}

function decodeDatetime(b, o) {
  const ms = Math.round((b.readUInt32LE(o + 4) * 1000) / 300);
  return `${formatDate(b.readInt32LE(o) + DAYS_1900)} ${hms(Math.floor(ms / 1000))}.${pad(ms % 1000, 3)}`;
}

function encodeSmalldatetime(v) {
  const p = parseDateTime(v);
  let days = p.days - DAYS_1900;
  let minutes = Math.round((p.sod + Number('0.' + p.frac)) / 60);
  if (minutes === 1440) {
    days += 1;
    minutes = 0;
  }
  inRange(days, 0, SMALLDATETIME_MAX, 'smalldatetime');
  const b = Buffer.alloc(5);
  b[0] = 4;
  b.writeUInt16LE(days, 1);
  b.writeUInt16LE(minutes, 3);
  return b;
}

function decodeSmalldatetime(b, o) {
  const minutes = b.readUInt16LE(o + 2);
  return `${formatDate(b.readUInt16LE(o) + DAYS_1900)} ${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}:00`;
}

function encodeDatetime2(scale, v) {
  const p = parseDateTime(v);
  const days = inRange(p.days - DAYS_0001, 0, DATE_MAX, 'datetime2');
  const timeBytes = scale <= 2 ? 3 : scale <= 4 ? 4 : 5;
  const ticks = p.sod * 10 ** scale + Number(fraction(p.frac, scale));
  return Buffer.concat([Buffer.from([timeBytes + 3]), leBytes(ticks, timeBytes), leBytes(days, 3)]);
}

function encodeNvarchar(d, v) {
  const s = Buffer.from(String(v), 'utf16le');
  if (!d.plp) {
    if (s.length > d.maxBytes) throw new RangeError(`${d.name} value exceeds nvarchar(${d.maxBytes / 2})`);
    return Buffer.concat([leBytes(s.length, 2), s]);
  }
  const parts = [Buffer.alloc(8)];
  parts[0].writeBigUInt64LE(BigInt(s.length)); // PLP total length
  for (let o = 0; o < s.length; o += PLP_CHUNK) {
    const chunk = s.subarray(o, o + PLP_CHUNK);
    parts.push(leBytes(chunk.length, 4), chunk);
  }
  parts.push(Buffer.alloc(4)); // PLP_TERMINATOR
  return Buffer.concat(parts);
}

function decodeNvarchar(d, b, o) {
  if (!d.plp) {
    const n = b.readUInt16LE(o);
    if (n === 0xffff) return { value: null, next: o + 2 };
    return { value: b.toString('utf16le', o + 2, o + 2 + n), next: o + 2 + n };
  }
  const total = b.readBigUInt64LE(o);
  if (total === PLP_NULL) return { value: null, next: o + 8 };
  let p = o + 8;
  const parts = [];
  for (let n = b.readUInt32LE(p); n !== 0; n = b.readUInt32LE(p)) {
    parts.push(b.subarray(p + 4, p + 4 + n));
    p += 4 + n;
  }
  const body = Buffer.concat(parts);
  if (total !== PLP_UNKNOWN && total !== BigInt(body.length))
    throw new RangeError('PLP length does not match its chunks');
  return { value: body.toString('utf16le'), next: p + 4 };
}

// ---- helpers

// Parses a decimal string into an unscaled BigInt with `scale` fraction digits.
function parseDecimal(v, scale) {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(String(v));
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) throw new TypeError(`not a decimal: ${v}`);
  const frac = (m[3] ?? '').replace(/0+$/, '');
  if (frac.length > scale) throw new RangeError(`${v} has more than ${scale} fraction digits`);
  const unscaled = BigInt((m[2] || '0') + frac.padEnd(scale, '0'));
  return m[1] === '-' ? -unscaled : unscaled;
}

function formatDecimal(u, scale) {
  const negative = u < 0n;
  const digits = (negative ? -u : u).toString().padStart(scale + 1, '0');
  const cut = digits.length - scale;
  return (negative ? '-' : '') + digits.slice(0, cut) + (scale ? '.' + digits.slice(cut) : '');
}

const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?$/;

// Returns days since 1970-01-01, seconds of day and the raw fraction digits.
function parseDateTime(text) {
  const m = DATETIME_RE.exec(String(text));
  if (!m) throw new TypeError(`not a date/time: ${text}`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const days = daysFromCivil(y, mo, d);
  if (civilFromDays(days).join() !== [y, mo, d].join()) throw new RangeError(`invalid date: ${text}`);
  const sod = Number(m[4] ?? 0) * 3600 + Number(m[5] ?? 0) * 60 + Number(m[6] ?? 0);
  return { days, sod, frac: m[7] ?? '' };
}

// Pads a fraction to `digits` digits; rejects digits beyond the type's precision.
function fraction(frac, digits) {
  const t = frac.replace(/0+$/, '');
  if (t.length > digits) throw new RangeError(`fraction ${frac} exceeds ${digits} digits`);
  return t.padEnd(digits, '0');
}

function inRange(days, min, max, what) {
  if (days < min || days > max) throw new RangeError(`${what} value out of range`);
  return days;
}

function parseGuid(text) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(text)))
    throw new TypeError(`not a GUID: ${text}`);
  return Buffer.from(String(text).replace(/-/g, ''), 'hex');
}

// Converts between the canonical byte order and the wire order (first three groups little-endian).
// The transform is its own inverse.
function guidWire(bytes) {
  const out = Buffer.from(bytes);
  out.subarray(0, 4).reverse();
  out.subarray(4, 6).reverse();
  out.subarray(6, 8).reverse();
  return out;
}

function formatGuid(bytes) {
  const hex = bytes.toString('hex').toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function formatDate(epochDays) {
  const [y, m, d] = civilFromDays(epochDays);
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

function hms(sod) {
  return `${pad(Math.floor(sod / 3600))}:${pad(Math.floor((sod % 3600) / 60))}:${pad(sod % 60)}`;
}

const pad = (n, width = 2) => String(n).padStart(width, '0');

function leBytes(x, n) {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    b[i] = x % 256;
    x = Math.floor(x / 256);
  }
  return b;
}

function leNum(b, o, n) {
  let x = 0;
  for (let i = n - 1; i >= 0; i--) x = x * 256 + b[o + i];
  return x;
}

function leBig(b) {
  let x = 0n;
  for (let i = b.length - 1; i >= 0; i--) x = (x << 8n) | BigInt(b[i]);
  return x;
}

// Proleptic Gregorian day counts (Howard Hinnant's algorithms); valid for year 1 onward.
function daysFromCivil(y, m, d) {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m > 2 ? m - 3 : m + 9) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(z) {
  z += 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [yoe + era * 400 + (m <= 2 ? 1 : 0), m, d];
}
