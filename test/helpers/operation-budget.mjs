import assert from 'node:assert/strict';

// Node inherits the CLI timeout even when a child explicitly requests Infinity.
// A finite workflow therefore declares its inventory and the unchanged guard
// for each operation; its parent has exactly their finite combined budget.
export function operationBudget(operations, guardMs) {
  if (!Number.isSafeInteger(operations) || operations < 1 || !Number.isSafeInteger(guardMs) || guardMs < 1)
    throw new Error('Operation counts and guards must be positive safe integers.');
  const budget = operations * guardMs;
  if (!Number.isSafeInteger(budget) || budget > 2_147_483_647)
    throw new Error('The finite operation budget exceeds Node timer limits.');
  return budget;
}

export function operationInventory(t, operations) {
  operationBudget(operations, 1);
  let observed = 0,
    overrun = false;
  t.after(() => {
    // A missing operation must not replace the original failed/aborted result.
    if (!overrun && !t.error && !t.signal?.aborted)
      assert.equal(observed, operations, 'the declared operation inventory completed');
  });
  return () => {
    if (++observed > operations) {
      overrun = true;
      throw new Error('The workflow exceeded its declared operation inventory.');
    }
  };
}

export function countOperations(t, operations, operation) {
  const enter = operationInventory(t, operations);
  return (...args) => {
    enter();
    return operation(...args);
  };
}
