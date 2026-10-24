// Outbox: captures outgoing email, Teams and Outlook messages as rows of the internal table paqvilo_outboxentry so a
// test or the /_sim/ panel can inspect them. Capture only: nothing here, or in anything it calls, sends network traffic.
// Attachment bytes go to an optional storage provider (put/delete); rows keep metadata and the storage key, never bytes.
import { randomUUID } from 'node:crypto';
import { DataError } from './data-error.mjs';
import { registerSettingParser } from './config-keys.mjs';
import { packCheck, registerPackExport } from './pack-exports.mjs';

export const OUTBOX_TABLE = 'paqvilo_outboxentry';
const ID = 'paqvilo_outboxentryid';
export const OUTBOX_MAPPING = Object.freeze({
  logicalName: OUTBOX_TABLE,
  idColumn: ID,
  dataverseOnly: true,
  // Internal capture state: no entity set, so neither the portal nor the Web API routes to it.
  fields: {
    [ID]: { dataverseType: 'uniqueidentifier' },
    channel: { dataverseType: 'nvarchar' },
    state: { dataverseType: 'nvarchar' },
    createdon: { dataverseType: 'datetime' },
  },
  relationships: {},
});
const CHANNELS = new Set(['email', 'teams', 'outlook', 'portal-email']);
const STATES = new Set(['queued', 'delivered', 'failed']);
const BODY_TYPES = new Set(['text', 'html']);
// ponytail: the outbox keeps the newest 1000 entries; older ones (and their stored attachment bytes) are dropped.
// Raise `retention` or page to disk if a scenario needs a longer history.
const DEFAULT_RETENTION = 1000;

export const outboxDescriptor = Object.freeze({
  name: 'outbox:local',
  version: '1',
  kind: 'provider',
  level: 'behaviour',
  fidelity: 'capture-only',
  operations: Object.freeze(['capture', 'list', 'get', 'markDelivered', 'markFailed', 'sweep']),
  requires: Object.freeze([]),
  principal: 'runtime',
  stateOwner: `store:tables.${OUTBOX_TABLE}`,
  lifecycle: 'in-process',
  notes: Object.freeze([
    'No network egress ever: entries are captured for inspection, never sent.',
    'Attachment bytes live in the storage provider under a key; rows never hold bytes.',
  ]),
});

const invalid = (message) => new DataError(message, 400, 'InvalidRequest');
const text = (value, label, max = 1_000_000) => {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length > max)
    throw invalid(`${label} must be text of at most ${max} characters`);
  return value;
};
function addresses(value, label) {
  const list = value == null ? [] : Array.isArray(value) ? value : [value];
  if (list.length > 500 || list.some((item) => typeof item !== 'string' || !item.trim() || item.length > 320))
    throw invalid(`${label} must be addresses`);
  return [...list];
}
const bytesOf = (content) =>
  Buffer.isBuffer(content) || content instanceof Uint8Array
    ? Buffer.from(content)
    : typeof content === 'string'
      ? Buffer.from(content, 'base64')
      : null;

export function createOutbox({
  store,
  clock = store?.clock,
  ids = store?.ids,
  storage = null,
  retention = DEFAULT_RETENTION,
} = {}) {
  if (!store || typeof store.transact !== 'function') throw new TypeError('createOutbox requires a DataStore');
  if (storage && (typeof storage.put !== 'function' || typeof storage.delete !== 'function'))
    throw new TypeError('Outbox storage must provide put and delete');
  const now = () => +(clock?.now?.() ?? Date.now());
  const uuid = () => ids?.uuid?.() ?? randomUUID();
  const rowsOf = () => store.state.tables?.[OUTBOX_TABLE] ?? [];
  // The organization composes the table at startup (dataverse-organization.mjs INTERNAL_TABLES); this seed covers a bare store.
  const seed = () => {
    store.state.mappings[OUTBOX_TABLE] ??= structuredClone(OUTBOX_MAPPING);
    return (store.state.tables[OUTBOX_TABLE] ??= []);
  };
  const write = (fn, nested) => store.transact(() => fn(seed()), { incremental: true, nested });
  const view = ({ [ID]: id, ...rest }) => structuredClone({ id, ...rest });
  const dropBytes = async (keys) => {
    for (const key of keys) await storage?.delete(key).catch(() => {});
  };
  const keysOf = (row) => row.attachments.map((attachment) => attachment.key).filter(Boolean);
  // Byte deletes that a nested capture deferred. Kept in state.simulator, a section the row transaction restores on
  // rollback, so a rolled-back capture takes its deferred deletes with it.
  const pending = () => ((store.state.simulator ??= {}).outboxPendingDeletes ??= []);
  // Keys of bytes put by a capture whose row is not written yet: sweep() must not reclaim them.
  // ponytail: tracked per outbox instance; two outboxes on one storage would each need to share this set.
  const inFlight = new Set();

  // Runs the deferred deletes: the list is taken in its own non-nested write, then the bytes go outside any transaction.
  async function drainPending() {
    if (!store.state.simulator?.outboxPendingDeletes?.length) return 0;
    const keys = await write(() => pending().splice(0), false);
    await dropBytes(keys);
    return keys.length;
  }

  async function transition(entryId, to, values) {
    const result = await write((rows) => {
      const index = rows.findIndex((row) => row[ID] === entryId);
      if (index < 0) throw new DataError(`Outbox entry ${String(entryId).slice(0, 64)} was not found`, 404, 'NotFound');
      if (rows[index].state !== 'queued')
        throw new DataError(
          `Outbox entry is ${rows[index].state}; only a queued entry can become ${to}`,
          409,
          'InvalidStateTransition',
        );
      store.mutateRow(OUTBOX_TABLE, rows, index, { state: to, ...values });
      return view(rows[index]);
    });
    await drainPending();
    return result;
  }

  return {
    descriptor: outboxDescriptor,
    /** Capture one message. Pass `{ nested: true }` to join the caller's transaction so a rolled-back write drops it. */
    async capture(entry = {}, { nested = false } = {}) {
      if (!CHANNELS.has(entry.channel)) throw invalid('channel must be email, teams, outlook or portal-email');
      const state = entry.state ?? 'queued';
      if (!STATES.has(state)) throw invalid('state must be queued, delivered or failed');
      const bodyType = entry.bodyType ?? 'text';
      if (!BODY_TYPES.has(bodyType)) throw invalid('bodyType must be text or html');
      if (entry.source != null && (typeof entry.source !== 'object' || typeof entry.source.kind !== 'string'))
        throw invalid('source must be { kind, id }');
      if (entry.attachments != null && (!Array.isArray(entry.attachments) || entry.attachments.length > 100))
        throw invalid('attachments must be an array of at most 100 items');
      const entryId = uuid(),
        at = now(),
        diagnostics = [],
        stored = [],
        flight = [];
      const row = {
        [ID]: entryId,
        channel: entry.channel,
        from: text(entry.from, 'from', 320),
        to: addresses(entry.to, 'to'),
        cc: addresses(entry.cc, 'cc'),
        bcc: addresses(entry.bcc, 'bcc'),
        subject: text(entry.subject, 'subject', 4000),
        body: text(entry.body, 'body'),
        bodyType,
        attachments: [],
        correlationId: text(entry.correlationId, 'correlationId', 200),
        source: entry.source ? { kind: entry.source.kind, id: entry.source.id ?? null } : null,
        createdOn: new Date(at).toISOString(),
        state,
        diagnostics,
      };
      try {
        for (const [index, attachment] of (entry.attachments ?? []).entries()) {
          if (!attachment || typeof attachment !== 'object') throw invalid('Each attachment must be an object');
          const bytes = attachment.content == null ? null : bytesOf(attachment.content);
          if (attachment.content != null && !bytes) throw invalid('Attachment content must be bytes or base64 text');
          const meta = {
            name: text(attachment.name, 'Attachment name', 260) ?? `attachment-${index + 1}`,
            contentType: text(attachment.contentType, 'Attachment contentType', 200) ?? 'application/octet-stream',
            size: bytes?.length ?? (Number.isSafeInteger(attachment.size) ? attachment.size : null),
            key: null,
          };
          if (bytes && storage) {
            const candidate = `outbox/${entryId.toLowerCase()}/${index + 1}`;
            flight.push(candidate);
            inFlight.add(candidate);
            const put = await storage.put(candidate, bytes, { contentType: meta.contentType });
            meta.key = put?.key ?? candidate;
            flight.push(meta.key);
            inFlight.add(meta.key);
            stored.push(meta.key);
          } else if (bytes)
            diagnostics.push({
              code: 'OUTBOX_ATTACHMENT_NOT_STORED',
              severity: 'warning',
              message: `Attachment ${index + 1} kept its metadata only: no storage provider is configured for outbox bytes.`,
            });
          row.attachments.push(meta);
        }
        // A nested capture may be rolled back by its caller, so it must not delete bytes yet: its retention drops are
        // journaled in pending() (rolled back with the rows) and deleted by the next non-nested outbox write or sweep().
        // ponytail: deferred bytes wait for that next write or sweep(); an idle outbox holds them until then.
        const dropped = [];
        const result = await write((rows) => {
          store.insertRow(OUTBOX_TABLE, rows, row);
          while (rows.length > retention) {
            dropped.push(...keysOf(rows[0]));
            store.removeRow(OUTBOX_TABLE, rows, 0);
          }
          if (nested && dropped.length) pending().push(...dropped);
          return view(row);
        }, nested);
        if (!nested) {
          await dropBytes(dropped);
          await drainPending();
        }
        return result;
      } catch (error) {
        await dropBytes(stored);
        throw error;
      } finally {
        for (const key of flight) inFlight.delete(key);
      }
    },
    list({ correlationId, channel, since } = {}) {
      const after =
        since == null
          ? null
          : since instanceof Date
            ? since.getTime()
            : typeof since === 'number'
              ? since
              : Date.parse(since);
      return rowsOf()
        .filter(
          (row) =>
            (correlationId == null || row.correlationId === correlationId) &&
            (channel == null || row.channel === channel) &&
            (after == null || Date.parse(row.createdOn) >= after),
        )
        .map(view);
    },
    get(entryId) {
      const row = rowsOf().find((candidate) => candidate[ID] === entryId);
      return row ? view(row) : null;
    },
    markDelivered(entryId) {
      return transition(entryId, 'delivered', { deliveredOn: new Date(now()).toISOString() });
    },
    markFailed(entryId, reason) {
      return transition(entryId, 'failed', {
        failedOn: new Date(now()).toISOString(),
        failureReason: text(reason, 'reason', 4000) ?? 'Failed',
      });
    },
    /** Drains deferred deletes, then deletes `outbox/` objects that no entry row references (bytes of rolled-back captures).
     * Objects are listed first and judged afterwards in a transaction (joining the caller's when one is open), so a capture
     * that committed while the list ran is referenced; a delete is conditional on the listed ETag, so bytes put again under a
     * listed key are kept (the pattern of the storage-routing sweep). */
    async sweep() {
      if (!storage?.list) return { deleted: 0, pending: 0 };
      const drained = await drainPending();
      const listed = [];
      let continuation;
      do {
        const page = await storage.list('outbox/', { continuation });
        for (const object of Array.isArray(page) ? page : (page?.items ?? []))
          listed.push({ key: object.key, etag: object.etag ?? '*' });
        continuation = page?.continuation ?? null;
      } while (continuation);
      const stale = await store.transact(
        () => {
          const referenced = new Set(rowsOf().flatMap(keysOf));
          return listed.filter((object) => !referenced.has(object.key) && !inFlight.has(object.key));
        },
        { nested: true, skipSaveIfUnchanged: true, lazyReadSnapshot: true, cloneResult: false },
      );
      let deleted = 0;
      for (const { key, etag } of stale) {
        try {
          if ((await storage.delete(key, { ifMatch: etag })) !== false) deleted += 1;
        } catch {
          /* PreconditionFailed: put again since listing, so kept; otherwise gone or in use, and the next sweep retries */
        }
      }
      return { deleted, pending: drained };
    },
  };
}

/**
 * Resolve with the first outbox entry matching `predicate`, polling every 20 ms of real time. The timeout elapses on
 * whichever runs out first: real time, or the supplied clock (so an advanced fixed clock also ends the wait).
 */
export async function waitForOutbox(outbox, predicate, { timeoutMs = 5000, clock } = {}) {
  const startReal = Date.now(),
    startClock = clock ? +clock.now() : null;
  for (;;) {
    const match = outbox.list().find(predicate);
    if (match) return match;
    const elapsed = Math.max(Date.now() - startReal, clock ? +clock.now() - startClock : 0);
    if (elapsed >= timeoutMs)
      throw new DataError(`No outbox entry matched within ${timeoutMs} ms`, 408, 'OutboxTimeout');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const isPlain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
/** Validates `providers.outbox`: { kind: 'local' | 'pack:<id>' = 'local', retention?: 1..1000000 }. */
export function outboxSettings(value, label = 'providers.outbox') {
  if (value === undefined) value = {};
  if (!isPlain(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value))
    if (!['kind', 'retention'].includes(key))
      throw new Error(`Unknown ${label} key '${key}'; expected kind or retention`);
  const kind = value.kind ?? 'local';
  if (typeof kind !== 'string' || (kind !== 'local' && !/^pack:[a-z0-9][a-z0-9._-]*$/.test(kind)))
    throw new Error(`${label}.kind must be local or pack:<id>`);
  if (
    value.retention !== undefined &&
    (!Number.isInteger(value.retention) || value.retention < 1 || value.retention > 1_000_000)
  )
    throw new Error(`${label}.retention must be an integer from 1 through 1000000`);
  return { kind, ...(value.retention !== undefined ? { retention: value.retention } : {}) };
}

/** Pack `outboxHandlers`: handler names mapping to functions. */
export function validateOutboxHandlers(map) {
  if (!isPlain(map) || Object.values(map).some((handler) => typeof handler !== 'function'))
    throw new TypeError('outboxHandlers must map names to functions');
}
registerPackExport('outboxHandlers', { check: packCheck(validateOutboxHandlers) });
registerSettingParser('providers.outbox', outboxSettings);
