// Gates on a runtime-clock scheduler (lib/runtime-clock.mjs): the deterministic point at which a test may advance a manual
// clock or cancel a run, instead of guessing how many event-loop turns or milliseconds the code under test needs.
const waiters = new WeakMap();

/** Resolves with the task handle the next time `scheduler` queues a task named `name` (a connector retry pause, a flow
 * wait). Call it before the operation that queues the task. */
export function whenScheduled(scheduler, name) {
  let pending = waiters.get(scheduler);
  if (!pending) {
    pending = [];
    waiters.set(scheduler, pending);
    const schedule = scheduler.schedule;
    scheduler.schedule = (task, delay, options) => {
      const handle = schedule(task, delay, options);
      for (const waiter of pending.splice(0))
        if (waiter.name === options?.name && handle !== null) waiter.resolve(handle);
        else pending.push(waiter);
      return handle;
    };
  }
  const { promise, resolve } = Promise.withResolvers();
  pending.push({ name, resolve });
  return promise;
}
