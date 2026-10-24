# Messaging and outbox

Mirage has two in-process modules for messages that leave a Dataverse operation. `mirage/lib/message-bus.mjs` is a local queue bus. `mirage/lib/outbox.mjs` captures email, Teams and Outlook messages so you can inspect them. Neither module sends network traffic. Both keep their state as rows of internal store tables, so restart, snapshot and reset follow the persistence mode you selected (memory, file or journal).

Both modules are built against a `DataStore`. The host hands them to the organization as `api.providers.messaging` and `api.providers.outbox`; [What is wired](#what-is-wired) lists their producers and routes.

## Local message bus

`createLocalMessageBus({ store, clock, ids, retry, lockDurationMs, id })` returns a bus over the store. Messages are rows of the internal table `paqvilo_queuemessage`. The table's mapping has no entity set, so the portal and the Web API never route to it. Each mutation is one incremental (journaled) store transaction. Pass `{ nested: true }` to `send` to join a transaction that is already running. The message then rolls back with that write. The organization composes its internal tables (`paqvilo_queuemessage`, `paqvilo_outboxentry` and the standard `flowrun` table: `dataverse-organization.mjs` `INTERNAL_TABLES`) in its startup transaction at every simulation level, so the first send, capture or flow run writes rows, never the schema.

| Operation                                                             | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `send(entity, body, { messageId, properties, scheduledEnqueueTime })` | Adds a message with a JSON `body` and plain-value `properties`. If the entity, or its dead-letter queue, already holds a message with the same `messageId`, `send` returns that message with `duplicate: true` and adds nothing.                                                                                                                                                                             |
| `receive(entity, { mode, maxMessages, waitMs })`                      | Returns due messages in order of `sequenceNumber`. In `peekLock` mode each message is locked until `lockedUntil` (`lockDurationMs`, 60 seconds by default). In `receiveAndDelete` mode the message is removed. Each delivery increments `deliveryCount`. `waitMs` polls until a message arrives or the time runs out. A `nested: true` receive cannot wait: combined with a `waitMs` above 0 it answers 400. |
| `complete(lockToken)`                                                 | Removes the locked message. A lock that has expired or is unknown fails with `MessageLockLost` (410).                                                                                                                                                                                                                                                                                                        |
| `abandon(lockToken, { reason })`                                      | Releases the lock. The message becomes visible again after the backoff for that attempt (`retry.backoffMs`).                                                                                                                                                                                                                                                                                                 |
| `deadLetter(lockToken, { reason, description })`                      | Moves the message to `<entity>/$deadletterqueue` with the reason.                                                                                                                                                                                                                                                                                                                                            |
| `peek(entity, { max })`                                               | Lists messages without locking them. Each message has a `state`: `active`, `locked`, `scheduled` or `deadLettered`.                                                                                                                                                                                                                                                                                          |
| `stats(entity)`                                                       | Counts `active`, `locked`, `scheduled` and `deadLettered` messages.                                                                                                                                                                                                                                                                                                                                          |

Delivery rules:

- **Ordering.** Messages are FIFO within one entity. Different entities are independent.
- **Lock expiry.** When a lock expires, the next `receive` on that entity releases the message, as an abandon would.
- **Retries.** `retry` is `{ maxAttempts, backoffMs, deadLetter }`. The default `{ maxAttempts: 1, backoffMs: [], deadLetter: true }` delivers each message once. A message that is released after `maxAttempts` deliveries moves to the dead-letter queue with reason `MaxDeliveryCountExceeded`. With `deadLetter: false` it is dropped. A message in a dead-letter queue is never dead-lettered again.
- **Scheduled messages.** A message with a `scheduledEnqueueTime` is invisible until it is due.
- **Clock.** Time comes from the injected `clock.now()`, or the store's clock, or the system clock. A test can move a fixed clock forward to expire locks and release scheduled messages.

The bus `descriptor` is the capability record `message-bus:local` at level `behaviour`. Its capabilities are `{ ordering: 'fifo-per-entity', redelivery: true, deadLetter: true, sessions: false, scheduled: true }`. Its state owner is `store:tables.paqvilo_queuemessage`. A topic is one entity with one implicit subscription: there are no rules, filters, sessions, auto-forwarding or message time-to-live.

## Service Bus emulator

A `servicebus-emulator` entry under `providers.messaging` is a bus over the [Azure Service Bus emulator](https://learn.microsoft.com/azure/service-bus-messaging/overview-emulator), at level `behaviour`. Core implements it with a minimal AMQP 1.0 client (`amqp-client.mjs`, no dependency): plain TCP to a loopback host, SASL PLAIN with the shared access key name as user name and the key as password, one session, sender and receiver links with link credit. Mirage does not start the emulator. The bus has the same `send`, `receive`, `complete`, `abandon` and `deadLetter` operations as the local bus:

- `send(entity, body, { messageId, properties, scheduledEnqueueTime })` sends to a queue or topic. The body is JSON in a data section with content type `application/json`, `properties` become application properties and `scheduledEnqueueTime` becomes the `x-opt-scheduled-enqueue-time` annotation. A message over 256 KB fails with `TooLarge` before it is sent. `duplicate` is `null`: Service Bus duplicate detection drops a duplicate silently, so the sender cannot tell.
- `receive(entity, { mode, maxMessages, waitMs })` reads a queue, a subscription (`<topic>/subscriptions/<name>`) or a `/$deadletterqueue` sub-queue. It returns up to `maxMessages` messages that arrive within `waitMs`. With `waitMs: 0` it drains the link, so it returns only the messages available now. `deliveryCount` counts this delivery; `sequenceNumber`, `enqueuedTime` and `lockedUntil` come from the broker's `x-opt-*` annotations.
- Peek-lock delivers unsettled messages. `complete` settles them as accepted (removed), `abandon` as modified with delivery-failed set (delivered again with a higher delivery count, dead-lettered by the emulator at the entity's MaxDeliveryCount; Learn's JMS mapping lists this outcome as Abandon, while released only unlocks) and `deadLetter(lockToken, { reason, description })` as rejected with the `com.microsoft:dead-letter` condition. `receiveAndDelete` uses a pre-settled link. A lock token that is unknown, past its `lockedUntil`, or from a connection or link that has gone answers `410 MessageLockLost`: Service Bus has no link recovery.
- A missing entity is the emulator's AMQP error: the operation fails with `NotFound`, diagnostic `amqp:not-found` and the entity name. A wrong key fails with `Unauthorized`, diagnostic `SASL_AUTH_FAILED`.
- `nested` cannot join a store transaction for an external broker: a send happens when it is called, and a rolled-back operation does not withdraw it.
- Service endpoints: a `serviceendpoint` row with contract 2 (Queue), 5 (Topic) or 6 (Queue Persistent) that `providers.messaging.endpoints` maps to `<id>/<entity>` of a `servicebus-emulator` provider is delivered through this bus with the same `send` as the local bus: the RemoteExecutionContext body and the listener properties. An asynchronous step's System Job succeeds when the emulator accepts the message and fails with the emulator's error otherwise (for example an entity the emulator does not know). A synchronous step sends its message when the step runs: the asynchronous pipeline awaits the bus `send`, and an SDK call a plug-in makes sends it through the synchronous I/O bridge worker (`sync-io-bridge.mjs`). A failed send fails the operation with 400 `ServiceEndpointFailed` naming the step (diagnostic `SERVICE_ENDPOINT_SEND_FAILED`). A sent message cannot be recalled: an operation that rolls back after the send records `SERVICE_ENDPOINT_SENT_BEFORE_ROLLBACK`.
- There is no `peek`, `stats`, session, deferral or lock renewal: those are Service Bus request-response operations outside this client. `GET /_sim/api/messages` inspects the local bus only.

The connection string is read from its `env:NAME` variable when a connection opens. The key goes only into the SASL exchange; it is never kept, and it never appears in state, results, errors, diagnostics or `/_sim` payloads. The bus opens one connection on first use and opens a new one after a failure. Every wait is bounded (5 seconds per step).

`preflight()` opens a fresh connection (SASL included) and attaches a sender link to every entity that `providers.messaging.endpoints` maps to the provider, within 2 seconds. `provider:messaging/<id>` is `satisfied` when that succeeds and `missing` with the reason otherwise (variable not set, not loopback, unreachable, SASL refused, or the entity the emulator does not know).

Emulator limits that affect local tests (the provider descriptor lists them too):

- The emulator runs as Docker containers: the emulator and a SQL Server Linux container.
- AMQP over TCP is the only transport. AMQP WebSockets and JMS are not supported.
- Partitioned entities are not supported. Entities come from `config.json` when the container starts.
- Data and entities are lost when the container restarts. Paqvilo's own job rows stay authoritative.
- The health check is `http://localhost:5300/health`.
- The bus does not use claims-based security (CBS); it authenticates with SASL PLAIN.

See also [Test locally with the Service Bus emulator](https://learn.microsoft.com/azure/service-bus-messaging/test-locally-with-service-bus-emulator).

`serviceBusEmulatorPreflight({ connectionString, healthPort = 5300, timeoutMs = 2000 })` never throws. It does these checks in order:

1. It requires `UseDevelopmentEmulator=true`.
2. It requires an `sb://` endpoint on a loopback host (`localhost`, `127.0.0.0/8` or `::1`). It does not contact any other host.
3. It requires `healthPort` to be an integer from 1 through 65535.
4. It sends `GET /health` on the loopback health port through `loopbackFetch`. Redirects are refused.

The result has `ready`, `reachable`, the endpoint host and `diagnostics`. The diagnostic codes are `SERVICEBUS_EMULATOR_CONNECTION_MISSING`, `_NOT_DEVELOPMENT`, `_ENDPOINT_INVALID`, `_PORT_INVALID`, `_NOT_LOOPBACK`, `_UNREACHABLE` and `_UNHEALTHY`. The result reports `level: 'behaviour'` and `adapter: 'core-amqp'`. The result never contains the connection string or its key.

### Checking against the real emulator

The tests run against a loopback fake broker (`mirage/testing/amqp-fake-broker.mjs`) that speaks the same AMQP subset with its own codec, not the client's, plus golden performative bytes written from the specification's field tables. A connection lost while a message is in flight fails that send with `AMQP_CONNECTION_CLOSED` naming the entity; the next operation reconnects. A run against the real emulator is a manual check and is not part of CI:

1. Start the emulator with Docker Compose as described in [Test locally with the Service Bus emulator](https://learn.microsoft.com/azure/service-bus-messaging/test-locally-with-service-bus-emulator), with a `config.json` that declares the queue, topic and subscription you use.
2. Set an environment variable to the emulator connection string, for example `FX_SB=Endpoint=sb://localhost;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=<key>;UseDevelopmentEmulator=true;`.
3. Declare `providers.messaging.<id>: { kind: 'servicebus-emulator', connectionString: 'env:FX_SB' }` and map an endpoint to `<id>/<queue>`.
4. Run preflight; `provider:messaging/<id>` is `satisfied` when the emulator accepts the connection and knows each mapped entity. Then send, receive and complete a message through `providers.messaging.buses.<id>`.

## Configuration keys

`messagingSettings(value, label)` validates and normalises `providers.messaging`:

| Key                                         | Values                                                                                                                                                                                                                                                                                              |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `providers.messaging.<id>.kind`             | `local-queue`, `servicebus-emulator` or `pack:<packId>/<name>`. The id `local` defaults to `local-queue`.                                                                                                                                                                                           |
| `providers.messaging.<id>.retry`            | `local-queue` and pack kinds: `{ maxAttempts (1-100), backoffMs (at most 32 delays, 0-86400000), deadLetter }`. The default is `{ maxAttempts: 1, backoffMs: [], deadLetter: true }`. Not accepted for `servicebus-emulator`: the emulator's `config.json` owns lock duration and MaxDeliveryCount. |
| `providers.messaging.<id>.lockDurationMs`   | `local-queue` only. An integer from 1000 through 300000.                                                                                                                                                                                                                                            |
| `providers.messaging.<id>.connectionString` | Required for `servicebus-emulator`. Only an `env:NAME` reference is accepted. A literal connection string is rejected. The endpoint must be `sb://` on a loopback host with `UseDevelopmentEmulator=true`.                                                                                          |
| `providers.messaging.<id>.amqpPort`         | `servicebus-emulator` only. The emulator's AMQP port, an integer from 1 through 65535. The default is 5672. The port in the connection string `Endpoint` is the management port and is not used for AMQP.                                                                                           |
| `providers.messaging.endpoints`             | `{ '<serviceendpoint id or name>': '<provider id>/<entity>' }`. The provider id must be declared.                                                                                                                                                                                                   |

Unknown keys are rejected for each kind. `providers.messaging` is normalised once and the result parses again unchanged: a `servicebus-emulator` entry carries no `retry`, so a catalogue entry such as `sb: { kind: servicebus-emulator, connectionString: env:SB_CONNECTION }` starts the core AMQP bus.

`providers.messaging.buses` (on `api.providers.messaging`) holds every declared provider by id. A `pack:<packId>/<name>` entry is created by that pack's `messageProviders.<name>` factory as `factory({ id, kind, settings, store, clock, ids, organizationUri })`, which returns a bus with `send(entity, message)`. A `local-queue` id is a local bus over the same queue table. A `servicebus-emulator` id is the core AMQP bus unless a pack exports a `servicebus-emulator` factory, which then takes precedence. A declared provider with no factory reports `PROVIDER_NOT_REGISTERED`, its endpoints resolve to no bus (`SERVICE_ENDPOINT_UNMAPPED`) and preflight lists `provider:messaging/<id>` as missing. A factory that throws fails host start with `PROVIDER_FACTORY_FAILED`. Each factory input also carries `own(resource)`, with the ownership and cleanup rules of [pack storage providers](storage-providers.md#pack-storage-providers).

A pack bus may implement `preflight()` → `{ ready, reason? }` with the same rules as [storage providers](storage-providers.md#contract): `provider:messaging/<id>` is `satisfied` only when it answers ready within 2 seconds, `missing` when it answers not ready, and `placeholder` (declared, not probed) without `preflight()`. A `preflight` that is not a function fails composition with `PROVIDER_FACTORY_FAILED`.

## Outbox

`createOutbox({ store, clock, ids, storage, retention = 1000 })` captures outgoing messages as rows of the internal table `paqvilo_outboxentry`. Like the queue table, it has no entity set. The descriptor is `outbox:local` at level `behaviour` with `fidelity: 'capture-only'`; its operations are `capture`, `list`, `get`, `markDelivered`, `markFailed` and `sweep`. **The outbox never sends anything.** Captured entries exist only for inspection.

`providers.outbox.kind: 'pack:<packId>'` keeps capture-only behaviour and adds that pack's `outboxHandlers` as post-capture observers. Each entry is `factory({ name, clock, ids, own })` (`own` as for [pack storage providers](storage-providers.md#pack-storage-providers)) returning a function or `{ observe(entry), settle?(), close?() }`. An observer sees every captured entry once the capture's transaction has committed; a capture rolled back with its caller is never observed, and an observer cannot replace or veto capture. An observer error is the `OUTBOX_HANDLER_FAILED` diagnostic. A `pack:` kind naming no pack with `outboxHandlers` fails host start with `PROVIDER_NOT_REGISTERED`. The outbox descriptor lists the observers as `observers: ['<packId>/<name>']`.

`capture(entry, { nested })` takes:

| Field                           | Values                                                              |
| ------------------------------- | ------------------------------------------------------------------- |
| `channel`                       | `email`, `teams`, `outlook` or `portal-email`                       |
| `from`, `to[]`, `cc[]`, `bcc[]` | addresses as text                                                   |
| `subject`, `body`, `bodyType`   | `bodyType` is `text` or `html`                                      |
| `attachments[]`                 | `{ name, contentType, content? (bytes or base64), size? }`          |
| `correlationId`, `source`       | `source` is `{ kind, id }`, for example `{ kind: 'SendEmail', id }` |
| `state`                         | `queued` (the default), `delivered` or `failed`                     |

Attachments:

- **With a storage provider.** When `storage` has `put` and `delete`, attachment bytes are stored under `outbox/<entry id>/<n>`. The entry keeps `{ name, contentType, size, key }` and never the bytes.
- **Without a storage provider.** The entry keeps the name, content type and size, with the diagnostic `OUTBOX_ATTACHMENT_NOT_STORED`.
- **Failed captures.** If the capture's own write fails, the stored bytes are deleted.
- **Nested captures.** A capture with `{ nested: true }` joins the caller's transaction, so it never deletes bytes itself. The keys of entries it evicts wait in `state.simulator.outboxPendingDeletes`, which rolls back with the caller's write. The next outbox write that is not nested, or `sweep()`, deletes them.

Reading and updating entries:

- `list({ correlationId, channel, since })` and `get(id)` read entries.
- `markDelivered(id)` and `markFailed(id, reason)` move a `queued` entry once. Any other move fails with `InvalidStateTransition` (409).
- Only the newest `retention` entries are kept. When an entry is evicted, its stored bytes are deleted (after the caller's transaction, for a nested capture).
- `sweep()` runs the pending deletes, then lists `outbox/` in the storage provider. Afterwards it judges the listed objects in a transaction (it joins the caller's transaction when called inside one), so a capture that committed while the list ran is referenced, and deletes every object that no entry references, such as the bytes of a capture whose caller rolled back. Keys of captures still in flight are skipped. Each delete is conditional on the ETag the list returned (`ifMatch`), so bytes put again under a listed key are kept. It returns `{ deleted, pending }`, where `pending` counts the deferred deletes it ran. Without a storage provider that can list, it returns `{ deleted: 0, pending: 0 }`. The storage router's sweep calls it; see [Storage providers](storage-providers.md).

`waitForOutbox(outbox, predicate, { timeoutMs, clock })` resolves with the first matching entry. It fails with `OutboxTimeout` when real time or the supplied clock passes `timeoutMs`.

## What is wired

Each producer reads its provider when it runs. When a provider is `null`, Mirage behaves as it did without it.

Both hosts build these providers once (`organization-host.mjs`): the local bus with the validated `providers.messaging` settings and the outbox are always present. The organization backend delivers through `serviceEndpointDelivery(store, { messaging: () => api.providers.messaging })`, the connector runtime's `memory-queue` provider sends to the same bus, and both hosts mount the `/_sim/` routes below before their administration router. A dry-run runtime cannot write the bus table (it is a schema change the dry-run level refuses), so a delivery there fails its job; use a state file.

`api.providers.messaging` has the shape `{ bus, buses?, settings, organizationUri? }`:

- `bus` is the default bus, such as the one from `createLocalMessageBus`. A bare bus is also accepted, and the endpoint mappings are then read from `bus.settings.endpoints`.
- `buses` holds every declared provider's bus by id: `local-queue` ids share the local table, pack and emulator kinds come from pack factories (see [Configuration keys](#configuration-keys)).
- `settings` is the output of `messagingSettings`, which holds the `endpoints` map.
- `organizationUri` is the value sent in each message's `organizationUri` property: the Dataverse API origin when the API is on, else the host's local origin.

`api.providers.outbox` is the object `createOutbox` returns.

### Service endpoint delivery

`serviceEndpointDelivery(store, { messaging })` in `dataverse-webhooks.mjs` is the plug-in pipeline's delivery adapter. `webhookDelivery` is an alias for it. `messaging` may be the provider object or a function that returns it.

| Contract                                   | With a messaging provider                                                          | Without one                                                         |
| ------------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 8 (Webhook)                                | POST to a loopback URL, unchanged                                                  | the same                                                            |
| 2 (Queue), 5 (Topic), 6 (Queue Persistent) | `bus.send(entity, RemoteExecutionContext, { messageId: OperationId, properties })` | skipped with `WEBHOOK_NOT_DELIVERED`; an async job is Canceled (32) |
| 1, 3, 4, 7, 9 and others                   | skipped; an async job is Canceled (32)                                             | the same                                                            |

- **Target.** The bus entity comes from `providers.messaging.endpoints`. The key is the endpoint's `serviceendpointid` (any letter case) or its `name`. The value `<provider>/<entity>` picks the bus: `buses[provider]`, or the default bus when the provider matches the bus id (`local` by default).
- **Properties.** Each message carries `{ organizationUri, callingUser, initiatingUser, entity, requestName }`. These names may differ from the native listener's property names.
- **Synchronous steps.** On a bus in this process (the local bus) the message is sent with `nested: true`, so it is written inside the running transaction. If that transaction fails, the message is removed with it. On the Service Bus emulator bus the message is sent when the step runs and a rollback does not withdraw it (see [Service Bus emulator](#service-bus-emulator)). Before the send, the step checks what the bus would refuse: the entity name, plain-value properties and a `messageId` (the `OperationId`) of 1 to 128 characters. A message that fails these checks raises the error diagnostic `SERVICE_ENDPOINT_SEND_FAILED` and fails the operation with "Endpoint unavailable" (400, `0x80040265`), so the write rolls back instead of committing without the message.
- **Asynchronous steps.** The message is sent after commit through the durable async job, which then ends Succeeded (30). Each committed event produces exactly one message, and a rolled-back write produces none. A send that fails the same checks fails the job with "Endpoint unavailable".
- **Unmapped endpoints.** An endpoint with no mapping, or one that names an unknown provider, is never dropped silently. It raises the error diagnostic `SERVICE_ENDPOINT_UNMAPPED`, with the endpoint id and name and never its `authvalue`. A synchronous step then fails and rolls back the operation. An asynchronous step's System Job ends Failed (31) with a message that names the missing mapping.
- **TriggerServiceEndpointCheck.** When a messaging provider is configured, it answers 204 for a mapped contract 2, 5 or 6 endpoint and sends nothing. An unmapped endpoint gets 400. Without a provider, the check accepts loopback contract 8 endpoints only. The 2/5/6 answer reuses the web hook's success shape.

### Email outbox

These rules apply when `api.providers.outbox` is set:

- **`SendEmail` with `IssueSend` false.** Captures an `email` entry with `state: 'delivered'`.
- **`SendEmail` with `IssueSend` true.** Captures the entry `queued`. Both captures run inside the message's transaction with `nested: true`, so a send that rolls back captures nothing.
- **Entry contents.** Addresses come from the email's `sender`, `torecipients`, `cc` and `bcc` columns and from its `activityparty` rows (participation types 1 to 4). The body comes from `description`, with `bodyType: 'html'`. `source` is `{ kind: 'SendEmail', id }`, and `correlationId` is the request id.
- **Attachments.** Each `activitymimeattachment` row of the email is listed as `{ name, contentType, size, key: null }`. The bytes stay where the row's storage keeps them.
- **`BackgroundSendEmail`.** Marks the queued `SendEmail` entries of the pending emails it returns as `delivered`, in one transaction. The email rows themselves keep Pending Send.
- **Other send messages.** `CreateAndSendNewEmail`, `SendEmailFromTemplate` and `SendTemplate` do not capture entries.

### `/_sim/` routes

`createMessagingRoutes({ api, csrf })` in `sim-messaging-routes.mjs` returns `async (req, res, url) => boolean`. The host mounts it before its generic `/_sim/api` router. It handles these routes:

| Route                                                 | Answer                                                                                                                                                                                                            |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /_sim/api/messages`                              | `{ configured, entities: [{ entity, stats }], endpoints }`. The entities are those in the bus table plus every mapped entity.                                                                                     |
| `GET /_sim/api/messages?entity=<name>[&max=]`         | `{ entity, messages }` from `peek`. Use `<name>/$deadletterqueue` for the dead-letter queue.                                                                                                                      |
| `DELETE /_sim/api/messages/<entity>`                  | `{ entity, purged }`. Requires the `x-sim-csrf` header (403 without it). The check fails closed: when the runtime has no CSRF token, the purge answers 403. Answers 404 when no messaging provider is configured. |
| `GET /_sim/api/outbox?correlationId=&channel=&since=` | `{ configured, entries }`                                                                                                                                                                                         |

Every answer passes through `redactSecrets`, and so do the flow-run answers under `/_sim/api/flow-runs`. A key is credential-named when, lower-cased and with separators dropped, it ends in `authvalue`, `connectionstring`, `password`, `secret`, `clientsecret`, `clientpassword`, `saskey`, `sastoken`, `sharedaccesskey`, `sharedaccesssignature`, `accountkey`, `apikey`, `token`, `accesstoken`, `authorization`, `primarykey`, `secondarykey`, `functionkey`, `signature` or `cookie`, or contains `functionskey` (so `client-secret` and `x-functions-key` match). Its value is replaced with `[redacted]`, and so is the `value` of a DataContract `{ key, value }` pair whose `key` is credential-named. The bare pair field `key` and `sharedaccesskeyname` never match. The routes inspect and purge the default bus only.
