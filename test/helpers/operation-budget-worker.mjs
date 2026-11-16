// @test-kind tooling: an isolated real Node test runner exercises inherited and numeric parent deadlines with IPC-driven virtual timer delivery.
import timers from 'node:timers';
import { operationBudget } from './operation-budget.mjs';

// Install before importing node:test, whose runner captures these timer
// functions. Only this owned child uses the virtual clock; no sleeps or CPU
// contention determine whether a runner deadline has elapsed.
let now = 0;
const handles = new Map();
timers.setTimeout = (callback, delay, ...args) => {
  const handle = { unref() {} };
  handles.set(handle, { at: now + delay, callback: () => callback(...args) });
  return handle;
};
timers.clearTimeout = (handle) => handles.delete(handle);
let release;
process.on('message', ({ type, ms }) => {
  if (type !== 'advance') return;
  now += ms;
  for (const [handle, timer] of [...handles]) if (timer.at <= now && handles.delete(handle)) timer.callback();
  // Let the actual runner's deadline rejection win before the operation gate
  // opens, if its guard was reached by this clock advance.
  setImmediate(() => release?.());
});

const { default: test } = await import('node:test');
const { workflowSteps } = await import('./workflow-step.mjs');
const mode = process.argv[2];
await test('finite workflow', { timeout: mode === 'infinity' ? Infinity : operationBudget(2, 10) }, async (t) => {
  const step = workflowSteps(t, {
    operations: 2,
    guardMs: 10,
    abort: () => {
      release?.();
      return true;
    },
  });
  for (let index = 0; index < (mode === 'omitted' ? 1 : 2); index++)
    await step('operation ' + index, async (signal) => {
      if (mode === 'primary') throw new Error('invented primary operation failure');
      const gate = new Promise((resolve) => {
        release = resolve;
        signal.addEventListener('abort', resolve, { once: true });
      });
      process.send({ type: 'entered', index });
      await gate;
      signal.throwIfAborted();
    });
});
process.send({ type: 'done', mode, now });
process.disconnect();
