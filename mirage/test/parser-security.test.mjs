// @test-kind security: alternate key and Liquid shorthand parsing of hostile input does work linear in its length.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKeySegment } from '../lib/data.mjs';
import { LiquidSyntaxError, tokenize } from '../lib/liquid-engine.mjs';

test('alternate keys preserve quoting, separators and typed values while rejecting incomplete or ambiguous keys', () => {
  assert.deepEqual(parseKeySegment(" code = 'a,b''c' , number = -12.5, flag=true "), {
    code: "a,b'c",
    number: -12.5,
    flag: 'true',
  });
  assert.deepEqual(parseKeySegment("empty='',id={abc}"), { empty: '', id: 'abc' });
  assert.equal(parseKeySegment('plain-id'), null);
  for (const source of ["a='unterminated", "a='closed'junk", 'a=', 'a=1,a=2', '__proto__=1', 'constructor=2'])
    assert.throws(
      () => parseKeySegment(source),
      (e) => e.code === 'InvalidKey',
    );
});

// @test-kind contract: the shorthand scanner keeps the whitespace, empty-body and final-newline rules.
test('whole-template Liquid shorthands retain whitespace, empty-body and final-newline behavior', () => {
  for (const source of ['{{{ hello }}}', '{{{\thello\t\t}}}\r\n', '{{{\nhello\n}}}', '{{{hello}}}\u2028'])
    assert.deepEqual(tokenize(source), ['{% literal %}', 'hello', '{% endliteral %}']);
  for (const source of ['{# hello #}', '{ #\thello\t# }\n', '{#\nhello\n#}'])
    assert.deepEqual(tokenize(source), ['{% comment %}', 'hello', '{% endcomment %}']);
  assert.deepEqual(tokenize('{{{}}}'), ['{% literal %}', '{% endliteral %}']);
  assert.deepEqual(tokenize('{##}'), ['{% comment %}', '{% endcomment %}']);
  assert.deepEqual(tokenize('{# hello\nworld #}'), ['{# hello\nworld #}']);
  assert.deepEqual(tokenize('{# hello #} suffix'), ['{# hello #} suffix']);
});

// The work bound, at both sizes: each scan that must read the hostile run steps over it (so the counted scanners, not an
// uncounted pattern, decided the input), and the total stays within a small multiple of the run. A rescan or
// backtracking regression grows with the square of the run and exceeds the bound by orders of magnitude.
const RUN_LENGTHS = [4096, 8192];
const SCAN_FACTOR = 3;
const SCAN_SLACK = 64;

function assertLinearWork(work, length, label, readers = 1) {
  assert.ok(
    work >= readers * length - SCAN_SLACK && work <= SCAN_FACTOR * length + SCAN_SLACK,
    `${label}: ${work} positions for ${length}`,
  );
}

test('long malformed keys are rejected after a number of scanned positions linear in their length', () => {
  for (const length of RUN_LENGTHS) {
    const tabs = '\t'.repeat(length);
    for (const source of ['a' + tabs + '=', 'a=' + tabs + "'unclosed"]) {
      const stats = { positions: 0 };
      assert.throws(
        () => parseKeySegment(source, stats),
        (e) => e.code === 'InvalidKey',
      );
      assertLinearWork(stats.positions, length, JSON.stringify(source.slice(0, 3)));
    }
  }
});

test('long unterminated shorthand templates read a fixed number of delimiter characters and scan linearly', () => {
  for (const length of RUN_LENGTHS) {
    const tabs = '\t'.repeat(length);
    for (const [source, outcome] of [
      ['{{{' + tabs, LiquidSyntaxError],
      ['{#' + tabs, ['{#' + tabs]],
    ]) {
      const stats = { shorthand: 0, positions: 0 };
      if (Array.isArray(outcome)) assert.deepEqual(tokenize(source, undefined, stats), outcome);
      else assert.throws(() => tokenize(source, undefined, stats), outcome);
      const label = JSON.stringify(source.slice(0, 3));
      // Both shorthand checks decide from the two ends of the template, whatever its length.
      assert.ok(stats.shorthand > 0 && stats.shorthand <= SCAN_SLACK, `${label}: shorthand read ${stats.shorthand}`);
      // The whitespace-control and token scans each step over the run.
      assertLinearWork(stats.positions, length, label, 2);
    }
  }
});
