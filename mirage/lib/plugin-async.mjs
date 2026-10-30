import {
  messageNameOf,
  runPluginPhase,
  pluginStepMatchesEntity,
  pluginPhaseMatches,
  pluginStepMatchesAttributes,
} from './exported-plugins.mjs';
import { committedJobs, liveJob, stageCommittedJobs, retryCommittedJob } from './committed-work.mjs';
import { clockFunction, systemClock, systemIds } from './runtime-clock.mjs';
import { createRequestContext, runWithRequest } from './request-context.mjs';
import { recordToSdkEntity } from './plugin-clr.mjs';
import { multipleMessage } from './plugin-single-multiple.mjs';
import { pluginStepBypassed } from './plugin-bypass.mjs';
import { DataError } from './data-error.mjs';

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
const PLUGIN_ATTEMPTS = 4;

/** The asyncoperation row of one async step run (operationtype 1, System Event), Ready when the committed event is
 * accepted (committed-work.mjs keeps the event in its `data`), so a restart runs it. Learn's states: Ready (0/0), Locked
 * while running (2/20), then Completed Succeeded (3/30) or Failed (3/31). A succeeded run of a step with asyncautodelete is
 * removed, and so is every run while the Dataverse API is off (systemJobs() false): the row is then only the durable queue entry.
 * Plug-in claims/attempt counts commit before execution; Locked is observable.
 * Explicit Retry returns the same job to Ready for a later local scheduler turn. */
function jobColumns(store, item, event, chain) {
  // Authored OrganizationRequest.RequestId is separate transport metadata.
  const requestId = event.frame?.requestId;
  let idColumn = null;
  try {
    idColumn = store.resolveMapping(event.entity)?.idColumn;
  } catch {
    /* A removed entity has no primary-key column to include. */
  }
  const recordId =
    idColumn && !['createmultiple', 'updatemultiple', 'retrievemultiple'].includes(event.operation)
      ? (event.row?.[idColumn] ?? null)
      : null;
  return {
    name: item.name ?? item.id,
    owningextensionid: { id: item.id, logical_name: 'sdkmessageprocessingstep', name: item.name },
    regardingobjectid: recordId ? { id: recordId, logical_name: event.entity } : null,
    regardingobjecttypecode: event.entity,
    primaryentitytype: event.entity,
    messagename: event.customApi?.name ?? messageNameOf(event.operation),
    correlationid: chain.id,
    depth: event.frame?.operationDepth ?? chain.depth + 1,
    ...(requestId == null ? {} : { requestid: requestId }),
  };
}

// OperationId/OperationCreatedOn describe this System Job, not the originating
// synchronous operation or the time of an individual retry/delivery attempt.
function jobExecutionFrame(store, id, event) {
  const { rows, index } = liveJob(store, id);
  const createdOn = index < 0 ? null : rows[index].createdon;
  if (typeof createdOn !== 'string' || !Number.isFinite(Date.parse(createdOn)))
    throw new DataError(
      'The queued asynchronous job has no valid creation timestamp.',
      501,
      'LocalPluginAsyncContextUnavailable',
    );
  const operationDepth = rows[index].depth;
  if (!Number.isSafeInteger(operationDepth) || operationDepth < 1)
    throw new DataError(
      'The queued asynchronous job has no valid execution depth.',
      501,
      'LocalPluginAsyncContextUnavailable',
    );
  return {
    ...structuredClone(event.frame ?? {}),
    operationId: id,
    createdOn,
    // Keep the saved UTC stamp internally; native async contexts expose its
    // clock components as DateTimeKind.Unspecified, including after retries.
    createdOnWire: { $type: 'DateTime', value: createdOn.replace(/Z$/, '') },
    operationDepth,
    delegatedDepth: operationDepth,
    asyncOperation: { id, createdOn, depth: operationDepth },
  };
}
// Claims a Ready job (Locked, In Progress) and returns its finish/cancel; null when the job left Ready (a cancel) or is gone.
function claimJob(store, id, item, systemJobs, diagnostic, { pluginAttempt = false } = {}) {
  const now = () => new Date(clockFunction(store.clock ?? systemClock)()).toISOString();
  const { rows, index } = liveJob(store, id);
  if (index < 0 || rows[index].statecode !== 0) return null;
  let attempt;
  if (pluginAttempt) {
    const payload = JSON.parse(rows[index].data);
    const previous = payload.pluginAttempts ?? 0;
    if (!Number.isSafeInteger(previous) || previous < 0 || previous > PLUGIN_ATTEMPTS)
      throw new Error('Invalid durable asynchronous plug-in attempt count.');
    if (previous === PLUGIN_ATTEMPTS) {
      if (!systemJobs()) {
        store.removeRow('asyncoperation', rows, index);
        return null;
      }
      Object.assign(rows[index], {
        statecode: 3,
        statuscode: 31,
        completedon: now(),
        message:
          payload.pluginLastFailure?.message ?? 'The asynchronous plug-in exhausted its four execution attempts.',
        friendlymessage:
          payload.pluginLastFailure?.message ?? 'The asynchronous plug-in exhausted its four execution attempts.',
        errorcode: payload.pluginLastFailure?.errorcode ?? 0,
      });
      diagnostic({ code: 'PLUGIN_ASYNC_RETRY_EXHAUSTED', stepId: item?.id, asyncoperationid: id, attempts: previous });
      return null;
    }
    attempt = previous + 1;
    rows[index].data = JSON.stringify({ ...payload, pluginAttempts: attempt });
  }
  Object.assign(rows[index], {
    statecode: 2,
    statuscode: 20,
    startedon: now(),
    ...(pluginAttempt ? { retrycount: attempt - 1 } : {}),
  });
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
    attempt,
    retry(error) {
      if (!attempt || attempt >= PLUGIN_ATTEMPTS) return false;
      const { rows, index } = live();
      if (index < 0) return false;
      const row = rows[index],
        payload = JSON.parse(row.data);
      row.data = JSON.stringify({
        ...payload,
        pluginLastFailure: { message: String(error.message ?? error), errorcode: errorNumber(error) },
      });
      Object.assign(row, { statecode: 0, statuscode: 0, message: null, friendlymessage: null, errorcode: null });
      delete row.startedon;
      delete row.completedon;
      return true;
    },
    recover() {
      const { rows, index } = live();
      if (index >= 0 && rows[index].statecode === 2 && rows[index].statuscode === 20) {
        Object.assign(rows[index], { statecode: 0, statuscode: 0 });
        delete rows[index].startedon;
      }
    },
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
  // The durable event is a snapshot; execution choices remain local/current.
  // This is a simulator admission contract, not a native queue snapshot policy.
  const skippedRegistration = (item, event, kind) => {
    const skip = (message, code) => {
      if (code) diagnostic({ code, severity: 'warning', stepId: item.id, message });
      return message;
    };
    if (!item.enabled || item.mode === 'disabled')
      return skip('Simulator: this asynchronous step is disabled; nothing was executed.', 'PLUGIN_STEP_DISABLED');
    if (item.mode === 'placeholder')
      return skip(
        'Simulator: this asynchronous step has no local handler; nothing was executed.',
        'PLUGIN_STEP_PLACEHOLDER',
      );
    if (item.unsupported && item.mode !== 'mock')
      return skip(
        `Simulator: unsupported registration, nothing was executed. ${item.unsupported}`,
        'PLUGIN_STEP_UNSUPPORTED',
      );
    if ((kind === 'webhook') !== (item.mode === 'webhook'))
      return 'Simulator: this asynchronous step changed its delivery kind; nothing was executed.';
    if (
      !pluginPhaseMatches([item], {
        store,
        entity: event.entity,
        operation: event.operation,
        stage: 40,
        changedAttributes: event.submittedAttributes ?? [],
        asyncExecution: true,
        bypassStepIds: event.bypassStepIds,
        bypassCustomPlugins: event.bypassCustomAsync,
        diagnostic,
      })
    )
      return 'Simulator: this asynchronous registration no longer matches its queued message; nothing was executed.';
    return null;
  };
  // An asynchronous web hook is delivered after commit. Its System Job is Locked while the POST runs, then Succeeded, Failed, or Canceled
  // (32: an endpoint the simulator does not contact, with a WEBHOOK_NOT_CONTACTED diagnostic, or a contract other than 8).
  const deliverWebhook = async ({ id, payload: { itemId, chain }, event }) => {
    const item = itemOf(itemId);
    try {
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
        const skipped = skippedRegistration(item, event, 'webhook');
        if (skipped) {
          await store.transact(() => job.cancel(skipped));
          return;
        }
        if (!webhooks) {
          diagnostic({ code: 'WEBHOOK_NOT_DELIVERED', stepId: itemId, reason: 'no-adapter' });
          await store.transact(() => job.cancel('Simulator: no asynchronous webhook delivery adapter is configured.'));
          return;
        }
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
          customApi: event.customApi,
          bypassStepIds: event.bypassStepIds,
          associationParameters: event.associationParameters,
          initialFrame: jobExecutionFrame(store, id, event),
          targets: event.targets,
          previousRecords: event.previousRecords,
          records: event.records,
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
    let job = null,
      retrying = false;
    try {
      // Persist the claim/attempt before invoking external original code. A
      // restart cannot reset the four-attempt budget, even after a crash.
      await store.transact(() => {
        job = claimJob(store, id, item, systemJobs, diagnostic, { pluginAttempt: true });
      });
      if (!job) return;
      await store.transact(() => {
        const previousChain = store.flowChain,
          previousFlag = store.pluginInTransaction,
          previousParent = store.pluginParentContext,
          previousTag = store.pluginSdkTag;
        store.flowChain = { id: chain.id, depth: chain.depth + 1 };
        store.pluginInTransaction = false;
        store.pluginParentContext = null;
        store.pluginSdkTag = event.frame?.requestTag;
        try {
          if (!item)
            throw Object.assign(new Error('The asynchronous step registration is no longer available.'), {
              code: 'LocalPluginAsyncUnavailable',
            });
          const skipped = skippedRegistration(item, event, 'plugin');
          if (skipped) {
            job.cancel(skipped);
            return;
          }
          let executed = false;
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
            customApi: event.customApi,
            bypassStepIds: event.bypassStepIds,
            bypassCustomPlugins: event.bypassCustomAsync,
            associationParameters: event.associationParameters,
            query: structuredClone(event.query),
            collection: structuredClone(event.collection),
            targets: event.targets,
            previousRecords: event.previousRecords,
            records: event.records,
            initialFrame: jobExecutionFrame(store, id, event),
            // A record a bulk message delegated has no ConcurrencyBehavior input (recorded corpus).
            ...(event.fromBulk ? { concurrencyBehavior: null } : {}),
            asyncExecution: true,
            diagnostic,
            onStepExecuted: () => {
              executed = true;
            },
          });
          // A run that executed nothing (an unsupported registration, or a placeholder) never reports success: its System Job is Canceled.
          if (!executed) job.cancel('Simulator: this asynchronous step completed without executing a handler or mock.');
          else job.finish(null);
          diagnostic({
            code: 'PLUGIN_ASYNC_COMPLETED',
            stepId: itemId,
            chainId: chain.id,
            sourceFile: item.sourceFile,
            mode: item.mode,
          });
        } catch (error) {
          if (error.details?.sourceException?.operationStatus === 'Retry' && job.retry(error)) {
            retrying = true;
            diagnostic({
              code: 'PLUGIN_ASYNC_RETRY_REQUESTED',
              stepId: itemId,
              chainId: chain.id,
              attempt: job.attempt,
              maxAttempts: PLUGIN_ATTEMPTS,
            });
            return;
          }
          job.finish(error);
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
          store.pluginSdkTag = previousTag;
        }
      });
      return retrying ? retryCommittedJob : undefined;
    } catch (error) {
      if (job) await store.transact(() => job.recover());
      diagnostic({
        code: 'PLUGIN_ASYNC_QUEUE_FAILED',
        stepId: itemId,
        error: { code: error.code, message: error.message },
      });
      throw error;
    } finally {
      if (!retrying) own.delete(id);
    }
  };
  const inContext = (run) => (job) => runWithRequest(runContext(store, job.event, job.payload.chain), () => run(job));
  // A rethrown transaction failure reaches the job runner, which counts the attempt (committed-work.mjs).
  const unregister = [
    jobs.register('plugin', inContext(runStep), { diagnostic }),
    jobs.register('webhook', inContext(deliverWebhook), { concurrent: true, diagnostic }),
  ];
  // Native corpus (async, crud, ownerAndState): an asynchronous Create/Update step whose row is deleted before its job
  // runs never executes, also when a retry waits. Inside the deleting transaction, the row's waiting plug-in jobs fail
  // with the row's absence (the native job's own error text is not recorded).
  const failWaitingWrites = (event) => {
    let idColumn;
    try {
      idColumn = store.resolveMapping(event.entity)?.idColumn;
    } catch {
      return;
    }
    const rowId = idColumn && event.row?.[idColumn],
      rows = store.state.tables?.asyncoperation ?? [];
    if (!rowId) return;
    const message = `${event.entity} With Id = ${rowId} Does Not Exist`;
    for (let index = rows.length - 1; index >= 0; index--) {
      const job = rows[index];
      if (
        job.statecode !== 0 ||
        !['Create', 'Update'].includes(job.messagename) ||
        job.regardingobjectid?.logical_name !== event.entity ||
        !sameId(job.regardingobjectid?.id, rowId) ||
        !String(job.data ?? '').includes('"kind":"plugin"')
      )
        continue;
      own.delete(job.asyncoperationid);
      if (!systemJobs()) store.removeRow('asyncoperation', rows, index);
      else
        Object.assign(job, {
          statecode: 3,
          statuscode: 31,
          completedon: new Date(clockFunction(store.clock ?? systemClock)()).toISOString(),
          message,
          friendlymessage: message,
          errorcode: 0x80040217 | 0,
        });
    }
  };
  // Selection runs inside the committing transaction (a data.mjs commit stager): the Ready rows commit or roll back with
  // the triggering rows. Chain counters, diagnostics and the runner start apply only after that commit.
  const stage = (events, { sequence = 0 } = {}) => {
    if (closed) return null;
    const entries = [],
      notes = [],
      counts = new Map();
    for (const event of events) {
      if (event.operation === 'delete') failWaitingWrites(event);
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
            item.contract?.supportedDeployment !== 1 &&
            item.contract?.mode === 1 &&
            pluginStepMatchesEntity(item, event.entity) &&
            (String(item.message).toLowerCase() === event.operation ||
              (!event.fromBulk && String(item.message).toLowerCase() === multipleMessage(event.operation))) &&
            item.stage === 40 &&
            !pluginStepBypassed(
              item,
              { bypassCustomPlugins: event.bypassCustomAsync, bypassStepIds: event.bypassStepIds },
              diagnostic,
            ) &&
            pluginStepMatchesAttributes(item, {
              store,
              entity: event.entity,
              operation: event.operation,
              changedAttributes: event.submittedAttributes,
            }) &&
            (event.operation !== 'onexternalupdated' ||
              !item.filteringAttributes.length ||
              item.filteringAttributes.some((name) => event.submittedAttributes.includes(name))),
        )
        .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
      for (const item of selected) {
        let invocation = event;
        if (String(item.message).toLowerCase() !== event.operation) {
          const mapping = store.resolveMapping(event.entity),
            id = event.row[mapping.idColumn];
          const target = recordToSdkEntity(store, event.entity, event.target ?? {});
          target.id = id;
          const multipleFrame = event.frame?.multipleFrame,
            sourceParent = event.frame?.asyncSourceParent,
            asyncSourceParent = sourceParent?.target
              ? {
                  ...sourceParent,
                  inputParameters: {
                    $type: 'ParameterCollection',
                    values: {
                      ...sourceParent.inputParameters?.values,
                      Target: recordToSdkEntity(store, event.entity, sourceParent.target),
                    },
                  },
                }
              : sourceParent,
            requestTag = Object.hasOwn(multipleFrame ?? {}, 'requestTag')
              ? multipleFrame.requestTag
              : event.frame?.requestTag;
          const sharedVariables = {
            ...(event.frame?.asyncSourceParent?.childSharedVariables?.values ?? {}),
            ...(multipleFrame?.sharedVariables?.values ?? {}),
            ...(requestTag === undefined ? {} : { tag: requestTag }),
          };
          invocation = {
            ...event,
            operation: multipleMessage(event.operation),
            row: { [mapping.idColumn]: '00000000-0000-0000-0000-000000000000', bulkIds: [id] },
            targets: [target],
            previousRecords: [event.previous ?? null],
            records: [event.row],
            // An async-only multiple registration has no synchronous wrapper
            // frame. Retain the known originating operation metadata without
            // copying the scalar message's Target/outputs or parent snapshot.
            frame: {
              ...Object.fromEntries(
                Object.entries(event.frame ?? {}).filter(([key]) =>
                  [
                    'requestTag',
                    'requestId',
                    'suppliedRequestId',
                    'operationId',
                    'correlationId',
                    'createdOn',
                    'createdOnWire',
                    'operationDepth',
                    'asyncSourceParent',
                  ].includes(key),
                ),
              ),
              ...(multipleFrame ?? {}),
              ...(asyncSourceParent ? { asyncSourceParent } : {}),
              ...(!Object.keys(sharedVariables).length
                ? {}
                : {
                    sharedVariables: { $type: 'ParameterCollection', values: sharedVariables },
                  }),
            },
            messageEvent: true,
          };
        }
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
          columns: jobColumns(store, item, invocation, chain),
          itemId: item.id,
          chain,
          event: invocation,
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
