/** A startup deadline ends at initial document/assets readiness, independently of session lifetime. */
export function startupDeadline(value = 120000) {
  const controller = new AbortController();
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 600000)
    throw new Error('--startup-timeout must be an integer from 1000 to 600000 milliseconds');
  let phase = 'configuration',
    expired = false,
    finished = false,
    rejectDeadline,
    reason;
  const failure = () =>
    Object.assign(new Error(`Model-driven startup timed out during ${phase} after ${timeout} ms.`), {
      code: 'startup_timeout',
      phase,
    });
  const promise = new Promise((_, reject) => {
    rejectDeadline = reject;
  });
  // A deadline can expire while synchronous source preparation is still returning.
  promise.catch(() => {});
  const end = Date.now() + timeout;
  const abort = () => {
    if (finished || expired) return;
    expired = true;
    reason = Object.assign(new Error(`Model-driven startup cancelled during ${phase}.`), {
      code: 'startup_cancelled',
      phase,
    });
    controller.abort(reason);
    rejectDeadline(reason);
  };
  const timer = setTimeout(() => {
    expired = true;
    reason = failure();
    controller.abort(reason);
    rejectDeadline(reason);
  }, timeout);
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  const close = () => {
    clearTimeout(timer);
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
  };
  return {
    signal: controller.signal,
    phase(value) {
      phase = value;
    },
    async wait(work, disposeLate) {
      const pending = Promise.resolve(work);
      let admitted = false,
        disposed = false;
      const dispose = async (value) => {
        if (!disposed) {
          disposed = true;
          await disposeLate?.(value);
        }
      };
      pending
        .then(async (value) => {
          if (!admitted && (expired || (!finished && Date.now() >= end))) await dispose(value);
        })
        .catch(() => {});
      if (expired || (!finished && Date.now() >= end)) {
        expired = true;
        reason ??= failure();
        controller.abort(reason);
        throw reason ?? failure();
      }
      const result = await Promise.race([pending, promise]);
      if (expired || (!finished && Date.now() >= end)) {
        expired = true;
        reason ??= failure();
        controller.abort(reason);
        await dispose(result);
        throw reason ?? failure();
      }
      admitted = true;
      return result;
    },
    abort,
    finish() {
      finished = true;
      close();
    },
    close,
  };
}
