# Company Operations portal permission harness

One visible `/permission-lab/` page and an internal `/permission-lab/liquid/` endpoint, deployed to a confirmed
enhanced-model Power Pages website. The page runs the same queries through Liquid and the portal Web API as the signed-in
Contact, optionally runs prepared CRUD, and stores the results as history in Dataverse. The
[harness specification](../../../docs/design/power-pages-permission-test-harness.md) defines the cases and contracts.

Every business read and write uses the authenticated portal session. The application connection only provisions website
components and checks metadata; it never supplies business-query results to the browser.

## Prepare and deploy

```sh
node portal-harness/compile.mjs
node portal-harness/deploy.mjs --config .paqvilo/portal-harness/deploy-config.json
```

- `compile.mjs` prepares the shared query plans and escaped Liquid partials from the stress catalogue when available. A
  private overlay can bind an actual signed-in tester without storing that person in the public catalogue. Generated
  manifests and templates, resolved GUIDs, deployment configurations, rollback content and observations stay under ignored
  `.paqvilo/portal-harness/`.
- `deploy.mjs` writes native `powerpagecomponents` through the saved application connection. Its configuration names a
  verified website, the CO Test Runner role, the home page, the publishing state and an optional language. It resolves
  lookup navigation properties and field allowlists against live metadata, refuses ambiguous duplicate settings, keeps
  existing setting IDs, journals changes and reads every component back. Solution membership and export belong to the
  [security tools](../portal-security/README.md).
- `artifactTransportBudgetBytes` (default 20 MiB per run, including encoding overhead and a 2 KiB allowance per part)
  bounds stored artifacts; exceeding it records incomplete persistence before oversized writes.

## What a run does

- **Reads.** 36 cases (R30 has inner and outer variants, so 37 paired observations) plus eight native OData variants.
  Each physical request creates its own operation, reads back the server-stamped UTC and GUID markers, saves its authored
  intent, then calls Liquid or `/_api`. Liquid returns a typed, escaped XML envelope with the authored XML and
  `visibility_query.xml`; the Web API lane records effective XML as unavailable. The page compares complete canonical rows,
  IDs, counts and duplicate multiplicities.
- **Paging.** Deterministic order, at most 20 pages. A full last page without more-records metadata needs an extra
  empty-page proof; repeated tuples across pages mark the result incomplete. OData variants need an advertised count that
  matches the complete response.
- **Oracle.** Expected visibility comes from the intended permission graph for each configured persona across the 21
  business/reference tables, plus authored collision scenarios. It is labelled separately from observed results.
  Administrator SDK query results are never used as a persona oracle.
- **CRUD.** Recorder probe CRUD always; with the guards installed, isolated A/B canary name changes with verification and
  restoration across 18 tables, and disposable stock-equipment Create/Read/Delete with scoped Account/Room bindings. Scope
  projections, principals, lifecycle fields, standard currencies and baseline records stay protected. Other Create and
  Delete cases report Blocked until their dependencies exist. An unexpectedly accepted write fails the permission
  assertion and is restored; failed cleanup keeps residual IDs and restoration payloads.
- **Plugin profiles and S01.** Plugin profiles and S01 query-budget cases (0 to 16 authored self joins) run from the same
  page. The 15/16 boundary and permission-expanded join counts are observations, not a join-per-role formula.
  Transactional plugin captures are rollback-vulnerable and cannot give complete durable coverage.
- **Async evidence.** P10 keeps its probe until operation-scoped async evidence arrives and its packet set is stable across
  reads, for at most 120 seconds; longer queues are explicit timeouts.
- **Large filters.** Non-aggregate fixture filters above the request-URL boundary are split into disjoint ID sets, run
  identically in both lanes, keeping multiplicity. Aggregate and distinct queries keep their shape.
- **Artifacts.** A versioned UTF-8 base64 envelope with original byte length and SHA-256, plus a checksum per stored part,
  so portal URL rewriting cannot alter captured bodies.
- **History.** Own-run history with exact row additions, removals and field changes, outcome and error changes. Regression
  comparison requires the same actor, dataset, roles and manifest; comparing different configurations is diagnostic only.

## Reading results

Lane equality is not authorization correctness. Two configurations show why independent fixture-eligibility assertions are
mandatory: Liquid returned linked Finance data while direct Finance API access was denied, and an inactive permission
parent with active descendants returned foreign fixture data in both lanes. Deep variants therefore disable the whole
secondary subtree with a journalled, bounded lease and verify every permission's restoration.

Permission changes can take effect gradually on the portal: after role changes, queries can keep an earlier principal
footprint for a while. Treat a changed footprint as needing a cache-controlled capture: record the active permission graph,
memberships, source and data versions and cache refresh evidence, and repeat the query until the footprint is stable.

An empty result, matching lanes or a query-limit rejection alone never proves correct authorization. Errors, sign-in pages
and query-limit failures stay visible and never become empty arrays.

## Tests

```sh
node --test portal-harness/test.mjs portal-harness/browser.test.mjs
```

The browser regression uses invented loopback data and checks typed XML parsing, escaping, canonical API parity, operation
intent, artifact persistence and incomplete backend status. It is separate from signed-in live qualification.

## Compare with Mirage

| Command | Purpose |
| --- | --- |
| `node portal-harness/compare-parity.mjs <native-run.json> <mirage-run.json> [private-report.json]` | Compare a native and a Mirage run summary. Actor, roles, dataset, manifest, source and configuration must match, and both must bind permission, membership and data snapshot hashes with the `evidenceQualification` native flags set from independently verified readbacks. Rows compare as multisets; queries keep predicates, projections, ordering, joins and identity literals, normalizing only formatting and generated aliases. A matching row count alone never establishes parity. |
| `node portal-harness/replay-parity.mjs <private-job.json>` | Replay saved authored pages through Mirage without network requests. The job names `schema`, `catalogue`, `manifest`, `nativeComponents` (an explicit native readback), `baselineOverlay`, `stressOverlay`, `snapshots` and `output`. Optional `variants` binds each run to `baseline`, `stress`, `safe-secondary-subtree-disabled` or `parent-only-disabled-negative-fault`; optional `observedProfiles` supplies evidenced site behaviour per variant (the inactive-parent fault needs `tablePermissionOrphans: "unrestricted"`). |
| `node portal-harness/mirage-campaign-replay.mjs --job <private-job.json>` | Replay frozen native captures through the original exported CLR assemblies, the Mirage Web API handler and the frozen Liquid query templates. No native requests. |
| `node portal-harness/mirage-replay-shards.mjs --job <private-job.json> --workers 10` | The same replay split across up to ten Node processes, each with its own state, SDK cache, CLR host pool and receipts; the parent verifies every child result before writing an aggregate receipt. |

Keep jobs, overlays, native sources, captures and outputs under ignored `.paqvilo/`: they contain Contact, query and
recording data.

### Campaign replay jobs

A schema-version 1 job for `mirage-campaign-replay.mjs` declares absolute `outputRoot`, `cacheRoot`, `exportRoot`,
`sdkAssembly`, optional `proxyAssembly`, nonempty `selectedStepIds` and `expectedAssemblyHashes` by assembly name. `inputs`
and each `cells[].inputs` are `{ file: <absolute path>, sha256 }`. Required inputs: `schema`, `catalogue`, `observed`,
`serviceProfiles`, `assemblyReceipt`, `snapshotBefore`, `snapshotAfter`, `capture`, `registrationBefore`,
`registrationAfter`, `siteBefore` and `siteAfter`; `overlay` is optional; cell inputs override common ones.

- Assembly receipts need matching installed and exported hashes with `allMatch: true`; build-only receipts are not enough.
  Backendless cells also need a frozen `context` input. Service profiles are explicit local backend grants.
- The worker derives the signed-in identity from the frozen Contact, account, same-site memberships and default roles, and
  requires stable native data, versions, memberships, graph, registration and site source receipts. It fingerprints the
  toolkit and project runtime source around every cell, archives the exact input and source bytes, saves immutable
  per-attempt results and resumes only after checking their hashes. A changed source or job needs a new output directory.
  Concurrent workers are refused; after a crash, confirm the old process exited before removing its `worker.lock`.
  `retryUnqualified: true` in the initial job retries completed diagnostic cells.
- For ongoing collection, omit `cells` and set an absolute `cellsDirectory` and `expectedCells` (at most 4096). Add one
  immutable cell file per frozen capture; changing or removing an existing one is rejected.
- Role-campaign jobs add `roleCampaign` (`domainHash`, `actorId`, `siteId`, `campaignDirectory`, `auxiliaryRoleIds`) and
  common `domain`, `blueprint` and `manifest` inputs; each cell is `id: "m<mask>"`. `exhaustiveRoleCoverageQualified`
  requires all 4096 role subsets with complete, verified page sets.
- Captures without `recordingInputs` (pre-query Run and operation readbacks) report `recordingInputWitness.verified: false`.

Replay qualifies physical reads, recorded plugin artifacts and context, and query-template and API wire results. It does not
cover authentication, full-page dispatcher execution, browser JavaScript, anonymous CRUD or unrecorded backend fault codes
(`allRuntimeFaultCodesQualified` stays false for them).

## Native role campaign

`node portal-harness/native-campaign.mjs <private-campaign.json>` collects a resumable campaign over subsets of the twelve
business roles, using the existing authenticated Contact: each run changes its web roles and clears both portal caches.

- The job must set `allowNativeRoleMutation`, `campaignDir`, `maxMasksPerBatch` (4096 runs the full lattice), `schema`, the
  deployment, connection and browser inputs, `nativeRegistration`, `assemblyReceipt` and the five `witnesses` returned by
  `campaignFrozenWitnesses`. Before changing memberships the runner verifies permissions, data, row versions, the complete
  website source, the registration graph and assembly bytes against that freeze.
- Memberships outside the twelve business roles are preserved; the original set and both caches are restored on exit. An
  interrupted lease is reconciled before collection resumes; unknown drift fails closed.
- `workerLock` is one shared absolute lock file, named `<site-guid>-<contact-guid>.native-campaign.lock.json`
  (lowercase GUIDs). It is never stolen; after a crash, confirm the process is dead and reconcile its journal before
  removing it. An optional `stopFile` requests a stop after the current role mask.
- `continuationPolicy: "mask-window"` is rejected; collection uses fresh per-page snapshots and cache checks.
- Collection is reported separately from parity qualification: collected cells still need exact Mirage replay and stable
  native principal-path and cache proof.

## Other tools

- `query-drop-probes.mjs` prepares templates that use a FetchXML tag with no property access, `.xml` only, `.results` only
  and both, for admitted and limit-failing queries.
- `metadata-envelope.mjs` reads `RetrieveTimestamp()` and bounded `RetrieveMetadataChanges` through a supplied Dataverse
  client (`readNativeMetadataEnvelope`), and the portal's cached `@Microsoft.Dynamics.CRM.globalmetadataversion` through a
  PK-only control read on an actor-owned TestRun (`readPortalMetadataEnvelope`). Bracket a measured cohort with both and
  call `compareMetadataEnvelopeWindow`; only a stable, ordered window with the same source and actor qualifies the
  cohort's observed cache version.

## References

[Liquid FetchXML](https://learn.microsoft.com/en-us/power-pages/configure/liquid/template-tags),
[portal API reads](https://learn.microsoft.com/en-us/power-pages/configure/read-operations),
[writes](https://learn.microsoft.com/en-us/power-pages/configure/write-update-delete-operations),
[Web API field configuration](https://learn.microsoft.com/en-us/power-pages/configure/web-api-overview),
[RetrieveTimestamp](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/retrievetimestamp),
[RetrieveMetadataChanges](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/retrievemetadatachanges).
