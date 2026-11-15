import { calledFrom } from '../../mirage/test/support/timer-origin.mjs';

/**
 * The timers that code under `origin` (a module or directory URL) arms through the global setTimeout during test `t`
 * and that have neither fired nor been cleared. Timers armed by other code in the process are not recorded.
 */
export function liveTimers(t, origin) {
  const live = new Set();
  const set = globalThis.setTimeout,
    clear = globalThis.clearTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...rest) => {
    if (!calledFrom(origin, import.meta.url)) return set(callback, delay, ...rest);
    const handle = set(
      (...args) => {
        live.delete(handle);
        callback(...args);
      },
      delay,
      ...rest,
    );
    live.add(handle);
    return handle;
  });
  t.mock.method(globalThis, 'clearTimeout', (handle) => {
    live.delete(handle);
    return clear(handle);
  });
  return live;
}
