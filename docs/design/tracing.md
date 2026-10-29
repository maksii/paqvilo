# Tracing: how it is built

Contributor notes for Mirage's causal tracing layer: one span store that records what a local runtime did for each
request (HTTP root, portal Web API, Dataverse operations, permission decisions, plugin stages and steps, SDK calls,
secrets, outbound HTTP, async jobs, flows, connectors and renders), how those pieces nest, and how they are queried. The
setting is `mirage.trace` in the [configuration guide](../configuration.md).

## Decisions

1. **One trace store per organization host.** `mirage/lib/trace-store.mjs` exports `createTraceStore(options)`.
   `composeOrganizationHost` (`organization-host.mjs`) creates it once and exposes it as `host.traces`; the DataStore
   carries the same instance as `store.traces`, so deep layers reach it without new constructor parameters. Every host of
   the runtime (Power Pages `server.mjs`, the standalone runtime and the Dataverse Web API listener) shares that one
   instance.
2. **The audit log keeps its API.** Each `AuditLog` entry additionally carries the `traceId` and `spanId` of its HTTP root
   span, and the `_sim` audit view links to the trace.
3. **Spans nest through the store's own `AsyncLocalStorage`.** `traces.run(span, fn)` makes `span` the parent of
   everything synchronous and awaited inside `fn`. When that stack is empty, the store reads `traceId` and `spanId` from
   the organization request context (`request-context.mjs`), which HTTP roots set and `child()` / `with()` keep.
4. **Async jobs never inherit the ambient span.** The staging code remembers its span in the store's in-memory registry
   (`traces.remember('job:<asyncoperationid>', span)`, `traces.remember('flow-run:<runId>', span)`); the runner opens its
   `job` span with the explicit `traceId` and `parentSpanId` from `traces.recall(key)`, else as a new root, with
   `async: true`, and runs the job inside `traces.run`. The committed-work tick and the flow scheduler kick run inside
   `traces.detached`, so the scheduler's inherited context is never trusted. The registry is not persisted: after a
   restart a job starts a new root (the in-memory traces are gone too).
5. **Workers carry no context.** CLR SDK calls are dispatched on the main thread inside the plugin-step span, so they nest
   through the span stack.
6. **Loopback HTTP joins the trace.** Outbound loopback calls (webhooks, the flow HTTP provider) send
   `X-Sim-Parent-Trace: <spanId>`, `X-Sim-Trace-Id: <traceId>` and `X-Trace-Id: <traceId>`. Inbound roots take the trace
   id from `X-Trace-Id`, else `X-Sim-Trace-Id`, and the parent span from `X-Sim-Parent-Trace`; only UUID-shaped values
   count. Portal pages send `X-Sim-Parent-Trace` and `X-Trace-Id` on their same-origin calls. Every traced response
   names its trace with `X-Trace-Id` and `X-Sim-Span-Id`.
7. **Trace ids never enter `store.state`.** `store.state` is hashed, journaled and checkpointed, so committed events,
   `asyncoperation.data` and `state.simulator.flowRuns` carry no trace or span ids; the registry of decision 4 links
   later work to its trace. Levels are a run-time toggle: `off`, `summary` (default) and `full`. The configuration row
   supplies the start value; `traces.configure(partial)` and `GET`/`PUT /_sim/api/trace/settings` (CSRF on `PUT`) change it
   without a restart, and the level never changes what goes into the state.
8. **Permission decisions are events, never per-row spans.** Each `assertAllowed` decision is one event
   `type: 'permission'` on the current span with attributes `{ table, operation, result: 'allow'|'deny', model,
permissions }` (and `code` on a denial); each `rows()`, `find` or `findMany` call is one event with
   `result: 'filtered'`, `rows` and `allowed`. A denial in `assertAllowed` with no current span opens a dedicated
   `permission` span with status `denied`. The Dataverse security model uses the same attribute names with `depth` and
   `privilege`.
9. **Trace lines are events.** CLR `ITracingService` lines are events `type: 'trace'` on the plugin-step span; flow
   `trace()` lines are events `type: 'trace'` on the flow-action span. Secret resolution is a `secret` span with its
   status only.
10. **Payloads are captured only at `full`, always redacted.** Bodies, queries, parameters, plugin target and output,
    flow action inputs and outputs, connector parameters and results. Secret values, bearer tokens, cookies and sealed flow
    outputs are never stored.
11. **Persistence is opt-in and outside the state file.** With `persist: true` each end of a trace appends one JSON line
    to `<stateDirectory>/traces/<yyyy-mm-dd>.ndjson`, next to the runtime's state file (under the ignored `.paqvilo/` by
    default; a state file elsewhere puts its `traces/` folder next to it). A runtime without a state directory (memory
    only, `dry-run`) accepts the setting and reports `status().persist.lastError: 'NoStateDirectory'`.

## Span model

A **trace** is the set of spans sharing a `traceId`. Every span record has this shape (JSON-safe; copies only leave the
store):

```js
{
  traceId, spanId, parentSpanId /* string|null */, sequence /* store-wide, increasing */,
  kind,       // 'http' | 'webapi' | 'dataverse' | 'store' | 'permission' | 'plugin-stage' | 'plugin-step' | 'sdk-call'
              // | 'secret' | 'http-out' | 'job' | 'flow-run' | 'flow-action' | 'connector' | 'render'
              // | 'render-template' | 'read' | 'native-service' | 'custom-api' | 'workflow' | 'bulk'
  name,       // human label: 'POST /_api/accounts', 'Create account', 'MyPlugin.PreCreate' (300 characters, redacted)
  module,     // 'portal' | 'webapi' | 'dataverse' | 'security' | 'plugins' | 'clr' | 'flows' | 'connectors' | 'liquid'
              // | 'jobs' | 'secrets' | 'webhooks' | 'native' | 'customapi' | null
  operation,  // lowercase verb: 'create' | 'update' | 'delete' | 'retrieve' | 'retrievemultiple' | 'associate'
              // | 'action' | 'render' | 'run' | 'get' | 'post' | ... | null. Every multi-row read is 'retrievemultiple'
              // (a FetchXML read adds attributes.query: 'fetchxml'); every job span is 'run' (attributes.kind names it)
  entity,     // logical name or null
  recordId,   // string or null
  startedAt,  // ISO time
  durationMs, // null while running, 0.01 ms precision
  status,     // 'running' | 'ok' | 'error' | 'denied'
  depth,      // nesting depth in the trace (root 0)
  async,      // true on the span that starts a staged job (a new execution segment)
  actor,      // { kind: 'anonymous'|'contact'|'staff'|'app'|'system'|'flow'|'plugin', id, name, roles? }
  session,    // { visitorId, sessionKey }  (sessionKey 'contact:<id>' signed in, else 'visitor:<id>', else null)
  origin,     // { host: 'power-pages'|'standalone'|'dataverse-api'|'job'|null, portal, preset }
  attributes, // flat and small: status code, rowCount, stage, mode, sdkCalls, runId, actionPath, connectorId, ...
  events,     // [{ offsetMs, type, message?, attributes? }], at most 1000 (attributes.droppedEvents counts the rest)
  links,      // [{ traceId, spanId, relation: 'staged-by'|'triggered'|'parent-request' }]
  input,      // only at level full: redacted, capped at payloadBytes
  output,     // only at level full: redacted, capped at payloadBytes
  error,      // { code, message } when the span failed
}
```

`actor`, `session` and `origin` default to the parent span's values; a span with no retained parent takes `actor` from the
request context initiator (`{ kind, id, name: null }`) and otherwise `{ kind: 'system', id: null, name: null }`.

A **trace summary** (the items of `query`) is:

```js
{
  traceId, sequence /* root */, latestSequence, startedAt /* root */,
  status,          // 'running' while any span runs, else the root status
  ended,           // no span running
  durationMs,      // root duration
  totalDurationMs, // first span start to last span end (a running span counts up to now)
  spanCount, droppedSpans, errorCount, deniedCount,
  pluginCount /* plugin-step */, flowCount /* flow-run */, connectorCount, dataverseCount,
  kinds: { [kind]: count }, entities: [...], modules: [...],
  evicted,         // only on a trace the LRU evicted while it ran: true
  root,            // the root span record (the parentless span, else the earliest)
}
```

The summary is kept up to date as spans start and end, so a query reads counters instead of scanning spans.

### Behaviours

- **A full trace hands out its overflow handle.** Once a trace holds `spansPerTrace` spans, `start` returns that trace's
  overflow handle: `enabled === false`, `traceId` the full trace's id, `spanId === null`, every method inert. Each refused
  span adds one to the trace's `droppedSpans`. `run(handle, fn)` makes the handle current, so everything started inside
  it (ambient children, a request context built from `handle.traceId` with no span) gets the same handle; a refused
  request root never splits its children into new traces. `headers(handle)` carries the trace id only. `current()` may
  return the handle, so callers never assume a `spanId`. The level-`off` no-op is a different, shared handle whose
  `traceId` is `null`.
- **The registry links later work to its trace.** `remember(key, { traceId, spanId })` keeps the pair in memory, and
  `recall(key)` returns a copy or `null`. It holds the 10,000 most recently used keys and `clear()` empties it. Keys are
  `job:<asyncoperationid>` and `flow-run:<runId>`. A remembered overflow handle recalls `{ traceId, spanId: null }`, so the
  job stays in the full trace and is refused there.
- **Scheduled work runs detached.** `detached(fn)` runs `fn` outside every current span of the store (`als.exit`); the
  request context is left as it is, so a caller that also must not inherit the request wraps it in
  `runWithRequest(null, …)`. The committed-work tick and the flow scheduler kick run detached.
- **Flow-run wait timers are not detached.** A wait timer (`timeoutAt`, a delay's `until`) is scheduled from inside the
  waiting run, so it may inherit that run's context. It needs no `detached`: the resume it fires opens its flow-run span
  with the explicit `traceId` and `parentSpanId` recalled from `flow-run:<runId>` (a new root when the key is gone), and
  an explicit parent disables the ambient fallback.
- **A trace evicted while it runs still ends.** When the `traces` LRU evicts a trace with running spans, listeners get its
  `trace-end` at once with `trace.evicted: true`, and with `persist: true` a line with its spans so far
  (`complete: false`) is queued. When its last span ends, one more line carries the spans that were still running.
- **Sealed flow runs capture no payloads.** A sealed run records its spans, statuses and timings, but no `input` or
  `output` on its `flow-run` and `flow-action` spans at any level.
- **Scheduled flow occurrences are new roots.** Each occurrence of a recurrence trigger starts a new trace whose root is a
  `job` span (attribute `kind: 'flow-schedule'`) with the `flow-run` span under it; it never joins the trace that
  registered the schedule.
- **The Dataverse listener root nests in process.** Without trace headers, a Dataverse Web API listener root started
  inside a current span (an in-process call such as model-driven `Xrm.WebApi`) is a child of that span; with headers the
  headers decide.
- **Job spans run on the job host.** Every `job` span has `origin.host: 'job'` (its children inherit it), with the
  `portal` and `preset` of the span that staged it; a job staged without a trace has neither.
- **A commit records nothing on its own.** A store commit adds a `commit` event to the current span; with no current span
  it records nothing (no standalone single-span trace for job bookkeeping).

A trace **ends** when its last running span ends. An async segment that starts afterwards in the same trace re-opens it,
and it ends again (a second `trace-end` event, a second persisted line) when that segment's spans end.

## Settings

`mirage.trace` (catalogue site and project file) is validated by `traceSettings(value, label = 'mirage.trace')` in
`mirage/lib/trace-settings.mjs`. Unknown keys are refused.

| Member          | Default     | Range                          |
| --------------- | ----------- | ------------------------------ |
| `level`         | `'summary'` | `'off'`, `'summary'`, `'full'` |
| `traces`        | `500`       | 10 to 10000 retained traces    |
| `spansPerTrace` | `2000`      | 50 to 20000                    |
| `payloadBytes`  | `16384`     | 256 to 1048576                 |
| `persist`       | `false`     | `true` or `false`              |

`mergeTraceSettings(current, partial, label = 'trace')` returns the validated settings after a run-time change. The row has
no `identity`, so changing it never forces a new runtime; `runtimeOptions()` delivers it as `createSimulator({ trace })`.

## Store contract

```js
import { createTraceStore, redactPayload, statusFromHttp } from './trace-store.mjs';

const traces = createTraceStore({
  settings, // a mirage.trace value (validated again; defaults fill gaps)
  stateDirectory, // string | () => string | null: the ignored state folder, read only when a trace is persisted
  now, // () => epoch milliseconds; default performance.timeOrigin + performance.now() (wall clock)
});
```

`statusFromHttp(status)` is the one mapping from an HTTP answer to a span status: `401` and `403` are `'denied'`, any
other status of 400 or more is `'error'`, anything else is `'ok'`. HTTP roots, web hook deliveries, connectors and the
Dataverse listener all use it.

The store is a frozen object:

| Member                                          | Returns                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                                       | `false` when the level is `off`.                                                                                                                                                                                                                                                            |
| `start(args)`                                   | A `Span`; the shared frozen no-op span when the level is `off`; the trace's overflow handle when the trace reached `spansPerTrace`.                                                                                                                                                         |
| `run(span, fn)`                                 | `fn()`'s result; inside it `current()` is `span` (a `Span` or an overflow handle). The no-op span just calls `fn()`.                                                                                                                                                                        |
| `detached(fn)`                                  | `fn()`'s result, run outside every current span of the store; the request context is unchanged.                                                                                                                                                                                             |
| `wrap(args, fn)`                                | `fn(span)`'s result (a promise stays a promise). Ends the span, or fails it on a throw or rejection and rethrows.                                                                                                                                                                           |
| `current()`                                     | The current `Span` or overflow handle, else the retained span named by the request context `spanId`, else the overflow handle of a full trace the request context names without a span, else `null`.                                                                                        |
| `headers(span = current())`                     | `{ 'x-sim-parent-trace': spanId, 'x-sim-trace-id': traceId, 'x-trace-id': traceId }` for a `Span`, the two trace id headers for an overflow handle, else `{}`.                                                                                                                              |
| `fromHeaders(headers)`                          | `{ traceId, parentSpanId }` from Node or Fetch headers: `traceId` from `x-trace-id`, else `x-sim-trace-id`; `parentSpanId` from `x-sim-parent-trace`; each lowercased, and `null` when absent or not a UUID (`8-4-4-4-12` hexadecimal), so a client can never name a route such as `stats`. |
| `remember(key, { traceId, spanId })`            | Nothing; keeps the pair under `key` in the in-memory registry (10,000 keys, least recently used dropped first). A pair without a trace id is ignored.                                                                                                                                       |
| `recall(key)`                                   | A copy `{ traceId, spanId }` of the remembered pair, or `null`.                                                                                                                                                                                                                             |
| `query(filters)`                                | `{ items: [summary], total, page, pageSize, pageCount, retained, dropped, latestSequence }`.                                                                                                                                                                                                |
| `spans(filters)`                                | The same envelope with span records as `items`.                                                                                                                                                                                                                                             |
| `tree(traceId)`                                 | `{ trace: summary, root, spans: [record] /* sequence order */, children: [node] }` or `null`; a node is a record plus `children`.                                                                                                                                                           |
| `span(spanId)`                                  | A span record or `null`.                                                                                                                                                                                                                                                                    |
| `ancestry(spanId)`                              | Retained records from the root down to `spanId` (inclusive); `[]` when unknown.                                                                                                                                                                                                             |
| `stats(filters)`                                | See below.                                                                                                                                                                                                                                                                                  |
| `subscribe(listener, { payloads = true } = {})` | An unsubscribe function. `listener({ type, span, trace? })` with frozen copies; with `payloads: false` the copies carry no `input` or `output` (hosts subscribe this way for the SSE channel).                                                                                              |
| `export(filters)`                               | `{ exportedAt, settings, traces: [tree] }` for every matching trace (no paging), in the `sort` and `order` of the filters.                                                                                                                                                                  |
| `clear()`                                       | `status()` after dropping every trace and remembered key and resetting `dropped` (the sequence keeps counting).                                                                                                                                                                             |
| `settings()`                                    | A copy of the settings in force.                                                                                                                                                                                                                                                            |
| `configure(partial)`                            | The new settings; validated like `mirage.trace`, evicts at once when `traces` shrinks; a refused change keeps the old value.                                                                                                                                                                |
| `status()`                                      | `{ level, enabled, retained, spans, running, dropped, droppedSpans, latestSequence, memoryBytes, listeners, persist }` from running counters (no scan of the spans).                                                                                                                        |
| `flush()`                                       | A promise that settles when every persisted line queued so far is written or has failed.                                                                                                                                                                                                    |

`status().persist` is `{ enabled, directory /* <stateDirectory>/traces or null */, written, failures, lastError }`;
`lastError` is `'NoStateDirectory'` while `persist` is on and the runtime has no state directory. `memoryBytes` is an
estimate kept as spans change: 512 bytes per span, 96 bytes plus the message length per event, the key and string lengths
of attributes (the JSON length of a structured attribute value, 8 bytes for other values; a replaced attribute replaces
its share), plus captured payload bytes. An evicted trace takes its share with it.

### start arguments

```js
traces.start({
  kind, // a span kind of the span model ('internal' when omitted)
  name, // the label (defaults to kind)
  module, // module or null
  operation, // lowercased
  entity, // logical name or null
  recordId, // string or null
  actor, // optional: { kind, id, name, roles? }; default from the parent (see the span model)
  session, // optional: { visitorId, sessionKey }; default from the parent
  origin, // optional: { host, portal, preset }; default from the parent
  attributes, // flat; credential-named keys are redacted, strings pass auditText (2000 characters)
  input, // thunk (or value) captured only at level full
  links, // [{ traceId, spanId, relation }]
  parentSpanId, // explicit parent: present (even null) disables the ambient fallback
  traceId, // explicit trace: present (even null) disables the ambient fallback
  async, // true on the first span of an async job segment
});
```

Parent resolution, in order:

1. `parentSpanId` or `traceId` given (including `null`): the current span is ignored.
2. Else the current span of `run` (an overflow handle names only its trace).
3. Else the request context `spanId` / `traceId`.
4. Else a new root in a new trace (`randomUUID()`).

The named parent and trace then resolve the same way for 1 and 3:

- A retained parent decides the trace: the span joins the parent's own trace, whatever trace id came with it.
- An unknown parent id (an evicted span, a legacy audit id) is kept as a link `{ traceId, spanId, relation:
'parent-request' }`. When the named trace is retained, the span goes under that trace's root (`depth: 1`); otherwise it
  is a root (`depth: 0`) of the named trace id, or of a new trace without one.
- No parent: a root of the named trace (a second root when the trace already exists), else of a new trace.
- The resolved trace is full: `start` returns its overflow handle and counts the span in `droppedSpans`.

### Span

| Member                                                                        | Effect                                                                                                                                                        |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`, `traceId`, `spanId`, `parentSpanId`, `status`                      | Read-only facts (`enabled` is `false` and the ids are `null` on the no-op span; an overflow handle keeps its `traceId`).                                      |
| `kind`, `name`, `module`, `operation`, `entity`, `recordId`, `depth`, `async` | Read the live record; on the no-op span and an overflow handle `null`, with `depth` `0` and `async` `false`.                                                  |
| `event(type, { message, attributes })`                                        | Appends `{ offsetMs, type, message?, attributes? }`; `message` passes `auditText` (4000 characters); past 1000 events only `attributes.droppedEvents` counts. |
| `set(attributes)`                                                             | Merges attributes.                                                                                                                                            |
| `setName(name)`                                                               | Replaces the label (300 characters, redacted) while the span runs.                                                                                            |
| `setActor(actor)`                                                             | Replaces `actor` (`{ kind, id, name, roles? }`; a non-object is ignored) while the span runs; spans started later inherit it.                                 |
| `setEntity(entity, recordId = null)`                                          | Sets both `entity` and `recordId` while the span runs.                                                                                                        |
| `setInput(thunk)`                                                             | At level `full`, captures the input while the span runs (like `start({ input })`).                                                                            |
| `output(thunk)`                                                               | At level `full`, captures the output while the span runs.                                                                                                     |
| `end({ status, error, attributes })`                                          | Sets `durationMs` and the status (`status`, else `error` when an error is given, else `ok`); idempotent.                                                      |
| `fail(error)`                                                                 | `end` with `status: 'denied'` for a 401/403 status or a code containing "denied", else `'error'`.                                                             |

Every method returns the span, so calls chain; on the no-op span and an overflow handle every method does nothing. `error` becomes
`{ code, message }` (`code` from `error.code`, else `error.name`, else `'Error'`; a string error is the message).

### Filters

`query`, `spans`, `stats` and `export` accept a `URLSearchParams` or a plain object. Empty values are ignored.

| Filter                                                                 | Applies to                                                                                                                                                                               |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `from`, `to`                                                           | Inclusive; see below. A trace matches when any of its spans starts in the range, a span by its own start.                                                                                |
| `kind`, `module`, `operation`, `entity`, `status`, `host`, `actorKind` | Case-insensitive equality (`host` is `origin.host`).                                                                                                                                     |
| `actorId`                                                              | Equality ignoring braces and case.                                                                                                                                                       |
| `sessionKey`, `visitorId`, `portal`                                    | Exact equality (`portal` is `origin.portal`).                                                                                                                                            |
| `search`                                                               | Case-insensitive substring of name, entity, error code and message, and attribute JSON.                                                                                                  |
| `traceId`                                                              | Exact trace id.                                                                                                                                                                          |
| `minDurationMs`                                                        | A trace's `totalDurationMs`, or a span's `durationMs` (running spans never match).                                                                                                       |
| `hasErrors`                                                            | `true`/`false`: a trace with or without error spans; a span with or without status `error`.                                                                                              |
| `parentSpanId`, `depth`                                                | `spans` and `stats` only.                                                                                                                                                                |
| `page`, `pageSize`                                                     | 1-based page (clamped to the last page), page size 1 to 200 (default 25).                                                                                                                |
| `sort`                                                                 | `query` and `export`: `start` (default, the root sequence), `duration` (`totalDurationMs`), `spans` (`spanCount`) or `errors` (`errorCount`, then `deniedCount`); ties by root sequence. |
| `order`                                                                | `desc` (default) or `asc`, for `sort`; spans always by sequence.                                                                                                                         |
| `bucketMs`                                                             | `stats` only.                                                                                                                                                                            |

`from` and `to` take an ISO 8601 date-time, epoch milliseconds (a number or a decimal string), or a `Date` in process.
A caller that sends a `Date` over HTTP serialises it with `toISOString()` (`2026-02-01T10:00:05.123Z`), which keeps the
milliseconds; `Date#toString()` drops them. Matching traces by any span, as the timeline counts spans, means a timeline
bucket used as `from`/`to` always lists the traces of its spans, follow-up requests and async segments included.

A trace matches the span-level filters (kind through `search`) when **one** of its spans meets all of them. An invalid
`from`, `to`, `page`, `pageSize`, `depth`, `minDurationMs`, `hasErrors`, `sort`, `order` or `bucketMs` throws a
`RangeError` with `status: 400` and `code: 'InvalidTraceFilter'`; its message starts with the filter name.

### stats

`stats(filters)` works on the matching spans (running spans count; percentiles use ended spans only):

```js
{
  count, from /* ISO|null */, to /* ISO|null */, bucketMs /* number|null */,
  overall, // figures over the matching spans
  roots,   // figures over the root spans of the matching traces (a trace matches as in query)
  byKind, byModule, byEntity, byOperation, byActor /* 'kind' or 'kind:id' */, byStatus:
    { [key]: figures },
  timeline: [{ bucketStart /* ISO */, count, errors, p95 }],
  slowest: [spanRef] /* 10, longest first */, errors: [spanRef] /* 10 error spans, newest first */,
}
// figures = { count, errors /* status error */, p50, p95, max }: nearest-rank percentiles of ended spans' durationMs,
//           null without durations
// spanRef = { traceId, spanId, parentSpanId, kind, name, entity, status, startedAt, durationMs, error? }
```

`roots` matches traces the way `query` does (one of its spans meets the span-level filters), so `parentSpanId` and
`depth` do not narrow it. `from` and `to` default to the earliest and latest matching start. Without `bucketMs` the
bucket is the smallest of 1, 5, 10, 50, 100, 500 ms, 1, 5, 10, 30 s, 1, 5, 10, 30 min, 1 h (then whole hours) that keeps
the timeline at 60 buckets or fewer. A `bucketMs` that gives more than 1000 buckets is a 400 `InvalidTraceFilter`.

### Events

`subscribe` listeners receive `{ type: 'span-start' | 'span-end', span }` and `{ type: 'trace-end', span: root, trace:
summary }` (also for a trace the LRU evicts while it runs, with `trace.evicted: true`). Copies are made only while at
least one listener exists, once per kind of copy: listeners subscribed with `payloads: false` share one copy without
`input` and `output` (also left out of `trace.root`). A throwing listener is ignored.

### Redaction

`redactPayload(value, limitBytes = 16384)` returns `{ value, bytes }`:

- credential-named keys (password, secret, token, authorization, authentication, cookie, credential, API key,
  signature, shared access signature, auth value, connection string, SAS and account keys, function keys; compared
  without separators; `sas` and `sig` as whole keys) become `'[redacted]'`, and so does the `value` of a `{ key, value }`
  pair whose key is credential-named. A Logic Apps `authentication: { type, value }` object is therefore hidden whole;
- strings pass `auditText` (`mirage/lib/audit-log.mjs`, shared with the audit log): `Bearer`, `Basic` (a base64 token),
  `Digest` and `SharedAccessSignature` credentials, the `code` and `sig` URL query parameters (`?code=` Azure Functions
  keys, `&sig=` SAS signatures), `name=value` credentials and secret-named FetchXML conditions;
- `URLSearchParams` pass `auditQuery`, which also hides `code` and `sig` parameters;
- dates become ISO strings, binary data `'[binary N bytes]'`, errors `{ name, code, message }`, maps objects, sets
  arrays; functions, symbols and `undefined` members are dropped; cycles become `'[circular]'` and nesting past 16 levels
  `'[depth limit]'`;
- JSON larger than `limitBytes` becomes `{ truncated: true, bytes, preview }` with a preview of at most `limitBytes`.

Captured `input` and `output` always go through it with the `payloadBytes` setting. A thunk that throws records
`{ captureError }`. Thunks must return their value synchronously.

### Persistence

With `persist: true`, the end of a trace (and the eviction of a running one) queues a line on
`<stateDirectory>/traces/<yyyy-mm-dd>.ndjson` (UTC date of the write):

```js
{ persistedAt, traceId, trace: summary, spans: [record], complete /* no span of the trace was running */ }
```

`spans` holds only the spans added since the previous line of that trace, plus any span an earlier line wrote while it
was still running (now with its end). The spans of a `traceId` are the concatenation of its lines, a later record of a
`spanId` replacing an earlier one; the latest line's `trace` summary supersedes earlier ones. The line is built on a
later turn (`setImmediate`), never inside the end that queued it, so ends of one trace in the same turn share one line.
Writes are appended in order, never throw into request handling, and are counted in `status().persist`.

## Hook-site cookbook

Reach the store as `host.traces` or `store.traces`; it may be absent in a bare `DataStore`, so guard with `?.`.

**A root.** An inbound handler takes its parent from the headers, so ambient context never leaks into a new request:

```js
const span = traces.start({
  kind: 'http',
  name: `${req.method} ${url.pathname}`,
  module: 'portal',
  operation: req.method,
  actor,
  session,
  origin: { host: 'power-pages', portal, preset },
  ...traces.fromHeaders(req.headers),
});
const context = createRequestContext({ ...facts, traceId: span.traceId, spanId: span.spanId });
res.on('finish', () =>
  span.end({ status: statusFromHttp(res.statusCode), attributes: { statusCode: res.statusCode } }),
);
await traces.run(span, () => runWithRequest(context, () => handle(req, res)));
```

**A nested operation.** `wrap` for a contained unit of work; it ends or fails the span for you:

```js
return traces.wrap(
  {
    kind: 'dataverse',
    name: `Create ${logical}`,
    module: 'dataverse',
    operation: 'create',
    entity: logical,
    input: () => data,
  },
  (span) => {
    const row = createRow();
    span.set({ recordId: row.id }).output(() => row);
    return row;
  },
);
```

Use `start` + `run` + `end` when the end happens elsewhere (a response `finish`, a generator step). Call `fail(error)` in
the `catch` and rethrow; never swallow the failure for the span's sake.

**Only when work happens.** Open a `plugin-stage` span only when steps matched, one `bulk` span per message (never per
row), and one span per store read call with a lazily built query summary.

**Events.** Permission decisions, trace lines, retries and staged jobs are events on the current span:

```js
traces.current()?.event('permission', { attributes: { table, operation, result: 'deny', model, permissions } });
span.event('trace', { message: line }); // CLR ITracingService, flow trace()
traces.current()?.event('job-staged', { attributes: { kind, asyncOperationId } });
```

**Async job parenting.** The staging span lives beside the committed event, never in it (the event is persisted in
`asyncoperation.data`), and in the trace store's in-memory registry once the commit saved. The scheduler tick runs
detached, and the runner parents the job explicitly (`committed-work.mjs` `stage`, `detached`, `traceJob`; flow
triggers use the same `store.stagingSpan(event)`):

```js
// data.mjs recordCommittedEvent: remember the current span beside the event (a WeakMap), not in it.
const staging = traces.current() ?? currentRequest();
if (staging?.traceId) stagingSpans.set(event, staging);

// committed-work.mjs stage, inside the committing transaction: the job's parent is the span that recorded its event.
const parent = entry.staging ?? store.stagingSpan(entry.event) ?? traces.current();
// ...once the commit saved: remember it under the job's key and say so on that same span.
traces.remember(`job:${asyncOperationId}`, { traceId: parent.traceId, spanId: parent.spanId ?? null }); // overflow handle: spanId null
parent.event?.('job-staged', { attributes: { kind, asyncOperationId } });
kick(); // schedules the tick as detached(store, tick): runWithRequest(null, () => traces.detached(tick))

// committed-work.mjs traceJob, whatever context the scheduler inherited:
const remembered = traces.recall(`job:${asyncOperationId}`); // null after a restart or clear(): the job is a new root
const job = traces.start({
  kind: 'job',
  name,
  module: 'jobs',
  operation: 'run',
  async: true,
  traceId: remembered?.traceId ?? null, // explicit (even null): the ambient span is never used
  parentSpanId: remembered?.spanId ?? null,
  origin: jobOrigin(traces, remembered?.spanId),
  links: remembered?.spanId ? [{ traceId: remembered.traceId, spanId: remembered.spanId, relation: 'staged-by' }] : [],
  attributes: { kind, jobId: asyncOperationId, attempt },
});
try {
  await traces.run(job, () => work(job));
  job.end();
} catch (error) {
  job.fail(error);
  throw error;
}
```

A flow run does the same with `flow-run:<runId>`: the first flow-run span is remembered when the run starts, and a resume
recalls it and passes its `traceId` and `parentSpanId` explicitly.

Flow actions cross awaits inside a generator: keep a map from action path to its span and start each action span with
`parentSpanId` of the flow-run span instead of relying on the current span.

**Forwarding headers.** Outbound loopback HTTP adds the current span:

```js
await fetch(url, { method: 'POST', headers: { ...headers, ...traces.headers() }, body });
```

**Secrets.** A `secret` span records the key name and the status only; never pass the resolved value as input,
output, attributes or event text.

## Performance contract

| Level     | Cost per hook                                                                                                                                                                                               |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off`     | `start` reads one setting and returns the shared no-op span; `run` calls `fn` directly; no thunk runs, nothing is allocated or retained.                                                                    |
| `summary` | One record and one handle per span, `randomUUID()`, one ISO time, map updates; attribute strings and event messages pass `auditText`. No payload thunk runs, no JSON work, no `structuredClone` in `start`. |
| `full`    | `summary` plus the payload thunks: a redacting deep copy and one `JSON.stringify` per captured value, capped at `payloadBytes`.                                                                             |

At every level: listeners cost nothing while none is subscribed; summary counters and the memory estimate are updated
as spans start and end (no scan), so `status()` reads counters and `query` filters and sorts over the counters, building
summaries and root copies only for the returned page; copies and JSON are built only by queries, listeners and
persistence, and persisted lines are serialised on a later turn with only their new spans; retention is bounded by
`traces × spansPerTrace` with `dropped` and `droppedSpans` counting what was evicted or refused, and the registry by
10,000 keys. Tests never assert speed.

## Surfaces

- **`_sim` routes** (`mirage/lib/sim-trace-routes.mjs`, mounted by both hosts and listed in `status.routes`):
  `GET /_sim/api/trace` (query), `GET /trace/spans`, `GET /trace/stats`, `GET /trace/:traceId` (tree),
  `GET /trace/span/:spanId`, `GET /trace/export`, `GET /trace/settings`, `PUT /trace/settings` and `POST /trace/clear`
  (CSRF on mutations); an SSE channel `trace` on `/_sim/events?channels=trace`.
- **CLI** `paqvilo mirage trace list|show <traceId>|spans|stats|settings [--level ...]|clear|export|watch` with `--json`
  and the filters as flags.
- **In-process** `simulator.trace` is the subset `query`, `spans`, `tree`, `span`, `ancestry`, `stats`, `export`,
  `clear`, `settings`, `configure`, `status` and `subscribe` of the store (`traceMethods` in `organization-host.mjs`);
  hook-site members (`start`, `run`, `wrap`, `detached`, `current`, `headers`, `fromHeaders`, `remember`, `recall`,
  `flush`) stay on `host.traces`. The **testing client** `connectRuntime().trace` (`mirage/testing/runtime.mjs`) offers
  the read, settings and export members over the `_sim` routes, serialising a `Date` filter with `toISOString()`.
- **`_sim` view** `#trace` in the Monitor group: filters, KPI tiles, a timeline, the trace list, a waterfall and nested
  tree per trace, a span drawer, pivots to related traces, a live toggle, settings and export. Audit rows and flow run
  details link to `#trace?traceId=...`.
