// Cloud flow run store: one `flowrun` row per run (the standard Dataverse table) plus the replay state in
// state.simulator.flowRuns[runId] = { processId, definitionHash, input, parameters, steps, journal, wait, notResumable }.
//
// A run that waits (delay, approval, webhook) is suspended: its row becomes Waiting and the wait is recorded. Resume is
// deterministic replay: resume() answers the `steps` mock map for executeFlowDefinition, built from the steps configured
// at start, every journalled connector action as { mode: 'mock', status, outputs } and the suspended action's outcome,
// so completed connector calls are not executed again. The run's non-secret flow parameter values are frozen at start and
// replayed on resume; a replay that reaches a live provider call before every journalled path is consumed fails the run
// NotResumable (ReplayDiverged, flow-runtime.mjs). Journal keys carry the occurrence ('path#2'), so a loop body replays each
// iteration. Secure outputs (journalled actions and secure waiting actions) are sealed in state (AES-256-GCM, flow-vault.mjs, key
// file under the state directory): a resume, also after a restart over the same state directory, replays them; without a state
// directory the key lives in this process, so a resume after a restart is NotResumable naming the action.
// An open run has an AbortSignal (signalOf); cancel() aborts it, so the interpreter schedules nothing more and provider calls
// in flight are aborted.
// A parent waiting on a child run (wait kind child) is resumed by the child's completion.
//
// Wait timers (timeoutAt, and `until` of a delay) run on the store's scheduler. They are in-memory: rearm() schedules
// them again from the recorded waits after a restart. A durable committed job (committed-work.mjs) runs as soon as it is
// written and has no due time, so it does not carry a timer.
// ponytail: in-memory wait timers re-armed by rearm(); move them to a due-time job row when committedJobs gains one.
// The flowrun status text values and the Approvals timeout outputs are guesses of the native ones.
import { DataError } from './data-error.mjs';
import { storeScheduler, systemClock, systemIds } from './runtime-clock.mjs';
import { runTrackedFlow, triggerPrincipal } from './flow-runtime.mjs';
import { runOwned } from './dataverse-transaction-context.mjs';
import { flowVault } from './flow-vault.mjs';
const OPEN = new Set(['Running', 'Waiting']);
const TERMINAL = new Set(['Succeeded', 'Failed', 'Cancelled', 'TimedOut']);
const ACTION_STATUSES = new Set(['Succeeded', 'Failed', 'Skipped', 'TimedOut']);
// child: a parent run waiting on a child flow run (wait.id is the child run id); the child's completion resumes it.
const WAIT_KINDS = new Set(['delay', 'approval', 'webhook', 'child']);
// The outcome of a parent's Workflow action from its child run's end: a Response below 400 succeeds, anything else fails it.
const childOutcome = ({ status, outputs, error }) =>
  status === 'Succeeded' && !(outputs?.statusCode >= 400)
    ? { status: 'Succeeded', outputs: outputs ?? {} }
    : {
        status: 'Failed',
        outputs: outputs ?? {
          error: {
            code: error?.code ?? 'ChildFlowFailed',
            message: error?.message ?? 'The child flow run ended ' + status + '.',
          },
        },
      };
const same = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
const clone = (value) => (value === undefined ? null : structuredClone(value));
const timeOf = (value) => {
  if (value == null) return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) throw new DataError('A wait time must be a date.', 400, 'InvalidRequest');
  return ms;
};

// The run rows' table: the standard flowrun table, composed by the organization at startup (dataverse-organization.mjs
// INTERNAL_TABLES) so the first run is a row write, never a schema change.
export const FLOW_RUN_TABLE = 'flowrun';
export function createFlowRunStore({
  store,
  clock = store?.clock ?? systemClock,
  ids = store?.ids ?? systemIds,
  scheduler = null,
  limits = {},
  diagnostic = () => {},
  approvals = null,
  resumeRun = null,
  stateDirectory = null,
  vault = flowVault(stateDirectory),
} = {}) {
  if (!store || typeof store.transact !== 'function') throw new TypeError('createFlowRunStore requires a DataStore');
  const keepRuns = limits.keepRuns ?? 200,
    keepJournals = limits.keepJournals ?? 50;
  const now = () => +clock.now();
  const iso = (ms) => new Date(ms).toISOString();
  const timers = new Map(); // runId -> scheduler handle
  // Process memory only, never state: the answers of child runs that ended before their parent recorded the wait on them, and
  // the cancellation controller of each open run.
  const childAnswers = new Map(),
    controllers = new Map();
  // A secure outcome in state is { status, secure: true, sealed } (views show { status, secure: true } only).
  const sealedEntry = (status, outputs, attempts) => ({
    status,
    secure: true,
    sealed: vault.seal(clone(outputs ?? {})),
    ...(Array.isArray(attempts) ? { attempts: clone(attempts) } : {}),
  });
  const viewJournal = (journal) =>
    journal && Object.fromEntries(Object.entries(journal).map(([path, { sealed, ...entry }]) => [path, clone(entry)]));
  const tasks = () => scheduler ?? storeScheduler(store);
  const runs = () => ((store.state.simulator ??= {}).flowRuns ??= {});
  const table = () => (store.state.tables.flowrun ??= []);
  const indexOf = (id) => table().findIndex((row) => same(row.flowrunid, id));
  // Joins the caller's transaction (a flow run inside a committed write) or runs its own.
  const write = (fn) => store.transact(fn, { nested: true });
  const notFound = () => new DataError('The flow run does not exist.', 404, 'FlowRunNotFound');
  const entryOf = (id) => {
    const index = indexOf(id),
      entry = runs()[id];
    if (index < 0 || !entry) throw notFound();
    return { index, row: table()[index], entry };
  };
  const setRow = (index, values) => store.mutateRow('flowrun', table(), index, values);

  function view(id, { journal = true } = {}) {
    const row = table()[indexOf(id)],
      entry = runs()[id];
    if (!row || !entry) return null;
    return {
      id: row.flowrunid,
      processId: row.workflowid,
      status: row.status,
      starttime: row.starttime,
      endtime: row.endtime ?? null,
      triggertype: row.triggertype ?? null,
      correlationId: row.correlationid ?? null,
      definitionHash: entry.definitionHash ?? null,
      wait: clone(entry.wait),
      notResumable: entry.notResumable ?? null,
      journalPruned: Boolean(entry.journalPruned),
      ...(journal ? { journal: viewJournal(entry.journal) } : {}),
    };
  }

  const disarm = (id) => {
    if (timers.has(id)) {
      tasks().cancel(timers.get(id));
      timers.delete(id);
    }
  };
  function arm(id, wait) {
    disarm(id);
    const due = [
      wait.timeoutAt != null && ['timeout', timeOf(wait.timeoutAt)],
      wait.kind === 'delay' && wait.until != null && ['until', timeOf(wait.until)],
    ]
      .filter(Boolean)
      .sort((a, b) => a[1] - b[1])[0];
    if (!due) return;
    const handle = tasks().schedule(() => fire(id, wait.id, due[0]), Math.max(0, due[1] - now()), {
      name: 'flow-run-wait',
    });
    if (handle !== null) timers.set(id, handle);
  }
  // A due wait: a delay ends Succeeded, a timeout ends TimedOut (runAfter ['TimedOut'] branches run on resume).
  async function fire(id, waitId, reason) {
    timers.delete(id);
    const entry = runs()[id],
      row = table()[indexOf(id)];
    if (!entry?.wait || entry.wait.id !== waitId || row?.status !== 'Waiting') return;
    if (reason === 'timeout' && entry.wait.kind === 'approval') await approvals?.close?.(waitId, 'TimedOut');
    const outcome =
      reason === 'timeout'
        ? { status: 'TimedOut', outputs: { error: { code: 'ActionTimedOut', message: 'The action wait timed out.' } } }
        : { status: 'Succeeded', outputs: {} };
    if (resumeRun) return resumeRun(id, outcome);
    if (reason === 'timeout')
      return api.complete(id, {
        status: 'TimedOut',
        error: { code: 'ActionTimedOut', message: 'The action wait timed out.' },
      });
    diagnostic({ code: 'FLOW_RESUME_NOT_WIRED', runId: id, waitId });
  }

  // Bounds: remove the oldest completed runs beyond keepRuns; drop journals and inputs of completed runs beyond keepJournals;
  // drop finished approvals beyond keepRuns (every Pending one stays).
  // ponytail: state.simulator sections are structured-cloned on every incremental write, so these bounded sizes are what keep the per-write cost flat.
  function pruneIn() {
    const all = runs(),
      rows = table();
    const tracked = rows
      .filter((row) => all[row.flowrunid])
      .sort((a, b) => String(b.starttime).localeCompare(String(a.starttime)));
    const remove = new Set(
      tracked
        .slice(keepRuns)
        .filter((row) => TERMINAL.has(row.status))
        .map((row) => row.flowrunid),
    );
    for (let i = rows.length - 1; i >= 0; i--)
      if (remove.has(rows[i].flowrunid)) {
        delete all[rows[i].flowrunid];
        store.removeRow('flowrun', rows, i);
      }
    let pruned = 0;
    for (const row of tracked.filter((r) => !remove.has(r.flowrunid) && TERMINAL.has(r.status)).slice(keepJournals)) {
      const entry = all[row.flowrunid];
      if (entry.journalPruned) continue;
      Object.assign(entry, { journal: null, steps: null, input: null, parameters: null, journalPruned: true });
      pruned++;
    }
    let approvalsPruned = 0;
    const approvalMap = store.state.simulator?.approvals;
    if (approvalMap) {
      const finished = Object.entries(approvalMap)
        .filter(([, approval]) => approval?.status !== 'Pending')
        .sort(([, a], [, b]) => String(b?.completionDate ?? '').localeCompare(String(a?.completionDate ?? '')));
      for (const [id] of finished.slice(keepRuns)) {
        delete approvalMap[id];
        approvalsPruned++;
      }
    }
    if (pruned || remove.size || approvalsPruned)
      diagnostic({
        code: 'FLOW_RUN_JOURNAL_PRUNED',
        journals: pruned,
        runs: remove.size,
        approvals: approvalsPruned,
        keepRuns,
        keepJournals,
      });
    return { runs: remove.size, journals: pruned, approvals: approvalsPruned };
  }

  const api = {
    scheduler: tasks,
    /** The sealing vault of this runtime's state directory (flow-vault.mjs): flow callback keys use it too. */
    vault,
    /** The host's replay entry point; timers call it with the wait outcome. */
    setResumeRun(fn) {
      resumeRun = typeof fn === 'function' ? fn : null;
    },

    /** parameters: the run's resolved non-secret flow parameter values (never a Secret one); resume() answers them. */
    /** background: an on-demand run that completes without a Response (resume() answers it back). */
    async start({
      processId,
      trigger = null,
      input = {},
      correlationId = null,
      definitionHash = null,
      steps = {},
      parameters = null,
      background = false,
    } = {}) {
      if (typeof processId !== 'string' || !processId)
        throw new DataError('A flow run needs its workflow id.', 400, 'InvalidRequest');
      const id = ids.uuid(),
        at = iso(now());
      await write(() => {
        store.insertRow('flowrun', table(), {
          flowrunid: id,
          name: id,
          workflowid: processId,
          status: 'Running',
          starttime: at,
          endtime: null,
          triggertype: trigger == null ? null : String(trigger),
          correlationid: correlationId ?? id,
        });
        runs()[id] = {
          processId,
          definitionHash,
          input: clone(input),
          parameters: clone(parameters),
          steps: clone(steps),
          journal: {},
          wait: null,
          notResumable: null,
          ...(background ? { background: true } : {}),
        };
      });
      return view(id);
    },

    /** The AbortSignal of an open run (created on first use); cancel() aborts it. */
    signalOf(runId) {
      if (!controllers.has(runId)) controllers.set(runId, new AbortController());
      return controllers.get(runId).signal;
    },

    /** Records one executed connector action (attempts: its retry attempts); actionPath carries its loop iteration ('path#2' for the
     * second iteration of a loop body). Secure outputs are sealed (flow-vault.mjs), never written in clear. */
    journal(runId, actionPath, { status = 'Succeeded', outputs = {}, secure = false, attempts = null } = {}) {
      if (!ACTION_STATUSES.has(status)) throw new DataError('Invalid journalled action status.', 400, 'InvalidRequest');
      return write(() => {
        const { row, entry } = entryOf(runId);
        if (row.status !== 'Running')
          throw new DataError('Only a running flow run journals actions.', 409, 'FlowRunNotRunning');
        const repeated = Object.hasOwn(entry.journal ?? {}, actionPath);
        (entry.journal ??= {})[actionPath] = secure
          ? sealedEntry(status, outputs, attempts)
          : { status, outputs: clone(outputs), ...(Array.isArray(attempts) ? { attempts: clone(attempts) } : {}) };
        if (repeated && !entry.notResumable) {
          entry.notResumable = 'RepeatedAction';
          diagnostic({ code: 'FLOW_RUN_NOT_RESUMABLE', runId, actionPath, reason: 'RepeatedAction' });
        }
      });
    },

    async suspend(runId, { actionPath, wait } = {}) {
      if (typeof actionPath !== 'string' || !actionPath)
        throw new DataError('A suspended run needs its action path.', 400, 'InvalidRequest');
      if (!wait || !WAIT_KINDS.has(wait.kind) || typeof wait.id !== 'string' || !wait.id)
        throw new DataError('A wait needs a kind (delay, approval, webhook) and an id.', 400, 'InvalidRequest');
      const recorded = {
        kind: wait.kind,
        id: wait.id,
        actionPath,
        ...(wait.until != null ? { until: iso(timeOf(wait.until)) } : {}),
        ...(wait.timeoutAt != null ? { timeoutAt: iso(timeOf(wait.timeoutAt)) } : {}),
        ...(wait.assignedTo != null ? { assignedTo: clone(wait.assignedTo) } : {}),
        ...(wait.secure ? { secure: true } : {}),
      };
      let ended = null;
      await write(() => {
        const { index, row, entry } = entryOf(runId);
        if (row.status !== 'Running')
          throw new DataError('Only a running flow run can wait.', 409, 'FlowRunNotRunning');
        // A child wait: the child run records its owner (parent run, action path); a child that already ended resumes it now.
        if (wait.kind === 'child') {
          const child = entryOf(wait.id);
          child.entry.parent = { runId, actionPath };
          if (TERMINAL.has(child.row.status)) ended = childAnswers.get(wait.id) ?? { status: child.row.status };
          childAnswers.delete(wait.id);
        }
        setRow(index, { status: 'Waiting' });
        entry.wait = recorded;
      });
      arm(runId, recorded);
      if (ended && resumeRun) await resumeRun(runId, childOutcome(ended));
      return view(runId);
    },

    /** Turns a Waiting run back to Running and answers the replay inputs: { steps, input, parameters, replay, processId, correlationId,
     * definitionHash }; replay lists the journalled action paths the run must consume as mocks before any live provider call. */
    async resume(runId, outcome = {}, { definitionHash } = {}) {
      const status = outcome.status ?? 'Succeeded';
      if (!ACTION_STATUSES.has(status)) throw new DataError('Invalid wait outcome status.', 400, 'InvalidRequest');
      const { row, entry } = entryOf(runId);
      if (row.status !== 'Waiting') throw new DataError('The flow run is not waiting.', 409, 'FlowRunNotWaiting');
      // A sealed secure output that this runtime's key cannot open (a memory-only runtime after a restart) names its action.
      const opened = Object.fromEntries(
        Object.entries(entry.journal ?? {})
          .filter(([, done]) => done.secure)
          .map(([path, done]) => [path, vault.open(done.sealed)]),
      );
      const secureAt = Object.entries(opened).find(([, value]) => value === undefined)?.[0];
      const reason =
        entry.notResumable ??
        (secureAt ? 'SecureOutputs (action ' + secureAt + ')' : null) ??
        (definitionHash && entry.definitionHash && definitionHash !== entry.definitionHash
          ? 'DefinitionChanged'
          : null);
      if (reason) {
        await api.complete(runId, {
          status: 'Failed',
          error: { code: 'NotResumable', message: 'The flow run cannot resume: ' + reason + '.' },
        });
        throw new DataError('The flow run cannot resume: ' + reason + '.', 409, 'NotResumable');
      }
      disarm(runId);
      return write(() => {
        // The real guard: a second resume of the same wait may have answered between the check above and this write.
        const { index, row: current, entry: live } = entryOf(runId);
        if (current.status !== 'Waiting' || !live.wait)
          throw new DataError('The flow run is not waiting.', 409, 'FlowRunNotWaiting');
        // A secure waiting action (secureData outputs): state keeps { status, secure: true }, the answer stays in process memory.
        if (live.wait.secure) {
          live.journal[live.wait.actionPath] = sealedEntry(status, outcome.outputs);
          opened[live.wait.actionPath] = clone(outcome.outputs ?? {});
        } else live.journal[live.wait.actionPath] = { status, outputs: clone(outcome.outputs ?? {}) };
        live.wait = null;
        setRow(index, { status: 'Running' });
        // journal answers every occurrence-keyed entry (flow-runtime.mjs replays 'path#2' for a loop body's second run); steps
        // keeps the first-occurrence mocks for callers that execute the replay directly. Neither is written to state.
        const journal = Object.fromEntries(
          Object.entries(live.journal).map(([path, done]) => [
            path,
            { status: done.status, outputs: clone(done.secure ? opened[path] : done.outputs) },
          ]),
        );
        const mocks = Object.fromEntries(
          Object.entries(journal)
            .filter(([path]) => !/#[\d.]+$/.test(path))
            .map(([path, done]) => [path, { mode: 'mock', ...clone(done) }]),
        );
        return {
          steps: { ...clone(live.steps ?? {}), ...mocks },
          configured: clone(live.steps ?? {}),
          journal,
          input: clone(live.input),
          parameters: clone(live.parameters ?? null),
          replay: Object.keys(live.journal),
          processId: live.processId,
          correlationId: table()[index].correlationid,
          definitionHash: live.definitionHash ?? null,
          background: Boolean(live.background),
        };
      });
    },

    /** outputs: a child run's Response ({ statusCode, headers, body }); the parent waiting on it resumes with it. */
    async complete(runId, { status = 'Succeeded', error = null, outputs = null } = {}) {
      if (!TERMINAL.has(status))
        throw new DataError('A completed flow run needs a terminal status.', 400, 'InvalidRequest');
      disarm(runId);
      let parent = null;
      await write(() => {
        const { index, row, entry } = entryOf(runId);
        if (TERMINAL.has(row.status)) return; // a run cancelled meanwhile keeps its status
        const at = now();
        setRow(index, {
          status,
          endtime: iso(at),
          duration: Math.max(0, at - Date.parse(row.starttime)),
          ...(error
            ? { errorcode: String(error.code ?? 'FlowRunFailed'), errormessage: String(error.message ?? '') }
            : {}),
        });
        Object.assign(entry, { wait: null, input: null, parameters: null });
        // Only a parent still Waiting on this child run is resumed (a cancelled parent is left alone).
        const owner = entry.parent ? runs()[entry.parent.runId] : null,
          ownerRow = entry.parent ? table()[indexOf(entry.parent.runId)] : null;
        if (ownerRow?.status === 'Waiting' && owner?.wait?.kind === 'child' && same(owner.wait.id, runId))
          parent = entry.parent;
        // ponytail: a child that ends before its parent recorded the wait hands its answer over in memory, bounded to 200 runs.
        else if (!entry.parent && row.triggertype === 'ChildFlow') {
          childAnswers.set(runId, { status, outputs: clone(outputs), error: clone(error) });
          if (childAnswers.size > 200) childAnswers.delete(childAnswers.keys().next().value);
        }
        pruneIn();
      });
      controllers.delete(runId);
      if (parent && resumeRun) await resumeRun(parent.runId, childOutcome({ status, outputs, error }));
      return view(runId);
    },

    async cancel(runId) {
      const { row, entry } = entryOf(runId);
      if (!OPEN.has(row.status)) return false;
      // Abort first: the interpreter stops scheduling and provider calls in flight end before the row write queues.
      controllers.get(runId)?.abort(new DataError('The flow run was cancelled.', 409, 'FlowRunCancelled'));
      if (entry.wait?.kind === 'approval') await approvals?.close?.(entry.wait.id, 'Cancelled');
      await api.complete(runId, { status: 'Cancelled' });
      return true;
    },
    async cancelAll(processId) {
      let count = 0;
      for (const run of api.list({ processId })) if (OPEN.has(run.status) && (await api.cancel(run.id))) count++;
      return count;
    },

    get: (runId) => view(runId),
    list({ processId, status } = {}) {
      return table()
        .filter(
          (row) =>
            runs()[row.flowrunid] &&
            (!processId || same(row.workflowid, processId)) &&
            (!status || row.status === status),
        )
        .sort((a, b) => String(b.starttime).localeCompare(String(a.starttime)))
        .map((row) => view(row.flowrunid, { journal: false }));
    },
    /** Waiting runs and their waits; state 'overdue' or 'pending' filters by timeoutAt against the clock. */
    waits({ state } = {}) {
      const at = now();
      return table()
        .filter((row) => row.status === 'Waiting' && runs()[row.flowrunid]?.wait)
        .map((row) => {
          const wait = runs()[row.flowrunid].wait;
          return {
            runId: row.flowrunid,
            processId: row.workflowid,
            ...clone(wait),
            overdue: wait.timeoutAt != null && Date.parse(wait.timeoutAt) <= at,
          };
        })
        .filter((w) => !state || (state === 'overdue') === w.overdue);
    },
    /** Schedules the timers of every recorded wait again (after a restart or a state load). Returns the number armed. */
    rearm() {
      let count = 0;
      for (const wait of api.waits())
        if (!timers.has(wait.runId) && (wait.timeoutAt != null || wait.until != null)) {
          arm(wait.runId, wait);
          count++;
        }
      return count;
    },
    prune: () => write(pruneIn),
    close() {
      for (const id of [...timers.keys()]) disarm(id);
    },
    describe,
  };
  return api;
}

// The host's run store per DataStore (attach): the row-trigger runner and the portal cloud-flow route find it here.
const attached = new WeakMap();
/** The run store attached to this DataStore's organization, or null (then flows run untracked, as without a store). */
export const flowRunsOf = (store) => (store && attached.get(store)) ?? null;

/**
 * The host composition (organization-host.mjs): a run store whose resumeRun replays a waiting run through runTrackedFlow with
 * the flow's current source and choices (flowOf = host cloudFlow), inside the organization's change slot and a store
 * transaction. attach(api) sets api.flowRuns and api.resumeRun (sim-flow-routes.mjs), registers the store for flowRunsOf and
 * re-arms recorded wait timers; close() stops the timers (only this store's scheduler handles) and unregisters.
 * Every kind of run (row trigger, ExecuteWorkflow, portal request, child flow) replays the same way: its input, steps and
 * journal are in the run state, and the definition, identity and connections come from flowOf(processId).
 */
export function createHostFlowRuns({
  store,
  clock = null,
  ids = null,
  scheduler = null,
  limits,
  diagnostic = () => {},
  approvals = null,
  flowOf,
  stateDirectory = null,
}) {
  let change = (fn) => fn();
  const runs = createFlowRunStore({
    store,
    ...(clock ? { clock } : {}),
    ...(ids ? { ids } : {}),
    scheduler,
    limits,
    diagnostic,
    approvals,
    stateDirectory,
  });
  async function resumeRun(runId, outcome) {
    try {
      const run = runs.get(runId),
        flow = run ? flowOf(run.processId) : null;
      if (run && !flow?.definition) {
        if (run.status === 'Waiting')
          await runs.complete(runId, {
            status: 'Failed',
            error: {
              code: 'NotResumable',
              message: 'The flow run cannot resume: its definition is no longer in the sources.',
            },
          });
        throw new DataError(
          'The flow run cannot resume: its definition is no longer in the sources.',
          409,
          'NotResumable',
        );
      }
      return await runTrackedFlow({
        runs,
        flowOf,
        resume: { runId, outcome },
        processId: run?.processId,
        wrap: (fn) => change(() => store.transact(fn, { cloneResult: false })),
        definition: flow?.definition,
        store,
        serviceProfile:
          flow?.serviceProfile ?? triggerPrincipal(flow?.connectors, flow?.definition, flow?.connectionReferences),
        steps: flow?.steps,
        connectors: flow?.connectors,
        connectionReferences: flow?.connectionReferences,
        secrets: flow?.secrets,
        diagnostic,
      });
    } catch (error) {
      diagnostic({
        code: 'FLOW_RUN_RESUME_FAILED',
        runId,
        error: { code: error.code ?? 'FlowResumeFailed', message: error.message },
      });
      return null;
    }
  }
  runs.setResumeRun(resumeRun);
  const closeTimers = runs.close;
  return Object.assign(runs, {
    flowOf,
    resumeRun,
    attach(api) {
      // The resumed run owns the change slot (runOwned), so a custom API it calls joins its transaction (no self-wait).
      if (typeof api?.change === 'function') change = (fn) => api.change(() => runOwned(fn));
      api.flowRuns = runs;
      api.resumeRun = resumeRun;
      attached.set(store, runs);
      runs.rearm();
      return runs;
    },
    close() {
      if (attached.get(store) === runs) attached.delete(store);
      closeTimers();
    },
  });
}

/** Capability record: local run mechanics are behaviour; native outcome and run-history parity are contract. */
export function describe() {
  return {
    name: 'flow-runs',
    version: 1,
    kind: 'organization-module',
    level: 'behaviour',
    operations: [
      { name: 'runRows', level: 'behaviour' },
      { name: 'journal', level: 'behaviour' },
      { name: 'waits', level: 'behaviour' },
      { name: 'resumeReplay', level: 'behaviour' },
      { name: 'waitTimeouts', level: 'behaviour' },
      { name: 'childFlowWaits', level: 'behaviour' },
      { name: 'approvalOutcomeShape', level: 'contract' },
      { name: 'runHistoryApiParity', level: 'contract' },
    ],
    requires: ['table:flowrun', 'scheduler'],
    principal: 'none',
    stateOwner: 'store:tables.flowrun+state:simulator.flowRuns',
    lifecycle: 'in-process',
  };
}
