# Tracing: how it is built

Contributor notes for Mirage's causal tracing: the decisions every hook site follows, the store contract and the cost
budget. What users see (span kinds, attributes, routes, filters, CLI, settings, redaction) is in
[request tracing](../../mirage/docs/tracing.md); this document does not repeat it. Code and tests cite the decisions
below by number ("decision 4") or by id (`D-R3-6`, `D-M-4`).

## Decisions

### 1. One trace store per organization host (D-R2-18)

`composeOrganizationHost` creates one `createTraceStore(options)` (`mirage/lib/trace-store.mjs`) and exposes it as
`host.traces`; the DataStore carries the same instance as `store.traces`. Every host of the runtime (Power Pages,
standalone, Dataverse listener) and a persona runtime share it. Why: a portal request, its Dataverse call and the job it
stages must land in one trace, with one set of run-time settings and one view. Consequence: deep layers reach the store
without new constructor parameters; a host given its store does not close it.

### 2. The audit log keeps its API

Each audit entry adds the `traceId` and `spanId` of its root span (a Liquid read entry: its own `read` span), and that
span names the entry in `attributes.auditId`. Why: the audit ledger has public contracts and records at level `off`.
Consequence: both sides link without merging ([Monitor](#monitor)).

### 3. Spans nest through the store's own AsyncLocalStorage

`traces.run(span, fn)` makes `span` the parent of everything inside `fn`. With an empty stack the store falls back to
the request context (`request-context.mjs`) `traceId` and `spanId`, which HTTP roots set. Why: no hook site passes a
parent by hand for synchronous or awaited work.

### 4. Async jobs never inherit the ambient span

The staging code remembers its span in the store's in-memory registry (`job:<asyncoperationid>`, `flow-run:<runId>`);
the runner opens its `job` span with the explicit `traceId` and `parentSpanId` from `recall(key)`, else as a new root,
with `async: true`. The committed-work tick and the flow scheduler kick run inside `traces.detached`. Why: the scheduler
runs inside whatever request happened to kick it, so its inherited context is wrong. Consequence: the registry is not
persisted; after a restart a job starts a new root.

### 5. Workers carry no context

CLR SDK calls are dispatched on the main thread inside the plugin-step span, so they nest through the span stack.

### 6. Loopback HTTP joins the trace

`traces.headers()` sends `X-Trace-Id`, `X-Sim-Parent-Trace` and `X-Sim-Span-Id`, and `X-Sim-Trace-Id` (an audit id)
only when the span or an ancestor names an audit entry. Inbound roots take the trace only from `X-Trace-Id` and accept
only UUID-shaped ids. Browser clients (portal pages, model-driven shell, `Xrm.WebApi` bridge, canvas player, code-app
SDK, `mirage/lib/trace-gesture.js`) send their page root's ids; a trusted gesture starts its own activity with
`X-Sim-Parent-Request` (relation `parent-request`). Why: the runtime's hosts call each other over loopback, and a page's
follow-up calls belong to the page. Consequence: a client can never name a route such as `stats` as a trace id.

### 7. Trace ids never enter store.state; levels are a run-time toggle

Committed events, `asyncoperation.data` and `state.simulator.flowRuns` carry no trace or span ids; the registry of
decision 4 links later work to its trace. `traces.configure(partial)` and `PUT /_sim/api/trace/settings` change the
level without a restart. Why: `store.state` is hashed, journaled and checkpointed, so a trace id would change its
fingerprint. Consequence: the level never changes what goes into the state; the `mirage.trace` row has no `identity`,
so changing it never forces a new runtime.

### 8. Permission decisions are events, never per-row spans (D-R3-11)

Each `assertAllowed` decision is one `permission` event on the current span; each `rows()`, `find` or `findMany` call
is one `filtered` event; a bulk evaluation (the model-driven `tableRights` index, the rows of a `bulk` span or a
BulkDelete job) is one aggregated `evaluated` event. A denied collection read emits the same `deny` event as a denied
create or delete. Only a denial with no current span opens a `permission` span (status `denied`). Why: per-row spans
would exceed `spansPerTrace` on any list read. The Dataverse security model uses the same attribute names plus `depth`
and `privilege`.

### 9. Trace lines are events

CLR `ITracingService`, flow `trace()`, classic workflow `trace()` and server logic `Logger` lines are `trace` events on
their step, action, workflow or server-logic span. Secret resolution is a `secret` span with key, vault, secret name and
status only.

### 10. Payloads are captured only at full, always redacted

Inputs and outputs are thunks that run only at level `full`, through `redactPayload` with the `payloadBytes` cap. Secret
values, bearer tokens, cookies and sealed flow outputs are never stored. Why: `summary` must cost no JSON work on the
request path ([performance contract](#performance-contract)).

### 11. Persistence is opt-in and outside the state file

With `persist: true` each end of a trace queues one NDJSON line under `<stateDirectory>/traces/`. The line is built on a
later turn (`setImmediate`), so ends of one trace in the same turn share a line, and holds only the spans new since the
trace's previous line. Writes are appended in order and never throw into request handling. Why: traces are diagnostic
output, not state; a state file must not grow with them. A runtime without a state directory reports
`lastError: 'NoStateDirectory'`.

### 12. Record identity everywhere (D-R3-1)

Every `dataverse` span sets `entity` and `recordId` as soon as they are known; a create calls `setEntity(table, id)`
once the id is assigned and before the post-operation stages run. Stage, step, job, web hook, workflow and Liquid
`entity-read` spans copy them from their target. `recordId` is a first-class filter; an attribute named `recordId` is
not the record identity. Why: "everything that touched this row" is the main question a user asks of a trace.

### 13. Dispatch payloads (D-R3-2)

At `full` the Dataverse dispatch span records `{ body, query, headers }` in and `{ id, rowCount, totalCount?,
moreRecords?, statusCode }` out; at `summary` `rowCount`, `pageNumber` and the query kind. The created id is read from
the created row, never from the response.

### 14. Actor and host on every root (D-R3-3)

Standalone, model-driven, canvas, code-app and listener roots call `setActor` right after session resolution and set
`origin.host` and `module`. In-process `Xrm.WebApi`, canvas and code-app calls carry the root's actor on every
descendant. Unauthenticated roots spread `ANONYMOUS_ROOT` so a header-named parent never lends its actor or session.

### 15. Handled errors reach the span (D-R3-4)

A handler that writes its own error answer (JSON envelope, SOAP fault, any 4xx or 5xx) calls
`recordHttpError(span, status, { code, message })` from its response writer. Connector and provider failures keep the
provider's code and message (`cause` holds the inner error); a failed flow run names its action; a cancelled run or
action ends `cancelled`. Why: otherwise a handled 400 would leave the span `ok` and its `error` empty.

### 16. Every outbound HTTP request is an http-out span (D-R3-5)

Server logic `HttpClient`, add-on flows, async callbacks, the plug-in registration check, Azurite storage, the sign-in
flow and the code-app dev-server probe send through `tracedFetch` (`trace-hosts.mjs`), which forwards the trace
headers. An HTTP web hook delivery opens its own `http-out` span the same way; a Service Bus delivery is a `webhook`
span. Connector calls are `connector` spans; the provider's own HTTP happens inside them.

### 17. Deferred work never inherits an ended span (D-R3-6)

BulkDelete, `api.systemJob`, `runInBackground`, RunDesktopFlow, background ExecuteWorkflow, rollup mass jobs, the
elastic time-to-live purge, connector-trigger polls and a pack trigger's `fire()` run inside `detached` and open a `job`
root (operation `run`, `module` naming the job type) parented through `remember`/`recall`, with a `staged-by` link to
the staging span and a `triggered` link back (`link()`, which also works on an ended span). Per-row work inside a job is
an event with a `rows` count.

### 18. Every client joins its caller (D-R3-7, D-R3-28)

Flow HTTP-trigger routes (public path and signed callback) and `/flow-runs` open an `http` root (`module: 'flows'`)
that joins the caller through `fromHeaders`, answers with `X-Trace-Id` and `X-Sim-Span-Id`, records 4xx/5xx through
`recordHttpError` and parents the `flow-run` span. `_sim` admin writes open an `http` root on host `sim`.

### 19. Every listener is complete (D-R3-8, D-R3-21, D-R3-25)

TDS opens one `http` root per statement with literals replaced by `?`; SOAP roots name the message; built-in messages,
functions, actions and custom APIs open a `function` or `action` span; `$batch` opens `batch` > `changeset` > `part`;
Web API CreateMultiple/UpdateMultiple/UpsertMultiple/DeleteMultiple open the same `bulk` span as the SDK path, with no
generic dispatch span under it. The identity provider and the SharePoint fixture server open `http` roots like any
other listener. Why: a request that enters by any door must be findable in the same store.

### 20. One vocabulary (D-R3-9)

Liquid reads are `retrieve` or `retrievemultiple` with `source`. Flow Dataverse connector operations are module
`dataverse` with the canonical operation (`update` for UpdateRecord; `upsert` only for a real upsert) and
`connector: 'commondataserviceforapps'`; the connector span stays module `connectors`. Server logic is kind
`server-logic`. Why: one `operation` filter must find the same work on every layer.

### 21. Forms, uploads and roots carry their request (D-R3-10)

A root records `query` (values redacted), `contentType`, `contentLength` and at `full` the capped body. A form submit
opens a `form` span above its Dataverse operation. Upload and download spans carry the file column, name and size, and
file and binary values are summarised, never copied. Plug-in step spans expose the shared variables at `full`.

### 22. Sign-in and visitors (D-R3-12, D-R2-13)

Sign-in POST and callback roots `setActor` to the contact and add a `signIn` event; contact and identity writes go
through the traced pipeline. Anonymous visitors receive the visitor cookie on their first page GET.
`traceSessionKey(contactId, visitorId)` is `contact:<id>` when signed in, else `visitor:<id>`, else `null`. Why: the
auth cookie is stateless, so the contact or visitor is the only stable session identity.

### 23. off is free (D-R3-13)

Roots check `traces.enabled` before parsing trace headers or looking up audit facts; `dataverse-security.mjs` guards its
`current()` read. A `.json` or `.pdf` page path that reaches the Liquid renderer gets its `http` root like any page.

### 24. Templates and grids are named (D-R3-14)

A built-in template span is `render-template <name>` from its include or reference name; native-service grid spans set
`entity`, `view` (`savedquery`) and `listId`.

### 25. A plug-in fault has one identity (D-R3-19)

A plug-in failure records `{ type, code, status, message, pluginType, step, stage, depth }` on the step span, and the
same `code` and `message` on the dispatch span and the root; a custom API `pluginFailure` uses the same shape. The fault
keeps its own `code` and `status` for the HTTP envelope and carries this identity as a non-enumerable `traceError`,
which every span it fails records. Why: the page shows a generic message; the trace must show which step refused.

### 26. Images and context per registration (D-R3-20)

At `full` a plugin-step input holds the registered images (alias and attribute filter, never the whole row) and the
execution context. The CLR host fills the same shape and adds the IPluginExecutionContext4 per-record image sets
(`preImagesCollection`, `postImagesCollection`); a JavaScript CreateMultiple/UpdateMultiple step adds its per-target
sets.

### 27. Bypass is visible (D-R3-22)

`MSCRM.BypassCustomPluginExecution` and `MSCRM.BypassBusinessLogicExecution` emit one `bypass` event on the dispatch
span naming what was skipped.

### 28. SDK calls name their records (D-R3-23)

A CLR `sdk-call` span carries the target id and the created id as output; an empty GUID is `null`.

### 29. Processes are named (D-R3-24)

A `job` span is named by the process display name alone, with `processType`, `processId` and `processName`; trees, the
CLI and the view print `<kind> <name>`, so no kind repeats in a name. Recurrence and poll occurrences and row-triggered
flows follow the same rule with the flow's display name.

### 30. Canvas formulas are spans (DV-B1-4)

The canvas player opens `canvas` spans (`start`, `select <control>.<property>`, `run <formula>`) with the formula text
at `full`; its Dataverse calls carry `caller: 'canvas'`.

### 31. Loop iterations are action executions (D-R3-30)

Each "Apply to each" or "Do until" iteration keeps its `flow-action` spans (attribute `iteration`), as the platform's run
history does; the loop span carries `iterations` and, at `full`, only the collection size. This is the one exception to
"no per-row spans"; `spansPerTrace` and the overflow handle bound it.

### 32. An activity fails with any of its steps

`failed` is true when the root or any step ended `error` or `denied` (except decision 33). `result` is `running` while a
span runs; for a failed activity the root's own `error` or `denied`, else `error` when a step ended `error`, else
`denied`; otherwise the root's status. `status` stays the root's own. Why: a form save refused by a plug-in behind an
HTTP 200 must read as failed. Consequence: `hasErrors` and `result` filter the activity on every route; `status=error`
selects single steps.

### 33. Browser probes are traced, not failures

A GET or HEAD a browser makes on its own (`browserProbe` in `trace-hosts.mjs`) sets the root attribute
`browserProbe: true`. A 404 to one is not a failed activity (result `ok`); its root keeps `error` and the 404, the HTTP
answer is unchanged, and on the Power Pages host its Page Not Found finding is recorded once per path. Why: favicon and
devtools probes would otherwise flood the failed list.

### 34. Search text is bounded and built lazily (D-R3-15)

`searchText(record)` joins metadata, attributes and events (at most 4096 characters) and, at `full`, input and output
JSON (at most 8192), lowercased. The first search that reads an ended span caches it (counted in `memoryBytes`); a late
`event` or `set` drops the cache. The Activity view's Find steps and `trace watch` use the same function. Why: no JSON
work on the request path, and a search never scans unbounded payloads.

### 35. Every SSE frame is written; only a stalled reader is dropped (D-R2-19, D-R3-18)

`sseClients` (`trace-hosts.mjs`) never skips a frame: a write that returns `false` waits for `drain`. A deferred check
(timer, then `setImmediate`, flagged late when the loop was blocked) looks for progress: bytes taken off the buffer, or
a shrinking libuv write queue (`_handle.writeQueueSize`, needed because a corked burst is one writev). A client with no
progress for `stallMs` (5 s) of a free loop is dropped; a late check never counts. Why: a synchronous burst can block
the loop longer than `stallMs`, and no reader could drain meanwhile.

### 36. flush() waits for persistence and live frames (D-R3-26)

`traces.flush()` never rejects and settles once every queued persisted line is written or failed and every subscriber
`flush` (the SSE channel: frames reached each socket) settled. Running spans are not waited for. Why: tests and the CLI
need a deterministic point after which files and frames are observable, without sleeping.

### 37. Five statuses (D-R3-29)

`SPAN_STATUSES` is `ok`, `error`, `denied`, `cancelled`, `running`. `statusFromHttp` maps 401/403 to `denied`, other
400+ to `error`. `cancelled` is neither error nor denial and counts in no summary counter.

## Store contract

The span record and trace summary shapes are in the [reference](../../mirage/docs/tracing.md#what-each-span-records).
`SPAN_KINDS` (exported, frozen) is the closed kind vocabulary; a hook site uses one of them.

```js
import {
  createTraceStore,
  recordHttpError,
  redactPayload,
  statusFromHttp,
  checkTraceFilters,
  searchText,
  SPAN_KINDS,
  SPAN_STATUSES,
  TRACE_EVENTS,
} from './trace-store.mjs';

const traces = createTraceStore({
  settings, // a mirage.trace value (validated again by traceSettings)
  stateDirectory, // string | () => string | null, read only when a trace is persisted
  entityNames, // name -> the logical and entity set names a table filter stands for (DV-N4-2)
  now, // wall clock that dates spans (default Date.now)
  elapsed, // monotonic clock for durations (default performance.now; an injected now is used for both)
});
```

| Member                                                               | Contract                                                                                                                                            |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                                                            | `false` at level `off`.                                                                                                                             |
| `start(args)`                                                        | A `Span`; the shared no-op span at `off`; the trace's overflow handle once it holds `spansPerTrace` spans.                                          |
| `run(span, fn)`, `wrap(args, fn)`                                    | Run `fn` with `span` current; `wrap` also ends the span, or fails it on a throw or rejection and rethrows.                                          |
| `detached(fn)`                                                       | Runs `fn` outside every current span (`als.exit`); the request context is unchanged, so wrap in `runWithRequest(null, …)` too when needed.          |
| `current()`                                                          | The current span or overflow handle, else the retained span the request context names, else `null`.                                                 |
| `headers(span)`, `fromHeaders(headers)`                              | Decision 6. `fromHeaders` returns `{ traceId, parentSpanId, links? }`, ids lowercased, non-UUIDs `null`.                                            |
| `remember(key, ids)`, `recall(key)`, `link(spanId, link)`            | Decision 4 registry (10,000 most recently used keys); `link` adds a link to a retained span, running or ended, and re-persists it.                  |
| `query`, `spans`, `tree`, `span`, `ancestry`, `stats`, `export`      | The reads behind the routes. Id filters accept 8+ hexadecimal prefixes (DV-N4-3).                                                                   |
| `subscribe(listener, { payloads, flush, events, traceId })`          | Frozen copies, made only while a listener exists, once per copy kind; a throwing listener is ignored.                                               |
| `settings()`, `configure(partial)`, `status()`, `clear()`, `flush()` | `configure` validates through `mergeTraceSettings` and evicts at once when `traces` shrinks; `clear` also empties the registry.                     |
| `track(cancel)`, `close()`                                           | Register an open body capture's cancel function; `close()` cancels them all. The organization host closes the store it created, after its runtimes. |

`checkTraceFilters(filters)` throws what `query` would (the CLI uses it before connecting). `simulator.trace` is the read
and settings subset (`traceMethods` in `organization-host.mjs`); instrumentation members stay on `host.traces`.

**Parent resolution.** An explicit `parentSpanId` or `traceId` (even `null`) disables the ambient fallback; else the
current span of `run`; else the request context; else a new root. A retained parent decides the trace. An unknown parent
becomes a `parent-request` link, under the named trace's root when that trace is retained, else a root. A full trace
returns its overflow handle.

**Overflow handle.** `enabled === false`, `traceId` the full trace, `spanId === null`, every method inert; each refused
span counts in `droppedSpans`. `run(handle, fn)` makes it current so children are refused in the same trace instead of
starting new ones; `headers(handle)` sends the trace id only; a remembered handle recalls `{ traceId, spanId: null }`.
The level-`off` no-op span is a different, shared handle with `traceId: null`.

**Span methods** chain and are inert on the no-op span and an overflow handle: `event`, `set`, `setName`, `setActor`,
`setEntity`, `setStatus`, `setError`, `setInput`, `output`, `end({ status, error, attributes })` (idempotent; explicit
status wins, then `setStatus`, then `error` when an error is set, else `ok`) and `fail(error)` (`denied` for 401/403 or a
code containing "denied"). An error keeps `code`, `message`, scalar facts (`status`, `type`, `action`, `parameter`,
`pluginType`, `step`, `stage`, `depth`, `rolledBack`), redacted `details` and one level of `cause`; a `traceError` object
replaces it (decision 25).

**Other behaviours.** A trace the LRU evicts while it runs emits `trace-end` with `evicted: true` at once and persists
twice. A flow-run wait timer is not detached: its resume opens the flow-run span with the ids recalled from
`flow-run:<runId>`. A commit with no current span records nothing. `recordHttpError` sets status and error while the span
runs, so a reader sees the failure before it ends.

**Redaction** (`redactPayload(value, limitBytes)` → `{ value, bytes }`): credential-named keys compared without
separators (`sas`, `sig` and `invitation` as whole keys, `secretName` exempt), `{ key, value }` pairs judged by `key`,
file and binary values summarised with SHA-256 (base64 means whole 4-character groups with mixed case and a digit, `+`
or `/`, so text and hex stay), strings through `auditText` (`audit-log.mjs`, shared with the audit log), at most 1000
items per array or object, nesting past 16 levels `'[depth limit]'`, cycles `'[circular]'`, and JSON over the limit
`{ truncated: true, bytes, preview }`. Thunks must return synchronously; one that throws records `{ captureError }`.

## Host helpers

`mirage/lib/trace-hosts.mjs`: `traceSessionKey`, `ANONYMOUS_ROOT`, `browserProbe`, `setTraceHeaders(res, span)` for
roots; `sseClients` (decision 35); `tracedFetch(traces, { module, operation, url, init, forwardHeaders, capture,
attributes, fetch })` (decision 16): an `http-out` span `<METHOD> <host><path>`, bodies at `full` unless
`capture: 'none'` (binary uploads, sealed values), a plain `fetch` without a store or at `off`; a synchronous throw from
the given `fetch` fails the span and rejects with that error.

## Hook-site cookbook

Reach the store as `host.traces` or `store.traces` (absent in a bare `DataStore`: guard with `?.`). A root checks
`traces.enabled`, takes its parent only from headers and ends on `finish`:

```js
const span = traces.start({
  kind: 'http',
  name: `${req.method} ${url.pathname}`,
  module: 'portal',
  operation: req.method,
  actor,
  session,
  origin: { host: 'power-pages', portal, preset },
  attributes: { query: auditQuery(url.searchParams), contentType, contentLength },
  ...traces.fromHeaders(req.headers),
});
const context = createRequestContext({ ...facts, traceId: span.traceId, spanId: span.spanId });
res.on('finish', () =>
  span.end({ status: statusFromHttp(res.statusCode), attributes: { statusCode: res.statusCode } }),
);
await traces.run(span, () => runWithRequest(context, () => handle(req, res)));
```

Use `wrap` for a contained unit and name the record as soon as it exists (`span.setEntity(logical, row.id)`). Use
`start` + `run` + `end` when the end happens elsewhere; `fail(error)` in the `catch` and rethrow. Open a `plugin-stage`
only when steps matched, one `bulk` per message, one `part` per `$batch` request. Async job parenting: the staging span
lives beside the committed event (a WeakMap, never inside `asyncoperation.data`), is remembered under `job:<id>` once the
commit saved, and the runner starts its `job` span with the recalled ids (`committed-work.mjs` `stage` and `traceJob`).
Flow actions cross generator awaits, so start each action span with an explicit `parentSpanId`. Never pass a resolved
secret as input, output, attribute or event text.

## Performance contract

| Level     | Cost per hook                                                                                                                                         |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off`     | `start` reads one setting and returns the shared no-op span; `run` calls `fn`; no thunk runs; roots read `enabled` before any header parsing.         |
| `summary` | One record and handle per span, `randomUUID()`, one ISO time, map updates; strings pass `auditText`. No payload thunk, no JSON, no `structuredClone`. |
| `full`    | `summary` plus one redacting copy and one `JSON.stringify` per captured value, capped at `payloadBytes`; `tracedFetch` reads at most `payloadBytes`.  |

At every level: summary counters and the memory estimate update as spans start and end, so `status()` and `query` never
scan spans; copies and JSON are built only by queries, listeners and persistence; retention is bounded by
`traces × spansPerTrace` and the registry by 10,000 keys; per-row work is an event with a count (decision 31 is the one
exception). `memoryBytes` estimates 512 bytes per span, 96 plus the message per event, attribute and payload lengths and
cached search text. Tests never assert speed.

## Surfaces

`_sim` routes and the `trace` SSE channel: `mirage/lib/sim-trace-routes.mjs` (`createTraceRoutes`,
`createTraceChannel`), mounted by both hosts. Activity reads (logs, render sources, bundle): `mirage/lib/sim-activity.mjs`.
CLI: `mirage/trace.mjs`. Testing client: `mirage/testing/runtime.mjs`. View: `mirage/admin/view-activity.mjs`. User-facing
behaviour of each is in the [reference](../../mirage/docs/tracing.md#api).

## Monitor

The `_sim` Monitor reads one spine, the trace store, and links facts that are not spans to it by `traceId`. The data
side (D-M-4) links; it does not merge.

1. **Audit and trace link both ways.** The audit ledger stays its own ledger (it records at level `off` and backs
   `connectRuntime().audit` and the acceptance proofs). `auditId` is an exact span filter; `GET /_sim/api/audit` takes
   `traceId` as one id or a comma list of at most 200 (more is 400 `InvalidAuditFilter`), so a page of activities joins
   its entries in one call.
2. **`X-Sim-Trace-Id` is an audit id, permanently.** Response headers keep their meaning. Inbound, `fromHeaders` resolves
   it through an index of retained spans that carry `auditId`, and the Power Pages host also through the audit ledger,
   whose entry keeps `traceId` and `spanId` after eviction. An unknown audit id is ignored; it never becomes a trace id.
   Why: existing clients echo it.
3. **The log stream has a server-side history.** A ring of `mirage.logs.retain` lines (default 2000, 0 to 50000)
   whether or not anyone listens; each line has `sequence`, `traceId` and `spanId` (the current span, `null` outside
   one); `startup` lines cover each startup phase. `GET /_sim/api/logs?since=&limit=&type=&traceId=`; a client merges the
   SSE `connected` sequence with the history.
4. **A declarative plugin rule is a span event.** `DataStore.applyPlugins` reports each matching rule once through
   `ruleEvaluated`: a `rule` event on the current span, then the host's `onRuleEvaluated` hook writes the `plugin` log
   line. Why: one source of truth, and no store snapshot per write. Level `off` costs one property read per rule.
5. **Findings name their trace.** A diagnostic recorded while a span is current carries `traceId` and `spanId`; a
   request's error handler names the request root explicitly. `GET /_sim/api/diagnostics?traceId=` narrows both lists.
6. **Request rings and flow runs name their trace.** The portal request ring has `traceId`, the Dataverse listener ring
   `traceId` and `spanId`; both stay level-independent. A flow run view has `traceId` and `traceSpanId` from the
   registry; a resume the registry does not know is remembered as the run's span (decision 7 still holds).
7. **Render sources resolve on request.** `GET /_sim/api/render-sources?refs=<id>,…` (at most 100) maps
   `render-template` `attributes.sourceRefId` to the source file and line, listing unknown ids under `missing`.
8. **The trace channel filters in the store.** Clients are grouped by `events` and `traceId` filter, each group holding
   one store subscription, so a frame type no client wants is never copied.
9. **One export bundle.** One NDJSON stream rather than an archive, because the repository has no dependency-free zip
   writer and a stream is readable line by line.
10. **What stays separate.** Health counters (valid at level `off`), the audit ledger and Dataverse ring (public
    contracts), flow run history (durable state), verification evidence and load-time findings are referenced by
    `traceId` where one exists, never copied into the store.
