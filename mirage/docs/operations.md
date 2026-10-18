# Server logic and cloud flows

Mirage inventories exported operations automatically. Open `/_sim/#operations` to review their source, route, access and local behavior. The catalogue includes portal server logic and cloud-flow consumers, matching enhanced site records in selected Solutions, and Solution workflow definitions.

An unlinked workflow remains visible and permits local mock/disabled configuration without an invented portal route or role grant. Configuration alone does not invoke or activate it. A supported activated Dataverse row trigger with an explicit backend profile can run without a portal consumer; a Power Pages Request workflow needs its consumer export to establish a route and web-role binding. Its role checks still apply when the response is mocked.

Solution plugin steps also appear in Backend operations. They run through supported local CRUD stages, rather than a portal URL. Select a step to review its table, message, stage, filtering columns and source. Configure a target-field mock, validation rejection or trusted project handler. See [Dataverse plugins](dataverse-plugins.md) for the contract and execution limits.

## Choose local behavior

| Mode | Result |
| --- | --- |
| Placeholder | HTTP 501 identifies an operation without a supported local implementation |
| Supported exported flow | Run imported basic actions for a Power Pages Request or supported activated Dataverse row trigger |
| JSON mock | Set a response body and status for success, empty, validation or failure scenarios |
| Exported server logic | Explicitly enable exported JavaScript against the local data store |
| Project provider | Register a trusted pack handler for business logic or unsupported integrations |
| Disabled | Deliberately skip the flow or exact action and retain a trace of that choice |

Select an operation, save its local behavior and call its exported route from your portal. **Use source default** removes a local override. Overrides affect simulation state; they do not deploy the source or activate an online flow.

## Execution boundary

Imported routes retain exported web-role checks. Local data access applies the current identity and table permissions. Exported server logic can query and change local records through supported Dataverse helpers. Writes require a verified HTTP write request and native CSRF checks; Liquid helper calls remain read-only.

Imported flow definitions run through a bounded local interpreter. Supported actions include variables, Compose, conditions, scopes, sequential foreach, Switch, runAfter, Response/Terminate and basic Dataverse create/update/delete/get/list operations. Unsupported expressions, connectors and execution settings require an exact per-action mock or disabled choice. The admin contract lists source action paths and records per-action mode/status/errors. Response headers are validated locally; unchosen branches retain Skipped states. Parallelism, retries, secure-data execution settings and arbitrary external connectors are not silently approximated.

WDL string interpolation preserves literal `@@{...}` escapes and exact numeric digits, including numbers within interpolated collections ([Microsoft expression syntax](https://learn.microsoft.com/en-us/azure/logic-apps/workflow-definition-language-schema#expressions)). Variable declarations require the global workflow level; nested declarations are rejected before execution unless the action or its containing branch has an explicit mock/disabled choice ([Power Automate variables](https://learn.microsoft.com/en-us/power-automate/create-variable-store-values)). These local regressions do not establish native flow parity.

Flow completion follows terminal branch statuses: a successful failure handler resolves its branch, while a skipped terminal action inherits its predecessor's completion status. Historical action statuses remain available for inspection ([Microsoft error handling](https://learn.microsoft.com/en-us/azure/logic-apps/error-exception-handling)). Response accepts 2xx, 4xx and 5xx status codes; a static 3xx status is rejected before execution and a computed 3xx status fails when the action runs ([Response schema](https://learn.microsoft.com/en-us/azure/logic-apps/logic-apps-workflow-actions-triggers#response-action)).

Power Pages Request triggers with conditions, splitting, concurrency, recurrence, operation options or unsupported inputs remain explicit capability errors instead of running as unconditional requests. Use an explicit flow mock/disabled choice instead; this policy does not claim native trigger filtering or scheduling. Omitted variable initial values still need native type-by-type comparison; no defaults are inferred.

GetItem supports comma-separated direct-column `$select` through the existing local SDK ColumnSet. Ordinary reads retain their current behavior; selected reads retain the primary key and attributes added by Retrieve plugins. `$expand`, lookup aliases and other connector options are rejected as unsupported ([Get a row options](https://learn.microsoft.com/en-us/power-automate/dataverse/get-row-id#advanced-options)). Connector HTTP headers, full metadata and precise native response envelopes are not reproduced.

Each Dataverse connector request uses an explicitly registered project `flowIdentities` backend profile. Portal role access and flow connection identity are separate. A later failed flow action preserves earlier completed connector writes. Each individual connector operation retains its own plugin transaction boundary. A row-triggered run can succeed without an HTTP Response; a request-triggered run cannot invent one.

Activated imported Dataverse triggers support added/modified/deleted and combined callback-registration messages, explicit Organization scope, scalar submitted-column selection and saved-row OData filters. An unchanged submitted update column still matches selection. Create/Delete ignore update select columns; lookup-column selection requires metadata and is ignored. Other ownership scopes, runAs, Delete-filter payload semantics, trigger conditions and unsupported source settings are reported as unsupported. Draft or unknown activation stays inactive by default. **Explicitly activate this source locally** enables a local test choice and records the override without altering the export or online flow.

Post-save queues preserve only actually committed events. Failed primary writes emit no trigger, while independently committed top-level PreValidation SDK writes retain their events. Recursive plugin/flow chains have bounds and drain together before reload/stop. Job errors are separate from the original committed response. This local queue is not the native Power Automate scheduler or its retry service.

Workers and interpreter budgets bound execution time; they do not provide an arbitrary untrusted-code sandbox. Enable exported code only from sources you trust.

External connectors, custom APIs, complex flow actions and unsupported expressions require explicit handlers, mocks or disabled choices. Mirage never forwards imported definitions to remote Power Automate. Invented interpreter/HTTP tests qualify local semantics only. Native parity requires the exact exported definition, activation, trigger, connection identity, source settings, run/action traces and resulting data from an authorised owned fixture.

Use [data packs](data-packs.md) for reusable project providers, [simulation administration](sim-administration.md) for state and personas, and [coverage](../../docs/coverage.md) for the wider platform boundary.
