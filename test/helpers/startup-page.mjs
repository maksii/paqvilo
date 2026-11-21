// Start-up and watcher test fixture: trackArmedTimers records the timers armed through the global setTimeout.
const MISORDER_MESSAGE = 'trackArmedTimers must be called after t.mock.timers.enable';

// Records each timer armed through the global setTimeout until it fires or is cleared. Call it after
// t.mock.timers.enable: enabling later replaces the wrapper, so the code under test never reaches it.
export function trackArmedTimers() {
  const armed = new Set();
  const schedule = globalThis.setTimeout,
    cancel = globalThis.clearTimeout;
  const wrapper = (callback, ms, ...args) => {
    const handle = schedule(() => {
      armed.delete(handle);
      callback(...args);
    }, ms);
    armed.add(handle);
    return handle;
  };
  globalThis.setTimeout = wrapper;
  globalThis.clearTimeout = (handle) => {
    armed.delete(handle);
    cancel(handle);
  };
  return {
    armed,
    restore() {
      const replaced = globalThis.setTimeout !== wrapper;
      globalThis.clearTimeout = cancel;
      if (replaced) throw new Error(MISORDER_MESSAGE);
      globalThis.setTimeout = schedule;
    },
  };
}

/**
 * A clock for startupDeadline that only the test moves, so no real guard is armed and no host, however slow, can
 * fire one. `expire(ms)` moves the time on and runs the guards that are then due; `armed` counts the pending ones.
 */
export function manualClock() {
  let now = 0;
  const timers = new Set();
  return {
    Date: { now: () => now },
    setTimeout(callback, delay) {
      const timer = { callback, at: now + delay };
      timers.add(timer);
      return timer;
    },
    clearTimeout: (timer) => timers.delete(timer),
    expire(ms) {
      now += ms;
      for (const timer of [...timers].filter((candidate) => candidate.at <= now)) {
        timers.delete(timer);
        timer.callback();
      }
    },
    get armed() {
      return timers.size;
    },
  };
}
