# Dataverse plug-ins

Mirage imports plug-in assemblies, types, steps and images from the selected Solution sources and runs the steps in the
organization's event pipeline. **Backend operations** in `/_sim/` shows each step's table, SDK message, stage, rank,
mode and filtering attributes; **Inspect** links steps to exported metadata and explicitly mapped C# sources. Lense uses
the same inventory. Exported registrations do not prove which steps are active online, and an export is not an
inventory of native platform handlers: native logic absent from the export needs its own project model or trusted
implementation.

"As recorded natively" below marks behaviour taken from captures on a live organization (`observation` evidence, see
[execution boundaries](#execution-boundaries)); other behaviour follows Microsoft's documented contracts or is a stated
local model.

## Execution modes

Each enabled step runs one implementation. A `/_sim/` choice, a trusted pack handler or a web hook endpoint takes
precedence over the assembly's uploaded content; without content a trusted original-CLR descriptor runs it when its
`defaultMode` is `clr` or **Execute trusted original CLR assembly** is chosen in `/_sim/`; otherwise the step is a
placeholder.

| Mode            | Local behaviour                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| Placeholder     | CRUD continues; a `PLUGIN_STEP_PLACEHOLDER` diagnostic reports the skipped logic                        |
| JSON mock       | Returns a target patch, a read query/result or bulk Targets, or rejects the write                       |
| Project handler | A trusted, explicitly registered synchronous JavaScript model (`pluginSteps` by step id, `pluginTypes`) |
| Original CLR    | Runs the registered .NET type in a local CLR host                                                       |
| Disabled        | Skips the step deliberately and records the choice                                                      |

- **Uploaded content runs by default.** A step whose assembly has content (uploaded through the Web API, SOAP or the
  Plug-in Registration Tool, from a `pluginpackage`, or read from a Solution export's `.dll`) runs it in the CLR host,
  as the platform runs every registered plug-in. See [uploaded assemblies](#uploaded-assemblies-run-by-default).
- **An exported step without bytes** (a Power Pages export carries none) runs original code only through a trusted
  `pluginRuntimes` descriptor ([original assembly registration](#original-assembly-registration)). Discovery alone
  never enables a DLL; missing CLR prerequisites do not prevent mocks or disabled choices.
- **A project handler that misbehaves** fails its own write and nothing else. A thrown error, a returned promise or an
  unusable result is the plug-in fault of that write, which is rolled back. A handler that never returns is ended at
  the platform's 2-minute plug-in limit: a served runtime (`mirage dev`, `start`, `serve`) writes
  `Mirage stopped: plug-in step <name> (<id>) did not return within 120 s` to its log and exits, because a JavaScript
  loop cannot be interrupted from outside and it blocks every other request meanwhile. An error the handler throws
  later, from a timer or an unawaited promise, has no request to report it: a served runtime records
  `PROJECT_CODE_UNCAUGHT` with the file and line and keeps serving. An asynchronous `workflows` or
  `dataverseMessages` handler whose promise never settles ends its invocation with 504 `PackHandlerTimeout` after
  120 s; the runtime keeps serving, and what the handler does through its API afterwards is refused.
- **Mocks** are validated by the admin endpoint for result shape, source table and stage. An explicit mock still
  applies when the original registration needs an unavailable image or identity adapter, and diagnostics state that the
  original logic did not run. A mock never gives an unknown message or stage a pipeline. Choosing mock or disabled for
  an original plug-in launches no CLR host.
- **Use source default** in Backend operations removes a local override.
- An asynchronous step run that executes nothing (unsupported registration, placeholder without handler or mock) ends
  Canceled (`statuscode` 32) with the reason in `message`; it never reports Succeeded.

## Registration

While the Dataverse API is on, its registration rows decide which steps run; without registration writes they equal
the Solution's list. A disabled step stops running, a deleted step is removed, and a step registered through the API
takes its pipeline position (stage, then rank) like a Solution step. Mirage stores plug-in packages, assemblies, types,
steps and images with the `sdkmessage` and `sdkmessagefilter` rows they reference.

**Validation** answers with these codes, taken from native captures (the isolation-mode refusal was captured for a
package-owned assembly and is assumed for the others):

| Case                                                                                | Answer                                                                                                                                                    |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missing message or handler                                                          | `0x80040200` "sdkmessageid is missing." / "plugintypeid is missing."                                                                                      |
| Fractional rank                                                                     | `0x80048d19`. Any whole rank is accepted; a negative rank runs before rank 1                                                                              |
| Unknown filter                                                                      | 404 `0x80040217` (a filter of another message is accepted)                                                                                                |
| Deployment its filter's (else message's) availability does not admit                | `0x80040203`, checked before secure configuration                                                                                                         |
| Asynchronous step outside stage 40                                                  | `0x80040203` naming the step                                                                                                                              |
| Filter that takes no custom step; a global step on `WhoAmI` or `RetrieveVersion`    | `0x80044187` naming the step and filter or message                                                                                                        |
| Unknown filtering attribute (also one with leading or trailing spaces)              | `0x8004f036`                                                                                                                                              |
| Image type the message does not support                                             | `0x8004416d`                                                                                                                                              |
| Image attribute that is not a column of the step's table                            | `0x80081119`                                                                                                                                              |
| Duplicate typename in an assembly                                                   | `0x8004417c`                                                                                                                                              |
| Type that is not one of the assembly's plug-in or workflow activity types           | `0x8004418b` "PluginType [..] not found in PluginAssembly [..]"                                                                                           |
| Deleting a plug-in type a step uses (assemblies and packages likewise)              | `0x8004f01f`; the step survives                                                                                                                           |
| Isolation mode other than sandbox                                                   | 403 `0x80040256` "Action failed for assembly '<identity>': No publisher is found, assembly must be registered in isolation."                              |
| Assembly content over 16 MB; source type other than database                        | `0x8004418f`; `0x8004417d`                                                                                                                                |
| Step registration without `prvCreateSdkMessageProcessingStep` and `prvReadSolution` | 403 `0x80040220` naming `prvReadSolution`; with the former, `prvReadSolution` is not needed (the lookups still need their Append and AppendTo privileges) |

A step without a stage is accepted. Images on SetState, SetStateDynamicEntity (EntityMoniker), GrantAccess (Target)
and DeleteMultiple (Targets) are refused, as are asynchronous-stage, filtering-attribute and image-type combinations the
message does not allow. The table's platform columns (`createdon`, `modifiedon`, `ownerid`, `statecode`, ...) and its
primary key are valid filtering and image attributes. An administrator's step whose `impersonatinguserid` names a
missing systemuser is accepted and keeps the unresolved id. Secure configuration on a non-server step, the impersonation
privilege, required-column and web hook step checks and the custom API step policies are local models.

**Packages.** A `pluginpackage`'s content is read as a NuGet package: each `lib/` assembly that declares an `IPlugin`
type becomes a package-owned `pluginassembly` (source type 4, sandbox isolation, public key token `null` when unsigned)
with a `plugintype` per plug-in type (workflow activities are not package types). A second package duplicating a
registered assembly is a duplicate key (`0x80040265`); deleting a package-owned assembly answers `0x80081117`; deleting
the package while a step uses one of its types answers `0x8004f01f`, otherwise its assemblies and types go with it. New
content drops types it no longer declares, and an update that would drop a type in use is refused (`0x8004418b`). A type
posted directly onto a package-owned assembly is accepted whatever its name and kept until the next content update.

**Solution steps.** An imported step has no secure configuration: its plug-in is constructed with secure `null` and its
unsecure configuration (a trusted descriptor may supply local secure text). At source bootstrap Mirage reads the `.dll`
an exported assembly names (`FileName`, `PluginAssemblies/<name>-<id>/<name>.dll`, directory or ZIP), checks name and
version, and reports `PLUGIN_ASSEMBLY_CONTENT_MISSING` or `PLUGIN_ASSEMBLY_CONTENT_INVALID` otherwise. Assembly content
is inspected as bounded PE/CLI data for identity and declared types; it executes only when an enabled step of one of its
types runs. Offline Only registrations stay in the inventory and never run.

**Message catalogue.** Standard SDK messages keep their native `sdkmessageid`, availability, private, auto-transaction
and workflow flags and `none` filter: the request messages of the official SDK assemblies plus the data, bulk, retention
and archive messages. Platform messages whose native id is not recorded (AddMembers, RemoveMembers, Route, Handle, Send,
the privilege, role and Replicate messages, ...) get a local id. Web API actions whose message has another name
(AddMembersTeam is AddMembers, SetParentTeam and SetParentSystemUser are SetParent, ...) seed no message; other Web API
operation names seed one with a local id. Messages a Microsoft solution installs come from the exported Solution or the
project's `observed.sdkMessages`. A custom API created, renamed, rebound or deleted at runtime gets, replaces or loses
its `sdkmessage` row and filter at once.

**Filters per table.**

- Custom tables: the data, state, retention and archive messages (`IsValidStateTransition` takes no custom step),
  `DeleteMultiple` and the legacy bulk messages, plus Assign and the sharing messages when user- or team-owned.
- Recorded native sets: `account` (26 filters, all allow steps), `transactioncurrency` (8; refuses Retrieve and
  RetrieveMultiple steps), `team` (12; AddMembers and RemoveMembers allow steps), `task` (17; Handle and Route allow
  steps), `systemuser` (18; refuses Retrieve and RetrieveMultiple), `contact` (the 17 platform filters of its 20).
- Other standard tables reuse the custom-table template (`lead` and `incident` add Merge), which may differ from native.
- N:N intersect tables take custom steps on RetrieveMultiple only. Elastic tables have data, bulk, Upsert,
  change-tracking, retention and archive filters. Virtual tables have data filters plus `OnExternalCreated`,
  `OnExternalUpdated` and `OnExternalDeleted`, whose steps must be asynchronous PostOperation (mode 1, stage 40;
  otherwise `0x80090303`); notifications publish the supplied snapshot and schedule the asynchronous pipeline without
  touching provider-owned rows.
- `none` filters: Associate, Disassociate, Execute, PublishAll and the other export, import and publish messages allow
  steps; Upsert, UpsertMultiple, Merge, RetrieveEntityChanges, WhoAmI, RetrieveVersion, ExecuteMultiple,
  ExecuteTransaction and most other request messages do not. A step with no filter is accepted on any existing message
  except WhoAmI and RetrieveVersion.
- `observed.sdkMessages[messageGuid]` may carry `availability` and `filterAvailability` (table to 0 server, 1 client,
  2 both); a proven server-only filter refuses Client and Both steps with `0x80040203`. Synthetic defaults are not
  evidence for this guard.

`GetPluginCertificateInfo` reads embedded PE Authenticode or NuGet `.signature.p7s` certificate metadata (names, SHA-1
fingerprint, self-signature result, DER) identified by the CMS signer's issuer and serial. It does not validate
signatures or establish trust; unsigned content has empty facts.

## Pipeline

Local Create, Update and Delete run synchronous stages 10 (PreValidation), 20 (PreOperation) and 40 (PostOperation) in
stage, rank, then step id order. At equal rank a single-record request runs its own message's steps before its paired
multiple message's, and a bulk request the reverse; ties between steps of the same message use step id, which may
differ from native. Stage 30 is the main operation, not a general extensibility stage.

- **Filtering.** Update filtering uses the columns present in the Target before each step (unchanged authored values,
  columns added by earlier steps, and the implicit primary key); it tests presence, not value changes. A Create step
  with filtering attributes fires only when the Target carries one of them.
- **Order of checks on Create.** The table-level grant gate precedes all handlers; then stages 10 and 20, declarative
  rules and their effects, the portal row-scope check (after stage 20, so local rules can establish a relationship
  first), then stage 40. A row-scope denial also revokes the request's independent PreValidation SDK writes. Scoped
  denials report permission name, scope and relationship.
- **Transactions.** Top-level PreValidation runs outside the transaction (`IsInTransaction` false), and its SDK writes
  commit independently and survive a later rejection. Nested PreValidation and stages 20 and 40 join the caller's
  transaction. An SDK write that fails inside a synchronous plug-in invalidates the enclosing transaction; catching the
  fault cannot make it commit (`0x8009000c`). A handled missing-record Retrieve and a caught local limitation (501,
  delivered as `NotSupportedException`) do not invalidate it. A caught refused Create still fails the operation with
  `0x8009000c`.
- **Depth.** JavaScript handlers and CLR steps share one `Depth` counter. The cap is 12, as recorded natively for
  synchronous and asynchronous chains: a thirteenth level fails with 400 `0x80044182` ("This workflow job was canceled
  because the workflow that started it included an infinite loop. ...", `LocalPluginDepth` for local callers) and the
  synchronous chain rolls back.
- **Timeout.** A CLR invocation's deadline (`timeoutMs`, default and maximum 120 seconds, the native 2-minute limit)
  includes its nested SDK calls and their plug-ins. Past it the step fails with 400 `0x80040224` and a
  `System.TimeoutException` message naming the type (`LocalPluginTimeout`), as recorded natively.
- **Faults.** An ordinary exception from `IPlugin.Execute` or a JavaScript step-id handler answers 400 `0x80040224` with
  its message. An `InvalidPluginExecutionException` answers `0x80040265` whatever code it authors. Its authored
  `errorCode`, or the SDK's default HRESULT `0x80131500`, is sent as the signed
  `Microsoft.PowerApps.CDS.ErrorDetails.SubErrorCode` annotation (`-2146233088` by default), and its `OperationStatus`
  as the `Microsoft.PowerApps.CDS.ErrorDetails.OperationStatus` value (`0`, Failed, unless authored; `Canceled` is
  `1`), for JavaScript handlers and CLR steps alike; the annotations appear when `Prefer` asks for them. An ordinary
  exception carries neither. A step-id handler declares the fault by throwing
  `{ pluginFault: 'InvalidPluginExecutionException', message, errorCode? }`; a plug-in type handler's exception is
  always that fault. The portal Web API wraps these faults in its own envelope.
- **Update rebase.** After PreOperation, Update re-reads the row and patches the latest saved values with the current
  Target and staged defaults: a field changed by a nested SDK write survives unless the Target names it.
- **Retrieve** reads after PreValidation and PreOperation; a ColumnSet change affects the returned attributes, and
  replacing the same-table Target selects another record while `PrimaryEntityId` keeps the requested id. Web API single
  and property reads use Retrieve, collection reads RetrieveMultiple; TDS bypasses both.
- **Read writes.** A Retrieve or RetrieveMultiple step may write through the SDK. A portal or Web API read whose steps
  run gets a read-operation boundary: the read is not transacted, its steps' SDK writes commit in their own transaction
  queued behind any open one (the step sees its own writes; others see them after commit), and they stay when the read
  later faults. A direct synchronous read without that boundary rejects original SDK writes.
- Operation flags, identities, parents, rollback boundaries and event chains belong to the active operation across
  asynchronous waits; an independent request cannot inherit them.

### Messages

| Message                                                                                                  | Local pipeline                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create, Update, Delete                                                                                   | Stages 10/20/40 and asynchronous steps. Each also runs its CreateMultiple, UpdateMultiple or DeleteMultiple steps inside its own pipeline (see [bulk](#bulk-messages)).                                                                                                                                                                                                     |
| Retrieve, RetrieveMultiple                                                                               | Stages 10/20/40 with typed query and result; asynchronous Retrieve steps run once after the read, also when a synchronous PostOperation step faults it.                                                                                                                                                                                                                     |
| Associate, Disassociate                                                                                  | One association pipeline for Web API `$ref`, SDK and portal `/_api` `$ref`: appendTo/append checks, record hooks per related row, stages 10/20/40 around the relationship write. A Web API N:N association first reads its intersect row.                                                                                                                                   |
| Assign, SetState, GrantAccess, ModifyAccess, RevokeAccess                                                | Own pipeline and main operation from SDK and SOAP; the sharing messages also from their Web API actions. SetState runs as SetStateDynamicEntity. Assign and SetState update the row through the Update pipeline (no Update PreValidation, ConcurrencyBehavior or nested SetStateDynamicEntity); Assign's Update runs as SYSTEM.                                             |
| RetrievePrincipalAccess, RetrieveSharedPrincipalsAndAccess                                               | Own pipeline with outputs (`AccessRights`, `PrincipalAccesses`); `IsAutoTransact` false; a team holding only a share reports the shared rights.                                                                                                                                                                                                                             |
| Update that sets `statecode`                                                                             | Runs SetStateDynamicEntity inside its main operation, one level deeper (a local model).                                                                                                                                                                                                                                                                                     |
| Upsert, UpsertMultiple, SetState steps                                                                   | Accepted, never run, as recorded natively. SDK Upsert reads the record (by id or by `KeyAttributes` of a declared alternate key) and runs Create or Update. UpsertMultiple runs CreateMultiple for new records, then UpdateMultiple, inside its UpsertMultiple/30 main operation.                                                                                           |
| Web API PATCH without `If-Match`                                                                         | Runs inside an Upsert main operation: a RetrieveMultiple existence check (QueryExpression on the key, no columns, TopCount 2), then Create or Update. `If-Match: *` and ETag requests skip the Upsert frame; If-Match on a missing row answers 404 `0x80040217` before any pipeline.                                                                                        |
| Merge                                                                                                    | SDK and Web API Merge on a mergeable table run the Merge pipeline around its Updates in one transaction: the subordinate is deactivated, then marked merged, and the target is written only when it gains values. On a table without a Merge filter SDK Merge fails with `0x80040800`.                                                                                      |
| DeleteMultiple (standard table)                                                                          | PreValidation of the bulk step and of each target's Delete, then 405 `0x8004023b`.                                                                                                                                                                                                                                                                                          |
| Create or Update writing money                                                                           | Runs `RetrieveExchangeRate` at internal stage 25 as SYSTEM (PreOperation, PostOperation and asynchronous steps, never PreValidation), between the Create's PreOperation and main operation. Natively a CreateMultiple runs it once; locally each target's Create does. Currency-only writes run none.                                                                       |
| Custom APIs                                                                                              | Stages 10/20/40 around the main operation, subject to the API's processing-step policy (None, Async Only, Sync and Async).                                                                                                                                                                                                                                                  |
| Other Web API actions and functions (and SOAP requests relayed to them)                                  | A generic pipeline: the Target row (else bound table, else `none`) as primary entity, inputs converted without parameter metadata (GUID text as Guid, typed objects as EntityReference or Entity), response properties as outputs. A local model. PublishXml and PublishAllXml (Web API and SDK) run the steps registered on their sdkmessages, `Publish` and `PublishAll`. |
| SOAP WhoAmI, RetrieveVersion, RetrieveCurrentOrganization, ExecuteMultiple, ExecuteTransaction, metadata | No pipeline. An enabled step on them (an unfiltered step, or one from a Solution) stops the request before any effect with `LocalPluginUnsupported`, a SOAP fault naming the step.                                                                                                                                                                                          |

SOAP Assign and SetState commit as one request transaction that queues their own and the delegated Update's
asynchronous steps. Between the two subordinate Updates of a Merge, the platform's internal stage-50 step reads the
subordinate's open action cards and the subordinate as SYSTEM, one level below the Merge. A bound operation addressed by
an alternate key binds its row and keeps the key in the Target.

### Bulk messages

- **Single origin.** A single Create, Update or Delete runs its multiple-message steps in its own pipeline: each sees
  the single message's context under its own `MessageName`, with the Target as a one-record `Targets` collection
  (EntityCollection named after the table, TotalRecordCount 0, MinActiveRowVersion null; for Delete an
  EntityReferenceCollection). It shares PrimaryEntityId, request ids, depth, ParentContext, SharedVariables,
  OutputParameters and Target edits; its Targets edits reach the Target. Queued multiple-message steps run as jobs of
  the same event; a queued DeleteMultiple job has an empty PrimaryEntityId. The wrapper's PrimaryEntityId starts empty
  and is set by executed scalar steps in rank order.
- **Bulk origin.** HTTP and SDK CreateMultiple/UpdateMultiple run the bulk ranks, then all single ranks for target A
  before target B in each stage; each record's single steps see the bulk message's context of that stage as
  `ParentContext` and the bulk request's ids. Targets are
  typed (TotalRecordCount 0 at PreValidation, -1 and MinActiveRowVersion `"-1"` afterwards), each target has its own
  Context4 image set, and a delegated record runs only its own message's steps. UpdateMultiple keeps duplicate entries:
  single Update steps run for each, and the first entry per id supplies the write. CLR bulk handlers may replace
  PreOperation Targets attribute collections; PostOperation Target changes reach later steps but not the saved row.
- **Availability.** SDK CreateMultiple and UpdateMultiple work on a table whose catalogue has the message's filter
  (native custom tables do), authorized by the run-as user's roles; otherwise `0x80040800` "The '<message>' method does
  not support entities of type '<table>'. MessageProcessorCache returned MessageProcessor.Empty.". Elastic tables refuse
  SDK bulk with 501 `LocalPluginBulkUnsupported`. A store without an organization catalogue needs
  `serviceProfile.bulkTables` entries (`entity`, `tableType: 'standard'`, `evidence`, `messages`). There is no fixed
  1,000-record limit. Combinations without imported filter evidence report `BULK_MESSAGE_AVAILABILITY_UNQUALIFIED` in
  the capability registry (`dataverse-standard-bulk-availability`).

## Execution context

**Parent context.** For synchronous Create, Update and Delete, PreOperation and PostOperation see the main operation as
`ParentContext`: stage 30, owned by the platform's `ObjectModel Implementation` step (one id per message and table),
inside the transaction, with the PreValidation inputs and shared variables. PreValidation keeps its caller's parent. A
nested operation's PreOperation sees its own main operation, whose parent is the calling step; Depth counts every level.
Every ancestor is readable and reports the observing context's `IsInTransaction` and `InitiatingUserAgent`. A later
operation on a saved row starts a fresh frame. A Web API PATCH upsert's existence read and its Create or Update share
one RequestId, OperationId and CorrelationId.

**Identity.** The caller's identity, business unit and impersonation apply to every step; the organization, root
business unit and SYSTEM are the defaults. Delete's PreOperation, main operation, PostOperation and asynchronous steps
run as SYSTEM (PreValidation as the caller), and JavaScript handlers and web hooks report the same `UserId`. An
impersonating step runs with the impersonated user as `UserId`. Assign's owner Update runs as SYSTEM while the caller
stays the initiating user. `IsApplicationUser` is true exactly when the initiating user is an application user.

**Input parameters and shared variables.**

- Every SharedVariables collection starts with the platform entries: `IsAutoTransact` (false for reads), `AcceptLang`
  (the caller's Accept-Language; empty for SDK requests from a plug-in), `tag` when the request carries one, and on
  Create `DefaultsAddedFlag` (not on a CreateMultiple request). Inside a [`$batch`](dataverse-api.md#batch) change
  set, collections, their parents and jobs add `IsODataTransaction` true and `ODataChangesetRequestCount`, and every
  stage is in the transaction.
- Create PreOperation and PostOperation collections carry `telemetryrootcontext`, a JSON string with local ids.
- After a main operation writes a user-owned table (or an association intersect), the root collection lists it in
  `ChangedEntityTypes` with `Update` (a `Dictionary<string, string>` in the CLR host). GrantAccess, ModifyAccess and
  RevokeAccess add `principalobjectaccess` and `POADistributionChanged` 10760; Merge adds `principalobjectaccess` and
  `POADistributionChanged` 1. A single-record write that queues asynchronous work adds `fileattachment: Create`
  (Mirage adds it before the PostOperation steps; natively Create and Delete show it only after their first
  PostOperation step). Only the root ancestor shows these entries; organization-owned tables are not listed.
- Inputs enumerate in this order: the request's parameters, then `tag` and `FromSandbox`, then platform additions
  (`ConcurrencyBehavior`, `IncludeAnnotations`, `ReturnNotifications`, `AppModuleId`, `IsAppModuleContext`,
  `UpdateContent`, `RelatedEntitiesQuery`), a bridged multiple message's `Targets` last.
- Delete and sandbox SDK requests carry `ConcurrencyBehavior` and `FromSandbox` in PreValidation and main-operation
  inputs only; a plug-in's UpdateMultiple carries `ConcurrencyBehavior` at every stage; a main operation's own Update
  (Assign, SetState, Merge) has none. `FromSandbox` comes only from an immediate CLR caller.
- Web API reads add IncludeAnnotations and ReturnNotifications (Retrieve, with a ColumnSet of the selected columns) or
  IncludeAnnotations, an empty AppModuleId and IsAppModuleContext (RetrieveMultiple). Reads issued outside a plug-in
  carry them false; the platform's own reads (Upsert existence query, N:N intersect check) carry the app-module inputs
  without IncludeAnnotations. An SDK or platform Retrieve has `RelatedEntitiesQuery` null and `ReturnNotifications`
  false.
- A Web API collection GET hands RetrieveMultiple steps a FetchExpression for the first page of 5000
  (`distinct="false" useraworderby="true" no-lock="false" mapping="logical" page="1" count="5000"`, GUIDs braced upper
  case); a step's edited FetchXML is read back into the query. PostOperation's BusinessEntityCollection carries the
  paging cookie with the page's `$orderby` values and first and last keys. A one-to-many `$expand` passes one
  FetchExpression in RelatedEntitiesQuery and its rows in RelatedEntities.
- The MSCRM bypass headers appear as InputParameters (`BypassCustomPluginExecution` Boolean, the others as sent) at
  every stage, on parent frames and on asynchronous jobs.
- The request `tag` (SDK, SOAP, or the HTTP `tag` query parameter) reaches shared variables, is re-projected to its
  canonical value between steps and inherited by nested calls; an explicit tag on a nested SDK request fails with the
  duplicate-key fault. Concurrent requests and batch members have independent tag scopes.
- For synchronous operations OperationId equals RequestId; nested operations inherit both and OperationCreatedOn (whole
  seconds). A request a plug-in issues reports an empty `InitiatingUserAgent`.

**Targets.** A Create Target carries the submitted columns at PreValidation (plus `transactioncurrencyid` on money
tables); PreOperation adds audit, ownership, state and time-zone stamps, never `versionnumber`. A standard table's
Create shows its choice and two-option defaults from PreValidation. `exchangerate` and `<money>_base` first appear at
PostOperation of a write that sets money. An Update Target gains `modifiedon`, `modifiedby` and `modifiedonbehalfby`
after PreValidation. A Web API Update writing a text column as null or empty shows an empty string while the row stores
null. Create allocates its identity before PreValidation; an explicitly submitted primary-key Attribute that is still
empty after PreValidation fails with 400 `0x80040203` "Expected non-empty Guid.". A Create reusing an existing key runs
PreValidation and PreOperation, then answers 412 `0x80040237`. A caller without the table privilege gets 403
`0x80040220`: Create after its PreValidation steps, Retrieve and RetrieveMultiple after PreOperation, Update and Delete
before any step.

**Images.** Registered aliases and selected columns; pre and post images from the row before and after the operation
(Assign and SetStateDynamicEntity included). Context4 image collections fill per stage in execution order; PostOperation
starts from the final PreOperation pre images plus, on Update, the platform's `PreBusinessEntity` image (the base
attributes of the table's published duplicate-detection rules, minus Target columns). Asynchronous steps receive
`AsynchronousStepPrimaryName` (primary name and key). Image attributes follow the stored row's column order. Decimal
values carry their storage scale; references carry no resolved names.

**Formatted values.** Images label booleans, choices (`; Red; Blue; ` for multi-select), named references, money (record
currency symbol at column precision), decimals, numbers and dates (ISO text in the calling user's time zone, from
`usersettings.timezonecode`, else UTC). A Create Target carries them from PreOperation; an Update Target only when the
request entered as UpdateMultiple or UpsertMultiple. Native recordings came from one UTC en-US user; other time zones
and cultures are local models.

**Values.** `multiselectpicklist` columns use `OptionSetValueCollection`; Float/Double columns stay `System.Double`;
lookups with exactly one target table become `EntityReference` (a raw GUID with several targets fails with
`LocalPluginSdkUnsupported`). Money, Decimal and Int64 travel as exact strings. Byte arrays, SDK arrays,
`EntityReference.KeyAttributes`/`RowVersion`, `AliasedValue`, query types, `ParameterCollection`, string-keyed
dictionaries and `OrganizationRequest`/`Response` keep their SDK types; unknown classes fail explicitly.
`mapping.sdkRowVersionColumn` exposes a source row version as `Entity.RowVersion`. Ambiguous duplicate tuples fail with
`LocalPluginValueAmbiguous`; accessor or prototype edits of JavaScript invocation state fail with
`LocalPluginStateMutationUnsupported`.

**Portal context.** An explicit trusted portal transport supplies `IsPortalsClientCall` and `PortalsContactId` from the
active local Contact; nested SDK operations clear both. Evidence-qualified `context.interfaceVersion: 7` supplies
environment id, tenant id, application-user status and user-agent presence.

## SDK calls from plug-ins

`IServiceProvider` supplies the execution context, tracing, `IOrganizationServiceFactory`,
`IServiceEndpointNotificationService` (posts the RemoteExecutionContext to a loopback web hook), `ILogger`
(`PLUGIN_CLR_TELEMETRY`, not the trace log), `IFeatureControlService` and `IManagedIdentityService` (cannot acquire a
token locally); any other service type is null.

`CreateOrganizationService(userId)` runs as that user: `null` is SYSTEM, `Guid.Empty` the step's `UserId`, another id
that system user (a missing user faults `0x80040217`). That user is `UserId` and `InitiatingUserId` of the nested
contexts and their jobs. Calls are authorized by the user's security roles like Web API calls (a missing privilege is
`0x80040220`; SYSTEM is not checked). On a store without a Dataverse security model the descriptor's `serviceProfile`
(and `sdkCallerProfiles` for other users) grants access instead.

`IOrganizationService.Execute` takes the SDK's request classes and a generic `OrganizationRequest`; a typed request
answers its typed response class (`WhoAmIResponse`), a generic one the base `OrganizationResponse`. Supported:

- Record, platform and custom API messages; WhoAmI; RetrieveVersion; the metadata reads (RetrieveEntity,
  RetrieveAttribute, RetrieveAllEntities, RetrieveRelationship, RetrieveOptionSet, RetrieveAllOptionSets).
- ExecuteTransaction (all or nothing, `ExecuteTransactionFault.FaultedRequestIndex`; requests run at the caller's depth
  in its transaction) and ExecuteMultiple (per-item faults, `ContinueOnError`, `ReturnResponses`; each request is a new
  root operation two levels below the caller with its own CorrelationId). Writes stay in the caller's savepoint.
- Update and Delete honour `ConcurrencyBehavior` (`0x80060882` stale `RowVersion`, `0x80060883` without one); Create
  carries `RelatedEntities` as a deep insert; Retrieve answers `RelatedEntitiesQuery`.
- `UnMaskedData` on Retrieve and RetrieveMultiple, under the Web API's `CanReadUnmasked` rule.
- Web API actions and functions with a synchronous handler.

Faults: a missing row is `0x80040217` ("Entity '<table>' With Id = <id> Does Not Exist"), an undeclared column
`0x80041103`; organization failures arrive as `FaultException<OrganizationServiceFault>` with the Web API's code for the
same failure. `NotSupportedException` (`LocalPluginSdkUnsupported`) marks a local gap, never a native fault:
asynchronous handlers, metadata writes, RetrieveMetadataChanges with a query, `SubQueryExpression`,
`AttributeExpressions`, `ForceSeek`, multidimensional arrays and non-SDK value types. A nil Retrieve ColumnSet fails
with the argument fault; a nil QueryExpression ColumnSet selects only the primary key.

**Record pipeline.** SDK Create, Update, Delete and Retrieve (and the flow Dataverse connector) run the organization
record pipeline: state defaults, synchronous record hooks (business rules, computed-column refusal, currency, state
transitions, duplicate detection, column security, rollup marking, cascade), audit columns, row version and the
alternate-key answer (412 `0x80060892`); reads apply the read projection. A pre-operation hook that answers a promise
(an async-only Power Fx adapter, attachment bytes routed to a storage provider) refuses the call with 501
`SdkAsyncPreOperationUnsupported` naming its module, before anything is stored. A virtual table without a provider
refuses the SDK write with 501 `VirtualProviderMissing`; one with a provider needs its synchronous operations (see
[virtual providers](dataverse-contract-modules.md#virtual-providers)). A post-operation hook that returns a promise
finishes after the call returns, outside its savepoint; a failure records `SDK_DEFERRED_EFFECT`.
`profile.pipeline.level` reports `behaviour` for writes and reads and `contract` for asynchronous hook effects;
without an organization on the store the service writes directly and reports `inventory`.

## Asynchronous steps and system jobs

Each accepted asynchronous run is written as a Ready `asyncoperation` (System Event, `operationtype` 1) inside the
transaction that commits the triggering write, so a rolled-back write leaves no job. One runner per store runs Ready
jobs in table order on the organization scheduler (the next turn by default; `runDue()`/`advance(ms)` on a manual
scheduler). A run claims the job (Locked), then records Completed/Succeeded (30) or Completed/Failed (31) with
`message`, `friendlymessage` and `errorcode`; a succeeded job is removed when its step has `asyncautodelete`. With the
Dataverse API off the job row is only the queue entry and is removed when the run ends.

- **Start delay.** A job waits the Dataverse API setting
  [`asyncStartDelayMs`](dataverse-api.md#enable-it) (default 1000 ms, the floor of the 0 to 6 s native pickup) before it
  may start, so a follow-up write sent right after the response still reaches it; `postponeuntil` stays null.
- **Cancellation.** Deleting a row cancels every waiting job regarding it inside the deleting transaction (3/32,
  `friendlymessage` "This system job was canceled because a referenced record was deleted."). A job whose step was
  deleted ends Failed (`0x8004418b`, `message` "Could not find plugin step description."); one whose step was disabled
  is Canceled (`friendlymessage` "Skipping Async Operation ... is in disabled state"). A job cancelled (statecode 3)
  before it starts does not run.
- **Failure.** A failed plug-in job has `errorcode` `0x80040265` (stored as -2147220891), the authored text as
  `friendlymessage` and the trace block (`Plugin Trace:` ... `Error Message:`) as `message`.
- **Retry.** `InvalidPluginExecutionException(OperationStatus.Retry, ...)` returns the job to Ready with a fresh
  invocation; a step that always asks for Retry executes five times and ends Failed with `retrycount` 4, as recorded
  natively. Retry delays are local scheduler turns, not the native back-off.
- **Context.** An asynchronous step sees the operation as it stood when PostOperation began (synchronous PostOperation
  edits do not reach it) and at most four parent frames, outside a transaction, without images. A request it issues is a
  new root operation of the originating request at the job's Depth + 1.
- **Limits.** Runs are never dropped: past each 100 queued runs a `PLUGIN_ASYNC_BACKLOG` diagnostic is recorded. Only
  the depth guard (`PLUGIN_ASYNC_LIMIT`, Depth 12) skips runs.
- **Restart.** Ready jobs live in the state file and resume when an organization starts on it (`backend.resume()`
  re-scans). A job left Locked by an interrupted process returns to Ready with `COMMITTED_JOB_RECOVERED`; this is
  at-least-once, so an external effect may repeat. `settleCommittedWork` (reload, stop, `backend.settle()`) waits for
  queued jobs and due scheduler tasks; with a manual scheduler it waits only for running work, and a job blocked on a
  not-yet-due task is finished by the `advance(ms)` that makes it due.
- **Classic workflows.** A background classic workflow run (mode 0 trigger) is a committed job of kind `workflow` with
  `operationtype` 10, run the same way ([workflows](dataverse-api.md#workflows)).

Web hook jobs are described under [webhooks](#webhooks). Cloud scheduling, service protection and worker recovery are
not reproduced.

## Webhooks

A step whose event handler is a service endpoint with contract 8 (Webhook) posts the `RemoteExecutionContext` JSON
with `x-ms-dynamics-organization`, `x-ms-dynamics-entity-name`, `x-ms-dynamics-request-name` and
`x-ms-correlation-request-id`. `authtype` WebhookKey (4) sends `?code=<value>`, HttpHeader (5) adds headers,
HttpQueryString (6) adds query parameters; `authvalue` is read as XML settings, JSON or key/value text. Above 256 KB,
`ParentContext`, `InputParameters`, `PreEntityImages` and `PostEntityImages` are removed and
`x-ms-dynamics-msg-size-exceeded` is sent. 502, 503 and 504 get one more attempt; each attempt times out after 60
seconds. Message inputs keep their typed shapes; unknown SDK value types fail with `LocalWebhookContextUnsupported`.

- **Loopback only.** Mirage contacts an endpoint only when its host is `localhost`, `*.localhost`, `127.0.0.0/8` or
  `::1` (the same rule as `TriggerServiceEndpointCheck` and the `odata.callback` check). A host name is resolved first
  and refused unless every address is loopback; redirects are refused. Any other URL, or a missing endpoint row, is
  never contacted and records `WEBHOOK_NOT_CONTACTED` (host only): a synchronous step lets the
  operation continue; an asynchronous step writes a Canceled job (32) "Simulator: endpoint not contacted (loopback
  webhooks only)". The platform's 80/443 port restriction is not applied.
- **Synchronous** steps wait for the endpoint inside the operation. 2xx lets it commit; anything else, or no answer,
  fails it with "Endpoint unavailable" (`0x80040265`) and rolls back. A request already sent cannot be recalled:
  `SERVICE_ENDPOINT_SENT_BEFORE_ROLLBACK` or `SERVICE_ENDPOINT_SEND_INDETERMINATE` records it. SDK calls from plug-ins
  post through the synchronous I/O bridge worker.
- **Asynchronous** steps post after commit; a non-2xx answer leaves a Failed job (31). The job stays Locked while its
  POST runs without holding back later jobs; if its row is gone when the answer arrives, `PLUGIN_ASYNC_JOB_MISSING` is
  recorded. Query failed jobs by `statuscode` 31 and `owningextensionid`.
- **Queues and topics.** Contracts 2, 5 and 6 go to the local message bus when `providers.messaging.endpoints` maps the
  endpoint, else fail with `SERVICE_ENDPOINT_UNMAPPED` ([messaging](messaging-and-outbox.md#service-endpoint-delivery)).
  Without a messaging provider, and for other contracts (Event Hub, ...), a synchronous step is skipped with
  `WEBHOOK_NOT_DELIVERED` and an asynchronous one is Canceled.
- A Solution step is a web hook step when its export names `ServiceEndpointId` or `EventHandlerTypeCode` 4618, or a bare
  `EventHandler` matching no plug-in type. The `serviceendpoint` row comes from organization data, such as a pack.
- `TriggerServiceEndpointCheck` probes a contract 8 endpoint only on loopback (204 for 2xx, no authentication sent); a
  mapped queue or topic answers 204 without sending; anything else answers 400.

## Uploaded assemblies run by default

A registered, enabled step whose type belongs to an assembly with uploaded `content` runs it in the CLR host without a
trust step (mode `clr`; pack handlers, web hooks and a `/_sim/` choice keep precedence), as the platform runs every
registered plug-in. A custom API main operation whose type is in such an assembly runs the same way. This is a local
contract: the host is the local CLR host described below, not the platform sandbox.

On first run Mirage writes the stored bytes, with the package's other `lib/` assemblies of the same target framework,
into an owned directory under the project's ignored `.paqvilo/plugin-assemblies`, and compiles the host there. Steps on
the same content share it; changed content is prepared again; a deleted step, assembly or package closes its runtime and
removes the directory. Only the stored bytes (with the package's assemblies) and the SDK are loaded, and every run
re-checks the prepared files' hashes.

`Microsoft.Xrm.Sdk.dll` is found through `PAQVILO_XRM_SDK` (a path; a missing file fails rather than falling back), then
the newest `microsoft.crmsdk.coreassemblies/<version>/lib/net462` in the NuGet packages folder (`NUGET_PACKAGES`, else
`~/.nuget/packages`), then the toolkit checkout's `.paqvilo/ci/sdk-reference/reference/lib/net462` (restored by
`npm run ci:prepare`). A `Microsoft.Crm.Sdk.Proxy.dll` beside it is supplied too. Microsoft assemblies are not
distributed with the toolkit.

The host is a small C# program. On Windows the .NET Framework 4 compiler builds it and it runs on the .NET Framework, as
Dataverse runs plug-ins. On macOS and Linux a [.NET SDK](https://dot.net) 10 or later builds it and it runs on .NET 10
or any later runtime: the original .NET Framework assembly and `Microsoft.Xrm.Sdk.dll` load unchanged. The SDK is found
through `DOTNET_ROOT`, `PATH` or its standard install folders; the first build restores the .NET 10 reference pack and
the WCF client (`System.ServiceModel.Primitives`) from NuGet, and later builds run offline. Every host runs in UTC with
the sandbox's en-US culture.

On modern .NET a plug-in that calls a .NET Framework-only API (`System.Web` serializers, `ConfigurationManager`,
`AppDomain` or remoting) fails with the missing type or method, and text formatted with a culture the plug-in creates
itself uses ICU data (for example a narrow no-break space before AM/PM). Run such plug-ins, and
[debugging](#debug-original-c-in-vs-code), on Windows.

When the assembly cannot run (no SDK, neither .NET Framework nor a .NET 10 SDK, host compilation failure, a type that
cannot load or construct) the step fails with 400 `0x80040224` naming the type and assembly (local wording), its
operation rolls back, and `PLUGIN_CLR_LOAD_FAILED` records the cause. Choose mock or disabled in `/_sim/` to run without
the CLR host.

## Original assembly registration

For an exported step without uploaded bytes, register its exact step id in a trusted external data pack's
`pluginRuntimes`:

| Field                                 | Meaning                                                                                                                                                               |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trust: 'execute-local-assembly'`     | Required opt-in                                                                                                                                                       |
| `root`, `assembly`, `typeName`        | Absolute trusted root, relative DLL path, exact type name                                                                                                             |
| `dependencies`                        | Further relative DLL paths under `root` (at most 100)                                                                                                                 |
| `sdkRoot`, `sdkAssembly`, `cacheRoot` | Externally installed SDK (absolute root, relative DLL) and the absolute snapshot cache                                                                                |
| `timeoutMs`                           | Positive integer; values above the 2-minute default are capped and values below 100 ms are raised to 100                                                              |
| `serviceProfile`                      | Execution-user GUID, evidence and table/operation grants (no portal roles or administrator access)                                                                    |
| `context`                             | Evidence-qualified initiating-user, organization and business-unit GUIDs; optional `executionUserId`, `interfaceVersion` (4 or 7), `operationCreatedOn` with evidence |
| `sdkCallerProfiles`                   | Grants for other `CreateOrganizationService` users on a store without a security model                                                                                |
| `defaultMode`                         | `clr` or `placeholder`                                                                                                                                                |
| `persistentHost`                      | `false` for a fresh host per execution                                                                                                                                |
| `symbols`, `debug`                    | See [debugging](#debug-original-c-in-vs-code)                                                                                                                         |

A custom API main operation uses a descriptor keyed by the exact `customapiid`, with a `typeName` matching its exported
type; its stage-30 OwningExtension comes from the exported internal step, or `context.mainOperationStepId` with
`mainOperationStepEvidence`. Descriptor runtimes are prepared at start and again on every write to a `customapi`,
`plugintype`, `pluginassembly` or `sdkmessageprocessingstep` row. Without a descriptor, an uploaded main operation's
OwningExtension is the exported internal step when there is exactly one, else a local id derived from the custom API id
named "CustomApi '<name>' implementation". A caught fault from a main operation aborts the calling plug-in's transaction
(400 `0x8009000c` after it returns).

### CLR host

- One long-lived host per runtime (all descriptors naming the same files, or one uploaded content), shared by its types,
  steps, messages and depths, so assembly static state survives between executions, as recorded natively. Each
  execution gets its own thread, plug-in instance, configuration and context; a nested Execute enters the same process.
  A plug-in exception keeps the host; a timeout or crash closes it and fails every invocation in flight. A simulator
  closes its hosts on shutdown.
- A fresh host (`persistentHost: false`) is a new process per execution from the verified executable, with a
  per-execution copy of the assembly.
- The host runs in en-US and UTC, as recorded natively. The protocol is UTF-8. SDK, trace and context calls
  from threads the plug-in starts are served; a handle used after its invocation returned has expired.
- Preparation confines and hashes the assembly, SDK, host source and generated host, and re-checks them before every
  start and call. No SDK download runs at startup.
- Limits: Depth 12; the deadline (at most 2 minutes); a context over 116.85 MB (measured as the local JSON context)
  fails with 400 `0x80040216` (-2147220970) "Message size exceeded when sending context to Sandbox. Message size: <n>
  Mb". A host that exits mid-invocation fails it with
  `0x8004418d` SandboxWorkerNotAvailable; one that cannot start fails the call with 503 `LocalPluginHostUnavailable`.
  SDK call counts, trace lengths and protocol sizes are not limited; console output is discarded.
- Ownership: a host binds only to the process that created it while it runs (409 `LocalPluginParentUnavailable`
  otherwise) and ends when its owning Node process ends, even abruptly (input pipe closed, kill-on-close job object).
- Trusted original code can access the local machine: this process isolation is **not an untrusted-code sandbox**.

### Bypass and business-logic ownership

SDK requests may set `BypassCustomPluginExecution` (boolean), `BypassBusinessLogicExecution` (`CustomSync`,
`CustomAsync`, or both) or `BypassBusinessLogicExecutionStepIds` (comma-separated step GUIDs); HTTP
[headers](dataverse-api.md#headers) and SOAP parameters behave the same. The run-as user needs `prvBypassCustomPlugins`
for the first and `prvBypassCustomBusinessLogic` for the others (System Administrator only); on a store without a
security model the profile lists them in `privileges` with evidence. `BypassCustomPluginExecution` and `CustomSync` skip
synchronous steps only; asynchronous steps still run. Choices apply to that operation; nested SDK operations need their
own. They do not grant row access or skip a custom API main operation. The step-id limit is three, or the export's
`OrgDbOrgSettings` `BypassBusinessLogicExecutionStepIdsLimit`.

Bypass keeps an extension classified as `system` or `microsoft` with evidence:
`observed.businessLogicOwnership[componentGuid] = { kind, evidence }` for a step, workflow or expression.
Customization level, namespaces and publisher names do not establish ownership; unclassified trusted adapters are
treated as custom and report `PLUGIN_BYPASS_OWNERSHIP_UNKNOWN`; the capability registry lists source step
classifications under `source-plugin-bypass-ownership`. The `ismanaged=true` plus `customizationlevel=0` edit
guard (`0x8004419a`) is a separate local contract and not ownership proof.

## Custom APIs and Dataverse Functions

- A custom API runs stages 10/20/40 around its main operation for HTTP and synchronous SDK callers alike. A named
  original main plug-in without a trusted or uploaded implementation fails explicitly; an API naming no implementation
  returns default outputs. A JavaScript main operation, provider or Power Fx adapter that answers a promise works for
  Web API and SOAP calls, but a synchronous SDK call from a plug-in refuses it with 501
  `SdkAsyncPreOperationUnsupported`.
- **Dataverse Functions.** A custom API whose `fxexpressionid` names an `fxexpression` row evaluates its expression with
  the core Power Fx engine ([Power Fx](canvas-apps.md#power-fx)); inputs are named values and the result record fills
  the response. It reads and writes tables (`Filter`, `LookUp`, `Collect`, `Patch`, `Remove`, `CountRows`, `Sort`) as
  the calling user, with privileges, row access and column security, as one unit: an error after a write leaves no row.
  An `Error(...)` or formula error answers 400 `0x80040265` with its message; a refused write (also inside `ForAll`)
  answers that refusal's envelope. Without the Power Fx engine both answer 501 `PowerFxEvaluatorMissing`.
- **Low-code plug-ins.** An `fxexpression` with a message and a table that no custom API names runs before the write as
  the calling user: `Set(ThisRecord.column, value)` or `Set(column, value)` changes any column of the row; a secured
  column the caller may not write refuses the write (403 `0x8004f502` on create, `0x8004f507` on update); `Error(...)`
  refuses it with its message.
- **Source layout.** `fxexpressions/<uniquename>/fxexpression.xml` (root `<fxexpression uniquename="...">` with
  `fxexpressionid`, `name`, `expression`, `context`, `parameters`, `messagename`, `entitylogicalname`, `statecode`
  children); `customapi.xml` names it with `<fxexpressionid>` as id text, a nested id, or a nested `<uniquename>`. An
  expression without an id gets a stable one from its unique name. Changing the folder refreshes the running simulator.
- **Delegation.** Formula table queries delegate to the store when every predicate is delegable: column comparisons
  (also through `Upper`, `Lower`, `Left`, `Mid`, `Replace` of a text column), `And`/`Or`/`Not`, `IsBlank`, `StartsWith`,
  `in`, `Sort`/`SortByColumns`, `First`, `LookUp`, `CountRows`, `CountIf`, and `Sum`/`Min`/`Max`/`Average` of a number
  column. `Now()`/`Today()` comparisons, currency columns and `Right`/`Substitute` are not delegated. Other predicates
  read the first 500 rows (`host.dataRowLimit`) and report `POWERFX_DELEGATION` naming the table, operation, limit and
  whether rows were cut.

## Trace log

Handlers and CLR runs write `plugintracelog` rows according to `organization.plugintracelogsetting` (0 off, 1
exceptions, 2 all). As recorded natively, `messageblock` joins trace lines with CRLF and keeps the last 10240
characters; `typename` is assembly-qualified; `configuration` and `secureconfiguration` are the step's; `requestid` is
the context's; `performanceconstructorduration` is 0; `exceptiondetails` is empty after success and names the
`OrganizationServiceFault` after an `InvalidPluginExecutionException`. Trace rows survive failed business transactions
and SDK savepoint rollbacks; nothing else does. If saving the trace also fails, both errors are reported in an
`AggregateError` whose cause is the business rejection. Trace cleanup is not modelled.

## Execution boundaries

| Area                    | Implemented locally                                                                                           | Limits                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Registration            | Solution discovery, mutable rows, packages, runtime custom API messages, native validation codes              | Standard tables without a recorded filter set use the custom-table template; secure configuration of imported steps is null               |
| Write and read pipeline | Stages 10/20/40, internal stages 25 and 50 where recorded, bulk lanes, named messages                         | Unexported platform handlers and unrecorded internal stages are absent; permission-query rewriting is a local model                       |
| Context                 | Typed inputs, outputs, shared variables, images, formatted values, complete ParentContext, Depth, correlation | Locally generated ids and timestamps differ; image attribute order follows the stored row; equal-rank order follows step id               |
| SDK                     | CRUD, reads, relationships, bulk, typed queries, ExecuteMultiple/Transaction, metadata reads, custom APIs     | Unsupported messages, query facets and value types fail with `LocalPluginSdkUnsupported`; fault codes without a capture use the Web API's |
| Asynchronous            | Durable committed jobs, retry, cancellation, restart recovery                                                 | No cloud scheduling, service protection or back-off timing; fixed start delay                                                             |
| Runtime                 | Original CLR on Windows .NET Framework or .NET 10+, uploaded content by default, debugging on Windows         | Not a security sandbox; flow Recurrence triggers run on the local scheduler ([operations](operations.md#execution-boundary))              |

A passing local pipeline does not prove native parity: native system logic absent from the export (currency validation,
server-side extensions) stays absent. Facts marked "as recorded natively" are `observation` evidence; only replay
cases built from two or more captures are `parity` ([test kinds](../../docs/test-kinds.md)). Private native evidence
stays in the owning project.

## Debug original C# in VS Code

Use Windows x64, the Microsoft **C#** extension (`ms-dotnettools.csharp`) and a Debug build with portable symbols
(`<DebugType>portable</DebugType>`); Microsoft's
[desktop CLR debugger](https://github.com/dotnet/vscode-csharp/blob/main/docs/debugger/Desktop-.NET-Framework.md) uses
`"type": "clr"` and requires portable PDBs. Extend the trusted descriptor for the exact exported step:

```js
{
  // Existing trust, root, assembly, SDK, identity and backend profile fields stay required.
  defaultMode: 'clr',
  assembly: 'bin/Debug/net462/Example.Plugins.dll',
  symbols: ['bin/Debug/net462/Example.Plugins.pdb'],
  debug: true,
}
```

`symbols` lists PDBs relative to the assembly's trusted root (dependencies may add theirs); `debug: true` requires the
assembly's PDB. They are snapshotted and hash-checked with the DLL on every execution. Descriptors naming the same files
share one symbol set and host.

1. Start Mirage with the project's `mirage dev` command. `defaultMode: 'clr'` selects original execution for that step
   on every start, dry run included; a `/_sim/` choice still wins, and **Use source default** restores the descriptor's.
2. Set breakpoints (constructors included) and trigger the operation. The terminal prints the owned
   `paqvilo-plugin-host.exe` PID; the host waits for a managed debugger before constructing the plug-in. Its command
   line ends with `--label <project folder>@<runtime port>`.
3. Run the launch configuration `<Project>: Mirage plug-in: attach .NET Framework` (generated by
   `paqvilo init`, or `paqvilo init --refresh-editor` in an existing project) and pick that PID.
4. Inspect locals, `InputParameters`, images, `SharedVariables` and outputs. SDK requests still pass through the
   organization pipeline; the request stays pending while paused.
5. To rebuild, stop Mirage, build, start again and attach to the new PID. A changed DLL or PDB is refused by a prepared
   runtime, so stale bytes never run.

Debug mode gives the invocation a 30-minute deadline instead of the 2-minute one, so turn it off for timing and parity
checks. All identity, privilege, transaction, integrity, depth and ownership checks stay on. Closing Mirage ends a host
waiting for the debugger.

### Daily edit, build and debug loop

Point the descriptor's `root`, `assembly` and `symbols` at your project's Debug output; Mirage snapshots those bytes at
start, so no deployment, profiler capture or manual copying is needed. Then for each change:

1. Edit and save the C# source.
2. Stop the dev task (Ctrl+C) and any remaining runtime with `paqvilo mirage stop --project ./mirage.project.yml`, then
   `dotnet build ./plugins/Example.Plugins.csproj -c Debug`. Stop if the build fails.
3. Run `mirage dev` again, trigger the operation and attach to the new PID.
4. Break in the changed code, continue and check the result in the app or API.

Put stop, build and dev in one npm script joined with `&&` so a failed build cannot start stale output; editor refresh
generates tasks for project npm scripts. Hot reload is not supported.

Microsoft's [Plug-in
Profiler](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/tutorial-debug-plug-in) replays a
captured remote context instead; a local breakpoint debugs the loaded assembly but does not prove native pipeline
parity.

## Configure source facts

PAC can export an SDK message id without its name. Create, Update, Delete, Retrieve and RetrieveMultiple ids are
platform constants; for other messages add `observed.sdkMessages` entries with the exact id, name and evidence. Mirage
does not guess a message from a step label. Map an exported type name to C# source with `observed.pluginSources`, in the
site's `mirage.observed` (catalogue) or the portal's `observed` (project manifest):

```yaml
observed:
  evidence: Plugin sources and SDK message names verified for this project.
  pluginSources:
    Vendor.Plugins.CustomerRules:
      path: components/Plugins/CustomerRules.cs
      evidence: Type declaration matches the exported PluginType name.
```

Each `path` resolves inside the entry's trusted `root`. Without `root` it is the catalogue's `sourceRoot` (catalogue)
or the project file's folder (project); a relative `root` resolves against the same folder, and `mirage init` writes
the catalogue's roots relative to the generated project file. The path must be a relative regular `.cs` file of at most
1 MiB, without `.`, `..`, `bin`, `obj`, `node_modules`, `.git` or `.paqvilo` segments; an unresolved mapping reports
`PLUGIN_SOURCE_UNRESOLVED`.

## Model a write

A mock response body changes submitted values during stage 10 or 20, or rejects the write:

```json
{ "target": { "displayname": "Normalized value" } }
```

```json
{ "error": { "message": "The supplied value is invalid." } }
```

Project packs register `pluginSteps` handlers by exact step id, or `pluginTypes` handlers by type name (see
[project extensions](../../docs/project-extensions.md)). A synchronous handler receives `step`, `entity`, `operation`,
`stage`, `target`, `record`, `previous`, `preImage`, `postImage`, `identity`, `changedAttributes`, `sharedVariables`,
`context`, `trace(text)` and `reject(message)`, and returns `{ target: {...} }` to patch. Context records are clones;
`sharedVariables` is the operation's live collection, seen by later JavaScript and CLR steps. A handler that returns a
promise, or a result the pipeline cannot use, fails the write and rolls it back like the handler's own exception: 400
`0x80040224` for a step-id handler, `0x80040265` for a plug-in type handler. A promise answers "Plugin handlers must
return synchronously." (`LocalPluginAsyncHandler` for local callers). Stage 40 patches reach later steps but not the
saved row; Delete patches are refused. Completed or timed-out handler continuations cannot touch the store again.

On a Power Pages basic form a `reject(message)` or `InvalidPluginExecutionException` shows the plug-in message only when
`Site/EnableCustomPluginError` is `true` ([forms and lists](forms-lists-parity.md)). The
[demo plug-in project](../../examples/project/components/DataversePlugins/README.md) has C# sources, exported
registrations and matching local models; compare a model with authorized live execution through
[project tests](data-packs.md).

## Read query registration

An explicitly unfiltered synchronous `RetrieveMultiple` step (an exported empty filter, explicit `none`, or a project's
native null-filter witness) observes every supported queried table, with the actual table as `PrimaryEntityName`.
Missing and unresolved filters stay unsupported. Null-filter steps on Create, bulk messages and asynchronous
RetrieveMultiple use the affected table and record.

- SDK QueryExpression paging and count controls keep the authored QueryBase in every stage. Totals are computed only
  when `PagingInfo.ReturnTotalRecordCount` is set; otherwise `-1`. Fetch `count`/`countcolumn` aliases are Int32.
- Internal SDK FetchExpression stays FetchExpression, and QueryExpression keeps its typed LinkEntity tree. Portal Fetch
  reads apply the modelled permission compiler before observers. Linked execution uses the local FetchXML evaluator with
  typed `AliasedValue` results.
- A trusted PreOperation reducer may remove redundant generated permission joins while keeping their bindings; the
  runtime then re-derives join privileges. Authored join removal, new joins and retargeted bindings need their own
  adapter.
- `context.operationCreatedOn` (canonical UTC, up to seven fractional digits, with `operationCreatedOnEvidence`) sets a
  replay's framework operation time; otherwise the runtime clock is used.

## Local registration comparison

```js
import { comparePluginRegistrations, parsePluginDocument } from 'paqvilo/mirage/fixtures';

const report = comparePluginRegistrations(parsePluginDocument(beforeXml), parsePluginDocument(afterXml));
```

Pass two inventories: `importSolutionPlugins(selectedLayers)` results, or `parsePluginDocument(xml)` results for single
exports (both exported from the same entry). The report lists `added`, `removed`, `changed` (with per-field `before` and
`after`), `unchanged` counts, `diagnostics` and `complete`. Stable GUIDs identify assemblies, types and steps; added,
removed and changed facts include execution mode, stage, rank, table, message, filtering attributes and image alias,
type, message property and attributes. Attribute order and GUID case are ignored. Duplicate or missing identities are
diagnostics with `complete: false`; nothing is matched by friendly name. Configuration, secure configuration and
assembly content are never copied into the result. This compares exported definitions, not deployed organizations.
