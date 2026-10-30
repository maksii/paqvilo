// Local message bus: queues with peek-lock, redelivery, dead-letter and scheduled messages, persisted as rows of the
// internal table paqvilo_queuemessage so restart, snapshot and reset follow the store's persistence mode.
// The Service Bus emulator bus (createServiceBusEmulatorBus) speaks AMQP 1.0 to the emulator on loopback through the core
// client amqp-client.mjs; serviceBusEmulatorPreflight probes its health endpoint. Nothing here contacts a non-loopback host.
// Callers already inside a store transaction pass `{ nested: true }` so send, receive, complete, abandon and deadLetter join it.
import { randomUUID } from 'node:crypto';
import { DataError } from './data-error.mjs';
import { isLoopbackUrl, loopbackFetch } from './dataverse-webhooks.mjs';
import { ProviderError } from './storage-provider.mjs';
import { CODE, connectAmqp, decodeMessage, described, encodeMessage, sym } from './amqp-client.mjs';
import { registerSettingParser } from './config-keys.mjs';
import { packCheck, registerPackExport } from './pack-exports.mjs';
import { parseExactJson, stringifyExactJson } from './exact-numeric.mjs';

export const QUEUE_MESSAGE_TABLE = 'paqvilo_queuemessage';
export const DEAD_LETTER_SUFFIX = '/$deadletterqueue';
const ID = 'paqvilo_queuemessageid';
export const QUEUE_MESSAGE_MAPPING = Object.freeze({
  logicalName: QUEUE_MESSAGE_TABLE,
  idColumn: ID,
  dataverseOnly: true,
  // Internal bus state: no entity set, so neither the portal nor the Web API routes to it.
  fields: {
    [ID]: { dataverseType: 'uniqueidentifier' },
    entity: { dataverseType: 'nvarchar' },
    messageid: { dataverseType: 'nvarchar' },
    sequencenumber: { dataverseType: 'bigint' },
    enqueuedon: { dataverseType: 'datetime' },
    visibleat: { dataverseType: 'bigint' },
    deliverycount: { dataverseType: 'int' },
    locktoken: { dataverseType: 'nvarchar' },
    lockeduntil: { dataverseType: 'bigint' },
  },
  relationships: {},
});
const OPERATIONS = Object.freeze(['send', 'receive', 'complete', 'abandon', 'deadLetter', 'peek']);
const ENTITY = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,259}(?:\/[A-Za-z0-9._~-]{1,260}){0,2}$/;
const DEFAULT_RETRY = Object.freeze({ maxAttempts: 1, backoffMs: Object.freeze([]), deadLetter: true });
const DEFAULT_LOCK_MS = 60_000; // Service Bus default LockDuration (1 minute).

export const localMessageBusDescriptor = Object.freeze({
  name: 'message-bus:local',
  version: '1',
  kind: 'provider',
  level: 'behaviour',
  operations: OPERATIONS,
  requires: Object.freeze([]),
  principal: 'runtime',
  stateOwner: `store:tables.${QUEUE_MESSAGE_TABLE}`,
  lifecycle: 'in-process',
  capabilities: Object.freeze({
    ordering: 'fifo-per-entity',
    redelivery: true,
    deadLetter: true,
    sessions: false,
    scheduled: true,
  }),
  fidelity: Object.freeze({
    notes: Object.freeze([
      'Queues only: a topic is one entity with a single implicit subscription (no rules or filters).',
      'Duplicate detection by messageId covers messages the bus still holds (active, locked, scheduled, dead-lettered).',
      'No sessions, transfers, auto-forwarding or message time-to-live.',
    ]),
  }),
});

const lockLost = () =>
  new DataError(
    'The lock supplied is invalid. Either the lock expired, or the message has already been removed from the queue.',
    410,
    'MessageLockLost',
  );
function entityName(entity, { deadLetter = false } = {}) {
  const base =
    deadLetter && typeof entity === 'string' && entity.endsWith(DEAD_LETTER_SUFFIX)
      ? entity.slice(0, -DEAD_LETTER_SUFFIX.length)
      : entity;
  if (typeof base !== 'string' || !ENTITY.test(base))
    throw new DataError(`Invalid message entity '${String(entity).slice(0, 80)}'`, 400, 'InvalidEntity');
  return entity;
}
const time = (value) => {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) throw new DataError('scheduledEnqueueTime must be a date', 400, 'InvalidRequest');
  return ms;
};
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
function json(value, label, { exact = true } = {}) {
  if (value === undefined) throw new DataError(`${label} must be JSON`, 400, 'InvalidRequest');
  try {
    return exact
      ? parseExactJson(stringifyExactJson(value), { allowFiniteDouble: true })
      : JSON.parse(JSON.stringify(value));
  } catch {
    throw new DataError(`${label} must be JSON`, 400, 'InvalidRequest');
  }
}
/** The send checks every bus applies: entity name, JSON body, plain-value properties, messageId, scheduled time. */
function messageInput(entity, body, { messageId, properties = {}, scheduledEnqueueTime } = {}) {
  entityName(entity);
  const value = json(body, 'Message body');
  if (
    !properties ||
    typeof properties !== 'object' ||
    Array.isArray(properties) ||
    Object.values(properties).some((item) => item !== null && typeof item === 'object')
  )
    throw new DataError('Message properties must be an object of plain values', 400, 'InvalidRequest');
  if (messageId !== undefined && (typeof messageId !== 'string' || !messageId || messageId.length > 128))
    throw new DataError('messageId must be 1-128 characters', 400, 'InvalidRequest');
  return {
    value,
    properties: json(properties, 'Message properties', { exact: false }),
    messageId,
    scheduled: time(scheduledEnqueueTime),
  };
}
/** The receive checks every bus applies. */
function receiveInput(entity, mode, maxMessages) {
  entityName(entity, { deadLetter: true });
  if (!['peekLock', 'receiveAndDelete'].includes(mode))
    throw new DataError('mode must be peekLock or receiveAndDelete', 400, 'InvalidRequest');
  if (!Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > 1000)
    throw new DataError('maxMessages must be 1-1000', 400, 'InvalidRequest');
}
function view(row, now, { lock = true } = {}) {
  const locked = row.locktoken != null && row.lockeduntil > now;
  return {
    entity: row.entity,
    messageId: row.messageid,
    body: row.body,
    properties: row.properties,
    sequenceNumber: row.sequencenumber,
    enqueuedTime: row.enqueuedon,
    scheduledEnqueueTime: iso(row.scheduledat),
    deliveryCount: row.deliverycount,
    lockToken: lock && locked ? row.locktoken : null,
    lockedUntil: locked ? iso(row.lockeduntil) : null,
    state: row.entity.endsWith(DEAD_LETTER_SUFFIX)
      ? 'deadLettered'
      : locked
        ? 'locked'
        : row.visibleat > now
          ? 'scheduled'
          : 'active',
    deadLetterReason: row.deadletterreason ?? null,
    deadLetterDescription: row.deadletterdescription ?? null,
  };
}

/**
 * A FIFO-per-entity queue bus over a DataStore. Every mutation is one incremental store transaction (journaled undo);
 * pass `{ nested: true }` to join a transaction the caller already runs (a sync step that must roll back with the write).
 */
export function createLocalMessageBus({
  store,
  clock = store?.clock,
  ids = store?.ids,
  retry = DEFAULT_RETRY,
  lockDurationMs = DEFAULT_LOCK_MS,
  id = 'local',
} = {}) {
  if (!store || typeof store.transact !== 'function') throw new TypeError('createLocalMessageBus requires a DataStore');
  const now = () => +(clock?.now?.() ?? Date.now());
  const uuid = () => ids?.uuid?.() ?? randomUUID();
  const policy = { ...DEFAULT_RETRY, ...retry };
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1)
    throw new TypeError('retry.maxAttempts must be a positive integer');
  const backoff = (deliveries) =>
    policy.backoffMs.length ? (policy.backoffMs[Math.min(deliveries, policy.backoffMs.length) - 1] ?? 0) : 0;
  const rowsOf = () => store.state.tables?.[QUEUE_MESSAGE_TABLE] ?? [];
  // The organization composes the table at startup (dataverse-organization.mjs INTERNAL_TABLES); this insert-only seed
  // inside each write covers a bus over a bare store and a replaced state.
  const seed = () => {
    store.state.mappings[QUEUE_MESSAGE_TABLE] ??= structuredClone(QUEUE_MESSAGE_MAPPING);
    return (store.state.tables[QUEUE_MESSAGE_TABLE] ??= []);
  };
  const write = (fn, nested) => store.transact(() => fn(seed()), { incremental: true, nested });
  const indexOf = (rows, rowId) => rows.findIndex((row) => row[ID] === rowId);
  // ponytail: every operation scans the table (O(messages)); index by entity if queues grow past a few thousand rows.
  const ordered = (rows, entity) =>
    rows.filter((row) => row.entity === entity).sort((a, b) => a.sequencenumber - b.sequencenumber);

  function moveToDeadLetter(rows, row, reason, description, explicit = false) {
    const index = indexOf(rows, row[ID]);
    if (!policy.deadLetter && !explicit) return store.removeRow(QUEUE_MESSAGE_TABLE, rows, index);
    store.mutateRow(QUEUE_MESSAGE_TABLE, rows, index, {
      entity: row.entity + DEAD_LETTER_SUFFIX,
      locktoken: null,
      lockeduntil: null,
      visibleat: 0,
      deadletterreason: reason ?? 'DeadLettered',
      deadletterdescription: description ?? null,
    });
  }
  // A released delivery (abandon or lock expiry) dead-letters once maxAttempts deliveries were made; otherwise it returns
  // to the queue after the backoff for that attempt. Dead-letter queues never dead-letter again.
  function release(rows, row, at, reason) {
    if (!row.entity.endsWith(DEAD_LETTER_SUFFIX) && row.deliverycount >= policy.maxAttempts)
      return moveToDeadLetter(
        rows,
        row,
        'MaxDeliveryCountExceeded',
        reason ?? `Delivery count ${row.deliverycount} reached maxAttempts ${policy.maxAttempts}`,
      );
    store.mutateRow(QUEUE_MESSAGE_TABLE, rows, indexOf(rows, row[ID]), {
      locktoken: null,
      lockeduntil: null,
      visibleat: at + backoff(row.deliverycount),
    });
  }
  function locked(rows, lockToken, at) {
    if (typeof lockToken !== 'string') throw lockLost();
    const row = rows.find((candidate) => candidate.locktoken === lockToken);
    if (!row || !(row.lockeduntil > at)) throw lockLost();
    return row;
  }

  const bus = {
    id,
    descriptor: localMessageBusDescriptor,
    retry: policy,
    async send(entity, body, { nested = false, ...options } = {}) {
      const { value, properties, messageId, scheduled } = messageInput(entity, body, options);
      return write((rows) => {
        const at = now(),
          key = messageId ?? uuid();
        const existing = rows.find(
          (row) => (row.entity === entity || row.entity === entity + DEAD_LETTER_SUFFIX) && row.messageid === key,
        );
        if (existing) return { ...view(existing, at, { lock: false }), duplicate: true };
        const row = {
          [ID]: uuid(),
          entity,
          messageid: key,
          body: value,
          properties,
          sequencenumber: rows.reduce((max, item) => Math.max(max, item.sequencenumber), 0) + 1,
          enqueuedon: iso(at),
          scheduledat: scheduled,
          visibleat: scheduled ?? at,
          deliverycount: 0,
          locktoken: null,
          lockeduntil: null,
        };
        store.insertRow(QUEUE_MESSAGE_TABLE, rows, row);
        return { ...view(row, at, { lock: false }), duplicate: false };
      }, nested);
    },
    async receive(entity, { mode = 'peekLock', maxMessages = 1, waitMs = 0, nested = false } = {}) {
      receiveInput(entity, mode, maxMessages);
      // A nested receive shares the caller's transaction, so no other writer can send while it polls: the wait could only time out.
      if (nested && (Number(waitMs) || 0) > 0)
        throw new DataError('waitMs cannot be combined with nested', 400, 'InvalidRequest');
      const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
      for (;;) {
        const received = await write((rows) => {
          const at = now();
          for (const row of ordered(rows, entity))
            if (row.locktoken != null && row.lockeduntil <= at) release(rows, row, at, 'Lock expired');
          const due = ordered(rows, entity)
            .filter((row) => row.locktoken == null && row.visibleat <= at)
            .slice(0, maxMessages);
          return due.map((row) => {
            const index = indexOf(rows, row[ID]);
            const values = { deliverycount: row.deliverycount + 1 };
            if (mode === 'receiveAndDelete') {
              store.removeRow(QUEUE_MESSAGE_TABLE, rows, index);
              return view({ ...row, ...values }, at, { lock: false });
            }
            Object.assign(values, { locktoken: uuid(), lockeduntil: at + lockDurationMs });
            store.mutateRow(QUEUE_MESSAGE_TABLE, rows, index, values);
            return view(rows[index], at);
          });
        }, nested);
        // ponytail: a waiting receive polls every 20 ms of real time; add send-side wake-ups if receivers wait on hot paths.
        if (received.length || Date.now() >= deadline) return received;
        await new Promise((resolve) => setTimeout(resolve, Math.min(20, deadline - Date.now())));
      }
    },
    complete(lockToken, { nested = false } = {}) {
      return write((rows) => {
        const row = locked(rows, lockToken, now());
        store.removeRow(QUEUE_MESSAGE_TABLE, rows, indexOf(rows, row[ID]));
        return true;
      }, nested);
    },
    abandon(lockToken, { reason, nested = false } = {}) {
      return write((rows) => {
        const at = now();
        release(rows, locked(rows, lockToken, at), at, reason);
        return true;
      }, nested);
    },
    deadLetter(lockToken, { reason, description, nested = false } = {}) {
      return write((rows) => {
        const row = locked(rows, lockToken, now());
        if (row.entity.endsWith(DEAD_LETTER_SUFFIX))
          throw new DataError('A dead-lettered message cannot be dead-lettered again', 400, 'InvalidOperation');
        moveToDeadLetter(rows, row, reason, description, true); // an explicit dead-letter always lands in the sub-queue
        return true;
      }, nested);
    },
    peek(entity, { max = 10 } = {}) {
      entityName(entity, { deadLetter: true });
      const at = now();
      return structuredClone(
        ordered(rowsOf(), entity)
          .slice(0, Math.max(0, max))
          .map((row) => view(row, at, { lock: false })),
      );
    },
    stats(entity) {
      entityName(entity);
      const at = now(),
        counts = { active: 0, locked: 0, scheduled: 0, deadLettered: 0 };
      for (const row of rowsOf())
        if (row.entity === entity || row.entity === entity + DEAD_LETTER_SUFFIX) counts[view(row, at).state] += 1;
      return counts;
    },
  };
  return bus;
}

// ---- Service Bus emulator: AMQP 1.0 transport (amqp-client.mjs)
const EMULATOR_SOURCES = Object.freeze([
  'https://learn.microsoft.com/azure/service-bus-messaging/overview-emulator',
  'https://learn.microsoft.com/azure/service-bus-messaging/test-locally-with-service-bus-emulator',
  'https://learn.microsoft.com/azure/service-bus-messaging/service-bus-emulator-whats-new',
  'https://learn.microsoft.com/azure/service-bus-messaging/service-bus-amqp-protocol-guide',
]);
const diagnostic = (code, message, severity = 'error') => ({ code, severity, message });
const EMULATOR_AMQP_PORT = 5672; // Service Bus emulator default AMQP port.
const EMULATOR_MAX_MESSAGE = 256 * 1024; // Emulator quota: message size 256 KB, not configurable.

/**
 * The one reading of an emulator connection string: { host, bracketed, keyName, key } or { error: { code, message } }.
 * Only Endpoint=sb://<loopback host> with UseDevelopmentEmulator=true is accepted; nothing is contacted here.
 */
function emulatorConnection(connectionString) {
  const refuse = (code, message) => ({ error: { code, message } });
  if (typeof connectionString !== 'string' || !connectionString.trim())
    return refuse(
      'SERVICEBUS_EMULATOR_CONNECTION_MISSING',
      'No emulator connection string was supplied (declare it as env:NAME).',
    );
  const parts = new Map();
  for (const part of connectionString.split(';')) {
    const at = part.indexOf('=');
    if (at > 0) parts.set(part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).trim());
  }
  if (String(parts.get('usedevelopmentemulator')).toLowerCase() !== 'true')
    return refuse(
      'SERVICEBUS_EMULATOR_NOT_DEVELOPMENT',
      'The connection string must contain UseDevelopmentEmulator=true; Paqvilo never contacts a cloud namespace.',
    );
  let host;
  try {
    const url = new URL(parts.get('endpoint'));
    if (url.protocol !== 'sb:') throw new Error();
    host = url.hostname;
  } catch {
    return refuse('SERVICEBUS_EMULATOR_ENDPOINT_INVALID', 'The connection string Endpoint must be sb://<host>.');
  }
  const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  if (!isLoopbackUrl(`http://${bracketed}/`))
    return refuse(
      'SERVICEBUS_EMULATOR_NOT_LOOPBACK',
      'The emulator endpoint must be localhost, 127.0.0.0/8 or ::1; other hosts are never contacted.',
    );
  return {
    host: bracketed.replace(/^\[|\]$/g, ''),
    bracketed,
    keyName: parts.get('sharedaccesskeyname') ?? '',
    key: parts.get('sharedaccesskey') ?? '',
  };
}

/** Probe a Service Bus emulator's health endpoint on loopback. Never throws; the result never carries the connection string or its key. */
export async function serviceBusEmulatorPreflight({ connectionString, healthPort = 5300, timeoutMs = 2000 } = {}) {
  const result = {
    name: 'message-bus:servicebus-emulator',
    kind: 'servicebus-emulator',
    level: 'behaviour',
    adapter: 'core-amqp',
    ready: false,
    reachable: false,
    endpoint: null,
    diagnostics: [],
  };
  const fail = (code, message) => {
    result.diagnostics.push(diagnostic(code, message));
    return result;
  };
  const target = emulatorConnection(connectionString);
  if (target.error && target.error.code !== 'SERVICEBUS_EMULATOR_NOT_LOOPBACK')
    return fail(target.error.code, target.error.message);
  if (!Number.isInteger(healthPort) || healthPort < 1 || healthPort > 65535)
    return fail('SERVICEBUS_EMULATOR_PORT_INVALID', 'healthPort must be an integer from 1 to 65535.');
  if (target.error) return fail(target.error.code, target.error.message);
  const probe = `http://${target.bracketed}:${healthPort}/health`;
  result.endpoint = `sb://${target.bracketed}`;
  try {
    const response = await loopbackFetch(probe, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
    await response.body?.cancel();
    result.reachable = true;
    result.ready = response.ok;
    if (!response.ok)
      result.diagnostics.push(
        diagnostic('SERVICEBUS_EMULATOR_UNHEALTHY', `The emulator health check answered ${response.status}.`),
      );
  } catch {
    result.diagnostics.push(
      diagnostic(
        'SERVICEBUS_EMULATOR_UNREACHABLE',
        `No emulator health endpoint answered on loopback port ${Number(healthPort)}.`,
      ),
    );
  }
  return result;
}

export const serviceBusEmulatorDescriptor = Object.freeze({
  name: 'message-bus:servicebus-emulator',
  version: '1',
  kind: 'servicebus-emulator',
  level: 'behaviour',
  operations: Object.freeze(['send', 'receive', 'complete', 'abandon', 'deadLetter']),
  requires: Object.freeze(['external-process:servicebus-emulator', 'secret:connectionString']),
  principal: 'connection',
  stateOwner: 'external:servicebus-emulator',
  lifecycle: 'external-process',
  capabilities: Object.freeze({
    ordering: 'fifo-per-entity',
    redelivery: true,
    deadLetter: true,
    sessions: false,
    scheduled: true,
  }),
  fidelity: Object.freeze({
    notes: Object.freeze([
      'Core AMQP 1.0 client over plain TCP on loopback with SASL PLAIN (shared access key name and key); no dependency, no CBS.',
      'Queues, topics and subscriptions (<topic>/subscriptions/<name>) and their $deadletterqueue sub-queues; entities come from the emulator config.json.',
      'Peek-lock is an unsettled transfer settled by complete (accepted), abandon (modified, delivery-failed) or deadLetter (rejected); receive-and-delete is pre-settled.',
      'No peek, sessions, deferral, lock renewal or duplicate reporting: those are Service Bus request-response operations outside this client.',
      'nested: a send cannot join a store transaction; the message is sent when called and a rolled-back operation does not withdraw it.',
      'A synchronous service endpoint step sends inside its operation: awaited on HTTP-driven writes, and through the worker-thread synchronous I/O bridge (its own connection; the worker reads env:NAME) on a plug-in SDK call or a flow Dataverse action.',
      'Runs as Docker containers (emulator plus SQL Server Linux); Paqvilo never starts it.',
      'AMQP over TCP only: no AMQP WebSockets and no JMS.',
      'Partitioned entities are not supported; entities come from config.json at container start.',
      'Data and entities are lost when the container restarts; Paqvilo job rows stay authoritative.',
      'Health check at http://localhost:5300/health; connection strings carry UseDevelopmentEmulator=true.',
      'One namespace, 256 KB messages, 1 hour maximum message time to live.',
    ]),
    sources: EMULATOR_SOURCES,
  }),
  preflight: serviceBusEmulatorPreflight,
});

const stamp = (value) => (value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null);
// Assumed: Service Bus SDKs read the 16-byte delivery-tag as the lock token in .NET Guid byte order (first three groups little-endian).
function lockTokenOf(tag) {
  const raw = Buffer.from(tag ?? []);
  if (raw.length !== 16) return raw.toString('hex');
  const hex = (start, end, reverse) => {
    const part = Buffer.from(raw.subarray(start, end));
    return (reverse ? part.reverse() : part).toString('hex');
  };
  return `${hex(0, 4, true)}-${hex(4, 6, true)}-${hex(6, 8, true)}-${hex(8, 10)}-${hex(10, 16)}`;
}

/**
 * A bus over the Service Bus emulator (kind servicebus-emulator), the same send/receive/complete/abandon/deadLetter contract as
 * the local bus. settings: the validated providers.messaging entry ({ connectionString: 'env:NAME', amqpPort? }); entities: the
 * entity names configuration maps to this provider (preflight attaches a link to each). The connection string is read from env
 * when a connection opens; its key goes to SASL only and never into state, results or errors. One connection, opened lazily,
 * reopened after a failure; links are cached per entity. Every wait is bounded by timeoutMs.
 */
export function createServiceBusEmulatorBus({
  id = 'servicebus-emulator',
  settings = {},
  entities = [],
  env = process.env,
  timeoutMs = 5000,
  now = Date.now,
} = {}) {
  const variable = /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(settings.connectionString ?? '')?.[1];
  if (!variable) throw new TypeError('createServiceBusEmulatorBus requires settings.connectionString as env:NAME');
  const port = settings.amqpPort ?? EMULATOR_AMQP_PORT;
  const names = [...new Set(entities)];
  names.forEach((entity) => entityName(entity));
  const senders = new Map(),
    receivers = new Map(),
    locks = new Map();
  let session = null;

  function open(source, ms, signal = null) {
    const target = emulatorConnection(source?.[variable]);
    if (target.error) {
      const message =
        target.error.code === 'SERVICEBUS_EMULATOR_CONNECTION_MISSING'
          ? `Environment variable ${variable} is not set.`
          : `${target.error.message} (${variable})`;
      return Promise.reject(new ProviderError('Unavailable', message, { provider: id, diagnostic: target.error.code }));
    }
    return connectAmqp({
      host: target.host,
      port,
      hostname: target.host,
      timeoutMs: ms,
      signal,
      provider: id,
      credentials: () => ({ user: target.keyName, password: target.key }),
    });
  }
  // The live connection, opened on first use and again after it failed (Service Bus has no link recovery: locks die with it).
  async function current() {
    const seen = session;
    if (seen) {
      const connection = await seen.catch(() => null);
      if (connection && !connection.failed) return connection;
      if (session !== seen) return current();
    }
    senders.clear();
    receivers.clear();
    locks.clear();
    session = open(env, timeoutMs);
    session.catch(() => {});
    return session;
  }
  async function linkOf(cache, key, attach) {
    const connection = await current();
    let pending = cache.get(key);
    const existing = pending ? await pending.catch(() => null) : null;
    if (existing && !existing.failure) return { connection, link: existing };
    pending = attach(connection);
    cache.set(key, pending);
    try {
      return { connection, link: await pending };
    } catch (error) {
      cache.delete(key);
      throw error;
    }
  }

  function view(entity, mode, connection, link, delivery) {
    const message = decodeMessage(delivery.payload);
    const annotations = message.annotations,
      { DeadLetterReason = null, DeadLetterErrorDescription = null, ...properties } = message.applicationProperties;
    const lockedUntil = annotations['x-opt-locked-until'] instanceof Date ? annotations['x-opt-locked-until'] : null;
    const lockToken = mode === 'peekLock' && !delivery.settled ? lockTokenOf(delivery.tag) : null;
    if (lockToken) locks.set(lockToken, { connection, link, deliveryId: delivery.deliveryId, lockedUntil, entity });
    const contentType = message.properties[6] ?? null;
    let body = message.body;
    if (Buffer.isBuffer(body) && contentType === 'application/json') {
      try {
        body = parseExactJson(body.toString('utf8'), { allowFiniteDouble: true });
      } catch {
        /* kept as bytes */
      }
    }
    return {
      entity,
      messageId: message.properties[0] == null ? null : String(message.properties[0]),
      body,
      properties,
      sequenceNumber: annotations['x-opt-sequence-number'] ?? null,
      enqueuedTime: stamp(annotations['x-opt-enqueued-time']),
      scheduledEnqueueTime: stamp(annotations['x-opt-scheduled-enqueue-time']),
      // Header delivery-count counts earlier unsuccessful deliveries (messaging 3.2.1); the local bus counts this one too.
      deliveryCount: (Number(message.header[4]) || 0) + 1,
      lockToken,
      lockedUntil: lockToken ? stamp(lockedUntil) : null,
      state: entity.endsWith(DEAD_LETTER_SUFFIX) ? 'deadLettered' : lockToken ? 'locked' : 'active',
      // Assumed: the emulator carries dead-letter reasons as the application properties DeadLetterReason/DeadLetterErrorDescription.
      deadLetterReason: DeadLetterReason,
      deadLetterDescription: DeadLetterErrorDescription,
    };
  }
  // A settlement goes on the link that received the message; a lock that is unknown, past x-opt-locked-until, or whose
  // link or connection has gone is lost (Service Bus has no link recovery).
  function settle(lockToken, state, check = () => {}) {
    const lock = typeof lockToken === 'string' ? locks.get(lockToken) : null;
    if (
      !lock ||
      lock.connection.failed ||
      lock.link.failure ||
      (lock.lockedUntil && lock.lockedUntil.getTime() <= now())
    ) {
      locks.delete(lockToken);
      throw lockLost();
    }
    check(lock);
    locks.delete(lockToken);
    lock.connection.settle(lock.link, lock.deliveryId, state);
    return true;
  }

  return {
    id,
    descriptor: serviceBusEmulatorDescriptor,
    retry: null,
    entities: Object.freeze(names),
    // What the synchronous I/O bridge (sync-io-bridge.mjs 'amqp-send') needs to open its own connection: the env:NAME
    // reference, never the connection string. The worker reads the variable from the shared process environment.
    syncIo: Object.freeze({ id, connectionString: settings.connectionString, amqpPort: port }),
    /** Send to a queue or topic. scheduledEnqueueTime becomes the x-opt-scheduled-enqueue-time message annotation.
     * duplicate is null: Service Bus duplicate detection drops a duplicate silently, so the sender cannot tell. */
    async send(entity, body, options = {}) {
      const { value, properties, messageId = randomUUID(), scheduled } = messageInput(entity, body, options);
      const annotations = new Map(
        scheduled == null ? [] : [[sym('x-opt-scheduled-enqueue-time'), new Date(scheduled)]],
      );
      const payload = encodeMessage({
        annotations,
        properties: [messageId, null, null, null, null, null, sym('application/json')],
        applicationProperties: properties,
        body: Buffer.from(stringifyExactJson(value), 'utf8'),
      });
      if (payload.length > EMULATOR_MAX_MESSAGE)
        throw new ProviderError(
          'TooLarge',
          `The message for '${entity}' is ${payload.length} bytes; the emulator accepts at most 256 KB.`,
          { provider: id },
        );
      const { connection, link } = await linkOf(senders, entity, (c) => c.attach({ role: 'sender', address: entity }));
      await connection.transfer(link, payload);
      return {
        entity,
        messageId,
        body: value,
        properties,
        sequenceNumber: null,
        enqueuedTime: null,
        scheduledEnqueueTime: scheduled == null ? null : new Date(scheduled).toISOString(),
        deliveryCount: 0,
        lockToken: null,
        lockedUntil: null,
        state: scheduled == null ? 'active' : 'scheduled',
        deadLetterReason: null,
        deadLetterDescription: null,
        duplicate: null,
      };
    },
    /** Receive from a queue, a subscription (<topic>/subscriptions/<name>) or a $deadletterqueue: up to maxMessages that arrive
     * within waitMs; with waitMs 0 the link is drained so only messages available now are returned. */
    async receive(entity, { mode = 'peekLock', maxMessages = 1, waitMs = 0 } = {}) {
      receiveInput(entity, mode, maxMessages);
      // Peek-lock deliveries are unsettled; receive-and-delete uses a pre-settled (snd-settle-mode settled) link.
      const { connection, link } = await linkOf(receivers, `${mode}:${entity}`, (c) =>
        c.attach({ role: 'receiver', address: entity, settled: mode === 'receiveAndDelete' }),
      );
      const deliveries = await connection.take(link, maxMessages, Math.max(0, Number(waitMs) || 0));
      return deliveries.map((delivery) => view(entity, mode, connection, link, delivery));
    },
    /** accepted: the message is removed. */
    async complete(lockToken) {
      return settle(lockToken, described(CODE.accepted, []));
    },
    /** modified with delivery-failed=true, undeliverable-here=false (messaging 3.4.5): the message is delivered again with a
     * higher delivery count. The Service Bus JMS mapping lists MODIFIED_FAILED as Abandon, which increases the delivery count,
     * while RELEASED only unlocks. The emulator's handling of modified is assumed (the Azure SDKs abandon this way). */
    async abandon(lockToken) {
      return settle(lockToken, described(CODE.modified, [true, false]));
    },
    /** rejected with the com.microsoft:dead-letter condition and the reason fields. */
    async deadLetter(lockToken, { reason, description } = {}) {
      // Assumed: the condition and info keys the emulator reads for an explicit dead-letter (the Service Bus SDKs send these).
      const info = new Map([
        [sym('DeadLetterReason'), reason ?? 'DeadLettered'],
        [sym('DeadLetterErrorDescription'), description ?? null],
      ]);
      return settle(
        lockToken,
        described(CODE.rejected, [
          described(CODE.error, [sym('com.microsoft:dead-letter'), description ?? null, info]),
        ]),
        (lock) => {
          if (lock.entity.endsWith(DEAD_LETTER_SUFFIX))
            throw new DataError('A dead-lettered message cannot be dead-lettered again', 400, 'InvalidOperation');
        },
      );
    },
    /** Ready when a fresh connection opens (SASL PLAIN included) and a sender link attaches to every configured entity, within
     * 1.8 s (inside the 2 s preflight bound). env overrides the environment for this probe only. */
    async preflight({ env: source = env } = {}) {
      let connection = null;
      try {
        connection = await open(source, 1800, AbortSignal.timeout(1800));
        for (const entity of names)
          await connection.detach(await connection.attach({ role: 'sender', address: entity }));
        return { ready: true, reason: null };
      } catch (error) {
        return { ready: false, reason: error.message };
      } finally {
        await connection?.close();
      }
    },
    async close() {
      const connection = await session?.catch(() => null);
      session = null;
      senders.clear();
      receivers.clear();
      locks.clear();
      await connection?.close();
    },
  };
}

/** The entities providers.messaging.endpoints maps to provider `providerId` (target `<providerId>/<entity>`). */
export function mappedEntities(settings, providerId) {
  return [
    ...new Set(
      Object.values(settings?.endpoints ?? {})
        .filter((target) => target.startsWith(`${providerId}/`))
        .map((target) => target.slice(providerId.length + 1)),
    ),
  ];
}

// ---- providers.messaging config validation
const PROVIDER_ID = /^[a-z][a-z0-9-]{0,63}$/;
const KINDS = new Set(['local-queue', 'servicebus-emulator']);
const PACK_KIND = /^pack:[A-Za-z0-9@._-]+\/[A-Za-z0-9._-]+$/;
const ENV_REFERENCE = /^env:[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function retrySettings(value, label) {
  if (value === undefined) return { ...DEFAULT_RETRY, backoffMs: [] };
  if (!plainObject(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value))
    if (!['maxAttempts', 'backoffMs', 'deadLetter'].includes(key)) throw new Error(`Unknown ${label} key '${key}'`);
  const maxAttempts = value.maxAttempts ?? 1,
    backoffMs = value.backoffMs ?? [],
    deadLetter = value.deadLetter ?? true;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100)
    throw new Error(`${label}.maxAttempts must be an integer from 1 through 100`);
  if (
    !Array.isArray(backoffMs) ||
    backoffMs.length > 32 ||
    backoffMs.some((ms) => !Number.isInteger(ms) || ms < 0 || ms > 86_400_000)
  )
    throw new Error(`${label}.backoffMs must be at most 32 integer delays from 0 through 86400000`);
  if (typeof deadLetter !== 'boolean') throw new Error(`${label}.deadLetter must be a boolean`);
  return { maxAttempts, backoffMs: [...backoffMs], deadLetter };
}

/** Validate and normalise `providers.messaging`. Throws Error naming the label; never echoes a credential value. */
export function messagingSettings(value, label = 'providers.messaging') {
  if (value === undefined) value = {};
  if (!plainObject(value)) throw new Error(`${label} must be an object`);
  const result = {};
  for (const [providerId, provider] of Object.entries(value)) {
    if (providerId === 'endpoints') continue;
    const at = `${label}.${providerId}`;
    if (!PROVIDER_ID.test(providerId))
      throw new Error(`${label} provider ids must be lower-case names (got '${providerId.slice(0, 64)}')`);
    if (!plainObject(provider)) throw new Error(`${at} must be an object`);
    const { kind } = provider;
    if (typeof kind !== 'string' || !(KINDS.has(kind) || PACK_KIND.test(kind)))
      throw new Error(`${at}.kind must be local-queue, servicebus-emulator or pack:<packId>/<name>`);
    // The emulator's config.json owns lock duration and MaxDeliveryCount, so its entry takes no retry; amqpPort is its AMQP port.
    const allowed =
      kind === 'local-queue'
        ? ['kind', 'retry', 'lockDurationMs']
        : kind === 'servicebus-emulator'
          ? ['kind', 'connectionString', 'amqpPort']
          : ['kind', 'retry', 'connectionString'];
    for (const key of Object.keys(provider))
      if (!allowed.includes(key)) throw new Error(`Unknown ${at} key '${key}' for kind ${kind}`);
    // Only kinds that accept retry get one, so a normalised result parses again unchanged (config-keys and the host both run this).
    const normalized = {
      kind,
      ...(allowed.includes('retry') ? { retry: retrySettings(provider.retry, `${at}.retry`) } : {}),
    };
    if (provider.amqpPort !== undefined) {
      if (!Number.isInteger(provider.amqpPort) || provider.amqpPort < 1 || provider.amqpPort > 65535)
        throw new Error(`${at}.amqpPort must be an integer from 1 through 65535`);
      normalized.amqpPort = provider.amqpPort;
    }
    if (provider.lockDurationMs !== undefined) {
      if (
        !Number.isInteger(provider.lockDurationMs) ||
        provider.lockDurationMs < 1000 ||
        provider.lockDurationMs > 300_000
      )
        throw new Error(`${at}.lockDurationMs must be an integer from 1000 through 300000`);
      normalized.lockDurationMs = provider.lockDurationMs;
    }
    if (provider.connectionString !== undefined) {
      if (typeof provider.connectionString !== 'string' || !ENV_REFERENCE.test(provider.connectionString))
        throw new Error(
          `${at}.connectionString must be an env:NAME reference; literal connection strings are not accepted in config`,
        );
      normalized.connectionString = provider.connectionString;
    } else if (kind === 'servicebus-emulator') throw new Error(`${at}.connectionString is required (env:NAME)`);
    result[providerId] = normalized;
  }
  result.local ??= { kind: 'local-queue', retry: retrySettings(undefined) };
  const endpoints = value.endpoints ?? {};
  if (!plainObject(endpoints))
    throw new Error(`${label}.endpoints must map service endpoint ids or names to <provider>/<entity>`);
  result.endpoints = {};
  for (const [key, target] of Object.entries(endpoints)) {
    if (!key.trim() || key.length > 200)
      throw new Error(`${label}.endpoints keys must be service endpoint ids or names of at most 200 characters`);
    const slash = typeof target === 'string' ? target.indexOf('/') : -1;
    const providerId = slash > 0 ? target.slice(0, slash) : '',
      entity = slash > 0 ? target.slice(slash + 1) : '';
    if (!Object.hasOwn(result, providerId) || providerId === 'endpoints' || !ENTITY.test(entity))
      throw new Error(
        `${label}.endpoints.${key.slice(0, 64)} must be <provider>/<entity> naming a declared messaging provider`,
      );
    result.endpoints[key] = target;
  }
  return result;
}

/** Pack `messageProviders`: provider kinds mapping to factory functions. */
function validateMessageProviders(map) {
  if (!plainObject(map) || Object.values(map).some((factory) => typeof factory !== 'function'))
    throw new TypeError('messageProviders must map provider names to factory functions');
}
registerPackExport('messageProviders', { check: packCheck(validateMessageProviders) });
registerSettingParser('providers.messaging', messagingSettings);
