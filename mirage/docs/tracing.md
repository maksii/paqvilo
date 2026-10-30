# Request tracing

Mirage records what a local runtime does for each request as a **trace**: a tree of **spans** that starts at the
inbound HTTP request and nests everything that request caused. Typical spans are the portal Web API call, the Dataverse
operation, its plug-in stages and steps, the SDK calls a plug-in makes, secret resolution, outbound loopback HTTP, the
page render with its templates and reads, and the cloud flows, actions and connector calls that follow. A permission
decision or a plug-in trace line is an **event** on the span where it happened.

Tracing answers questions the request audit cannot: why a save took 900 ms, which plug-in step refused a create, which
flow a row change started and which connector call inside it failed. The audit log keeps its own sanitized request
ledger; each audit entry carries the `traceId` and `spanId` of its request, and the `_sim` audit view links to the
trace.

Tracing is local to one runtime. Every host of that runtime (the Power Pages host, the standalone model-driven or API
host and the Dataverse Web API listener) shares one trace store, so a portal request, the Dataverse request it makes and
the job it stages appear in the same trace. Nothing leaves the machine.

## What is traced

| Kind                                   | Opened by                                                                  | Typical attributes                                   |
| -------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------- |
| `http`                                 | An inbound request on any host (`origin.host` names it)                    | status code, route kind, request and client ids      |
| `webapi`                               | A portal `/_api` request                                                   | entity set, record id, `Prefer`                      |
| `dataverse`, `store`                   | A Dataverse create, update, delete, associate or read; a direct store read | entity, record id, row count                         |
| `permission`                           | A table-permission denial outside any other span                           | table, operation, model                              |
| `plugin-stage`, `plugin-step`          | A pipeline stage with matching steps, and each step                        | stage, mode, rank, depth, SDK call count             |
| `sdk-call`                             | An SDK call made by a plug-in                                              | request name, entity                                 |
| `custom-api`, `workflow`, `bulk`       | A custom API, a classic workflow or a `CreateMultiple`-style message       | binding, handler kind, target count                  |
| `secret`                               | Secret resolution                                                          | key name, purpose, status (never the value)          |
| `http-out`                             | A web hook delivery or another loopback call                               | path, contract, status                               |
| `job`                                  | An asynchronous job: an async plug-in step, a web hook, a flow trigger     | job kind, job id, attempt, chain                     |
| `flow-run`, `flow-action`, `connector` | A cloud flow run, each of its actions, and each connector call             | run id, action path, iteration, connector, operation |
| `render`, `render-template`, `read`    | A page render, each template it includes and each Liquid data read         | page, template, source reference, row count          |
| `native-service`                       | A built-in portal service such as an entity grid                           | service, view or form id, paging                     |

Events record what happened inside a span without a span of its own: `permission` (one per permission decision, with
`result` `allow` or `deny`, and one per filtered query with `result: 'filtered'` and the row counts, never one per
row), `trace` (plug-in `ITracingService` and flow `trace()` lines), `retry`, `page`, `job-staged`, `suspended` and
`flow-trigger-skipped`.

Operations use one vocabulary on every layer, so one filter finds the same work everywhere: a multi-row read is
`retrievemultiple` (a FetchXML read adds the attribute `query: 'fetchxml'`), and a `job` span has the operation `run`
with the job kind in its `kind` attribute. A `render-template` span is named after its source (`webtemplate Order`) or,
for a source without a reference, after its kind and slot (`snippet Head`); a slot whose source is empty still gets a
span with the attribute `empty: true`.

## How a request becomes a trace

Take a portal page whose script creates a row through the Web API, where the table has a synchronous plug-in, an
asynchronous plug-in step and a cloud flow on create that calls a connector. One trace holds all of it:

```text
http      GET /orders/new                       the page request opens the trace
  render  /orders/new                           the page render, its templates and Liquid reads
  http    POST /_api/x_orders                   the script's create, joined through headers
    webapi    POST x_orders
      dataverse   Create x_order
        plugin-stage  Create x_order · PreOperation
          plugin-step   Sample.Plugins.ValidateOrder
            sdk-call      Retrieve x_customer
      job         Sample.Plugins.NotifyOrder (async)    staged-by the create
      job         Flow OrderCreated                     staged-by the create
        flow-run      When an order is created
          flow-action   Send_an_email
            connector     shared_office365/SendEmailV2
```

1. **The page request opens the trace.** `GET /orders/new` starts an `http` root span. The page carries its own ids
   in the runtime script, and the render nests under the root.
2. **The script's create joins it.** Portal pages send `X-Sim-Parent-Trace` and `X-Trace-Id` on same-origin
   `fetch` and `XMLHttpRequest` calls (see [Headers](#headers)), so `POST /_api/x_orders` is a child of the page's
   root span rather than a new trace.
3. **The create runs its pipeline inside its span.** The `webapi` span holds the `dataverse` create; each pipeline
   stage with matching steps is a `plugin-stage`, each step a `plugin-step`, and each SDK call the step makes an
   `sdk-call` under that step. Permission decisions and `ITracingService` lines are events on the span where they
   happened, and the save adds a `commit` event.
4. **Jobs run after the response, in the same trace.** The asynchronous step and the flow trigger are staged at
   commit. Each `job` span is marked `async`, is parented by the span that staged it, and links back to it
   with `staged-by`. On the waterfall these bars start after the request ended. The `job-staged` event sits on that
   same parent span.
5. **The flow nests under its job.** The `flow-run` span holds one `flow-action` per executed action, and each
   connector call is a `connector` span under its action.

The trace ends when its last span ends. The status of its row in the list is the root span's status, and the error
badges count failures anywhere below it: if the flow fails, the page request still reads `ok` with an error badge. Open
the trace and select the red bar.

## Levels

`mirage.trace.level` sets how much each span records. The value in the catalogue or project file is the start value;
the `_sim` **Traces** view, `PUT /_sim/api/trace/settings`, `paqvilo mirage trace settings --level <level>` and
`connectRuntime().trace.configure({ level })` change it on a running runtime without a restart and without touching the
state file.

| Level     | Records                                                                                                                                                     | Cost                                                                                                    |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `off`     | Nothing.                                                                                                                                                    | Each hook reads one setting and returns a shared no-op span. No payload is built.                       |
| `summary` | Every span with its timing, status, actor, session, entity, attributes and events. The default.                                                             | One small record per span. Payload builders never run, and no JSON is serialized while a request runs.  |
| `full`    | `summary` plus redacted inputs and outputs: bodies, queries, plug-in targets and outputs, flow action inputs and outputs, connector parameters and results. | `summary` plus one redacting copy and one JSON size check per captured value, capped at `payloadBytes`. |

Use `summary` for daily work: it shows the shape, the timing and the failure of every request. Switch to `full` while
you investigate one problem, then back. A span only records an input or output when it was opened at `full`.

The other members of `mirage.trace` bound memory:

| Member          | Default | Range          | Meaning                                                                                |
| --------------- | ------- | -------------- | -------------------------------------------------------------------------------------- |
| `traces`        | `500`   | 10 to 10000    | Traces kept in memory; the oldest is dropped first.                                    |
| `spansPerTrace` | `2000`  | 50 to 20000    | Spans kept per trace; later spans of the trace are counted in `droppedSpans` instead.  |
| `payloadBytes`  | `16384` | 256 to 1048576 | Size cap of one captured input or output; a larger value keeps a preview.              |
| `persist`       | `false` | `true`/`false` | Append ended traces to files under the state folder (see [Persistence](#persistence)). |

Summaries, copies and JSON are built only when something reads the store: a query, an export, a live subscriber or
persistence. With no `_sim` view or CLI watching, a trace costs its records and nothing else.

## Reading a trace

Open `/_sim/#trace` (**Traces**, in the **Monitor** group). The filter bar narrows the list by time, kind, module,
operation, entity, status, host, actor, session, visitor, portal, free text, minimum duration and errors. Every filter,
the sort, the open trace and span and a comparison are part of the page address, so a view can be bookmarked or shared
with a teammate who runs the same project. The active filters show as chips above the overview; select a chip's × to
drop that filter. **Live** follows the live channel on either host and reloads the list and the overview at most once a
second as traces end; a runtime that does not serve the channel turns Live off with a notice, and **Refresh traces**
still reads the newest traces.

Each trace row shows the status, the root duration, when the root request started, its name (`POST /_api/accounts`),
where it came from (host, actor and session), the span count with its errors and denials, and the tables involved.
Select the **Started**, **Duration**, **Spans** or **Errors** heading to sort the list by it (`sort=` in the address,
largest or newest first); select it again to reverse the order. The status is `running` while any span runs, otherwise
the root span's status: `ok`, `error`, or `denied` for a 401, a 403 or a permission refusal. The session is the span's
`sessionKey`: `contact:<id>` for a signed-in contact, `visitor:<id>` for a request with the visitor cookie, and empty
otherwise; `visitorId` is the visitor cookie alone. Roots on the standalone host and on the Dataverse listener are
`anonymous` with no session until they authenticate.

Times are shown in your local time, and the timeline axis names the UTC offset. A time range matches a trace when any of
its spans starts in the range, so a timeline bucket that holds only the asynchronous spans of an earlier request still
lists that request.

The trace detail has three readings of the same spans:

- The **waterfall** draws one bar per span, offset from the trace start and as wide as its duration. Bars that sit
  inside their parent ran synchronously within it. A bar marked async starts a job segment, such as an async plug-in
  step or a flow run started by the row change; the follow-up requests a page sends also start after the page's root
  span ended, without being async. Read the waterfall to find where time went.
- The **tree** nests spans by parent. Read it to see what caused what: the request, the Dataverse create, its
  PreOperation stage, the step that ran, the SDK update the step issued, and the PostOperation stage under it.
- **JSON** shows the whole trace as `GET /_sim/api/trace/id/<traceId>` answers it, with **Download trace** and **Copy
  JSON**.

Above the waterfall and the tree, the span search keeps the spans whose name, kind, table, error or attributes contain
the text, and **Only errors and denials** keeps the failing spans; both keep the ancestors of what they match, so the
path to a span stays readable. **Copy id** and **Copy link** in the detail head copy the trace id and the address of the
current view, and the span drawer has **Copy span id**.

Select a span to open its drawer: attributes, the events in order with their offset from the span start, the error code
and message, the redacted input and output (at level `full`), and links. Links connect spans that are related but not
nested: `staged-by` points from a job to the span that staged it, `parent-request` from a browser follow-up to the page
that sent it, and `triggered` from a flow run to the change that triggered it. The pivots in the drawer open the traces
of the same session, the same actor, the same entity, the parent request or the child traces.

To compare two runs of the same work, tick **Compare** on two rows and select **Compare the 2 ticked traces**, or open
`#trace?compare=<traceId1>,<traceId2>`. The two trees show side by side. Spans are matched by their kind and name path
from the root (a repeated span by its position among its siblings), each matched span shows how much longer or shorter
it took in the second trace, and the spans only one trace has are listed. This answers "why did this save take 900 ms
today": the matched span with the largest delta is where the time went.

Durations are wall-clock milliseconds with 0.01 ms precision. `durationMs` of a trace is the root span's duration;
`totalDurationMs` runs from the first span start to the last span end, including asynchronous segments. A trace ends
when its last running span ends; an asynchronous segment that starts afterwards reopens it.

To find a slow or failing request quickly, use the **Overview**: the tiles count the traces, the matching spans with
their p50 and p95 durations, the error and denied spans, and the plug-in steps, flow runs and connector calls. **Root
p50 / p95** are the durations of the root spans of the matching traces, so a filter on a table or a span kind still
shows how long the requests that touched it took. With a time range set, **Root p95 vs before** compares the root p95
with the previous range of the same length. Below the tiles, the timeline counts spans per bucket (errors in red), and
the breakdown gives counts, errors and p50/p95/maximum durations by kind, module, table, operation and actor. Select a
timeline bucket to narrow the time range to it, or **Filter** on a breakdown row to narrow to that value.

**Export filtered traces** downloads the traces the filters match, in the list's order, as NDJSON (one trace per line,
the default), JSON or OTLP JSON. The runtime streams the file and includes at most 200 traces; see
[API](#api) for larger exports.

### What joins and what starts a new trace

- **Loopback calls join; anything else starts fresh.** A request joins a trace only through the [headers](#headers).
  Requests to `/_sim/` itself are not traced.
- **Jobs join the trace that staged them.** Asynchronous plug-in steps, web hook deliveries and flows started by a row
  change are `async` segments of the trace whose save staged them. The runtime keeps which trace and span staged each
  job, and which trace each flow run belongs to for its resumes, in memory only (up to 10 000 entries, cleared with the
  traces), never in the state file: a job that runs after a restart starts a new trace. A job never inherits the span
  of a request that happens to run while the job queue works.
- **Scheduled flow occurrences are new roots.** Each occurrence of a recurrence trigger starts its own trace: a `job`
  root with the attribute `kind: 'flow-schedule'` and the `flow-run` under it. It never joins the trace that
  registered the schedule.
- **In-process Dataverse calls nest.** A Dataverse Web API listener request made in process without trace headers, such
  as the model-driven `Xrm.WebApi` of a form, nests under the span that made it; with headers, the headers decide.
- **A commit is an event, not a span.** A store commit adds a `commit` event to the current span. With no current span
  (job bookkeeping, for example) it records nothing, so the list holds no single-span commit traces.
- **A full trace stays one trace.** Once a trace holds `spansPerTrace` spans, every further span of that trace is
  refused and counted in its `droppedSpans`, and the spans opened under a refused span are refused in the same trace:
  they never start a new trace. The response of a refused request still names its trace in `X-Trace-Id`. At level
  `off` nothing is recorded.
- **Sealed flow runs capture no payloads.** A flow run with a `Secret` parameter or any `secureData` action records
  its spans, statuses and timings, but no input or output on its `flow-run`, `flow-action` and `connector` spans,
  even at level `full`. The child flows it calls and its resumed runs are sealed too.

## Headers

Traces join across loopback HTTP through request headers, and every traced response names its trace:

| Header               | Direction | Meaning                                                                                                |
| -------------------- | --------- | ------------------------------------------------------------------------------------------------------ |
| `X-Trace-Id`         | inbound   | The trace id the new request joins.                                                                    |
| `X-Sim-Trace-Id`     | inbound   | The trace id the new request joins when `X-Trace-Id` is absent.                                        |
| `X-Sim-Parent-Trace` | inbound   | The span the request belongs under: a span id, or an earlier request's audit entry id (its root span). |
| `X-Trace-Id`         | response  | The trace id of this request, on every host including the Dataverse Web API listener.                  |
| `X-Sim-Span-Id`      | response  | The root span id of this request.                                                                      |
| `X-Sim-Trace-Id`     | response  | The request's audit entry id on the Power Pages host (`connectRuntime` sessions read it as `traceId`). |

A client that sends back the trace headers of a response joins that response's trace. Portal pages send
`X-Sim-Parent-Trace` and `X-Trace-Id` on same-origin `fetch` and `XMLHttpRequest` calls unless the script sets them
itself, so the Web API calls a page script makes join the page's trace. Web hook deliveries and the flow HTTP provider
forward the headers of the current span on loopback calls.

An inbound value that is not a UUID (32 hexadecimal digits in the `8-4-4-4-12` form) is ignored, and the request
starts a new trace; a request can never choose a word such as `stats` as its trace id. When `X-Sim-Parent-Trace` names
a retained span, that span's trace wins over a different `X-Trace-Id`. When it names a span that is not retained but
`X-Trace-Id` names a retained trace, the request joins that trace one level under its root, with a `parent-request`
link to the span it named. When neither is known, the request starts a new trace, named by `X-Trace-Id` when it is
present, and keeps that `parent-request` link.

## API

Both hosts serve these routes under `/_sim/api` and list `/trace` in `status.routes`. Reads are `GET`; `PUT` and `POST`
need the `x-sim-csrf` header with the administration token.

| Route                     | Answer                                                                                                                                                                                                                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /trace`              | `{ items: [trace summary], total, page, pageSize, pageCount, retained, dropped, latestSequence }`, in the `sort` and `order` asked for.                                                                                                                                                               |
| `GET /trace/spans`        | The same envelope with span records as `items`, in sequence order.                                                                                                                                                                                                                                    |
| `GET /trace/stats`        | `overall` (the matching spans) and `roots` (the root spans of the matching traces) as `{ count, errors, p50, p95, max }`; the same figures by kind, module, entity, operation, actor and status; the timeline; the slowest and the latest error spans. Percentiles are nearest-rank over ended spans. |
| `GET /trace/export`       | The matching traces as a streamed attachment, in the list order, at most `limit` of them; see [Export](#export).                                                                                                                                                                                      |
| `GET /trace/id/<traceId>` | `{ trace, root, spans, children }`: the summary, the root, the spans in order and the nested tree. 404 `TraceNotFound` when not retained.                                                                                                                                                             |
| `GET /trace/<traceId>`    | The same for a UUID-shaped id. Any other id answers 404 `TraceNotFound`: read it at `/trace/id/<traceId>`, so that no trace id competes with a named route.                                                                                                                                           |
| `GET /trace/span/<id>`    | One span record. 404 `SpanNotFound` when not retained.                                                                                                                                                                                                                                                |
| `GET /trace/settings`     | `{ settings, status }`: the settings in force and the store status (retained, spans, running, dropped, memory estimate, listeners, persistence).                                                                                                                                                      |
| `PUT /trace/settings`     | Applies a partial settings change, such as `{ "level": "full" }`, and answers `{ settings, status }`. An invalid value is 400 `InvalidTraceSettings` and keeps the old settings.                                                                                                                      |
| `POST /trace/clear`       | Drops every retained trace and answers the store status.                                                                                                                                                                                                                                              |

The Infrastructure view (`GET /_sim/api/dashboard`) shows the trace store as the `org:trace` node with its level and
persistence, and its counters (`retained`, `spans`, `running`, `dropped`, `droppedSpans`, `latestSequence`) as
`activity.trace`.

The list, spans, stats and export routes take the same query parameters:

| Parameter                                                              | Matches                                                                                                             |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `from`, `to`                                                           | ISO time or epoch milliseconds; a trace when any of its spans starts in the range, a span by its own start.         |
| `kind`, `module`, `operation`, `entity`, `status`, `host`, `actorKind` | Case-insensitive equality (`host` is the origin host).                                                              |
| `actorId`                                                              | Equality ignoring braces and case.                                                                                  |
| `sessionKey`, `visitorId`, `portal`                                    | Exact equality (`sessionKey` is `contact:<id>` or `visitor:<id>`).                                                  |
| `search`                                                               | Case-insensitive text in the name, entity, error and attributes.                                                    |
| `traceId`                                                              | One trace.                                                                                                          |
| `minDurationMs`                                                        | A trace's total duration or a span's duration (running spans never match).                                          |
| `hasErrors`                                                            | `true` or `false`.                                                                                                  |
| `parentSpanId`, `depth`                                                | Spans and stats only.                                                                                               |
| `page`, `pageSize`, `order`                                            | 1-based page, 1 to 200 per page (default 25), `desc` (default) or `asc`.                                            |
| `sort`                                                                 | The trace list and export: `start` (default, the order the roots started), `duration` (total), `spans` or `errors`. |
| `bucketMs`                                                             | Stats timeline bucket; chosen automatically for at most 60 buckets when absent.                                     |
| `format`, `limit`                                                      | Export only: `json` (default), `ndjson` or `otlp`, and at most `limit` traces (default 200, 1 to 2000).             |

A trace matches when one of its spans meets every span filter, so `kind=plugin-step&status=error` lists the traces with
a failing plug-in step. An invalid value answers 400 `InvalidTraceFilter` with a message that starts with the parameter
name. A runtime without a trace store answers 501 `TraceNotConfigured`.

### Export

`GET /trace/export` writes one trace at a time, so a large export never sits in memory as one document. The
`X-Trace-Export-Matched` header gives the number of matching traces; when it is above `limit`, narrow the filters or
raise `limit`.

| `format`         | Attachment                   | Content                                                                                     |
| ---------------- | ---------------------------- | ------------------------------------------------------------------------------------------- |
| `json` (default) | `simulator-traces.json`      | `{ exportedAt, settings, traces: [tree] }`, each tree as `GET /trace/id/<traceId>` answers. |
| `ndjson`         | `simulator-traces.ndjson`    | One `{ trace, spans }` line per trace: the summary and the flat spans.                      |
| `otlp`           | `simulator-traces.otlp.json` | OTLP/JSON `resourceSpans`, for a viewer that reads OpenTelemetry traces.                    |

The OTLP mapping keeps every span of every exported trace under one resource (`service.name: paqvilo-mirage`):

- **Ids.** The trace id is the 32 hexadecimal digits of the trace UUID; the span id is the first 16 hexadecimal digits
  of the SHA-256 of the span id. The same span gets the same OTLP id on every export, so parents and links hold. The
  original ids stay in the `mirage.trace_id` and `mirage.span_id` attributes.
- **Kind.** `http` spans are SERVER, `http-out` and `connector` spans CLIENT, `job` spans CONSUMER, every other kind
  INTERNAL.
- **Attributes.** The span attributes, plus `mirage.kind`, `mirage.module`, `mirage.operation`, `mirage.entity`,
  `mirage.record_id`, `mirage.status`, `mirage.async`, `mirage.depth`, `mirage.host`, `mirage.portal`,
  `mirage.actor.kind`, `mirage.actor.id`, `mirage.session.key`, `mirage.session.visitor_id`, and at level `full` the
  redacted `mirage.input` and `mirage.output` as JSON text.
- **Events, links and status.** Events keep their type, time, message and attributes. Links keep their relation as
  `mirage.relation`. The status is OK for `ok`, ERROR with the error message for `error` and `denied`, and UNSET for a
  span that still runs.

### Live channel

Both hosts also serve `GET /_sim/events?channels=trace`: server-sent `event: trace` frames. The first is
`{ type: 'connected', status }`, then `{ type: 'span-start' | 'span-end' | 'trace-end', span, trace? }` as spans start
and end. Frames never carry captured inputs or outputs; read the trace for them. A `trace-end` frame carries
`trace.evicted: true` for a trace that left the store while it still ran. Frames are built only while a subscriber is
connected. A client that disconnects, even before its first frame, leaves no subscription behind, and a client that
stops reading is disconnected once three writes in a row find its buffer full (an `EventSource` reconnects by itself).

### Testing client and in-process handle

`connectRuntime()` from `paqvilo/mirage/testing` has a `trace` member over these routes: `query(filters)`,
`spans(filters)`, `tree(traceId)`, `span(spanId)`, `ancestry(spanId)`, `stats(filters)`, `export(filters)`,
`settings()`, `status()`, `configure(partial)`, `clear()` and `subscribe(listener, { signal })`.

- Filters are plain objects. A `Date` is sent as its ISO time with milliseconds, and `undefined` or `null` members are
  left out.
- `tree` and `span` answer `null` for an id that is not retained, and `ancestry` answers `[]`; `ancestry` lists the
  spans from the root down to the span.
- `export({ format })` answers the parsed document for `json` and `otlp`, and the array of `{ trace, spans }` lines for
  `ndjson`.
- `subscribe` follows the live channel: the listener receives every frame, `connected` first. It returns an
  `unsubscribe()` function whose `closed` promise resolves when the stream ends (unsubscribe, the signal, or the runtime
  stopping) and rejects when the stream cannot be opened or the listener throws.
- A runtime that does not answer rejects with the code `RuntimeUnreachable`. Writes send the CSRF token for you.

The in-process handle from `createSimulator` exposes the store itself as `simulator.trace`. It answers the same reads
synchronously (`query`, `spans`, `tree`, `span`, `ancestry`, `stats`, `export`, `settings`, `status`, `configure`,
`clear`), and its `subscribe(listener, { payloads })` delivers frozen event copies, with captured payloads unless
`payloads: false`. It also has what instrumentation uses: `start`, `run`, `wrap`, `current`, `headers`, `fromHeaders`,
`detached`, `remember`, `recall`, and `flush`, which resolves when the queued persisted lines are written.

```js
import { connectRuntime } from 'paqvilo/mirage/testing';
const sim = await connectRuntime({ origin: 'http://127.0.0.1:8787' });
await sim.trace.configure({ level: 'full' });
const visitor = sim.createSession();
await visitor.json('/_api/contacts', { method: 'POST', body: { firstname: 'Ada' } });
const { items } = await sim.trace.query({ kind: 'plugin-step', hasErrors: true });
const tree = items.length ? await sim.trace.tree(items[0].traceId) : null;
```

Assert on what a trace contains (the spans, their nesting, their status and error codes), never on how long they took.

## CLI

`paqvilo mirage trace <action>` reads the trace store of a running runtime. Select the runtime with
`--origin http://127.0.0.1:<port>` or with `--config FILE --site ID`, which finds the runtime owned by that site the
way `connectRuntime` does.

| Action          | Prints                                                                                                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list`          | One row per trace: start, status, duration, span and error counts, host, name, trace id.                                                                                |
| `show TRACE_ID` | The trace summary and its span tree, one indented line per span, with errors.                                                                                           |
| `spans`         | One row per span: start, kind, status, duration, entity, name, span id.                                                                                                 |
| `stats`         | The overall and root figures (count, errors, p50, p95, max), the same figures by kind, then the slowest spans. A percentile with no ended span prints `—`.              |
| `settings`      | The settings in force and the store status; `--level`, `--persist`, `--traces`, `--spans-per-trace` and `--payload-bytes` change them.                                  |
| `clear`         | Drops every retained trace.                                                                                                                                             |
| `export`        | The matching traces as the runtime streams them, in `--format json` (default), `ndjson` or `otlp`, at most `--limit N` (default 200, at most 2000); redirect to a file. |
| `watch`         | One line per ended span as it happens, or per ended trace with `--trace-end`, until Ctrl+C, `--count N` lines or the runtime stopping.                                  |

The filters are flags with the parameter names in kebab case: `--from`, `--to`, `--kind`, `--module`, `--operation`,
`--entity`, `--status`, `--host`, `--actor-kind`, `--actor-id`, `--session-key`, `--visitor-id`, `--portal`, `--search`,
`--trace-id`, `--parent-span-id`, `--depth`, `--min-duration-ms`, `--has-errors`, `--page`, `--page-size`, `--order`,
`--sort` and `--bucket-ms`. They apply to `list`, `spans`, `stats` and `export`; on `clear`, `settings` and `show` they
are refused.

`watch` takes the same filters except the paging and ordering flags, and applies them to each frame it receives: to
the ended span, or with `--trace-end` to the ended trace. For a trace, `--kind`, `--module` and `--entity` match any
span of it, `--status error` and `--status denied` match a trace with such a span, `--min-duration-ms` and
`--has-errors` match the whole trace, and the other filters match its root span. The runtime checks the values first,
as it does for `list`. When the runtime stops, or on Ctrl+C, `watch` prints `stream ended` on stderr and exits 0.

`--json` prints one envelope for every action: `{ schemaVersion: 1, ok: true, command, result }`. `result` is what the
matching route answers: the page envelope for `list` and `spans`, the tree for `show`, the stats document for `stats`,
`{ settings, status }` for `settings`, the store status for `clear`, and the export document for `export` (the array
of lines with `--format ndjson`). `watch --json` prints one envelope per line, with the frame as `result`. A failure
prints `{ schemaVersion: 1, ok: false, command, error: { code, message } }` (without `--json`, the message on stderr)
and exits 1:

| Code                   | Meaning                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------ |
| `InvalidArguments`     | A flag, action, origin or argument the command refuses before it connects.                             |
| `RuntimeUnreachable`   | No runtime answers at the origin.                                                                      |
| `TraceNotFound`        | `show` names a trace that is not retained.                                                             |
| `InvalidTraceFilter`   | The runtime refused a filter, sort, format or limit; the message starts with the parameter name.       |
| `InvalidTraceSettings` | The runtime refused a settings change.                                                                 |
| `MIRAGE_FAILED`        | Any other failure. Other runtime codes, such as `TraceNotConfigured`, are passed through as they come. |

```sh
node bin/paqvilo.mjs mirage trace list --origin http://127.0.0.1:8787 --has-errors true --sort duration
node bin/paqvilo.mjs mirage trace show 2f0c4c1e-6f8a-4d1b-9a43-4d3a1f1d2c11 --origin http://127.0.0.1:8787
node bin/paqvilo.mjs mirage trace settings --level full --origin http://127.0.0.1:8787
node bin/paqvilo.mjs mirage trace export --entity contact --format ndjson --origin http://127.0.0.1:8787 > traces.ndjson
node bin/paqvilo.mjs mirage trace watch --kind plugin-step --status error --origin http://127.0.0.1:8787
```

## Persistence

With `persist: true`, ended traces are appended as JSON lines to `<state folder>/traces/<yyyy-mm-dd>.ndjson` (the UTC
date of the write). The state folder is the folder of the runtime's state file: `.paqvilo/` by default, which is
ignored. A state file outside `.paqvilo/` puts `traces/` next to it, outside the ignored folder.

A line is `{ persistedAt, traceId, trace: summary, spans: [record], complete }`. `spans` holds the spans added since
the previous line of that trace, plus any span the previous line wrote while it still ran, so a trace that reopens for
asynchronous segments adds small lines. To rebuild a trace, read its lines in order and keep the latest record of each
span id and the latest summary. `complete` is `false` when a span still ran as the line was written. That happens when
a trace leaves memory while it runs (the oldest trace is dropped first): it is written at once, its `trace-end` frame
carries `trace.evicted: true`, and it is written again when its last span ends.

Lines are built after the response is sent, never while it is written. Writes are queued in order and never fail a
request; the settings status reports the directory, the lines written, the failures and the last error. A runtime
without a state folder (memory-only state or `--simulation dry-run`) accepts `persist: true` but writes nothing and
reports `lastError: 'NoStateDirectory'`, which the Traces settings panel and `trace settings` show. Persisted traces
are not read back on restart: the files are for your own analysis. Delete them like any other local state.

## Privacy and redaction

- Inputs and outputs are captured only at level `full`, and always through the same redaction. Values under
  credential-named keys (passwords, secrets, tokens, authorization and authentication, cookies, credentials, API keys,
  signatures, connection strings, SAS and shared access signatures, account and function keys) become `[redacted]`,
  and so do the `sig` and `code` URL query parameters. In text, `Bearer`, `Basic`, `Digest` and
  `SharedAccessSignature` credentials, `name=value` credentials and signed URL query strings (`?code=`, `&sig=`) are
  masked, and secret-named FetchXML conditions are hidden.
- Secret resolution records the key name and the status only. Secret values, bearer tokens, cookies, request headers
  and sealed (secure) flow inputs and outputs are never stored.
- Attribute strings and event messages pass the same text redaction at every level. Live frames never carry inputs or
  outputs.
- Traces live in the runtime's memory, and on disk only with `persist: true` in the state folder. Treat an export like
  any other local evidence: it can contain business data at level `full`, so keep it out of source control.
