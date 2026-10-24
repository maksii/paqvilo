import v8 from 'node:v8';
import { clockFunction, storeScheduler, systemClock, systemIds } from './runtime-clock.mjs';

/** Drain all post-commit consumers to a common quiescent point. A consumer may
 * create work for another consumer, so a single sequential drain is insufficient.
 * The store's scheduler (runtime-clock.mjs) is drained too: its due tasks include the dataverse-async jobs. */
export async function settleCommittedWork(store, runners, { close = false } = {}) {
  const active = [...new Set([...runners, store.scheduler])].filter(Boolean);
  if (close) {
    const boundary = store.committedEventSequence ?? 0;
    for (const runner of active) runner.beginClose(boundary);
  }
  do {
    for (const runner of active) await runner.drain();
    await store.flushCommittedEvents();
  } while (active.some((runner) => runner.status().pending));
  if (close) {
    for (const runner of active) await runner.close();
    store.committedJobs?.close();
  }
}

// asyncoperation values of a durable committed-event job. operationtype 1 is System Event (the
// default), 10 is Workflow (a classic workflow job keeps it for its whole life through `columns.operationtype`).
const SYSTEM_EVENT = 1,
  WORKFLOW = 10;

const READY = 0,
  LOCKED = 2;
// ponytail: a job whose transaction rolls back is tried 3 times, then finished Failed; a per-kind retry policy can replace the constant.
const MAX_ATTEMPTS = 3;
export const encodeEvent = (event) => v8.serialize(event).toString('base64');
const decodeEvent = (text) => v8.deserialize(Buffer.from(text, 'base64'));
const jobOf = (row) => {
  if (
    (row?.operationtype !== SYSTEM_EVENT && row?.operationtype !== WORKFLOW) ||
    typeof row.data !== 'string' ||
    !row.data.startsWith('{')
  )
    return null;
  try {
    const payload = JSON.parse(row.data);
    return typeof payload?.kind === 'string' ? payload : null;
  } catch {
    return null;
  }
};
const payloadOf = (row) => (row?.statecode === READY ? jobOf(row) : null);
// The position of a job row by id, through the store's primary-key index (data.mjs) when it has one.
const JOB_KEY = { idColumn: 'asyncoperationid' };
const indexOf = (store, rows, id) => {
  const positions = store.rowPositions?.(JOB_KEY, rows, id);
  return positions ? (positions[0] ?? -1) : rows.findIndex((row) => row.asyncoperationid === id);
};

/** The one durable runner of committed-event work for a store: async plug-in runs, async web hooks and row-triggered flows.
 * stage() writes Ready asyncoperation rows (System Event unless the entry's columns say otherwise) whose `data` keeps the
 * job kind, its chain and the committed event, so a restart finds them; a single tick on the store's scheduler runs the Ready rows of the registered kinds in
 * table order (FIFO): the next turn with a real scheduler, runDue() with a manual one. A kind registered `concurrent`
 * (a web hook POST) starts in order without blocking the jobs after it. A tick reads only its queued ids; resume() is the
 * one full scan of the table. A run whose transaction rolled back leaves its row Ready: the row counts the attempt in its
 * `data` and is tried again, and the third such attempt finishes it Failed (COMMITTED_JOB_POISONED).
 * stage() runs inside the triggering transaction (a data.mjs commit stager; stageCommittedJobs), so a commit carries its
 * jobs or does not happen; only the kick runs after the commit. With a manual scheduler a tick that waits on a not-yet-due
 * task of that scheduler (a connector retry pause) is blocked: pending() and drain() leave it to a later advance(). */
export function committedJobs(store) {
  if (store.committedJobs) return store.committedJobs;
  const kinds = new Map(),
    queued = new Set(),
    started = new Set(),
    enqueues = new Set(),
    running = new Set(),
    retry = new Set();
  let ticking = null,
    kicked = false,
    closed = false;
  const scheduler = () => storeScheduler(store);
  const now = () => new Date(clockFunction(store.clock ?? systemClock)()).toISOString();
  const autoRuns = () => {
    const status = scheduler().status();
    return !status.manual && !status.closed;
  };
  const kick = () => {
    if (kicked || closed) return;
    kicked = true;
    if (
      scheduler().schedule(
        () => {
          kicked = false;
          return tick();
        },
        0,
        { name: 'committed-jobs' },
      ) === null
    )
      kicked = false;
  };
  // Diagnostics go to each distinct sink the registered kinds were given.
  const report = (note) => {
    for (const sink of new Set([...kinds.values()].map((kind) => kind.diagnostic).filter(Boolean))) sink(note);
  };
  const remember = (id, kind, error) => {
    store.committedJobErrors ??= [];
    store.committedJobErrors.push({ id, kind, code: error.code ?? 'CommittedJobError', message: error.message });
    if (store.committedJobErrors.length > 50) store.committedJobErrors.shift();
  };
  const track = (work) => {
    const write = work.catch((error) => remember(null, null, error)).finally(() => enqueues.delete(write));
    enqueues.add(write);
    return write;
  };
  const readyJob = (rows, id) => {
    const index = indexOf(store, rows, id),
      payload = payloadOf(rows[index]);
    return payload && kinds.has(payload.kind) ? { id, payload, index } : null;
  };
  // The queued ids not yet tried in this tick, in table order (FIFO).
  const scan = (seen) => {
    const rows = store.state.tables?.asyncoperation ?? [],
      jobs = [];
    for (const id of queued) {
      if (seen.has(id) || started.has(id)) continue;
      const job = readyJob(rows, id);
      if (job) jobs.push(job);
    }
    return jobs.sort((a, b) => a.index - b.index);
  };
  // A row still Ready after its run means the run's transaction rolled back.
  const countAttempt = async (id, kind, failure) => {
    if (!readyJob(store.state.tables?.asyncoperation ?? [], id)) return;
    const message = failure
      ? String(failure.message ?? failure)
      : 'The job did not complete: its transaction was rolled back.';
    let attempts = 0;
    await store.transact(() => {
      const { rows, index } = liveJob(store, id),
        row = rows[index],
        payload = payloadOf(row);
      if (!payload) return;
      attempts = (Number(payload.attempts) || 0) + 1;
      row.data = JSON.stringify({ ...payload, attempts });
      if (attempts >= MAX_ATTEMPTS)
        Object.assign(row, { statecode: 3, statuscode: 31, completedon: now(), message, friendlymessage: message });
    });
    if (attempts >= MAX_ATTEMPTS)
      report({ code: 'COMMITTED_JOB_POISONED', asyncoperationid: id, kind, attempts, message });
    else if (attempts) retry.add(id);
  };
  const execute = async ({ id, payload }) => {
    started.add(id);
    let failure = null;
    try {
      await kinds.get(payload.kind)?.run({ id, payload, event: decodeEvent(payload.event) });
    } catch (error) {
      failure = error;
      remember(id, payload.kind, error);
    }
    try {
      if (kinds.has(payload.kind)) await countAttempt(id, payload.kind, failure);
    } catch (error) {
      remember(id, payload.kind, error);
    } finally {
      started.delete(id);
      queued.delete(id);
      // A concurrent run that ends after its tick retries on a tick of its own.
      if (retry.has(id) && !ticking) {
        retry.delete(id);
        queued.add(id);
        kick();
      }
    }
  };
  const readyRows = (entries) => {
    const ids = store.ids ?? systemIds,
      stamp = now();
    return entries.map(({ id, kind, columns = {}, event, ...rest }) => ({
      asyncoperationid: id ?? ids.uuid(),
      operationtype: SYSTEM_EVENT,
      statecode: READY,
      statuscode: 0,
      ...columns,
      createdon: stamp,
      data: JSON.stringify({ kind, ...rest, event: encodeEvent(event) }),
    }));
  };
  const manual = () => scheduler().status().manual;
  const tick = () =>
    (ticking ??= (async () => {
      const seen = new Set();
      try {
        for (;;) {
          let jobs = scan(seen);
          // Jobs a run commits (a plug-in write that triggers a flow) join this tick once their Ready rows are written.
          if (!jobs.length) {
            await store.flushCommittedEvents();
            if (enqueues.size) {
              await Promise.allSettled([...enqueues]);
              continue;
            }
            jobs = scan(seen);
            if (!jobs.length) break;
          }
          for (const job of jobs) {
            seen.add(job.id);
            if (!kinds.has(job.payload.kind)) continue;
            const run = execute(job);
            if (kinds.get(job.payload.kind).concurrent) {
              running.add(run);
              run.finally(() => running.delete(run));
            } else await run;
          }
        }
      } finally {
        // Rows tried in this tick or gone from the table stop counting; rows enqueued after its last scan start the next tick.
        const rows = store.state.tables?.asyncoperation ?? [];
        for (const id of queued) if (!started.has(id) && (seen.has(id) || !readyJob(rows, id))) queued.delete(id);
        // A rolled-back attempt runs again on the next tick, until MAX_ATTEMPTS finishes it.
        for (const id of retry) queued.add(id);
        retry.clear();
        ticking = null;
        if (queued.size) kick();
      }
    })());
  const jobs = (store.committedJobs = {
    /** run({ id, payload, event }) executes one job; it finds its row by id and writes the row's final state itself. */
    register(kind, run, { concurrent = false, diagnostic = null } = {}) {
      kinds.set(kind, { run, concurrent, diagnostic });
      return () => {
        if (kinds.get(kind)?.run === run) kinds.delete(kind);
      };
    },
    /** Inside an open transaction (a commit stager): inserts the Ready rows synchronously, so they commit or roll back with
     * it, and returns the function that starts the runner once that transaction committed (null without entries). */
    stage(entries) {
      if (!entries.length) return null;
      const rows = readyRows(entries),
        table = (store.state.tables.asyncoperation ??= []);
      for (const row of rows) store.insertRow('asyncoperation', table, row);
      return () => {
        for (const row of rows) queued.add(row.asyncoperationid);
        kick();
      };
    },
    /** Finds Ready rows saved before a restart (or imported) and starts the runner. A row left Locked (2/20) by a run that
     * did not finish (a crash during a web hook POST, a failed final write) is Ready again: at-least-once, so a web hook may
     * be delivered twice. One COMMITTED_JOB_RECOVERED diagnostic reports the count. */
    resume() {
      if (closed) return;
      const locked = [];
      for (const row of store.state.tables?.asyncoperation ?? []) {
        const id = row.asyncoperationid,
          payload = started.has(id) ? null : jobOf(row);
        if (!payload || !kinds.has(payload.kind)) continue;
        if (row.statecode === READY) queued.add(id);
        else if (row.statecode === LOCKED && row.statuscode === 20) locked.push(id);
      }
      if (locked.length)
        track(
          store
            .transact(() => {
              const rows = store.state.tables?.asyncoperation ?? [];
              let count = 0;
              for (const id of locked) {
                const row = rows[indexOf(store, rows, id)];
                if (row?.statecode !== LOCKED || started.has(id)) continue;
                Object.assign(row, { statecode: READY, statuscode: 0 });
                delete row.startedon;
                count++;
              }
              return count;
            })
            .then((count) => {
              if (!count) return;
              for (const id of locked) queued.add(id);
              report({
                code: 'COMMITTED_JOB_RECOVERED',
                count,
                message: `${count} job(s) left Locked by an unfinished run are Ready again.`,
              });
              kick();
            }),
        );
      if (queued.size) kick();
    },
    /** Settle close: resume() and kick() run nothing afterwards; enqueued rows wait for the next runtime. */
    close() {
      closed = true;
    },
    get closed() {
      return closed;
    },
    // A manual scheduler counts a running tick itself (status().pending), and leaves out a blocked one.
    pending: () => enqueues.size + running.size + (ticking && !manual() ? 1 : 0) + (autoRuns() ? queued.size : 0),
    async drain() {
      for (;;) {
        await store.flushCommittedEvents();
        if (enqueues.size) await Promise.allSettled([...enqueues]);
        else if (running.size) await Promise.all([...running]);
        else if (ticking && !manual()) await ticking;
        // The manual scheduler's drain returns once its running tasks settled or are blocked; a tick still running is blocked.
        else if (ticking) {
          const current = ticking;
          await scheduler().drain();
          if (ticking === current) return;
        } else if (autoRuns() && queued.size) {
          kick();
          await scheduler().drain();
          if (!ticking && !running.size && !enqueues.size && queued.size)
            await new Promise((resolve) => setImmediate(resolve));
        } else return;
      }
    },
  });
  return jobs;
}

/**
 * The one staging step of every committed-event consumer (plug-in steps and web hooks, flow triggers, classic workflows),
 * called inside a data.mjs commit stager: the Ready rows of `entries` (kind defaulted to `kind`) are inserted into the
 * committing transaction, and the returned function, which data.mjs runs only after that commit, applies the consumer's
 * bookkeeping: `ledger` ({ runs, accepted, own }) takes the per-chain run `counts` (bounded maps) and the staged job ids,
 * each buffered diagnostic goes to `report`, then the runner starts. Nothing of it happens when the transaction rolls back;
 * with no entry and no diagnostic it returns null, so the commit is not forced to save.
 */
export function stageCommittedJobs(
  store,
  { kind = null, entries, diagnostics = [], report = () => {}, counts = null, ledger = null },
) {
  if (!entries.length && !diagnostics.length) return null; // nothing staged: the commit is not forced to save
  const start = committedJobs(store).stage(kind ? entries.map((entry) => ({ kind, ...entry })) : entries);
  return () => {
    if (ledger) {
      for (const [id, count] of counts ?? []) {
        ledger.runs.set(id, count);
        ledger.accepted.add(id);
        if (ledger.accepted.size > 2000) ledger.accepted.delete(ledger.accepted.values().next().value);
        if (ledger.runs.size > 1000) ledger.runs.delete(ledger.runs.keys().next().value);
      }
      for (const entry of entries) ledger.own.add(entry.id);
    }
    for (const note of diagnostics) report(note);
    start?.();
  };
}

/** The asyncoperation row of a durable job, found again by id: a commit in between may have replaced the state. */
export function liveJob(store, id) {
  const rows = store.state.tables.asyncoperation ?? [];
  return { rows, index: indexOf(store, rows, id) };
}
