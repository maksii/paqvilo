import { DataError } from './data-error.mjs';

// JSON-safe store representation; BigInt never escapes this arithmetic module.
// Only numeric column metadata may accept this value. Public JSON emits a number,
// while saved simulator state retains its type and exact decimal digits.
const marker = 'DataverseNumeric';
const failure = (message) => {
  throw new DataError(message, 400, 'NumericPrecisionUnsupported');
};
export const isExactNumeric = (value) =>
  value?.$type === marker &&
  ['Int64', 'Decimal', 'Money', 'Literal'].includes(value.numericType) &&
  typeof value.value === 'string';
export function decimalParts(value) {
  const text = String(isExactNumeric(value) ? value.value : value);
  if (text.length > 160) failure('Numeric literal exceeds the bounded 160-character precision representation.');
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) return null;
  const exponent = Number(match[4] ?? 0);
  if (Math.abs(exponent) > 128) failure('Numeric exponent exceeds the bounded precision representation.');
  let coefficient = BigInt((match[1] === '-' ? '-' : '') + match[2] + (match[3] ?? '')),
    scale = (match[3]?.length ?? 0) - exponent;
  if (scale < 0) {
    coefficient *= 10n ** BigInt(-scale);
    scale = 0;
  }
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale--;
  }
  return { coefficient, scale };
}
export function decimalText(parts) {
  const { coefficient, scale } = parts,
    negative = coefficient < 0n,
    digits = (negative ? -coefficient : coefficient).toString().padStart(scale + 1, '0');
  return (negative ? '-' : '') + (scale ? digits.slice(0, -scale) + '.' + digits.slice(-scale) : digits);
}
export function exactNumeric(value, numericType = 'Literal', { collapse = true } = {}) {
  const parts = decimalParts(value);
  if (!parts) failure('Invalid exact numeric literal.');
  const text = decimalText(parts),
    number = Number(text),
    back = Number.isFinite(number) ? decimalParts(number) : null;
  if (
    collapse &&
    back &&
    back.coefficient === parts.coefficient &&
    back.scale === parts.scale &&
    (parts.scale > 0 || Number.isSafeInteger(number))
  )
    return number;
  return { $type: marker, numericType, value: text };
}
export function numericPair(a, b) {
  const x = decimalParts(a),
    y = decimalParts(b);
  if (!x || !y) return null;
  const scale = Math.max(x.scale, y.scale);
  return { x: x.coefficient * 10n ** BigInt(scale - x.scale), y: y.coefficient * 10n ** BigInt(scale - y.scale) };
}
export function compareNumeric(a, b) {
  const pair = numericPair(a, b);
  return pair ? (pair.x < pair.y ? -1 : pair.x > pair.y ? 1 : 0) : NaN;
}
export function roundNumeric(value, precision, numericType = 'Decimal') {
  if (!Number.isInteger(precision) || precision < 0 || precision > 28)
    failure('Exact decimal precision must be between 0 and 28.');
  const parts = decimalParts(value);
  if (!parts) failure('Invalid decimal literal.');
  if (parts.scale > precision) {
    const divisor = 10n ** BigInt(parts.scale - precision),
      negative = parts.coefficient < 0n,
      absolute = negative ? -parts.coefficient : parts.coefficient;
    parts.coefficient = (absolute / divisor + ((absolute % divisor) * 2n >= divisor ? 1n : 0n)) * (negative ? -1n : 1n);
    parts.scale = precision;
  }
  return exactNumeric(decimalText(parts), numericType);
}
export function sumNumeric(values, numericType = 'Decimal') {
  const parts = values.map(decimalParts);
  if (parts.some((p) => !p)) failure('Exact aggregation requires numeric values.');
  const scale = Math.max(0, ...parts.map((p) => p.scale)),
    coefficient = parts.reduce((sum, p) => sum + p.coefficient * 10n ** BigInt(scale - p.scale), 0n);
  return exactNumeric(decimalText({ coefficient, scale }), numericType);
}
export function multiplyNumeric(values, numericType = 'Decimal') {
  const parts = values.map(decimalParts);
  if (parts.some((p) => !p)) failure('Exact multiplication requires numeric values.');
  const scale = parts.reduce((sum, p) => sum + p.scale, 0);
  if (scale > 128) failure('Exact multiplication exceeds the bounded precision representation.');
  return exactNumeric(
    decimalText({ coefficient: parts.reduce((product, p) => product * p.coefficient, 1n), scale }),
    numericType,
  );
}
export function averageNumeric(values, { integer = false } = {}) {
  if (!values.length) return null;
  const sum = decimalParts(sumNumeric(values)),
    divisor = BigInt(values.length);
  if (integer) return exactNumeric((sum.coefficient / (divisor * 10n ** BigInt(sum.scale))).toString(), 'Int64');
  // Finite decimal averages retain all digits. An unbounded recurring result
  // requires a source-qualified SQL decimal result precision, rather than Number.
  let coefficient = sum.coefficient,
    scale = sum.scale,
    remaining = divisor;
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const common = gcd(coefficient < 0n ? -coefficient : coefficient, remaining);
  coefficient /= common;
  remaining /= common;
  while (remaining % 2n === 0n) {
    coefficient *= 5n;
    scale++;
    remaining /= 2n;
  }
  while (remaining % 5n === 0n) {
    coefficient *= 2n;
    scale++;
    remaining /= 5n;
  }
  if (remaining !== 1n || scale > 28) failure('Recurring exact average requires source-qualified result precision.');
  return exactNumeric(decimalText({ coefficient, scale }), 'Decimal');
}
export function divideNumeric(a, b, { integer = false, modulo = false } = {}) {
  const pair = numericPair(a, b);
  if (!pair || pair.y === 0n) failure('Exact division requires numeric values and a nonzero divisor.');
  if (integer) return exactNumeric((modulo ? pair.x % pair.y : pair.x / pair.y).toString(), 'Int64');
  if (modulo) {
    const x = decimalParts(a),
      y = decimalParts(b),
      scale = Math.max(x.scale, y.scale);
    return exactNumeric(decimalText({ coefficient: pair.x % pair.y, scale }), 'Decimal');
  }
  let coefficient = pair.x,
    denominator = pair.y,
    scale = 0;
  if (denominator < 0n) {
    coefficient = -coefficient;
    denominator = -denominator;
  }
  const gcd = (x, y) => (y ? gcd(y, x % y) : x),
    common = gcd(coefficient < 0n ? -coefficient : coefficient, denominator);
  coefficient /= common;
  denominator /= common;
  while (denominator % 2n === 0n) {
    coefficient *= 5n;
    scale++;
    denominator /= 2n;
  }
  while (denominator % 5n === 0n) {
    coefficient *= 2n;
    scale++;
    denominator /= 5n;
  }
  if (denominator !== 1n || scale > 28) failure('Recurring exact division requires an explicit result precision.');
  return exactNumeric(decimalText({ coefficient, scale }), 'Decimal');
}
export function metadataNumeric(value) {
  if (value == null || String(value).trim() === '') return undefined;
  const exact = exactNumeric(String(value).trim());
  return isExactNumeric(exact) ? exact.value : exact;
}
export function parseNumericLiteral(text) {
  return exactNumeric(text);
}
export function parseExactJson(text, { allowFiniteDouble = false } = {}) {
  return JSON.parse(text, (key, value, context) => {
    if (value && typeof value === 'object' && value.$type === marker)
      failure('Internal numeric representations are not accepted as JSON payload objects.');
    if (typeof value !== 'number' || !context?.source) return value;
    try {
      return parseNumericLiteral(context.source);
    } catch (error) {
      // Generic JSON transports also carry IEEE754 Double values beyond the
      // bounded Decimal/Int64 representation. Dataverse payload readers retain
      // their stricter default; a transport can preserve an already-finite Double.
      if (allowFiniteDouble && Number.isFinite(value) && error.code === 'NumericPrecisionUnsupported') return value;
      throw error;
    }
  });
}
export function stringifyExactJson(value) {
  return JSON.stringify(value, (key, item) =>
    isExactNumeric(item)
      ? JSON.rawJSON(typeof item.lexeme === 'string' ? item.lexeme : decimalText(decimalParts(item)))
      : item,
  );
}
// Exact numeric whose JSON lexeme keeps a fixed scale (Dataverse writes money with four decimals).
export function fixedScaleNumeric(value, scale, numericType = 'Money') {
  const parts = decimalParts(value);
  if (!parts) failure('Invalid exact numeric literal.');
  if (parts.scale > scale) return fixedScaleNumeric(roundNumeric(value, scale, numericType), scale, numericType);
  const text = decimalText(parts),
    [whole, fraction = ''] = text.split('.');
  return { $type: marker, numericType, value: text, lexeme: scale ? whole + '.' + fraction.padEnd(scale, '0') : whole };
}
export function formatExactNumeric(value, digits) {
  const rounded = roundNumeric(value, digits),
    text = isExactNumeric(rounded) ? rounded.value : String(rounded),
    [whole, fraction = ''] = text.split('.');
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (digits ? '.' + fraction.padEnd(digits, '0') : '');
}
