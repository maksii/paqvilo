# Server logic and cloud flows

Mirage inventories exported operations automatically: portal server logic, cloud-flow consumers, matching enhanced
site records in selected Solutions, Solution workflow definitions and Solution plug-in steps. Review their source,
route, access and local behaviour at `/_sim/#operations` on the administration address (`adminUrl`). Mirage never
forwards a definition to Power Automate; to compare with the platform, compare run and action traces and resulting
data from an authorized environment running the same export.

## Choose local behaviour

| Mode                    | Result                                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| Placeholder             | HTTP 501 identifies an operation without a supported local implementation                          |
| Supported exported flow | Runs the imported actions for a Power Pages Request or a supported activated Dataverse row trigger |
| JSON mock               | A response body and status for success, empty, validation or failure scenarios                     |
| Exported server logic   | Explicitly runs exported JavaScript against the local data store                                   |
| Project provider        | A trusted pack handler for business logic or unsupported integrations                              |
| Disabled                | Deliberately skips the flow or exact action and keeps a trace of that choice                       |

Save a behaviour for an operation and call its exported route from the portal; **Use source default** removes the
override. Overrides change simulation state only; they never deploy the source or activate an online flow.

- A discovered flow defaults to exported only when its trigger is supported, it has a portal consumer route or a
  Dataverse trigger, and every connector call (a Dataverse trigger included) resolves to a bound connection; otherwise
  it stays a placeholder. A manual, HTTP Request or Recurrence flow without a consumer therefore needs an explicit
  exported choice before `POST /_sim/api/flow-runs` or its trigger host runs it. Unsupported expressions,
  connectors and execution settings need an exact per-action mock or disabled choice.
- An unlinked workflow stays visible and accepts a local mock or disabled choice without an invented route or role
  grant; configuration alone never invokes it. A supported activated Dataverse row trigger with an explicit backend
  profile runs without a portal consumer; a Power Pages Request workflow needs its consumer export for its route and
  web-role binding, and those role checks still apply when the response is mocked.
- Plug-in steps run through the local CRUD stages, not a URL. Each step can take a target-field mock, a validation
  rejection or a trusted handler; see [Dataverse plug-ins](dataverse-plugins.md).

## Execution boundary

Imported routes keep their exported web-role checks, and local data access applies the current identity and table
permissions. Exported server logic can query and change local records through the supported Dataverse helpers; writes
need a verified HTTP write request and the native CSRF checks, and Liquid helper calls stay read-only. Workers and
interpreter budgets bound execution time but are not a sandbox for untrusted code: enable exported code only from
sources you trust.

Server logic reaches the host only through these bridges. A bridge whose host service is absent answers status 501
with `ServerError: true`, never success.

For HTTP invocations, `Server.Context.Url` carries the full local request URL and `Server.Context.Headers` carries
request headers with credential values redacted.

| Bridge                                                                           | Local behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Server.Connector.Dataverse.InvokeCustomApi(httpMethod, url, payload)`           | Runs the custom API through the operation registry (unbound `name`, or `set(id)/Microsoft.Dynamics.CRM.name`; function parameters as inline literals) as the principal below. A bound row must be readable by the signed-in contact, else 403. Answers the server-object envelope (`StatusCode`, `Body`, `IsSuccessStatusCode`, `ReasonPhrase`, `ServerError`, `ServerErrorMessage`, `Headers`).                                                                                    |
| `Server.Connector.CloudFlow.TriggerAsync(flowId, payload)`                       | Runs the site's cloud flow like `/_api/cloudflow/v1.0/trigger/<guid>` and answers the [flow API](#power-pages-flow-api)'s status and body in the envelope (a refusal, a run that ended without its Response and a Response status alike), with its web-role check. The payload carries `siteId` (the site's `Portal.id`), `siteUrl` (the local site origin, no trailing slash) and `userId` first. A flow without a Response answers 202 with an empty `Body`, reported as success. |
| `Server.Connector.HttpClient.GetAsync/PostAsync/PutAsync/PatchAsync/DeleteAsync` | Contract: the URL is rewritten by the connections' `settings.rewrites`, and only a loopback target is called (no redirects). Any other host answers `StatusCode` 502, `ServerError: true`, `ServerErrorMessage: 'HTTP target is not a declared local service'` and records `SERVER_LOGIC_HTTP_REFUSED`.                                                                                                                                                                             |
| `Server.Logger.Log/Warn/Error`                                                   | Lines go to the diagnostics stream (`SERVER_LOGIC_LOG`) with the operation id (`Server.Context.ActivityId`).                                                                                                                                                                                                                                                                                                                                                                        |
| `Server.EnvironmentVariable.get(name)`                                           | Non-secret effective values; see [environment variables and secrets](deployment-profiles.md#environment-variable-types-effective-values-and-secrets).                                                                                                                                                                                                                                                                                                                               |

### Server logic site settings and principal

- `ServerLogic/Enabled` false refuses every call with 403 `ServerLogicDisabled` (`SERVER_LOGIC_DISABLED`).
- `ServerLogic/AllowedDomains` (comma or semicolon separated; a domain allows its subdomains) and
  `ServerLogic/AllowNetworkingToAllDomains` (false with no list refuses every host) are checked against the original
  HttpClient host before any rewrite; a refused host answers the 403 envelope and records
  `SERVER_LOGIC_HTTP_DOMAIN_BLOCKED`.
- Time limit: a local run defaults to 5 seconds. The simulator option `serverLogicTimeoutMs` (milliseconds, a finite
  number above 0, else a `TypeError`) replaces the default. The applied limit is capped at
  `ServerLogic/TimeoutInSeconds` (default 120, at most 240) and never below 100 ms; a site value above the local limit
  records `SERVER_LOGIC_TIMEOUT_LOCAL` (info). A run stopped at the limit answers 500 `ServerLogicTimeout`
  (`Server logic exceeded its time limit of 5000 ms (serverLogicTimeoutMs, at most ServerLogic/TimeoutInSeconds).`),
  and an exception the exported code does not catch answers 500 `ServerLogicFailed` with the exception's message.
- `InvokeCustomApi` never runs as SYSTEM. Under enhanced authorization it runs as the visitor's mapped Dataverse user
  when there is one; otherwise as the site's application user: the observed one
  (`observed.portalApplicationUserId`) when that row exists, else a local application user `# Portals-<site name>`
  created once with System Administrator standing in for the native Portal Application User, Service Writer and
  Service Deleter roles.
- The capability record `serverLogic` lists Dataverse, InvokeCustomApi, CloudFlow, Logger, EnvironmentVariable and
  site settings at `behaviour`, HttpClient at `contract`.

## Cloud flows

Imported definitions run in a bounded local interpreter. This local queue and interpreter are not the Power Automate
scheduler or its retry service.

### Triggers

| Trigger                                                           | Local behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Power Pages Request                                               | Runs from its portal consumer through the [Power Pages flow API](#power-pages-flow-api). The declared trigger schema is enforced at the run's start: input it refuses answers 400 `IncorrectPayload`, fails the run before its first action and reports the warning `FLOW_TRIGGER_SCHEMA_ENFORCED`, because a hosted site runs the flow with whatever was sent; `observed.powerPagesFlowTriggerSchema: not-enforced` reproduces that. A run that waits before its Response holds the request, on the runtime clock, until the resumed run answers its Response or ends, for up to 120 seconds after the request arrived; then the request answers 400 `BadGateway`, the run continues and its Response action fails the run. Without the run store the request answers 202 `Default`. |
| Manual (`Button`)                                                 | Runs as a child flow or on demand (`POST /_sim/api/flow-runs`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| HTTP Request (`kind: Http`)                                       | On demand through `POST /_sim/api/flow-triggers/<flowId>`; its signed callback URL is served only locally. The body is checked against the schema only with `operationOptions: EnableSchemaValidation` (400 `InvalidRequest`), as for [Schema Validation](https://learn.microsoft.com/en-us/azure/connectors/connectors-native-reqres#add-a-request-trigger); Button triggers always check it.                                                                                                                                                                                                                                                                                                                                                                                        |
| `Recurrence`                                                      | Runs on the runtime scheduler once the flow has the exported choice and explicit local activation (rules below).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Dataverse row trigger                                             | Added, modified, deleted and combined messages, Organization scope, scalar submitted-column selection and saved-row OData filters (rules below).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Dataverse "When an action is performed" (`BusinessEventsTrigger`) | Each committed run of the named custom API (`catalog`, `category`, `entityname`, `sdkmessagename`; `entityname` `none` for an unbound action) stages a durable job that starts a run (trigger type `Automated`) with body `{ InputParameters, OutputParameters }`. A rolled-back action starts nothing. A trigger without `catalog` and `category` matches by action name. Otherwise the Solution's Dataverse "Catalog" and "Catalog Assignment" rows (`catalog`, `catalogassignment`) must assign the action to that category; when no `catalog` row is loaded it matches by action name and records `FLOW_TRIGGER_CATALOG_UNCHECKED`.                                                                                                                                               |
| Connector webhook or polling trigger                              | Contract, only when a pack `flowTriggers` export hosts its connector operation: subscribed on activation, a run per `fire(body)`, a polling `poll()` at the recurrence `frequency` and `interval` from `startTime` (a schedule does not apply), unsubscribed when the flow is disabled or the runtime closes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

Without a host, another connector trigger answers `Unsupported trigger <type>/<operation> (<connector>; no pack
flowTriggers entry hosts it); configure an explicit flow mock or disable it.` Request triggers with splitting,
concurrency, recurrence, operation options or unsupported inputs are explicit capability errors.

**Activation.** Draft or unknown activation stays inactive. **Explicitly activate this source locally** (or
`{ mode: 'exported', activation: 'local-enabled' }` through `PATCH /_sim/api/operations/<key>` or
`PATCH /_sim/api/config`) records a local override without altering the export or the online flow. Both hosts
re-synchronize the Recurrence and connector trigger hosts at startup and after every override, so the flow is scheduled
at once. The `flow-triggers` capability record is part of the host registry.

**Recurrence.** `frequency` Second to Month, `interval`, optional `startTime`, `timeZone` and `schedule`. `timeZone` is
an IANA name resolved through Intl, or a Windows id mapped through the Unicode CLDR 45 windowsZones table (territory
001, `mirage/lib/windows-time-zones.mjs`); any other id is refused by name (`Coordinated Universal Time` reads as UTC).
A `startTime` without `Z` or an offset is wall-clock time in that zone. `schedule` takes `hours` and `minutes` (Day,
Week, Month), `weekDays` (Week) and `monthDays` (Month, `-1` for the last day); a schedule on another frequency or an
unknown key is an error. With a schedule, or a non-UTC zone on Day, Week or Month, occurrences are wall-clock times in
the zone across daylight-saving changes, no sooner than `startTime`, with unset parts taken from `startTime` (or the
moment the host was armed); otherwise occurrences follow `startTime` in whole intervals. Missed occurrences are not
back-filled.

**Row triggers.** An unchanged submitted update column still matches selection; Create and Delete ignore update select
columns; lookup-column selection needs metadata and is otherwise ignored. Other ownership scopes, runAs, Delete-filter
payload semantics and unsupported source settings are reported unsupported. A row-triggered run can succeed without an
HTTP Response; a request-triggered run cannot invent one.

**Trigger conditions.** Source `conditions: [{ expression: '@...' }]` (at most 100) run before a run is created, for
every trigger host. Each must evaluate to boolean true; false creates no run history or effects
([Microsoft](https://learn.microsoft.com/en-us/power-automate/customize-triggers)) and reports `FLOW_TRIGGER_SKIPPED`.
HTTP routes and Power Pages calls answer a skipped request with 202 and no run id; a parent `Workflow` action whose
child condition is false fails `ChildFlowNotStarted`. Conditions use the supported functions, the trigger body and
non-secret parameters; unknown functions, malformed syntax, unavailable fields and non-boolean results are errors.
Uncaptured trigger headers or status metadata and secret parameters are not invented.

**Committed-event queue.** Only committed events trigger runs: a failed primary write emits nothing, while an
independently committed top-level PreValidation SDK write keeps its events. Each accepted run is a Ready
`asyncoperation` row (System Event) holding the event, run FIFO by the store's durable job runner together with
asynchronous plug-in steps ([Dataverse plug-ins](dataverse-plugins.md)); the row is removed when the run ends, and Ready
rows resume once after a restart. The queue never drops runs: past 100 queued runs (and each further 100) it records
`FLOW_TRIGGER_BACKLOG`. Recursive plug-in and flow chains are bounded (depth 8 by default, at most 16) and drain
before reload or stop. Job errors are separate from the original response. Tests drive the queue with a manual
scheduler (`createScheduler({ clock: fixedClock(), manual: true })` as the organization runtime's `scheduler`) and
`runDue()`.

### Power Pages flow API

`POST /_api/cloudflow/<version>/trigger/<processid>` answers as hosted Power Pages does (hosted session F8). Any
version segment is routed; the id is the consumer's process id in any letter case, with or without a trailing slash.
Error bodies are `{ "ErrorCode", "Message" }` as `application/json; charset=utf-8`.

| Request                                                                                                                                                                                                                               | Answer                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Another method than POST                                                                                                                                                                                                              | 404, no body                                                                                                                         |
| No `__RequestVerificationToken` of the session, no `X-Requested-With`, or a body that does not parse                                                                                                                                  | 500 with the platform error page; the flow does not run                                                                              |
| An `eventData` string that is not JSON                                                                                                                                                                                                | 500, no body                                                                                                                         |
| No id (`/trigger/`)                                                                                                                                                                                                                   | 400 `{ "error": { "code": "9004010A" } }`                                                                                            |
| An id that is not a process id of the site's consumers (braced, a consumer id, unknown, malformed, another site's flow)                                                                                                               | 404 `00000005` `IncorrectFlowId`                                                                                                     |
| A caller without one of the consumer's web roles                                                                                                                                                                                      | 403 `00000003` `MissingPermissions`; a signed-in visitor does not hold Anonymous Users                                               |
| A workflow that is not activated: its `.data.xml` has a `StateCode` other than 1, or none (Mirage seeds its workflow row as Draft), or its workflow row was set to Draft through the Dataverse API; explicit local activation runs it | 400 `00000002` `FlowDisabled`                                                                                                        |
| A consumer whose workflow is not in the sources                                                                                                                                                                                       | 404 `00000008` `FlowNotFound`, with `CLOUD_FLOW_DEFINITION_MISSING`: select the flow's Solution or configure a local mock or handler |
| A body without an `eventData` string (raw JSON, `eventData` as an object, empty)                                                                                                                                                      | The flow runs and its Response action fails                                                                                          |

The trigger body is `siteId` (the site's `Portal.id`: the
[observed](../../docs/configuration.md#observed-platform-behaviour) `portalId`, else the website id), `siteUrl` (the
site origin, no trailing slash) and `userId` (the contact id; `null` for an anonymous caller, which is not captured), then the event data; the injected values win over
same-named event data. `Server.Connector.CloudFlow.TriggerAsync` sends the same three values.

| Flow outcome                                                                                                                            | Answer                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Response 200                                                                                                                            | 200 with the body (a string as is, anything else as JSON text), `text/html; charset=utf-8`                              |
| Response 204                                                                                                                            | 204, no body                                                                                                            |
| Response 201 or 202 (another 2xx: inferred, not captured)                                                                               | That status, `0000000B` `Default`                                                                                       |
| Response 404                                                                                                                            | 404 `00000008` `FlowNotFound`                                                                                           |
| Response 400 or 409 (another 4xx except 404: inferred, not captured)                                                                    | That status, `00000006` `IncorrectPayload`                                                                              |
| Response 500 or 503 (another 5xx: inferred, not captured)                                                                               | 400 `{ "ErrorCode": "IncorrectPayload", "Message": "BadGateway" }`                                                      |
| No Response action in the definition, however the run ends                                                                              | 202 `0000000B` `Default`                                                                                                |
| The run ends without answering its Response (a failed action, a computed 3xx, `Terminate` with any status, a cancelled run)             | 400 `IncorrectPayload`, "The server did not receive a response from an upstream server. Request tracking id '<runId>'." |
| No Response within 120 seconds of the request (also a data pack's cloud-flow handler that does not answer within 120 seconds: inferred) | 400 `IncorrectPayload` `BadGateway`                                                                                     |

Custom Response headers are dropped. Answers carry `cache-control: no-cache, no-store, must-revalidate`,
`pragma: no-cache` and `expires: -1`; an anonymous caller's refusal (`MissingPermissions`, `IncorrectFlowId`) carries `cache-control: private` as captured; on
other error answers to an anonymous caller (a flow's Response or outcome) that is inferred, not captured. The
workflow-state checks (`FlowDisabled`, `FlowNotFound`) apply to exported and placeholder flows; a local mock or pack
handler answers without reading the definition. A run that a
`Terminate` ends with Succeeded or Cancelled keeps that status; a failure after the Response still fails the run. A
Response whose caller no longer waits (the 120 seconds passed, or the body had no `eventData` string) fails, and the run
ends Failed with `ActionFailed` "An action failed. No dependent actions succeeded."; the run record keeps that the
caller stopped waiting, so a resume after a restart fails the Response too.

### Actions and limits

Supported actions: variables, Compose, conditions, scopes, `Foreach`, `Until`, `Switch`, `runAfter`,
Response/Terminate, `Wait`, the data operations ParseJson, Select, Query (Filter array), Join and Table (CSV or HTML),
child flows (`Workflow`), the `Http` action, the connector operations under
[connections and connectors](#connections-and-connectors), and pack `flowActions` action types (contract; run with
resolved inputs and journalled like connector actions, see [data packs](data-packs.md)).

| Limit                                   | Value                                                                                                                  |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Source actions per definition           | 250                                                                                                                    |
| Executed actions per run (`maxActions`) | default 2,000, at most 10,000                                                                                          |
| Run time                                | none, unless the caller passes `limits.timeoutMs` (store clock; the next action after it fails 504 `LocalFlowTimeout`) |
| Loop items (`maxIterations`)            | `Foreach` items and `Until` iterations: default 100, at most 1,000                                                     |
| `Until`                                 | `limit.count` default 60, at most 5,000 and `maxIterations`; `limit.timeout` default `PT1H` (then `TimedOut`)          |
| Concurrent `Foreach`                    | a top-level `Foreach` with `runtimeConfiguration.concurrency.repetitions` 1–50; others run sequentially                |
| Child flow depth                        | 16 (`FLOW_MAX_DEPTH`, `ChildFlowDepthExceeded`, 400)                                                                   |
| Request and ParseJson schema            | depth 32; 10,000 traversal and 10,000 evaluation checks                                                                |
| Expression nesting                      | 64 levels, chained property access included                                                                            |

- **ParseJson and Request schemas** support `type`, `enum`, `required`, `properties`, `items`, `additionalProperties`
  and bounded `allOf`, `anyOf` and `oneOf`
  ([composition](https://json-schema.org/understanding-json-schema/reference/combining)), keeping sibling constraints,
  exact numeric types and nested boolean schemas; annotations are ignored. Other assertions and `$ref` fail explicitly
  (even in an unchosen branch) and are never resolved remotely. A value mismatch is `ValidationFailed`; an unsupported
  schema is `LocalFlowUnsupported`.
- **Concurrency.** Actions with no runAfter path between them start together, and a join waits for every dependency.
  Branches whose runAfter statuses on the same predecessor exclude each other are not concurrent. A waiting action
  (`Wait`, approval, waiting child) holds only its branch; the others' built-in actions continue, so a Response in a
  concurrent branch answers before the run waits (the `/_sim/api` start routes return that Response too), while
  provider-backed actions and further waits run after the resume. Branches that write the same variable, where one
  writes what another reads (`variables('<name>')` in inputs, expressions or `foreach`), or that both answer a
  Response need an explicit mock or disabled choice (else the run fails 501 `LocalFlowUnsupported` naming the
  actions), as do concurrent `Foreach` iterations that write a variable. A dynamic variable name or malformed
  expression cannot prove independence. Mocked and disabled actions are excluded; variable names are case-sensitive.
- **Completion.** `Terminate` stops the run at once; with `runStatus` `Failed` or `Cancelled` it fails with its
  `runError.message` (`LocalFlowTerminated`). Completion follows terminal branch statuses: a successful failure handler
  resolves its branch and a skipped terminal action inherits its predecessor's status
  ([error handling](https://learn.microsoft.com/en-us/azure/logic-apps/error-exception-handling)); unchosen branches
  keep Skipped states. Response accepts 2xx, 4xx and 5xx; a static 3xx is rejected before execution and a computed one
  fails the action. Response headers are validated locally.
- **Variables** must be declared at the global workflow level (nested declarations are rejected unless mocked or
  disabled) and get no inferred default without an initial value.
- **Not approximated:** an action-level `retryPolicy`, `operationOptions`, `limit` (except on `Until`) or
  `staticResults`, and arbitrary external connectors. A connector action accepts `runtimeConfiguration.secureData` and
  `inputs.retryPolicy` ([flow runs](#flow-runs-waits-and-approvals)).

### Expressions

The interpreter implements these functions, and refuses an argument count outside each one's range before execution:
`triggerBody`, `triggerOutputs`, `item`, `variables`, `parameters`, `body`, `outputs`, `actions`, `items`, `concat`,
`and`, `or`, `coalesce`, `createArray`, `equals`, `not`, `if`, `add`, `sub`, `mul`, `div`, `mod`, `greater`,
`greaterOrEquals`, `less`, `lessOrEquals`, `string`, `int`, `float`, `json`, `length`, `empty`, `contains`,
`startsWith`, `endsWith`, `split`, `join`, `substring`, `skip`, `take`, `first`, `last`, `toLower`, `toUpper`, `trim`,
`replace`, `ticks`, `utcNow`, `formatDateTime`, `addDays`, `addHours`, `addMinutes`, `addSeconds`, `addToTime`,
`subtractFromTime`, `startOfDay`, `startOfHour`, `startOfMonth`, `dayOfWeek`, `dayOfMonth`, `dayOfYear` and `guid`
([function reference](https://learn.microsoft.com/en-us/azure/logic-apps/expression-functions-reference)).

- **Dates and ids** read the run's `store.clock` and `store.ids`, so a fixed store repeats results. `utcNow([format])`
  and `formatDateTime(timestamp[, format[, locale]])` default to `o`. `addDays`/`addHours`/`addMinutes`/`addSeconds`
  take `(timestamp, interval[, format])`; `addToTime`/`subtractFromTime` take `(timestamp, interval, unit[, format])`
  with Second to Year (a short month clamps the day); `startOfDay`/`startOfHour`/`startOfMonth` take
  `(timestamp[, format])`; `dayOfWeek` (0 is Sunday), `dayOfMonth` and `dayOfYear` return integers; `guid([format])`
  takes N, D (default), B, P or X. Formats are .NET date patterns for en-us, the only locale. A bare time is refused.
  Invalid input fails `LocalFlowExpression` (400).
- **`ticks(timestamp)`** takes UTC `yyyy-MM-ddTHH:mm:ss[.fffffff]Z` in years 0001–9999 and returns exact 100-ns
  intervals since 0001-01-01 as Int64; invalid dates, zone-less values and other offsets are refused.
- **Strings and collections.** `split` treats a nonempty delimiter literally (empty is refused); `join` uses the Join
  action's exact conversion and refuses results above 104,857,600 characters; `substring`, `skip` and `take` need
  non-negative safe integers and reject overflow; `skip` and `take` keep collection types. `startsWith` and `endsWith`
  are case-insensitive and need two strings (null fails: use `coalesce(item()?['x_name'], '')`); `contains` is
  case-sensitive.
- **Syntax.** Interpolation keeps literal `@@{...}` escapes and exact numeric digits ([expression
  syntax](https://learn.microsoft.com/en-us/azure/logic-apps/workflow-definition-language-schema#expressions)). Omitted
  arguments, including a trailing comma, are rejected; commas inside quoted strings and zero-argument calls are valid.
  Quoted or escaped expression-looking text is literal. Expression failures still allow ordinary `runAfter` handling.

Two pure APIs from `paqvilo/mirage/fixtures` check expressions and conditions without starting a run or a provider:

```js
import { inspectFlowExpression, evaluateFlowTriggerConditions } from 'paqvilo/mirage/fixtures';

const syntax = inspectFlowExpression("@equals(triggerBody()?['enabled'], true)"); // { supported, diagnostics: [{ code, message }] }
const matches = evaluateFlowTriggerConditions(definition, { input, parameters });
```

`inspectFlowExpression` reports syntax, known-function and arity diagnostics with the execution signatures; it never
evaluates dynamic fields or infers types from an absent schema or sample.

## Connections and connectors

An `OpenApiConnection` action, the built-in `Http` action and a Dataverse trigger resolve along this chain, and every
failed hop is a coded error, never an implicit success:

1. the action's `host.connectionName` names an entry of the flow's `properties.connectionReferences`, giving the
   connection reference logical name;
2. the `connectionreference` row with that name gives the bound `connectionid`;
3. the project `connections[<connectionid>]` entry gives connector, provider, principal and settings;
4. the provider runs the operation.

An action without a connection reference (the built-in `Http` action) uses `connections.<connectorId>` when declared,
else the connector's built-in provider. A pack `flowIdentities[<processId>]` profile overrides a connection principal
and binds Dataverse actions on its own. Portal role access and flow connection identity are separate.

| Provider                  | Level                                                 | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dataverse`               | behaviour (files and bound/unbound actions: contract) | Dataverse connector operations through the organization record pipeline ([below](#dataverse-provider)).                                                                                                                                                                                                                                                                                                                                              |
| `http`                    | behaviour                                             | The `Http` action: `settings.rewrites` (longest prefix first), then only loopback URLs, no redirects, the remaining flow time as timeout.                                                                                                                                                                                                                                                                                                            |
| `fixture`                 | behaviour                                             | The `Http` action answered by pack `httpFixtures` (method and URL pattern); no network.                                                                                                                                                                                                                                                                                                                                                              |
| `pack:<id>`               | behaviour                                             | Pack `connectors[<connectorId>].operations[<operationId>]` called with `(request, context)`. Pack connector ids cannot be `flow`.                                                                                                                                                                                                                                                                                                                    |
| `memory-queue`            | behaviour (native envelope: contract)                 | Service Bus queue actions `SendMessage`, `SendMessages`, `GetMessagesFromQueueWithPeekLock`, `CompleteMessageInQueue`, `AbandonMessageInQueue`, `DeadLetterMessageInQueue` over the [local bus](messaging-and-outbox.md#local-message-bus); `queueType: DeadLetter` reads the dead-letter queue. Inside a run they join its transaction (a nested receive cannot wait: 400). Without a bus: 503 `ProviderUnavailable`. Topic actions are not mapped. |
| `approvals`               | behaviour (native envelope: contract)                 | `CreateAnApproval`, `StartAndWaitForAnApproval`, `WaitForAnApproval`; see [flow runs](#flow-runs-waits-and-approvals).                                                                                                                                                                                                                                                                                                                               |
| `custom-connector:<name>` | contract                                              | A Solution custom connector compiled from its OpenAPI 2.0 definition ([below](#custom-connectors)).                                                                                                                                                                                                                                                                                                                                                  |

```yaml
connections:
  dataverse-dev: # the ConnectionId a deployment profile binds to the reference
    connector: shared_commondataserviceforapps
    provider: dataverse
    principal: { pack: invented-pack, identity: flow-service } # a pack connectionPrincipals entry
    evidence: Owner of the Dataverse reference in the invented test environment
  http:
    connector: http
    provider: http
    settings:
      rewrites: { 'https://functions.example.test/api/': 'http://localhost:7071/api/' }
```

An entry takes only `connector`, `provider`, `principal`, `evidence` and `settings`, and `settings` only `rewrites`,
`auth` and `parameters`. `settings.auth` takes only `apiKey`, `username`, `password`, `token`, `clientId` and
`clientSecret`. Connection entries never hold credentials: every `settings.auth` value, and any value under a
`principal` or `settings.parameters` key named like secret, password, key or token, must be an `env:NAME` or
`variable:NAME` reference. Rewrite prefixes are absolute http(s) URLs without user information, a query or a fragment.
Validation runs when the configuration loads and stops with a message that names the full key path, for example
`Unknown sites.example.mirage.connections.c1.settings key 'headers'`, or for a literal secret
`sites.example.mirage.connections.c1.settings.auth takes apiKey, username, password, token, clientId, clientSecret as env:NAME or variable:NAME references only`
(the runtime does not start; the `mirage preflight` exit code is 2).

**Errors.** `ConnectorNotConfigured` (501), `ConnectionNotBound` (409), `ConnectionUnauthorized` (401, undeclared
principal), `PermissionDenied` (403), `OperationUnsupported` (501), `ProviderUnavailable` (503, including a non-loopback
URL), `ProviderTimeout` (504, including a pack connector operation or `httpFixtures` responder that has not settled
within the call's time limit), `ProviderFailed` (502, including a refused redirect); Dataverse backend errors such as
`LocalBackendPermissionDenied` keep their codes. A failed call, or a connector, `Http`, child-flow or pack action answer
of 400 or above (including the last answer of an exhausted retry policy), fails the action with
`error: { code: 'ActionFailed', message }` and keeps the status, headers and body as outputs; a throwing provider adds
`cause: { code }` and keeps `{ error: { code, message } }` as outputs. `runAfter` failure branches handle both. Every
call records `CONNECTOR_INVOKE` (connector, operation, reference, connection, provider, principal id, caller, status,
duration, correlation id), never parameter values, URLs, headers or bodies.

**Paging.** An action that declares only `runtimeConfiguration.paginationPolicy.minimumItemCount` follows `nextLink`
pages until it has that many items, at most 10 pages (`CONNECTOR_PAGINATION_TRUNCATED` when cut); a later non-2xx page
fails the action, and a complete result carries no `nextLink`. Without the policy only the first page is returned.

The operation contract lists `connections` (name, connector, reference, connection id, provider, bound, using actions)
and each connector action's `connection` (`referenceLogicalName`, `bound`, `provider`). An unbound reference keeps its
action unsupported.

### Dataverse provider

Each request uses the registered `flowIdentities` backend profile, else the principal of its bound connection, with
that principal's explicit backend grants.

- `CreateRecord` (Add a new row), `UpdateRecord` (Upsert: updates the row with that id or creates it with that id),
  `UpdateOnlyRecord` (a missing row fails `NotFound`) and `DeleteRecord` run the organization record pipeline (state
  defaults, hooks, audit and version columns, alternate-key answers) and answer the row in the body. An asynchronous
  hook remainder that fails afterwards reports `SDK_DEFERRED_EFFECT`. Each operation keeps its own plug-in transaction
  boundary, so a later failed action keeps earlier completed writes.
- `GetItem` (`$select` of direct columns, `partitionId`) and `ListRecords` (`$select`, `$filter`, `$orderby`, `$top`,
  `$expand`, `fetchXml`, `$skiptoken`) return the Web API read projection (computed columns, column security).
  `ListRecords` answers at most 5,000 rows per page with `@odata.nextLink`
  ([skip token](https://learn.microsoft.com/power-automate/dataverse/list-rows#skip-token)); the token format and link
  host differ from the platform's. `fetchXml` runs through the SDK FetchXML read and cannot combine with the OData
  options (400). `$expand` reads each expanded table with its own grants and keeps nested options; a many-to-many
  navigation answers 501 `LocalFlowUnsupported`. `GetItem` rejects `$expand`, lookup aliases and other options.
  Other parameters are rejected before the run (`Unsupported Dataverse parameter`).
- `AssociateEntities`/`DisassociateEntities` take a related-row URL that is relative or on this organization's
  loopback origin (otherwise 400). A `ChangeSet` scope of Add, Update, Upsert and Delete actions on one connection,
  without dependencies between them, commits or rolls back together.
- `GetEntityFileImageFieldContent` and `UpdateEntityFileImageFieldContent` use the profile's read and update grants.
- `PerformBoundAction` and `PerformUnboundAction` run the registered message (custom API, Function, built-in or pack
  message) as the profile's systemuser, never SYSTEM: the profile needs an `execute` grant naming the message
  (`grants: [{ message: 'x_Echo', operations: ['execute'] }]`, else 403 `LocalBackendPermissionDenied`), a bound action
  also `read` on its row, and a `userId` that is no systemuser answers 403 `LocalBackendIdentityRequired`. A custom API
  handler joins the run's transaction. Without an organization these four answer 501 `OperationUnsupported`.
- Not run: `GetRelevantRows` (no relevance index; 501), background operations, the `…WithOrganization` operations and
  the MCP operations. Connector headers, full metadata and exact native envelopes are not reproduced.

### Custom connectors

Solution custom connectors (`Connectors/*_openapidefinition.json`) are registered as `custom-connector:<name>`
providers and follow source reloads. A connector compiles from OpenAPI 2.0:

- path, query, header, body and formData parameters; a body is sent with the first supported `consumes` type: JSON,
  `application/x-www-form-urlencoded` or `multipart/form-data` (a file parameter `{ "$content-type", "$content" }`
  becomes a file part);
- API key, basic or OAuth security, with values from `settings.auth` (`apiKey`, `username` and `password`, a static
  `token`, or `clientId` and `clientSecret`, each an `env:NAME` or `variable:NAME` reference) and connection parameter
  values from `settings.parameters`;
- the policy templates `setheader` (Request and Response), `setqueryparameter`, `routerequesttoendpoint`,
  `dynamichosturl`, `setproperty`, `convertarraytoobject` and `convertobjecttoarray`, in instance order, with
  `@headers()`, `@queryParameters()`, `@connectionParameters()`, `@environmentVariables()`, `@body()` and `@item()`;
- a C# `script.csx` for its `scriptOperations` (all operations when the API properties list none), run through the
  local .NET SDK in place of the backend request; other operations go to the backend directly. A script runs only when
  the project trusts it: `connectorScripts` ([configuration](../../docs/configuration.md)) names
  `{ connector, sha256 }` of its exact text. An untrusted script (`CONNECTOR_SCRIPT_UNTRUSTED`, the message names the
  hash to register) or a missing `dotnet` (`CONNECTOR_SCRIPT_SDK_MISSING`) makes the scripted operations unsupported.
  The host is built once per script under the state directory; its first build restores Newtonsoft.Json and
  Microsoft.Extensions.Logging.Abstractions through NuGet. A trusted script runs unsandboxed with your user rights;
  `Context.SendAsync` goes through the connection rewrites and the loopback rule. A build error
  (`CONNECTOR_SCRIPT_BUILD_FAILED`), an exception thrown by the script or invalid JSON in its answer fails the action
  with 502 `ProviderFailed` naming the cause.

Requests go to a matching pack `httpFixtures` entry or a loopback URL after `settings.rewrites`; any other URL answers
`ProviderUnavailable`. A `nextLink` page is requested only on the operation's host or its rewritten origin (else 403
`PermissionDenied`, nothing sent), with authentication and Request `setheader` policies.

OAuth: client credentials (`flow: application`, needs `clientId` and `clientSecret`) without a static token posts
`grant_type=client_credentials` to the definition's `tokenUrl` (after rewrites; loopback or fixture only) and caches the
token in memory until `expires_in`. Authorization code (`flow: accessCode`, needs `clientId`) is signed in through
`POST /_sim/api/connections/<connection id>/authorize`: it answers 202
`{ connectionId, authorizeUrl, redirectUri, expiresAt }`; open `authorizeUrl` in a browser within 10 minutes. The
authorization server redirects to a one-time loopback listener (`http://127.0.0.1:<port>/callback`, PKCE `S256`),
which exchanges the code and refreshes the token later with its refresh token. `GET /_sim/api/connections` lists the
connections and `GET /_sim/api/connections/<connection id>/authorization` answers
`{ signedIn, expiresAt, refreshable }`; a connection of another flow answers 400 `ConnectionNotAuthorizationCode`, an
unknown one 404 `ConnectionNotFound`. Until sign-in, or on a refused sign-in or token request, calls answer 401
`ConnectionUnauthorized`. Any other OAuth flow (implicit, password) is never signed in locally: its connector is not
blocked, a connection with a static token reference (`auth.token: env:<NAME>`) sends it as `Authorization: Bearer`,
and a call on a connection without one answers 501 `OperationUnsupported`. For each cloud flow that uses such a
connection without a token, the flow's entry in `GET /_sim/api/operations` lists a `CONNECTOR_AUTH_UNSUPPORTED` warning
in `contract.warnings` naming the connector, the connection, the actions and the OAuth flow; the same warning, with the
flow name (`flow`) and `operationKey`, is reported once in `GET /_sim/api/diagnostics` and in the preflight report's
`diagnostics` (`GET /_sim/api/preflight`, `mirage preflight --json`). Authorization-code tokens are
[sealed](#flow-runs-waits-and-approvals) in state; tokens and secrets never reach diagnostics or `/_sim` answers.

Anything else blocks the connector and makes its actions unsupported with a named diagnostic:
`CONNECTOR_POLICY_UNSUPPORTED`, `CONNECTOR_MEDIA_TYPE_UNSUPPORTED`, `CONNECTOR_SCRIPT_MISSING`,
`CONNECTOR_SCRIPT_OPERATION_UNKNOWN`, `CONNECTOR_OPENAPI_VERSION_UNSUPPORTED`, `CONNECTOR_OPENAPI_INVALID`,
`CONNECTOR_AUTH_UNSUPPORTED`; an unknown operation id is `CONNECTOR_OPERATION_UNKNOWN`.

### Flow runs, waits and approvals

Both hosts keep one run store (capability `flow-runs`). Every flow kind (row triggers, `ExecuteWorkflow`, portal
request flows, child flows) runs as a tracked run inside the caller's transaction; run-store writes happen outside it,
so a rolled-back execution keeps its `Failed` row.

- **Rows.** One standard `flowrun` row per run: `flowrunid`, `workflowid`, `status` (`Running`, `Waiting`, `Succeeded`,
  `Failed`, `Cancelled`, `TimedOut`), `starttime`, `endtime`, `duration`, `triggertype`, `correlationid`, and
  `errorcode`/`errormessage` on failure. Replay state lives in `state.simulator.flowRuns[<runId>]` (definition hash,
  trigger input until the run ends, configured `steps`, the journal of executed connector actions, the current wait).
- **Retention.** The newest 200 runs, the journals of the newest 50 finished runs and 200 finished approvals are kept
  (`FLOW_RUN_JOURNAL_PRUNED`); running and waiting runs and pending approvals are never pruned.
- **Waits.** A run suspends on a `Wait` (`inputs.interval { count, unit }` with Second to Week, or
  `inputs.until.timestamp`) or a waiting approval, recording
  `wait = { kind: 'delay' | 'approval' | 'webhook' | 'child', id, actionPath, until?, timeoutAt?, assignedTo? }`.
  Timers run on the store's scheduler (`runDue()`/`advance(ms)` when manual): a delay ends `Succeeded`, a timeout ends
  the action and any pending approval `TimedOut` so `runAfter: ['TimedOut']` branches can run. Waits are re-armed
  after a restart. A waiting action also suspends inside `Foreach` (concurrent included) and `Until`; only a run
  without a run store answers 501 `FlowSuspendNotWired`: mock or disable it.
- **Resume** is deterministic replay. Non-secret parameter values are frozen when the run starts, `Secret` parameters
  are resolved again. `resume(runId, outcome)` answers `{ steps, journal, input, parameters, replay, processId,
correlationId, definitionHash }`; `steps` maps every journalled action path (a repeated loop action is `<path>#2`)
  and the suspended action to mocks, so completed connector writes are not repeated. A replay that reaches a live
  provider call with a journalled path unreplayed, or ends with one, fails `NotResumable` (`ReplayDiverged`); a changed
  definition hash or a definition that left the sources also fails `NotResumable` (409); a second resume of the same
  wait answers 409 `FlowRunNotWaiting`. An on-demand run without a Response requirement keeps that across resume.
- **Secure outputs** (`runtimeConfiguration.secureData` covering `outputs`) are sealed in the journal; views show only
  `{ status, secure: true }`. A memory-only runtime cannot open them after a restart: the resume fails `NotResumable`
  (`SecureOutputs (action <path>)`).
- **Retry.** `inputs.retryPolicy` on a connector action takes `{ type: 'fixed' | 'exponential' | 'none', count: 1–4,
interval: <ISO 8601, at most one day> }` (`none` takes only `type`); `ProviderUnavailable`, `ProviderTimeout`, 408, 429
  and 5xx are retried up to `count` times after the first attempt on the scheduler (exponential waits
  interval × 2^(n−1)), each attempt journalled under `attempts`; other answers are not retried. A policy on a built-in
  action or with invalid values is 400 `InvalidRequest`.
- **Child flows.** A `Workflow` action runs its child through the internal `flow` connector (`RunChildFlow`) as its
  own run (trigger type `ChildFlow`) inside the parent's transaction. The child needs an exported definition (404
  `ChildFlowNotFound`) with a manual `Button` trigger (400 `ChildFlowTriggerUnsupported`) and a Response (else the
  action fails `LocalFlowFailed`); it needs no exported choice of its own, but a child in mock, disabled or handler
  mode fails 501 `ChildFlowNotExecutable`. A child Response of 400 or above, or a `Terminate` (`LocalFlowTerminated`),
  fails the parent action. A child that answered before waiting answers its
  parent at once and keeps running. A child that waits first suspends its parent (wait kind `child`, `id` the child
  run); when it completes, a still-waiting parent resumes with its Response (400 and above, or a failed, cancelled or
  timed-out child, fails the action). `POST /_sim/api/flow-waits/<id>` refuses a child wait with 409
  `FlowWaitOwnedByChild`. Only an untracked parent cancels a waiting child and fails 501
  `ChildFlowSuspendUnsupported`.
- **Cancel.** `CancelAllCloudFlowRuns` cancels the workflow's `Running` and `Waiting` runs (stopping timers and
  pending approvals), then updates other open `flowrun` rows to `Cancelled` through the record path; `flowrun` is an
  elastic table, so a failed update does not roll back earlier ones.

**Sealed values.** Secure outputs, authorization-code tokens and per-flow HTTP callback keys are sealed with
AES-256-GCM under `mirage-vault.key` in the runtime's state directory, readable by the current user only (sealing fails
with `VaultKeyAclFailed` when Windows cannot restrict it). The key never reaches state, configuration, diagnostics or
`/_sim`. Without a state directory the key lives in the process only.

**Approvals.** The `approvals` provider stores each approval in `state.simulator.approvals[<id>]` (`title`,
`assignedTo` split on `;`, `details`, `status` `Pending` → `Approved` | `Rejected` | `Completed` | `TimedOut` |
`Cancelled`, `responses`). `CreateAnApproval` answers at once; `StartAndWaitForAnApproval` and a pending
`WaitForAnApproval` suspend only for a caller passing `context.canSuspend` (else 501 `FlowSuspendNotWired`), with a
default `timeoutAt` of 30 days, the Power Automate run limit.

| `approvalType`    | Completes when                                                                          |
| ----------------- | --------------------------------------------------------------------------------------- |
| `Basic` (default) | the first response; `Approve` or `Reject` (case-sensitive) is the outcome               |
| `AwaitAll`        | any `Reject` (as `Rejected`), or every assignee approved                                |
| `Custom`          | the first response, which must be one of the `;`-separated `responseOptions` (required) |
| `CustomAwaitAll`  | every assignee answered; the outcome joins the responses                                |

Any other type, or a Custom type without `responseOptions`, is refused at creation (400 `ProviderFailed`). A response
must come from an assignee (email or id, case-insensitive; else 403 `ApprovalResponderNotAssigned`), once per assignee
(else 409 `ApprovalAlreadyAnswered`), with an outcome among the type's options (else 400 `InvalidRequest` listing
them); a response without a responder counts for the only assignee, and with several the 400 `InvalidRequest` names
them. At `timeoutAt` the approval and the action end `TimedOut`. A completing response
answers `{ statusCode: 200, body: { name, title, details, outcome, requestDate, completionDate, responses: [...] } }`
with field names from the Approvals output definition; while `Pending` it answers `statusCode: 202` with
`completed: false`. Status codes and the dynamic envelope are not reproduced exactly.

#### Administration routes

Every `POST` needs the administration token in `x-sim-csrf` (`csrf` of `/_sim/api/status`, or `simulator.csrf`); answers
pass through `redactSecrets`.

| Route                                             | Result                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /_sim/api/flow-runs?processId=&status=`      | Run summaries, newest first.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `GET /_sim/api/flow-runs/<runId>`                 | One run with its journal; never trigger input or secure outputs.                                                                                                                                                                                                                                                                                                                                                                |
| `GET /_sim/api/flow-waits?state=overdue\|pending` | Waiting runs and their waits; an approval wait carries an `approval` block (type, title, options, assignees, responses, awaiting, requireAll).                                                                                                                                                                                                                                                                                  |
| `POST /_sim/api/flow-waits/<waitId>`              | `{ outcome, responder, comments }` for an approval, `{ outputs }` for a delay or webhook wait. Records the response and schedules the resume (202) once the approval completes; a still-pending approval answers 202 with `scheduled: false`. Without a resume function: 501 `FlowResumeNotWired`, nothing changes.                                                                                                             |
| `POST /_sim/api/flow-runs`                        | `{ processId, input }` starts a tracked run (trigger type `Manual`) of a manual, HTTP Request, Recurrence or pack connector-trigger flow whose choice is exported: 201 with the summary, plus `response` when the run answered a Response (also when it waits after answering); another choice 409 `FlowNotExecutable`, another trigger 400 `FlowTriggerUnsupported`, a flow without an exported definition 404 `FlowNotFound`. |
| `POST /_sim/api/flow-triggers/<flowId>`           | Runs an HTTP Request trigger flow with the JSON body; answers the Response status and body with only the Response's `content-type` and `x-*` headers (never `x-sim*`, `x-trace-id`, cookies, `location` or CSP; the host adds its own `x-trace-id` and `x-sim-span-id`), also when the run waits after answering, or 202 `{ runId, status }` without a Response or when it waits first.                                         |
| `GET /_sim/api/flow-triggers`                     | One entry per Recurrence, HTTP Request and pack-hosted connector-trigger flow: `kind`, `state` (`scheduled`, `subscribed`, `on-demand`, `inactive`), `nextRun` and why an entry is inactive. Reading only lists.                                                                                                                                                                                                                |

## Local portal routes

- `GET /search/` renders the default search page (`portal-search.mjs`) when the export has none, following the
  `Search/*` site settings and table permissions, with the usual portal response headers and
  `x-sim-route: portal-search-local`. See [Liquid parity](liquid-parity.md#search).
- `/_services/sharepoint-data.json|addfiles|addfolder|deleteitem/<website>` are the Power Pages document control's
  services, and `/_apps/portal-documents/<table>/<id>/<name>` downloads a listed file; see
  [SharePoint documents](sharepoint.md#power-pages-document-control).
- `/__sim-static/pages-client-api.js` serves the `$pages` client API script for pages that do not load the platform
  bundles. See [forms and lists](forms-lists-parity.md#modern-lists-and-the-client-api).

## Local services

Azure Functions, Azurite, the Service Bus emulator and other loopback HTTP services are declared and probed, never
started. Run them yourself (Functions with Core Tools `func start`, the emulators as their docs describe). Core talks to
the two emulators as providers: [Azurite storage](storage-providers.md#azurite) and the
[Service Bus emulator bus](messaging-and-outbox.md#service-bus-emulator).

```yaml
localServices:
  functions: { kind: http, baseUrl: 'http://localhost:7071', probe: '/admin/host/status', required: false }
  azurite:
    { kind: azure-storage, blob: 'http://127.0.0.1:10000/devstoreaccount1', probe: '/devstoreaccount1?comp=list' }
  servicebus: { kind: service-bus, connectionStringVariable: FX_SB_EMULATOR }
  fx-api: { kind: http, baseUrl: 'http://127.0.0.1:5000' }
```

- Settings validation requires every `baseUrl`, `blob` and probe to stay on localhost, 127.0.0.0/8 or ::1, a probe to
  be a path on that origin, and refuses a `connectionString` key (name an environment variable in
  `connectionStringVariable` instead). A refusal names the key path, for example
  `sites.example.mirage.localServices.f.baseUrl must be an http(s) URL on localhost, 127.0.0.0/8 or ::1`.
- Preflight sends one GET per service without redirects, ended by a caller's `timeoutMs` or the 30-second
  idle window, and answers `{ id, kind, reachable, status, required, message }` without throwing; messages show origin
  and path only. A Service Bus entry reads its variable at probe time and checks the emulator's loopback health
  endpoint; an unset variable is reported by name.
- The capability registry lists each service as a `contract` capability `local-service:<id>` with
  `requires: ['external-process:<id>']` and lifecycle `external-process`.
- Route a cloud URL to a local service with a connection's `settings.rewrites`
  ([connections and connectors](#connections-and-connectors)).
