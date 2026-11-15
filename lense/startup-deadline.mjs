import { STARTUP_PAGE_CAP_MS, STARTUP_PAGE_SILENCE_MS } from './startup-progress.mjs';

// Page events that show a start is still moving: requests, responses and navigations such as a sign-in redirect.
const PAGE_PROGRESS_EVENTS = ['request', 'requestfinished', 'requestfailed', 'framenavigated'];

/**
 * A model-driven start is bounded by silence, as `--startup-timeout` documents: it fails only after that long
 * without progress (a phase, a page request or navigation), or at the absolute cap counted from the start.
 * Both limits are hang guards; a start that keeps progressing is never failed by them. A deadline ends at
 * initial document/assets readiness, independently of session lifetime.
 */
export function startupDeadline(value = STARTUP_PAGE_SILENCE_MS) {
  const controller = new AbortController();
  const silenceMs = Number(value);
  if (!Number.isInteger(silenceMs) || silenceMs < 1000 || silenceMs > 600000)
    throw new Error('--startup-timeout must be an integer from 1000 to 600000 milliseconds');
  const startedAt = Date.now();
  const capAt = startedAt + STARTUP_PAGE_CAP_MS;
  let phase = 'configuration',
    lastProgressAt = startedAt,
    expired = false,
    finished = false,
    rejectDeadline,
    reason,
    timer = null;
  const pages = [];
  // Disposal of late values that need closing; settled() waits for them. Work with nothing to dispose is not tracked.
  const late = new Set();
  const promise = new Promise((_, reject) => {
    rejectDeadline = reject;
  });
  // A deadline can expire while synchronous source preparation is still returning.
  promise.catch(() => {});
  const guardFailure = (now) => {
    if (now - lastProgressAt >= silenceMs)
      return Object.assign(
        new Error(
          `Model-driven startup made no progress for ${now - lastProgressAt} ms: the ${silenceMs} ms silence guard ended the start. Last phase reached: ${phase}. This is a hang guard, not a limit on a start that keeps progressing.`,
        ),
        { code: 'startup_timeout', phase, guard: 'silence' },
      );
    if (now >= capAt)
      return Object.assign(
        new Error(
          `Model-driven startup reached the ${STARTUP_PAGE_CAP_MS} ms cap guard after ${now - startedAt} ms. Last phase reached: ${phase}. This is a hang guard, not a limit on a start that keeps progressing.`,
        ),
        { code: 'startup_timeout', phase, guard: 'cap' },
      );
    return null;
  };
  const clearTimer = () => {
    clearTimeout(timer);
    timer = null;
  };
  const detachPages = () => {
    for (const { page, listener } of pages.splice(0)) for (const name of PAGE_PROGRESS_EVENTS) page.off(name, listener);
  };
  const expire = (failure) => {
    expired = true;
    reason = failure;
    clearTimer();
    detachPages();
    controller.abort(reason);
    rejectDeadline(reason);
  };
  // A guard that is due ends the start now, even when its timer has not run yet (for example during synchronous work).
  const tripped = () => {
    if (!expired && !finished) {
      const failure = guardFailure(Date.now());
      if (failure) expire(failure);
    }
    return expired;
  };
  const schedule = () => {
    clearTimer();
    if (finished || expired) return;
    const due = Math.min(lastProgressAt + silenceMs, capAt);
    timer = setTimeout(onTimer, Math.max(1, due - Date.now()));
  };
  // Progress only moves the silence mark; the timer re-arms itself for the next due check.
  const touch = () => {
    if (!finished && !expired) lastProgressAt = Date.now();
  };
  function onTimer() {
    timer = null;
    if (!tripped()) schedule();
  }
  const abort = () => {
    if (finished || expired) return;
    expired = true;
    reason = Object.assign(new Error(`Model-driven startup cancelled during ${phase}.`), {
      code: 'startup_cancelled',
      phase,
    });
    clearTimer();
    detachPages();
    controller.abort(reason);
    rejectDeadline(reason);
  };
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  schedule();
  const onPageEvent = () => touch();
  const close = () => {
    clearTimer();
    detachPages();
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
  };
  return {
    signal: controller.signal,
    phase(value) {
      phase = value;
      touch();
    },
    /** Reports progress that is not a phase change, such as a completed step of the start. */
    progress: touch,
    /** Page requests, responses and navigations (a sign-in redirect included) count as progress until the deadline closes. */
    watchPage(page) {
      if (finished || expired || typeof page?.on !== 'function') return;
      for (const name of PAGE_PROGRESS_EVENTS) page.on(name, onPageEvent);
      pages.push({ page, listener: onPageEvent });
    },
    async wait(work, disposeLate) {
      const pending = Promise.resolve(work);
      // Work the deadline abandons before racing it still has a handler, so its later failure is not unhandled.
      pending.catch(() => {});
      let admitted = false,
        disposed = false;
      const dispose = async (value) => {
        if (!disposed) {
          disposed = true;
          await disposeLate?.(value);
        }
      };
      if (disposeLate) {
        const disposal = pending
          .then(async (value) => {
            if (!admitted && (expired || (!finished && guardFailure(Date.now())))) await dispose(value);
          })
          .catch(() => {})
          .finally(() => late.delete(disposal));
        late.add(disposal);
      }
      if (tripped()) throw reason;
      const result = await Promise.race([pending, promise]);
      if (tripped()) {
        await dispose(result);
        throw reason;
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
    /** Resolves once every late value that the deadline disposed of, or is still disposing of, has settled. */
    async settled() {
      await Promise.allSettled(late);
    },
  };
}
