# Company Operations portal permission harness

The harness creates one visible `/permission-lab/` page and an internal `/permission-lab/liquid/` endpoint in a confirmed enhanced-model Power Pages website. It uses the authenticated portal session for every business read and write. The application connection provisions website components and qualifies metadata; it never supplies browser business-query results.

Run `node portal-harness/compile.mjs` from this project to prepare the shared plans and escaped Liquid partials. Generated manifests/templates, resolved reference GUIDs, deployment configurations, rollback content and observations stay under ignored `.paqvilo/portal-harness/`. The generator consumes the stress catalogue when available, and supports a private overlay for an actual signed-in tester without storing that person's identity in the public fixture catalogue.

`node portal-harness/deploy.mjs --config .paqvilo/portal-harness/deploy-config.json` deploys native `powerpagecomponents` using the saved application connection. The configuration must identify a verified website, CO Test Runner role, home page, publishing state and optional language. It resolves lookup navigation properties and field allowlists against live metadata, refuses ambiguous duplicate settings, preserves existing setting IDs, journals changes and reads all components back. Portal solution membership and export are handled by the companion security toolkit.

The normal suite contains 36 cases with separate inner/outer R30 variants, giving 37 paired observations. Eight native OData variants are recorded independently. Each physical request creates its own operation, reads the server-stamped UTC/GUID markers, saves its authored intent, then calls Liquid or `/_api`. The marker guard preserves null names. Liquid emits a typed, escaped XML envelope containing authored XML and `visibility_query.xml`; the API records effective XML as unavailable. The browser compares complete canonical rows, IDs, counts and duplicate multiplicities, and stores summary/query/raw/canonical artifacts in checksummed parts.

Number paging uses deterministic order and a 20-page bound. A full terminal page without more-record metadata requires an additional empty-page proof. Cross-page repeated tuples mark results incomplete. Native OData variants require an advertised count matching the complete response; an unqualified continuation is recorded as incomplete. Errors, sign-in pages and query-limit failures remain visible and never become successful empty arrays.

The page supports own-run history selection and checksummed canonical diffs. Role/Contact snapshots are checked against every Liquid response. Full basic fixture visibility expectations cover each configured persona and the 21 business/reference tables; independent authored scenarios check selected collisions. These expectations are evaluations of the intended configuration graph, labelled separately from observed portal authorization. Administrator SDK fixture query results are not used as a persona oracle.

Prepared CRUD runs include disposable recorder probe CRUD. Qualified business scalar guards enable isolated A/B canary name changes, paired verification and restoration across 18 tables. Qualified stock-equipment guards enable disposable equipment creation, read and deletion with scoped Account/Room bindings. Scope projections, principals, lifecycle fields, standard currencies and baseline business records remain protected. Other Create/Delete cases are reported as blocked until disposable parent/singleton dependencies and maintained projections are qualified. Accepted unexpected writes fail the permission assertion and are restored; failed cleanup retains explicit residual IDs and restoration payloads.

The same page offers qualified plugin profiles and explicit S01 query-budget cases with 0 through 16 authored self joins. The 15/16 boundary and permission-expanded XML counts are observations, not assumptions about a fixed join-per-role formula. Transactional plugin captures are labelled rollback-vulnerable and cannot produce complete durable three-front coverage. Azure/flow and durable collector scenarios require their external dependencies.

Run `node --test portal-harness/test.mjs portal-harness/browser.test.mjs` for the project regressions. The browser regression uses invented loopback data and validates actual typed XML parsing, escaping, canonical API parity, operation intent, artifact persistence and honest incomplete backend status. It is separate from signed-in live qualification.

The platform contracts are documented in Microsoft's [Liquid FetchXML reference](https://learn.microsoft.com/en-us/power-pages/configure/liquid/template-tags), [portal API read operations](https://learn.microsoft.com/en-us/power-pages/configure/read-operations), [write operations](https://learn.microsoft.com/en-us/power-pages/configure/write-update-delete-operations), and [Web API field configuration](https://learn.microsoft.com/en-us/power-pages/configure/web-api-overview).

Live qualification records successful paired reads through an eleven-join permission path, guarded stock-equipment Create/Read/Delete, recorder probe CRUD, and ABC/P02/P05 plugin profiles. Disposable equipment is tied to the actor's immutable TestRun; its additional own-run Delete permission does not grant ordinary IT asset deletion. Scalar A/B tests restore their original values, and every profile cleanup has a separately stamped Request/Response/Cleanup observation.

Two security findings remain recorded: linked Finance data returned by Liquid despite denied direct Finance API access, and a deliberately inactive permission parent with active descendants that returned foreign fixture data. Parity alone is therefore insufficient; independent fixture eligibility assertions remain mandatory. The latter configuration was restored immediately. Safe deep variants disable the entire secondary subtree with a bounded, journalled lease and verify every permission's restoration.

Large nonaggregate fixture filters are partitioned into disjoint ID sets to stay below the observed request-URL boundary; identical fragments run in both lanes and retain multiplicity. Aggregate and distinct queries keep their original shape. History reports exact row additions/removals/field changes alongside outcome, completeness and HTTP/platform error changes. Regression comparison requires the same actor, dataset, roles and manifest; cross-configuration comparison is currently a diagnostic limitation. The manifest also records the desired portable permission blueprint hash; native live readback is separate evidence.

Artifacts use a versioned UTF-8 base64 envelope with original byte length and SHA-256, plus a checksum for each stored part. This prevents the portal's embedded API URL rewriting from altering captured HTTP bodies. Readers still verify older plain artifacts exactly; historical checksum failures remain evidence. Deployment accepts `artifactTransportBudgetBytes` (default 20 MiB per run), including encoding overhead and a conservative 2 KiB metadata allowance per part. Exceeding it records incomplete persistence before oversized part writes. A combined client/server storage quota remains part of external collector qualification.

### Mirage evidence comparison

`node portal-harness/compare-parity.mjs <native-run.json> <mirage-run.json> [private-report.json]` compares recorded run summaries or the last summary in a captured `results` envelope. The actor, role set, dataset, manifest, source and configuration must match. Both summaries must bind `configuration.permissionSnapshotHash`, `membershipSnapshotHash` and `dataSnapshotHash`, with `evidenceQualification.nativeConfigurationVerified`, `nativeMembershipsVerified`, `nativeDataVerified` and `nativeCacheQualified` explicitly true. These assertions must come from independently verified readbacks and stable repeated server captures; the comparator cannot verify an assertion's origin. Backend artifacts require valid SHA-256, complete numbered parts and matching operation/span/stage bindings. Complete canonical rows are compared as multisets. Query comparisons retain predicates, projections, ordering, join direction/type, union hints and identity literals; formatting and generated alias names are normalized, and only full operation/time sentinel literals are substituted. Reports distinguish exact XML hashes from structural matches. Missing stages, failed/incomplete rows, changed configuration or unverified native configuration remain unqualified. A matching row count alone never establishes parity.

`node portal-harness/replay-parity.mjs <private-job.json>` replays saved authored physical pages through Mirage without making network requests. Its job contains `schema`, `catalogue`, `manifest`, `nativeComponents`, `baselineOverlay`, `stressOverlay`, `snapshots` and `output` file paths. `nativeComponents` is an explicitly supplied native `powerpagecomponents` readback, not browser discovery. An optional `variants` map binds each captured run GUID to `baseline`, `stress`, `safe-secondary-subtree-disabled` or `parent-only-disabled-negative-fault`. An optional `observedProfiles` map supplies separately evidenced site behavior for a variant; reproducing the inactive-parent fault requires an explicit `tablePermissionOrphans: "unrestricted"` profile. No filename-derived permission changes or automatic live writes occur. Keep the job, identity overlay, native source, captures and outputs under the project's ignored `.paqvilo/` directory.

The historical corpus currently contains 45 recorded runs, 117 paired cases and seven observed subsets of the twelve business roles, out of 4,096 possible subsets. These records do not contain authoritative contemporaneous permission and data snapshots for every run. Their reconstructed replay is diagnostic, even when a query structure or row multiset matches. Offline enumeration of subsets is a separate modeled check and cannot fill native coverage gaps. The coverage ledger always reports these gaps; observing every subset would still leave other permission graphs, actors, data states, CRUD rights, query shapes and plugin configurations unqualified.

The stress sequence also records different expanded principal footprints after role changes: two displayed business roles initially produced the preceding one-role query path, and the eight-role zero-authored-join case initially produced the preceding four-role footprint before later requests expanded further. This is consistent with a permission cache lag, but the captures do not prove its cause. The report marks such footprint changes as requiring a cache-controlled native capture. Requalification must record the exact active permission graph, memberships, source/data versions and cache refresh evidence together, then repeat the query until the server-side principal footprint is stable. Do not fit a fixed join-per-role formula to the historical counts.

`node portal-harness/native-campaign.mjs <private-campaign.json>` collects a resumable native role campaign. The private job explicitly enables `allowNativeRoleMutation`, identifies `campaignDir`, `maxMasksPerBatch` (4096 runs the full lattice), `schema`, the normal deployment/connection/browser inputs, `nativeRegistration`, `assemblyReceipt`, and all five `witnesses` returned by `campaignFrozenWitnesses`. Before changing memberships, the runner verifies the actual permission/data/row-version snapshot, complete website source, registration graph including disabled states, and assembly bytes against that freeze. Each invocation preserves memberships outside the twelve business roles and restores the original membership set and both portal caches on exit. After an interruption, the pending lease is reconciled before collection resumes; unknown drift fails closed.

Every job also requires one shared absolute `workerLock` across campaign directories, with filename `<lowercase-site-guid>-<lowercase-contact-guid>.native-campaign.lock.json`. The runner acquires it before recovery or live reads and never steals an existing lock. After a crash, verify that its recorded process is dead and reconcile the owning journal before explicitly removing the stale lock. An optional absolute `stopFile` requests recovery after the current complete role mask; it is retained until the coordinator removes the request. Recovery restores roles and both caches before the worker releases its lock.

Every measured operation retains its authored bytes, canonical native rows/outcome, role snapshot, final backend artifact hashes, source/snapshot hashes and immutable archive checksum in Dataverse history. Full plugin payloads and the before/after source witnesses also remain in a checksummed local gzip archive. Collection follows successful full pages to an observed terminator within the explicit twenty-page bound. Failed or partial attempts remain in history, without becoming completed masks. Collected cells still require exact Mirage replay, stable native principal-path/cache proof and supported backend observability; the runner reports collection separately from parity qualification. The original eight OData variants and the additional eight metadata-valid probes have separate IDs and denominator cells.

`query-drop-probes.mjs` prepares isolated templates for a FetchXML tag with no property access, `.xml` only, `.results` only and both, for admitted and limit-failing queries. The no-access and XML-only templates never dereference results implicitly. These are source-specific execution diagnostics, not a default core policy. Reference tables whose native RetrieveMultiple filters disallow custom plugin registration require a separately supported observation method; an absent observer is never credited as a captured empty backend query.
# Offline original-plugin campaign replay

`node portal-harness/mirage-campaign-replay.mjs --job <private job.json>` replays
frozen native captures through the original exported CLR assemblies, the actual
Mirage Web API handler and the frozen query Liquid templates. It makes no native
requests or mutations. Keep jobs and outputs under the project's ignored
`.paqvilo/`; they contain contact, query and recording data.

A schema-version 1 job declares absolute `outputRoot`, `cacheRoot`, `exportRoot`,
`sdkAssembly`, optional `proxyAssembly`, nonempty `selectedStepIds`, and
`expectedAssemblyHashes` keyed by assembly name. Its `inputs` and each unique
`cells[].inputs` contain `{file: <absolute path>, sha256: <actual file SHA256>}`.
Required inputs are `schema`, `catalogue`, `observed`, `serviceProfiles`,
`assemblyReceipt`, `snapshotBefore`, `snapshotAfter`, `capture`,
`registrationBefore`, `registrationAfter`, `siteBefore` and `siteAfter`;
`overlay` is optional. Cell inputs override common inputs. Native assembly
receipts require matching installed/exported hashes and `allMatch: true`;
build-only receipts are insufficient. Backendless cells also require an explicit
frozen Context7 `context` input. Service profiles are explicit local backend
grants, not a claim that native Dataverse privileges were fully audited.

The worker derives the signed-in identity from frozen Contact, account lookup,
same-site memberships and authenticated default role IDs. It requires stable
native data, versions, memberships, graph, registration and consumed site source
receipts. It fingerprints installed toolkit and project runtime source before
and after every cell, saves immutable per-attempt results, and resumes completed
results only after checking their hashes. Concurrent workers are refused. A
private content-addressed archive retains the exact explicit input bytes and
runtime source bytes (including the CLR bridge), with manifests in the ledger;
mutable source checkout paths are insufficient to reconstruct an older proof.
A changed source/job requires a new output directory. After an interrupted process,
inspect its private ledger and confirm the old process has exited before removing
its owned `worker.lock`; the interrupted cell is rerun. `retryUnqualified: true`
must be set in the initial job to retry completed diagnostic cells.

For an ongoing collector, omit `cells` and declare an absolute `cellsDirectory`
and `expectedCells` (at most 4096). Write one immutable JSON cell specification
per fully frozen native capture into that directory. Repeated worker invocations
consume new specifications and resume old ones under the same common job receipt;
changing/removing an existing specification is rejected. Partial collection never
sets the campaign summary's `allQualified` flag.

For CPU parallelism, run `node portal-harness/mirage-replay-shards.mjs --job
<private job.json> --workers 10`. This launches up to ten actual Node processes,
each with separate cell state, SDK cache, CLR host pool and receipt directory.
Cell IDs select a stable shard; subsequent invocations resume that same layout.
The parent archives its own runtime sources and verifies every immutable child
result, source/wire witness, process identity and coverage denominator before
writing an aggregate receipt. Cancellation stops owned workers; a failed worker
prevents aggregate qualification. These offline workers create no native login
sessions and make no native requests.

New native captures include `recordingInputs` with actual pre-query Run and
operation readbacks. Replay preserves their creator, platform fields and
RowVersions and validates each actor/root/lane/marker binding. Historical captures
without these inputs expose `recordingInputWitness.verified: false`; their narrower
query/context/wire proof does not retroactively prove recorder SDK-object inputs.

Exhaustive role jobs additionally declare `roleCampaign` with `domainHash`, exact
`actorId`/`siteId`, native `campaignDirectory` and the preserved auxiliary/default
`auxiliaryRoleIds`. Common immutable inputs include `domain`, `blueprint` and
`manifest`; each cell is `id: "m<mask>"` with that integer `mask`. A cell includes
its verified native history readback and every continuation in `nativePages` when
needed. Replay rebuilds the domain from frozen source definitions, derives the
mask from actual memberships, checks native campaign/history claims, and requires
each source fragment/lane/page exactly once through its terminal wire result.
Missing pages remain incomplete. Runs and operation IDs cannot repeat across role
cells. Resume and aggregate paths reread every SHA-pinned native/source input and
revalidate membership/page bindings. Generic jobs expose physical diagnostic scope
and never set `exhaustiveRoleCoverageQualified`; the role flag requires all 4096
distinct verified masks with complete qualified page sets.

Qualification covers physical reads, original recorded plugin artifacts/context,
and actual query-template/API wire results. It does not cover authentication,
dispatcher/full-page execution, browser JavaScript, anonymous CRUD or unrecorded
backend fault codes. Failed admitted Liquid queries can have exact observable
artifacts and wire failures while `allRuntimeFaultCodesQualified` remains false.
## Stable checkpoint (13 October 2026)

Native work is stopped at the user's request. The existing authenticated Contact
is the native runner; future runs update its web roles and clear both caches.
Parallel identities and process workers are local Mirage capabilities.

The current Source4 calibration replay qualifies 184 of 204 physical reads.
Twenty remain different: six stress Web API budget/URI cases and fourteen OData
admission failures. The first collected role subset qualifies 203 of 204 reads;
its outstanding metadata-envelope version needs an independent cohort receipt.
Two role subsets were collected, with all seven continuation pages for the
second. This does not establish exhaustive 4,096-subset or configuration coverage.
Full dispatcher/browser flow, native SDK projection defaults and unobserved
runtime faults remain outside the qualified scope.

Native memberships, both caches, the 235-step registry, authentication settings
and private site visibility were verified restored. Opening Microsoft's studio
added two unrelated default components; they were retained and documented in
ignored evidence. A future native source freeze must include them.

`native-mask-window.mjs` has tested archive/history and shared-boundary checks,
but is not connected to the native collector. `continuationPolicy: "mask-window"`
is rejected before collection; the supported collector uses fresh per-page
snapshots and cache checks. Source5 lookup tests remain opt-in and undeployed;
they require the declared variant-length upgrade and fresh native receipts.
Private source freezes, captures, ledgers and restoration receipts stay under
ignored `.paqvilo/`; they are excluded from the package.

## Independent metadata envelopes

`metadata-envelope.mjs` reads the official `RetrieveTimestamp()` and bounded
`RetrieveMetadataChanges` functions through an explicitly supplied Dataverse
client. It records current timestamps separately from the portal's cached
`@Microsoft.Dynamics.CRM.globalmetadataversion` value. A prefix match in one
environment does not prove that every portal cache uses the current timestamp.

Use `readPortalMetadataEnvelope` on an actual actor-owned, immutable TestRun
before and after a measured cohort. Supply the intended portal origin, frozen
role IDs and site, registration and dataset hashes. This control performs a
PK-only GET separate from the measured cases. Bracket those controls with
`readNativeMetadataEnvelope`, then call `compareMetadataEnvelopeWindow`.
Only a stable, ordered window with the same source and actor qualifies that
cohort's observed cache version. Retain the raw control responses independently;
historical cases cannot obtain a new source receipt retrospectively.

Microsoft documents the [metadata timestamp function](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/retrievetimestamp)
and [metadata changes function](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/retrievemetadatachanges).
