// @test-kind contract: Paqvilo's own navigation commit budget policy for acceptance runs, asserted as pure arithmetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { navigationCommitBudget } from '../lib/navigation-budget.mjs';

test('unmeasured navigation reserve is 3 s or half the remaining budget when shorter, and never more than half', () => {
  assert.deepEqual(navigationCommitBudget(15000), { reserveMs: 7500, policy: 'bounded-write-fallback' });
  assert.equal(navigationCommitBudget(8000).reserveMs, 3000);
  assert.equal(navigationCommitBudget(4000).reserveMs, 2000);
  assert.equal(navigationCommitBudget(1000).reserveMs, 500);
});
test('proportional reserve leaves pending writes a fair share across remaining budgets', () => {
  const table = [
    [0, 0],
    [1000, 500],
    [6000, 3000],
    [8000, 3000],
    [10000, 5000],
    [60000, 30000],
  ];
  for (const [remainingMs, reserveMs] of table) {
    assert.equal(navigationCommitBudget(remainingMs).reserveMs, reserveMs, `remaining ${remainingMs} ms`);
  }
});
test('negative remaining budget clamps the reserve at zero', () => {
  assert.deepEqual(navigationCommitBudget(-1000), { reserveMs: 0, policy: 'bounded-write-fallback' });
  assert.deepEqual(navigationCommitBudget(-1000, { comparableMs: 500 }), {
    reserveMs: 0,
    policy: 'comparable-navigation-chain',
  });
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
