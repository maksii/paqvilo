// Markup a test rendered itself, bounded before a test reads it with a regular expression: rendered fixtures are a few
// kilobytes, so a page past the bound is a broken fixture, and the bound keeps the backtracking of the tests' tag
// patterns small (CodeQL js/polynomial-redos follows the runtime's library input into these renders).
const MARKUP_LIMIT = 4_000_000;

export function boundedMarkup(html) {
  const text = String(html ?? '');
  if (text.length > MARKUP_LIMIT)
    throw new RangeError(`Rendered markup is ${text.length} characters, past the ${MARKUP_LIMIT} bound.`);
  return text;
}
