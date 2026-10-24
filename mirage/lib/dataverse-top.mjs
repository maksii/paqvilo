import { DataError } from './data-error.mjs';
const error = (message) => new DataError(message, 400, 'InvalidRequest', { innerCode: '0x80060888' });
export function parseDataverseTop(value, { occurrences = 1 } = {}) {
  if (occurrences > 1)
    throw error("Query option '$top' was specified more than once, but it must be specified at most once.");
  if (value == null) return null;
  const raw = String(value);
  let first = 0,
    last = raw.length;
  const white = (at) => raw.charCodeAt(at) === 32 || (raw.charCodeAt(at) >= 9 && raw.charCodeAt(at) <= 13);
  while (first < last && white(first)) first++;
  while (last > first && white(last - 1)) last--;
  const text = raw.slice(first, last),
    invalid = () =>
      error(
        `Invalid value '${raw}' for $top query option found. The $top query option requires a non-negative integer value.`,
      );
  if (!/^[+-]?\d+$/.test(text)) throw invalid();
  const significant = text.replace(/^[+-]?0*/, '');
  if (significant.length > 19) throw invalid();
  const n = BigInt(text);
  if (n < 0n || n > 9223372036854775807n) throw invalid();
  if (n === 0n) throw error('Invalid value for $top query option.');
  if (n > 2147483647n)
    throw error(
      `The limit of '2147483647' for Top query has been exceeded. The value from the incoming request is '${n}'.`,
    );
  return Number(n);
}
