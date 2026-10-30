import {
  inspectFlowTrigger,
  runTrackedFlow,
  triggerPrincipal,
  flowDefinitionHash,
  RECURRENCE_FREQUENCIES,
  FLOW_MAX_DEPTH,
  zoneParts,
  zonedInstant,
} from './flow-runtime.mjs';
import { flowRunsOf } from './flow-runs.mjs';
import { compileODataPredicate, parseODataExpression } from './odata-query.mjs';
import { validateServiceProfile } from './local-organization-service.mjs';
import { committedJobs, liveJob, stageCommittedJobs } from './committed-work.mjs';
import { systemIds, storeScheduler } from './runtime-clock.mjs';
import { registerPackExport } from './pack-exports.mjs';
import { createRequestContext, runWithRequest } from './request-context.mjs';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
const definitionOf = (workflow) => workflow?.definition?.properties?.definition ?? workflow?.definition?.definition;
const flowItems = (items) =>
  items().filter((i) => i.kind === 'cloud-flow' && i.contract?.trigger?.kind === 'dataverse');
const hostedRunners = new WeakMap();
/** The trigger runner of this DataStore's organization (its trigger hosts), or null. */
export const flowTriggersOf = (store) => (store && hostedRunners.get(store)) ?? null;
// The next occurrence of a recurrence after now: from startTime (or the time it was armed) in whole intervals. Missed
// occurrences are not back-filled. Without startTime the first occurrence is one interval after arming, although a newly
// saved flow natively runs at once; Month adds calendar months in UTC.
export function nextOccurrence({ frequency, interval, start, zone = 'UTC', schedule = null }, now, armedAt = now) {
  if (schedule || (zone !== 'UTC' && ['Day', 'Week', 'Month'].includes(frequency)))
    return calendarOccurrence({ frequency, interval, start, zone, schedule }, now, armedAt);
  const anchor = start ?? armedAt,
    step = RECURRENCE_FREQUENCIES[frequency];
  if (anchor > now) return anchor;
  if (step) return anchor + (Math.floor((now - anchor) / (step * interval)) + 1) * step * interval;
  const base = new Date(anchor);
  let months = 0,
    at = anchor;
  while (at <= now) {
    months += interval;
    const d = new Date(base);
    d.setUTCMonth(base.getUTCMonth() + months);
    at = d.getTime();
  }
  return at;
}
// A Day/Week/Month recurrence with a schedule or a time zone, on wall-clock days in that zone: the first scheduled time after now,
// no sooner than startTime. Unset hours, minutes, week day and month day come from startTime (or the arming time), as documented
// (concepts-schedule-automated-recurring-tasks-workflows#start-time; Day/Week examples, monthDays -1 the last day).
// Guesses: Week intervals counted in Monday-based weeks from the anchor's week, seconds 0 with a schedule, a monthDay past
// the month's end skipping that month.
function calendarOccurrence({ frequency, interval, start, zone, schedule }, now, armedAt) {
  const s = schedule ?? {},
    anchor = start ?? armedAt,
    a = zoneParts(anchor, zone),
    dayOf = (ms) => Math.floor(ms / 86400000),
    week = (day) => Math.floor((day + 3) / 7);
  const anchorDay = dayOf(Date.UTC(a.year, a.month, a.day)),
    from = zoneParts(Math.max(anchor, now), zone),
    first = dayOf(Date.UTC(from.year, from.month, from.day));
  const hours = s.hours ?? [a.hour],
    minutes = s.minutes ?? [a.minute],
    second = schedule ? 0 : a.second;
  // ponytail: a day-by-day scan bounded to 17 years (the documented maximum Month interval is 16); a closed form is the upgrade if it shows in profiles.
  for (let day = first; day < first + 6210; day++) {
    const date = new Date(day * 86400000),
      y = date.getUTCFullYear(),
      m = date.getUTCMonth(),
      d = date.getUTCDate();
    const due =
      frequency === 'Day'
        ? (day - anchorDay) % interval === 0
        : frequency === 'Week'
          ? (week(day) - week(anchorDay)) % interval === 0 &&
            (s.weekDays ?? [new Date(anchorDay * 86400000).getUTCDay()]).includes(date.getUTCDay())
          : (y * 12 + m - (a.year * 12 + a.month)) % interval === 0 &&
            (s.monthDays ?? [a.day]).some(
              (n) => n === d || (n === -1 && d === new Date(Date.UTC(y, m + 1, 0)).getUTCDate()),
            );
    if (!due) continue;
    for (const hour of hours)
      for (const minute of minutes) {
        const at = zonedInstant({ year: y, month: m, day: d, hour, minute, second }, zone);
        if (at > now && at >= anchor) return at;
      }
  }
  return null;
}
/** Pack export flowTriggers: { [connectorId]: { [operationId]: { subscribe(ctx), unsubscribe?(ctx), poll?(ctx) } } } (contract). */
registerPackExport('flowTriggers', {
  check(value, packId) {
    const bad = (message) => {
      throw new Error(`Data pack ${packId}: ${message}`);
    };
    if (!value || typeof value !== 'object' || Array.isArray(value))
      bad('flowTriggers must map connector ids to { operationId: { subscribe, unsubscribe?, poll? } }');
    for (const [connectorId, ops] of Object.entries(value)) {
      if (!/^[\w.-]{1,250}$/.test(connectorId) || !ops || typeof ops !== 'object' || Array.isArray(ops))
        bad(`flowTriggers.${connectorId} must map operation ids to trigger hosts`);
      for (const [operationId, entry] of Object.entries(ops))
        if (
          !operationId.trim() ||
          !entry ||
          typeof entry !== 'object' ||
          typeof entry.subscribe !== 'function' ||
          (entry.unsubscribe !== undefined && typeof entry.unsubscribe !== 'function') ||
          (entry.poll !== undefined && typeof entry.poll !== 'function')
        )
          bad(
            `flowTriggers.${connectorId}.${operationId} needs subscribe(ctx) and optional unsubscribe(ctx), poll(ctx) functions`,
          );
    }
  },
});
/** Own asynchronous queue for Dataverse row triggers, plus the trigger hosts of Recurrence flows and pack connector
 * triggers (flowTriggers): a host starts when its flow has the exported mode and explicit local activation
 * (configuration.activation 'local-enabled'), at runner creation and on sync(); close() stops every host.
 * Source rows have already been saved before arrival.
 * No callback makes a live request or changes the committed caller response.
 * Every accepted run is a Ready asyncoperation row (System Event) run by the store's one durable job runner
 * (committed-work.mjs), so a restart runs it; the row is removed when the run ends (the run is reported by diagnostics). */
export function createFlowTriggerRunner({
  store,
  items,
  workflows,
  identities,
  diagnostic = () => {},
  limits = {},
  acceptedChains = new Set(),
  connectors = null,
  secrets = null,
}) {
  const chainRuns = new Map(),
    own = new Set(),
    jobs = committedJobs(store);
  let closed = false,
    closing = false,
    stopSequence = Infinity;
  const record = (code, entry) => diagnostic({ code, ...entry });
  const run = async ({ id, payload: { key, chain }, event }) => {
    // The run joins the committing request's correlation as an asynchronous child of it.
    const correlationId = event.correlationId ?? chain.id;
    await runWithRequest(
      createRequestContext({
        correlationId,
        depth: chain.depth + 1,
        mode: 'async',
        ids: store.ids,
        clock: store.clock,
      }),
      () =>
        store.transact(async () => {
          const { rows, index } = liveJob(store, id);
          if (index < 0 || rows[index].statecode !== 0) return null;
          store.removeRow('asyncoperation', rows, index);
          const oldChain = store.flowChain;
          store.flowChain = { id: chain.id, depth: chain.depth + 1 };
          try {
            const item = flowItems(items).find((i) => i.key === key);
            if (!item) throw new Error('The flow trigger registration is no longer available.');
            const workflow = workflows().get(item.processId),
              definition = definitionOf(workflow),
              trigger = inspectFlowTrigger(definition),
              mapping = store.resolveMapping(trigger.table);
            if (!trigger.supported) throw new Error(trigger.errors.join(' '));
            if (workflow.active !== true) {
              if (item.configuration?.activation !== 'local-enabled')
                throw new Error(
                  'The imported workflow activation state is not Activated. Choose explicit local activation to exercise this source.',
                );
              record('FLOW_TRIGGER_ACTIVATION_OVERRIDE', {
                operationKey: item.key,
                sourceActivation: workflow.active ?? null,
                sourceFile: workflow.file,
                message: 'User selected local activation; exported activation remains unchanged.',
              });
            }
            const connectionReferences = workflow.definition?.properties?.connectionReferences;
            const profile =
              identities().get(item.processId) ?? triggerPrincipal(connectors, definition, connectionReferences);
            validateServiceProfile(profile);
            const grants = profile.grants.filter((g) => g.entity === event.entity && g.operations.includes('read'));
            if (!grants.some((g) => !g.predicate || g.predicate(structuredClone(event.row), 'read') === true))
              throw new Error('Trigger backend profile has no matching read grant for the committed source row.');
            if (event.operation === 'update' && trigger.selectColumns.length) {
              const scalar = trigger.selectColumns.filter((name) => {
                const field = store.fieldDefinition(event.entity, name);
                if (!field) throw new Error('Select-column field kind is absent from the imported metadata: ' + name);
                return !['lookup', 'customer', 'owner'].includes(
                  String(field.dataverseType ?? field.type ?? '').toLowerCase(),
                );
              });
              if (!scalar.some((name) => event.submittedAttributes.includes(name))) return null;
            }
            if (trigger.filter) {
              if (event.operation === 'delete')
                throw new Error(
                  'Delete trigger filters require native payload/filter evidence; this combination is not yet implemented.',
                );
              const ctx = store.queryContext({ admin: true, id: profile.userId }, { dialect: 'dataverse' });
              if (
                !compileODataPredicate(
                  parseODataExpression(trigger.filter, { dialect: 'dataverse' }),
                  mapping,
                  ctx,
                )(event.row)
              )
                return null;
            }
            if (item.mode !== 'exported')
              throw new Error(
                'Automatic Dataverse triggers support imported definitions, explicit mock or disabled mode.',
              );
            const input = {
                ...structuredClone(event.row),
                SdkMessage: { create: 'Create', update: 'Update', delete: 'Delete' }[event.operation],
              },
              answer = await runTrackedFlow({
                runs: flowRunsOf(store),
                processId: item.processId,
                trigger: 'Automated',
                depth: chain.depth + 1,
                definition,
                input,
                store,
                serviceProfile: profile,
                steps: item.configuration?.steps,
                connectors: connectors ?? undefined,
                connectionReferences,
                secrets,
                context: { correlationId },
                diagnostic: (d) => record(d.code, { ...d, operationKey: item.key, chainId: chain.id, correlationId }),
              });
            record(answer.status === 'Skipped' ? 'FLOW_TRIGGER_SKIPPED' : 'FLOW_TRIGGER_COMPLETED', {
              operationKey: item.key,
              chainId: chain.id,
              correlationId,
              status: answer.status,
              ...(answer.runId ? { runId: answer.runId } : {}),
              sourceFile: item.sourceFile,
              payloadScope: 'Local committed row snapshot; native payload parity requires separate capture',
            });
          } catch (error) {
            record('FLOW_TRIGGER_FAILED', {
              operationKey: key,
              chainId: chain.id,
              error: { code: error.code ?? 'LocalFlowTriggerUnsupported', message: error.message },
            });
          } finally {
            store.flowChain = oldChain;
          }
          return null;
        }),
    )
      .catch((error) =>
        record('FLOW_TRIGGER_QUEUE_FAILED', { operationKey: key, error: { code: error.code, message: error.message } }),
      )
      .finally(() => own.delete(id));
  };
  const unregister = jobs.register('flow', run);
  const same = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
  // One durable "When an action is performed" job: its row is removed and its run executes in one transaction, as a row-trigger
  // job, so a restart before it ran still runs it (committedJobs resume).
  const runAction = ({ id, payload: { key, input } }) =>
    store
      .transact(
        async () => {
          const { rows, index } = liveJob(store, id);
          if (index < 0 || rows[index].statecode !== 0) return null;
          store.removeRow('asyncoperation', rows, index);
          const current = candidates().get(key);
          await start(
            hosts.get(key) ?? {
              key,
              kind: 'dataverse-action',
              hash: current ? flowDefinitionHash(current.definition) : null,
            },
            { input, trigger: 'Automated', wrap: (fn) => fn() },
          );
          return null;
        },
        { cloneResult: false },
      )
      .catch((error) =>
        record('FLOW_TRIGGER_QUEUE_FAILED', { operationKey: key, error: { code: error.code, message: error.message } }),
      );
  const unregisterAction = jobs.register('flow-action', runAction);
  // Selection runs inside the committing transaction (a data.mjs commit stager): the Ready rows commit or roll back with
  // the triggering rows. Chain counters, diagnostics and the runner start apply only after that commit.
  const stage = (events, { sequence = 0 } = {}) => {
    if (closed) return null;
    const entries = [],
      notes = [],
      counts = new Map(),
      note = (code, entry) => notes.push([code, entry]);
    for (const event of events) {
      if (event.messageEvent) continue;
      // A committed custom API action (dataverse-customapi.mjs): one durable job per enabled "When an action is performed" host.
      if (event.operation === 'action') {
        for (const host of hosts.values())
          if (host.kind === 'dataverse-action' && same(event.message, host.message) && same(event.table, host.table)) {
            if (!cataloged(host, event.message)) {
              note('FLOW_TRIGGER_NOT_CATALOGED', {
                operationKey: host.key,
                message:
                  'The action is not assigned to the trigger catalog and category (catalog, catalogassignment rows).',
              });
              continue;
            }
            entries.push({
              id: (store.ids ?? systemIds).uuid(),
              kind: 'flow-action',
              columns: { name: host.key, correlationid: event.correlationId ?? null },
              key: host.key,
              input: { InputParameters: event.inputs ?? {}, OutputParameters: event.outputs ?? {} },
              event: {},
            });
          }
        continue;
      }
      for (const item of flowItems(items)) {
        if (closing && sequence > stopSequence && !acceptedChains.has(event.chain?.id)) {
          note('FLOW_TRIGGER_STOPPED', {
            operationKey: item.key,
            message: 'A new committed root event arrived after the stop boundary.',
          });
          continue;
        }
        const workflow = workflows().get(item.processId),
          definition = definitionOf(workflow),
          trigger = inspectFlowTrigger(definition);
        let mapping;
        try {
          mapping = store.resolveMapping(trigger.table);
        } catch {
          note('FLOW_TRIGGER_UNSUPPORTED', {
            operationKey: item.key,
            message: 'The source trigger table cannot be bound to the imported schema.',
          });
          continue;
        }
        const messages = {
          1: ['create'],
          2: ['delete'],
          3: ['update'],
          4: ['create', 'update'],
          5: ['create', 'delete'],
          6: ['update', 'delete'],
          7: ['create', 'update', 'delete'],
        };
        if (mapping.logicalName !== event.entity || !messages[trigger.message]?.includes(event.operation)) continue;
        if (item.mode === 'disabled') {
          note('FLOW_TRIGGER_DISABLED', { operationKey: item.key });
          continue;
        }
        if (item.mode === 'placeholder') {
          note('FLOW_TRIGGER_PLACEHOLDER', {
            operationKey: item.key,
            message: 'Source trigger has no enabled local execution choice.',
          });
          continue;
        }
        if (item.mode === 'mock') {
          note('FLOW_TRIGGER_MOCK', {
            operationKey: item.key,
            status: item.configuration?.status ?? 200,
            sourceActivation: workflow.active ?? null,
            message: 'Explicit local mock; original trigger logic and backend connection were not executed.',
          });
          continue;
        }
        // A root event (no chain) starts its own chain, so the rows of one bulk commit never share one chain budget.
        const chain = event.chain ?? { id: (store.ids ?? systemIds).uuid(), depth: 0 },
          runs = (counts.get(chain.id) ?? chainRuns.get(chain.id) ?? 0) + 1;
        if (
          chain.depth >= Math.min(limits.maxDepth ?? 8, FLOW_MAX_DEPTH) ||
          runs > Math.min(limits.maxChainRuns ?? 100, 1000)
        ) {
          note('FLOW_TRIGGER_LIMIT', { operationKey: item.key, chainId: chain.id, depth: chain.depth });
          continue;
        }
        // Committed work is never dropped: every run is a durable Ready job, run FIFO; a large backlog is only reported.
        const backlog = Math.min(limits.maxPending ?? 100, 1000),
          waiting = own.size + entries.length;
        if (waiting >= backlog && waiting % backlog === 0)
          note('FLOW_TRIGGER_BACKLOG', { operationKey: item.key, chainId: chain.id, pending: waiting + 1 });
        counts.set(chain.id, runs);
        entries.push({
          id: (store.ids ?? systemIds).uuid(),
          kind: 'flow',
          columns: {
            name: item.key,
            regardingobjecttypecode: event.entity,
            primaryentitytype: event.entity,
            correlationid: chain.id,
            depth: chain.depth + 1,
          },
          key: item.key,
          chain,
          event,
        });
      }
    }
    return stageCommittedJobs(store, {
      entries,
      diagnostics: notes,
      report: ([code, entry]) => record(code, entry),
      counts,
      ledger: { runs: chainRuns, accepted: acceptedChains, own },
    });
  };
  // "When an action is performed" lists the actions of a Catalog and a Category: a category is a second-level catalog row whose
  // parentcatalogid is the catalog, and a catalogassignment row assigns a custom API to the category
  // (https://learn.microsoft.com/power-automate/dataverse/action-trigger,
  // https://learn.microsoft.com/power-apps/developer/data-platform/catalog-catalogassignment). A trigger without catalog and
  // category matches by action name only. Not known natively: whether the exported catalog and category values are unique names
  // or ids (both are accepted), and the stored column of the polymorphic assignment object (object, customapiid or objectid).
  // Catalog rows come from the Solution (source-organization-extensions.mjs: catalogs/ and Assets/catalogassignments.xml).
  // An organization whose catalog table has no row at all (no Solution ships a catalog) cannot be checked: the trigger fires by action
  // name and FLOW_TRIGGER_CATALOG_UNCHECKED says so once per host.
  function cataloged(host, message) {
    if (host.catalog == null && host.category == null) return true;
    const rows = (name) => {
        try {
          return store.tableRows(name) ?? [];
        } catch {
          return [];
        }
      },
      catalogs = rows('catalog'),
      named = (value) => catalogs.find((r) => [r.uniquename, r.catalogid, r.name].some((v) => same(v, value)));
    if (!catalogs.length) {
      if (!host.catalogNoted) {
        host.catalogNoted = true;
        record('FLOW_TRIGGER_CATALOG_UNCHECKED', {
          operationKey: host.key,
          message:
            'No catalog rows are loaded; the action trigger matches by action name without its catalog and category assignment.',
        });
      }
      return true;
    }
    const catalog = named(host.catalog),
      category = named(host.category);
    if (!catalog || !category || !same(category.parentcatalogid, catalog.catalogid)) return false;
    const api = rows('customapi').find((r) => same(r.uniquename, message));
    return (
      Boolean(api) &&
      rows('catalogassignment').some(
        (a) =>
          same(a.catalogid, category.catalogid) &&
          ([a.object, a.customapiid, a.objectid].some((v) => same(v, api.customapiid)) ||
            (same(a.objectname, api.uniquename) &&
              String(a.objectidtype ?? 'customapi').toLowerCase() === 'customapi')),
      )
    );
  }
  const unsubscribe = store.addCommitStager(stage);
  const drain = () => jobs.drain();
  const beginClose = (sequence) => {
    closing = true;
    stopSequence = Math.min(stopSequence, sequence ?? store.committedEventSequence ?? 0);
  };

  // ---- trigger hosts: Recurrence (behaviour) and pack connector triggers (contract)
  const hosts = new Map(),
    scheduler = () => storeScheduler(store),
    now = () => Number(store.clock?.now?.() ?? Date.now());
  const eligible = (item) => item.mode === 'exported' && item.configuration?.activation === 'local-enabled';
  const candidates = () => {
    const result = new Map();
    for (const item of items())
      if (item.kind === 'cloud-flow') {
        const workflow = workflows().get(item.processId),
          definition = definitionOf(workflow);
        if (!definition) continue;
        const trigger = inspectFlowTrigger(definition, { connectors });
        if (['recurrence', 'connector', 'http', 'dataverse-action'].includes(trigger.kind))
          result.set(item.key, { item, workflow, definition, trigger });
      }
    return result;
  };
  // One hosted run: a tracked run (trigger type Recurrence or Automated) in its own transaction, reported by FLOW_TRIGGER_* diagnostics.
  async function start(host, { input, trigger, wrap = (fn) => store.transact(fn, { cloneResult: false }) }) {
    const current = candidates().get(host.key);
    if (closed || !current || !eligible(current.item) || flowDefinitionHash(current.definition) !== host.hash) {
      record('FLOW_TRIGGER_STOPPED', {
        operationKey: host.key,
        message: 'The flow is no longer enabled for local trigger hosting.',
      });
      return null;
    }
    const { item, workflow, definition } = current,
      connectionReferences = workflow.definition?.properties?.connectionReferences,
      correlationId = (store.ids ?? systemIds).uuid();
    try {
      const profile =
        identities().get(item.processId) ?? triggerPrincipal(connectors, definition, connectionReferences);
      const answer = await runTrackedFlow({
        runs: flowRunsOf(store),
        processId: item.processId,
        trigger,
        definition,
        input,
        store,
        serviceProfile: profile,
        steps: item.configuration?.steps,
        connectors: connectors ?? undefined,
        connectionReferences,
        secrets,
        context: { correlationId },
        wrap,
        diagnostic: (d) => record(d.code, { ...d, operationKey: item.key, correlationId }),
      });
      record(answer?.status === 'Skipped' ? 'FLOW_TRIGGER_SKIPPED' : 'FLOW_TRIGGER_COMPLETED', {
        operationKey: item.key,
        trigger: host.kind,
        correlationId,
        status: answer?.status ?? null,
        ...(answer?.runId ? { runId: answer.runId } : {}),
      });
      return answer;
    } catch (error) {
      record('FLOW_TRIGGER_FAILED', {
        operationKey: item.key,
        trigger: host.kind,
        correlationId,
        error: { code: error.code ?? 'LocalFlowTriggerFailed', message: error.message },
      });
      return null;
    }
  }
  const arm = (host, fn) => {
    const next = nextOccurrence(host.recurrence, now(), host.armedAt);
    host.next = next;
    if (next === null) {
      record('FLOW_TRIGGER_SCHEDULE_EMPTY', {
        operationKey: host.key,
        message: 'The recurrence schedule has no occurrence in the next 17 years.',
      });
      return;
    }
    host.handle = scheduler().schedule(
      async () => {
        host.handle = null;
        if (hosts.get(host.key) !== host) return;
        await fn();
        if (hosts.get(host.key) === host) arm(host, fn);
      },
      Math.max(0, next - now()),
      { name: 'flow-recurrence' },
    );
  };
  const context = (host) => ({
    processId: host.processId,
    operationKey: host.key,
    connectorId: host.connectorId,
    operationId: host.operationId,
    parameters: structuredClone(host.parameters ?? {}),
    clock: store.clock ?? null,
    fire: (body) =>
      start(host, {
        input: body && typeof body === 'object' && !Array.isArray(body) ? body : {},
        trigger: 'Automated',
      }),
  });
  async function startHost(key, { item, definition, trigger }) {
    const host = {
      key,
      processId: item.processId,
      kind: trigger.kind,
      hash: flowDefinitionHash(definition),
      armedAt: now(),
      next: null,
      handle: null,
    };
    hosts.set(key, host);
    if (trigger.kind === 'recurrence') {
      host.recurrence = trigger.recurrence;
      arm(host, () => start(host, { input: {}, trigger: 'Recurrence' }));
      return;
    }
    // "When an action is performed": the committed custom API action event (dataverse-customapi.mjs invoke) is staged by stage()
    // as a durable flow-action job for this host; the run's trigger body is the action's InputParameters and OutputParameters
    // (https://learn.microsoft.com/power-automate/dataverse/action-trigger#using-dynamic-content-and-action-inputs--outputs;
    // body/OutputParameters in https://learn.microsoft.com/power-platform/alm/extend-pipelines#triggers). The other body fields
    // of the native notification are not reproduced. The action must be assigned to the trigger's category (cataloged()).
    if (trigger.kind === 'dataverse-action') {
      Object.assign(host, {
        message: trigger.message,
        table: trigger.table,
        catalog: trigger.catalog,
        category: trigger.category,
      });
      return;
    }
    const raw = Object.values(definition.triggers)[0],
      entry = connectors.flowTriggers(trigger.connectorId, trigger.operationId);
    Object.assign(host, {
      connectorId: trigger.connectorId,
      operationId: trigger.operationId,
      parameters: raw.inputs?.parameters ?? {},
      entry,
    });
    try {
      host.subscription = await entry.subscribe(context(host));
    } catch (error) {
      hosts.delete(key);
      record('FLOW_TRIGGER_SUBSCRIBE_FAILED', {
        operationKey: key,
        error: { code: error.code ?? 'FlowTriggerSubscribeFailed', message: error.message },
      });
      return;
    }
    if (trigger.polling) {
      host.recurrence = trigger.recurrence;
      arm(host, async () => {
        try {
          const found = await entry.poll({ ...context(host), subscription: host.subscription });
          for (const body of Array.isArray(found) ? found : [])
            await start(host, { input: body, trigger: 'Automated' });
        } catch (error) {
          record('FLOW_TRIGGER_POLL_FAILED', {
            operationKey: key,
            error: { code: error.code ?? 'FlowTriggerPollFailed', message: error.message },
          });
        }
      });
    }
  }
  async function stopHost(key) {
    const host = hosts.get(key);
    if (!host) return;
    hosts.delete(key);
    if (host.handle !== null && host.handle !== undefined) scheduler().cancel(host.handle);
    if (host.entry?.unsubscribe)
      try {
        await host.entry.unsubscribe({ ...context(host), subscription: host.subscription });
      } catch (error) {
        record('FLOW_TRIGGER_UNSUBSCRIBE_FAILED', {
          operationKey: key,
          error: { code: error.code ?? 'FlowTriggerUnsubscribeFailed', message: error.message },
        });
      }
  }
  // Hosts follow the operation choices when syncTriggers() runs: at runner creation and when the host applies operation
  // overrides. GET /_sim/api/flow-triggers only lists them (list()).
  /** Starts the hosts of newly enabled Recurrence/connector-trigger flows and stops the others; answers list(). */
  async function syncTriggers() {
    if (closed || closing) return list();
    let found;
    try {
      found = candidates();
    } catch (error) {
      record('FLOW_TRIGGER_SYNC_FAILED', {
        error: { code: error.code ?? 'FlowTriggerSyncFailed', message: error.message },
      });
      return list();
    }
    for (const [key, host] of [...hosts]) {
      const want = found.get(key);
      if (!want || !want.trigger.supported || !eligible(want.item) || flowDefinitionHash(want.definition) !== host.hash)
        await stopHost(key);
    }
    for (const [key, want] of found)
      if (!hosts.has(key) && want.trigger.supported && want.trigger.kind !== 'http' && eligible(want.item))
        await startHost(key, want);
    return list(found);
  }
  /** The trigger hosts: one entry per Recurrence, HTTP Request and connector-trigger flow. */
  function list(found = null) {
    try {
      found ??= candidates();
    } catch {
      found = new Map();
    }
    return [...found.values()].map(({ item, trigger }) => {
      const host = hosts.get(item.key);
      return {
        operationKey: item.key,
        processId: item.processId,
        kind: trigger.kind,
        supported: trigger.supported,
        mode: item.mode,
        activation: item.configuration?.activation ?? null,
        state:
          trigger.kind === 'http'
            ? trigger.supported && item.mode === 'exported'
              ? 'on-demand'
              : 'inactive'
            : host
              ? trigger.kind === 'recurrence' || host.recurrence
                ? 'scheduled'
                : 'subscribed'
              : 'inactive',
        ...(host?.next != null ? { nextRun: new Date(host.next).toISOString() } : {}),
        ...(trigger.connectorId ? { connectorId: trigger.connectorId, operationId: trigger.operationId } : {}),
        ...(trigger.supported ? {} : { errors: trigger.errors }),
        ...(!host && trigger.kind !== 'http' && trigger.supported && !eligible(item)
          ? { reason: 'Needs the exported mode and explicit local activation.' }
          : {}),
      };
    });
  }
  const runner = {
    drain,
    beginClose,
    syncTriggers,
    triggers: () => list(),
    async close() {
      beginClose();
      for (const key of [...hosts.keys()]) await stopHost(key);
      await drain();
      closed = true;
      unsubscribe();
      unregister();
      unregisterAction();
      chainRuns.clear();
      if (hostedRunners.get(store) === runner) hostedRunners.delete(store);
    },
    status: () => ({ pending: jobs.pending(), closed }),
  };
  hostedRunners.set(store, runner);
  syncTriggers().catch((error) =>
    record('FLOW_TRIGGER_SYNC_FAILED', {
      error: { code: error.code ?? 'FlowTriggerSyncFailed', message: error.message },
    }),
  );
  return runner;
}

// "When an HTTP request is received" callback URLs (https://learn.microsoft.com/azure/connectors/connectors-native-reqres): each
// flow has its own random HMAC-SHA256 key, sealed in state.simulator.flowCallbackKeys (flow-vault.mjs), and its URL carries the
// signature of the flow, trigger and the sp, sv and api-version values as sig. A request without a valid sig answers 401.
// The native URL shape and signed content are a guess; locally the URL is served under this host's /_sim/api/flow-triggers.
const CALLBACK_API_VERSION = '2016-06-01';
const callbackId = (processId) =>
  String(processId ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();
async function callbackKey(store, vault, processId, create) {
  const keys = () => store.state.simulator?.flowCallbackKeys ?? {},
    id = callbackId(processId),
    opened = keys()[id] ? vault.open(keys()[id]) : undefined;
  if (opened || !create) return opened ? Buffer.from(opened.key, 'base64') : null;
  const key = randomBytes(32);
  await store.transact(
    () => {
      ((store.state.simulator ??= {}).flowCallbackKeys ??= {})[id] = vault.seal({ key: key.toString('base64') });
    },
    { nested: true },
  );
  return key;
}
const signature = (key, processId, triggerName, sp, sv, version) =>
  createHmac('sha256', key)
    .update([callbackId(processId), triggerName, sp, sv, version].join('\n'))
    .digest('base64url');
/** The signed callback URL of a flow's Request trigger on origin: { method, url } (the key is created on first use). */
export async function flowCallbackUrl({ store, vault, processId, triggerName, origin, method = null }) {
  const key = await callbackKey(store, vault, processId, true),
    sp = '/triggers/' + triggerName + '/run',
    sv = '1.0';
  const url = new URL(
    '/_sim/api/flow-triggers/' +
      encodeURIComponent(callbackId(processId)) +
      '/triggers/' +
      encodeURIComponent(triggerName) +
      '/paths/invoke',
    origin,
  );
  for (const [k, v] of Object.entries({
    'api-version': CALLBACK_API_VERSION,
    sp,
    sv,
    sig: signature(key, processId, triggerName, sp, sv, CALLBACK_API_VERSION),
  }))
    url.searchParams.set(k, v);
  return { method: method ?? 'POST', url: url.href };
}
/** Whether a callback request's query carries the flow's valid signature (constant-time comparison). */
export async function verifyFlowCallback({ store, vault, processId, triggerName, query }) {
  const key = await callbackKey(store, vault, processId, false),
    sig = query.get('sig');
  if (
    !key ||
    !sig ||
    query.get('sp') !== '/triggers/' + triggerName + '/run' ||
    query.get('sv') !== '1.0' ||
    query.get('api-version') !== CALLBACK_API_VERSION
  )
    return false;
  const expected = Buffer.from(
      signature(key, processId, triggerName, query.get('sp'), query.get('sv'), query.get('api-version')),
    ),
    given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Capability record: Recurrence hosting is behaviour; pack connector trigger hosting is a contract seam. */
export function describe() {
  return {
    name: 'flow-triggers',
    version: 1,
    kind: 'organization-module',
    level: 'behaviour',
    operations: [
      { name: 'dataverseRowTriggers', level: 'behaviour' },
      { name: 'recurrence', level: 'behaviour' },
      { name: 'httpRequestOnDemand', level: 'behaviour' },
      { name: 'httpRequestCallbackUrl', level: 'behaviour' },
      { name: 'connectorTriggers', level: 'contract' },
      { name: 'recurrenceSchedule', level: 'behaviour' },
      { name: 'businessEventsTrigger', level: 'behaviour' },
    ],
    requires: ['scheduler', 'flow-runs'],
    principal: 'flow',
    stateOwner: 'store:tables.flowrun',
    lifecycle: 'in-process',
  };
}
