// One clock, id and scheduler source for an organization runtime. The defaults are wall time, random GUIDs and real
// timers; tests and acceptance runs pass fixedClock, sequentialIds and a manual scheduler for reproducible state.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { uuidV5 } from './dataverse-security.mjs';

// setTimeout runs a delay above 2**31 - 1 ms after 1 ms. A longer wait is armed in clamped slices.
export const MAX_TIMER_DELAY = 2 ** 31 - 1;
// runDue refuses to loop forever when tasks keep re-queuing themselves as due.
const MAX_DUE_RUNS = 10000;

export const systemClock = Object.freeze({ now: () => Date.now() });
export const systemIds = Object.freeze({ uuid: () => randomUUID() });

/** A clock that moves only when told to: advance(ms) and set(ms) return the new time. */
export function fixedClock(startMs = Date.parse('2026-01-01T00:00:00.000Z')) {
  let now = Number(startMs);
  if (!Number.isFinite(now)) throw new TypeError('fixedClock needs a start time in epoch milliseconds.');
  return {
    now: () => now,
    advance(ms) { now += Number(ms); return now; },
    set(ms) { now = Number(ms); return now; },
  };
}

/** Deterministic, valid version 5 GUIDs: the namespace GUID over a counter (1, 2, ...). */
export function sequentialIds(namespace = '6ba7b810-9dad-11d1-80b4-00c04fd430c8') {
  let counter = 0;
  uuidV5(namespace, '0'); // refuses an invalid namespace up front
  return { uuid: () => uuidV5(namespace, String(++counter)) };
}

/** The clock as a function of epoch milliseconds, from a function or a { now() } object. */
export const clockFunction = clock => typeof clock === 'function' ? clock : () => clock.now();

// The manual-scheduler task whose code is running, so schedule() knows which task queued a continuation.
const currentTask = new AsyncLocalStorage();
// libuv requests (file system, socket writes, connects, DNS) in flight: a task waiting on one is still making progress.
const IO_REQUEST = /Req|WriteWrap|ShutdownWrap|ConnectWrap|QueryWrap|SendWrap/;
const ioPending = () => process.getActiveResourcesInfo().some(name => IO_REQUEST.test(name));
const turn = () => new Promise(resolve => setImmediate(resolve));

/**
 * Tracked tasks on one clock. Real mode runs a task on the next turn (delay 0) or after its delay on an unref'd timer;
 * manual mode only queues them, and runDue()/advance(ms) run the due ones in due order. close() cancels every task and
 * refuses new ones. faults({ task, name, attempt }) may return an Error: that attempt does not run the task, is counted
 * in status().faults and the task is queued again as due now (return null to let the next attempt run).
 * Manual mode: a running task that queued a task of its own which has not finished (a connector retry pause, a flow wait)
 * may be waiting on it, so runDue() runs due tasks without waiting for that task, and a task still queued and not due
 * makes it blocked once a quiet turn passes (no task settled or queued, no I/O request in flight). runDue(), advance()
 * and drain() return with blocked tasks still running; status().blocked counts them and status().pending leaves them
 * out. A later advance() that makes the continuation due runs it, and the blocked task then finishes.
 * ponytail: "blocked" is judged from continuations the task queued and process-wide I/O activity, not from what the task
 * awaits; a task waiting on unrelated I/O that never completes keeps runDue() waiting. Explicit wait handles would be exact.
 */
export function createScheduler({ clock = systemClock, manual = false, faults = null } = {}) {
  const now = clockFunction(clock);
  const tasks = new Map(); // handle -> { task, name, due, delay, order, attempt, timer, immediate }
  const running = new Set(); // entries of started tasks, each with its settle promise (entry.tracked)
  let closed = false, sequence = 0, executed = 0, faulted = 0, failed = 0, progress = 0, wake = null;
  // Every schedule and every settle is progress, and wakes a manual runDue()/drain() waiting for some.
  const progressed = () => { progress += 1; if (wake) { const resolve = wake.resolve; wake = null; resolve(); } };
  const woken = () => (wake ??= Promise.withResolvers()).promise;

  const disarm = entry => {
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.immediate) clearImmediate(entry.immediate);
    entry.timer = entry.immediate = null;
  };
  const arm = (handle, entry, delay) => {
    if (manual) return;
    if (delay > 0) {
      entry.remaining = delay;
      const fire = () => {
        entry.remaining -= Math.min(entry.remaining, MAX_TIMER_DELAY);
        if (entry.remaining > 0) { entry.timer = setTimeout(fire, Math.min(entry.remaining, MAX_TIMER_DELAY)); entry.timer.unref?.(); return; }
        entry.timer = null;
        execute(handle);
      };
      entry.timer = setTimeout(fire, Math.min(delay, MAX_TIMER_DELAY));
      entry.timer.unref?.();
    } else entry.immediate = setImmediate(() => { entry.immediate = null; execute(handle); });
  };
  function execute(handle) {
    const entry = tasks.get(handle);
    if (!entry || closed) return Promise.resolve();
    tasks.delete(handle);
    disarm(entry);
    entry.attempt += 1;
    const fault = faults?.({ task: entry.task, name: entry.name, attempt: entry.attempt }) ?? null;
    if (fault) {
      faulted += 1;
      entry.due = now();
      entry.delay = 0;
      tasks.set(handle, entry);
      arm(handle, entry, 0);
      return Promise.resolve();
    }
    executed += 1;
    running.add(entry); // before the task starts, so what it queues synchronously counts as its continuation
    let result;
    try { result = Promise.resolve(manual ? currentTask.run(entry, entry.task) : entry.task()); } catch (error) { result = Promise.reject(error); }
    entry.tracked = result.then(() => {}, () => { failed += 1; }).finally(() => { running.delete(entry); entry.children = null; progressed(); });
    return entry.tracked;
  }
  // A running task with a continuation it queued that is still queued, or running and itself waiting.
  const waiting = entry => Boolean(entry.children) && [...entry.children].some(child => tasks.get(child.order) === child || running.has(child) && waiting(child));
  const blocked = () => { let count = 0; for (const entry of running) if (waiting(entry)) count += 1; return count; };
  // True when a task settled or was queued during a quiet check: two turns without either and without I/O in flight.
  const settles = async () => {
    for (let quiet = 0; quiet < 2;) {
      const before = progress;
      await turn();
      if (progress !== before) return true;
      quiet = ioPending() ? 0 : quiet + 1;
    }
    return false;
  };
  // Manual mode: waits until every running task has settled or is blocked; with runTasks it also runs the due tasks, a
  // task that is not waiting finishing before the next starts (FIFO).
  async function quiesce(runTasks) {
    let count = 0;
    for (;;) {
      const active = [...running].filter(entry => !waiting(entry));
      if (active.length) { await Promise.race([...active.map(entry => entry.tracked), woken()]); continue; }
      const next = runTasks && !closed ? due() : null;
      if (next) {
        if (++count > MAX_DUE_RUNS) throw new Error(`The scheduler ran ${MAX_DUE_RUNS} due tasks in one runDue(); a task keeps re-queuing itself.`);
        execute(next[0]);
        continue;
      }
      if (!running.size || !await settles()) return count;
    }
  }
  const due = () => {
    const at = now();
    let next = null;
    for (const [handle, entry] of tasks) if (entry.due <= at && (!next || entry.due < next[1].due || entry.due === next[1].due && entry.order < next[1].order)) next = [handle, entry];
    return next;
  };
  const immediates = () => { let count = 0; for (const entry of tasks.values()) if (entry.immediate) count += 1; return count; };
  const scheduler = {
    manual,
    clock,
    schedule(task, delayMs = 0, { name = null } = {}) {
      if (typeof task !== 'function') throw new TypeError('A scheduled task must be a function.');
      if (closed) return null;
      const delay = Math.max(0, Number(delayMs) || 0), handle = ++sequence;
      const entry = { task, name, due: now() + delay, delay, order: handle, attempt: 0, timer: null, immediate: null, children: new Set(), tracked: null };
      tasks.set(handle, entry);
      if (manual) { const parent = currentTask.getStore(); if (parent?.children && running.has(parent)) parent.children.add(entry); progressed(); }
      arm(handle, entry, delay);
      return handle;
    },
    cancel(handle) {
      const entry = tasks.get(handle);
      if (!entry) return false;
      disarm(entry);
      return tasks.delete(handle);
    },
    pending: () => [...tasks].map(([handle, entry]) => ({ handle, name: entry.name, due: entry.due, attempt: entry.attempt }))
      .sort((a, b) => a.due - b.due || a.handle - b.handle),
    /** Manual mode: runs every task due at the clock's time, one after another, including tasks they queue as due, and
     * returns once the started tasks settled or are blocked. */
    runDue() {
      if (!manual) return Promise.reject(new Error('runDue() is for a manual scheduler; a real scheduler runs its own tasks.'));
      return quiesce(true);
    },
    /** Manual mode: moves the clock forward, then runs the tasks that became due. */
    advance(ms) {
      if (typeof clock?.advance !== 'function') throw new Error('advance(ms) needs a clock with advance(ms), such as fixedClock().');
      clock.advance(ms);
      return scheduler.runDue();
    },
    /** Waits for running tasks, and in real mode for tasks queued for the next turn. Timers that are not due are not awaited. */
    async drain() {
      if (manual) { await quiesce(false); return; }
      for (;;) {
        if (running.size) await Promise.all([...running].map(entry => entry.tracked));
        else if (!manual && !closed && immediates()) await new Promise(resolve => setImmediate(resolve));
        else return;
      }
    },
    beginClose() {},
    close() {
      closed = true;
      for (const entry of tasks.values()) disarm(entry);
      tasks.clear();
    },
    status: () => { const stuck = manual ? blocked() : 0;
      return { manual, closed, pending: running.size - stuck + (manual || closed ? 0 : immediates()), scheduled: tasks.size, running: running.size,
        blocked: stuck, executed, faults: faulted, failures: failed }; },
  };
  return scheduler;
}

/**
 * The store's one scheduler: the given one when the store has no open scheduler, else the store's (created on first use).
 * A closed scheduler stays the store's, so a stray call after close starts nothing; `reopen: true` replaces it.
 */
export function storeScheduler(store, scheduler = null, { reopen = false } = {}) {
  const closed = Boolean(store.scheduler?.status().closed);
  if (scheduler) { if (!store.scheduler || closed) store.scheduler = scheduler; return scheduler; }
  if (!store.scheduler || closed && reopen) store.scheduler = createScheduler({ clock: store.clock ?? systemClock });
  return store.scheduler;
}
