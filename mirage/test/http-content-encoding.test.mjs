import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptsGzip } from '../lib/http-content-encoding.mjs';

test('gzip negotiation respects explicit exclusions, weights, wildcards and malformed quality values', () => {
  for (const [header, expected] of [
    [undefined, false],
    ['', false],
    ['identity', false],
    ['br, deflate', false],
    ['gzip', true],
    ['GZip ; Q=0.5', true],
    ['gzip;q=0', false],
    ['gzip;q=0.000', false],
    ['*;q=1', true],
    ['gzip;q=0, *;q=1', false],
    ['gzip;q=0.2,*;q=0', true],
    ['gzip;q=invalid', false],
    ['gzip;q=1.2', false],
    ['gzip;q=0.0001', false],
    ['notgzip', false],
  ])
    assert.equal(acceptsGzip({ headers: { 'accept-encoding': header } }), expected, String(header));
});
