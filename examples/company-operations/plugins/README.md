# Company Operations plug-in laboratory

Dataverse plug-ins, a collector and SDK tools that record what the platform does with Power Pages queries and SDK
pipelines: the query each stage receives, execution context, images and nested-call lineage. The
[plug-in design](../../../docs/design/dataverse-plugin-observation.md) owns the decisions; this page covers building,
installing and running it.

This is project code; nothing here enters `lense/` or `mirage/`. SDK and application tests do not establish Power Pages
Contact authorization: only the [portal harness](../portal-harness/README.md), signed in as the intended Contact, does.

## Contents

| Path                                             | What it is                                                                                                                                                                                            |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `QueryObservation/`, `PipelineTests/`, `Shared/` | Two strong-name signed .NET Framework 4.6.2 assemblies (incoming-query observer; pipeline chain, guards and recording) on pinned `Microsoft.CrmSdk.CoreAssemblies` 9.0.2.60 with committed lockfiles. |
| `LabPublicSigning.snk`                           | A deliberately public synthetic signing key; not a production certificate or federation credential.                                                                                                   |
| `registrations.json`                             | Generated step registry (231 steps in `PaqviloBehaviorPlugins`) and the `readiness` flags of external dependencies.                                                                                   |
| `secure-provisioning.json`                       | Symbolic secret references and safe version labels for secure step configuration; no secret values.                                                                                                   |
| `collector/`                                     | Collector and worker source, deployment contract and the flow-only secret contract.                                                                                                                   |
| `Tests/`, `test/`                                | .NET fixture checks and Node tests.                                                                                                                                                                   |
| `SdkProbes/`, `sdk-projection-probes.mjs`        | Read-only SDK projection and count controls.                                                                                                                                                          |
| `mirage-runtime.mjs`                             | Replays native captures against the original assemblies in Mirage.                                                                                                                                    |

Builds, environment-specific registrations, exported solutions and evidence stay under the project's ignored
`.paqvilo/`.

## Build and install

Provision the schema and load the catalogue first (see the [project guide](../README.md)): the exported plug-in solution
is an update package for that schema, not a first-install package. Every Node utility below except
`prepare-registration.mjs` connects to Dataverse; all take `--connection <file>` (default
`.paqvilo/dataverse/provisioning.connection.json` relative to the current directory) and check the saved organisation
first. Run from the toolkit checkout, against an environment you are authorized to change.

```powershell
dotnet build examples/company-operations/plugins/QueryObservation/QueryObservation.csproj -c Release -p:RestoreLockedMode=true
dotnet build examples/company-operations/plugins/PipelineTests/PipelineTests.csproj -c Release -p:RestoreLockedMode=true
node examples/company-operations/plugins/prepare-registration.mjs          # offline: regenerates registrations.json
node examples/company-operations/plugins/deploy.mjs                        # read-only plan
node examples/company-operations/plugins/deploy.mjs --apply                # registers assemblies, steps, images, config
node examples/company-operations/plugins/provision-owner-team.mjs          # security role and owner team for ChainNode Assign tests
node examples/company-operations/plugins/verify-live.mjs                   # runs SDK profiles, writes .paqvilo/plugins/qualification.json
node examples/company-operations/plugins/audit-installation.mjs            # local vs installed assembly hashes, .paqvilo/plugins/installation-audit.json
```

- Apply is resumable by stable component IDs and re-reads before creating anything.
- SDK message filters are discovered in the connected environment; a step is registered only where
  `iscustomprocessingstepallowed` is true. Unsupported combinations (for example Currency RetrieveMultiple or ChainNode
  Upsert filtered steps) are reported, not invented. Upsert is observed through its Create and Update pipelines.
- Images are registered only on supported message/stage pairs: Create uses the `Id` message property, Update and Delete
  use `Target`.
- After a local rebuild, `upload-assemblies.mjs` replaces the content of the existing assemblies.
  `update-guard-config.mjs` writes the registered chain-step IDs into the three ChainNode guards; a fresh install gets
  them from `deploy.mjs`.
- Secure step configuration is not carried by solution exports. The two synthetic secure-config secrets are generated
  in memory and written only to secure step configuration.
- Diagnostics: `inspect-trace.mjs [--enable]` (reads, or turns on, the organisation plug-in trace log),
  `inspect-operation-errors.mjs` (recent `OperationIntentGuard` exceptions), `inspect-metadata.mjs` (solution component
  types), `audit-evidence.mjs` (P02 event parts from the last `qualification.json`).

## Capture modes

`deploy.mjs` sets `captureMode` in the unsecure step configuration to `TransactionalLab`.

- `TraceOnly`: safe IDs and hashes in the plug-in trace log. No full queries; the platform caps and purges traces.
- `TransactionalLab`: complete payloads as immutable, Unicode-safe event parts with a full SHA-256; operation headers
  stay Partial with provenance `DataversePlugin.TransactionalLab.RollbackVulnerable`. Evidence written inside the
  request transaction rolls back with a failed request, and a recording write fault aborts the transaction rather than
  being swallowed.
- `DurableCollector`: each snapshot goes to an authenticated collector that stores it before acknowledging; an
  independent worker writes it to Dataverse. Needs the hosted collector, worker, storage and managed-identity
  federation, which this project does not deploy.

`registrations.json` `readiness` marks business projection maintenance, the durable collector, the flow secret, Azure
identity binding and the optional bulk and Merge profiles as not ready. Profiles that need them (P08 durable rollback,
P13 Azure, P14 flow secret) stay blocked until they exist.

The collector validates Entra v2 JWTs (roles, tenant, audience, issuer, writer identity), envelope identity and payload
SHA-256, and stores a private Blob receipt before answering 202. The plug-in has an 8-second transport budget per
operation; managed-identity token acquisition is synchronous and cannot be cancelled, so an overrun is measured and no
further request is made. Unmatched receipts are kept privately; the worker never guesses a Contact.

## What the guards enforce

Expect these refusals when a request breaks a rule:

- **Operation intent.** The server stamps the actor from the Run relationship, the GUID and the UTC markers. Portal
  Create accepts only the Liquid and Web API lanes with a Pending capture state. Portal Update may change only the
  authored query, hashes, client summary, Liquid XML and client finish time.
- **Query capture binding.** Portal-lane capture uses the platform portal flag and `PortalsContactId` when available: the
  Contact must match the intent's actor, otherwise capture is withheld and the query is left unchanged. Without that
  interface, capture requires permission-shaped Contact predicates that all agree with the actor, labelled observed
  query binding, not identity attestation. Markers correlate requests; they never authenticate.
- **SDK lane.** Requires a configured trusted caller and immutable SDK actor provenance; nested captures require the same
  operation and the exact registered chain-step lineage. Shared portal backend identities are not trusted SDK callers.
- **Evidence and projections.** Server events are writable only by configured recorder identities. All eight Access
  scope N:N relationships (`pqvd_access_*`) accept associations only from a trusted identity. Run and owner moves and
  cross-run result or probe bindings are rejected.
- **Business data.** No scope or lifecycle reconciler is installed, so only names, Contact first/last names,
  membership work contact details, equipment manufacturer/model/serial/condition, selected descriptions and the
  employment contract reference are mutable. Structural selectors, dates, financial fields, keys, lifecycle states and
  relationships stay maintenance-only.
- **Disposable equipment.** Create needs a name, kind and condition, a `CO-CANARY-` tag, Stock state, a room whose site
  owns the supplied Account, no current assignment and an existing `pqvd_canaryrunid` with an immutable Contact actor.
  Delete also checks Stock state and no current assignment. Ordinary equipment Delete is not granted.

## SDK chain behaviour

- The first request attaches one immutable `tag`; descendants inherit it. Setting a different tag on a descendant
  request makes Dataverse fail with a duplicate-key fault.
- Dataverse can replace caller contexts with internal ObjectModel contexts and drop caller variables, so ChainB seals its
  configured step ID into the server-owned node `configstatus` before B -> C. Internal Delete and ownership exceptions
  require that exact sealed step, the configured SDK application as initiating user and a same-operation ancestor.
- Execution Depth (a platform limit) is not table-permission depth. The depth profile runs only as an explicit
  scenario; failed-hop evidence is not durable in `TransactionalLab` mode.
- The query mutator is SDK-only and disabled by default.

## Optional contracts (off by default)

Each needs its own registration, assembly build and native qualification before its results count.

- `allowAnonymousObservation: true` with an `anonymousObservationTables` allowlist (intent guard and query observer):
  captures anonymous portal reads against an SDK-created intent, provenance `AnonymousPortal.ConfiguredSDKIntent`.
  Requires a root portal call with an empty `PortalsContactId`; the controller Contact is never treated as the request
  identity.
- `allowOwnedEvidenceDeletion: true` with exactly one `writerId`: root Delete of an archived `pqvd_pluginevent` by that
  SDK writer, bound by the tag `CO-OWNED-EVIDENCE-DELETE:<maintenance-intent-GUID>` to a maintenance intent at most 30
  minutes old that names the event GUID, original operation and full event hash. Archive and verify the event first.
- `allowOwnedEquipmentLookupTests: true` (Source5 only): Room rebind of a disposable Stock canary within its Building
  and Account, and Probe-to-Equipment binding within the same Run. Needs the Source5 schema
  (`pqvd_testoperation.pqvd_variant` at 128 characters).

## Replay in Mirage

`mirage-runtime.mjs` binds the original exported assemblies and exact registered step IDs to Mirage. Supply a fresh
native registration snapshot, installed and exported assembly hashes, a pinned external SDK, an owned cache directory and
explicit backend grant profiles. A hash mismatch or unresolved registration is rejected; nothing is downloaded.

- `applyNativeDataSnapshot` loads frozen native reads into the local store atomically.
- `replayNativeReadBatch` runs each authored FetchXML request through the original assemblies and compares raw incoming
  queries, SDK collections and stable context fields with the native capture. Optional `webApiPortal` and
  `liquidReplay` inputs also compare the Mirage Web API and Liquid outputs. A run qualifies only with `sourceWitness`
  readbacks proving that permissions, memberships, data, row versions, site components and registration match the
  snapshot.
- `validateFinalQueryObserverWitness` gates the final-query-only campaign on identical paired captures.
- `persistentHost: true` reuses the CLR process with a fresh plug-in instance per call; call `binding.close()` in
  `finally`.

Supplying an already expanded native query tests CLR execution only, not the permission compiler.

`planSdkProjectionProbes` and `executeSdkProjectionProbes` (with `SdkProbes/SdkProbes.csproj`) run 21 read-only SDK
projection and count controls through the sole native writer. The driver hash is verified, the token is passed over
stdin only, and the driver uses TLS 1.2.

## Local checks

From `examples/company-operations`:

```sh
npm run sdk:build
node --test plugins/test/*.test.mjs
```

From the toolkit checkout:

```powershell
dotnet build examples/company-operations/plugins/Tests/Tests.csproj -c Release -p:RestoreLockedMode=true
& examples/company-operations/plugins/Tests/bin/Release/net462/Tests.exe
```

These cover immutable intent, redaction, typed queries, inert observers, marker ambiguity, XML entity protection,
protected scope associations, receipt validation, worker envelope integrity and chunk reassembly. The collector tests
run the real worker against invented loopback identity, Blob and Dataverse gateways; they do not deploy or emulate
Azure, qualify managed identity or prove hosted durability.

## References

[Query types](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/best-practices/business-logic/implement-all-types-of-queries-when-filtering-preoperation-retrievemultiple),
[registration, images and secure configuration](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/register-plug-in),
[context and tag](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/understand-the-data-context),
[shared-variable tag](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/optional-parameters#add-a-shared-variable-to-the-plugin-execution-context),
[portal flag and Contact identity](https://learn.microsoft.com/en-us/dotnet/api/microsoft.xrm.sdk.ipluginexecutioncontext2?view=dataverse-sdk-latest),
[Custom API](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/custom-api),
[Depth](https://learn.microsoft.com/en-us/dotnet/api/microsoft.xrm.sdk.iexecutioncontext.depth),
[managed identity](https://learn.microsoft.com/en-us/power-platform/admin/set-up-managed-identity),
[flow-only secret action](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/retrieveenvironmentvariablesecretvalue),
[organization web proxy client](https://learn.microsoft.com/en-us/dotnet/api/microsoft.xrm.sdk.webserviceclient.organizationwebproxyclient?view=dataverse-sdk-latest).
