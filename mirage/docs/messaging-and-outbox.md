# Messaging and outbox

Messages that leave a Dataverse operation go to a message bus or the outbox. Each host builds both once and hands them
to the organization as `api.providers.messaging` and `api.providers.outbox`.

| Piece                             | What it is                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------- |
| Local queue bus (`local-queue`)   | In-process queue over store rows; the Service Bus stand-in. Always present.                 |
| Service Bus emulator bus          | AMQP 1.0 client for an emulator you run on loopback. Never started by Mirage.               |
| Pack bus (`pack:<packId>/<name>`) | Your pack's `messageProviders` implementation.                                              |
| Outbox                            | Capture only: email, Teams and Outlook messages are recorded for inspection and never sent. |
| Azure Service Bus, mail servers   | Refused: nothing contacts a non-loopback host.                                              |

The queue and outbox state are rows of internal tables (`paqvilo_queuemessage`, `paqvilo_queuesequence`,
`paqvilo_outboxentry`, plus the standard `flowrun` table), composed in the organization's startup transaction at every
simulation level and without an entity set, so the portal and Web API never route to them. At `dry-run`, or without a
state file, they work in memory and are lost when the runtime closes; use a persistent level and a state file when they
must survive a restart.

## Local message bus

The local bus works over the store. Each mutation is one journaled store transaction; `{ nested: true }` joins a running
transaction, so the message rolls back with it.

| Operation                                                             | Behaviour                                                                                                                                                                                        |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `send(entity, body, { messageId, properties, scheduledEnqueueTime })` | JSON `body`, plain-value `properties`. A `messageId` already in the entity or its dead-letter queue returns that message with `duplicate: true`.                                                 |
| `receive(entity, { mode, maxMessages, waitMs })`                      | Due messages by `sequenceNumber`. `peekLock` locks each until `lockedUntil` (`lockDurationMs`, default 60 s); `receiveAndDelete` removes it. `waitMs` polls; a nested receive cannot wait (400). |
| `complete(lockToken)`                                                 | Removes the message; an expired or unknown lock fails `MessageLockLost` (410).                                                                                                                   |
| `abandon(lockToken, { reason })`                                      | Releases the lock; the message reappears after that attempt's `retry.backoffMs`.                                                                                                                 |
| `deadLetter(lockToken, { reason, description })`                      | Moves the message to `<entity>/$deadletterqueue`.                                                                                                                                                |
| `peek(entity, { max })`, `stats(entity)`                              | Lists or counts messages by state: `active`, `locked`, `scheduled`, `deadLettered`.                                                                                                              |

- FIFO within one entity; entities are independent. An expired lock is released by the next `receive` on its entity and
  counts as an abandoned delivery: the message reappears after that attempt's `retry.backoffMs`.
- `retry` is `{ maxAttempts, backoffMs, deadLetter }`, default `{ maxAttempts: 1, backoffMs: [], deadLetter: true }`. A
  message released after `maxAttempts` deliveries is dead-lettered with `MaxDeliveryCountExceeded`, or dropped with
  `deadLetter: false`.
- A `scheduledEnqueueTime` hides the message until due. Time comes from the injected clock, else the store's, so a
  test can move a fixed clock to expire locks and release scheduled messages.
- Not modelled: a topic is one entity with one implicit subscription; no rules, filters, sessions, auto-forwarding or
  time-to-live. The descriptor is `message-bus:local` at `behaviour`.

## Service Bus emulator

A `servicebus-emulator` provider is a bus over the
[Azure Service Bus emulator](https://learn.microsoft.com/azure/service-bus-messaging/overview-emulator) at `behaviour`,
through a dependency-free AMQP 1.0 client: plain TCP to a loopback host, SASL PLAIN with the shared access key name and
key, one session, link credit. It has `send`, `receive`, `complete`, `abandon` and `deadLetter`:

- `send` writes a JSON data section (`application/json`); `properties` become application properties and
  `scheduledEnqueueTime` the `x-opt-scheduled-enqueue-time` annotation. A message over 256 KB fails `TooLarge` before
  sending. `duplicate` is `null`: the broker drops duplicates silently.
- `receive` reads a queue, `<topic>/subscriptions/<name>` or a `/$deadletterqueue` sub-queue, returning what arrives
  within `waitMs` (`0` drains what is available now). `sequenceNumber`, `enqueuedTime` and `lockedUntil` come from the
  broker's annotations.
- `complete` settles accepted; `abandon` settles modified with delivery-failed (redelivered, then dead-lettered by the
  emulator at the entity's MaxDeliveryCount); `deadLetter` rejects with `com.microsoft:dead-letter`. A lock that is
  unknown, expired or from a lost connection answers 410 `MessageLockLost`; Service Bus has no link recovery.
- A missing entity fails `NotFound` (diagnostic `amqp:not-found`); a wrong key fails `Unauthorized`
  (`SASL_AUTH_FAILED`); a connection lost mid-send fails `AMQP_CONNECTION_CLOSED` and the next operation reconnects.
  Each protocol step waits at most 5 seconds.
- `nested` cannot join a store transaction: a send happens when called, and a rollback does not withdraw it.
- Not supported: `peek`, `stats`, sessions, deferral, lock renewal, AMQP WebSockets, JMS, CBS and partitioned entities.
  `GET /_sim/api/messages` shows the local bus only.

The connection string is read from its `env:NAME` variable when a connection opens; the key goes only into the SASL
exchange and is never kept or reported. `preflight()` opens a fresh connection and attaches a sender link to every
entity that `providers.messaging.endpoints` maps to the provider, under the [idle guard](storage-providers.md#contract);
`provider:messaging/<id>` is `satisfied` on success and `missing` with the reason otherwise.

The [local service](operations.md#local-services) health check requires `UseDevelopmentEmulator=true`, an `sb://`
endpoint on a loopback host and a valid health port, then sends `GET /health` to that host on port 5300 without
redirects. It never throws and reports `SERVICEBUS_EMULATOR_CONNECTION_MISSING`, `_NOT_DEVELOPMENT`,
`_ENDPOINT_INVALID`, `_PORT_INVALID`, `_NOT_LOOPBACK`, `_UNREACHABLE` or `_UNHEALTHY`.

Emulator facts that affect tests: it runs as Docker containers (the emulator and SQL Server); entities come from its
`config.json` at container start and are lost on restart (Paqvilo's own job rows stay authoritative); one namespace, 256
KB messages.

### Check against the real emulator

CI uses a loopback fake broker (`mirage/testing/amqp-fake-broker.mjs`) with its own codec. A real-emulator run is
manual:

1. Start the emulator as in [Test locally with the Service Bus
   emulator](https://learn.microsoft.com/azure/service-bus-messaging/test-locally-with-service-bus-emulator), with a
   `config.json` declaring your queue, topic and subscription.
2. Set a variable to the emulator connection string, for example
   `FX_SB=Endpoint=sb://localhost;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=<key>;UseDevelopmentEmulator=true;`.
3. Declare `providers.messaging.<id>: { kind: servicebus-emulator, connectionString: env:FX_SB }` and map an endpoint to
   `<id>/<queue>`.
4. Run preflight, then send, receive and complete through `providers.messaging.buses.<id>`.

## Configuration keys

Mirage validates `providers.messaging` and `providers.outbox` when the configuration loads; unknown keys are rejected
per kind, and the normalized result parses again unchanged. A refusal names the full key path, for example
`Unknown sites.example.mirage.providers.messaging.sb key 'retry' for kind servicebus-emulator` or
`sites.example.mirage.providers.messaging.sb.connectionString is required (env:NAME)`.

| Key                                         | Values                                                                                                                                                            |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `providers.messaging.<id>.kind`             | Required: `local-queue`, `servicebus-emulator` or `pack:<packId>/<name>`. An undeclared `local` id is added as `local-queue` with the default retry.              |
| `providers.messaging.<id>.retry`            | `local-queue` and pack kinds: `maxAttempts` 1–100, `backoffMs` at most 32 delays of 0–86400000, `deadLetter`. Not for the emulator: its `config.json` owns those. |
| `providers.messaging.<id>.lockDurationMs`   | `local-queue` only; 1000–300000.                                                                                                                                  |
| `providers.messaging.<id>.connectionString` | Required for `servicebus-emulator`; `env:NAME` only. The endpoint must be `sb://` on loopback with `UseDevelopmentEmulator=true`.                                 |
| `providers.messaging.<id>.amqpPort`         | `servicebus-emulator` only; default 5672. The port in `Endpoint` is the management port, not used for AMQP.                                                       |
| `providers.messaging.endpoints`             | `{ '<serviceendpoint id or name>': '<provider id>/<entity>' }`; the provider id must be declared.                                                                 |

`api.providers.messaging` is `{ bus, buses, settings, organizationUri }`: `bus` is the default (local) bus; `buses`
holds every declared provider by id (`local-queue` ids share the local table, a `servicebus-emulator` id is the core
AMQP bus unless a pack exports a `servicebus-emulator` factory); `settings` holds the `endpoints` map; `organizationUri`
is the Dataverse API origin, else the host's local origin.

A `pack:<packId>/<name>` entry is created by that pack's `messageProviders.<name>` factory as
`factory({ id, kind, settings, store, clock, ids, organizationUri, own })`, returning a bus with `send(entity, message)`
and optionally `preflight()`, under the composition rules of
[pack storage providers](storage-providers.md#pack-storage-providers). A declared provider with no factory reports
`PROVIDER_NOT_REGISTERED`, its endpoints resolve to no bus and preflight lists `provider:messaging/<id>` as missing.

## Outbox

The outbox captures messages as rows of `paqvilo_outboxentry` and keeps the newest `providers.outbox.retention` entries
(default 1,000, at most 1,000,000). The descriptor is `outbox:local` at `behaviour` with `fidelity: 'capture-only'`.
**The outbox never sends anything.**

`capture(entry, { nested })` takes `channel` (`email`, `teams`, `outlook` or `portal-email`), `from`, `to[]`, `cc[]`,
`bcc[]`, `subject`, `body`, `bodyType` (`text` or `html`), `attachments[]` (`{ name, contentType, content?, size? }`),
`correlationId`, `source` (`{ kind, id }`) and `state` (`queued` by default, `delivered` or `failed`).

- **Attachments.** With a storage provider, bytes are stored under `outbox/<entry id>/<n>` and the entry keeps
  `{ name, contentType, size, key }`; without one the entry keeps metadata only (`OUTBOX_ATTACHMENT_NOT_STORED`). A
  failed capture deletes its bytes; a nested capture defers its deletes to `state.simulator.outboxPendingDeletes`,
  which rolls back with the caller.
- **Reading.** `list({ correlationId, channel, since })`, `get(id)`; `markDelivered(id)` and `markFailed(id, reason)`
  move a `queued` entry once (else 409 `InvalidStateTransition`). Dropped entries take their bytes with them.
- **Sweep.** `sweep()` runs the deferred deletes and deletes listed `outbox/` objects that no entry references (with
  `ifMatch`), returning `{ deleted, pending }`. The [storage sweep](storage-providers.md#routing) calls it.
- **Observers.** `providers.outbox.kind: 'pack:<packId>'` adds that pack's `outboxHandlers` as observers:
  `factory({ name, clock, ids, own })` returns a function or `{ observe(entry), settle?(), close?() }`. An observer sees
  each entry after its transaction commits and cannot replace or veto it; its error is `OUTBOX_HANDLER_FAILED`. A
  `pack:` kind naming no pack with `outboxHandlers` fails host start with `PROVIDER_NOT_REGISTERED`.

### Email outbox

- `SendEmail` with `IssueSend` false captures an `email` entry `delivered`; with `IssueSend` true it is `queued`. Both
  run inside the message's transaction, so a rolled-back send captures nothing.
- Addresses come from the email's `sender`, `torecipients`, `cc`, `bcc` and its `activityparty` rows (participation
  types 1–4); the body is `description` as HTML; `source` is `{ kind: 'SendEmail', id }`; attachments are listed as
  `{ name, contentType, size, key: null }` and their bytes stay where the row's storage keeps them.
- `BackgroundSendEmail` marks the queued entries of the emails it returns `delivered`; the email rows keep Pending Send.
- `CreateAndSendNewEmail`, `SendEmailFromTemplate` and `SendTemplate` capture nothing.

## Service endpoint delivery

How a plug-in step whose handler is a service endpoint delivers:

| Contract                                   | With a messaging provider                                                          | Without one                                                           |
| ------------------------------------------ | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 8 (Webhook)                                | POST to a loopback URL                                                             | the same                                                              |
| 2 (Queue), 5 (Topic), 6 (Queue Persistent) | `bus.send(entity, RemoteExecutionContext, { messageId: OperationId, properties })` | skipped with `WEBHOOK_NOT_DELIVERED`; an async job ends Canceled (32) |
| 1, 3, 4, 7, 9 and others                   | skipped; an async job ends Canceled (32)                                           | the same                                                              |

- **Target.** `providers.messaging.endpoints` keyed by the endpoint's `serviceendpointid` (any case) or `name`;
  `<provider>/<entity>` picks `buses[provider]`, or the default bus when the provider is its id.
- **Properties.** `{ organizationUri, callingUser, initiatingUser, entity, requestName }`; these names may differ from
  the native listener's.
- **Synchronous steps.** On the local bus the message is sent `nested`, so it rolls back with a failed transaction. On
  the emulator it is sent when the step runs (a plug-in SDK call sends through the synchronous I/O bridge), and a later
  rollback records `SERVICE_ENDPOINT_SENT_BEFORE_ROLLBACK`. A message the bus would refuse (entity name, non-plain
  properties, `messageId` outside 1–128 characters) or a failed send fails the operation with "Endpoint unavailable"
  (400, `0x80040265`) and `SERVICE_ENDPOINT_SEND_FAILED`.
- **Asynchronous steps.** Sent after commit by the durable job: one message per committed event, none for a rolled-back
  write. The job ends Succeeded (30), or Failed when the send fails.
- **Unmapped endpoints** raise `SERVICE_ENDPOINT_UNMAPPED` (id and name, never `authvalue`): a synchronous step fails
  the operation, an asynchronous job ends Failed (31).
- **TriggerServiceEndpointCheck** answers 204 for a mapped contract 2, 5 or 6 endpoint (sending nothing) and 400 for an
  unmapped one; it probes a contract 8 endpoint only on a loopback URL, and refuses every other endpoint.

## `/_sim/` routes

Both hosts serve these routes; they inspect and purge the default bus only.

| Route                                                 | Answer                                                                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `GET /_sim/api/messages`                              | `{ configured, entities: [{ entity, stats }], endpoints }`: the entities in the table plus every mapped entity.                 |
| `GET /_sim/api/messages?entity=<name>[&max=]`         | `{ entity, messages }` from `peek` (`max` default 100, at most 1000); `<name>/$deadletterqueue` reads the dead-letter queue.    |
| `DELETE /_sim/api/messages/<entity>`                  | `{ entity, purged }`. Needs the administration token in `x-sim-csrf` (fails closed with 403); 404 without a messaging provider. |
| `GET /_sim/api/outbox?correlationId=&channel=&since=` | `{ configured, entries }`                                                                                                       |

Every answer, and every flow-run answer, passes through `redactSecrets`: a key that, lower-cased and without
separators, ends in `authvalue`, `connectionstring`, `password`, `pwd`, `secret`, `token`, `apikey`, `authorization`,
`signature`, `cookie`, `saskey`, `sharedaccesskey`, `accountkey`, `primarykey`, `secondarykey`, `functionkey` or
`subscriptionkey`, or contains `functionskey`, has its value replaced with `[redacted]`, as does the `value` of a
`{ key, value }` pair whose `key` is credential-named. The bare field `key` and `sharedaccesskeyname` never match.
Free-text fields (`body`, `subject`, `message`, `description`, `reason` and similar) are also masked for embedded
connection strings and credential headers.
