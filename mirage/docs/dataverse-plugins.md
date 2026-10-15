# Dataverse plugin registrations

Mirage discovers plugin assemblies, types and steps from selected Solution sources. **Operations** shows their table, SDK message, stage, execution order, mode and filtering attributes. **Inspect** links applicable steps to exported metadata and explicitly mapped C# sources. Lense uses the same inventory; exported registrations do not prove which steps are active online.

Choose a local execution mode for each discovered enabled step. Original CLR execution loads the original `IPlugin` assembly in an owned Windows .NET Framework process. It requires an explicitly trusted project descriptor, an externally installed Microsoft Xrm SDK assembly and a separate backend identity/security profile. Export discovery alone never enables a DLL. Missing CLR prerequisites do not prevent using mocks or disabled choices.

| Mode | Local behavior |
| --- | --- |
| Placeholder | CRUD continues; `PLUGIN_STEP_PLACEHOLDER` reports skipped business logic |
| JSON mock | Return a target patch or reject the write |
| Project handler | Run a trusted, explicitly registered synchronous JavaScript model |
| Original CLR | Execute the exact registered original type with the supported local SDK adapter |
| Disabled | Skip this step deliberately and record the choice |

Source mode 1 stage 40 Create/Update/Delete steps use a bounded post-save queue. Their failure is recorded separately and cannot reject the committed caller. Unsupported source contracts remain visible; explicit mock/disabled choices are still selectable. Original execution of an unsupported contract fails diagnostically. Select **Use source default** to remove a local override.

Mocks can replace a supported read query/result or bulk Targets through Operations, using the same typed local contracts as project handlers. The admin endpoint checks result shape, source table and execution stage before saving. An eligible explicit mock still applies its configured result when the original registration needs an unavailable image or identity adapter; diagnostics state that original logic was not executed. Unknown messages/stages do not gain an execution pipeline through a mock choice.

## Original assembly registration

Register exact exported step IDs in a trusted external data pack's `pluginRuntimes`. A descriptor contains `trust: 'execute-local-assembly'`, `root`, relative `assembly`, exact `typeName`, `sdkRoot`, relative `sdkAssembly`, `cacheRoot`, `serviceProfile` and `context`. Context requires evidence-qualified initiating-user, organisation and business-unit GUIDs. The profile requires an explicit execution-user GUID, evidence and table/operation grants; it does not inherit portal roles or administrator access. A null SDK service-factory caller requires an explicit local system-factory choice. Arbitrary impersonation is unsupported.

CLR preparation verifies confined regular files and hashes the original assembly, SDK, host source and generated host. No SDK download runs on portal startup. Workers cap protocol bytes, recursion, SDK calls, time and traces, and terminate only their owned host. Trusted original code can access the local machine; this process isolation is **not an untrusted-code sandbox**. Microsoft assemblies remain external to the toolkit distribution. Windows CI runs an actual compiled invented plugin against a pinned external SDK package; protocol-only tests do not substitute for DLL execution.

An explicit descriptor `persistentHost: true` reuses at most 32 owned hosts by prepared runtime, type and recursion depth. Each invocation constructs a fresh plugin instance, configuration and context; assembly static state remains process-local. Source and execution bytes are checked on every call, and deadlines, protocol bounds and SDK authorization still apply. A failed invocation closes its host. Campaigns call `closeClrHostPool()` in `finally`; a simulator closes its own pooled runtimes on shutdown. Default descriptors continue to use fresh hosts. Host reuse is a performance choice, not native evidence.

## Execution and evidence boundaries

| Contract | Implemented local boundary | Remaining qualification |
| --- | --- | --- |
| Write pipeline | Create/Update/Delete stages 10, 20, 40; rank and submitted-column filters | Native actor, registration and business-source proof |
| Read pipeline | Synchronous Retrieve and RetrieveMultiple stages 10/20/40; typed query/input/output observers and serialized backend recording writes | Exact proprietary native permission-query transformation remains separately qualified |
| Context | Typed input/output/shared state, selected images, live nested ParentContext, correlation/depth, explicit portal transport Contact and Context2 flags | SDK properties outside the declared proxy contract fail explicitly |
| SDK | CRUD, Retrieve/RetrieveMultiple, typed linked Fetch/QE, nested joins/aliases and explicit per-table row grants; named Execute responses for these messages | Advanced filters, full-text queries, unknown request parameters and other SDK messages fail explicitly |
| Relationships | Associate/Disassociate SDK calls and named responses; exact imported schema/partner direction; endpoint, proposed-row and intersect-edge backend grants | Native source/context proof; ambiguous self-reference without source EntityRole metadata and parameter replacement remain gaps |
| Standard bulk | Explicit source-evidenced CreateMultiple/UpdateMultiple; typed Targets, Context4 aligned images, filtering, shared state, typed IDs and per-record exception details; atomic caller rollback | Native merged single/multiple ordering, elastic tables and other bulk messages remain required work; mixed registrations are rejected before writes |
| Values | Money/Decimal and Int64 wire strings, exact typed numeric column storage/reload, option collections, references, aliases, GUIDs and dates | Exact numeric storage requires source column types/bounds/precision; recurring aggregate precision and native wire qualification remain open |
| Mode 1 | Post-save stage 40 CRUD; separate completed SDK requests persist after later job failure | Dataverse async service scheduling, retry and native context proof |
| Lifecycle | Shared bounded plugin/flow chains, consumer isolation and coordinated drain/stop | Recurrence, arbitrary external work and durable cloud-service scheduling are not implemented |

System output parameters are populated once at the main-operation boundary, before PostOperation; Create does not expose its system `id` in PreValidation or PreOperation. Custom values survive ranked CLR steps, and an intervening project read handler updates the current Retrieve or RetrieveMultiple result without discarding custom outputs. Final synchronous output values reach the SDK caller's named response `Results`, including replaced Create `id`, CreateMultiple `Ids`, removed keys and supported typed custom values. Direct Create uses the installed SDK's missing-`id` default (`Guid.Empty`); a mistyped named output retains its raw value and the SDK getter throws its own type error. These are local documented-contract regressions with actual compiled invented DLLs, not native fixture qualification. See Microsoft's [execution context reference](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/understand-the-data-context).

For synchronous Create, Update and Delete, later CLR stages access PreValidation shared variables through `ParentContext.SharedVariables`. PreOperation and PostOperation share their own collection; nested SDK requests retain the incoming ancestor context and request depth. A later operation on a saved row starts a fresh frame. Original invented DLL regressions cover these documented contracts; native context comparison remains separate. `RetrieveExchangeRate` has no local message adapter.

The private response handoff is synchronous and scoped to one exact store, message, table and opaque SDK invocation token. Nested SDK requests have separate frames; bare project/flow operations, cascade children and later asynchronous work cannot overwrite the initiating SDK caller's results. Captures clone final values and are removed after success or failure. This is a correctness mechanism for trusted local code, not an untrusted-code isolation boundary. DataStore and flow row/bulk return shapes remain unchanged; no native WebAPI response-envelope behavior is inferred. Retrieve/RetrieveMultiple context keys `BusinessEntity`/`BusinessEntityCollection` are mapped to the installed SDK response keys `Entity`/`EntityCollection`. Conflicting context/SDK aliases require an explicit adapter and fail diagnostically. Unsupported SDK messages, unsupported value types and changed read identities retain their existing explicit limitations. See Microsoft's [SDK message reference](https://learn.microsoft.com/en-gb/power-apps/developer/data-platform/org-service/use-messages).

A default `InvalidPluginExecutionException` from the supplied Microsoft SDK carries a CLR source HRESULT. Mirage preserves that raw value in `sourceException.errorCode` and maps the default `0x80131500` to the Dataverse `IsvAborted` fault code `0x80040265` for HTTP inner errors and nested SDK faults. Explicit nondefault codes remain unchanged. Actual invented DLL HTTP tests cover the default, explicit custom code, unchanged unrelated exception behavior and a nested `FaultException<OrganizationServiceFault>` caller. This does not establish equality between the direct Dataverse HTTP envelope and the Power Pages portal wrapper, or qualify other native exception shapes. See Microsoft's [plugin exception guidance](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/best-practices/business-logic/use-invalidpluginexecutionexception-plugin-workflow-activities).

Imported `multiselectpicklist` columns use `OptionSetValueCollection` in Targets, entity images and SDK reads. Stored arrays or comma-separated strings retain their selected option integers; SDK writes accept source-typed Int32 option arrays and validate declared options before mutation. Untyped arrays remain unsupported deep writes. Original DLL tests cover Target/image typing and SDK Update/reload; native precision, formatting and query comparisons remain separate. See Microsoft's [choices column reference](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/multi-select-picklist).

Source-declared Float/Double columns retain `System.Double` for fractional and integral values in Targets, images, SDK reads and typed aliases. Original CLR writes, shared variables and output values carry an explicit finite Double wire value so that an integral Double does not become an Int32 on the next step. Nonfinite values fail explicitly. Actual invented DLL casts qualify these local contracts; native aggregate precision and overflow responses still require separate comparison.

Local OData-to-SDK query construction is a limited local adapter. It is not evidence of the proprietary Power Pages permission-query transformation. Internal SDK FetchExpression input remains FetchExpression; QueryExpression retains its typed nested LinkEntity/criteria/columns tree. Portal Fetch reads apply the modeled permission compiler before observers; the supported scalar portal OData adapter exposes modeled expanded FetchExpression, with its transport qualification recorded separately. Supported linked execution internally uses the local FetchXML evaluator, with typed AliasedValue results and Entity.Id independent of selected Attributes. Unsupported advanced shapes fail instead of returning altered SDK types. Invented original-DLL tests prove these local contracts separately from authorised native capture.

Bulk execution also requires `serviceProfile.bulkTables` entries with an exact logical `entity`, `tableType: 'standard'`, nonempty `evidence` and explicit `messages` (`CreateMultiple`, `UpdateMultiple`). This project assertion must come from captured table/message metadata; it is never inferred from a table name. CLR bulk handlers can replace the pre-operation Targets attribute collections while preserving table/count/existing identities. PostOperation changes are not persisted. Association parameters remain immutable in the local adapter. The [bulk plugin reference](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/write-plugin-multiple-operation) documents Targets, Context4 images and submitted-column filtering; the [relationship SDK reference](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/org-service/entity-operations-associate-disassociate) distinguishes relationship schema names from navigation properties. These documented contracts and invented DLL tests do not establish native business-source equality.

## Configure source facts

PAC can export an SDK message ID without its name. The Create, Update, Delete, Retrieve and RetrieveMultiple ids are platform constants Mirage knows; for other messages supply `observed.sdkMessages` entries with the exact ID, name and evidence from your environment. Mirage does not guess the operation from a step label.

To connect a supplied C# project, map an exact exported type name through `observed.pluginSources`:

Use the site's `mirage.observed` block in a Lense catalogue, or that portal's `observed` block in a Mirage project manifest.

```yaml
observed:
  evidence: Plugin sources and SDK message names verified for this project.
  pluginSources:
    Vendor.Plugins.CustomerRules:
      path: components/Plugins/CustomerRules.cs
      evidence: Type declaration matches the exported PluginType name.
```

Catalogue paths resolve from `sourceRoot`; project-file paths resolve from that project directory. Mappings must point to regular `.cs` files within the trusted root. Exported assembly and type metadata remain available when source code is absent.

## Model a write

A mock response body can change submitted values during stage 10 or 20:

```json
{"target":{"displayname":"Normalized value"}}
```

To test rejection, use:

```json
{"error":{"message":"The supplied value is invalid."}}
```

Project packs register `pluginSteps` handlers by exact step ID. A synchronous handler receives `step`, `entity`, `operation`, `stage`, `target`, `record`, `previous`, `identity`, `changedAttributes` and `reject(message)`. Return `{target:{...}}` to apply a patch. Context records are cloned; editing them alone does not change the store. Async handlers are rejected. Stage 40 and Delete handlers cannot patch the target.

Local Create, Update and Delete run supported synchronous stages in stage/rank/ID order. Update filtering checks submitted columns, including unchanged values. Authorisation precedes the local pipeline. Top-level PreValidation SDK writes commit independently and remain saved after a later caller rejection; nested PreValidation and stages 20/40 participate in their caller's transaction. Each asynchronous SDK request is independent. These boundaries are tested with original invented DLLs; source-qualified native comparison remains a separate obligation. See Microsoft's [event framework](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/event-framework), [database transactions](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/scalable-customization-design/database-transactions) and [registration reference](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/register-plug-in).

The [demo plugin project](../../examples/project/components/DataversePlugins/README.md) includes C# sources, eight exported registrations and matching local models. Use [project tests](data-packs.md) to compare your model with authorized live execution.

Source-declared lookup GUIDs are supplied to original CLR plugins as SDK `EntityReference` values when the exported lookup metadata names exactly one target table. This applies to Targets, images and SDK retrieval, including a source-defined self-referencing relationship. Explicit typed references retain their logical table; a raw GUID with missing or multiple lookup targets fails with `LocalPluginSdkUnsupported` instead of selecting a table. Compiled invented DLL regressions cover lookup casts and named association responses. See Microsoft's [EntityReference contract](https://learn.microsoft.com/en-us/dotnet/api/microsoft.xrm.sdk.entityreference?view=dataverse-sdk-latest) and [lookup target metadata](https://learn.microsoft.com/en-us/dotnet/api/microsoft.xrm.sdk.metadata.lookupattributemetadata.targets?view=dataverse-sdk-latest).

Original local CLR shared values preserve byte arrays, explicitly modeled primitive and SDK arrays (including null entries and jagged string arrays), `EntityReference.KeyAttributes`/`RowVersion`, and `EntityCollection.EntityName`/`MinActiveRowVersion`/`TotalRecordCountLimitExceeded`. The installed SDK known-type catalogue and compiled typed readers guide these codecs. Unknown array contracts fail explicitly; metadata/label SDK contracts and request/response collection support remain separate work. Preserving reference metadata does not implement alternate-key backend CRUD.

Supported named SDK requests accept the optional `tag` string (bounded to 8 KiB locally). The tag reaches original CLR shared variables, survives PreValidation parent separation and inherits through nested shortcut service calls. Descendant replacement and plugin mutation fail before a changed tag is propagated; owned request state is restored on failure. Original-DLL regressions exercise `DeleteRequest.Parameters["tag"]`, all three Delete stages and a nested Create. Native fault HRESULTs for prohibited tag changes and portal Web API optional-tag transport require separate qualification.

Configured read mocks can include the optional result metadata above. Pure mock or handler read steps preserve typed results for direct and named original SDK callers, while ordinary reads keep their existing projections. Actual loopback admin regressions also verify that choosing mock or disabled for an original plugin prevents its dependency calls and launches no additional CLR host. These controls do not predict arbitrary external network behavior.

## Read recording and portal contexts

HTTP and Liquid read providers enter a serialized `DataStore.readOperation()` boundary before invoking local read plugins. Pure reads preserve the state revision and file; synchronous SDK recording writes use explicit backend grants, save successfully completed requests and publish their committed events. A top-level read is outside a database transaction at stages 10, 20 and 40, so a later observer or query rejection retains earlier independently completed SDK writes. A read called from a transactional CRUD plugin inherits that transaction. Direct synchronous reads without a serialized request boundary continue to reject original SDK writes. These contracts follow recorded lab context patterns and invented original DLL regressions; durable collector or arbitrary hosted pipeline parity is not implied.

An explicit trusted portal transport option supplies `IsPortalsClientCall` and `PortalsContactId` from the active local Contact. User roles alone do not set these properties. Nested SDK operations clear both properties while retaining the live parent context and correlation. Each local request frame supplies a stable generated RequestId and empty SecondaryEntityName for the supported single-table CRUD/read messages. Local GUIDs and timestamps are local provenance rather than copies of native platform values. Microsoft's [Context2 reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.xrm.sdk.ipluginexecutioncontext2?view=dataverse-sdk-latest) describes these portal properties.

An original runtime descriptor may explicitly list `sdkCallerProfiles` for known SDK factory callers. Each identity requires its own evidence and table/operation grants. A nested SDK pipeline uses that requested execution identity, preserves the initiating ancestor identity and restores the previous frame after completion; unknown callers still fail. An exported run-as step can independently bind `context.executionUserId`. This does not infer Dataverse impersonation privileges from portal roles.

Evidence-qualified `context.interfaceVersion: 7` supplies environment ID, tenant ID, application-user status and user-agent presence, with a local placeholder for the withheld user-agent value. Nonbulk Context4 image collections preserve empty collections or a single registered image set. Explicit portal input observations support `AppModuleId`, `IsAppModuleContext` and `IncludeAnnotations`; an observed empty Fetch paging-cookie convention can also be selected. Default descriptors keep Context4 and do not invent those observed properties. Native `SecondaryEntityName` can be supplied as a context observation.

An explicit mapping `sdkRowVersionColumn` preserves a source integral row version independently of selected SDK Attributes. The original CLR transport retains `Entity.RowVersion` in both directions. Native snapshot replay can supply actual version metadata from a read-only projection or ETag evidence. Local CRUD does not predict the organisation-wide native version sequence or claim native optimistic-concurrency execution.

Fetch aggregate `count` and `countcolumn` aliases carry Int32 values independently of the original column type. Grouped lookup names and choice labels use declared primary-name metadata, source target rows and option labels; missing metadata does not produce an invented name. Supported groupby lookup aliases include the native companion name attribute and formatted values. Culture-sensitive numeric, date and currency display contracts still require their source settings and separate qualification.
# Read query registration and provider metadata

An explicitly unfiltered synchronous `RetrieveMultiple` step can observe every
supported queried table. An exported empty SDK filter or explicit `none` binding,
or a project's exact native null-filter witness, establishes this scope. Missing
and unresolved filters remain unsupported. The execution context retains the
actual queried table as `PrimaryEntityName`; scope is never substituted into
runtime context. Registration acceptance does not establish that a particular
platform table invokes custom processing. Native callbacks on one supported
table do not qualify tables which emitted no callback evidence.

SDK QueryExpression paging/count controls retain the authored QueryBase in every
observer stage. The execution adapter requests totals only when the caller sets
`PagingInfo.ReturnTotalRecordCount`; pure SDK Fetch without an explicit total
count request returns `-1`. Provider EntityCollections carry the actual root
logical name and the source-qualified default minimum active row version `-1`.
Plugin-created collections keep their SDK constructor defaults. Explicit minimum
active row version requests require a qualified provider, and fail diagnostically
otherwise. Counts over the configured maximum preserve the limit-exceeded flag;
native count-limit campaigns remain a separate qualification gate.

Trusted replay descriptors may set `context.operationCreatedOn` with a canonical
UTC timestamp (up to seven fractional digits) and bounded
`operationCreatedOnEvidence`. This is recorded framework request-envelope
metadata, not an expected query/data result. An existing frame timestamp wins;
otherwise the explicit timestamp is preserved without rounding .NET ticks. The
runtime uses its clock when no timestamp is supplied. This supports independent
historical checks of source plugins that compare their immutable intent time to
the framework operation time.

Fresh and pooled CLR hosts bind the owning Node process PID and actual .NET
process birth time. A background host watcher terminates that host when its
exact owner exits, including an abrupt process kill while plugin code loops
without returning. Reusing a PID with a different birth time cannot keep the
host alive. Ordinary cleanup still closes owned hosts and verifies their absence;
interrupted proof attempts remain incomplete and are rerun from their journals.
