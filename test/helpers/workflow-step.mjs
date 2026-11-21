import { ownedFixture } from '../../mirage/testing/owned-fixture.mjs';
import { operationInventory } from './operation-budget.mjs';

/** Guard each observed operation of a finite workflow and drain abandoned work before leaving its step. */
export function workflowSteps(parent, { guardMs, abort, operations }) {
  const enter = operations === undefined ? () => {} : operationInventory(parent, operations);
  return async (name, operation) => {
    enter();
    let completed = false,
      result;
    await parent.test(name, { timeout: guardMs }, async (step) => {
      let settled = false;
      const body = Promise.resolve()
        .then(() => {
          step.signal.throwIfAborted();
          return operation(step.signal);
        })
        .finally(() => {
          settled = true;
        });
      ownedFixture(step).add(async () => {
        const drained = body.catch(() => {});
        // An acquisition that has not returned a handle cannot be interrupted
        // here. Its fixture owns late arrivals; do not make this hook wait on it.
        if (!settled && !(await abort()) && !settled) return;
        await drained;
      });
      result = await body;
      completed = true;
    });
    if (!completed) throw new Error(`Workflow step did not complete: ${name}`);
    return result;
  };
}
