# Company Operations example: Dataverse plug-in observations

Design of the Dataverse plug-ins that observe the synthetic [Company Operations model](company-operations-demo.md)
(document 1) and the [permission harness](power-pages-permission-test-harness.md) (document 2): what is observed and
why, the evidence contract, security constraints and the platform behaviour relied on. Building, installing and running
them is in the [plug-in laboratory guide](../../examples/company-operations/plugins/README.md); file names below are
relative to its folder.

Status: the plug-ins, registration tooling, collector and worker source and the Mirage replay binding are implemented in
`examples/company-operations/plugins`. The hosted durable collector, managed-identity federation, Key Vault and the
flow-only secret are contracts only: this project does not deploy them, and `registrations.json` marks them not ready.
Anything else not implemented is marked **Proposed** where it occurs. The **Evidence schema and metadata** section is
parsed by `prepare-schema.mjs`; keep its heading and table rows exact.

## Solution ownership and dependency order

| Import order | Solution                         | Owns                                                                                                       |
| ------------ | -------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1            | `PaqviloCompanyOperationsCore`   | 19 custom business/reference tables, standard-table extensions, choices, keys, relationships (document 1). |
| 2            | `PaqviloCompanyOperationsForms`  | Business forms and views.                                                                                  |
| 3            | `PaqviloPermissionTestSupport`   | Three history/probe tables and six support choices (document 2).                                           |
| 4            | `PaqviloPluginEvidence`          | The evidence tables, choices, relationships, forms and views below.                                        |
| 5            | `PaqviloBehaviorPlugins`         | Assemblies, steps, images, Custom API, environment variables and the TestSupport extensions below.         |
| 6            | `PaqviloCompanyOperationsPortal` | One website, roles, permissions, page components and settings; Contact-role assignments stay data.         |

- Dependencies run one way: TestSupport imports without evidence lookups, which BehaviorPlugins adds. The segmented
  exports update existing tables
  ([segmentation](https://learn.microsoft.com/en-us/power-platform/alm/segmented-solutions-alm)). Azure bindings, secure
  step configuration and connection references are provisioned per environment.
- Seeding precedes activation of the BehaviorPlugins steps: `OperationIntentGuard` overwrites markers even for trusted
  SDK creation and gets no seed exception.
- 28 tables, 25 custom and three standard: 22 business/reference tables (19 custom plus Account, Contact and system
  Money Currency), three support and three evidence tables. The harness has 21 roots because the custom
  CurrencyReference replaces the system Currency root. Technical findings live in `pqvd_testoperation`, not
  `pqvd_finding`.

## Platform behaviour the design relies on

_Documented_ means linked Microsoft documentation; _observed_ means seen in this project's live captures and encoded in
the code; _assumed_ means not qualified.

- _Documented._ RetrieveMultiple's `Query` can be FetchExpression, QueryExpression or QueryByAttribute; OData reads can
  arrive as QueryExpression ([query
  types](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/best-practices/business-logic/implement-all-types-of-queries-when-filtering-preoperation-retrievemultiple)).
  Record the runtime type; make no conversion calls in the hot pipeline.
- _Documented._ Liquid `variable.xml` shows the query with permissions applied, a plug-in sees it only at its registered
  stage and order, and neither is physical SQL ([event
  pipeline](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/event-framework)). The late artifact is
  `PluginReceivedQuery.Stage20.Late`, attributed `RegisteredStageOnly.NotFinalSql`. Permission-join expansion has no
  documented formula: compare captures, never assert one join per role.
- _Documented._ FetchXML allows 15 link-entities unless support raises `QueryLinkEntityLimit`
  ([joins](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/fetchxml/join-tables)); execution Depth
  is limited to 8 by default and unrelated to permission depth
  ([Depth](https://learn.microsoft.com/en-us/dotnet/api/microsoft.xrm.sdk.iexecutioncontext.depth)). Never change
  either limit; assert lineage, not Depth.
- _Documented._ In-transaction writes roll back with a failing request; the trace log survives but is capped at 10 KB
  and purged after about 24 hours
  ([tracing](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/logging-tracing)). Hence the durable
  collector design.
- _Documented._ `RetrieveEnvironmentVariableSecretValue` runs only from flows; secure step configuration is not
  exported; filtering attributes mean "sent", not "changed"; plug-ins cannot call private Custom API messages, and a
  Custom API plug-in gets no step configuration
  ([registration](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/register-plug-in), [Custom
  API](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/custom-api)).
- _Observed._ Nested operations can run in internal ObjectModel contexts that drop the caller's `UserId` and
  SharedVariables, so ChainB seals its step ID into the server-owned `pqvd_configstatus` for `ChainNodeGuard`.
- _Observed._ A different `tag` on a descendant request fails with a duplicate-key fault; only the root sets it.
- _Assumed._ Power Pages forwards no `tag` from browser headers; root correlation uses markers or probe fields.
- _Assumed._ System Currency may lack the pipeline a custom table gets, so R21 is observed on `pqvd_currencyreference`;
  zero Currency events beside a working positive control stays unqualified.

## Operation identity and correlation

One `pqvd_testoperation` row is the technical finding for **one root request attempt**, identified by its primary GUID.
Retries, pages, CRUD steps and SDK roots get new GUIDs; nested SDK pipelines share the root with distinct span IDs;
paired Liquid and Web API reads share a pair key. A retry never overwrites a failed attempt.

- A portal POST cannot choose the GUID, so `OperationIntentGuard` (Create, stage 20, order 5) assigns it, derives the
  Contact from the Run and stamps the markers `CO-UTC:<yyyy-MM-ddTHH:mm:ss.fffZ>` and `CO-OP:<lowercase id>`, capture
  state Pending and the actor provenance, all immutable afterwards.
- The caller injects both markers into the root criteria, in an AND with the original root filter, never in a
  link-entity and without changing OR precedence; the null arm keeps null names:

  ```xml
  <filter type="or">
    <condition attribute="pqvd_name" operator="null"></condition>
    <filter type="and">
      <condition attribute="pqvd_name" operator="ne" value="CO-UTC:2026-10-12T09:00:00.000Z"></condition>
      <condition attribute="pqvd_name" operator="ne" value="CO-OP:11111111-1111-4111-8111-111111111111"></condition>
    </filter>
  </filter>
  ```

  The guard is inert only while no root primary name (`account.name`, `contact.fullname`,
  `transactioncurrency.currencyname`, `pqvd_name`) holds a `CO-UTC:` or `CO-OP:` value. The committed catalogues hold
  none; **Proposed**: a fixture-generation check.

- The observer reads markers only from root-table name predicates and needs exactly one distinct pair and an intent
  with those stored markers and a Run; otherwise it captures nothing and never guesses an actor.
- `physicalQueryHash` hashes the exact received query. `logicalQueryHash` must match across paired lanes; the harness
  hashes the authored template before marker values are filled in. **Proposed**: a versioned canonical form of received
  queries that removes only the reserved guard and declared paging differences.
- QueryByAttribute cannot express the guard; it is an SDK calibration case on ChainNode fixtures, not a paired lane.
- **Markers correlate; they never authenticate.** `UserId` and `InitiatingUserId` are Dataverse users, not the portal
  Contact. Publishing raw captures to the run's Contact suits only this synthetic lab, never a real-data logger.
- `TransactionalLab` writes nothing for an operation without a Run, and the worker keeps such receipts in Blob storage.
  **Proposed**: a private `Quarantined` operation (rules below), attached later only to a validated run and intent,
  never to a Contact inferred from query text.

## Evidence schema and metadata

Use prefix `pqvd`, stable component IDs and option prefix `18327`. `!` means application-required unless the quarantine
exception below applies. Text lengths are characters; Time is DateTime/UserLocal with UTC serialization; L is a
single-target lookup. External/context GUIDs are Text(36), avoiding assumptions about UI support for custom GUID
attributes. Standard primary GUID, name, timestamps, state/status and auditing are present. Evidence tables are standard
organization-owned tables; ChainNode is standard **user/team-owned** so Assign can be tested.

| Table / entity set                           | Columns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pqvd_testoperation` / `pqvd_testoperations` | `pqvd_name` Text(160)!, `pqvd_runid` L(pqvd_testrun), `pqvd_runnercontactid` L(contact), `pqvd_pairkey` Text(36)!, `pqvd_caseid` Text(64)!, `pqvd_lane` Choice!, `pqvd_variant` Text(128)!, `pqvd_phase` Choice(pqvd_phase)!, `pqvd_attempt` Integer!, `pqvd_pagenumber` Integer!, `pqvd_expectedmessage` Text(64)!, `pqvd_roottable` Text(80)!, `pqvd_markertime` Time!, `pqvd_markerutc` Text(64)!, `pqvd_markeroperation` Text(48)!, `pqvd_logicalqueryhash` Text(64), `pqvd_physicalqueryhash` Text(64), `pqvd_authoredquery` Multiline(262144), `pqvd_clientsummary` Multiline(65536), `pqvd_liquidxml` Multiline(262144), `pqvd_clientfinishedat` Time, `pqvd_capturestate` Choice!, `pqvd_serversummary` Multiline(65536), `pqvd_receivedqueryhash` Text(64), `pqvd_receivedlinkcount` Integer, `pqvd_backendfirstat` Time, `pqvd_backendlastat` Time, `pqvd_actorprovenance` Text(80)!, `pqvd_collectorreference` Text(160). |
| `pqvd_pluginevent` / `pqvd_pluginevents`     | `pqvd_name` Text(160)!, `pqvd_operationid` L(pqvd_testoperation)!, `pqvd_eventkey` Text(64)!, `pqvd_partnumber` Integer!, `pqvd_partcount` Integer!, `pqvd_source` Choice!, `pqvd_artifacttype` Text(64)!, `pqvd_capturetime` Time!, `pqvd_message` Text(64), `pqvd_stage` Integer, `pqvd_mode` Integer, `pqvd_executionorder` Integer, `pqvd_depth` Integer, `pqvd_isintransaction` Boolean, `pqvd_backenduserid` Text(36), `pqvd_initiatinguserid` Text(36), `pqvd_correlationid` Text(36), `pqvd_requestid` Text(36), `pqvd_platformoperationid` Text(36), `pqvd_spanid` Text(36)!, `pqvd_parentspanid` Text(36), `pqvd_querytype` Text(40), `pqvd_linkcount` Integer, `pqvd_contenttype` Text(80)!, `pqvd_payloadtext` Multiline(262144)!, `pqvd_payloadhash` Text(64)!, `pqvd_provenance` Text(80)!.                                                                                                                            |
| `pqvd_chainnode` / `pqvd_chainnodes`         | `pqvd_name` Text(160)!, `pqvd_operationid` L(pqvd_testoperation)!, `pqvd_nodecode` Text(40)!, `pqvd_parentnodeid` L(pqvd_chainnode), `pqvd_hop` Text(16)!, `pqvd_hopindex` Integer!, `pqvd_scenario` Text(40)!, `pqvd_requestnonce` Text(36), `pqvd_completionnonce` Text(36), `pqvd_querymarkerutc` Text(64)!, `pqvd_payloadjson` Multiline(16384), `pqvd_sampletext` Text(160), `pqvd_sampledecimal` Decimal(precision 4, range -1000000..1000000), `pqvd_samplemoney` Money(precision 2, nonnegative), `pqvd_sampledate` DateOnly, `pqvd_sampletime` Time, `pqvd_sampleboolean` Boolean, `pqvd_samplechoice` Choice(pqvd_operation), `pqvd_samplemultichoice` MultiSelect(pqvd_engagementkind), `pqvd_samplecontactid` L(contact), `pqvd_configstatus` Text(80). Standard owner/owning business unit, transactioncurrencyid and state/status remain available.                                                                    |

Only run/runner lookups may be absent on quarantined operation rows. Use a generated GUID pair key, case/variant
`unmatched`, the parsed root table/message, a valid SDK lane placeholder and actorprovenance UnmatchedBackend;
serversummary explicitly marks the originating lane unknown until reconciled. Never put `unmatched` into a Choice field.
Creation guard fills markers from primary GUID and server time; observers preserve actual captured values in events even
if they mismatch. ChainNode code/operation/query-marker fields are immutable after Create; guard validates them at
C/U20/order5 with a declared Before image on U. Attempt/page/part indices start at 1; hopindex starts at 1, counts/depth
are nonnegative, and Boolean flags default false. No alternate key on large text or query content. The committed Source4
manifest keeps the operation variant column at 40 characters; the 128-character length applies only to the Source5
cohort.

| Key / relationship              | Definition                                                                                                                                                                                                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pqvd_ak_pluginevent_part`      | Operation lookup + event key + part number; all required. Event key hashes execution span, stage, step ID and artifact type. Repeated receipt is idempotent; differing payload under the same key is a conflict.                                           |
| `pqvd_ak_chainnode_code`        | Operation lookup + node code; both required. SDK Upsert profile uses this key.                                                                                                                                                                             |
| `pqvd_testrun_operations`       | Run -> operation through `pqvd_runid`.                                                                                                                                                                                                                     |
| `pqvd_contact_testoperations`   | Contact -> operation through `pqvd_runnercontactid`; reporting relationship only, not another portal root.                                                                                                                                                 |
| `pqvd_testoperation_events`     | Operation -> event through `pqvd_operationid`.                                                                                                                                                                                                             |
| `pqvd_testoperation_chainnodes` | Operation -> node through `pqvd_operationid`.                                                                                                                                                                                                              |
| `pqvd_chainnode_children`       | ChainNode -> ChainNode through parent lookup.                                                                                                                                                                                                              |
| `pqvd_contact_chainnodes`       | Contact -> ChainNode through sample-contact lookup; never a permission root.                                                                                                                                                                               |
| `pqvd_chainnode_peers`          | Native N:N ChainNode self-relationship; intersect `pqvd_chainnodepeer`, columns `pqvd_chainnodeidone` and `pqvd_chainnodeidtwo`, role names/metadata frozen in registry. Confirm exported metadata and use those actual names in SDK association requests. |

Custom 1:N relationships use Delete Restrict, Assign/Share/Unshare/Reparent/Merge Cascade None. Do not cascade deletion
of history. Standard owner/currency metadata is preserved. Self N:N peer deletion follows platform intersect cleanup; it
does not grant access to the other node. Operation has no alternate key: its primary GUID is the unique operation
identity.

Create three independent global choices with values starting at 183270000 in listed order:

| Choice              | Ordered labels                                                                      |
| ------------------- | ----------------------------------------------------------------------------------- |
| `pqvd_testlane`     | Liquid, WebAPI, SDK, Flow, LocalModel                                               |
| `pqvd_capturestate` | Pending, Partial, Complete, NoBackendInvocationObserved, CaptureFailed, Quarantined |
| `pqvd_eventsource`  | DataversePlugin, AzureCollector, PowerAutomate, SDKClient, LocalModel               |

`pqvd_lane` uses pqvd_testlane; `pqvd_source` uses pqvd_eventsource. Reuse support pqvd_phase/operation choices where
declared. Capture Complete means all expected artifacts for that operation were acknowledged, not that its business
request passed. Serversummary records expected/present/missing steps and per-artifact persistence states. An operation
that failed before PostOperation can have complete failure evidence without a fabricated post event.

BehaviorPlugins owns these **extensions**, not new tables:

| Existing table    | Added columns / relationships                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pqvd_testresult` | `pqvd_operationid` L(pqvd_testoperation), optional for legacy identity/run summaries; required by application for individual request artifacts. `pqvd_testoperation_results`: operation -> result. Existing result keys/engine choices stay unchanged. Backend plug-in evidence resides in server-owned events, never disguised as a client engine.                                                                                            |
| `pqvd_crudprobe`  | `pqvd_activeoperationid` L(pqvd_testoperation), `pqvd_triggernonce` Text(36), `pqvd_pluginscenario` Text(40), `pqvd_hopbudget` Integer(0..10). `pqvd_testoperation_probes`: operation -> probe. Probe ownership and run remain immutable. These fields trigger the chain; they do not confer business permissions.                                                                                                                             |
| `pqvd_equipment`  | `pqvd_canaryrunid` L(pqvd_testrun), optional and immutable. `pqvd_testrun_canaryequipments`: run -> disposable equipment. BehaviorPlugins owns this lookup and relationship. Only newly created unassigned Stock equipment with a CO-CANARY tag can bind it. A Delete-only Parent permission beneath the runner's own Run permits cleanup without granting general IT equipment deletion. Existing business equipment leaves this lookup null. |

Add main forms `CO Test Operation`, `CO Plugin Event`, `CO Chain Node` in PluginEvidence; read-only evidence fields,
events/nodes subgrids on operation, typed values/owner on node. Public views: `CO My Run Operations` (parameterized
portal use, not personal security), `CO Pending Captures`, `CO Quarantined Captures`, `CO Plugin Events by Operation`,
`CO Chain Nodes by Operation`, `CO Failed Capture Operations`. BehaviorPlugins owns five supplemental main forms: `CO
Test Operation Pipeline` adds the results subgrid; `CO Test Result Pipeline` includes the Operation lookup; `CO CRUD
Probe Pipeline` exposes trigger fields; `CO Test Run Pipeline` adds the operations subgrid. `CO Equipment Canary
Diagnostics` exposes the immutable canary Run lookup, tag, Stock state and assignment for cleanup review. Preserve
initial Core/Support/Evidence forms without BehaviorPlugins-owned references so exports retain dependency direction.
This supplemental approach avoids a shared unmanaged form introducing reverse dependencies. Lookup/Quick Find views use
names/IDs and safe summary columns, never entire query/context payloads. No Global grants.

## Recorder permissions and server-owned evidence

- `CO Test Runner` gets Parent permissions Run -> Operation (Read, Create, Update, Append, Append To; no Delete),
  Operation -> Events (Read) and Operation -> ChainNode (Read), beside document 2's own permissions
  (`portal-security/blueprint.mjs`). No Contact root on Operation, no Global evidence permission, no portal writes to
  events or chain nodes. Quarantined operations have no Run and so no portal path.
- Web API field lists do not separate read from write, so guards enforce the server-owned columns: the portal may change
  only the authored query, hashes, client summary, Liquid XML and client finish time, and server actor fields are
  derived, never accepted from the browser. `registration.mjs` generates the guard inventory; the refusals are listed
  under [what the guards enforce](../../examples/company-operations/plugins/README.md#what-the-guards-enforce).
- Trusted writers are an explicit configured system-user allowlist (`trustedWriterIds`), never a client Boolean or a
  marker. **Proposed**: a hosted collector application user with create, read and update on operations and events, read
  on runs, and no business-table read or grant writes.
- Events are append-only for ordinary callers, but a trusted writer or administrator can still alter them: no
  cryptographic attestation is claimed. The one deletion path through the guards is the owned-evidence contract that
  the lab registration turns on for `verify-live.mjs --cleanup`: a root Delete by the sole configured SDK writer, bound
  to a maintenance intent of the same run that names the event and its payload hash
  ([optional contracts](../../examples/company-operations/plugins/README.md#optional-contracts-off-by-default)).
- Snapshots never contain credentials, cookies, authorization headers, secret values, secure configuration or tokens;
  values under sensitive key names are redacted.

## Set A: incoming-query observer

`IncomingQueryObserver` runs synchronously on RetrieveMultiple of every business/reference table plus a diagnostic
ChainNode registration, at stage 10/order 10, 20/10 (before the deliberate mutator), 20/9900 (late view; another
higher-order step means it is not last) and 40/9900 (query plus returned rows and paging). Steps exist only where the
environment's message filter allows them; no unfiltered global step. Four snapshots per query are test overhead, not a
production logger pattern.

- The observer never changes the Query, rows, ordering, security, paging or expected exceptions, and records nothing for
  unmarked queries. Nested marked queries are part of the suite, so it does not return early at Depth > 1 unless
  `rootObservationOnly` is configured.
- Capture binds to the intent's immutable actor (see the guide's guard list); this qualifies recording ownership and
  grants no table access.
- FetchExpression is stored as the exact string, parsed with DTD processing prohibited, and its link-entities are
  counted recursively. **Proposed**: a stored link tree, filter and alias inventories and a normalized hash.
  QueryExpression and QueryByAttribute become typed DTOs with an explicit marker for unsupported types; converted XML is
  never labelled original FetchXML.
- A failed stage is never filled by rerunning the query, and a missing post snapshot is not an empty result.
- **Proposed**: header `pqvd_receivedqueryhash` and `pqvd_receivedlinkcount` summarize a RetrieveMultiple root's late
  snapshot and stay null for CRUD and SDK roots, whose server summary indexes child queries by span.
- CurrencyReference rows and `pqvd_access_currencyreferences` are fixture-maintenance only; guards stay on for probes.

## Durable capture

An in-transaction write rolls back with its request, so **evidence that survives a failed request needs an external
durable collector**. `deploy.mjs` installs `TransactionalLab`, labelled rollback-vulnerable; see
[capture modes](../../examples/company-operations/plugins/README.md#capture-modes). The `DurableCollector` contract:

- The plug-in posts each snapshot synchronously and checks the durable receipt; an independent worker writes it to
  Dataverse outside the request transaction and may retry its own writes, never the business mutation. No
  fire-and-forget threads or recursive SDK logging.
- Each receipt waits at most `timeoutMs` (default and maximum 2000 ms) within 8000 ms per operation. A failure traces
  safe IDs only, leaves capture incomplete and lets the query proceed: fail-open capture is not test success.
- Payloads over 2 MiB UTF-8 are traced as incomplete. Parts split at Unicode-safe boundaries of at most 128,000 UTF-16
  code units and carry the full hash and part count; a repeated receipt is idempotent, a different payload under the
  same key a conflict. **Proposed**: a 20 MiB per-run budget and private blob references (never SAS or bearer URLs).
- Capture, collector and Dataverse times are kept apart; order by spans and stages. `NoBackendInvocationObserved` means
  nothing arrived in the window (cache reuse, early validation, missing registration or capture failure remain
  possible), never proof of authorization denial.

## Set B: pipeline context and SDK chain

The root is a portal PATCH of the Contact's own `pqvd_crudprobe` setting operation, scenario, hop budget (1 to 10) and a
fresh nonce; `RecordingBindingGuard` checks them against the intent, and other updates start nothing. A denied business
write never triggers a privileged fallback. `ChainA` (probe Update, stage 40) creates node B with the root `tag`;
`ChainB` (node Create) moves it to hop C; `ChainC` (node Update, B -> C only) runs the profile's leaf action.
`PipelineContextObserver` records stages 10, 20 and 40 with two secure profiles, `AsyncContextObserver` a separate
asynchronous execution, `DepthChain` the depth scenario, and the disabled `QueryShapeMutator` an SDK-only query change.

- Nested operations are real SDK requests through `IOrganizationService.Execute`, with typed requests where a `tag` is
  needed, under `context.UserId`; never direct `Execute` calls, never silent null or system identity.
- Recursion is bounded by operation, scenario allowlist, hop transition, node code, nonce and budget, not by suppressing
  Depth > 1. Plug-in instances hold no per-execution state. Assertions use recorded lineage. Operator-visible behaviour:
  [SDK chain behaviour](../../examples/company-operations/plugins/README.md#sdk-chain-behaviour).
- A 60-second wall-clock budget is enforced for the depth chain. **Proposed**: the same budget for every profile.
- **Proposed**: projection and invariant handlers for mutable business scenarios under a fixture-maintenance identity.
  None is installed, so `BusinessProjectionGuard` limits portal updates to safe fields.

Profiles (scenario `ABC` for P01, otherwise the code). Eligibility comes from SDK message-filter metadata; an
unsupported combination has a reason, and absent registration is not a pass. `verify-live.mjs` runs the implemented
ones.

- Implemented: P01 ABC chain; P02 CRUD (Create, Update, Retrieve, QueryExpression and QueryByAttribute reads, Delete;
  a FetchExpression read is **Proposed**); P03 Associate/Disassociate through `pqvd_chainnode_peers`; P04 Upsert by key
  twice; P05 Assign to the demo team (needs `provision-owner-team.mjs`); P06 state Update then SetState; P07 Custom API;
  P09 depth budgets 1, 3, 7, 8, 9 and 10; P10 async; P11 shared variables and parent context; P12 secure configuration
  and `pqvd_LabProfile` (missing and invalid-type cases **Proposed**).
- Blocked (the probe guard requires `DurableCollector`): P08 controlled rollback; P13 managed identity, Key Vault and
  echo service; P14 flow secret (contract `collector/flow-secret-contract.json`). ChainC refuses P13 and P14; their leaf
  actions are **Proposed**.
- **Proposed**: P15 bulk messages and P16 Merge and other specialized messages, from an external SDK client only;
  ExecuteMultiple, ExecuteTransaction and bulk messages never run inside synchronous plug-ins
  ([batch guidance](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/best-practices/business-logic/avoid-batch-requests-plugin)).

An expected fault aborts the transaction, so faulting leaf calls get their own root; a failed in-transaction SDK
write is never caught and continued.

## Images, Custom API and snapshots

- Images list exact columns, never all attributes; Upsert is not assumed to provide Update images, and asynchronous
  steps register their own.
- `pqvd_EchoLabContext` is public because plug-ins cannot call private messages. Its execute privilege is the installed
  ChainNode Read privilege, it returns IDs and a typed echo, never secrets, and it is not a portal endpoint.
- Every event is a schema-versioned DTO, never reflection over SDK objects. Context interfaces report availability
  separately from a successful read (false, empty GUID and unavailable stay distinct); parents, images, rows and strings
  are bounded with counts and truncation flags; unknown types are named, never given an invented value; SharedVariables
  are limited to `pqvd.lab.*` and `tag`; the business `operationId` is kept apart from platform IDs
  ([context and tag](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/understand-the-data-context)).
  The sandbox never hashes binaries: `audit-installation.mjs` maps assembly identity to hashes outside it.

## Secrets and Azure

- The unsecure step configuration is validated at construction and holds no credentials. The secure configuration holds
  a **synthetic** secret; only presence, validity and version label are recorded, never value, length or hash. Two step
  profiles with different versions prove per-step construction. Secure values are provisioned after import from the
  symbolic references in `secure-provisioning.json`.
- `deploy.mjs` defines the `pqvd_Lab*` environment variables with safe defaults and a valueless secret definition; a
  missing endpoint blocks collection rather than pointing at an invented host. Ordinary values use
  `RetrieveEnvironmentVariableValue` (`DefinitionSchemaName`); the flow secret action takes `EnvironmentVariableName`.
- **Proposed**, P14: `CO Lab Secret Verification` runs only for an allowlisted ChainNode in `FlowPending`, validates
  operation, scenario and nonce, and returns only success, version label, run reference and a safe error category, with
  secure inputs and outputs on every action carrying the secret. Its sanitized callback is gated by the flow connection
  identity. No secret reaches Dataverse, traces or run history; a direct plug-in call is expected to fail.
- P13: the collector token comes from `IManagedIdentityService.AcquireToken` (qualify it against the selected SDK). It
  needs version 2 federation, a certificate-signed assembly bound to the identity and Azure RBAC; strong-name signing is
  insufficient ([managed identity](https://learn.microsoft.com/en-us/power-platform/admin/set-up-managed-identity)).
  **Proposed**: Key Vault verification of a synthetic secret and an allowlisted echo service.
- Outbound calls go only to the configured HTTPS, non-loopback collector without a query string, with redirects off,
  `Connection: close` and a bounded response ([sandbox web
  access](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/access-web-services)). URLs never come
  from portal fields. Missing bindings and timeouts are recorded outcomes, not simulated successes, and collector
  readiness does not claim P13 or P14.

## Join budget, comparison and the harness page

The harness runs S01 and owns the page ([harness guide](../../examples/company-operations/portal-harness/README.md)).
Rules for reading their evidence:

- Authored join count and permission-path count are independent; paths may be deduplicated, so linear growth is never
  asserted. Extra roles come from fixture administration, never from widening a persona or from the page.
- A refusal can precede the observer; label that missing evidence. Link limits, authorization denial, missing fixtures,
  collector failure and data drift are different outcomes; an expected 16-link rejection can pass as a constraint test
  while its parity status stays an error. Unique markers can reduce cache reuse; record it.
- Complete payloads live in result parts (client) and event parts (server); a header value that does not fit stays null,
  never silently truncated. Backend outputs are observations, never the oracle. Generated aliases, timestamps and IDs
  are ignored only by named, versioned comparison rules.

## Local models and the Source5 cohort

Mirage runs the original assemblies against native captures
([replay in Mirage](../../examples/company-operations/plugins/README.md#replay-in-mirage)) but does not reproduce the
hosted pipeline or Azure: local events are models. SDK tests do not prove Power Pages authorization.

Source5 observes disposable Stock canary Equipment Create, Update and Delete in their original portal context and adds
an optional probe equipment lookup ([optional
contracts](../../examples/company-operations/plugins/README.md#optional-contracts-off-by-default)). SDK-prepared
intents, valid for 30 minutes, bind operation, target, message, Contact-owned Run and the portal actor. Create and
Update carry the `CO-OP:` sentinel in the name; Delete uses one prepared before the source freeze and captures the
`Before` image. Room rebinds stay in the Building and owning Account. Source5 has its own assemblies, registrations,
schema and recordings; Source4 captures do not qualify it.
