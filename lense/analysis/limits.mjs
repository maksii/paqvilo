// Static analysis budget: the default ceilings, the most a caller may raise each one to, and their validation.
// Shared by the inventory, the CLI (--analysis-limit) and the catalogue schema (sites.<id>.analysis.limits).

/** Default ceilings, shared by all roots of one analysis. */
export const ANALYSIS_LIMITS = Object.freeze({
  roots: 128,
  files: 10000,
  directories: 10000,
  entries: 100000,
  fileBytes: 2 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
});

/**
 * The most each ceiling can be raised to. A raised budget stays bounded (sources are read into memory), is reported
 * with its source, and a source tree that exhausts it is still an incomplete analysis naming the ceiling.
 */
export const ANALYSIS_LIMIT_MAXIMUMS = Object.freeze({
  roots: 1024,
  files: 500000,
  directories: 500000,
  entries: 5000000,
  fileBytes: 16 * 1024 * 1024,
  totalBytes: 1024 * 1024 * 1024,
});

/** One ceiling's value, refused unless it is a known ceiling with an integer from 1 to its maximum. */
function analysisLimitValue(key, value, label = 'Static analysis limit') {
  if (!Object.hasOwn(ANALYSIS_LIMITS, key))
    throw new Error(
      `Invalid static analysis limit: ${label} names unknown ceiling '${key}'; ceilings: ${Object.keys(ANALYSIS_LIMITS).join(', ')}`,
    );
  if (!Number.isSafeInteger(value) || value < 1 || value > ANALYSIS_LIMIT_MAXIMUMS[key])
    throw new Error(
      `Invalid static analysis limit: ${label} ${key} must be an integer from 1 to ${ANALYSIS_LIMIT_MAXIMUMS[key]}`,
    );
  return value;
}

/** A `{ ceiling: value }` object (catalogue or API), validated in full. */
export function parseAnalysisLimits(value, label = 'Static analysis limits') {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Invalid static analysis limit: ${label} must be an object of ceilings`);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, analysisLimitValue(key, entry, label)]));
}

/** `--analysis-limit <ceiling>=<integer>` values; a later one for the same ceiling replaces an earlier one. */
export function parseAnalysisLimitOptions(values = []) {
  const limits = {};
  for (const entry of values) {
    const match = /^([A-Za-z]+)=(\d{1,16})$/.exec(entry);
    if (!match)
      throw Object.assign(new Error(`--analysis-limit must be <ceiling>=<integer>, not "${entry}"`), {
        code: 'invalid_argument',
      });
    try {
      limits[match[1]] = analysisLimitValue(match[1], Number(match[2]), '--analysis-limit');
    } catch (error) {
      throw Object.assign(error, { code: 'invalid_argument' });
    }
  }
  return limits;
}

/** The ceiling each inventory skip reason exhausted (records and content units share the files ceiling). */
export const LIMIT_REASONS = Object.freeze({
  'file-count-limit': 'files',
  'record-count-limit': 'files',
  'content-unit-limit': 'files',
  'directory-limit': 'directories',
  'entry-count-limit': 'entries',
  'file-size-limit': 'fileBytes',
  'total-size-limit': 'totalBytes',
  'root-count-limit': 'roots',
});
