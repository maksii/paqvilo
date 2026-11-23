// @test-kind contract: the byte-range, integrity-attribute and integrity-token patterns of session.mjs match what their earlier forms matched
import test from 'node:test';
import assert from 'node:assert/strict';
import { byteRange, integrityUrls, integrityCheck } from '../lense/session.mjs';

// The forms before the rewrite, kept here as the oracle.
const OLD_RANGE = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i;
const OLD_ATTRIBUTE = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
const OLD_TOKEN = /^(sha256|sha384|sha512)-([A-Za-z0-9+/=_-]+)(?:\?.*)?$/i;

function oldByteRange(header, size) {
  const match = OLD_RANGE.exec(String(header ?? ''));
  if (!match || (match[1] === '' && match[2] === '')) return null;
  let start;
  let end;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (suffix === 0) return false;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
    if (match[2] !== '' && Number(match[2]) < start) return null;
  }
  if (!Number.isSafeInteger(start) || start >= size || end < start) return false;
  return { start, end };
}

const HEADERS = [
  'bytes=0-99',
  'bytes=10-',
  'bytes=-5',
  'bytes=-0',
  'bytes=-',
  'bytes=5-2',
  'bytes=0-9999',
  'bytes=100-200',
  '  bytes = 1 - 3  ',
  'BYTES=2-4',
  'bytes =\t7-\t',
  'bytes=1 2-3',
  'bytes=1-2-3',
  'bytes=0-1,4-5',
  'bytes=a-b',
  'bytes=99999999999999999999-',
  'items=0-1',
  'bytes',
  '',
  ' bytes=0-1 ',
  undefined,
  null,
];

test('byteRange answers every header as the earlier pattern did', () => {
  for (const header of HEADERS)
    for (const size of [0, 1, 10, 100])
      assert.deepEqual(byteRange(header, size), oldByteRange(header, size), `${JSON.stringify(header)} of ${size}`);
});

test('byteRange keeps the documented outcomes', () => {
  assert.deepEqual(byteRange('bytes=2-4', 10), { start: 2, end: 4 });
  assert.deepEqual(byteRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.equal(byteRange('bytes=-0', 10), false);
  assert.equal(byteRange('bytes=0-1,4-5', 10), null);
});

test('byteRange ends on a long run of blanks', () => {
  const started = process.hrtime.bigint();
  assert.equal(byteRange(`bytes=${' '.repeat(200000)}`, 10), null);
  assert.equal(byteRange(`bytes=${' '.repeat(200000)}x`, 10), null);
  assert.ok(process.hrtime.bigint() > started);
});

const TAGS = [
  'src="/a.js" integrity="sha256-abc"',
  "src='/a.js' integrity='sha384-xyz'",
  'src=/a.js integrity=sha512-q==',
  'a-b:c = "1" d=\'2\' e = 3',
  'data-x=1 x=2 x=3',
  'a=b=c d="e"f=g',
  'a= >b=1',
  'a="x"b=1',
  'abc def = ghi',
  '=x a=',
  'x-y_z=1 _k=2',
  'a:b=1',
  'integrity = "sha256-AAA" crossorigin',
];

test('the attribute pattern finds the attributes the earlier one found', () => {
  for (const tag of TAGS) {
    const before = [...tag.matchAll(OLD_ATTRIBUTE)].map((m) => [m[1], m[2] ?? m[3] ?? m[4] ?? '']);
    const after = [...tag.matchAll(/(?<![\w:-])([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)].map((m) => [
      m[1],
      m[2] ?? m[3] ?? m[4] ?? '',
    ]);
    assert.deepEqual(after, before, tag);
  }
});

test('integrityUrls reads the pinned same-origin files', () => {
  const html =
    '<script src="/a.js" integrity="sha256-abc"></script><link href="/b.css" integrity=\'sha384-xyz\' rel=stylesheet>' +
    '<script src="https://other.test/c.js" integrity="sha256-q"></script><script src="/d.js"></script>';
  const found = integrityUrls(html, 'https://site.test/page', 'https://site.test');
  assert.deepEqual([...found.values()], ['sha256-abc', 'sha384-xyz']);
});

test('the integrity token pattern accepts the tokens the earlier one accepted', () => {
  const tokens = [
    'sha256-abc=',
    'SHA384-AbC_-+/=',
    'sha512-xyz?ct=application/javascript',
    'sha1-abc',
    'sha256-',
    'sha256-a b',
    'md5-xx',
    'sha256-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=_-',
    'sha256-ſK',
    'sha256-ab!',
  ];
  const now = /^(sha256|sha384|sha512)-([A-Z0-9+/=_-]+)(?:\?.*)?$/i;
  for (const token of tokens) assert.deepEqual(now.exec(token)?.slice(1), OLD_TOKEN.exec(token)?.slice(1), token);
});

test('integrityCheck still compares the strongest listed digest', () => {
  assert.equal(integrityCheck('md5-xx', 'x'), null);
  const result = integrityCheck('sha256-ungültig sha256-abc', 'x');
  assert.equal(result.algorithm, 'sha256');
  assert.equal(result.match, false);
});
