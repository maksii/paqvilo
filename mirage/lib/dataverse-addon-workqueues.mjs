// Simulated Dataverse work queues (Power Automate work queues): EnqueueWorkQueueItem, Dequeue, ClearWorkQueue,
// ComputeSlaWorkQueueItem and AddWorkQueueItemProcessingHistoryEntry, over the workqueue and workqueueitem tables.
// Every operation is registered through registerAddon (dataverse-addon-common.mjs), so a trusted pack's
// dataverseMessages handler replaces it. Each handler's comment names the details that are guesses.
// ponytail: ClearWorkQueue is always synchronous (isDeletionGoingAsync false); no draft-3 schema validation of the input.
import { randomUUID } from 'node:crypto';
import { DataError } from './data-error.mjs';
import { argsOf, registerAddon } from './dataverse-addon-common.mjs';
import { parseDataverseRoute, parsePrefer } from './dataverse-odata.mjs';
import { privilegeDeniedError, privilegeName } from './dataverse-security.mjs';
import { parseXmlDocument, planFetch } from './fetchxml-engine.mjs';

const STATE_QUEUED = 0;
const STATE_PROCESSING = 1;
const STATE_PROCESSED = 2;
const SLA = { NotSet: 0, In: 1, AtRisk: 2, Out: 3 };
const key = (value) => String(value ?? '').toLowerCase();
const sameId = (a, b) => key(a) === key(b);
const invalid = (message, innerCode = '0x80040203') => new DataError(message, 400, 'InvalidRequest', { innerCode });
const minutes = (count) => count * 60000;
const ms = (value) => (value == null ? null : Date.parse(value));
const iso = (at) => new Date(at).toISOString();

// SLA status of one item at time `at`: NotSet without a queue TTL, Out past its expiry, AtRisk past its threshold, else In.
function slaOf(row, ttl, at) {
  if (!ttl) return SLA.NotSet;
  if (ms(row.expirydate) != null && at >= ms(row.expirydate)) return SLA.Out;
  if (ms(row.slathresholddate) != null && at >= ms(row.slathresholddate)) return SLA.AtRisk;
  return SLA.In;
}

// The FetchXML a Dequeue request carries must select workqueueitem rows of this queue: a workqueueid eq condition on the bound id.
function checkDequeueQuery(query, queueId) {
  let fetch;
  try {
    fetch = parseXmlDocument(query, { root: 'fetch' });
    planFetch(fetch, { profile: 'webapi' });
  } catch {
    throw invalid('Invalid FetchXML');
  }
  const entity = fetch.children?.find((node) => node.name === 'entity');
  if (entity?.attrs?.name !== 'workqueueitem') throw invalid('Invalid FetchXML');
  const hasQueueCondition = (node) =>
    (node.name === 'condition' &&
      node.attrs?.attribute === 'workqueueid' &&
      node.attrs?.operator === 'eq' &&
      sameId(node.attrs?.value, queueId)) ||
    (node.children ?? []).some(hasQueueCondition);
  if (!hasQueueCondition(entity)) throw invalid('Invalid FetchXML');
}

function operations(api) {
  const { store } = api;
  const tableOf = (logical) => (store.state.tables[logical] ??= []);
  const rowIn = (logical, pk, id) => tableOf(logical).find((row) => sameId(row[pk], id)) ?? null;
  const itemsOf = (queueId) => tableOf('workqueueitem').filter((row) => sameId(row.workqueueid, queueId));
  const write = (fn) => api.change(() => store.transact(fn, { isolated: true }));
  const need = (c, logical, right) => {
    const privilege = privilegeName(right, api.principals.privilegeNoun(logical));
    if (!(api.principals.privileges(c.user).get(privilege) > 0)) throw privilegeDeniedError(c.user, privilege, logical);
  };
  // Queued and not delayed or expired at `at`.
  const eligible = (row, at) =>
    row.statecode === STATE_QUEUED &&
    (ms(row.delayuntil) == null || ms(row.delayuntil) <= at) &&
    (ms(row.expirydate) == null || ms(row.expirydate) > at);
  const fifo = (a, b) => (a.priority ?? 1) - (b.priority ?? 1) || (ms(a.createdon) ?? 0) - (ms(b.createdon) ?? 0);
  const flag = (value) => value === true || value === 'true';

  return [
    {
      name: 'EnqueueWorkQueueItem',
      kind: 'action',
      binding: 'entity',
      entity: 'workqueue',
      // Guesses: the paused-queue text, the duplicate error and the input check.
      signature: {
        params: [
          ['workQueueItem', 'mscrm.crmbaseentity'],
          ['returnCreated', 'Edm.Boolean'],
        ],
        response: [
          ['workQueueItemId', 'Edm.Guid'],
          ['workQueueItemRecord', 'mscrm.workqueueitem'],
        ],
      },
      handle: async (c) => {
        need(c, 'workqueue', 'Read');
        need(c, 'workqueueitem', 'Create');
        const queue = c.target.row;
        // A queue that is inactive or paused (statuscode 2 Inactive, 3 Paused) takes no items.
        if ((queue.statecode ?? 0) !== 0 || queue.statuscode === 2 || queue.statuscode === 3)
          throw invalid('Work queue paused or stopped');
        const item = argsOf(c).workQueueItem ?? {};
        if (typeof item !== 'object' || Array.isArray(item)) throw invalid('workQueueItem must be an entity object.');
        // A Json queue (inputschematype 1) needs input that parses as JSON.
        if (queue.inputschematype === 1 && item.input != null) {
          try {
            JSON.parse(item.input);
          } catch {
            throw invalid('Input is not valid JSON.');
          }
        }
        const at = api.clock();
        const ttl = Number(queue.defaultitemtimetoliveinminutes) || 0;
        const slaPercent = Number(queue.slathresholdinpercentage) || 0;
        const row = {
          ...item,
          workqueueitemid: randomUUID(),
          workqueueid: c.target.id,
          statecode: STATE_QUEUED,
          statuscode: 0,
          requeuecount: 0,
          retrycount: 0,
          priority: Math.max(1, Math.trunc(Number(item.priority ?? 1)) || 1),
          createdon: iso(at),
          expirydate: item.expirydate ?? (ttl ? iso(at + minutes(ttl)) : null),
          slathresholddate: ttl && slaPercent ? iso(at + (minutes(ttl) * slaPercent) / 100) : null,
          slastatus: ttl ? SLA.In : SLA.NotSet,
        };
        await write(() => {
          if (
            item.uniqueidbyqueue != null &&
            itemsOf(c.target.id).some((entry) => entry.uniqueidbyqueue === item.uniqueidbyqueue)
          )
            throw new DataError(
              'A record with the same uniqueidbyqueue already exists in this work queue.',
              400,
              'DuplicateRecord',
              { innerCode: '0x80040237' },
            );
          tableOf('workqueueitem').push(row);
        });
        return {
          workQueueItemId: row.workqueueitemid,
          ...(flag(argsOf(c).returnCreated) ? { workQueueItemRecord: { ...row } } : {}),
        };
      },
    },
    {
      name: 'Dequeue',
      kind: 'action',
      binding: 'entity',
      entity: 'workqueue',
      // Takes the next item of the queue, or of a FetchXML query that must name workqueueitem and this queue, and marks it
      // Processing. Order: priority ascending, then created first (FIFO). Delayed and expired items are skipped. An empty queue
      // answers 204. Guesses: the empty-queue status and the returned keys.
      signature: { params: [['request', 'Edm.String']], returns: 'mscrm.crmbaseentity' },
      handle: async (c) => {
        need(c, 'workqueue', 'Read');
        need(c, 'workqueueitem', 'Write');
        const queueId = c.target.id;
        const raw = argsOf(c).request;
        let request = {};
        if (raw) {
          try {
            request = JSON.parse(raw);
          } catch {
            throw invalid('Invalid argument.');
          }
        }
        if (!request || typeof request !== 'object' || Array.isArray(request)) throw invalid('Invalid argument.');
        let candidates = null;
        if (request.query != null) {
          checkDequeueQuery(String(request.query), queueId);
          const mapping = store.resolveMapping('workqueueitem');
          const path = `/api/data/${c.version}/${mapping.entitySet}`;
          const url = new URL(`${c.origin}${path}`);
          url.searchParams.set('fetchXml', String(request.query));
          const res = await api.records.handle({
            method: 'GET',
            route: parseDataverseRoute(path),
            url,
            origin: c.origin,
            version: c.version,
            prefer: parsePrefer(undefined),
            headers: {},
            user: c.user,
            caller: c.caller,
            identity: c.identity,
            requestId: c.requestId,
          });
          // The query orders the rows; the stored state decides which of them are Queued.
          candidates = (res.body?.value ?? []).map((row) => row[mapping.idColumn]);
        }
        let selected;
        await write(() => {
          // Selection and claiming share a transaction; a second worker rechecks state after the first commits.
          const at = api.clock();
          const pick = candidates
            ? candidates
                .map((id) => rowIn('workqueueitem', 'workqueueitemid', id))
                .find((row) => row && sameId(row.workqueueid, queueId) && eligible(row, at))
            : itemsOf(queueId)
                .filter((row) => eligible(row, at))
                .sort(fifo)[0];
          if (!pick) return;
          const user = c.user?.systemuserid ?? null;
          Object.assign(pick, {
            statecode: STATE_PROCESSING,
            statuscode: 1,
            processingstarttime: iso(at),
            processinguser: user ? { id: user, logical_name: 'systemuser' } : null,
          });
          selected = { ...pick };
        });
        return selected;
      },
    },
    {
      name: 'ClearWorkQueue',
      kind: 'action',
      binding: 'entity',
      entity: 'workqueue',
      // Removes every item of the queue. ponytail: always synchronous, so isDeletionGoingAsync is false.
      signature: { params: [], response: [['isDeletionGoingAsync', 'Edm.Boolean']] },
      handle: async (c) => {
        need(c, 'workqueueitem', 'Delete');
        const queueId = c.target.id;
        await write(() => {
          const rows = tableOf('workqueueitem');
          for (let i = rows.length - 1; i >= 0; i -= 1) if (sameId(rows[i].workqueueid, queueId)) rows.splice(i, 1);
        });
        return { isDeletionGoingAsync: false };
      },
    },
    {
      name: 'ComputeSlaWorkQueueItem',
      kind: 'action',
      binding: 'entity',
      entity: 'workqueue',
      // Recomputes the SLA status of the queue's items that are not Processed. The status boundaries are guesses.
      signature: { params: [] },
      handle: async (c) => {
        need(c, 'workqueueitem', 'Write');
        const queueId = c.target.id;
        const ttl = Number(c.target.row.defaultitemtimetoliveinminutes) || 0;
        const at = api.clock();
        await write(() => {
          for (const row of itemsOf(queueId))
            if (row.statecode !== STATE_PROCESSED) row.slastatus = slaOf(row, ttl, at);
        });
        return undefined;
      },
    },
    {
      name: 'AddWorkQueueItemProcessingHistoryEntry',
      kind: 'action',
      binding: 'entity',
      entity: 'workqueueitem',
      // Appends a processing attempt to the item's executioncontext, a system-managed list kept as JSON. An unreadable list
      // starts empty. The stored format of executioncontext is a guess.
      signature: { params: [['item', 'mscrm.crmbaseentity']] },
      handle: async (c) => {
        need(c, 'workqueueitem', 'Write');
        const itemId = c.target.id;
        const entry = argsOf(c).item ?? {};
        const at = api.clock();
        await write(() => {
          const row = rowIn('workqueueitem', 'workqueueitemid', itemId);
          let history = [];
          try {
            const parsed = JSON.parse(row.executioncontext || '[]');
            if (Array.isArray(parsed)) history = parsed;
          } catch {
            history = [];
          }
          row.executioncontext = JSON.stringify([...history, { ...entry, createdon: iso(at) }]);
        });
        return undefined;
      },
    },
  ];
}

export function install(api) {
  for (const op of operations(api)) registerAddon(api, op);
}

export const EXTENSION = { name: 'dataverse-addon-workqueues', install };
