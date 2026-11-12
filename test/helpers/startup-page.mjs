// Start-up and watcher test fixture: trackArmedTimers records the timers armed through the global setTimeout.
// Records each timer armed through the global setTimeout until it fires or is cleared (mock timers included).
export function trackArmedTimers() {
  const armed = new Set();
  const schedule = globalThis.setTimeout,
    cancel = globalThis.clearTimeout;
  globalThis.setTimeout = (callback, ms, ...args) => {
    const handle = schedule(() => {
      armed.delete(handle);
      callback(...args);
    }, ms);
    armed.add(handle);
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    armed.delete(handle);
    cancel(handle);
  };
  return {
    armed,
    restore() {
      globalThis.setTimeout = schedule;
      globalThis.clearTimeout = cancel;
    },
  };
}
