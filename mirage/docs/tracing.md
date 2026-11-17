# Request tracing

A **trace** is everything one local request caused: a tree of **spans** that starts at the inbound HTTP request and
nests the Web API call or form submit, the Dataverse operation, its plug-in stages, steps and SDK calls, the page render,
outbound HTTP, and the jobs and cloud flows that follow with their actions and connector calls. A permission decision, a
plug-in trace line or a sign-in is an **event** on the span where it happened.

Every host of one runtime shares one trace store: the Power Pages host, the standalone host with its model-driven,
canvas and code apps, the Dataverse Web API listener (with SOAP and TDS), the local identity provider and a SharePoint
contract fixture server started with the store. A portal request, the Dataverse request it makes and the job it stages
are one trace. Nothing leaves the machine. The request audit stays a separate ledger: each audit entry carries the
`traceId` and `spanId` of its request, and the root span names its entry in the attribute `auditId`.

## Levels

`mirage.trace` sets the level and the memory bounds. The value in the catalogue or project file is the start value; the
`_sim` **Activity** view's **⚙ Settings**, `PUT /_sim/api/trace/settings`,
`paqvilo mirage trace settings --level <level>` and `connectRuntime().trace.configure({ level })` change any member on
a running runtime without a restart and without touching the state file. Unknown keys are refused.

```yaml
mirage:
  trace:
    level: summary
    traces: 500
    spansPerTrace: 2000
    payloadBytes: 16384
    persist: false
```

| Member          | Default   | Range                    | Meaning                                                                                      |
| --------------- | --------- | ------------------------ | -------------------------------------------------------------------------------------------- |
| `level`         | `summary` | `off`, `summary`, `full` | See below.                                                                                   |
| `traces`        | `500`     | 10 to 10000              | Traces kept in memory; the least recently active is dropped first (at once when lowered).    |
| `spansPerTrace` | `2000`    | 50 to 20000              | Spans kept per trace; later spans of that trace are refused and counted in `droppedSpans`.   |
| `payloadBytes`  | `16384`   | 256 to 1048576           | Cap of one captured input or output; a larger value becomes `{ truncated, bytes, preview }`. |
| `persist`       | `false`   | `true`, `false`          | Append ended traces to the state folder (see [Persistence](#persistence)).                   |

| Level     | Records                                                                                                                                                                | Cost                                                                          |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `off`     | Nothing. Roots read no trace header; Activity lists the request audit instead.                                                                                         | One setting read per hook.                                                    |
| `summary` | Every span with timing, status, actor, session, entity, record, attributes and events.                                                                                 | One small record per span; no payload is built, no JSON while a request runs. |
| `full`    | `summary` plus redacted inputs and outputs: bodies, queries, plug-in targets, images, shared variables, messages, flow action and connector payloads, canvas formulas. | One redacting copy per captured value, capped at `payloadBytes`.              |

Use `summary` for daily work and `full` while you investigate one problem. A span records an input or output only when
it was opened at `full`, and keeps the level it was opened at as `level`. Summaries, copies and JSON are built only when
something reads the store (a query, an export, a live subscriber or persistence).

## Reading a trace

In `/_sim/#activity` a trace is an **activity** and a span a **step**;
[`_sim` administration](sim-administration.md#activity) describes the workspace, its filters and tabs.

- **Result.** `running` while any step runs. An ended activity reads `error` or `denied` when its root or any step ended
  so (the root's own error or denial first, then `error` before `denied`), else the root's status. A page that answered
  HTTP 200 while a plug-in step refused the save reads `error` with a `root ok` badge. An activity is **failed** when its
  result is `error` or `denied`, or, while it runs, as soon as a step failed; the **Result** filter
  (`result=error,denied`), the **Failed** filter and the **Errors & denied** quick filter select failed activities.
- **Browser probes.** A browser's own `GET` or `HEAD` for `/favicon.ico`, `/apple-touch-icon[-WxH][-precomposed].png` or
  `/.well-known/appspecific/com.chrome.devtools.json` has the root attribute `browserProbe: true`. A 404 to one is not a
  failure: it reads `ok` (`browser probe`), and its root keeps `error` with the 404.
- **Compare.** `#activity?compare=<traceId1>,<traceId2>` matches steps by kind and name path and shows each step's
  duration delta.

A span is dated by the wall clock and timed on a monotonic clock in 0.01 ms steps, so a
clock change never gives a negative duration. `durationMs` of a trace is the root's; `totalDurationMs` runs from the
first span start to the last span end, async segments included. A trace ends when its last running span ends; an async
segment that starts later reopens it.

Example: a page whose script creates a row, with a synchronous plug-in, an async step and a flow on create:

```text
http      GET /orders/new
  render  /orders/new
  http    POST /_api/x_orders                   joined through the page's headers
    webapi    POST x_orders
      dataverse   Create x_order
        plugin-stage  Create x_order · PreOperation
          plugin-step   Sample.Plugins.ValidateOrder
            sdk-call      Retrieve x_customer
      job         Order async follow-up         async, staged-by the create
      job         When an order is created      async, staged-by the create
        flow-run      When an order is created
          flow-action   Send_an_email
            connector     shared_office365/SendEmailV2
```

## What is traced

| Kind                                   | Opened by                                                                                      | Typical attributes                                     |
| -------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `http`                                 | An inbound request on any host (`origin.host` names it), and each TDS statement                | status code, query, content type and length            |
| `webapi`                               | A portal `/_api` request                                                                       | entity set, record id, `Prefer`, file transfer         |
| `form`                                 | A portal basic or advanced form submission                                                     | form, form kind, mode, button, step                    |
| `dataverse`, `store`                   | A Dataverse create, update, delete, associate or read; a direct store read                     | entity, record id, row count, page, query kind         |
| `function`, `action`                   | A Dataverse function or action: `WhoAmI`, `RetrieveTotalRecordCount`, custom APIs and messages | message, bound table                                   |
| `bulk`                                 | One `CreateMultiple`, `UpdateMultiple`, `UpsertMultiple` or `DeleteMultiple` (SDK or Web API)  | message, table, target count, Web API action           |
| `batch`, `changeset`, `part`           | A Web API `$batch`, each change set in it and each request in it                               | parts, change sets, content id, rolled back            |
| `permission`                           | A table-permission denial outside any other span                                               | table, operation, model                                |
| `plugin-stage`, `plugin-step`          | A pipeline stage with matching steps, and each step                                            | stage, mode, rank, depth, SDK call count               |
| `sdk-call`                             | An SDK call made by a plug-in                                                                  | request name, entity, record id                        |
| `custom-api`, `workflow`               | A custom API, a classic workflow                                                               | binding, handler kind                                  |
| `server-logic`                         | A Power Pages server logic run                                                                 | server logic, function, method                         |
| `secret`                               | Secret resolution                                                                              | key, vault, secret name, version, status (never value) |
| `http-out`                             | An outbound HTTP request: a web hook delivery, server logic `HttpClient`, sign-in, storage, …  | method, URL, status                                    |
| `webhook`                              | A Service Bus queue or topic delivery                                                          | transport, channel, queue, message id                  |
| `job`                                  | An asynchronous job, a background operation or a scheduled flow occurrence                     | job kind, process type, id and name, attempt           |
| `flow-run`, `flow-action`, `connector` | A cloud flow run, each of its actions, and each connector call                                 | run id, action path, connector, operation              |
| `render`, `render-template`, `read`    | A page render, each template it includes and each Liquid data read                             | page, template, source, row count                      |
| `native-service`                       | A built-in portal service such as an entity grid                                               | service, view, saved query, row count                  |
| `canvas`                               | A canvas app action: `start`, `select <control>.OnSelect`, `run <formula>`                     | app, action, control, property, screen                 |
| `internal`                             | Anything else (the default kind)                                                               |                                                        |

A span ends `ok`, `error` (an exception, fault or HTTP error answer), `denied` (a permission refusal or a 401/403) or
`cancelled` (a cancelled flow run or action; neither an error nor a denial); it is `running` until then.

| Event                                                | Where and what                                                                                                                                                                                                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `permission`                                         | One per decision (`result` `allow`/`deny`, `table`, `operation`, `model`, deny `code`), one per filtered query (`result: 'filtered'` with row counts) and one per bulk evaluation (`result: 'evaluated'`, `tables`, `allowed`, `denied`). Never one per row. |
| `commit`                                             | A store commit on the current span. With no current span a commit records nothing.                                                                                                                                                                           |
| `trace`                                              | A plug-in `ITracingService` line, a flow or classic workflow `trace()` line, a server logic `Logger` line (with `level`).                                                                                                                                    |
| `diagnostic`                                         | A server logic worker diagnostic, with its `code`.                                                                                                                                                                                                           |
| `bypass`                                             | An `MSCRM.BypassCustomPluginExecution` or `MSCRM.BypassBusinessLogicExecution` header on the dispatch span: `header`, `value`, `skipped` (`['sync-plugins']` when the local pipeline skipped the synchronous stages, else `[]`).                             |
| `signIn`                                             | A sign-in on the request root: `provider` (`local`, `persona` or the external provider) and `contactId`.                                                                                                                                                     |
| `job-staged`                                         | A job staged by the span: its kind and job id.                                                                                                                                                                                                               |
| `rows`                                               | The row count of a many-row job (BulkDelete, rollup mass calculation, elastic time-to-live purge) instead of a span per row.                                                                                                                                 |
| `cascade`, `business-rule`                           | A cascaded Assign on the assigning write; a business rule run with its mode, changed columns and error.                                                                                                                                                      |
| `retry`, `page`, `suspended`, `flow-trigger-skipped` | A job retry, a paged read, a suspended flow run, a skipped flow trigger.                                                                                                                                                                                     |

Under a `bulk` span the row decisions aggregate into one evaluated `permission` event, one `commit` event and the first
denial, with counts in the attributes `permissions` and `commits`. Operations use one vocabulary on every layer: a
multi-row read is `retrievemultiple` (a FetchXML read adds `query: 'fetchxml'`), a function or action span has its
lowercased message, and a `job` span has operation `run`.

## What each span records

A span record, as the routes and the in-process handle return it:

```js
{
  traceId, spanId, parentSpanId, sequence, // sequence: store-wide, increasing
  kind, name, module, operation, entity, recordId,
  startedAt, durationMs,      // ISO time; null while running
  status, level, depth, async, // async: true on the span that starts a job segment
  actor,    // { kind: 'anonymous'|'contact'|'staff'|'app'|'client'|'caller'|'system'|'flow'|'plugin', id, name, roles? }
  session,  // { visitorId, sessionKey }: 'contact:<id>' signed in, else 'visitor:<id>', else null
  origin,   // { host, portal, preset }
  attributes,
  events,   // [{ offsetMs, type, message?, attributes? }], at most 1000 (attributes.droppedEvents counts the rest)
  links,    // [{ traceId, spanId, relation: 'staged-by' | 'triggered' | 'parent-request' }]
  input, output, // level full only, redacted
  error,    // { code, message, status?, type?, action?, parameter?, pluginType?, step?, stage?, depth?, rolledBack?, details?, cause? }
}
```

`actor`, `session` and `origin` default to the parent's. Every span that acts on one row names it: `entity` is the
logical name and `recordId` the row id. A create names its record once the id is assigned, before its PostOperation
stage, so PostOperation steps, staged jobs and web hooks name the same row; plug-in, job, web hook, workflow, Liquid
entity read, form and row-triggered flow spans copy it from their target. Filter on `recordId` to find every span that
touched one row.

### Roots and hosts

| `origin.host`       | Roots                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| `power-pages`       | Portal pages, `/_api`, forms, sign-in, files and the other portal routes.                        |
| `standalone`        | The standalone host's own routes and its flow routes.                                            |
| `model-driven`      | `/main.aspx` and the model-driven shell's `/_apps` routes, including its in-app Web API.         |
| `canvas`            | `/_apps/canvas*` and `/_apps/api/canvas/*`.                                                      |
| `code-app`          | `/_apps/code*`.                                                                                  |
| `dataverse-api`     | The Dataverse Web API listener.                                                                  |
| `soap`              | The Organization Service SOAP endpoint of the listener.                                          |
| `tds`               | One root per TDS (SQL) statement.                                                                |
| `identity-provider` | The local identity provider (module `identity`).                                                 |
| `sharepoint`        | A fixture server started with `createSharePointFixtureServer({ traces })` (module `sharepoint`). |
| `job`               | Every `job` span, with the portal and preset of the span that staged it.                         |
| `sim`               | `/_sim/api` administration writes; the default host of flow routes whose host names none.        |

A root records `query` (credential values hidden), `contentType` and `contentLength`, and at `full` the input
`{ query, contentType, body }`. A Dataverse listener root keeps, at `full`, `{ query, headers, body }` with the headers
that change the answer (`Prefer`, `If-Match`, `If-None-Match`, the bypass and caller headers). A root that writes its
own error answer (JSON envelope, SOAP fault, text) records that code and message. A refused listener bearer records
`The request carries no access token.` or `The access token was refused (<reason>).`

The root actor is a signed-in `contact` (full name, else first and last name, else email), a `staff` user on the
model-driven, canvas and code-app hosts, an `app` or `client` for a token client, `anonymous` until the request
authenticates, or `system` (named `simulator`) for `/_sim/api` writes. Descendants carry the root's actor.
Administration reads and the trace routes open no root.

### Portal pages, forms and sign-in

- **Visitors.** An anonymous browser's first page `GET` sets the visitor cookie, so later requests have the session key
  `visitor:<id>`. Sign-in, sign-out and external sign-in routes start none.
- **Sign-in.** Sets the root actor to the contact and adds a `signIn` event; contact and identity writes are `dataverse`
  spans. An external sign-in's metadata, token and user-info requests are `http-out` spans (module `identity`; the token
  request records no bodies).
- **Forms.** One `form` span (`Basic form <name>` or `Advanced form <name>`, operation `submit`) above its Dataverse
  operation: `form`, `formId`, `formKind`, `mode`, `button`, `stepId`, `native`, `formOperation`, `outcome`; at `full`
  the submitted values.
- **Files.** `transfer` (`upload`, `download`, `delete`, `upload-block`), `fileColumn`, `fileName`, `fileSize`,
  `mimetype`; never the bytes.
- **Renders.** A `render-template` span is named by its source (`webtemplate Order`), a runtime template by its include
  name (`builtin entity_list`), a missing include `missing <name>`, nested Liquid by its slot (`snippet Head`,
  `inline liquid`, `editable`, `liquid filter`, `page copy layout`); an empty slot has `empty: true`. A Liquid read is a
  `retrieve` (with `recordId`) or `retrievemultiple` with `source` (`liquid-fetchxml`, `entity-read`, `entity-query`),
  and at `full` the query and rows.
- **Grids.** An entity grid `native-service` span names its table, `view`, `savedquery`, `rowCount` and `itemCount`.
- **Server logic.** A `server-logic` span (`Server logic <name>`, operation the lowercased function) with input
  `{ function, method, body, input, query }` and the result at `full`; `HttpClient` requests are `http-out` children.

### Dataverse operations

- **Dispatch.** Every level: `statusCode`, `rowCount`, `pageNumber` and `query` (`odata`, `fetchxml`, `savedquery`,
  `userquery`, `apply`, `delta`). At `full`: input `{ body, query, headers }` and output
  `{ id, rowCount, totalCount, moreRecords, statusCode }`.
- **Functions and actions.** Built-in functions (`WhoAmI`, `RetrieveVersion`, `RetrieveCurrentOrganization`,
  `RetrieveTotalRecordCount`, `RetrieveMetadataChanges`), access messages (`RetrievePrincipalAccess`,
  `RetrieveUserPrivileges`, `GrantAccess`, `ModifyAccess`, `RevokeAccess`), custom functions and actions and flow
  connector messages open a span named by the message (and bound table), with parameters and answer at `full`. A message
  run through the internal entry carries `systemUserId`; the actor stays the caller's.
- **Bulk.** One `bulk <Message> <table>` span with `message`, `table`, `entity`, `targets`, `action` (Web API) and the
  created ids as output; per-target `dataverse` children only where the pipeline runs per target.
- **`$batch`.** A `batch` span (`parts`, `changesets`, `requests`, `json`, `continueOnError`, `statusCode`), a
  `changeset <n>` span per change set and a `part` per request (`method`, `contentId`, `statusCode`; request and answer
  at `full`). A rolled-back change set ends `error` with `rolledBack: true` and `failedContentId`; parts that ran before
  carry `rolledBack: true`. The error also reaches the batch span and the root.
- **SOAP.** The root carries `soapOperation`, `message` and `query` (`fetchxml`, `queryexpression`). Each message
  (including `ExecuteMultiple` and `ExecuteTransaction` items) is a `dataverse` span `<Message> <table>` with
  `recordId` and `requestIndex`. A fault records its code, message, `errorCode` and `faultedRequestIndex` on the root.
- **TDS.** Each statement is an `http` root (operation `query`) named by its text with literals as `?`, with `sql`,
  `statementType`, `line`, `rowCount` and `resultSets`; entity reads are children. At `full` it keeps the raw text,
  parameters and result shapes. An unparsable batch is one `SQL batch` root with the SQL error number.

### Plug-ins

- **Steps.** At `full` the input is `{ target, inputParameters, preImages, postImages, sharedVariables, context }`:
  images keyed by registered alias, holding only the registered attributes; `context` is `{ messageName, stage, mode,
depth, correlationId, initiatingUserId, userId, businessUnitId, isolationMode }`. The output is
  `{ outputParameters, sharedVariables }` (plus `output`, what a JavaScript handler returned). JavaScript and CLR steps
  record the same shape.
- **Faults.** `error = { type, code, status, message, pluginType, step, stage, depth }`: `type` is
  `InvalidPluginExecutionException` or `Exception`, `code` the answer's code (`0x80040265`, `0x80040224` or a typed
  code), `status` the fault's operation status name. The stage span, the dispatch span and the root carry the same
  error; a custom API plug-in failure uses the same shape.
- **SDK calls.** A CLR `sdk-call` names its target record; a create names the created id as `recordId` and output. An
  empty GUID is `null`.

### Jobs and background work

A `job` span is named by the process display name (printed `job <name>`) and carries `kind`, `processType`,
`processId`, `processName`, and for a committed job `jobId`, `attempt` and, when chained, `chainId` and `depth`. It runs
on host `job`, outside the span that staged it, with a `staged-by` link to that span (which gets a `triggered` link
back).

| Job kind (`kind`)                    | Opened by                                                                                             |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| async plug-in, web hook, workflow    | An asynchronous plug-in step, web hook or classic workflow staged at commit.                          |
| `bulk-delete`                        | A BulkDelete job (the staff user as actor; one `bulk` span with a `rows` event).                      |
| `system-job`                         | `api.systemJob`, including a background `ExecuteWorkflow`; its message as output.                     |
| `background-operation`               | `runInBackground`, with its output parameters or error.                                               |
| `desktop-flow`                       | `RunDesktopFlow`.                                                                                     |
| `rollup-mass`, `elastic-ttl-purge`   | A rollup mass calculation, the elastic table time-to-live purge, with a `rows` event; none when idle. |
| `flow` (`processType: 'cloud-flow'`) | A cloud flow started by a row change.                                                                 |
| `flow-schedule`, `flow-trigger`      | A recurrence or polling flow occurrence; a pack trigger's `fire()`.                                   |

A classic workflow's `trace()` lines are events on its `workflow` span and its result `{ message }` is the output.

### Outbound calls, web hooks and secrets

- **Outbound HTTP.** Server logic `HttpClient`, `RunDesktopFlow` and background operation callbacks,
  `TriggerServiceEndpointCheck`, external sign-in, Azurite storage and the code-app dev server probe open an `http-out`
  span `<METHOD> <host><path>` with `method`, `url` (credentials removed, secret query values hidden) and `status`, and
  forward the trace headers. At `full`: request `{ method, url, headers, body }` and answer `{ status, headers, body }`
  (text bodies only, at most `payloadBytes`; storage records no bytes). A 4xx/5xx records the provider's own code and
  message when the body has them; a network failure records the cause code (`ECONNREFUSED`).
- **Web hooks.** An `http-out` span (module `webhooks`) with the record, `stepId`, `stepName`, `mode`; at `full` the
  request before authentication is applied and the receiver's `{ status, body }`. No answer is `WebhookNoAnswer`.
- **Service Bus.** A `webhook` span `Send <provider>/<queue>` with `transport: 'servicebus'`, `channel`, `queue`,
  `provider`, `serviceEndpoint`, `stepName`, `mode`, `messageId` and the record; the message at `full`.
- **Secrets.** A `secret` span with `key`, `vault`, `secretName`, `version`, `purpose`, the status and `resolvedVersion`;
  never the value.

### Flows and connectors

- **Run-starting routes.** `POST /_sim/api/flow-runs`, an HTTP Request trigger's `POST /_sim/api/flow-triggers/<id>`
  and its signed callback URL open an `http` root (module `flows`, `route` `flow-run`, `flow-trigger` or
  `flow-callback`) that joins the caller through the [headers](#headers), answers with `X-Trace-Id` and
  `X-Sim-Span-Id`, and parents the `flow-run` span. The actor is the administrator, or an anonymous `caller` on the
  signed URL (`signed: true`).
- **Row triggers.** The job span (`kind: 'flow'`, `processType: 'cloud-flow'`, `processId`, `processName`) and its
  `flow-run` name the trigger's table and row; a resumed run keeps them.
- **Loops.** Each "Apply to each" or "Do until" iteration keeps its `flow-action` spans with `iteration` (0-based, the
  innermost loop); the loop action carries `iterations`. `spansPerTrace` bounds a large loop.
- **Scheduled occurrences.** Each recurrence tick and polling check is its own `job` root named by the flow, actor
  `system`, with `kind: 'flow-schedule'`, `trigger` (`recurrence`, `poll`), `schedule`, `scheduledFor` and, for a poll,
  `connectorId`, `operationId` and `found`. A pack trigger's `fire()` is a `job` root `kind: 'flow-trigger'`, staged by
  the calling span when one runs.
- **Failures.** A failed run names its action in `error.action`, the attribute `failedAction` and (at `full`) the output
  `{ status, response, failedAction }`, also after its Response answered. A cancelled run or action ends `cancelled`.
- **Connectors.** The error is the provider's own code, message and status, with the inner exception as `cause` and the
  runtime's mapped code as `mappedCode`. Canvas calls carry `caller: 'canvas'`, code app calls `caller: 'code-app'`.
- **The Dataverse connector.** A `dataverse` span (module `dataverse`) with the canonical operation (`create`,
  `retrieve`, `retrievemultiple`, `update` with `created: true` when it created the row, `delete`, `upsert` only for a
  real upsert), `connector: 'commondataserviceforapps'`, `statusCode`, `rowCount`, `message` for an action and the
  created `recordId`; at `full` the parameters (written values as `item`) and `{ statusCode, id, rowCount,
moreRecords }`. The write happens inside it, with no second `dataverse` span.
- **Sealed runs.** A run with a `Secret` parameter or any `secureData` action marks its `flow-run`, `flow-action` and
  `connector` spans `secure: true` and records no input or output on them at any level; its child flows and resumes are
  sealed too.

### Model-driven, canvas and code apps

- **Model-driven.** `/_apps/api/tables` record requests name their table and record; lists name `view`, `page`,
  `pageSize` and `search`. The shell's table rights are one `permission` event (`result: 'evaluated'`,
  `operation: 'rights'`).
- **Canvas.** One `canvas` span per player action: `start` and `reset` (`App.OnStart`), `select <control>.OnSelect`,
  `input <control>.OnChange`, `run <formula>`, `evaluate <formula>`, with `app`, `action`, `control`, `property`,
  `screen`, `item`; at `full` input `{ formula, parameters, value }` and output `{ result, errors }`. A failed formula
  ends the span with the first failure (`denied` for a refused write).
- **Code apps.** Roots name the `app`; the dev server probe is an `http-out` span (module `code-apps`, operation
  `probe`).

## What joins and what starts a new trace

- **Loopback calls join through the [headers](#headers); anything else starts fresh.** Portal pages send the page
  root's ids on same-origin `fetch` and `XMLHttpRequest` calls unless the script sets them; the model-driven shell
  (including `Xrm.WebApi` and custom pages), the canvas player and the code-app client do the same. Canvas source-watch
  polls send none.
- **A click or key press starts an activity.** In the canvas player, the model-driven shell and a code app, a trusted
  pointer or key press makes the next call send its own `X-Trace-Id` and `X-Sim-Parent-Request`; that activity links to
  the page load with `parent-request`. Earlier calls join the page load; later calls, timers included, join the latest
  press's activity.
- **Jobs join the trace that staged them** as `async` segments: async plug-in steps, web hooks, row-triggered flows,
  BulkDelete, system jobs, background operations, `RunDesktopFlow` and background `ExecuteWorkflow`. Which span staged
  each job is kept in memory only (10,000 entries, cleared with the traces): after a restart a job starts a new trace. A
  job never inherits the span of an unrelated request.
- **Scheduled work is a new root.** Recurrence occurrences, connector-trigger polls, rollup mass calculations,
  time-to-live purges and each next occurrence of a recurring BulkDelete never join the trace that registered them.
- **In-process Dataverse calls nest.** A listener request made in process without trace headers (`Xrm.WebApi` of a
  form) nests under the current span; with headers, the headers decide.
- **A full trace stays one trace.** Past `spansPerTrace`, further spans of the trace and everything under them are
  refused and counted in `droppedSpans`; the response still names the trace in `X-Trace-Id`.

## Headers

| Header                 | Direction | Meaning                                                                                                                     |
| ---------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------- |
| `X-Trace-Id`           | inbound   | The trace the request joins. The only inbound header read as a trace id.                                                    |
| `X-Sim-Parent-Trace`   | inbound   | The span the request belongs under: a span id or an earlier request's audit id.                                             |
| `X-Sim-Trace-Id`       | inbound   | An audit id: without `X-Sim-Parent-Trace`, the request joins under the span that names that audit entry.                    |
| `X-Sim-Parent-Request` | inbound   | The span (or audit id) of the request a new activity follows; the root keeps its own trace and links with `parent-request`. |
| `X-Trace-Id`           | response  | The request's trace id, on every host.                                                                                      |
| `X-Sim-Span-Id`        | response  | The request's root span id.                                                                                                 |
| `X-Sim-Trace-Id`       | response  | The request's audit entry id on the Power Pages host (`connectRuntime` sessions read it as `traceId`).                      |

Only UUID-shaped values count; anything else is ignored and the request starts a new trace. A retained parent decides
the trace over a different `X-Trace-Id`. An unknown parent with a retained `X-Trace-Id` joins one level under that
trace's root with a `parent-request` link; with neither known, the request starts a new trace (named by `X-Trace-Id`
when present) and keeps the link. The Power Pages host also resolves `X-Sim-Trace-Id` through the audit ledger after
the trace left memory; an unknown audit id is ignored. Outbound requests (`http-out`, web hooks, connectors, Service
Bus, the flow HTTP provider) send `X-Trace-Id`, `X-Sim-Parent-Trace` and `X-Sim-Span-Id` of the sending span, and
`X-Sim-Trace-Id` only when that span or an ancestor names an audit entry. A client that echoes a response's trace
headers joins its trace.

## API

Both hosts serve these routes under `/_sim/api` (listed as `/trace` in `status.routes`). `PUT` and `POST` need the
token of `/_sim/api/status` `csrf` (or `simulator.csrf`) in `x-sim-csrf`. Errors are
`{ error: { code, message, parameter? } }`; a runtime without a trace store answers 501 `TraceNotConfigured`.

| Route                     | Answer                                                                                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /trace`              | `{ items: [summary], total, page, pageSize, pageCount, retained, dropped, latestSequence }`.                                                             |
| `GET /trace/spans`        | The same envelope with span records, in sequence order.                                                                                                  |
| `GET /trace/stats`        | See [stats](#stats).                                                                                                                                     |
| `GET /trace/export`       | The matching traces as a streamed attachment; see [Export](#export).                                                                                     |
| `GET /trace/id/<traceId>` | `{ trace, root, spans, children }`: summary, root, spans in order and the nested tree. 404 `TraceNotFound` when not retained.                            |
| `GET /trace/<traceId>`    | The same for a UUID-shaped id; any other id is 404 `TraceNotFound`.                                                                                      |
| `GET /trace/span/<id>`    | One span record; 404 `SpanNotFound`.                                                                                                                     |
| `GET /trace/settings`     | `{ settings, status }`: settings in force and the store status.                                                                                          |
| `PUT /trace/settings`     | Applies a partial change (`{ "level": "full" }`, body at most 64 KB) and answers `{ settings, status }`; an invalid value is 400 `InvalidTraceSettings`. |
| `POST /trace/clear`       | Drops every trace and remembered job link; answers the status.                                                                                           |
| `POST /trace/flush`       | Waits until queued persisted lines are written and live frames reached their clients (not for running spans); answers the status.                        |

The status is `{ level, enabled, retained, spans, running, dropped, droppedSpans, latestSequence, memoryBytes,
listeners, persist: { enabled, directory, written, failures, lastError } }`. The Health view shows the same counters on
its `org:trace` node.

A trace summary:

```js
{
  traceId, sequence, latestSequence, startedAt,
  auditId,          // the root's audit entry id, or null
  status,           // the root's own status; running while a span runs
  result,           // the activity result (see Reading a trace)
  failed,           // the root or a step ended error or denied (a browser probe's 404 excepted)
  ended, durationMs, totalDurationMs,
  spanCount, droppedSpans, errorCount, deniedCount,
  firstError,       // once a span failed: { spanId, kind, name, status, code, message }
  pluginCount, flowCount, connectorCount, dataverseCount,
  kinds, entities, modules,
  evicted,          // only on a trace dropped while it ran
  root,             // the root span record
}
```

### Filters

`/trace`, `/trace/spans`, `/trace/stats` and `/trace/export` take the same query parameters. A trace matches when
**one** of its spans meets every span filter, so `kind=plugin-step&status=error` lists traces with a failing plug-in
step.

| Parameter                                  | Matches                                                                                                                                       |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `from`, `to`                               | Inclusive ISO time or epoch milliseconds: a trace when any span starts in the range, a span by its own start.                                 |
| `kind`, `status`                           | Case-insensitive equality with a span kind or status.                                                                                         |
| `result`                                   | Comma list of results: the trace's activity result (`summary.result`); spans and stats keep all spans of those traces.                        |
| `hasErrors`                                | `true`/`false`: the activity is failed (`summary.failed`). `status=error` instead selects single failing spans.                               |
| `module`, `operation`, `host`, `actorKind` | Case-insensitive equality (`host` is `origin.host`).                                                                                          |
| `entity` (or `table`)                      | Logical or entity set name (`contact` or `contacts`), case-insensitive.                                                                       |
| `recordId`, `actorId`                      | Equality ignoring braces and case.                                                                                                            |
| `sessionKey`, `visitorId`, `portal`        | Exact equality.                                                                                                                               |
| `auditId`                                  | Exact: a span naming that audit entry (a Liquid read's audit id finds its page).                                                              |
| `search`                                   | Case-insensitive text in name, kind, module, operation, entity, record id, actor, error, attributes, events and, at `full`, input and output. |
| `traceId`                                  | A full id, or a prefix of at least 8 hexadecimal characters.                                                                                  |
| `minDurationMs`                            | A trace's total duration or a span's duration (running spans never match).                                                                    |
| `parentSpanId`, `depth`                    | Spans and stats only.                                                                                                                         |
| `page`, `pageSize`, `order`                | 1-based page, 1 to 200 per page (default 25), `desc` (default) or `asc`.                                                                      |
| `sort`                                     | Trace list and export: `start` (default), `duration` (total), `spans` or `errors`.                                                            |
| `bucketMs`                                 | Stats timeline bucket; chosen for at most 60 buckets when absent; more than 1000 buckets is refused.                                          |
| `format`, `limit`                          | Export only: `json` (default), `ndjson` or `otlp`; at most `limit` traces (default 200, 1 to 2000).                                           |

`recordId`, `actorId`, `sessionKey` and `visitorId` also take a prefix of at least 8 hexadecimal characters after an
optional `kind:` (`visitor:ad87d220`); an ambiguous prefix matches every candidate. An invalid value, or a `kind`,
`status`, `result`, `sort`, `order` or `format` outside its list, answers 400 `InvalidTraceFilter` with `parameter`; the
message starts with the parameter and lists the allowed values:
`status must be one of ok, error, denied, cancelled, running (got "bogus").`

### stats

`{ count, from, to, bucketMs, overall, roots, byKind, byModule, byEntity, byOperation, byActor, byStatus, timeline,
slowest, errors }`. Figures are `{ count, errors, p50, p95, max }`, nearest-rank over ended spans (`null` without
durations). `roots` covers the root spans of the matching traces and adds `failed`. `timeline` is
`[{ bucketStart, count, errors, p95 }]`; `slowest` and `errors` list 10 spans each.

### Export

`GET /trace/export` writes one trace at a time, in the list order. `X-Trace-Export-Matched` gives the number of matching
traces; when it exceeds `limit`, narrow the filters or raise `limit`.

| `format`         | Attachment                   | Content                                                                       |
| ---------------- | ---------------------------- | ----------------------------------------------------------------------------- |
| `json` (default) | `simulator-traces.json`      | `{ exportedAt, settings, traces: [tree] }`, each tree as `/trace/id` answers. |
| `ndjson`         | `simulator-traces.ndjson`    | One `{ trace, spans }` line per trace.                                        |
| `otlp`           | `simulator-traces.otlp.json` | OTLP/JSON `resourceSpans` under one resource, `service.name: paqvilo-mirage`. |

OTLP mapping: the trace id is the UUID's 32 hexadecimal digits and the span id the first 16 hexadecimal digits of the
SHA-256 of the span id (stable across exports); the originals stay in `mirage.trace_id` and `mirage.span_id`. `http` is
SERVER, `http-out` and `connector` CLIENT, `webhook` PRODUCER, `job` CONSUMER, the rest INTERNAL. Attributes add
`mirage.kind`, `mirage.module`, `mirage.operation`, `mirage.entity`, `mirage.record_id`, `mirage.status`,
`mirage.level`, `mirage.async`, `mirage.depth`, `mirage.host`, `mirage.portal`, `mirage.actor.kind`,
`mirage.actor.id`, `mirage.session.key`, `mirage.session.visitor_id` and, at `full`, `mirage.input` and
`mirage.output`. Links keep their relation as `mirage.relation`. Status is OK for `ok`, ERROR (with the message) for
`error` and `denied`, UNSET for `running` and `cancelled`.

### Activity bundle

`GET /_sim/api/activity/export?<filters>&format=bundle[&traces=ndjson|otlp][&limit=N]` takes the export filters and
`limit` (default 200, 1 to 2000) and streams `simulator-activity-bundle.ndjson` (with `X-Trace-Export-Matched`): one
JSON document per line, each with a `kind`, in this order.

| `kind`     | Document                                                                                                                                        |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `bundle`   | `{ schemaVersion: 1, exportedAt, timeZone, filters, traces, runtime }`: IANA time zone, query, origin, revisions, fingerprints, trace settings. |
| `activity` | `{ trace, spans }` per matching trace (`traces=ndjson`, the default).                                                                           |
| `otlp`     | One `{ resourceSpans }` document with every matching trace (`traces=otlp`).                                                                     |
| `audit`    | `{ entry }` per retained audit entry of a matching trace.                                                                                       |
| `log`      | `{ line }` per retained log line of a matching trace.                                                                                           |
| `finding`  | `{ diagnostic }` per finding of a matching trace.                                                                                               |
| `evidence` | `{ path, time, passed, verified, stale, differences, artifactUrls }` when a verification report exists.                                         |
| `end`      | `{ counts: { activities, audit, logs, findings, evidence } }`.                                                                                  |

A filter of only `from`/`to` (or none) also takes log lines and findings that belong to no trace in that range. Another
`format` or `traces` value is 400 `InvalidActivityExport` naming it. The standalone host has no audit trail, log stream
or verification evidence, so its bundle has no `audit`, `log` or `evidence` documents.

### Live channel

`GET /_sim/events?channels=trace[&events=<type>,...][&traceId=<id>]` on both hosts sends `event: trace` frames: first
`{ type: 'connected', status, events, traceId }`, then `{ type: 'span-start' | 'span-end' | 'trace-end', span, trace? }`.
`events` keeps those types (default all three) and `traceId` one trace; the runtime filters before building frames. An
unknown type answers one `{ type: 'error', error: { code: 'InvalidTraceFilter', parameter: 'events', message } }` frame
and ends the stream. Frames never carry inputs or outputs. A `trace-end` for a trace dropped while it ran has
`trace.evicted: true`. Every frame is written; a client that has drained nothing 5 seconds after a refused write while
the event loop was free is disconnected.

### Testing client and in-process handle

`connectRuntime()` from `paqvilo/mirage/testing` has `trace`: `query`, `spans`, `tree`, `span`, `ancestry`, `stats`,
`export`, `settings`, `status`, `configure`, `clear`, `flush` and `subscribe(listener, { signal, events, traceId })`.
Beside it, `logs({ since, limit, type, traceId })`, `diagnostics({ traceId })`, `audit({ traceId })` (one id, a comma
list or an array) and `exportBundle(filters)` (the bundle documents in order).

- Filters are plain objects (`{ recordId, kind: 'plugin-step' }`); a `Date` is sent with its milliseconds, and
  `undefined` or `null` members are left out.
- `tree` and `span` answer `null` for an id that is not retained, `ancestry` `[]` (otherwise the spans from the root
  down to the span).
- `export({ format: 'ndjson' })` answers the array of lines; `json` and `otlp` the parsed document.
- `subscribe` receives every frame, `connected` first, and returns `unsubscribe()` whose `closed` promise resolves when
  the stream ends and rejects when it cannot open or the listener throws.
- A refused request rejects with `status`, `code` and `parameter`; an unanswering runtime with `RuntimeUnreachable`, a
  connection closed mid-response with `RuntimeConnectionLost` (both keep the fetch error as `cause`).

`createSimulator()` exposes `simulator.trace` with the same reads, `settings`, `status`, `configure` and `clear`
synchronously, `flush()` as a promise, and `subscribe(listener, { payloads, events, traceId })` (payloads included
unless `payloads: false`).

```js
import { connectRuntime } from 'paqvilo/mirage/testing';
const sim = await connectRuntime({ origin: 'http://127.0.0.1:8787' });
await sim.trace.configure({ level: 'full' });
const visitor = sim.createSession();
await visitor.json('/_api/contacts', { method: 'POST', body: { firstname: 'Ada' } });
const { items } = await sim.trace.query({ kind: 'plugin-step', hasErrors: true });
const tree = items.length ? await sim.trace.tree(items[0].traceId) : null;
```

Assert on what a trace contains (spans, nesting, status, error codes), never on durations.

## CLI

`paqvilo mirage trace <action>` reads a running runtime's store. Select the runtime with one of
`--origin http://127.0.0.1:<port>` (loopback only), `--config FILE --site ID` or `--project FILE`.

| Action                                            | Prints                                                                                                                                                                        |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list`                                            | One row per trace: start, result (`error (root ok)`, `ok (browser probe)` when it differs from the root), `DURATION` (root), `TOTAL`, counts, host, actor, session, name, id. |
| `show TRACE_ID`, `show PREFIX` or `show --latest` | The summary and span tree. A prefix (8+ hexadecimal characters) must match one retained trace; `--latest` takes the filters and shows the newest match.                       |
| `spans`                                           | One row per span: start, kind, status, duration, entity, record id, actor, name, span id.                                                                                     |
| `stats`                                           | Overall and root figures (the Roots line counts failed activities), by kind, then the slowest spans; `—` for a percentile without ended spans.                                |
| `settings`                                        | Settings and status; `--level`, `--persist`, `--traces`, `--spans-per-trace` and `--payload-bytes` change them.                                                               |
| `clear`, `flush`                                  | As the routes; print the status.                                                                                                                                              |
| `export`                                          | The route's stream in `--format json` (default), `ndjson` or `otlp`, at most `--limit N`; `--format bundle` prints the [activity bundle](#activity-bundle).                   |
| `watch`                                           | One line per ended span, or per ended trace with `--trace-end`, until Ctrl+C, `--count N` lines or the runtime stops (`stream ended` on stderr, exit 0).                      |

Filters are the parameter names in kebab case: `--from`, `--to`, `--kind`, `--module`, `--operation`, `--entity`,
`--record-id`, `--status`, `--host`, `--actor-kind`, `--actor-id`, `--session-key`, `--visitor-id`, `--portal`,
`--audit-id`, `--result`, `--search`, `--trace-id`, `--parent-span-id`, `--depth`, `--min-duration-ms`,
`--has-errors`, plus `--page`, `--page-size`, `--order`, `--sort` and `--bucket-ms` for `list`, `spans`, `stats` and
`export`. `watch` takes the filters without paging and applies them to each frame (for `--trace-end`: kind, module and
entity match any span, `--min-duration-ms` the whole trace, `--has-errors` the activity, the rest the root). The
command checks filter values with the runtime's rules before it connects. `list` and `spans` print local time with the
UTC offset in the header; `--utc` prints ISO UTC.

`--json` prints `{ schemaVersion: 1, ok: true, command, result }` (`watch`: one per line), `result` being the route's
answer. A failure prints `{ schemaVersion: 1, ok: false, command, error: { code, message, parameter? } }`; without
`--json` it writes the message to stderr, prefixed `<code>: ` for a runtime error answer or a refused value.

| Code                    | Exit | Meaning                                                                                             |
| ----------------------- | ---- | --------------------------------------------------------------------------------------------------- |
| `InvalidArguments`      | 1    | A flag, action, origin or argument refused before connecting.                                       |
| `RuntimeUnreachable`    | 1    | No runtime answers at the origin.                                                                   |
| `RuntimeConnectionLost` | 1    | The runtime closed the connection before the response completed.                                    |
| `TraceNotFound`         | 1    | No retained trace matches; traces live in memory, so ids from before a restart or `clear` are gone. |
| `AmbiguousTraceId`      | 1    | A `show` prefix matches more than one trace.                                                        |
| `InvalidTraceFilter`    | 2    | A filter, sort, format or limit is refused; `parameter` names it.                                   |
| `InvalidTraceSettings`  | 2    | The runtime refused a settings change.                                                              |
| `MIRAGE_FAILED`         | 1    | Any other failure; other runtime codes (`TraceNotConfigured`) pass through.                         |

```sh
node bin/paqvilo.mjs mirage trace list --origin http://127.0.0.1:8787 --has-errors true --sort duration
node bin/paqvilo.mjs mirage trace show --latest --kind plugin-step --origin http://127.0.0.1:8787
node bin/paqvilo.mjs mirage trace spans --record-id 6c1f0b4e --origin http://127.0.0.1:8787
node bin/paqvilo.mjs mirage trace settings --level full --origin http://127.0.0.1:8787
node bin/paqvilo.mjs mirage trace export --entity contact --format ndjson --origin http://127.0.0.1:8787 > traces.ndjson
node bin/paqvilo.mjs mirage trace watch --kind plugin-step --status error --origin http://127.0.0.1:8787
```

## Persistence

With `persist: true`, each end of a trace appends a line to `<state folder>/traces/<yyyy-mm-dd>.ndjson` (UTC date of
the write). The state folder is the folder of the runtime's state file: the ignored `.paqvilo/` by default; a state file
elsewhere puts `traces/` next to it, outside the ignored folder.

A line is `{ persistedAt, traceId, trace: summary, spans: [record], complete }`. `spans` holds the spans added since the
trace's previous line plus any span that line wrote while it still ran. To rebuild a trace, read its lines in order and
keep the latest record per span id and the latest summary. `complete: false` means a span still ran: a trace dropped
from memory while running is written at once and again when its last span ends. A link added later (a job's
`triggered` link) writes that span again. Lines are built after the response, never fail a request, and are counted in
the status. A runtime without a state folder (memory-only, `--simulation dry-run`) accepts `persist: true`, writes
nothing and reports `lastError: 'NoStateDirectory'`. Files are never read back on restart.

## Privacy and redaction

- Inputs and outputs are captured only at `full`, always redacted. Values under credential-named keys (password,
  secret, token, authorization, authentication, cookie, credential, API key, signature, connection string, SAS, account,
  subscription, private and function keys, invitation codes) and the `value` of a `{ key, value }` pair with such a key
  become `[redacted]`. `secretName` names a Key Vault secret, never its value, and stays readable.
- In text, `Bearer`, `Basic`, `Digest` and `SharedAccessSignature` credentials, `name=value` credentials, `code`, `sig`
  and invitation query parameters and secret-named FetchXML conditions are masked, at every level (attribute strings and
  event messages included).
- File and binary columns are summarised as `{ bytes, mimetype, filename, sha256 }`: a `documentbody`, binary data, a
  data URL or base64 under `body` or an image key, and any data URL or base64 longer than 1 KB.
- Secret values, bearer tokens, cookies, a sign-in's token request and sealed flow payloads are never stored. Live
  frames never carry inputs or outputs.
- An export or persisted file at `full` can hold business data: keep it out of source control.
