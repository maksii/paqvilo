# Request tracing

Mirage records what a local runtime does for each request as a **trace**: a tree of **spans** that starts at the
inbound HTTP request and nests everything that request caused. Typical spans are the portal Web API call or form
submit, the Dataverse operation, its plug-in stages and steps, the SDK calls a plug-in makes, secret resolution,
outbound HTTP, web hook and Service Bus deliveries, the page render with its templates and reads, the jobs and cloud
flows that follow, and their actions and connector calls. A permission decision, a plug-in trace line or a sign-in is
an **event** on the span where it happened.

Tracing answers questions the request audit cannot: why a save took 900 ms, which plug-in step refused a create, which
flow a row change started and which connector call inside it failed. The audit log keeps its own sanitized request
ledger; each audit entry carries the `traceId` and `spanId` of its request, the root span of an audited request names
its entry in the attribute `auditId`, and the `_sim` **Activity** view shows both together.

Tracing is local to one runtime. Every host of that runtime shares one trace store: the Power Pages host, the
standalone host with its model-driven, canvas and code apps, the Dataverse Web API listener with its SOAP endpoint, the
TDS endpoint, the local identity provider and a SharePoint contract fixture server started with the store. A portal
request, the Dataverse request it makes and the job it stages therefore appear in the same trace. Nothing leaves the
machine.

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

A span ends with one of five statuses: `ok`, `error` (an exception, a fault or an HTTP error answer), `denied` (a
permission refusal or a 401 or 403 answer), `cancelled` (stopped before it finished, such as a cancelled flow run or
action) and `running` while it has not ended. `cancelled` counts as neither an error nor a denial.

Events record what happened inside a span without a span of its own:

| Event                                                | Where and what                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `permission`                                         | One per permission decision (`result` `allow` or `deny`, with `table`, `operation`, `model` and the deny `code`), one per filtered query (`result: 'filtered'` with the row counts, never one per row) and one per bulk evaluation (`result: 'evaluated'` with `tables`, `allowed` and `denied`, such as the model-driven table rights). A refused Web API collection read records the same `deny` event as a refused create. |
| `commit`                                             | A store commit on the current span.                                                                                                                                                                                                                                                                                                                                                                                           |
| `trace`                                              | A plug-in `ITracingService` line, a flow `trace()` line, a classic workflow `trace()` line or a server logic `Logger` line (with its `level`).                                                                                                                                                                                                                                                                                |
| `diagnostic`                                         | A server logic worker diagnostic, with its `code`.                                                                                                                                                                                                                                                                                                                                                                            |
| `bypass`                                             | One per `MSCRM.BypassCustomPluginExecution` or `MSCRM.BypassBusinessLogicExecution` header on the Dataverse dispatch span: `header`, `value` and `skipped` (`['sync-plugins']` when the local pipeline skipped the synchronous plug-in stages for it, else `[]`).                                                                                                                                                             |
| `signIn`                                             | A sign-in on the request's root: `provider` (`local`, `persona` or the external provider) and `contactId`.                                                                                                                                                                                                                                                                                                                    |
| `job-staged`                                         | A job staged by the span: its kind and job id.                                                                                                                                                                                                                                                                                                                                                                                |
| `rows`                                               | The row count of a job that works on many rows (a BulkDelete, a rollup mass calculation, an elastic table time-to-live purge), instead of one span per row.                                                                                                                                                                                                                                                                   |
| `cascade`, `business-rule`                           | A cascaded Assign on the assigning write; a business rule run with its mode, changed columns and error.                                                                                                                                                                                                                                                                                                                       |
| `retry`, `page`, `suspended`, `flow-trigger-skipped` | A job retry, a paged read, a suspended flow run, a skipped flow trigger.                                                                                                                                                                                                                                                                                                                                                      |

Under a `bulk` span the row decisions are aggregated: one evaluated `permission` event, one `commit` event and the
first denial, with the counts in the span attributes `permissions` and `commits`.

Operations use one vocabulary on every layer, so one filter finds the same work everywhere: a multi-row read is
`retrievemultiple` (a FetchXML read adds the attribute `query: 'fetchxml'`), a function or action span has the operation
of its lowercased message, and a `job` span has the operation `run` with the job kind in its `kind` attribute.

## What each span records

Every span names its record when it acts on one: `entity` is the table's logical name and `recordId` the row id. A
keyed request names the record when it starts; a create names it as soon as the id is assigned, before its
PostOperation stage runs, so PostOperation steps, the jobs it stages and the web hooks it sends name the same record.
Plug-in stage and step spans, job spans, web hook spans, workflow spans, Liquid entity reads, form spans and flow spans
of a row trigger copy `entity` and `recordId` from their target. Filter on `recordId` to find every span that touched
one row.

### Roots and hosts

`origin.host` names the host that answered the root, and the descendants inherit it:

| `origin.host`       | Roots                                                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `power-pages`       | Portal pages, `/_api`, forms, sign-in, files and the other portal routes.                                            |
| `standalone`        | The standalone host's own routes and its flow routes.                                                                |
| `model-driven`      | `/main.aspx` and the model-driven shell's `/_apps` routes, including its in-app Web API.                             |
| `canvas`            | `/_apps/canvas*` and `/_apps/api/canvas/*`.                                                                          |
| `code-app`          | `/_apps/code*`.                                                                                                      |
| `dataverse-api`     | The Dataverse Web API listener.                                                                                      |
| `soap`              | The Organization Service SOAP endpoint of the listener.                                                              |
| `tds`               | One root per TDS (SQL) statement.                                                                                    |
| `identity-provider` | The local identity provider (module `identity`).                                                                     |
| `sharepoint`        | A SharePoint contract fixture server started with `createSharePointFixtureServer({ traces })` (module `sharepoint`). |
| `job`               | Every `job` span, with the portal and preset of the span that staged it.                                             |
| `sim`               | `/_sim/api` administration writes; the default host of flow routes whose host names none.                            |

A root records its request: the attributes `query` (credential values hidden), `contentType` and `contentLength`, and
at level `full` the input `{ query, contentType, body }` (the body capped at `payloadBytes`). A Dataverse listener root
keeps, at `full`, `{ query, headers, body }` with the headers that change the answer (`Prefer`, `If-Match`,
`If-None-Match`, the bypass headers and the caller headers). A root that answers an error itself records it: the error
code and message of its JSON envelope, SOAP fault or text answer, on the span whose status it sets. A refused listener
bearer names the refusal: `The request carries no access token.` or `The access token was refused (<reason>).`

The actor of a root is who made the request: a signed-in `contact` (named by its full name, else first and last name,
else its email), a `staff` user with id and name on the model-driven, canvas and code-app hosts, an `app` or `client`
for a token client, `anonymous` until a request authenticates, and `system` (named `simulator`) for `/_sim/api`
administration writes. Every descendant carries the root's actor. Administration reads and the trace routes themselves
open no root.

### Portal pages, forms and sign-in

- **Visitors.** An anonymous browser's first page `GET` starts its visitor session, so every later request of that
  browser has the session key `visitor:<id>`. The account routes (sign-in, sign-out, external sign-in) keep their own
  cookie contract and start none.
- **Sign-in.** A local, persona or external sign-in sets the request root's actor to the contact and adds a `signIn`
  event. The contact and identity writes it makes are `dataverse` spans. An external sign-in's metadata, token and
  user-info requests are `http-out` spans (module `identity`; the token request records no bodies), and the identity
  provider's own roots join under them.
- **Forms.** A basic or advanced form submission is one `form` span (`Basic form <name>` or `Advanced form <name>`,
  operation `submit`) above its Dataverse operation: attributes `form`, `formId`, `formKind`, `mode`, `button`, `stepId`
  and `native`, then `formOperation` and `outcome`; at `full` the submitted values as input.
- **Files.** Upload and download spans name the file, never its bytes: attributes `transfer` (`upload`, `download`,
  `delete` or `upload-block`), `fileColumn`, `fileName`, `fileSize` and `mimetype`.
- **Renders.** A `render-template` span is named after its source (`webtemplate Order`); a runtime template after its
  include name (`builtin entity_list`), an include with no template `missing <name>`, and nested Liquid after its slot
  (`snippet Head`, `inline liquid`, `editable`, `liquid filter`, `page copy layout`). A slot whose source is empty still
  gets a span with `empty: true`. A Liquid read is a `retrieve` (`entities.<table>[id]`, with its `recordId`) or a
  `retrievemultiple` (FetchXML or an entity query) with the attribute `source` (`liquid-fetchxml`, `entity-read` or
  `entity-query`) and, at `full`, the query and the rows read.
- **Grids.** An entity grid `native-service` span names its table, `view`, `savedquery`, `rowCount` and `itemCount`,
  and a refused read adds the `deny` event.
- **Server logic.** A server logic run is a `server-logic` span (`Server logic <name>`, operation the lowercased
  function) with the input `{ function, method, body, input, query }` and its result as output at `full`. `Logger`
  lines are `trace` events, and each `HttpClient` request is an `http-out` span under it.

### Dataverse operations

- **Dispatch.** At `full` the Dataverse dispatch span of a Web API request records the input `{ body, query, headers }`
  (`Prefer`, `If-Match`, `If-None-Match`) and the output `{ id, rowCount, totalCount, moreRecords, statusCode }`. At
  every level it carries `statusCode`, `rowCount` and `pageNumber` for a page, and `query` for the kind of query:
  `odata`, `fetchxml`, `savedquery`, `userquery`, `apply` or `delta`.
- **Functions and actions.** Built-in functions (`WhoAmI`, `RetrieveVersion`, `RetrieveCurrentOrganization`,
  `RetrieveTotalRecordCount`, `RetrieveMetadataChanges`), the access messages (`RetrievePrincipalAccess`,
  `RetrieveUserPrivileges`, `GrantAccess`, `ModifyAccess`, `RevokeAccess`), every registered custom function or action
  and the messages a flow connector runs open a `function` or `action` span named by the message (and its bound table),
  with the parameters as input and the answer as output at `full`, and the error answer as its error.
- **Bulk.** `CreateMultiple`, `UpdateMultiple`, `UpsertMultiple` and `DeleteMultiple` open one `bulk <Message> <table>`
  span with `message`, `table`, `entity`, `targets` and, through the Web API, `action`, and the created ids as output.
  Per-target `dataverse` spans open only where the pipeline runs per target.
- **`$batch`.** A `batch` span (`parts`, `changesets`, `requests`, `json`, `continueOnError`, `statusCode`) holds a
  `changeset <n>` span per change set and a `part` span per request (`method`, `contentId`, `statusCode`, and at `full`
  its URL, headers and body in and its answer out). A failing part records its error; a rolled-back change set ends
  `error` with `rolledBack: true` and `failedContentId`, and the parts that ran before the failure carry
  `rolledBack: true`. The error also reaches the batch span and the listener root.
- **SOAP.** A SOAP root (host `soap`) carries `soapOperation`, `message` and `query` (`fetchxml` or `queryexpression`).
  Each message, including the items of `ExecuteMultiple` and `ExecuteTransaction`, is a `dataverse` span
  `<Message> <table>` with its `recordId` (the created id on Create), `requestIndex`, and its parameters and results at
  `full`. A fault records its hexadecimal code, message, `errorCode` and `faultedRequestIndex` on the root.
- **TDS.** Each statement is an `http` root on host `tds` (operation `query`, the caller as actor), named by its text
  with string and number literals replaced by `?`, with the attributes `sql` (the same text), `statementType`, `line`,
  `rowCount` and `resultSets`. Its entity reads are its children. At `full` it keeps the raw text, the parameters and
  the shape of each result set. A batch that does not parse is one `SQL batch` root carrying the SQL error number.

### Plug-ins

- **Steps.** At `full` a `plugin-step` span records what the step receives: `{ target, inputParameters, preImages,
postImages, sharedVariables, context }`. Images are keyed by their registered alias and hold only the registered
  attributes, never the whole row. `context` is `{ messageName, stage, mode, depth, correlationId, initiatingUserId,
userId, businessUnitId, isolationMode }`. The output is `{ outputParameters, sharedVariables }` after the step (plus
  `output`, what a JavaScript handler returned). JavaScript and CLR steps record the same shape.
- **Faults.** A plug-in failure records one identity on the step span: `error = { type, code, status, message,
pluginType, step, stage, depth }`, where `type` is `InvalidPluginExecutionException` or `Exception`, `code` the code the
  answer carries (`0x80040265`, `0x80040224` or the plug-in's typed code) and `status` the fault's operation status name.
  The stage span, the Dataverse dispatch span and the request root carry the same error. A custom API plug-in failure
  uses the same shape.
- **SDK calls.** A CLR `sdk-call` span names its target record, and a create names the created id as its `recordId` and
  output; an empty GUID is recorded as `null`.
- **Custom APIs and messages.** A message run through the internal message entry, such as a flow connector's bound or
  unbound action, is one `action` or `function` span with its parameters and answer at `full` and the attribute
  `systemUserId`; the actor stays the caller's.

### Jobs and background work

A `job` span is named by the process display name alone (trees, the CLI and the view print it as
`job <name>`) and carries `kind`, `processType`, `processId` and `processName`, and for a committed job also `jobId`,
`attempt` and, for a chained job, `chainId` and `depth`. A row-triggered flow's job and a scheduled flow occurrence are
named by the flow's display name. Every deferred job opens its own `job` span
outside the span that staged it, on host `job`: a job never runs inside an ended span and never inherits a request that
happens to run while the job queue works.

| Job kind (`kind`)                              | Opened by                                                                                          |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| the async plug-in, web hook and workflow kinds | An asynchronous plug-in step, web hook or classic workflow staged at commit.                       |
| `bulk-delete`                                  | A BulkDelete job (the staff user as actor; one `bulk` span with a `rows` event, no per-row spans). |
| `system-job`                                   | A system job (`api.systemJob`), including a background `ExecuteWorkflow`; its message as output.   |
| `background-operation`                         | A background operation (`runInBackground`), with its output parameters or error.                   |
| `desktop-flow`                                 | `RunDesktopFlow`.                                                                                  |
| `rollup-mass`, `elastic-ttl-purge`             | A rollup mass calculation and the elastic table time-to-live purge, with a `rows` event.           |
| `flow` (`processType: 'cloud-flow'`)           | A cloud flow started by a row change (see below).                                                  |
| `flow-schedule`, `flow-trigger`                | A recurrence or polling flow occurrence, and a pack trigger's `fire()` (see below).                |

A job staged by a span has a `staged-by` link to that span, and the staging span has a `triggered` link to the job.
Each next occurrence of a recurring BulkDelete is a new root, and a rollup mass job or a purge with nothing to do opens
no span. A classic workflow's `trace()` lines are `trace` events on its `workflow` span, and its result `{ message }` is
the span output.

### Outbound calls, web hooks and secrets

- **Outbound HTTP.** Server logic `HttpClient`, the `RunDesktopFlow` and background operation callbacks,
  `TriggerServiceEndpointCheck`, external sign-in, Azurite storage and the code-app dev server probe each open an
  `http-out` span named `<METHOD> <host><path>` with `method`, `url` (credentials removed, secret query values hidden)
  and `status`, and forward the trace headers. At `full` it records the request `{ method, url, headers, body }` and the
  answer `{ status, headers, body }` (text bodies only, at most `payloadBytes`; storage records no bytes). An answer of
  400 or more records the provider's own code and message when its body carries them; a network failure records the
  cause's code, such as `ECONNREFUSED`.
- **Web hooks.** A web hook delivery is an `http-out` span (module `webhooks`) with the record, `stepId`, `stepName`
  and `mode`. At `full` its input is the request before authentication is applied (URL, headers and the
  `RemoteExecutionContext` body) and its output the receiver's answer `{ status, body }`, on every delivery path. An
  answer of 400 or more is the span's error; no answer is `WebhookNoAnswer`.
- **Service Bus.** A queue or topic delivery is a `webhook` span `Send <provider>/<queue>` with `transport:
'servicebus'`, `channel` (`queue` or `topic`), `queue`, `provider`, `serviceEndpoint`, `stepName`, `mode`,
  `messageId` and the record; at `full` the message as input. A refused send fails the span.
- **Secrets.** A `secret` span names `key`, `vault`, `secretName`, `version` and `purpose`, and ends with the resolution
  status (and `resolvedVersion`); it never holds the secret value.

### Flows and connectors

- **Run-starting routes.** The on-demand `POST /_sim/api/flow-runs`, an HTTP Request trigger's route
  (`POST /_sim/api/flow-triggers/<id>`) and its signed callback URL open an `http` root of module `flows` with the
  attribute `route` (`flow-run`, `flow-trigger` or `flow-callback`) on the serving host (`power-pages` or `standalone`).
  They join the caller through the [headers](#headers) and answer with `X-Trace-Id` and `X-Sim-Span-Id`. The actor is the
  simulator administrator, or an anonymous `caller` on the signed URL (attribute `signed: true`). An answer of 400 or
  more records its code and message. The `flow-run` span is the root's child.
- **Row triggers.** The `job` span of a row-triggered flow is named by the flow's display name, with `kind: 'flow'`,
  `processType: 'cloud-flow'`, `processId` and `processName`. It and its `flow-run` span name the trigger's table and
  row; a resumed run keeps them.
- **Loops.** "Apply to each" and "Do until" iterations are traced as action executions, as in the platform's run
  history: each `flow-action` span inside a loop carries `iteration`, the 0-based index of its innermost loop, and the
  loop action's span carries `iterations`, the number of iterations it started. A large loop is bounded by
  `spansPerTrace`: once the trace is full, further action spans are refused and counted in `droppedSpans`.
- **Scheduled occurrences.** Each recurrence tick and each polling connector-trigger check is its own `job` root named
  by the flow's display name, actor `system`, with `kind: 'flow-schedule'`, `trigger` (`recurrence` or `poll`),
  `schedule` (such as `Every 1 Hour`), `scheduledFor` and, for a poll, `connectorId`, `operationId` and `found`. A
  failed poll fails the root with the pack's code and message. A pack trigger's `fire()` is its own `job` root
  (`kind: 'flow-trigger'`); when it is called from a running span, that span stages it.
- **Failures.** A failed run names its failing action: the `flow-run` span's `error.action`, its attribute
  `failedAction` and, at `full`, its output `{ status, response, failedAction }`. A run that fails after its Response
  answered still ends with that error. A cancelled action or run ends `cancelled`.
- **Connectors.** A connector call's error is the provider's own code, message and status, with the inner exception as
  `cause` and the code the runtime mapped it to as the attribute `mappedCode`. An answer of 400 or more records its
  `{ error: { code, message } }`, else `Http<status>`. A canvas app's connector calls carry `caller: 'canvas'`, a code
  app's `caller: 'code-app'`.
- **The Dataverse connector.** A flow's Dataverse connector call is a `dataverse` span (module `dataverse`) with the
  canonical operation: `create`, `retrieve`, `retrievemultiple`, `update` (an UpdateRecord, with `created: true` when it
  created the row), `delete`, or `upsert` only for a real upsert. It carries `connector: 'commondataserviceforapps'`,
  `statusCode`, `rowCount`, `query: 'fetchxml'` for a FetchXML read, `message` for an action and the created
  `recordId`. At `full` its input is the parameters with the written values as `item`, and its output
  `{ statusCode, id, rowCount, moreRecords }`. The record write happens inside this span, with no second `dataverse`
  span under it.
- **Sealed runs.** A run with a `Secret` parameter or any `secureData` action marks its `flow-run`, `flow-action` and
  `connector` spans `secure: true` and records no input or output on them, even at `full`.

### Model-driven, canvas and code apps

- **Model-driven.** A record request on `/_apps/api/tables` names its table and record (a create once it is saved),
  and a list names its `view`, `page`, `pageSize` and `search`. The table rights the shell evaluates are one aggregated
  `permission` event (`result: 'evaluated'`, `operation: 'rights'`).
- **Canvas.** Each player action is one `canvas` span: `start` (and `reset`) for `App.OnStart`,
  `select <control>.OnSelect`, `input <control>.OnChange`, `run <formula>` and `evaluate <formula>`, with `app`,
  `action`, `control`, `property`, `screen` and `item`. At `full` its input is `{ formula, parameters, value }` (the
  formula source text) and its output `{ result, errors }`. An action whose formulas failed ends with the first failure
  (`denied` for a refused write).
- **Code apps.** Roots name the `app`. The code-app client joins every call to the trace of its `getContext` answer,
  and the dev server probe is an `http-out` span (module `code-apps`, operation `probe`).

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
      job         Order async follow-up                 staged-by the create
      job         When an order is created              staged-by the create
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
   happened, and the save adds a `commit` event. Every span from the create down names the new row.
4. **Jobs run after the response, in the same trace.** The asynchronous step and the flow trigger are staged at
   commit. Each `job` span is marked `async`, is parented by the span that staged it, and links back to it with
   `staged-by`; the staging span links to it with `triggered`. On the waterfall these bars start after the request
   ended. The `job-staged` event sits on that same parent span.
5. **The flow nests under its job.** The `flow-run` span holds one `flow-action` per executed action, and each
   connector call is a `connector` span under its action.

The trace ends when its last span ends. The status of its row in the list is the root span's status, and the error
badges count failures anywhere below it: if the flow fails, the page request still reads `ok` with an error badge, and
the row names the first failed span. Open the trace and select the red bar.

## Levels

`mirage.trace.level` sets how much each span records. The value in the catalogue or project file is the start value;
**⚙ Settings** of the `_sim` **Activity** view, `PUT /_sim/api/trace/settings`, `paqvilo mirage trace settings --level <level>` and
`connectRuntime().trace.configure({ level })` change it on a running runtime without a restart and without touching the
state file.

| Level     | Records                                                                                                                                                                                                                                   | Cost                                                                                                    |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `off`     | Nothing.                                                                                                                                                                                                                                  | Each hook reads one setting and returns a shared no-op span. No payload is built.                       |
| `summary` | Every span with its timing, status, actor, session, entity, record, attributes and events. The default.                                                                                                                                   | One small record per span. Payload builders never run, and no JSON is serialized while a request runs.  |
| `full`    | `summary` plus redacted inputs and outputs: bodies, queries, plug-in targets, images, shared variables and outputs, web hook and Service Bus messages, flow action inputs and outputs, connector parameters and results, canvas formulas. | `summary` plus one redacting copy and one JSON size check per captured value, capped at `payloadBytes`. |

Use `summary` for daily work: it shows the shape, the timing and the failure of every request. Switch to `full` while
you investigate one problem, then back. A span only records an input or output when it was opened at `full`; every
span records the level it was opened at as `level`.

The other members of `mirage.trace` bound memory. The same four ways change them at run time, and Activity's
**⚙ Settings** edits the three limits as numbers:

| Member          | Default | Range          | Meaning                                                                                |
| --------------- | ------- | -------------- | -------------------------------------------------------------------------------------- |
| `traces`        | `500`   | 10 to 10000    | Traces kept in memory; the oldest is dropped first.                                    |
| `spansPerTrace` | `2000`  | 50 to 20000    | Spans kept per trace; later spans of the trace are counted in `droppedSpans` instead.  |
| `payloadBytes`  | `16384` | 256 to 1048576 | Size cap of one captured input or output; a larger value keeps a preview.              |
| `persist`       | `false` | `true`/`false` | Append ended traces to files under the state folder (see [Persistence](#persistence)). |

Summaries, copies and JSON are built only when something reads the store: a query, an export, a live subscriber or
persistence. With no `_sim` view or CLI watching, a trace costs its records and nothing else.

## Reading a trace

Open `/_sim/#activity` (**Activity**, in the **Monitor** group). There a trace is an **activity** and a span a
**step**; [`_sim` administration](sim-administration.md#activity) describes the whole workspace, its tabs and the
addresses it replaced (`#trace`, `#audit`, `#logs` and `#evidence` redirect to it). Its toolbar row holds the tabs,
the tab's quick filter, **Live**, **Refresh**, **Export**, **⚙** (tracing settings), the search box (`/` focuses it)
and **Filters**, which opens the filter drawer on the right. On Activities and Stats the quick filter is **Errors &
denied**: it sets `result=error,denied` in one click, shown as the Result chip, and clears it on the next, so a failing
request is two clicks away: the toggle, then its row. On the Log stream it is **Startup** (`type=startup`), so the
startup lines are two clicks away too. The drawer narrows the list by time range, result, who, table, record id, host and free
text; **More filters** adds kind, module, operation, step result, failed steps, from, to, minimum duration, session,
portal and audit id. Every filter, the sort, the open
activity and step and a comparison are part of the page address, so a view can be bookmarked or shared with a teammate
who runs the same project. The active filters show as chips under the toolbar; select a chip's × to drop that filter,
or **Clear all**. Opening `#activity` with nothing after it resets the filters, the range, the sort and the open activity.
A filter value the runtime refuses shows a banner naming the filter, the value and the runtime's message, with a button
that removes it. **Live** follows the `trace-end` frames of the live channel on either host and reloads the list and
the figures at most once a second as activities end; a runtime that does not serve the channel turns Live off with a
notice, and **Refresh** still reads the newest activities.

From 1200 px wide the list sits on the left and the open activity on the right, in a column that scrolls on its own;
on a narrower screen the activity follows the list and long names wrap. A link to an activity or a step scrolls its
detail into view beside the list.

Each row shows the time the root request started, the result with the HTTP status as a badge, its name
(`POST /_api/accounts`), who made it, the root duration, the step count with its errors, and the first error message
under the name. On the Power Pages host the row also carries the request audit facts of the request: the provider, the
rows returned, the reads it made and the portal error code. Select the **Time**, **Duration**, **Steps** or **Errors**
heading to sort the list by it (`sort=` in the address, largest or newest first); select it again to reverse the order.
The bottom bar under the list holds **Compare**, **Show reads**, the time zone, the count, **Rows** and paging. The Log
stream, Findings, Pages & render and the Stats breakdown sort by any data column from its heading in the page (text
order, numbers numeric). On a phone a log line takes two lines, with **Open activity →** under it. The
result is `running` while any step runs, otherwise the root step's status; the (i) of the Result heading explains the
five results. **Who** is the actor and the session: `Ada Member · contact:1a2b3c4d` for a signed-in contact,
`Visitor accb980f` for a browser with the visitor cookie (its session key `visitor:<id>`), and `Anonymous` otherwise. Roots
on the standalone host and on the Dataverse listener are `anonymous` with no session until they authenticate.

Times show as local `HH:MM:SS.mmm`, with the date and the UTC time on hover, and the bottom bar names the zone once. A
time range matches an activity when any of its steps starts in the range, so a timeline bucket that holds only the
asynchronous steps of an earlier request still lists that request.

An open activity starts with its **Why** line: the first step that failed or was denied, with its error or denial
message and **Show this step**. Its **Steps** tab has two readings of the same spans:

- The **waterfall** draws one bar per step, offset from the activity start and as wide as its duration. Bars that sit
  inside their parent ran synchronously within it. A bar marked async starts a job segment, such as an async plug-in
  step or a flow run started by the row change; the follow-up requests a page sends also start after the page's root
  step ended, without being async. Read the waterfall to find where time went.
- The **tree** nests steps by parent. Read it to see what caused what: the request, the Dataverse create, its
  PreOperation stage, the step that ran, the SDK update the step issued, and the PostOperation stage under it.

The other tabs read what joins the activity by its trace id: **Log & findings** (the log lines and findings written
during it), **Rendered** (the render, template and Liquid read steps, each template resolved to its source file and
line through `GET /_sim/api/render-sources`), **Request** (the request audit entry of the root and of its reads) and
**JSON**, the whole activity as `GET /_sim/api/trace/id/<traceId>` answers it, with **Download activity** and **Copy
JSON**.

Opening an activity moves the focus to its heading. Above the waterfall and the tree, **Find steps** keeps the steps
whose search text contains the text (the same text the `search` filter reads, see [API](#api)), and **Only errors and
denials** keeps the failing steps; both keep the ancestors of what they match, so the path to a step stays readable.
**Copy id** and **Copy link** in the detail head copy the activity id and the address of the current view, and the
step drawer has **Copy step id**.

Select a step to open its drawer. A breadcrumb shows its path from the root, and **Parent** and **Root** open those
steps by name, also when they belong to another retained activity. The drawer shows the attributes, the events in
order with their offset from the step start, the error code and message, the level the step was captured at, the
redacted input and output (at level `full`, otherwise a note that says why there is none: the level, nothing passed,
or a sealed run), and links. Ids in the attributes link to their views: `runId` to the flow run, `jobId` to the system
job record and `stepId` to the plug-in step. Escape closes the drawer and returns the focus to the step, unless you
are typing in a field; a second Escape closes the activity.

Links connect spans that are related but not nested: `staged-by` points from a job to the span that staged it,
`triggered` from the staging span to the job it started, and `parent-request` from a browser follow-up to the page that
sent it. **Related** opens the activities of the same session, the same who and the same record, and the flow run or
job the activity started; the drawer's pivots also open the same table, the parent request and the child activities.

To compare two runs of the same work, tick **Compare** on two rows and select **Compare the 2 ticked activities**, or
open `#activity?compare=<traceId1>,<traceId2>`. The two trees show side by side. Steps are matched by their kind and
name path from the root (a repeated step by its position among its siblings), each matched step shows how much longer
or shorter it took in the second activity, and the steps only one activity has are listed. This answers "why did this
save take 900 ms today": the matched step with the largest delta is where the time went.

Durations are wall-clock milliseconds with 0.01 ms precision. `durationMs` of a trace is the root span's duration;
`totalDurationMs` runs from the first span start to the last span end, including asynchronous segments. A trace ends
when its last running span ends; an asynchronous segment that starts afterwards reopens it.

To find a slow or failing request quickly, open the **Stats** tab: the tiles count the activities, the matching steps
with their p50 and p95 durations, the error and denied steps, and the plug-in steps, flow runs and connector calls.
**Root p50 / p95** are the durations of the root steps of the matching activities, so a filter on a table or a step
kind still shows how long the requests that touched it took. With a time range set, **Root p95 vs before** compares the
root p95 with the previous range of the same length. **Slowest steps** and **Latest errors** list the steps to open
first. Below them, the timeline counts steps per bucket (errors in red), and the breakdown gives counts, errors and
p50/p95/maximum durations by kind, module, table, operation and who. Select a timeline bucket to narrow the time range
to it, or **Filter** on a breakdown row to narrow to that value.

**⚙ Settings** changes the level, persistence and the retention limits (`traces`, `spansPerTrace`, `payloadBytes`)
without a restart; a smaller `traces` limit drops the oldest activities at once and reloads the list. At level `off`
Activities lists the request audit instead, under a banner, so the page is never blank, and **Live** follows the request
audit (`Following the request audit`).

**Export** downloads, for the current filters, the [activity bundle](#activity-bundle) (the default, also with
its activities as OTLP) or the activities alone as NDJSON, JSON or OTLP JSON. The runtime streams the file and
includes at most 200 activities; see [API](#api) for larger exports.

The `_sim` administration pages follow the browser's dark colour scheme; `/_setup/` stays light.

### What joins and what starts a new trace

- **Loopback calls join; anything else starts fresh.** A request joins a trace only through the [headers](#headers).
  `/_sim/api` administration writes are their own roots on host `sim`; administration reads and the trace routes are
  not traced.
- **Jobs join the trace that staged them.** Asynchronous plug-in steps, web hook deliveries, flows started by a row
  change, BulkDelete, system jobs, background operations, `RunDesktopFlow` and background `ExecuteWorkflow` are `async`
  segments of the trace whose span staged them. The runtime keeps which trace and span staged each job, and which trace
  each flow run belongs to for its resumes, in memory only (up to 10 000 entries, cleared with the traces), never in the
  state file: a job that runs after a restart starts a new trace. A job never inherits the span of a request that
  happens to run while the job queue works.
- **Scheduled work is a new root.** Each recurrence occurrence, connector-trigger poll, rollup mass calculation and
  time-to-live purge starts its own trace with a `job` root. It never joins the trace that registered the schedule. A
  pack trigger's `fire()` joins the span it was called from only while that span runs.
- **In-process Dataverse calls nest.** A Dataverse Web API listener request made in process without trace headers, such
  as the model-driven `Xrm.WebApi` of a form, nests under the span that made it; with headers, the headers decide.
- **A commit is an event, not a span.** A store commit adds a `commit` event to the current span. With no current span
  (job bookkeeping, for example) it records nothing, so the list holds no single-span commit traces.
- **A full trace stays one trace.** Once a trace holds `spansPerTrace` spans, every further span of that trace is
  refused and counted in its `droppedSpans`, and the spans opened under a refused span are refused in the same trace:
  they never start a new trace. The response of a refused request still names its trace in `X-Trace-Id`. At level
  `off` nothing is recorded.
- **Sealed flow runs capture no payloads.** A flow run with a `Secret` parameter or any `secureData` action records
  its spans, statuses and timings with `secure: true`, but no input or output on its `flow-run`, `flow-action` and
  `connector` spans, even at level `full`. The child flows it calls and its resumed runs are sealed too.

## Headers

Traces join across loopback HTTP through request headers, and every traced response names its trace:

| Header               | Direction | Meaning                                                                                                |
| -------------------- | --------- | ------------------------------------------------------------------------------------------------------ |
| `X-Trace-Id`         | inbound   | The trace id the new request joins. It is the only inbound header read as a trace id.                  |
| `X-Sim-Trace-Id`     | inbound   | An audit id: the request joins under the span that names that audit entry. Never read as a trace id.   |
| `X-Sim-Parent-Trace` | inbound   | The span the request belongs under: a span id, or an earlier request's audit entry id (its root span). |
| `X-Trace-Id`         | response  | The trace id of this request, on every host including the Dataverse Web API listener.                  |
| `X-Sim-Span-Id`      | response  | The root span id of this request.                                                                      |
| `X-Sim-Trace-Id`     | response  | The request's audit entry id on the Power Pages host (`connectRuntime` sessions read it as `traceId`). |

A client that sends back the trace headers of a response joins that response's trace. Portal pages send
`X-Sim-Parent-Trace` and `X-Trace-Id` on same-origin `fetch` and `XMLHttpRequest` calls unless the script sets them
itself, so the Web API calls a page script makes join the page's trace. The model-driven shell (its own API calls,
custom pages and the `Xrm.WebApi` bridge), the canvas player and the code-app client send the ids of their page root
the same way; the canvas player's source-watch polls send none. Web hook deliveries, every `http-out` request,
connector calls, Service Bus deliveries and the flow HTTP provider forward the headers of the current span:
`X-Trace-Id` (its trace), `X-Sim-Parent-Trace` and `X-Sim-Span-Id` (the sending span), and `X-Sim-Trace-Id` only when
that span or its nearest retained ancestor names an audit entry, with that audit id. The trace id is never sent as
`X-Sim-Trace-Id`.

`X-Sim-Trace-Id` keeps one meaning in both directions: the audit id. Without `X-Sim-Parent-Trace`, a retained span
whose `auditId` attribute equals it (the root of that audited request, or a Liquid read) becomes the parent, in that
span's trace unless `X-Trace-Id` names another. The Power Pages host also resolves it through the audit ledger, whose
entry keeps its `traceId` and `spanId` after the trace left memory; an entry recorded while tracing was off names no
span, and the request starts a new trace. An audit id that names nothing is ignored.

An inbound value that is not a UUID (32 hexadecimal digits in the `8-4-4-4-12` form) is ignored, and the request
starts a new trace; a request can never choose a word such as `stats` as its trace id. When `X-Sim-Parent-Trace` names
a retained span, that span's trace wins over a different `X-Trace-Id`. When it names a span that is not retained but
`X-Trace-Id` names a retained trace, the request joins that trace one level under its root, with a `parent-request`
link to the span it named. When neither is known, the request starts a new trace, named by `X-Trace-Id` when it is
present, and keeps that `parent-request` link. At level `off` roots read no trace header.

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
| `POST /trace/flush`       | Waits until every queued persisted line is written and every live channel frame reached its client, then answers the store status. Running spans are not waited for.                                                                                                                                  |

A trace summary carries `status`, `durationMs`, `totalDurationMs`, the span, error and denied counts, the plug-in,
flow, connector and Dataverse counts, the kinds, tables and modules involved, the root span, `auditId` (the audit
entry id its root names, or `null`) and, once a span ended `error` or `denied`, `firstError`:
`{ spanId, kind, name, status, code, message }` of the first one.

The Health view (`GET /_sim/api/dashboard`) shows the trace store as the `org:trace` node (**Activity**, in the
**Monitor** group of the map, linking to `#activity`) with its level and persistence, and its counters (`retained`,
`spans`, `running`, `dropped`, `droppedSpans`, `latestSequence`) as `activity.trace`.

The list, spans, stats and export routes take the same query parameters:

| Parameter                                  | Matches                                                                                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `from`, `to`                               | ISO time or epoch milliseconds; a trace when any of its spans starts in the range, a span by its own start.                                                               |
| `kind`, `status`                           | Case-insensitive equality with one of the span kinds or the five statuses (`ok`, `error`, `denied`, `cancelled`, `running`).                                              |
| `result`                                   | A comma list of the five statuses, matched against the trace's own status (`running` while a span runs, else the root's); spans and stats keep the spans of those traces. |
| `auditId`                                  | Exact; a span whose `auditId` attribute names that audit entry, a trace when any of its spans does (a Liquid read's audit id finds its page).                             |
| `module`, `operation`, `host`, `actorKind` | Case-insensitive equality (`host` is the origin host).                                                                                                                    |
| `entity` (or `table`)                      | The table's logical name or its entity set name (`contact` or `contacts`), case-insensitive; a span matches under either name. `/audit` takes the same names.             |
| `recordId`, `actorId`                      | Equality ignoring braces and case (`recordId` is the span's record id).                                                                                                   |
| `sessionKey`, `visitorId`, `portal`        | Exact equality (`sessionKey` is `contact:<id>` or `visitor:<id>`).                                                                                                        |

`recordId`, `actorId`, `sessionKey` and `visitorId` also accept a prefix of at least 8 hexadecimal characters, after an
optional `kind:` (`visitor:ad87d220`, as the `_sim` views show ids): it matches every id that begins with it, so an
ambiguous prefix matches every candidate. A shorter value matches exactly.
| `search` | Case-insensitive text in the name, kind, module, operation, entity, record id, actor, error, attribute keys and values, event types, messages and attributes, and at level `full` the input and output (bounded). |
| `traceId` | One trace. |
| `minDurationMs` | A trace's total duration or a span's duration (running spans never match). |
| `hasErrors` | `true` or `false`. |
| `parentSpanId`, `depth` | Spans and stats only. |
| `page`, `pageSize`, `order` | 1-based page, 1 to 200 per page (default 25), `desc` (default) or `asc`. |
| `sort` | The trace list and export: `start` (default, the order the roots started), `duration` (total), `spans` or `errors`. |
| `bucketMs` | Stats timeline bucket; chosen automatically for at most 60 buckets when absent. |
| `format`, `limit` | Export only: `json` (default), `ndjson` or `otlp`, and at most `limit` traces (default 200, 1 to 2000). |

`result` keeps an activity whose own result is listed (`result=error,denied` lists the failed and refused requests),
while `status` keeps one where any span has that status.

A trace matches when one of its spans meets every span filter, so `kind=plugin-step&status=error` lists the traces with
a failing plug-in step. An invalid value, including a `kind`, `status`, `result`, `sort`, `order` or `format` outside its list,
answers 400 `{ error: { code: 'InvalidTraceFilter', message, parameter } }`: `parameter` names the filter, and the
message starts with it and, for a list, names the allowed values and the value it got, such as
`status must be one of ok, error, denied, cancelled, running (got "bogus").` A runtime without a trace store answers
501 `TraceNotConfigured`.

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
- **Kind.** `http` spans are SERVER, `http-out` and `connector` spans CLIENT, `webhook` spans PRODUCER, `job` spans
  CONSUMER, every other kind INTERNAL.
- **Attributes.** The span attributes, plus `mirage.kind`, `mirage.module`, `mirage.operation`, `mirage.entity`,
  `mirage.record_id`, `mirage.status`, `mirage.level`, `mirage.async`, `mirage.depth`, `mirage.host`, `mirage.portal`,
  `mirage.actor.kind`, `mirage.actor.id`, `mirage.session.key`, `mirage.session.visitor_id`, and at level `full` the
  redacted `mirage.input` and `mirage.output` as JSON text.
- **Events, links and status.** Events keep their type, time, message and attributes. Links keep their relation as
  `mirage.relation`. The status is OK for `ok`, ERROR with the error message for `error` and `denied`, and UNSET for a
  span that still runs or was `cancelled`.

### Activity bundle

`GET /_sim/api/activity/export?<filters>&format=bundle` (Power Pages host) takes the filters of `/trace/export`, at most
`limit` activities (default 200, 1 to 2000), and `traces=ndjson` (default) or `traces=otlp`. It streams the attachment
`simulator-activity-bundle.ndjson` (`application/x-ndjson`, with `X-Trace-Export-Matched`): one JSON document per line,
each with a `kind`, in this order:

| `kind`     | Document                                                                                                                                                                                                    |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bundle`   | `{ schemaVersion: 1, exportedAt, timeZone, filters, traces, runtime }`: the runtime's IANA time zone, the query, and the runtime's origin, host, revision, store revision, fingerprints and trace settings. |
| `activity` | `{ trace, spans }` per matching trace in list order (`traces=ndjson`).                                                                                                                                      |
| `otlp`     | One `{ resourceSpans }` document with every matching trace (`traces=otlp`), mapped as below.                                                                                                                |
| `audit`    | `{ entry }` per retained audit entry of a matching trace.                                                                                                                                                   |
| `log`      | `{ line }` per retained log line of a matching trace.                                                                                                                                                       |
| `finding`  | `{ diagnostic }` per finding of a matching trace. A plug-in step, flow trigger, connector or flow action finding also carries `name`, `entity` (when there is a table) and, for plug-in steps, `message`.   |
| `evidence` | `{ path, time, passed, verified, stale, differences, artifactUrls }` when a verification report exists.                                                                                                     |
| `end`      | `{ counts: { activities, audit, logs, findings, evidence } }`.                                                                                                                                              |

A filter that names nothing but `from` and `to` (or nothing) also takes the log lines and findings that belong to no
trace, such as startup lines and load findings, when their time is in the range. Any other `format` answers 400
`InvalidActivityExport` naming `format`, and a `traces` value other than `ndjson` or `otlp` the same naming `traces`.

### Live channel

Both hosts also serve `GET /_sim/events?channels=trace`: server-sent `event: trace` frames. The first is
`{ type: 'connected', status, events, traceId }`, then `{ type: 'span-start' | 'span-end' | 'trace-end', span, trace? }`
as spans start and end. `events=<type>[,<type>]` keeps only those frame types (`span-start`, `span-end`, `trace-end`;
all three by default) and `traceId=<id>` only the frames of that trace; the runtime filters them, so a type no client
asks for is never built. An unknown type answers one `{ type: 'error', error: { code: 'InvalidTraceFilter', parameter:
'events', message } }` frame and ends the stream. Frames never carry captured inputs or outputs; read the trace for them. A `trace-end` frame carries
`trace.evicted: true` for a trace that left the store while it still ran. Frames are built only while a subscriber is
connected. Every frame is written, so a client that keeps reading loses none however large a burst is. A client that
disconnects, even before its first frame, leaves no subscription behind; a client that stops reading is disconnected
when it has not drained its buffer 5 seconds after a refused write, or when its buffer is full again after three
drains in a row (an `EventSource` reconnects by itself).

### Testing client and in-process handle

`connectRuntime()` from `paqvilo/mirage/testing` has a `trace` member over these routes: `query(filters)`,
`spans(filters)`, `tree(traceId)`, `span(spanId)`, `ancestry(spanId)`, `stats(filters)`, `export(filters)`,
`settings()`, `status()`, `configure(partial)`, `clear()`, `flush()` and `subscribe(listener, { signal, events,
traceId })`. Beside `trace`, `logs({ since, limit, type, traceId })` reads `GET /_sim/api/logs`,
`diagnostics(filters)` passes `traceId`, `audit({ traceId })` takes one id, a comma list or an array, and
`exportBundle(filters)` returns the documents of the [activity bundle](#activity-bundle) in order.

- Filters are plain objects, such as `{ recordId, kind: 'plugin-step' }`. A `Date` is sent as its ISO time with
  milliseconds, and `undefined` or `null` members are left out.
- `tree` and `span` answer `null` for an id that is not retained, and `ancestry` answers `[]`; `ancestry` lists the
  spans from the root down to the span.
- `export({ format })` answers the parsed document for `json` and `otlp`, and the array of `{ trace, spans }` lines for
  `ndjson`.
- `flush()` resolves with the store status once the runtime wrote its queued persisted lines and handed its live
  frames to the sockets.
- `subscribe` follows the live channel: the listener receives every frame, `connected` first; `events` (a type or an
  array) and `traceId` narrow the frames as the channel's query does. It returns an
  `unsubscribe()` function whose `closed` promise resolves when the stream ends (unsubscribe, the signal, or the runtime
  stopping) and rejects when the stream cannot be opened or the listener throws.
- A refused request rejects with the runtime's `status`, `code` and, for a filter, `parameter`. A runtime that does not
  answer rejects with the code `RuntimeUnreachable`; one that accepted the connection and closed it before the response
  completed rejects with `RuntimeConnectionLost`. Both keep the fetch error as `cause`. Writes send the CSRF token for
  you.

The in-process handle from `createSimulator` exposes the store's reads as `simulator.trace`: `query`, `spans`, `tree`,
`span`, `ancestry`, `stats`, `export`, `settings`, `status`, `configure` and `clear` answer synchronously, `flush()`
returns a promise that settles once the queued persisted lines are written and the live frames reached their clients,
and `subscribe(listener, { payloads, events, traceId })` delivers frozen event copies, with captured payloads unless
`payloads: false`; `events` (a type or an array) and `traceId` narrow the frames as for the testing client.

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

| Action          | Prints                                                                                                                                                                                                                                                           |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list`          | One row per trace: start, status, root duration, total duration, span, error and denied counts, host, actor, session, name, trace id.                                                                                                                            |
| `show TRACE_ID` | The trace summary and its span tree, one indented line per span, with errors.                                                                                                                                                                                    |
| `spans`         | One row per span: start, kind, status, duration, entity, record id, actor, name, span id.                                                                                                                                                                        |
| `stats`         | The overall and root figures (count, errors, p50, p95, max), the same figures by kind, then the slowest spans. A percentile with no ended span prints `—`.                                                                                                       |
| `settings`      | The settings in force and the store status; `--level`, `--persist`, `--traces`, `--spans-per-trace` and `--payload-bytes` change them.                                                                                                                           |
| `clear`         | Drops every retained trace.                                                                                                                                                                                                                                      |
| `flush`         | Waits until the runtime wrote its queued persisted lines and live frames, then prints the store status.                                                                                                                                                          |
| `export`        | The matching traces as the runtime streams them, in `--format json` (default), `ndjson` or `otlp`, at most `--limit N` (default 200, at most 2000); redirect to a file. `--format bundle` prints the [activity bundle](#activity-bundle), one document per line. |
| `watch`         | One line per ended span as it happens, or per ended trace with `--trace-end`, until Ctrl+C, `--count N` lines or the runtime stopping.                                                                                                                           |

`list` prints `DURATION` (the root span's) and `TOTAL` (first span start to last span end, what `--sort duration` sorts
by). `list` and `spans` print local time (`YYYY-MM-DD HH:MM:SS.mmm`) with the UTC offset once in the `STARTED` header; `--utc` prints ISO UTC instead.

The filters are flags with the parameter names in kebab case: `--from`, `--to`, `--kind`, `--module`, `--operation`,
`--entity`, `--record-id`, `--status`, `--host`, `--actor-kind`, `--actor-id`, `--session-key`, `--visitor-id`,
`--portal`, `--audit-id`, `--result`, `--search`, `--trace-id`, `--parent-span-id`, `--depth`, `--min-duration-ms`, `--has-errors`, `--page`,
`--page-size`, `--order`, `--sort` and `--bucket-ms`. They apply to `list`, `spans`, `stats` and `export`; on `clear`,
`flush`, `settings` and `show` they are refused. The command checks the values with the runtime's own rules before it
connects.

`watch` takes the same filters except the paging and ordering flags, and applies them to each frame it receives: to
the ended span, or with `--trace-end` to the ended trace. For a trace, `--kind`, `--module` and `--entity` match any
span of it, `--status error` and `--status denied` match a trace with such a span, `--min-duration-ms` and
`--has-errors` match the whole trace, and the other filters match its root span. `--search` reads the same text as the
`search` filter, without payloads (frames carry none). When the runtime stops, or on Ctrl+C, `watch` prints
`stream ended` on stderr and exits 0.

`--json` prints one envelope for every action: `{ schemaVersion: 1, ok: true, command, result }`. `result` is what the
matching route answers: the page envelope for `list` and `spans`, the tree for `show`, the stats document for `stats`,
`{ settings, status }` for `settings`, the store status for `clear` and `flush`, and the export document for `export`
(the array of lines with `--format ndjson`, the array of bundle documents with `--format bundle`). `watch --json` prints one envelope per line, with the frame as `result`. A
failure prints `{ schemaVersion: 1, ok: false, command, error: { code, message, parameter? } }`; without `--json` it
prints the message on stderr, as `<code>: <message>` when the runtime answered with an error envelope (such as
`InvalidTraceFilter: limit must be an integer from 1 to 2000.`). A filter or setting that the command or the runtime
refuses exits 2; every other failure exits 1:

| Code                    | Exit | Meaning                                                                                                |
| ----------------------- | ---- | ------------------------------------------------------------------------------------------------------ |
| `InvalidArguments`      | 1    | A flag, action, origin or argument the command refuses before it connects.                             |
| `RuntimeUnreachable`    | 1    | No runtime answers at the origin.                                                                      |
| `RuntimeConnectionLost` | 1    | The runtime accepted the connection and closed it before the response completed.                       |
| `TraceNotFound`         | 1    | `show` names a trace that is not retained.                                                             |
| `InvalidTraceFilter`    | 2    | A filter, sort, format or limit is refused; `parameter` names it and the message starts with it.       |
| `InvalidTraceSettings`  | 2    | The runtime refused a settings change.                                                                 |
| `MIRAGE_FAILED`         | 1    | Any other failure. Other runtime codes, such as `TraceNotConfigured`, are passed through as they come. |

```sh
node bin/paqvilo.mjs mirage trace list --origin http://127.0.0.1:8787 --has-errors true --sort duration
node bin/paqvilo.mjs mirage trace show 2f0c4c1e-6f8a-4d1b-9a43-4d3a1f1d2c11 --origin http://127.0.0.1:8787
node bin/paqvilo.mjs mirage trace spans --record-id 6c1f0b4e-0d3a-4f7e-9b1a-2d5e8c7f9a10 --origin http://127.0.0.1:8787
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
carries `trace.evicted: true`, and it is written again when its last span ends. A link added to a persisted span later,
such as the `triggered` link of a job that ran after the trace ended, writes that span again in the trace's next line.

Lines are built after the response is sent, never while it is written. Writes are queued in order and never fail a
request; the settings status reports the directory, the lines written, the failures and the last error, and `flush`
waits for the queue. A runtime without a state folder (memory-only state or `--simulation dry-run`) accepts
`persist: true` but writes nothing and reports `lastError: 'NoStateDirectory'`, which Activity's **⚙ Settings** and
`trace settings` show. Persisted traces are not read back on restart: the files are for your own analysis. Delete them
like any other local state.

## Privacy and redaction

- Inputs and outputs are captured only at level `full`, and always through the same redaction. Values under
  credential-named keys (passwords, secrets, tokens, authorization and authentication, cookies, credentials, API keys,
  signatures, connection strings, SAS and shared access signatures, account, subscription, private and function keys)
  become `[redacted]`, and so does the `value` of a `{ key, value }` pair whose key is credential-named. The `sig` and
  `code` URL query parameters are hidden too. The `secretName` of a secret span names a Key Vault secret, never its
  value, and stays readable. In text, `Bearer`, `Basic`, `Digest` and `SharedAccessSignature` credentials,
  `name=value` credentials and signed URL query strings (`?code=`, `&sig=`) are masked, and secret-named FetchXML
  conditions are hidden.
- File and binary columns are summarised, never copied: a note's `documentbody`, binary data, a data URL or base64
  under `body` or an image key, and any data URL or base64 longer than 1 KB become `{ bytes, mimetype, filename,
sha256 }`, the size and SHA-256 of the decoded bytes with the MIME type and file name when they are known.
- Secret resolution records the key, vault, secret name and the status only. Secret values, bearer tokens, cookies,
  the token request of a sign-in and sealed (secure) flow inputs and outputs are never stored.
- Attribute strings and event messages pass the same text redaction at every level. Live frames never carry inputs or
  outputs.
- Traces live in the runtime's memory, and on disk only with `persist: true` in the state folder. Treat an export like
  any other local evidence: it can contain business data at level `full`, so keep it out of source control.
