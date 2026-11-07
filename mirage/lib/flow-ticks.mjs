import { DataError } from './data-error.mjs';
import { parseDateValue } from './dataverse-values.mjs';
import { exactNumeric } from './exact-numeric.mjs';

/** WDL ticks: 100 ns since 0001-01-01. UTC ISO only; retain all seven fractional digits. */
export function flowTicks(value) {
  const match = typeof value === 'string' && /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,7}))?Z$/.exec(value);
  if (!match)
    throw new DataError(
      'ticks() supports UTC ISO timestamps with seconds and at most seven fractional digits.',
      501,
      'LocalFlowUnsupported',
    );
  const parsed = parseDateValue(match[1] + 'Z');
  if (!parsed || value.startsWith('0000'))
    throw new DataError('ticks() requires a valid timestamp in years 0001 through 9999.', 400, 'LocalFlowExpression');
  const ticks = (BigInt(parsed.ms) + 62135596800000n) * 10000n + BigInt((match[2] ?? '').padEnd(7, '0'));
  return exactNumeric(ticks.toString(), 'Int64');
}
