import { messageNameOf, runPluginPhase } from './exported-plugins.mjs';
import { committedJobs, liveJob, stageCommittedJobs } from './committed-work.mjs';
import { clockFunction, systemClock, systemIds } from './runtime-clock.mjs';
import { createRequestContext, runWithRequest } from './request-context.mjs';

// Each run gets its own request context: the starting request's correlation (carried by the committed event, else the chain)
// as the parent, mode async, the writer as principal; a plug-in trace log and nested events then carry that correlation.
const runContext = (store, event, chain) =>
  createRequestContext({ correlationId: event.correlationId ?? chain.id, clock: store.clock, ids: store.ids }).child({
    mode: 'async',
    principal: event.identity ?? null,
  });

// The Dataverse error number of a failed run: the inner code a plug-in fault carries (plugin-fault.mjs), else 0.
const errorNumber = (error) => {
  const code = error?.details?.innerCode;
  return /^0x[0-9a-f]+$/i.test(code ?? '') ? Number.parseInt(code, 16) | 0 : 0;
};
const sameId = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();

/** The asyncoperation row of one async step run (operationtype 1, System Event), Ready when the committed event is
 * accepted (committed-work.mjs keeps the event in its `data`), so a restart runs it. Learn's states: Ready (0/0), Locked
 * while running (2/20), then Completed Succeeded (3/30) or Failed (3/31). A succeeded run of a step with asyncautodelete is
 * removed, and so is every run while the Dataverse API is off (systemJobs() false): the row is then only the durable queue entry.
 * ponytail: a plug-in run writes Locked and its final state in one transaction, so only Ready and the final state are observable. */
function jobColumns(store, item, event, chain) {
  let idColumn = null;
  try {
    idColumn = store.resolveMapping(event.entity)?.idColumn;
  } catch {
    /* A removed entity has no primary-key column to include. */
  }
  const recordId = idColumn ? (event.row?.[idColumn] ?? null) : null;
  return {
    name: item.name ?? item.id,
    owningextensionid: { id: item.id, logical_name: 'sdkmessageprocessingstep', name: item.name },
    regardingobjectid: recordId ? { id: recordId, logical_name: event.entity } : null,
    regardingobjecttypecode: event.entity,
    primaryentitytype: event.entity,
    messagename: messageNameOf(event.operation),
    correlationid: chain.id,
    depth: chain.depth + 1,
  };
}
// Claims a Ready job (Locked, In Progress) and returns its finish/cancel; null when the job left Ready (a cancel) or is gone.
function claimJob(store, id, item, systemJobs, diagnostic) {
  const now = () => new Date(clockFunction(store.clock ?? systemClock)()).toISOString();
  const { rows, index } = liveJob(store, id);
  if (index < 0 || rows[index].statecode !== 0) return null;
  Object.assign(rows[index], { statecode: 2, statuscode: 20, startedon: now() });
  const autodelete =
    store.tableRows('sdkmessageprocessingstep').find((row) => sameId(row.sdkmessageprocessingstepid, item?.id))
      ?.asyncautodelete === true;
  // A web hook finishes in a later transaction: an isolated commit or a rollback in between replaces the state, so the row is found again by id.
  const live = () => {
    const found = liveJob(store, id);
    if (found.index < 0) diagnostic({ code: 'PLUGIN_ASYNC_JOB_MISSING', stepId: item?.id, asyncoperationid: id });
    return found;
  };
  return {
    finish(error) {
      const { rows, index } = live();
      if (index < 0) return;
      if (!systemJobs() || (!error && autodelete)) {
        store.removeRow('asyncoperation', rows, index);
        return;
      }
      // friendlymessage carries the plug-in's own message; the native user-facing text is not known.
      const message = error ? String(error.message ?? error) : null;
      Object.assign(
        rows[index],
        error
          ? {
              statecode: 3,
              statuscode: 31,
              completedon: now(),
              message,
              friendlymessage: message,
              errorcode: errorNumber(error),
            }
          : { statecode: 3, statuscode: 30, completedon: now() },
      );
    },
    // A web hook the simulator cannot deliver in any form is Canceled (statuscode 32), with the message as its reason.
    cancel(message) {
      const { rows, index } = live();
      if (index < 0) return;
      if (!systemJobs()) {
        store.removeRow('asyncoperation', rows, index);
        return;
      }
      Object.assign(rows[index], {
        statecode: 3,
        statuscode: 32,
        completedon: now(),
        message,
        friendlymessage: message,
      });
    },
  };
}

/** Local post-save queue for explicitly selected source mode-1 registrations.
 * Each SDK write is independent. A later job failure cannot reject the original
 * caller or undo completed SDK requests. This is not the Dataverse async service.
 * Every accepted run is a Ready asyncoperation row run by the store's one durable job runner (committed-work.mjs); the
 * row stays after the run while systemJobs() is true (the Dataverse API is on). */
export function createAsyncPluginRunner({
  store,
  items,
  handlers,
  runtimes,
  webhooks = null,
  diagnostic = () => {},
  limits = {},
  acceptedChains = new Set(),
  systemJobs = () => false,
}) {
  const runs = new Map(),
    own = new Set(),
    jobs = committedJobs(store);
  let closed = false,
    closing = false,
    stopSequence = Infinity;
  const itemOf = (id) => items().find((item) => sameId(item.id, id)) ?? null;
  // An asynchronous web hook is delivered after commit. Its System Job is Locked while the POST runs, then Succeeded, Failed, or Canceled
  // (32: an endpoint the simulator does not contact, with a WEBHOOK_NOT_CONTACTED diagnostic, or a contract other than 8).
  const deliverWebhook = async ({ id, payload: { itemId, chain }, event }) => {
    const item = itemOf(itemId);
    try {
      if (!webhooks) {
        diagnostic({ code: 'WEBHOOK_NOT_DELIVERED', stepId: itemId, reason: 'no-adapter' });
        await store.transact(() => claimJob(store, id, item, () => false, diagnostic)?.finish(null));
        return;
      }
      let job = null;
      await store.transact(() => {
        job = claimJob(store, id, item, systemJobs, diagnostic);
      });
      if (!job) return;
      try {
        if (!item)
          throw Object.assign(new Error('The asynchronous step registration is no longer available.'), {
            code: 'LocalPluginAsyncUnavailable',
          });
        const answer = await webhooks.afterCommit({
          item,
          entity: event.entity,
          operation: event.operation,
          stage: 40,
          target: structuredClone(event.target ?? {}),
          record: structuredClone(event.row),
          previous: structuredClone(event.previous ?? null),
          identity: structuredClone(event.identity ?? {}),
          changedAttributes: event.submittedAttributes,
          depth: chain.depth + 1,
          correlationId: event.correlationId ?? chain.id,
          diagnostic,
        });
        await store.transact(() => (answer?.canceled ? job.cancel(answer.canceled) : job.finish(null)));
        diagnostic({
          code: 'PLUGIN_ASYNC_COMPLETED',
          stepId: itemId,
          chainId: chain.id,
          sourceFile: item.sourceFile,
          mode: item.mode,
        });
      } catch (error) {
        await store.transact(() => job.finish(error));
        diagnostic({
          code: 'PLUGIN_ASYNC_FAILED',
          stepId: itemId,
          chainId: chain.id,
          error: { code: error.code ?? 'LocalPluginAsyncError', message: error.message },
        });
      }
    } catch (error) {
      diagnostic({
        code: 'PLUGIN_ASYNC_QUEUE_FAILED',
        stepId: itemId,
        error: { code: error.code, message: error.message },
      });
      throw error;
    } finally {
      own.delete(id);
    }
  };
  const runStep = async ({ id, payload: { itemId, chain }, event }) => {
    const item = itemOf(itemId);
    await store
      .transact(() => {
        const previousChain = store.flowChain,
          previousFlag = store.pluginInTransaction,
          previousParent = store.pluginParentContext;
        store.flowChain = { id: chain.id, depth: chain.depth + 1 };
        store.pluginInTransaction = false;
        store.pluginParentContext = null;
        let job = null;
        try {
          job = claimJob(store, id, item, systemJobs, diagnostic);
          if (!job) return;
          if (!item)
            throw Object.assign(new Error('The asynchronous step registration is no longer available.'), {
              code: 'LocalPluginAsyncUnavailable',
            });
          runPluginPhase({
            store,
            items: [item],
            handlers,
            runtimes,
            entity: event.entity,
            operation: event.operation,
            stage: 40,
            target: structuredClone(event.target ?? {}),
            record: structuredClone(event.row),
            previous: structuredClone(event.previous ?? null),
            identity: structuredClone(event.identity ?? {}),
            changedAttributes: event.submittedAttributes,
            initialFrame: event.frame,
            asyncExecution: true,
            diagnostic,
          });
          // A run that executed nothing (an unsupported registration, or a placeholder) never reports success: its System Job is Canceled.
          const skipped =
            item.mode === 'placeholder'
              ? 'Simulator: this asynchronous step has no local handler; nothing was executed.'
              : item.unsupported && item.mode !== 'mock'
                ? `Simulator: unsupported registration, nothing was executed. ${item.unsupported}`
                : null;
          if (skipped) job.cancel(skipped);
          else job.finish(null);
          diagnostic({
            code: 'PLUGIN_ASYNC_COMPLETED',
            stepId: itemId,
            chainId: chain.id,
            sourceFile: item.sourceFile,
            mode: item.mode,
          });
        } catch (error) {
          job?.finish(error);
          diagnostic({
            code: 'PLUGIN_ASYNC_FAILED',
            stepId: itemId,
            chainId: chain.id,
            error: { code: error.code ?? 'LocalPluginAsyncError', message: error.message },
          });
        } finally {
          store.flowChain = previousChain;
          store.pluginInTransaction = previousFlag;
          store.pluginParentContext = previousParent;
        }
      })
      .catch((error) => {
        diagnostic({
          code: 'PLUGIN_ASYNC_QUEUE_FAILED',
          stepId: itemId,
          error: { code: error.code, message: error.message },
        });
        throw error;
      })
      .finally(() => own.delete(id));
  };
  const inContext = (run) => (job) => runWithRequest(runContext(store, job.event, job.payload.chain), () => run(job));
  // A rethrown transaction failure reaches the job runner, which counts the attempt (committed-work.mjs).
  const unregister = [
    jobs.register('plugin', inContext(runStep), { diagnostic }),
    jobs.register('webhook', inContext(deliverWebhook), { concurrent: true, diagnostic }),
  ];
  // Selection runs inside the committing transaction (a data.mjs commit stager): the Ready rows commit or roll back with
  // the triggering rows. Chain counters, diagnostics and the runner start apply only after that commit.
  const stage = (events, { sequence = 0 } = {}) => {
    if (closed) return null;
    const entries = [],
      notes = [],
      counts = new Map();
    for (const event of events) {
      if (closing && sequence > stopSequence && !acceptedChains.has(event.chain?.id)) {
        notes.push({
          code: 'PLUGIN_ASYNC_STOPPED',
          message: 'A new committed root event arrived after the stop boundary.',
        });
        continue;
      }
      const selected = items()
        .filter(
          (item) =>
            item.enabled &&
            item.contract?.mode === 1 &&
            item.entity === event.entity &&
            String(item.message).toLowerCase() === event.operation &&
            item.stage === 40 &&
            (!['update', 'onexternalupdated'].includes(event.operation) ||
              !item.filteringAttributes.length ||
              item.filteringAttributes.some((name) => event.submittedAttributes.includes(name))),
        )
        .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
      for (const item of selected) {
        // A root event (no chain) starts its own chain, so the rows of one bulk commit never share one chain budget.
        const chain = event.chain ?? { id: (store.ids ?? systemIds).uuid(), depth: 0 },
          count = (counts.get(chain.id) ?? runs.get(chain.id) ?? 0) + 1;
        if (chain.depth >= Math.min(limits.maxDepth ?? 8, 16) || count > Math.min(limits.maxChainRuns ?? 100, 1000)) {
          notes.push({ code: 'PLUGIN_ASYNC_LIMIT', stepId: item.id, chainId: chain.id });
          continue;
        }
        // Committed work is never dropped: every run is a durable Ready job, run FIFO; a large backlog is only reported.
        const backlog = Math.min(limits.maxPending ?? 100, 1000),
          waiting = own.size + entries.length;
        if (waiting >= backlog && waiting % backlog === 0)
          notes.push({ code: 'PLUGIN_ASYNC_BACKLOG', pending: waiting + 1, stepId: item.id, chainId: chain.id });
        counts.set(chain.id, count);
        entries.push({
          id: (store.ids ?? systemIds).uuid(),
          kind: item.mode === 'webhook' ? 'webhook' : 'plugin',
          columns: jobColumns(store, item, event, chain),
          itemId: item.id,
          chain,
          event,
        });
      }
    }
    return stageCommittedJobs(store, {
      entries,
      diagnostics: notes,
      report: diagnostic,
      counts,
      ledger: { runs, accepted: acceptedChains, own },
    });
  };
  const unsubscribe = store.addCommitStager(stage);
  const drain = () => jobs.drain();
  const beginClose = (sequence) => {
    closing = true;
    stopSequence = Math.min(stopSequence, sequence ?? store.committedEventSequence ?? 0);
  };
  return {
    drain,
    beginClose,
    async close() {
      beginClose();
      await drain();
      closed = true;
      unsubscribe();
      for (const stop of unregister) stop();
      runs.clear();
    },
    status: () => ({ pending: jobs.pending(), closed }),
  };
}
