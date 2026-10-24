import test from 'node:test';
import assert from 'node:assert/strict';
import { navigationCommitBudget } from '../lib/navigation-budget.mjs';

test('unmeasured navigation leaves at most five seconds for writes and reserves slow redirect time', () => {
  assert.deepEqual(navigationCommitBudget(15000), { reserveMs: 10000, policy: 'bounded-write-fallback' });
  assert.equal(navigationCommitBudget(8000).reserveMs, 3000);
  assert.equal(navigationCommitBudget(4000).reserveMs, 2000);
  assert.equal(navigationCommitBudget(1000).reserveMs, 500);
});
test('only comparable navigation-chain evidence increases the reserve; explicit override remains supported', () => {
  assert.deepEqual(navigationCommitBudget(8000, { comparableMs: 4500 }), {
    reserveMs: 5500,
    policy: 'comparable-navigation-chain',
  });
  assert.equal(navigationCommitBudget(8000, { comparableMs: 10 }).reserveMs, 3000);
  assert.equal(navigationCommitBudget(8000, { comparableMs: 20000 }).reserveMs, 8000);
  assert.deepEqual(navigationCommitBudget(8000, { explicitMs: 1000, comparableMs: 4500 }), {
    reserveMs: 1000,
    policy: 'explicit',
  });
});
