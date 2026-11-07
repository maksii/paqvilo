# Tracing: how it is built

Contributor notes for Mirage's causal tracing layer: one span store that records what a local runtime did for each
request (HTTP root, portal Web API, forms, Dataverse operations and messages, `$batch` parts, permission decisions,
plugin stages and steps, SDK calls, secrets, outbound HTTP, web hooks and Service Bus deliveries, async jobs, workflows,
server logic, flows, connectors, canvas formulas and renders), how those pieces nest, and how they are queried. The
setting is `mirage.trace` in the [configuration guide](../configuration.md). This document is the contract every hook
site follows; the user guide is [mirage/docs/tracing.md](../../mirage/docs/tracing.md).

## Decisions

1. **One trace store per organization host.** `mirage/lib/trace-store.mjs` exports `createTraceStore(options)`.
   `composeOrganizationHost` (`organization-host.mjs`) creates it once and exposes it as `host.traces`; the DataStore
   carries the same instance as `store.traces`, so deep layers reach it without new constructor parameters. Every host of
   the runtime (Power Pages `server.mjs`, the standalone runtime and the Dataverse Web API listener) shares that one
   instance.
2. **The audit log keeps its API.** Each `AuditLog` entry additionally carries the `traceId` and `spanId` of its HTTP root
   span (a Liquid read entry: its own `read` span), and that span names the entry in `attributes.auditId`, so each side
   links to the other ([Monitor](#monitor)).
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
6. **Loopback HTTP joins the trace.** Outbound loopback calls (`traces.headers()`) send `X-Trace-Id: <traceId>`,
   `X-Sim-Parent-Trace: <spanId>` and `X-Sim-Span-Id: <spanId>`, and `X-Sim-Trace-Id` only when the span or an ancestor
   names an audit entry, with that audit id (never the trace id). Inbound roots take the trace id from `X-Trace-Id` only and the
   parent span from `X-Sim-Parent-Trace`; an inbound `X-Sim-Trace-Id` is an audit id, resolved to the span that names it
   ([Monitor](#monitor)); only UUID-shaped values count. Portal pages, the
   model-driven client runtime, the `Xrm.WebApi` bridge, the canvas player and the code-app SDK send `X-Sim-Parent-Trace`
   and `X-Trace-Id` of their page root on their same-origin calls. Every traced response names its trace with
   `X-Trace-Id` and `X-Sim-Span-Id`.
7. **Trace ids never enter `store.state`.** `store.state` is hashed, journaled and checkpointed, so committed events,
   `asyncoperation.data` and `state.simulator.flowRuns` carry no trace or span ids; the registry of decision 4 links
   later work to its trace. Levels are a run-time toggle: `off`, `summary` (default) and `full`. The configuration row
   supplies the start value; `traces.configure(partial)` and `GET`/`PUT /_sim/api/trace/settings` (CSRF on `PUT`) change it
   without a restart, and the level never changes what goes into the state.
8. **Permission decisions are events, never per-row spans.** Each `assertAllowed` decision is one event
   `type: 'permission'` on the current span with attributes `{ table, operation, result: 'allow'|'deny', model,
permissions }` (and `code` on a denial); each `rows()`, `find` or `findMany` call is one event with
   `result: 'filtered'`, `rows` and `allowed`. A denied collection read emits the same `deny` event as a denied create or
   delete. A bulk evaluation (the model-driven `tableRights` index) emits one aggregated event `result: 'evaluated'` with
   `tables`, `allowed` and `denied` counts instead of one event per table. A denial in `assertAllowed` with no current
   span opens a dedicated `permission` span with status `denied`. The Dataverse security model uses the same attribute
   names with `depth` and `privilege`.
9. **Trace lines are events.** CLR `ITracingService` lines are events `type: 'trace'` on the plugin-step span; flow
   `trace()` lines are events `type: 'trace'` on the flow-action span; classic workflow `trace()` lines on the workflow
   span; server logic `Logger` lines on the `server-logic` span. Secret resolution is a `secret` span with the key, vault
   and secret name and its status only.
10. **Payloads are captured only at `full`, always redacted.** Bodies, queries, parameters, plugin target, images,
    shared variables and output, flow action inputs and outputs, connector parameters and results, web hook and Service
    Bus bodies and answers, canvas formula text. Secret values, bearer tokens, cookies and sealed flow outputs are never
    stored, and file and binary columns are summarised (see [Redaction](#redaction)).
11. **Persistence is opt-in and outside the state file.** With `persist: true` each end of a trace appends one JSON line
    to `<stateDirectory>/traces/<yyyy-mm-dd>.ndjson`, next to the runtime's state file (under the ignored `.paqvilo/` by
    default; a state file elsewhere puts its `traces/` folder next to it). A runtime without a state directory (memory
    only, `dry-run`) accepts the setting and reports `status().persist.lastError: 'NoStateDirectory'`.
12. **Record identity everywhere (D-R3-1).** Every `dataverse` span sets `entity` and `recordId` as soon as they are
    known: keyed routes at start, a create through `setEntity(table, id)` once the id is assigned and before the
    post-operation stages run, so post-operation steps inherit it. Plug-in stage and step spans, job, web hook, workflow
    and Liquid `entity-read` spans copy `entity` and `recordId` from their target. `recordId` is a first-class filter
    (store, routes, CLI `--record-id`, testing client, the view's chip and "Same record" pivot); an attribute named
    `recordId` is not the record identity.
13. **Dispatch payloads (D-R3-2).** At `full` the Dataverse dispatch span input is `{ body, query, headers }` (`query`:
    OData options, FetchXML, view, search, page, top, skip, orderby; `headers`: `Prefer`, `If-Match`) and its output
    `{ id, rowCount, totalCount?, moreRecords?, statusCode }`; at `summary` the attributes `rowCount`, `pageNumber` and
    the query kind. The created id is read from the created row, never from the response.
14. **Actor and host on every root (D-R3-3).** Standalone, model-driven, canvas, code-app and listener roots call
    `setActor` right after session resolution (`staff` with id and name, `app` or `client` for token clients,
    `anonymous` otherwise) and set `origin.host` and `module`. In-process `Xrm.WebApi`, canvas and code-app calls into
    Dataverse carry the root's actor on every descendant. A contact actor's name is its `fullname`, else
    `firstname lastname`, else its email.
15. **Handled errors reach the span (D-R3-4).** A handler that writes its own error answer (a JSON error envelope, a
    SOAP fault, any 4xx or 5xx) calls `recordHttpError(span, status, { code, message })` from its response writer, so the
    span status and its `error` always agree. Connector and provider failures keep the provider's own code and message
    (`cause` holds the inner error); a failed flow run names its failing action in `error.action` and its output
    `failedAction`; a cancelled action or run ends with status `cancelled`.
16. **Every outbound HTTP request is an `http-out` span (D-R3-5).** Server logic `HttpClient`
    (`exported-operations.mjs`), add-on flows, async callbacks (`dataverse-async.mjs`), the plug-in registration check,
    Azurite storage, the sign-in flow and the code-app dev-server probe send through `tracedFetch` (`trace-hosts.mjs`),
    which forwards the trace headers. An HTTP web hook delivery (`dataverse-webhooks.mjs`) opens its own `http-out` span
    with the same headers, body and answer. A Service Bus queue or topic delivery opens a `webhook` span with attribute
    `transport: 'servicebus'`; its body and answer are captured at `full`. Connector calls are `connector` spans; the
    provider's own HTTP happens inside the provider.
17. **Deferred work never inherits an ended span (D-R3-6).** BulkDelete, `api.systemJob`, `runInBackground`,
    RunDesktopFlow, background ExecuteWorkflow, rollup mass jobs, the elastic time-to-live purge, connector-trigger polls
    and a pack trigger's `fire()` run inside `detached` and open a `job` root (operation `run`, `module` naming the job
    type) parented through `remember`/`recall`, with a `staged-by` link to the staging span and a `triggered` link on the
    staging span to the job root. Per-row work inside such a job is an event with a `rows` count, never a span per row.
18. **Every client joins its caller (D-R3-7, D-R3-28).** Flow HTTP-trigger routes (the public path and the signed
    callback URL) and the on-demand `/flow-runs` route open an `http` root (`module: 'flows'`, `origin.host` the serving
    host, actor from the session, else `anonymous` or `caller` for a signed URL), join the caller through `fromHeaders`,
    answer with `X-Trace-Id` and `X-Sim-Span-Id`, record 4xx and 5xx through `recordHttpError`, and parent the `flow-run`
    span under that root. `_sim` admin actions open an `http` root with host `sim` and actor `system` or the staff user.
19. **Every listener is complete (D-R3-8, D-R3-21, D-R3-25).** The TDS endpoint opens one `http` root per statement
    (`origin.host: 'tds'`, `operation: 'query'`, attributes `sql` with literals as `?`, `statementType`, `line`,
    `rowCount` and `resultSets`) with the entity reads as children. SOAP spans (`origin.host: 'soap'`) carry `message` (the request name) and the operation. Built-in Dataverse messages, bound
    and unbound functions and actions (`WhoAmI`, `RetrieveTotalRecordCount`, custom APIs) and JS `service.execute` open a
    `function` or `action` span named by the message, with the input parameters and the output at `full`. `$batch` opens
    a `batch` span with one `part` child per request and a `changeset` child per change set; a rolled-back change set
    ends `error` with `rolledBack: true`. CreateMultiple, UpdateMultiple, UpsertMultiple and DeleteMultiple through the
    Web API open the same `bulk` span as the SDK path (attributes `message`, `table`, `entity`, `targets`, plus `action`,
    the Web API action name), with per-target `dataverse` children only when the pipeline runs per target; no generic
    dispatch span opens under it. The local identity provider (`origin.host: 'identity-provider'`, module `identity`)
    and the SharePoint contract fixture server (`origin.host: 'sharepoint'`, module `sharepoint`) open `http` roots like
    any other listener.
20. **One vocabulary (D-R3-9).** Liquid reads are `retrieve` or `retrievemultiple` with attribute
    `source: 'liquid-fetchxml' | 'entity-read' | 'entity-query'`. Flow Dataverse connector operations are module
    `dataverse` with the canonical operation (`update` for UpdateRecord, `create`, `retrieve`, `retrievemultiple`,
    `delete`, `upsert` only for a real upsert) and attribute `connector: 'commondataserviceforapps'`; the connector span
    itself stays module `connectors`. Server logic is kind `server-logic` with its input and output.
21. **Forms, uploads and roots carry their request (D-R3-10).** A root `http` span records `query` (values redacted),
    `contentType`, `contentLength` and, at `full`, the body (capped). A form submit opens a `form` span (its `entity`
    and `recordId`, attributes `form`, `formId`, `formKind`, `mode`, `button`) above its Dataverse operation. Upload and download spans carry the file column,
    file name and size. Plug-in step spans expose the shared variables at `full`.
22. **Sign-in and visitors (D-R3-12).** Sign-in POST and callback roots `setActor` to the signed-in contact and record a
    `signIn` event (`provider`, `contactId`); contact and identity writes go through the traced pipeline. Anonymous page
    visitors receive the visitor cookie on their first page GET, so every visitor has a `visitor:<id>` session key.
23. **`off` is free (D-R3-13).** Roots check `traces.enabled` before they parse trace headers or look up audit facts;
    `dataverse-security.mjs` guards its `current()` read. A `.json` or `.pdf` page path that reaches the Liquid renderer
    gets the `http` root like any page.
24. **Templates and grids are named (D-R3-14).** A built-in template span is `render-template <name>` from its include
    or reference name; native-service grid spans set `entity`, `view` (`savedquery`) and `listId`.
25. **A plug-in fault has one identity (D-R3-19).** A plug-in failure records `error = { type:
'InvalidPluginExecutionException' | 'Exception', code: '0x80040265' /* or the typed fault code */, status /* the fault
status name */, message, pluginType, step, stage, depth }` on the step span, and the same `code` and `message` on the
    dispatch span and the root; a custom API `pluginFailure` uses the same shape.
26. **Images and context per registration (D-R3-20).** At `full` a plugin-step input is `{ target, inputParameters,
preImages: { <alias>: attributes }, postImages: { <alias>: attributes }, sharedVariables, context: { messageName, stage,
mode, depth, correlationId, initiatingUserId, userId, businessUnitId, isolationMode } }` and its output
    `{ outputParameters, sharedVariables }`. Images hold the registered alias and attribute filter, never the whole row.
    The CLR host fills the same shape and adds the IPluginExecutionContext4 sets the step saw (`preImagesCollection`,
    `postImagesCollection`: one `{ <alias>: attributes }` per record, with the platform's `PreBusinessEntity` and
    `AsynchronousStepPrimaryName`); a JavaScript CreateMultiple/UpdateMultiple step adds its per-target sets.
27. **Bypass is visible (D-R3-22).** `MSCRM.BypassCustomPluginExecution` and `MSCRM.BypassBusinessLogicExecution`
    headers emit one `bypass` event on the dispatch span `{ header, value, skipped: ['sync-plugins' | 'async-plugins' |
'flows'] }`.
28. **SDK calls name their records (D-R3-23).** A CLR `sdk-call` span carries the target id when there is one and the
    created id as its output; an empty GUID is recorded as `null`.
29. **Processes are named (D-R3-24).** A `job` span is named by the process display name alone (`Order async
follow-up`, `When an order is created`, `Mass Calculate Rollup Fields`), with attributes `processType`, `processId` and
    `processName`: trees, the CLI and the view print `<kind> <name>`, so no kind repeats itself in a name. A classic
    workflow's result is its span output. A recurrence or poll occurrence root is likewise the `job` span
    `<flow display name>` (attributes `kind: 'flow-schedule'`, `trigger: 'recurrence' | 'poll'`, `schedule`), actor
    `system`, and a row-triggered flow's job span is `<flow display name>` with `processType: 'cloud-flow'`,
    `processId` and `processName`.
30. **Canvas formulas are spans (DV-B1-4).** The canvas player opens `canvas` spans: `start`, `select
<control>.<property>` and `run <formula>` with the formula text at `full` and an `error` outcome; Dataverse calls from a
    canvas app carry attribute `caller: 'canvas'`.
31. **Loop iterations are action executions (D-R3-30).** As in the platform run history, each iteration of an "Apply to
    each" or "Do until" runs its actions again, so each iteration's `flow-action` spans are kept, with attribute
    `iteration` (0-based); the loop action span carries `iterations` (the count) and, at `full`, only the collection
    size, never the collection. The `spansPerTrace` cap and its overflow handle bound a large loop. This is the one
    exception to "no per-row spans" (see the [performance contract](#performance-contract)).

## Span model

A **trace** is the set of spans sharing a `traceId`. Every span record has this shape (JSON-safe; copies only leave the
store):

```js
{
  traceId, spanId, parentSpanId /* string|null */, sequence /* store-wide, increasing */,
  kind,       // one of SPAN_KINDS (below)
  name,       // human label: 'POST /_api/accounts', 'Create account', 'MyPlugin.PreCreate' (300 characters, redacted)
  module,     // 'portal' | 'webapi' | 'dataverse' | 'security' | 'plugins' | 'clr' | 'flows' | 'connectors' | 'liquid'
              // | 'jobs' | 'secrets' | 'webhooks' | 'native' | 'customapi' | 'canvas' | 'code-apps' | 'model-driven'
              // | 'storage' | 'identity' | 'sharepoint' | 'sim' | 'http' | null
  operation,  // lowercase verb: 'create' | 'update' | 'delete' | 'retrieve' | 'retrievemultiple' | 'associate'
              // | 'upsert' | 'action' | 'function' | 'render' | 'run' | 'resolve' | 'get' | 'post' | ... | null.
              // Every multi-row read is 'retrievemultiple' (a FetchXML read adds attributes.query: 'fetchxml'); every
              // job span is 'run' (attributes.kind and processType name it)
  entity,     // logical name or null
  recordId,   // string or null: the record the span acts on (filter recordId)
  startedAt,  // ISO time
  durationMs, // null while running, 0.01 ms precision
  status,     // one of SPAN_STATUSES: 'running' | 'ok' | 'error' | 'denied' | 'cancelled'
  level,      // 'summary' | 'full': the capture level when the span started
  depth,      // nesting depth in the trace (root 0)
  async,      // true on the span that starts a staged job (a new execution segment)
  actor,      // { kind: 'anonymous'|'contact'|'staff'|'app'|'client'|'caller'|'system'|'flow'|'plugin', id, name, roles? }
  session,    // { visitorId, sessionKey }  (sessionKey 'contact:<id>' signed in, else 'visitor:<id>', else null)
  origin,     // { host, portal, preset }; host: 'power-pages' | 'standalone' | 'model-driven' | 'canvas' | 'code-app'
              // | 'dataverse-api' | 'tds' | 'soap' | 'identity-provider' | 'sharepoint' | 'job' | 'sim' | null
  attributes, // flat and small: status code, rowCount, stage, mode, sdkCalls, runId, actionPath, connectorId, ...
  events,     // [{ offsetMs, type, message?, attributes? }], at most 1000 (attributes.droppedEvents counts the rest)
  links,      // [{ traceId, spanId, relation: 'staged-by'|'triggered'|'parent-request' }]
  input,      // only at level full: redacted, capped at payloadBytes
  output,     // only at level full: redacted, capped at payloadBytes
  error,      // when the span failed: { code, message, status?, type?, action?, parameter?, pluginType?, step?,
              // stage?, depth?, rolledBack?, details?, cause? }
}
```

`SPAN_KINDS` (exported, frozen) is `http`, `webapi`, `dataverse`, `function`, `action`, `batch`, `part`, `changeset`,
`bulk`, `store`, `permission`, `plugin-stage`, `plugin-step`, `sdk-call`, `custom-api`, `secret`, `http-out`, `webhook`,
`job`, `workflow`, `server-logic`, `flow-run`, `flow-action`, `connector`, `render`, `render-template`, `read`,
`native-service`, `form`, `canvas` and `internal` (the default). A hook site uses one of them; the `kind` filter refuses
any other value. `SPAN_STATUSES` is `ok`, `error`, `denied`, `cancelled`, `running`; `cancelled` is neither an error nor
a denial (it counts in no summary counter).

| Kind                         | Opened by                                                                                                                                     |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `function`, `action`         | A Web API, SOAP or `service.execute` message (`WhoAmI`, `RetrieveTotalRecordCount`, custom APIs), named by the message.                       |
| `bulk`                       | One per CreateMultiple, UpdateMultiple, UpsertMultiple or DeleteMultiple (SDK or Web API): `message`, `table`, `entity`, `targets`, `action`. |
| `batch`, `changeset`, `part` | A `$batch` request, each change set, each request inside it; a rolled-back change set ends `error` with `rolledBack: true`.                   |
| `form`                       | A portal form submit (`entity`, `recordId`; attributes `form`, `formId`, `formKind`, `mode`, `button`), above its Dataverse operation.        |
| `canvas`                     | Canvas player actions: `start`, `select <control>.<property>`, `run <formula>` (formula text at `full`).                                      |
| `webhook`                    | A Service Bus queue or topic delivery (`transport: 'servicebus'`), with body and answer at `full`; an HTTP web hook is an `http-out` span.    |
| `server-logic`               | A Power Pages server logic run, with its input and output and `Logger` lines as `trace` events.                                               |
| `http` (TDS)                 | One root per TDS statement: `operation: 'query'`, `sql`, `statementType`, `line`, `rowCount`, `resultSets`.                                   |

`actor`, `session` and `origin` default to the parent span's values; a span with no retained parent takes `actor` from the
request context initiator (`{ kind, id, name: null }`) and otherwise `{ kind: 'system', id: null, name: null }`.

A **trace summary** (the items of `query`) is:

```js
{
  traceId, sequence /* root */, latestSequence, startedAt /* root */,
  auditId,         // the root's attributes.auditId (its audit entry), else null
  status,          // 'running' while any span runs, else the root status
  ended,           // no span running
  durationMs,      // root duration
  totalDurationMs, // first span start to last span end (a running span counts up to now)
  spanCount, droppedSpans, errorCount, deniedCount,
  firstError,      // only once a span ended error or denied: the first one, { spanId, kind, name, status, code, message }
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
  `runWithRequest(null, …)`. The committed-work tick, the flow scheduler kick and every deferred job of decision 17 run
  detached.
- **Flow-run wait timers are not detached.** A wait timer (`timeoutAt`, a delay's `until`) is scheduled from inside the
  waiting run, so it may inherit that run's context. It needs no `detached`: the resume it fires opens its flow-run span
  with the explicit `traceId` and `parentSpanId` recalled from `flow-run:<runId>` (a new root when the key is gone), and
  an explicit parent disables the ambient fallback.
- **A trace evicted while it runs still ends.** When the `traces` LRU evicts a trace with running spans, listeners get its
  `trace-end` at once with `trace.evicted: true`, and with `persist: true` a line with its spans so far
  (`complete: false`) is queued. When its last span ends, one more line carries the spans that were still running.
- **Sealed flow runs capture no payloads.** A sealed run records its spans, statuses and timings, but no `input` or
  `output` on its `flow-run` and `flow-action` spans at any level.
- **Scheduled flow occurrences are new roots.** Each occurrence of a recurrence trigger (and each connector-trigger poll
  or pack trigger `fire()`) starts a new trace whose root is a `job` span named `<flow display name>` (attributes
  `kind: 'flow-schedule'`, `trigger`, `schedule`) with the `flow-run` span under it; it never joins the trace that
  registered the schedule.
- **The Dataverse listener root nests in process.** Without trace headers, a Dataverse Web API listener root started
  inside a current span (an in-process call such as model-driven `Xrm.WebApi`) is a child of that span; with headers the
  headers decide.
- **Job spans run on the job host.** Every `job` span has `origin.host: 'job'` (its children inherit it), with the
  `portal` and `preset` of the span that staged it; a job staged without a trace has neither.
- **A commit records nothing on its own.** A store commit adds a `commit` event to the current span; with no current span
  it records nothing (no standalone single-span trace for job bookkeeping).
- **A handled error is recorded where it is written.** `recordHttpError` (decision 15) sets the status `end()` uses when
  it is given none and the `error` at once, so a span read while it still runs already shows the failure.

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
The `_sim` view edits the retention members through `PUT /_sim/api/trace/settings`.

## Store contract

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
  settings, // a mirage.trace value (validated again; defaults fill gaps)
  stateDirectory, // string | () => string | null: the ignored state folder, read only when a trace is persisted
  now, // () => epoch milliseconds; default performance.timeOrigin + performance.now() (wall clock)
});
```

`statusFromHttp(status)` is the one mapping from an HTTP answer to a span status: `401` and `403` are `'denied'`, any
other status of 400 or more is `'error'`, anything else is `'ok'`. HTTP roots, web hook deliveries, connectors,
`tracedFetch` and the Dataverse listener all use it.

`recordHttpError(span, status, { code, message, details } = {})` returns `span`. For a status of 400 or more it calls
`span.setStatus(statusFromHttp(status))` and `span.setError({ code, message, status, details })` (`code` defaults to
`Http<status>`, `message` to `HTTP <status>`); a lower status, the no-op span, an overflow handle, `null` and an ended
span are left alone. An explicit `end({ status })` still wins over it.

`checkTraceFilters(filters)` throws the error `query` would throw for the filters (the CLI checks its flags with it
before it connects). `searchText(record)` is the text the `search` filter looks in (see [Filters](#filters)).

The store is a frozen object:

| Member                                                                       | Returns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `enabled`                                                                    | `false` when the level is `off`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `start(args)`                                                                | A `Span`; the shared frozen no-op span when the level is `off`; the trace's overflow handle when the trace reached `spansPerTrace`.                                                                                                                                                                                                                                                                                                                                                                          |
| `run(span, fn)`                                                              | `fn()`'s result; inside it `current()` is `span` (a `Span` or an overflow handle). The no-op span just calls `fn()`.                                                                                                                                                                                                                                                                                                                                                                                         |
| `detached(fn)`                                                               | `fn()`'s result, run outside every current span of the store; the request context is unchanged.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `wrap(args, fn)`                                                             | `fn(span)`'s result (a promise stays a promise). Ends the span, or fails it on a throw or rejection and rethrows.                                                                                                                                                                                                                                                                                                                                                                                            |
| `current()`                                                                  | The current `Span` or overflow handle, else the retained span named by the request context `spanId`, else the overflow handle of a full trace the request context names without a span, else `null`.                                                                                                                                                                                                                                                                                                         |
| `headers(span = current())`                                                  | `{ 'x-sim-parent-trace': spanId, 'x-sim-span-id': spanId, 'x-trace-id': traceId }` for a `Span`, plus `'x-sim-trace-id': auditId` when the span or its nearest retained ancestor carries `attributes.auditId` (never the trace id); `{ 'x-trace-id': traceId }` (plus the trace root's audit id) for an overflow handle; else `{}`.                                                                                                                                                                          |
| `fromHeaders(headers)`                                                       | `{ traceId, parentSpanId }` from Node or Fetch headers: `traceId` from `x-trace-id` only, `parentSpanId` from `x-sim-parent-trace`; without a parent header, an `x-sim-trace-id` that a retained span names in `attributes.auditId` gives that span as the parent (and its trace unless `x-trace-id` names one), an unknown one nothing. Each id is lowercased and `null` when absent or not a UUID (`8-4-4-4-12` hexadecimal), so a client can never name a route such as `stats`.                          |
| `remember(key, { traceId, spanId })`                                         | Nothing; keeps the pair under `key` in the in-memory registry (10,000 keys, least recently used dropped first). A pair without a trace id is ignored.                                                                                                                                                                                                                                                                                                                                                        |
| `recall(key)`                                                                | A copy `{ traceId, spanId }` of the remembered pair, or `null`.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `link(spanId, { traceId, spanId, relation = 'triggered' })`                  | `true` when it added the link to the retained span `spanId`, running or ended (a job runner holds only the recalled ids); `false` for an identical `{ spanId, relation }` link, an unknown span, a link without ids or level `off`. A persisted span is written again in the trace's next line.                                                                                                                                                                                                              |
| `query(filters)`                                                             | `{ items: [summary], total, page, pageSize, pageCount, retained, dropped, latestSequence }`.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `spans(filters)`                                                             | The same envelope with span records as `items`.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `tree(traceId)`                                                              | `{ trace: summary, root, spans: [record] /* sequence order */, children: [node] }` or `null`; a node is a record plus `children`.                                                                                                                                                                                                                                                                                                                                                                            |
| `span(spanId)`                                                               | A span record or `null`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `ancestry(spanId)`                                                           | Retained records from the root down to `spanId` (inclusive); `[]` when unknown.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `stats(filters)`                                                             | See below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `subscribe(listener, { payloads = true, flush = null, events = null } = {})` | An unsubscribe function. `listener({ type, span, trace? })` with frozen copies; with `payloads: false` the copies carry no `input` or `output` (hosts subscribe this way for the SSE channel). `flush`: an optional `() => Promise` that `flush()` awaits. `events`: one `TRACE_EVENTS` type (`span-start`, `span-end`, `trace-end`) or a list of them the listener receives, default all; `traceId`: only frames of that trace; another value is a `TypeError`. `simulator.trace.subscribe` is this member. |
| `export(filters)`                                                            | `{ exportedAt, settings, traces: [tree] }` for every matching trace (no paging), in the `sort` and `order` of the filters.                                                                                                                                                                                                                                                                                                                                                                                   |
| `clear()`                                                                    | `status()` after dropping every trace and remembered key and resetting `dropped` (the sequence keeps counting).                                                                                                                                                                                                                                                                                                                                                                                              |
| `settings()`                                                                 | A copy of the settings in force.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `configure(partial)`                                                         | The new settings; validated like `mirage.trace`, evicts at once when `traces` shrinks; a refused change keeps the old value.                                                                                                                                                                                                                                                                                                                                                                                 |
| `status()`                                                                   | `{ level, enabled, retained, spans, running, dropped, droppedSpans, latestSequence, memoryBytes, listeners, persist }` from running counters (no scan of the spans).                                                                                                                                                                                                                                                                                                                                         |
| `flush()`                                                                    | A promise that never rejects and settles once every persisted line queued so far (and any queued while it waits) is written or has failed, and every subscriber `flush` (the SSE channel: its frames reached each client's socket) has settled. Running spans are not waited for.                                                                                                                                                                                                                            |

`status().persist` is `{ enabled, directory /* <stateDirectory>/traces or null */, written, failures, lastError }`;
`lastError` is `'NoStateDirectory'` while `persist` is on and the runtime has no state directory. `memoryBytes` is an
estimate kept as spans change: 512 bytes per span, 96 bytes plus the message length per event, the key and string lengths
of attributes (the JSON length of a structured attribute value, 8 bytes for other values; a replaced attribute replaces
its share), captured payload bytes, and the length of each cached search text. An evicted trace takes its share with
it.

### start arguments

```js
traces.start({
  kind, // one of SPAN_KINDS ('internal' when omitted)
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

| Member                                                                        | Effect                                                                                                                                                                                    |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`, `traceId`, `spanId`, `parentSpanId`, `status`                      | Read-only facts (`enabled` is `false` and the ids are `null` on the no-op span; an overflow handle keeps its `traceId`).                                                                  |
| `kind`, `name`, `module`, `operation`, `entity`, `recordId`, `depth`, `async` | Read the live record; on the no-op span and an overflow handle `null`, with `depth` `0` and `async` `false`.                                                                              |
| `event(type, { message, attributes })`                                        | Appends `{ offsetMs, type, message?, attributes? }`; `message` passes `auditText` (4000 characters); past 1000 events only `attributes.droppedEvents` counts.                             |
| `set(attributes)`                                                             | Merges attributes.                                                                                                                                                                        |
| `setName(name)`                                                               | Replaces the label (300 characters, redacted) while the span runs.                                                                                                                        |
| `setActor(actor)`                                                             | Replaces `actor` (`{ kind, id, name, roles? }`; a non-object is ignored) while the span runs; spans started later inherit it.                                                             |
| `setEntity(entity, recordId = null)`                                          | Sets both `entity` and `recordId` while the span runs.                                                                                                                                    |
| `setStatus(status)`                                                           | While the span runs, the status a later `end()` without `status` uses (`ok`, `error`, `denied` or `cancelled`; anything else is ignored).                                                 |
| `setError(error)`                                                             | While the span runs, sets `error` (the shape below); a later `end({ error })` replaces it.                                                                                                |
| `setInput(thunk)`                                                             | At level `full`, captures the input while the span runs (like `start({ input })`).                                                                                                        |
| `output(thunk)`                                                               | At level `full`, captures the output while the span runs.                                                                                                                                 |
| `end({ status, error, attributes })`                                          | Sets `durationMs` and the status (`status` when it is one of `ok`, `error`, `denied`, `cancelled`, else the `setStatus` value, else `error` when an error is set, else `ok`); idempotent. |
| `fail(error)`                                                                 | `end` with `status: 'denied'` for a 401/403 status or a code containing "denied", else `'error'`.                                                                                         |

Every method returns the span, so calls chain; on the no-op span and an overflow handle every method does nothing. `error` becomes
`{ code, message }` (`code` from `error.code`, else `error.name`, else `'Error'`; a string error is the message) plus the
facts the error carries: scalar `status` (or `statusCode`), `type`, `action`, `parameter`, `pluginType`, `step`,
`stage`, `depth` and `rolledBack`, `details` (redacted, 2 KB) and one level of `cause` in the same shape. Other members
of the error are not kept. An error with a `traceError` object (a plug-in fault keeps its own `code` and `status` for
the HTTP envelope and carries its identity there, non-enumerable) is recorded as that `traceError`, on every span it
fails: step, stage, dispatch and root.

### Filters

`query`, `spans`, `stats` and `export` accept a `URLSearchParams` or a plain object. Empty values are ignored.

| Filter                                               | Applies to                                                                                                                                                                                                                                                        |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `from`, `to`                                         | Inclusive; see below. A trace matches when any of its spans starts in the range, a span by its own start.                                                                                                                                                         |
| `kind`, `status`                                     | Case-insensitive equality with a value of `SPAN_KINDS` / `SPAN_STATUSES`; any other value is refused.                                                                                                                                                             |
| `module`, `operation`, `entity`, `host`, `actorKind` | Case-insensitive equality (`host` is `origin.host`); `entity` (alias `table`) takes the logical or the entity set name, resolved by the store's `entityNames` option (the organization's mappings; DV-N4-2), and spans keep the logical name.                     |
| `recordId`, `actorId`                                | Equality ignoring braces and case (`recordId` is the span's own `recordId`, never an attribute); a value of at least 8 hexadecimal characters also matches every id it begins (DV-N4-3), an ambiguous prefix all of them.                                         |
| `result`                                             | A comma list of `SPAN_STATUSES` (case-insensitive): a trace matches when its summary status (`running` while a span runs, else the root's status) is one of them; `spans` and `stats` keep the spans of matching traces. Unlike `status`, which matches any span. |
| `auditId`                                            | Exact equality with the span's `attributes.auditId` (a root or a Liquid read naming its audit entry).                                                                                                                                                             |
| `sessionKey`, `visitorId`, `portal`                  | Exact equality (`portal` is `origin.portal`); `sessionKey` and `visitorId` also take an 8+ hex prefix (`visitor:ad87d220`).                                                                                                                                       |
| `search`                                             | Case-insensitive substring of the span's search text: name, kind, module, operation, entity, record id, actor name and id, error code and message, attribute keys and values, event types, messages and attributes, and at `full` the input and output JSON.      |
| `traceId`                                            | Exact trace id.                                                                                                                                                                                                                                                   |
| `minDurationMs`                                      | A trace's `totalDurationMs`, or a span's `durationMs` (running spans never match).                                                                                                                                                                                |
| `hasErrors`                                          | `true`/`false`: a trace with or without error spans; a span with or without status `error`.                                                                                                                                                                       |
| `parentSpanId`, `depth`                              | `spans` and `stats` only.                                                                                                                                                                                                                                         |
| `page`, `pageSize`                                   | 1-based page (clamped to the last page), page size 1 to 200 (default 25).                                                                                                                                                                                         |
| `sort`                                               | `query` and `export`: `start` (default, the root sequence), `duration` (`totalDurationMs`), `spans` (`spanCount`) or `errors` (`errorCount`, then `deniedCount`); ties by root sequence.                                                                          |
| `order`                                              | `desc` (default) or `asc`, for `sort`; spans always by sequence.                                                                                                                                                                                                  |
| `bucketMs`                                           | `stats` only.                                                                                                                                                                                                                                                     |

`from` and `to` take an ISO 8601 date-time, epoch milliseconds (a number or a decimal string), or a `Date` in process.
A caller that sends a `Date` over HTTP serialises it with `toISOString()` (`2026-02-01T10:00:05.123Z`), which keeps the
milliseconds; `Date#toString()` drops them. Matching traces by any span, as the timeline counts spans, means a timeline
bucket used as `from`/`to` always lists the traces of its spans, follow-up requests and async segments included.

A trace matches the span-level filters (kind through `search`) when **one** of its spans meets all of them. An invalid
`from`, `to`, `page`, `pageSize`, `depth`, `minDurationMs`, `hasErrors` or `bucketMs`, and a `kind`, `status`, `sort` or
`order` outside its vocabulary, throws a `RangeError` with `status: 400`, `code: 'InvalidTraceFilter'` and `parameter`
(the filter name); its message starts with the filter name, and for a vocabulary it lists the allowed values and the
value it got: `status must be one of ok, error, denied, cancelled, running (got "bogus").`

**The search text is bounded and built lazily.** `searchText(record)` joins the metadata, attributes and events (at most
4096 characters) and, at `full`, the input and output JSON (at most 8192 characters), lowercased. The first search that
reads an ended span caches its text (counted in `memoryBytes`); a late `event` or `set` on that span drops the cache, and
a running span is searched as it is. No JSON work happens on the request path for it, so `summary` keeps its cost.

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
  signature, shared access signature, auth value, connection string, SAS, account, subscription and private keys,
  function keys; compared without separators; `sas` and `sig` as whole keys; the exact key `secretName`, which names a
  Key Vault secret and never holds its value, is exempt) become `'[redacted]'`, and so does the
  `value` of a `{ key, value }` pair whose key is credential-named. A Logic Apps `authentication: { type, value }` object
  is therefore hidden whole;
- file and binary columns become `{ bytes, mimetype?, filename?, sha256 }` (the size and SHA-256 of the decoded bytes;
  `mimetype` and `filename` from the sibling `mimetype`, `filename` or `name` members or the data URL): any string under
  `documentbody`; binary data, a data URL or base64 of at least 64 characters under `body` or a key containing `image`;
  and under any key (or as the whole value) a data URL or base64 longer than 1 KB. The `value` of a `{ key, value }` pair
  is judged by its `key`. Base64 means only base64 characters in whole 4-character groups with upper case, lower case and
  a digit, `+` or `/`, so text, a URL, a hex string or a repeated letter stays as it is;
- strings pass `auditText` (`mirage/lib/audit-log.mjs`, shared with the audit log): `Bearer`, `Basic` (a base64 token),
  `Digest` and `SharedAccessSignature` credentials, the `code` and `sig` URL query parameters (`?code=` Azure Functions
  keys, `&sig=` SAS signatures), `name=value` credentials and secret-named FetchXML conditions;
- `URLSearchParams` pass `auditQuery`, which also hides `code` and `sig` parameters;
- dates become ISO strings, other binary data `'[binary N bytes]'`, errors `{ name, code, message }`, maps objects, sets
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
Writes are appended in order, never throw into request handling, and are counted in `status().persist`; `flush()`
waits for them.

## Host helpers

`mirage/lib/trace-hosts.mjs` holds what every host shares:

- `traceSessionKey(contactId, visitorId)`, `ANONYMOUS_ROOT` and `setTraceHeaders(res, span)` (roots).
- `sseClients({ onEmpty, onDrop, now = Date.now, stallMs = 5000, defer })` → `{ add(res), send(message), flush(),
end(), size, [Symbol.iterator] }`, the client set of an SSE channel (D-R3-18). Every frame is written, so a reader that
  keeps up loses nothing however large a burst is. A write that returns `false` starts a wait for `drain`. `send` never
  drops a client on time: a synchronous burst can hold the event loop longer than `stallMs`, and no reader can drain
  while it does. A deferred check (`defer(fn)`; by default a timer of `min(stallMs, 1 s)` followed by `setImmediate`, so
  it runs after the I/O poll of a free loop, and called with `{ late: true }` when it ran more than an interval late)
  looks for progress since the previous check: the bytes the client has taken off its buffer grew, or its socket's libuv
  write queue (`_handle.writeQueueSize`) shrank. The second matters because a corked burst is one writev:
  `writableLength` stays put until the kernel took all of it, while the queue falls as the peer reads. Progress, or a
  late check (the blocked stretch is never counted), restarts the stall clock; a client still waiting that made no
  progress for more than `stallMs` of a free loop is dropped and destroyed. That and a closed response are the only ways
  a client leaves (`onDrop(res, 'stalled' | 'closed' | 'ended')` reports each): a reader whose every frame meets
  back-pressure (frames larger than the socket's high-water mark, small kernel buffers) drains, so it is making
  progress and stays. A refused write is queued, never skipped. `flush()` writes an SSE comment to each client and
  resolves once its callback ran (every earlier frame, the queued ones included, reached the kernel; the response's
  `writableLength` is 0) or the client closed.
- `tracedFetch(traces, { module = 'http', operation, url, init = {}, forwardHeaders = true, capture = 'full', attributes,
fetch })` → the `Response` (D-R3-5). It opens an `http-out` span named `<METHOD> <host><path>` under the current span
  (attributes `method`, `url` without credentials and with secret query values hidden, then `status`), sends
  `traces.headers(span)` when `forwardHeaders`, and at `full` with `capture: 'full'` records the input `{ method, url,
headers, body }` and the output `{ status, headers, body, truncated? }` (a text-like body read from a clone, at most
  `payloadBytes`; never an event stream). `capture: 'none'` records no bodies (binary uploads, sealed values). A status
  of 400 or more goes through `recordHttpError` with the provider's own code and message when the read body carries them
  (`{ error: { code, message } }`, `{ code, message }` or `{ error, error_description }`), else `Http<status>` and the
  status text; a network failure fails the span with the cause's code (`ECONNREFUSED`, ...) and rejects as `fetch`
  does. `fetch` is the implementation to call as `fetch(url, init)` (default `globalThis.fetch`), such as the loopback
  guard of `dataverse-webhooks.mjs`; a synchronous throw from it fails the span and rejects with that same error object.
  Without a store, or at level `off`, it is a plain `fetch(url, init)`.

## Hook-site cookbook

Reach the store as `host.traces` or `store.traces`; it may be absent in a bare `DataStore`, so guard with `?.`.

**A root.** An inbound handler checks `traces.enabled` first, then takes its parent from the headers, so ambient
context never leaks into a new request:

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

**A handled error.** The response writer records what it answers:

```js
function sendError(res, status, code, message) {
  recordHttpError(traces.current(), status, { code, message });
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { code, message } }));
}
```

**A nested operation.** `wrap` for a contained unit of work; it ends or fails the span for you. A create names its
record as soon as the id exists:

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
    span.setEntity(logical, row.id).output(() => row);
    return row;
  },
);
```

Use `start` + `run` + `end` when the end happens elsewhere (a response `finish`, a generator step). Call `fail(error)` in
the `catch` and rethrow; never swallow the failure for the span's sake. A cancelled unit ends with
`end({ status: 'cancelled' })`.

**Only when work happens.** Open a `plugin-stage` span only when steps matched, one `bulk` span per message (never per
row), one `batch` span per `$batch` with one `part` per request, and one span per store read call with a lazily built
query summary.

**Events.** Permission decisions, trace lines, retries, staged jobs, bypass headers and sign-ins are events on the current
span:

```js
traces.current()?.event('permission', { attributes: { table, operation, result: 'deny', model, permissions } });
span.event('trace', { message: line }); // CLR ITracingService, flow trace(), workflow trace(), server logic Logger
traces.current()?.event('job-staged', { attributes: { kind, asyncOperationId } });
dispatch.event('bypass', { attributes: { header, value, skipped: ['sync-plugins'] } });
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
  name: processName, // the process display name alone; trees, the CLI and the view show the kind beside it
  module: 'jobs',
  operation: 'run',
  async: true,
  traceId: remembered?.traceId ?? null, // explicit (even null): the ambient span is never used
  parentSpanId: remembered?.spanId ?? null,
  origin: jobOrigin(traces, remembered?.spanId),
  links: remembered?.spanId ? [{ traceId: remembered.traceId, spanId: remembered.spanId, relation: 'staged-by' }] : [],
  attributes: { kind, jobId: asyncOperationId, attempt, processType, processId, processName },
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

**Outbound HTTP.** A request a host or module sends goes through `tracedFetch`, which opens the `http-out` span and
forwards the headers (the HTTP web hook sender opens its own `http-out` span the same way):

```js
const response = await tracedFetch(traces, {
  module: 'jobs',
  operation: 'callback',
  url,
  init: { method: 'POST', body },
});
// A guarded sender passes its implementation: tracedFetch(traces, { module, url, init, fetch: loopbackFetch }).
```

**Secrets.** A `secret` span records the key name, vault, secret name and the status only; never pass the resolved value
as input, output, attributes or event text.

## Performance contract

| Level     | Cost per hook                                                                                                                                                                                               |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off`     | `start` reads one setting and returns the shared no-op span; `run` calls `fn` directly; no thunk runs, nothing is allocated or retained; roots read `traces.enabled` before any header parsing or lookup.   |
| `summary` | One record and one handle per span, `randomUUID()`, one ISO time, map updates; attribute strings and event messages pass `auditText`. No payload thunk runs, no JSON work, no `structuredClone` in `start`. |
| `full`    | `summary` plus the payload thunks: a redacting deep copy and one `JSON.stringify` per captured value, capped at `payloadBytes`; `tracedFetch` reads at most `payloadBytes` of a cloned response body.       |

At every level: listeners cost nothing while none is subscribed; summary counters and the memory estimate are updated
as spans start and end (no scan), so `status()` reads counters and `query` filters and sorts over the counters, building
summaries and root copies only for the returned page; copies and JSON are built only by queries, listeners and
persistence, and persisted lines are serialised on a later turn with only their new spans; the search text is built by
the first search that needs it, never on the request path; retention is bounded by `traces × spansPerTrace` with
`dropped` and `droppedSpans` counting what was evicted or refused, and the registry by 10,000 keys. Per-row work is an
event with a count, never a span per row; a bulk evaluation is one aggregated event. The single exception is a flow
loop (decision 31): each "Apply to each" or "Do until" iteration keeps its `flow-action` spans, because they are action
executions of the run history, and `spansPerTrace` with the overflow handle bounds them (refused spans count in
`droppedSpans`). Tests never assert speed.

## Surfaces

- **`_sim` routes** (`mirage/lib/sim-trace-routes.mjs`, mounted by both hosts and listed in `status.routes`):
  `GET /_sim/api/trace` (query), `GET /trace/spans`, `GET /trace/stats`, `GET /trace/:traceId` (tree),
  `GET /trace/span/:spanId`, `GET /trace/export`, `GET /trace/settings`, `PUT /trace/settings`, `POST /trace/clear` and
  `POST /trace/flush` (CSRF on mutations; flush answers `status()` once the store flushed); an SSE channel `trace` on
  `/_sim/events?channels=trace`. Every failure is `{ error: { code, message, parameter? } }`; an invalid filter (and an
  export `format` or `limit`) is 400 `InvalidTraceFilter` naming its `parameter`. The OTLP export maps `http` to
  SERVER, `http-out` and `connector` to CLIENT, `webhook` to PRODUCER, `job` to CONSUMER and the rest to INTERNAL,
  `cancelled` to the unset status, and carries `mirage.level` and `mirage.record_id`.
- **CLI** `paqvilo mirage trace list|show <traceId>|spans|stats|settings [--level ...]|clear|flush|export|watch` with
  `--json` and the filters as flags (`--record-id` included). `list` prints the root `DURATION` and the `TOTAL` duration
  that `--sort duration` sorts by, the span, error and denied counts, the host, actor and session; `spans` prints the
  record id and actor. The CLI checks its filters with `checkTraceFilters` before it connects; a filter or setting that
  check or the runtime refuses prints the runtime's own `<code>: <message>` (the `--json` envelope carries `{ code,
message, parameter }`) and exits 2; `Local runtime request failed (<status>)` prefixes only an answer that is not a JSON
  error envelope; other failures exit 1. `watch` applies the same search text to its payload-free frames.
- **In-process** `simulator.trace` is the subset `query`, `spans`, `tree`, `span`, `ancestry`, `stats`, `export`,
  `clear`, `flush`, `settings`, `configure`, `status` and `subscribe` of the store (`traceMethods` in
  `organization-host.mjs`); hook-site members (`start`, `run`, `wrap`, `detached`, `current`, `headers`, `fromHeaders`,
  `remember`, `recall`) stay on `host.traces`. The **testing client** `connectRuntime().trace`
  (`mirage/testing/runtime.mjs`) offers the read, settings, clear, flush and export members over the `_sim` routes,
  serialising a `Date` filter with `toISOString()`; its request errors carry `status`, `code` and `parameter`. A runtime
  that never answered rejects with `RuntimeUnreachable`; one that accepted the connection and closed it before the
  response completed (a reset, `terminated`, a body cut short) rejects with `RuntimeConnectionLost`; both keep the fetch
  error as `cause`.
- **`_sim` view** `#activity` (`mirage/admin/view-activity.mjs`) in the Monitor group: one filter bar that is the page
  address (`result`, `who`, `table`, `recordId`, `host`, `q`, the range and the other trace filters, plus the audit keys
  the old `#audit` links carry), tabs Activities (trace summaries with the audit facts merged by `traceId`), Log stream,
  Findings, Pages & render and Stats, and a detail `#activity/<traceId>[/<spanId>]` with a Why line, a waterfall and
  nested tree, a span drawer with a breadcrumb from `ancestry()`, named parent and link targets and the span's own
  capture level, pivots to related traces and the same record, live following, editable retention settings and the
  export bundle. Flow runs link to `#activity/<traceId>/<traceSpanId>`; flow run, job and plug-in step ids link to their
  `_sim` views; `#trace`, `#audit`, `#logs` and `#evidence` redirect to it. The view shows an invalid filter's
  `InvalidTraceFilter` message and uses the `ui-kit.css` dark theme tokens. See
  [`_sim` administration](../../mirage/docs/sim-administration.md#monitor).

## Monitor

The `_sim` Monitor area reads one spine, the trace store, and links the facts that are not spans to it by `traceId`. The
data side (D-M-4) links; it does not merge. These are its decisions.

1. **Audit and trace link both ways.** The audit ledger stays a ledger of its own: it records at level `off`, keeps its
   sequence windows and backs `connectRuntime().audit`/`exportAudit` and the acceptance proofs. An audited Power Pages
   request's root span sets `attributes.auditId` to its entry id (the `X-Sim-Trace-Id` response header); a Liquid read
   (`liquid-fetchxml`, `entity-read`, `entity-query`) opens its `read` span first, so its entry names that span and the
   span names the entry; a sign-in flow write names the current span. A trace summary has `auditId` (the root's), and
   `auditId` is a span filter (exact) of the store, the routes, the testing client and the bundle: a span matches when it
   names that entry, a trace when any of its spans does. `GET /_sim/api/audit` and `/audit/export` take `traceId`: one id
   or a comma list of at most 200 (more is 400 `InvalidAuditFilter`), so a page of activities joins its entries in one call.
   The Monitor's result filter is `result` (summary status, comma list); `status` keeps matching any span.
2. **`X-Sim-Trace-Id` is an audit id, permanently.** Response headers keep their meaning (`X-Sim-Trace-Id` the audit id,
   `X-Trace-Id`/`X-Sim-Span-Id` the trace). Inbound, only `X-Trace-Id` names a trace; `fromHeaders` resolves
   `X-Sim-Trace-Id` through an index of the retained spans that carry `auditId` (kept by `start` and `set`, dropped with
   their trace), and the Power Pages host also resolves it through the audit ledger, whose entry keeps `traceId` and
   `spanId` after its trace was evicted. An audit id that names nothing is ignored, so a client echoing it starts a new
   trace (or joins the `X-Trace-Id` it sends); the audit id never becomes a trace id.
3. **The log stream has a server-side history.** Every log line goes to a ring of `mirage.logs.retain` lines (default
   2000, 0..50000, `0` keeps none) whether or not anyone listens; serialisation happens only for SSE subscribers. A line
   is `{ sequence, type, time, level, traceId, spanId, ...payload }`: `traceId`/`spanId` are the current span when the
   line is emitted (the audit entry's for `request`/`liquid`/`data`, the finding's for `diagnostic`) and `null` outside
   any span. Types: `startup` (one per startup phase, from `configuration` to `listener-ready`, so the stream answers
   "what happened at startup"), `request`, `liquid`, `data`, `plugin`, `diagnostic`, `reload` (server side now) and the
   stream-only `connected` frame, which names the latest retained sequence and consumes none.
   `GET /_sim/api/logs?since=&limit=&type=&traceId=` answers `{ items, latestSequence, oldestSequence, retained, dropped,
retain, more }`, oldest first (without `since`: the newest `limit`, default 500). A client opens the stream, takes the
   `connected` sequence and merges the history by `sequence`. The SSE frame shape is unchanged apart from the two ids.
4. **A declarative plugin rule is a span event.** `DataStore.applyPlugins` reports each rule that matched the table and
   operation once, through `ruleEvaluated`: a `rule` event `{ rule, table, operation, result: applied|skipped|rejected,
changes, secondaryEffects, code?, message? }` on the current span (the Dataverse span), then the host's
   `onRuleEvaluated` hook, which writes the `plugin` log line. One source of truth; the earlier wrapper, which took a
   `store.snapshot({ sections: ['plugins'] })` on every write while an administrator listened, is gone. Level `off` costs
   one property read per rule.
5. **Findings name their trace.** A runtime diagnostic recorded while a span is current carries `traceId` and `spanId`; a
   request's error handler, which runs after the span stack unwound, names the request's root explicitly. Load, source and
   watcher reload findings carry neither key. `GET /_sim/api/diagnostics?traceId=` narrows both lists.
6. **Request rings and flow runs name their trace.** The portal request ring (`/diagnostics.requests`, the dashboard
   `activity.requests.recent`) has `traceId`; the Dataverse listener ring (`/dataverse/requests`) `traceId` and `spanId`.
   Both stay level-independent ledgers. A flow run view has `traceId` and `traceSpanId` (the run's first `flow-run` span)
   from the registry; a resume the registry does not know (after a restart) is remembered as the run's span. Trace ids
   still never enter `store.state` (decision 7).
7. **Render sources resolve on request.** `GET /_sim/api/render-sources?refs=<id>,…` (at most 100) maps the
   `attributes.sourceRefId` of `render-template` spans to `{ id, path, file, line, column, kind, name, recordId, field,
languageId }` from the portal source index (`sourceEditorTarget` gives the physical line; `null` when the file no
   longer holds the loaded text) and lists unknown ids under `missing`. Render provenance proofs stay token-gated for
   Lense.
8. **The trace channel filters in the store.** `/_sim/events?channels=trace&events=<types>&traceId=<id>`: the channel
   groups clients by filter, each group holding one store subscription with `events`, so a type no client wants is never
   copied; `traceId` narrows a group to one trace. An unknown type answers one `error` frame and ends the stream. The
   Activity list takes `trace-end` only; a live detail takes its own trace's `span-end`.
9. **One export bundle.** `GET /_sim/api/activity/export?<trace filters>&format=bundle[&traces=ndjson|otlp][&limit=]`
   streams NDJSON documents with a `kind`: `bundle` (schema version, export time, the runtime's IANA time zone, the
   filter, the runtime origin, revision, store revision, source and implementation fingerprints, trace settings), then
   `activity` per trace (or one `otlp` document), `audit`, `log` and `finding` items whose `traceId` is a matched trace,
   the verification `evidence` reference, and `end` with the counts. A filter naming nothing but `from`/`to` also takes
   the uncorrelated lines and findings of that range. No archive format: the repository has no dependency-free zip
   writer, and one NDJSON stream is readable line by line. `connectRuntime().exportBundle(filters)` returns the documents
   and `paqvilo mirage trace export --format bundle` prints them; `connectRuntime().logs()` reads the history.
10. **What stays separate.** Health topology and counters (since-start totals, valid at level `off`), the audit ledger
    and the Dataverse ring (level-independent ledgers with public contracts), flow run history (durable domain state),
    verification evidence (another run's output bound to fingerprints) and load-time findings: each is referenced by
    `traceId` where one exists, never copied into the trace store.
