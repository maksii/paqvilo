// @test-kind security: Power BI placeholder URLs redact query and fragment values without pathological rescanning.
import test from 'node:test';
import assert from 'node:assert/strict';
import { redactUrlQuery } from '../lib/query-redaction.mjs';

test('redaction preserves the original query and fragment delimiters', () => {
  assert.equal(redactUrlQuery('/report?a=one&b=two#view=three'), '/report?a=[redacted]&b=[redacted]#view=[redacted]');
  assert.equal(redactUrlQuery('&a=one'), '&a=one');
  assert.equal(redactUrlQuery('?=empty&x=two'), '?=empty&x=[redacted]');
  assert.equal(redactUrlQuery('??=yes'), '??=[redacted]');
});

test('redaction handles a long incomplete query', () => {
  const incomplete = '?'.repeat(100_000);
  assert.equal(redactUrlQuery(incomplete), incomplete);
  assert.equal(redactUrlQuery(`${incomplete}=secret`), `${incomplete}=[redacted]`);
});
import { redactEmbeddedQueryValues } from '../baseline-capture.mjs';

test('embedded query redaction scans long punctuation runs once', () => {
  const input = `https://example.invalid/${')'.repeat(100_000)}x`;
  assert.equal(redactEmbeddedQueryValues(input), input);
  assert.equal(
    redactEmbeddedQueryValues('https://example.invalid/?secret=value).'),
    'https://example.invalid/?secret=…).',
  );
});
import { stripLastLineQuery } from '../lib/strip-last-line-query.mjs';

test('query removal keeps line-terminator behavior for long malformed input', () => {
  const value = `${'?'.repeat(100_000)}\u2028tail`;
  assert.equal(stripLastLineQuery(value), value);
  assert.equal(stripLastLineQuery('first?keep\nsecond?remove'), 'first?keep\nsecond');
  assert.equal(stripLastLineQuery('first?keep\n'), 'first?keep\n');
});
