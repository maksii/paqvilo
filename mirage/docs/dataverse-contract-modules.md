# Dataverse contract modules

Contract modules add Dataverse business-logic capabilities to the local Web API: calculated columns, business rules, currency, record hierarchy, state transitions, cascades, rollups, formula columns, virtual providers and business process flows. Each module is a Dataverse API extension with `install`, `reset` and `describe`. `describe()` returns the module's capability record, which includes its fidelity level, the operations it supports and the source metadata it needs. A module computes only the subset it documents. Anything outside that subset produces a diagnostic and has no effect. A trusted data pack can replace the evaluation for a specific column or rule.

Diagnostics are reported once per column or rule. Each module sends them to the `diagnostic` callback passed at install time. They are also available from the module's `diagnostics()` accessor on the Dataverse API.

Module authors share two helpers from `mirage/lib/dataverse-addon-common.mjs`. `packOverrides(api, name)` reads a pack export from the runtime's pack export registry (`api.packExport(name)`) as the plain object a module's validator reads, or `undefined` when no pack exports the name. `onceReporter(diagnostic)` returns `{ diagnostics, report(entry, key), clear() }`: `report` records an entry (severity `warning` unless the entry names one) and forwards it to `diagnostic` the first time its key is seen, and `clear()` starts again on reset.

Each module below is installed by the organization runtime through the extension list in `mirage/lib/dataverse-extensions.mjs`. The level is the module's capability level as its section states it.

| Module                 | Extension name                | Level                                                                                                                                                          | Pack export                                                                  |
| ---------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Calculated columns     | `dataverse-calculated`        | contract (behaviour when pack functions cover every calculated column)                                                                                         | `calculatedColumns`                                                          |
| Business rules         | `dataverse-business-rules`    | contract (behaviour when pack functions cover every Entity-scope rule)                                                                                         | `businessRules`                                                              |
| Currency               | `dataverse-currency`          | behaviour                                                                                                                                                      | none                                                                         |
| Record hierarchy       | `dataverse-hierarchy`         | behaviour once the organization runtime wires the query operators, else contract (resolve operations behaviour)                                                | `hierarchies`                                                                |
| State transitions      | `dataverse-state-transitions` | behaviour                                                                                                                                                      | `transitions`                                                                |
| Cascade                | `dataverse-cascade`           | behaviour (Assign); other cascades contract                                                                                                                    | none                                                                         |
| Rollup                 | `dataverse-rollup`            | behaviour                                                                                                                                                      | `rollups`                                                                    |
| Formula columns        | `dataverse-formula`           | contract (behaviour when a synchronous evaluator or pack function covers the column)                                                                           | `formulaColumns`                                                             |
| Virtual providers      | `dataverse-virtual-providers` | behaviour for the operations a registered provider implements (create, update, delete, retrieve, retrieveMultiple); contract otherwise and for external events | `virtualTableProviders`, `virtualTables` (declarations, `fallback: 'local'`) |
| Business process flows | `dataverse-bpf`               | contract                                                                                                                                                       | none                                                                         |

## Calculated columns

Module: `mirage/lib/dataverse-calculated.mjs`. Capability record: requires `metadata:FormulaDefinition`. `describe(api)` reports level `behaviour` only when the store has calculated columns and a pack function covers every one of them; otherwise it reports `contract`, because the evaluator covers only the subset below.

**Behaviour.** A column with `SourceType` 1 in its metadata is calculated on every read: Web API entity, collection, property and `$value` reads, expanded rows, FetchXML, `$filter`, `$orderby`, `$apply` aggregates and the portal reads all use the computed value. The stored value is never returned. A calculated column that reads another calculated column reads it computed; a chain deeper than five calculated columns reads null with `CALCULATED_UNSUPPORTED`. An `$orderby` or FetchXML `<order>` on a calculated column whose definition references a parent column or another calculated column is ignored without an error, as on the platform. The value comes from the column's `FormulaDefinition`, evaluated against the stored row. A `Field` reference can follow one N:1 lookup to the parent row. That parent row is read without the caller's read privilege, as the platform computes the value itself.

The supported `FormulaDefinition` subset uses XML elements. Element names are case-insensitive and namespace prefixes are ignored. The root element is either an optional `<Formula>` wrapper around exactly one expression, or the expression itself.

| Element                                                                                                                       | Meaning                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `<Constant Value="…" Type="number\|string\|boolean\|datetime\|null"/>`                                                        | A literal value. If `Type` is omitted, a numeric value is a number and anything else is text. |
| `<Field Name="column"/>`, `<Field Name="lookup.column"/>`                                                                     | A column of the same row, or a column of the parent row one hop away                          |
| `<Add>`, `<Subtract>`, `<Multiply>`, `<Divide>`                                                                               | Number arithmetic. A null operand gives null, and dividing by zero gives null.                |
| `<Concat>`                                                                                                                    | Text concatenation. A null operand counts as empty text.                                      |
| `<If>` condition, then, else                                                                                                  | A conditional. When `else` is absent and the condition is false, the result is null.          |
| `<Equal>`, `<NotEqual>`, `<GreaterThan>`, `<GreaterEqual>`, `<LessThan>`, `<LessEqual>`, `<And>`, `<Or>`, `<Not>`, `<IsNull>` | Comparisons and logical operators                                                             |
| `<AddDays>`, `<AddHours>`, `<AddWeeks>`, `<AddMonths>`, `<AddYears>` (date, amount)                                           | Date arithmetic in UTC                                                                        |
| `<DiffInDays>`, `<DiffInHours>`, `<DiffInMinutes>`, `<DiffInWeeks>`, `<DiffInMonths>`, `<DiffInYears>` (from, to)             | Date differences in whole units                                                               |

Arithmetic uses JavaScript numbers. Money and decimal results can therefore differ from the platform in the last digits.

**Writes.** A create, update or upsert that includes a calculated column is refused with HTTP 400 `0x80048d19`, and nothing is stored.

**Diagnostics.** `CALCULATED_UNSUPPORTED` is reported once per column in these cases:

- the column has no `FormulaDefinition`
- the definition contains a node outside the subset
- a value has the wrong type, for example text where a number is expected
- a pack function returns a promise

In each case the column reads as null. Mirage never guesses a value.

**Pack override.** A pack's `calculatedColumns` export maps `'<table>.<column>'` to a synchronous function `(row, ctx) => value`. The function receives a copy of the stored row and `ctx = { table, column, user, related(lookup) }`, where `user` is null because the platform computes the column. When a pack defines a function for a column, it replaces the evaluator for that column. `validateCalculatedColumns(map)` checks the export: each key must have the form `table.column` and each value must be a synchronous function.

**Limits.** The column designer stores `FormulaDefinition` as Windows Workflow XAML (`ActivityReference` and `EvaluateExpression` with VB expressions). That format is outside the subset, so a column exported from the designer reports `CALCULATED_UNSUPPORTED` until a pack supplies a function for it.

## Business rules

Module: `mirage/lib/dataverse-business-rules.mjs`. Capability record: requires `workflow:category=2`. `describe(api)` reports level `behaviour` only when the store has activated Entity-scope rules and a pack function covers every one of them; otherwise it reports `contract`, because the parser covers only the subset below.

**Behaviour.** A business rule is a `workflow` row that is activated (`statecode` 1), is a definition (`type` 1), has `category` 2 and names the table in `primaryentity`. Only rules with `processtriggerscope` 2 (Entity scope, which covers forms and the server) are evaluated by the server.

Rules run in the `beforeWrite` hook for create, update and upsert, before the row is stored and inside the write's transaction. They are evaluated synchronously in workflow-table order against the merged row: the existing values, with the request payload applied on top. A rule can change only the payload. It cannot write other rows, so it never increases plug-in depth. If a rule fails, the whole write is rolled back. The hook runs for every write surface: the Web API, SDK calls from plug-ins, flow Dataverse actions, the portal `/_api` and portal forms, and the rows messages create.

| Action (XAML step)                                                                                          | Server behaviour                                                                                     |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `<SetAttributeValueStep Attribute Value/>`                                                                  | Sets the value in the payload                                                                        |
| `<SetDefaultValueStep Attribute Value/>`                                                                    | On create only, sets the value when the merged value is empty                                        |
| `<SetMessageStep Message/>`                                                                                 | Fails the write with HTTP 400. The error message is the rule's message and the code is `0x80040265`. |
| `<SetFieldRequiredLevelStep Attribute RequiredLevel="required"/>`                                           | Fails the write with HTTP 400 `0x80040203` when the merged value is empty                            |
| `<ConditionBranchStep Logic="and\|or">` with `<Condition Attribute Operator Value/>`, `<Then>` and `<Else>` | One condition branch. Supported operators: `eq`, `ne`, `gt`, `ge`, `lt`, `le`, `null`, `not-null`.   |

The steps are the child elements of the root element. Each `Value` is parsed as JSON when it is valid JSON, for example a number, `true`, `false` or `null`. Otherwise it is used as text. Condition branches nest at most 64 deep; a deeper rule reports `BUSINESS_RULE_UNSUPPORTED`. Parsed rules are cached per workflow id and replaced when the rule's XAML changes, and the activated rules are indexed by table once per store revision.

**Inventory.** Some actions affect only the client: `<SetVisibilityStep>`, `<SetDisplayModeStep>` (lock and unlock) and `<RecommendationStep>`. They have no server behaviour, and each rule that contains them reports `BUSINESS_RULE_CLIENT_ONLY` once. The rule's server actions still run. Rules with Form or All Forms scope are never evaluated by the server.

**Diagnostics.**

- `BUSINESS_RULE_CLIENT_ONLY` lists a rule's client-only actions. It is reported once per rule.
- `BUSINESS_RULE_UNSUPPORTED` is reported once per rule when the rule's XAML is outside the subset. That rule is skipped.

**Pack override.** A pack's `businessRules` export maps a workflow id to a synchronous function `(ctx) => ({ target?, error? })`. The function receives `ctx = { workflowId, name, table, operation, rule, target, payload, userId, initiatingUserId }`. `target` is a copy of the merged row, and `payload` is a copy of the request payload. A returned `target` patch is merged into the payload. A returned `error` fails the write like a `SetMessageStep`. When a pack defines a function for a rule, it replaces the parsed rule. `validateBusinessRules(map)` checks the export: each key must be a workflow GUID and each value must be a synchronous function.

**Model-driven host.** `businessRulesFor(store, table)` returns the parsed rules for every scope. Each rule has `{ workflowId, name, table, scope: "entity" | "form", formId, steps, clientOnly, unsupported? }`. On an installed API the same list is available as `api.businessRulesFor(table)`, so that client-side evaluation can use the same rule model. The model-driven host does not consume it.

**Limits.** The rule designer exports XAML with Windows Workflow `ActivityReference` wrappers, and its `clientdata` is generated JavaScript. Neither format is read, so an exported designer rule reports `BUSINESS_RULE_UNSUPPORTED` until a pack supplies a function for it.

## Currency

Module: `mirage/lib/dataverse-currency.mjs`. Capability record: level `behaviour`, requires `table:transactioncurrency`.

**Behaviour.** On a write to a table with a money column (a column of kind money, not its `_base` companion), the `beforeWrite` hook stamps the row before it is stored, in the write's transaction. On create, and on an update that gives a money value or a currency:

1. `transactioncurrencyid` is the payload's currency (sent as `transactioncurrencyid@odata.bind`), else the currency the stored row already holds, else the organization base currency.
2. `exchangerate` is that currency's rate. The base currency is 1, whatever its stored value.
3. `<column>_base` is `<column> / exchangerate`, rounded half away from zero to the currency's `currencyprecision` (fallback: the column's precision, then 2), for each money column that holds a value.

The base currency is `organization.basecurrencyid` when set, else the first `transactioncurrency` row. Tables without a money column are not touched.

| Operation              | Supported subset                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `CurrencyStamp`        | create and update: currency, rate and `_base` on money tables                                                                         |
| `BaseAmount`           | `_base` = column / rate, at the currency precision                                                                                    |
| `RetrieveExchangeRate` | executed by `dataverse-predefined.mjs` (not registered again here): 200 with `ExchangeRate`, 404 `0x80040217` for an unknown currency |

**Inventory / contract.** Nothing is retained that is not executed. An unknown currency on an update is refused with the lookup inner code. Exchange rates are read at write time only. A change to a rate does not restate stored base amounts.

**Diagnostics.** `CURRENCY_BASE_MISSING` fires when a write needs the base currency and none exists (no `organization.basecurrencyid` and no `transactioncurrency` row). It fires once per table; the write proceeds without stamping.

**Pack override.** None. The module has no pack export.

An unknown currency in a Web API bind answers 404 `0x80040217` before the hook runs; other writers that reach the hook get 400.

## Record hierarchy

Module: `mirage/lib/dataverse-hierarchy.mjs`. Capability record: requires `metadata:IsHierarchical`. Per operation: `resolve:under`, `resolve:eq-or-under`, `resolve:above`, `resolve:eq-or-above` at level `behaviour`; `query:under`, `query:eq-or-under`, `query:above`, `query:eq-or-above`, `query:not-under` at level `behaviour` once the organization runtime has wired them (`api.hierarchyQueryWired`), else `contract`. The module level follows the query operators.

**Behaviour.** `api.hierarchy.resolve(table, rootId, direction)` walks a table's self-referencing lookup breadth first over its rows and returns the matching record ids as a Set of lowercase GUIDs. It returns `null` when the table is not hierarchical or has no mapping. A lookup value may be an `{ id }` object or a bare GUID. Each record is visited once; a root that is not a row yields an empty set.

| Direction     | Records returned                            |
| ------------- | ------------------------------------------- |
| `under`       | descendants of the root, excluding the root |
| `eq-or-under` | the root and its descendants                |
| `above`       | ancestors of the root, excluding the root   |
| `eq-or-above` | the root and its ancestors                  |

A table is hierarchical when a one-to-many relationship references the table from itself and carries `IsHierarchical` (read from the metadata relationship records). `api.hierarchy.isHierarchical(table)` returns `{ column }` (the lookup column) or `null`.

**Query operators.** The FetchXML and OData operators `under`, `eq-or-under`, `above`, `eq-or-above` and `not-under` are compiled in `mirage/lib/dataverse-conditions.mjs`. The organization runtime sets `store.hierarchyResolver` to `api.hierarchy.resolve` and marks the operators wired. A Dataverse caller resolves them through `identity.hierarchy`, which asks that resolver first. Every other caller (portal FetchXML, Liquid and the portal Web API) resolves them through the runtime's query scope (`runWithQueryResolvers`), which the organization host enters per request. `not-under` selects the rows outside the `under` set. On a table that is not hierarchical the query is refused with 400, inner code `0x80040203` and reason `HIERARCHY_NOT_HIERARCHICAL`. Outside any query scope the operators keep the unsupported-operator refusal.

**Diagnostics.**

- `HIERARCHY_DEPTH_EXCEEDED`: once per table when a walk exceeds `maxDepth` (default 100). The walk stops there and returns the records found so far; it never throws.
- `HIERARCHY_CYCLE`: once per table when a lookup loops back to a record already visited. The loop is not followed.

**Pack override.** Export `hierarchies`: `{ '<table>': '<lookup column>' }`, validated by `validateHierarchies(map)` (logical names, lowercase result, `TypeError` on a bad entry). It names a table as hierarchical without the metadata flag and wins over the flag for that table. Passed as `install(api, { hierarchies })`.

## State transitions

Module: `mirage/lib/dataverse-state-transitions.mjs`. Capability record: level `behaviour`, requires `metadata:TransitionData`.

**Behaviour.** On a table that enforces status transitions, a write that changes `statuscode` is checked before the row is stored (update, and an upsert that updates; creates are not transitions). A status change is allowed only to a status the current status allows, whichever state the target status belongs to. A state change through Update (a PATCH of `statecode` and `statuscode`) is the Web API's way to change state, so the state change itself is not refused; Mirage's SOAP `SetState` is such a PATCH and gets the same check. A refused write answers 400 with inner code `0x8004F00E` and stores nothing. `IsValidStateTransition` stays registered by `dataverse-record-messages.mjs`; when this module is installed its handler asks `api.stateTransitions.isValid` first. On an enforced table that answer uses the same targets (the state must match the target status option and the target must be allowed; a state change is valid there). Other tables keep the record-messages answer.

A table enforces transitions when the install option `transitions` names it, or when its metadata has `EnforceStateTransitions` true (`dataverseMetadata.EnforceStateTransitions`). Other tables are untouched.

| Allowed targets of a status                                                | Source                                                  |
| -------------------------------------------------------------------------- | ------------------------------------------------------- |
| explicit list for the status in `transitions`                              | pack or test configuration, wins over metadata          |
| `TransitionData` of the status option, an array of statuscodes             | exported metadata form                                  |
| `TransitionData` of the status option, the native `allowedtransitions` XML | `sourcestatusid` is the status, `tostatusid` the target |
| none listed: any target is allowed                                         | `STATE_TRANSITIONS_UNCONFIGURED` diagnostic             |

`TransitionData` is read from the status being left (the current status).

**Inventory / contract.** This module registers no message, and `CloseIncidentRequest` is not implemented here.

**Diagnostics.**

- `STATE_TRANSITIONS_UNCONFIGURED`: a status that is left on an enforced table has no allowed-target list, so any change from it is allowed. Once per table and status.

**Pack override.** `install(api, { transitions })`. Export name `transitions`, a map `{ "<table logical name>": { "<statuscode>": [<statuscode>, ...] } }`. Keys are lowercased table names and whole-number statuscodes, values are arrays of whole-number statuscodes (an empty array allows no target). An explicit table entry enforces even when the metadata flag is false, and its lists replace the metadata lists for the statuses it names; a status it does not name keeps its metadata list. Validator: `validateTransitions(map)`, which throws a TypeError naming the bad key.

## Cascade

Module: `mirage/lib/dataverse-cascade.mjs`. Capability record: level `behaviour` (Assign executes), operation levels `CascadeAssign` behaviour, `CascadeShare`, `CascadeUnshare`, `CascadeReparent`, `CascadeMerge` contract. Requires `metadata:relationship cascade`.

**Behaviour.** When an update changes a row's `ownerid`, the afterWrite hook gives its one-to-many children the new owner inside the write's transaction. Before each child is written, the caller's Assign privilege on that child is checked (`api.principals.authorize`, operation `assign`); a refusal fails the whole write, the parent included. A host without `api.principals` (portal only) cascades without that check. The children are written through `store.updateRecord` with the caller's identity marked admin, which skips only the portal table-permission layer, and their row journal rolls back with the write. A child whose owner changed applies its own relationships the same way; a visited set bounds the depth. Children already owned by the new owner are not written. Only `ownerid` is written.

| Assign value                             | Children that receive the new owner                        |
| ---------------------------------------- | ---------------------------------------------------------- |
| `Cascade`                                | every child                                                |
| `Active`                                 | children with `statecode` 0                                |
| `UserOwned`                              | children owned by the parent's owner from before the write |
| `NoCascade`, `RemoveLink`, anything else | none                                                       |

`UserOwned` means "owned by the same user as the primary row". The primary row already has the new owner after the write, so the owner from before the write is compared.

**Inventory / contract.** Share, Unshare, Reparent and Merge are not executed: no access is granted or revoked, no row is re-parented, no child is merged. Nothing answers success for them.

**Diagnostics.** Each is emitted once per key and again only after reset (every reseed):

- `CASCADE_ASSIGN_DEFAULTED`: once per relationship (parent table, child table, lookup column) whose metadata has no Assign value, when an owner change reaches it. NoCascade is applied.
- `CASCADE_SHARE_NOT_SIMULATED`, `CASCADE_UNSHARE_NOT_SIMULATED`, `CASCADE_REPARENT_NOT_SIMULATED`, `CASCADE_MERGE_NOT_SIMULATED`: once per table that declares that cascade with a value other than NoCascade. Checked at install and on every reseed. The default extensions seed standard metadata that declares Share cascades on many standard tables, so these fire for those tables too.

The host reads diagnostics from `api.cascades.diagnostics()`.

**Pack override.** None. The module has no pack export.

**Limits.** Only `ownerid` is written, not `owninguser`, `owningteam` or `owningbusinessunit`. Active workflows and business rules on reassigned rows are not deactivated, which the platform does. `describe().seams` names the existing functions a Share or Merge cascade would call; none is wired.

## Rollup

Module: `mirage/lib/dataverse-rollup.mjs`. Capability record: level `behaviour`, requires `metadata:FormulaDefinition`, `scheduler`. `MassRecalculation` is a behaviour operation when the module scheduled the periodic job; without a scheduler it is listed under `contractOperations`.

**Behaviour.** A rollup column is a column whose metadata says SourceType 2. Its FormulaDefinition is the aggregate FetchXML: one child `<entity>`, one aggregate `<attribute>`, and a `<filter>` whose condition with `value="{id}"` names the child column that holds the parent id (the 1:N relationship). Three operations execute:

- **Create.** A new parent row is stamped `<column>_state = 0` (NotCalculated) and `<column>_date = null` for every rollup column whose payload omits them. An explicit write to `<column>` itself is refused with 400, on create, update and upsert.
- **Child write.** A create, update, upsert or delete of a child row marks each parent linked through a rollup `<column>_state = 0` (stale), inside the write's own transaction. A reparent or delete also marks the parent the row pointed at before the write. A parent already at 0 is left alone. The flag is a journaled row mutation: the parent's version number, modified-on value and ETag stay, and no Update step, flow, audit entry or committed event runs for the parent.
- **Recalculate.** `recalculate(api, table, id, column)` (exported, and `api.rollups.recalculate(table, id, column)`) computes the value over the local child rows and stores `<column>`, `<column>_state = 1` (Calculated) and `<column>_date = now`, with the modified-on value kept. It runs as the platform (administrator), like the cascade module. It returns `{ table, id, column, value, state, date }`, rejects with 400 for a column that is not a rollup and 404 for an unknown row.
- **CalculateRollupField.** The message (`dataverse-record-messages.mjs`) calls `api.rollups.recalculate` when this module is installed, so a pack `rollups` function is honoured and an unsupported definition stores state 2 with `ROLLUP_UNSUPPORTED`. Without the module the message runs the column's FetchXML aggregate itself.
- **Mass recalculation.** When the runtime has a scheduler (`api.scheduler`), install schedules a recurring "Mass Calculate Rollup Fields" task every hour that recalculates every stale (`_state = 0`) rollup column of every row (`api.rollups.recalculateStale()`). A failed run reports `ROLLUP_MASS_RECALCULATION_FAILED` and the next run still comes. Closing the module cancels the task.

The rollup columns per table and the child-to-parent links are memoised per `store.tablesRevision([])` and cleared on reset.

**Supported subset.** The FetchXML subset recalculated by this module:

| Part                                                                               | Meaning                                                                                  |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `<fetch aggregate="true">` with one `<entity>`                                     | The child table is the rollup source.                                                    |
| `<attribute name="c" aggregate="count\|sum\|min\|max\|avg">` (exactly one)         | The aggregate. `count` counts non-null values; the others read numbers and ignore nulls. |
| `<filter type="and">` with `<condition attribute="p" operator="eq" value="{id}"/>` | The parent link: rows whose `p` holds the parent id.                                     |
| optional `<condition attribute="statecode" operator="eq" value="0"/>`              | Only active child rows. A row without a statecode counts as active.                      |

Anything else (a `link-entity`, an or-filter, another condition, a second attribute or filter, a non-numeric value under sum, min, max or avg) is outside the subset.

**Inventory / contract.** Without a scheduler, `MassRecalculation` is contract only and stale columns are recalculated only on demand. Unsupported definitions are not guessed: they are answered by a diagnostic and state 2.

**Diagnostics.** `ROLLUP_UNSUPPORTED`, once per `table.column`: the definition is outside the subset, the pack function returned a promise, or a value under the aggregate is not a number. The column stores null with `_state = 2`. `api.rollups.diagnostics()` lists them.

**Pack override.** Export `rollups`, a map of `'<table>.<column>'` keys to synchronous functions `(row, ctx) => value`. `row` is a copy of the parent row and `ctx` is `{ table, column }`. The override wins over the definition and stores its value with `_state = 1`. Precedence: pack override, then the supported subset, then `ROLLUP_UNSUPPORTED` with state 2. The validator is `validateRollups(map)`; install is `install(api, { rollups, diagnostic })`.

**Limits.**

- SUM over no matching child rows is 0; MIN, MAX and AVG over none are null.
- An unsupported definition stores state 2 (OverflowError), the nearest platform error state.
- A write to a rollup column is refused with the invalid-property shape (`0x80048d19`).
- The platform keeps no per-row stale flag; its system job recalculates incrementally per column. The local `_state = 0` mark only tells the hourly local task which rows to visit.

## Formula columns

Module: `mirage/lib/dataverse-formula.mjs`. Capability record: level `behaviour` when the installed evaluator answers synchronously and reports behaviour (the core Power Fx engine does), or when a pack `formulaColumns` function covers every formula column, else `contract`; requires `provider:power-fx`.

**Behaviour.** A column whose metadata says `SourceType 3` is a formula column. Every read takes its value from the store's computed-column seam, so `$filter`, `$orderby`, `$apply` and FetchXML use the computed value too: a pack `formulaColumns['<table>.<column>']` function wins; otherwise the evaluator's `evaluateSync(formula, ctx)` evaluates the stored formula text against a copy of the stored row, with `symbols: { table, columns }` and `principal: null`, and its `{ value }` is used. Writes that set a formula column are refused with a 400 (`0x80048d19`, read-only) and store nothing. The column is evaluated as the system user, so the caller's identity is not passed.

**Evaluator.** The evaluator is the install option, else the host's `api.providers.powerFx` (the core Power Fx engine, or a pack `powerFx` adapter), else `createPowerFxEvaluator()` from `canvas-power-fx.mjs`, the core engine. The formula reads the row's columns by name or through `ThisRecord`, follows lookups to the related row, and reads other formula columns of the row, at most 10 deep; a decimal result keeps the column's precision (default 2), and a formula that answers an error value reads `null` with `FORMULA_ERROR` once per column (see [Dataverse](dataverse-parity.md)). With the engine explicitly disabled (`engine: false`) it answers 501 and the column reads `null`. Read projection is synchronous: an evaluator without `evaluateSync`, or one that answers with a promise, leaves the column `null` with `FORMULA_NOT_EVALUATED`. The capability record reports `behaviour` when the evaluator lists `evaluateSync` at behaviour.

| Source                | Meaning                                                                |
| --------------------- | ---------------------------------------------------------------------- |
| `SourceType 3`        | formula column (0 simple, 1 calculated, 2 rollup, 3 formula, 4 prompt) |
| `FormulaDefinition`   | the formula text, passed to the evaluator whole                        |
| evaluator `{ value }` | the column's value on read, when synchronous                           |

**Inventory / contract.** Without a synchronous evaluator or a pack override (the engine disabled), the answer is `null`.

**Diagnostics.** `FORMULA_NOT_EVALUATED` fires when a formula column has no value: the evaluator has no `evaluateSync` or answers asynchronously, the column has no formula text, the evaluator throws, returns without `value`, or a pack function returns a promise. Once per table and column, until reset.

**Pack override.** Export `formulaColumns`, keys `'<table>.<column>'` (case-insensitive), values synchronous `(row, ctx) => value` functions where `ctx` is `{ table, column, user }` with `user` null (the column is computed as the system user). Validator: `validateFormulaColumns(map)`; an async function or a malformed key throws a `TypeError`. Precedence: override, then the evaluator, then the diagnostic and `null`.

**Limits.** The whole stored `FormulaDefinition` text is passed to the evaluator; a definition stored as YAML is not unpacked.

## Virtual providers

Module: `mirage/lib/dataverse-virtual-providers.mjs`. Capability record (`describe(api)`): each operation (`Create`, `Update`, `Delete`, `Retrieve`, `RetrieveMultiple`) is `behaviour` when a registered provider implements it and `contract` otherwise; a declared local fallback is listed as the `LocalFallback` operation (`contract`, its reason names the tables); `OnExternalCreated`, `OnExternalUpdated` and `OnExternalDeleted` are `contract`. Requires `pack:virtualTableProviders`.

**Behaviour.** Reads and writes of a virtual table go to its provider, and the local row is its mirror. A write goes to its provider inside the write's transaction, and the local row mirrors what the provider returned. A table is virtual when its mapping says so (`isVirtual`, `tableType` `Virtual` or a `dataSourceId`) or when the host declares it in `virtualTables`. The data source id comes from the `virtualTables` declaration, else `mapping.dataSourceId`, else the Solution's `dataverseMetadata.DataSourceId`. Its provider is `virtualTableProviders[dataSourceId]`, else `virtualTableProviders[table]`. The caller's identity is passed to the provider as `ctx.userId` and `ctx.initiatingUserId`.

The provider is the write's main operation, as data providers handle Create, Update and Delete at stage 30 on the platform. The module's `beforeWrite` hook only checks (501 `VirtualProviderMissing`, 501 `VirtualProviderOperationMissing`) and queues the write; the records layer calls the provider in its `external` stage, after the store write has passed every check (If-Match, alternate keys, required columns, business rules and the other hooks, store plug-ins) and before the `afterWrite` hooks, inside the same transaction. A write refused locally (412 for a stale If-Match or a duplicate alternate key, 400 for a validation or rule refusal) never reaches the provider. A provider failure rolls the local write back and answers 400 `VirtualProviderFailed`, so the local row is never left half written. A create without a primary key reaches the provider without one, and the provider's returned primary key and columns replace the stored row's; a create that names its key (in the body, or an upsert `PATCH /set(key)`) passes that key to the provider and keeps it, so a repeated upsert updates. The response and the `afterWrite` hooks see the merged row. A nested standard parent in a virtual row create is created through the pipeline first and reaches the provider as its reference (`{ id, logical_name, name }`) under the lookup column. A deep insert cannot create a virtual table row: it answers 501 `VirtualProviderDeepInsertUnsupported`.

A provider's write runs inside the operation's transaction (stage 30, the core transaction stage). A provider joins that transaction by exposing all three of `begin(ctx)`, `commit(ctx)` and `rollback(ctx)` (`ctx.operation` is `transaction`). Mirage calls `begin` once per provider and outermost transaction, before the provider's first write in it. It calls `commit` after that transaction commits. It calls `rollback` when that transaction rolls back for any reason: a provider failure, a later request of the `$batch` change set or `ExecuteTransaction` refused locally (412, 400, a plug-in), or a failed post-operation step. A failed `commit` or `rollback` is reported as `VIRTUAL_PROVIDER_TRANSACTION_FAILED`, and the transaction's outcome stands. A provider without these operations is not enlisted. Its write stays when the transaction rolls back, and `VIRTUAL_PROVIDER_EFFECT_UNCOMPENSATED` names each such row. Mirage never calls an inverse operation to undo a write, so the external change stays. The capability record lists `TransactionEnlistment` as `behaviour` when a registered provider declares the transaction contract, else `contract`.

| Write                             | Provider call            | Mirror                                                                                      |
| --------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------- |
| create, or an upsert that creates | `create(row, ctx)`       | the returned row (must carry the primary key); it replaces the stored row's key and columns |
| update, or an upsert that updates | `update(id, patch, ctx)` | the returned row, merged (the primary key is kept); nothing returned keeps the patch        |
| delete                            | `delete(id, ctx)`        | the local row is removed by the write itself                                                |

**Reads.** Before a Web API read answers, the records layer runs the `source` record hook. A collection, `$count` or navigation read calls the provider's `retrieveMultiple({ select, filter, orderby, top }, ctx)`: `select`, `filter` and `orderby` are the caller's `$select`, `$filter` and `$orderby` text, `top` is `$top` as a number, each `null` when absent. A single record, property or `$value` read calls `retrieve(id, ctx)`; `null` means the row does not exist (404). An alternate-key read asks `retrieveMultiple` and matches the key locally. The answer replaces the table's mirror rows (a returned row merges over its mirror row) without running write hooks, and the read then answers through the shared read path, so `$filter`, `$select`, `$orderby`, paging, `$expand`, column security and masking apply to the provider's rows as to any rows. `api.virtualProviders.query(table, { select, filter, orderby, top })` calls `retrieveMultiple` directly and resolves with its rows, or `null` when the table is not virtual, declares the local fallback, or its provider has no `retrieveMultiple`. Portal reads outside the Web API read the mirror as the last Web API read or write left it.

**SDK reads.** SDK `Retrieve`, `RetrieveMultiple` and FetchXML (a CLR plug-in's `IOrganizationService`, the flow Dataverse connector) are synchronous and never read the mirror. A virtual table without a provider (and without the local fallback) answers them with 501 `VirtualProviderMissing`. A table with a provider is served only through the provider's optional synchronous operations; without them the read answers 501 `SdkVirtualReadUnsupported`, and a FetchXML read of a virtual table always does (no request shape carries FetchXML). Provider-backed SDK reads execute the registered Retrieve/RetrieveMultiple pre/main/post pipeline over the provider result, including query/result changes and declared backend grants. `api.virtualProviders.status(table)` answers `{ virtual, provider, fallback }` synchronously.

| Provider operation                | Called for                                                  | Arguments                                                                            | Answer                                                                      |
| --------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `retrieveSync` (optional)         | SDK `Retrieve`                                              | `(ctx, id)`                                                                          | the row, or `null` (404); a promise answers 501 `SdkVirtualReadUnsupported` |
| `retrieveMultipleSync` (optional) | SDK `RetrieveMultiple` (QueryExpression)                    | `(ctx, { select, filter, orderby, top })`, the request shape `retrieveMultiple` gets | an array of rows; a promise answers 501 `SdkVirtualReadUnsupported`         |
| `createSync` (optional)           | SDK `Create` (and a Web API create when `create` is absent) | `(row, ctx)`, as `create`                                                            | the created row, synchronously                                              |
| `updateSync` (optional)           | SDK `Update` (and a Web API update when `update` is absent) | `(id, patch, ctx)`, as `update`                                                      | the updated row or nothing, synchronously                                   |
| `deleteSync` (optional)           | SDK `Delete` (and a Web API delete when `delete` is absent) | `(id, ctx)`, as `delete`                                                             | nothing, synchronously                                                      |

The rows pass the profile's grants and the read projection (column security, masking) as local rows do. An SDK write to a providerless virtual table answers 501 `VirtualProviderMissing` and stores nothing; an SDK write calls only the provider's declared synchronous write operation; without it the write answers 501 `SdkAsyncPreOperationUnsupported` before any provider call, and the local row stays unchanged. A declared synchronous operation that answers a promise fails the write with 400 `VirtualProviderFailed` (the provider has then been called; a provider without `begin`/`commit`/`rollback` keeps that write).

**Without a provider.** A virtual table without a provider answers every read and write with 501 `VirtualProviderMissing`. A project that wants local rows declares `virtualTables: { <table>: { fallback: 'local' } }` (the `install` option or a pack's `virtualTables` export, validated by `validateVirtualTables`): its rows are then stored and read locally, `VIRTUAL_PROVIDER_LOCAL_FALLBACK` (info) reports it once, and the capability record lists the table under `LocalFallback`.

**Inventory / contract.** `OnExternalCreated`, `OnExternalUpdated` and `OnExternalDeleted` are listed in the capability record at level `contract`; `dataverse-misc-messages.mjs` answers them and this module registers nothing for them. `api.virtualProviders.for(table)` returns the provider's operations and `describe(table)` returns the provider's own `describe()` result when it has one.

**Diagnostics.** Each is reported once per table and operation, then never again until reset.

- `VIRTUAL_PROVIDER_MISSING` (error): a virtual table has no provider and no declared fallback; its reads and writes answer 501 `VirtualProviderMissing`.
- `VIRTUAL_PROVIDER_LOCAL_FALLBACK` (info): a providerless virtual table uses its declared local fallback.
- `VIRTUAL_PROVIDER_FAILED`: a provider operation threw or returned a value that is not a row (or, for `retrieveMultiple`, not an array of rows; for `create`, a row without the primary key). The read or write fails with 400 and the local write is rolled back.
- `VIRTUAL_PROVIDER_OPERATION_MISSING`: the provider lacks the operation a read or write needs. The request fails with 501 and nothing is stored.

**Pack override.** Export `virtualTableProviders`, validated by `validateVirtualTableProviders(map)`. Keys are a data source id or a table logical name. Each value is an object whose operations are optional and must be functions: `retrieve`, `retrieveMultiple`, `retrieveSync`, `retrieveMultipleSync`, `create`, `update`, `delete`, `createSync`, `updateSync`, `deleteSync`, `describe`, and the transaction operations `begin`, `commit` and `rollback` (all three or none). An unknown operation name is refused, so a typo cannot pass silently. Operations other than the two synchronous reads may be async, because they run inside the write. `install(api, { virtualTableProviders, virtualTables, diagnostic })`; `virtualTables` maps a table to `{ dataSourceId?, fallback?: 'local' }` and declares it virtual; packs export the same map as `virtualTables`.

## Business process flows

Module: `mirage/lib/dataverse-bpf.mjs`. Capability record: level `contract`, requires `workflow:category=4`.

**Behaviour.** A business process flow is a workflow row of category 4, with `primaryentity` set to the table it runs on and `uniquename` naming its instance table. The module reads these rows in two places:

- `api.businessProcessFlows.list()`, `.for(table)` and `.diagnostics()` expose the inventory (read only, computed from the store on each call).
- `createInstance(api, workflowid, targetId)` (exported) inserts one instance row for a record, at the flow's first stage, through `api.change` and `store.createRecord` with the platform's admin identity, in a nested transaction. Awaited inside an open write it joins that write and rolls back with it; on its own it is one committed transaction. It runs only when the instance table exists in the store. The row does not go through the records pipeline, so no plug-in step or audit entry runs for it.

The module registers no message. `RetrieveProcessInstances`, `RetrieveActivePath` and `SetProcess` are already answered by `mirage/lib/dataverse-misc-messages.mjs`. `RetrieveProcessInstances` and `RetrieveActivePath` read the instance rows that `createInstance` writes. `SetProcess` answers 501 (see below).

| Operation                      | Level       | Meaning                                                                                                                                                                            |
| ------------------------------ | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BusinessProcessFlowInventory` | `inventory` | Lists category-4 workflow rows as `{ workflowid, name, uniquename, primaryentity, stages: [{ id, name, entity }] }`.                                                               |
| `BusinessProcessFlowInstance`  | `contract`  | `createInstance`: inserts `{ <pk>, businessprocessflowinstanceid, processid, activestageid, traversedpath, bpf_<primaryentity>id }`. Executes only when the instance table exists. |

**Inventory / contract.**

- The stage list is read only when it is simple: clientdata JSON `{ "stages": [{ "stageid", "stagename", "entityname"? }] }`, or XAML with `stage` elements that carry `stageid` (or `id`) and `stagename` (or `name`). A stage without an entity takes the flow's primary entity. A flow without a simple list has `stages: []`.
- Stage validation and stage moves are not implemented. There is no `moveStage`. No operation rewrites `activestageid` or `traversedpath` of an existing instance row; those are the two columns `createInstance` writes.
- `createInstance` does not create `processstage` rows. `RetrieveActivePath` reads those rows, so an instance whose stages are not in the store has an empty path.
- Instances carry no `statecode` or `statuscode`. The store stamps `createdon` and `modifiedon` as for any created row.

**Diagnostics.** Each fires once per flow (per code and workflow id) until reset.

| Code                         | When                                                                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `BPF_DEFINITION_UNPARSED`    | A category-4 flow has no primary entity or no simple stage list. Its `stages` is `[]`. Reported by the inventory and by `createInstance`. |
| `BPF_DEFINITION_MISSING`     | `createInstance` names a workflow id that is not a category-4 row. Creates nothing.                                                       |
| `BPF_DEFINITION_NOT_ACTIVE`  | `createInstance` names a flow whose `statecode` is not activated. Creates nothing.                                                        |
| `BPF_INSTANCE_TABLE_MISSING` | No mapping exists for the flow's `uniquename`. `createInstance` returns `null` and creates nothing.                                       |

`createInstance` throws a `TypeError` when the target id is not a GUID (a programming error, not a Dataverse answer).

**Pack override.** None in this module. The existing `dataverseMessages` seam (`addonHandlers`) replaces the `SetProcess` default.

**Messages.** `SetProcess` answers `501 NotImplemented`, inner code `0x80040216`, "SetProcess is for internal use only and is not simulated." A pack `dataverseMessages.SetProcess` handler replaces that answer.

**Limits.** The instance primary key is `businessprocessflowinstanceid` unless the mapping names an `idColumn`, and the lookup to the record is `bpf_<primaryentity>id`. A flow whose stage list has another layout has `stages: []` and reports `BPF_DEFINITION_UNPARSED`.
