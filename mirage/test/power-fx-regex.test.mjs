import test from 'node:test';
import assert from 'node:assert/strict';
import { powerFxEngine } from '../lib/power-fx.mjs';
import { regexGuardCounts } from '../lib/power-fx-functions.mjs';

// A 50 ms guard keeps the hostile cases short; the assertions check the error value, not the elapsed time.
const host = { regexGuardMs: 50 };
const evaluate = (formula) => powerFxEngine.evaluateSync(formula, { host }).value;
const hostileText = `"${'a'.repeat(40)}!"`;

// @test-kind security: a user pattern that backtracks without bound must end as an error value, not stall the server.
test('IsMatch with a nested quantifier that backtracks without bound returns BadRegex', () => {
  assert.equal(evaluate(`IsError(IsMatch(${hostileText}, "(a+)+b"))`), true);
});

// @test-kind security: a backreference pattern that backtracks without bound must end as an error value, not stall the server.
test('IsMatch with a backreference that backtracks without bound returns BadRegex', () => {
  assert.equal(evaluate(String.raw`IsError(IsMatch(${hostileText}, "(a+)+\1b"))`), true);
});

// @test-kind contract: ordinary IsMatch, Match and MatchAll results are pinned so the guarded path keeps Power Fx semantics.
test('IsMatch, Match and MatchAll keep their results on guarded and unguarded patterns', () => {
  assert.equal(evaluate('IsMatch("abab", "(ab)+")'), true);
  assert.equal(evaluate(String.raw`IsMatch("abab", "(ab)\1", "N")`), true);
  assert.equal(evaluate(String.raw`Match("a1b22", "\d+").FullMatch`), '1');
  assert.equal(evaluate(String.raw`CountRows(MatchAll("a1b22", "\d+"))`), 2);
});

// @test-kind contract: an invalid pattern keeps its BadRegex error value, with or without the guard.
test('an invalid pattern still returns the BadRegex error value', () => {
  assert.throws(
    () => evaluate('IsMatch("a", "(")'),
    (error) => error.details?.kind === 'BadRegex',
  );
});

// @test-kind security: a polynomial pattern with no quantified group or backreference runs under the guard in IsMatch, Match and MatchAll.
test('IsMatch, Match and MatchAll end as error values for a polynomial pattern under the guard', () => {
  const guarded = { host: { regexGuardMs: 200 } };
  const hostileText = `"${'a'.repeat(3000)}b"`;
  const pattern = '".*.*.*.*.*.*.*c"';
  assert.equal(powerFxEngine.evaluateSync(`IsError(IsMatch(${hostileText}, ${pattern}))`, guarded).value, true);
  assert.equal(powerFxEngine.evaluateSync(`IsError(Match(${hostileText}, ${pattern}))`, guarded).value, true);
  assert.equal(powerFxEngine.evaluateSync(`IsError(MatchAll(${hostileText}, ${pattern}))`, guarded).value, true);
});

// @test-kind contract: every pattern runs through one guard context created at most once, so guarding ordinary patterns adds no context per call.
test('IsMatch on an ordinary pattern runs through one shared guard context', () => {
  const before = regexGuardCounts();
  for (let call = 0; call < 1000; call += 1) assert.equal(evaluate('IsMatch("abc", "b")'), true);
  const after = regexGuardCounts();
  assert.equal(after.contexts <= 1, true);
  assert.equal(after.runs - before.runs, 1000);
});
