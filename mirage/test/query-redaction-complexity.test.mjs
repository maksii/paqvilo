// @test-kind security: Power BI placeholder URLs redact query and fragment values without pathological rescanning.
import test from 'node:test';
import assert from 'node:assert/strict';
import { redactUrlQuery, redactUrlUserinfo } from '../lib/query-redaction.mjs';

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

test('userinfo redaction hides the user name and password of an authority only', () => {
  assert.equal(
    redactUrlUserinfo('https://user:secret@app.example.test/r?x=1'),
    'https://[redacted]@app.example.test/r?x=1',
  );
  assert.equal(redactUrlUserinfo('//a@b@host/p'), '//[redacted]@host/p');
  // The URL parser removes tab, CR and LF anywhere, so the redacted value is shown without them.
  assert.equal(redactUrlUserinfo(' \thttps://u:p&a=b@host#f'), ' https://[redacted]@host#f');
  assert.equal(redactUrlUserinfo('https://u:p@host\\path'), 'https://[redacted]@host\\path');
  // A backslash ends a special URL's authority (WHATWG URL), so an "@" after it is not userinfo.
  assert.equal(redactUrlUserinfo('https://host\\a@b'), 'https://host\\a@b');
  for (const unchanged of [
    'https://host/a@b',
    'https://host?mail=a@b',
    'groups/x@y',
    'https://host#a@b',
    'mailto:a@b',
    'foo:/a@b',
    '//',
    '/single@slash',
  ])
    assert.equal(redactUrlUserinfo(unchanged), unchanged);
  const long = `https://${'a'.repeat(100_000)}`;
  assert.equal(redactUrlUserinfo(long), long);
  const slashes = `https:${'/\\'.repeat(50_000)}host`;
  assert.equal(redactUrlUserinfo(slashes), slashes);
});

test('userinfo redaction finds the authority where the WHATWG URL parser does', () => {
  // Each input carries user name "inu" and password "inp" for the platform's URL parser.
  const cases = [
    ['https:\\\\inu:inp@host/', 'https:\\\\[redacted]@host/'],
    ['https:/\\inu:inp@host', 'https:/\\[redacted]@host'],
    ['https:\\/inu:inp@host', 'https:\\/[redacted]@host'],
    ['https:/\t/inu:inp@host', 'https://[redacted]@host'],
    ['https:/\r\n/inu:inp@host', 'https://[redacted]@host'],
    ['https:///inu:inp@host', 'https:///[redacted]@host'],
    ['ht\ttps://inu:inp@host', 'https://[redacted]@host'],
    ['HTTPS://inu:inp@host', 'HTTPS://[redacted]@host'],
    ['\u0000 https://inu:inp@host', '\u0000 https://[redacted]@host'],
    ['\\\\inu:inp@host/x', '\\\\[redacted]@host/x'],
    ['/\\inu:inp@host', '/\\[redacted]@host'],
    ['//inu:inp@host', '//[redacted]@host'],
    ['foo://inu:inp@host', 'foo://[redacted]@host'],
    ['foo://in\\u:inp@host', 'foo://[redacted]@host'],
  ];
  for (const [input, redacted] of cases) {
    const parsed = new URL(input, 'https://base.example.test/');
    assert.equal(parsed.password, 'inp', JSON.stringify(input));
    assert.match(parsed.username, /^in/, JSON.stringify(input));
    assert.equal(redactUrlUserinfo(input), redacted, JSON.stringify(input));
    assert.doesNotMatch(redactUrlUserinfo(input), /inp/, JSON.stringify(input));
  }
  // Without a base, "https:" followed directly by the authority also carries userinfo.
  assert.equal(new URL('https:inu:inp@host').password, 'inp');
  assert.equal(redactUrlUserinfo('https:inu:inp@host'), 'https:[redacted]@host');
});
