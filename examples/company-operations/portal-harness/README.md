# Company Operations permission harness

One visible `/permission-lab/` page and an internal `/permission-lab/liquid/` endpoint on an enhanced-model Power Pages
site. As the signed-in Contact, the page runs the same FetchXML through Liquid and the portal Web API, optionally runs
prepared CRUD and plug-in profiles, and saves every observation as history in Dataverse. The
[harness design](../../../docs/design/power-pages-permission-test-harness.md) explains the contracts.

Every business read and write uses the authenticated portal session. The application connection only deploys website
components and reads metadata; it never supplies business results to the browser. Deploy the
[permission graph](../portal-security/README.md) first.

## Prepare and deploy

```sh
node portal-harness/compile.mjs                                               # offline
node portal-harness/deploy.mjs --config .paqvilo/portal-harness/deploy-config.json   # writes to the live site
```

Run from `examples/company-operations`.

- `compile.mjs` builds the query plans and escaped Liquid partials from the stress catalogue (base catalogue if absent)
  into `.paqvilo/portal-harness/generated/` and prints the case count, template count and manifest hash.
- `deploy.mjs` writes native `powerpagecomponents` through the saved application connection; run it only against a
  site you are authorized to change. Its JSON config:

  | Key                                    | Meaning                                                                                                      |
  | -------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
  | `connection`                           | Private Dataverse connection file.                                                                           |
  | `website`, `role`, `home`, `published` | GUIDs of the verified website, the `CO Test Runner` role, the root page and the publishing state (required). |
  | `language`                             | Optional website language.                                                                                   |
  | `resolvedIds`, `readiness`             | Live IDs and dependency readiness flags merged into the manifest.                                            |
  | `overlayFile`, `personaRoleOverrides`  | Private tester overlay (`portal-security/tester-overlay.mjs`) and per-persona web-role lists.                |
  | `artifactTransportBudgetBytes`         | Stored-artifact budget per run, default 20 MiB including encoding and a 2 KiB allowance per part.            |
  | `odataPositiveVariants`                | Extra OData positive-control variants.                                                                       |

  It resolves navigation properties and field allowlists from live metadata, refuses ambiguous duplicate settings, keeps
  existing setting IDs, journals changes and reads every component back. Solution packaging belongs to
  `portal-security/package.mjs`.

Generated manifests, resolved GUIDs, deployment configs, rollback content and observations stay under
`.paqvilo/portal-harness/`.

## What a run does

- **Reads.** 36 cases (R30 has inner and outer variants, so 37 paired observations) plus OData variants of R01, R03,
  R05, R09, R12, R23, R24 and R33. Each physical request first creates its own `pqvd_testoperation`, reads back the
  server-stamped marker values and saves its authored intent, then calls Liquid or `/_api`. Liquid returns a typed,
  escaped XML envelope with the authored XML and the permission-rewritten `visibility_query.xml`; the Web API lane
  records effective XML as not exposed. Rows, IDs, counts and duplicate multiplicities are compared canonically.
- **Paging.** Deterministic order, at most 20 pages. A full last page without more-records metadata needs an extra
  empty-page proof; repeated tuples across pages mark the result incomplete. OData variants need an advertised count
  that matches the complete response.
- **Oracle.** Expected visibility comes from the intended permission graph per persona across the 21 business and
  reference tables plus the authored collision scenarios, labelled separately from observed results. Administrator SDK
  results are never used as a persona oracle.
- **CRUD.** Recorder probe CRUD always; with the guards installed, isolated A/B canary name changes with verification and
  restoration on 18 tables, and disposable Stock-equipment Create/Read/Delete with scoped Account and Room bindings.
  Projections, principals, lifecycle fields, standard currencies and baseline records stay protected. Other Create and
  Delete cases report Blocked until their dependencies exist. An unexpectedly accepted write fails the assertion and is
  restored; failed cleanup keeps residual IDs and restoration payloads.
- **Plug-in profiles and S01.** Plug-in profiles and the S01 query-budget cases (0 to 16 authored self joins) run from
  the same page. The 15/16 boundary and permission-expanded join counts are observations, not a joins-per-role formula.
  Transactional plug-in captures can roll back and cannot give complete durable coverage.
- **Async evidence.** P10 keeps its probe until operation-scoped async evidence arrives and is stable across reads, for
  at most 120 seconds; longer queues are recorded as timeouts.
- **Large filters.** Non-aggregate fixture filters whose encoded FetchXML exceeds 3,500 characters are split into
  disjoint ID sets, run identically in both lanes and merged keeping multiplicity. Aggregate and distinct queries keep
  their shape.
- **Artifacts.** A versioned UTF-8 base64 envelope with original byte length and SHA-256, plus a checksum per stored part,
  so portal URL rewriting cannot alter captured bodies. Exceeding the transport budget records incomplete persistence
  before any oversized write.
- **History.** Own-run history with row additions, removals, field, outcome and error changes. Regression comparison
  requires the same actor, dataset, roles and manifest; anything else is diagnostic only.

## Reading results

Lane equality is not authorization correctness. Liquid has returned linked Finance data while direct Finance API access
was denied, and an inactive permission parent with active descendants returned foreign fixture data in both lanes. Only
the independent scenario oracle decides.

Permission changes reach the portal gradually: after a role change, queries can keep the earlier principal footprint
for a while. Treat a changed footprint as needing a cache-controlled capture: record the active graph, memberships,
source and data versions and cache-refresh evidence, and repeat until the footprint is stable.

Errors, sign-in pages and query-limit failures stay visible and never become empty arrays. An empty result, matching
lanes or a query-limit rejection alone never proves correct authorization.

## Tests

```sh
node --test portal-harness/test.mjs portal-harness/parity.test.mjs
node --test portal-harness/browser.test.mjs
```

Both use invented loopback data. The browser test checks typed XML parsing, escaping, canonical API parity, operation
intent, artifact persistence and incomplete backend status; it is not signed-in live qualification.

## Compare with Mirage

These read private files only and make no native requests.

- `node portal-harness/compare-parity.mjs <native-run.json> <mirage-run.json> [private-report.json]`: Compare a native and a Mirage run summary (report default `.paqvilo/portal-harness/mirage-parity.json`; exit code 1 unless equal). Actor, roles, dataset, manifest, source and configuration must match, and both runs must bind permission, membership and data snapshot hashes with `evidenceQualification` flags from independently verified readbacks. Rows compare as multisets; queries keep predicates, projections, ordering, joins and identity literals, normalizing only formatting and generated aliases.
- `node portal-harness/replay-parity.mjs <private-job.json>`: Replay saved authored pages through Mirage. The job names `schema`, `catalogue`, `manifest`, `nativeComponents` (an explicit native readback), `baselineOverlay`, `stressOverlay`, `snapshots` and `output`. Optional `variants` binds each run to `baseline`, `stress`, `safe-secondary-subtree-disabled` or `parent-only-disabled-negative-fault`; optional `observedProfiles` supplies evidenced site behaviour per variant (the inactive-parent fault needs `tablePermissionOrphans: "unrestricted"`).
- `node portal-harness/mirage-campaign-replay.mjs --job <private-job.json>`: Replay frozen native captures through the original exported CLR assemblies, the Mirage Web API handler and the frozen Liquid templates.
- `node portal-harness/mirage-replay-shards.mjs --job <private-job.json> --workers <1..10>`: The same replay across up to ten Node processes, each with its own state, SDK cache, CLR host pool and receipts; the parent verifies every child result before writing the aggregate receipt.

Jobs, overlays, native sources, captures and outputs contain Contact, query and recording data: keep them under
`.paqvilo/`.

### Campaign replay jobs

A schema-version 1 job for `mirage-campaign-replay.mjs` declares absolute `outputRoot`, `cacheRoot`, `exportRoot`,
`sdkAssembly`, optional `proxyAssembly`, nonempty `selectedStepIds` and `expectedAssemblyHashes` by assembly name.
`inputs` and each `cells[].inputs` are `{ file: <absolute path>, sha256 }`. Required inputs: `schema`, `catalogue`,
`observed`, `serviceProfiles`, `assemblyReceipt`, `snapshotBefore`, `snapshotAfter`, `capture`, `registrationBefore`,
`registrationAfter`, `siteBefore` and `siteAfter`; `overlay` is optional; cell inputs override common ones.

- Assembly receipts need matching installed and exported hashes with `allMatch: true`; build-only receipts are not
  enough. Backendless cells also need a frozen `context` input. Service profiles are explicit local backend grants.
- The worker derives the signed-in identity from the frozen Contact, account, same-site memberships and default roles,
  and requires stable native data, versions, memberships, graph, registration and site source receipts. It fingerprints
  the toolkit and project runtime source around every cell, archives the exact input and source bytes, saves immutable
  per-attempt results and resumes only after checking their hashes. A changed source or job needs a new output
  directory. Concurrent workers are refused; after a crash, confirm the old process exited before removing its
  `worker.lock`. `retryUnqualified: true` retries completed diagnostic cells.
- For ongoing collection, omit `cells` and set an absolute `cellsDirectory` and `expectedCells` (at most 4096). Add one
  immutable cell file per frozen capture; changing or removing an existing one is rejected.
- Role-campaign jobs add `roleCampaign` (`domainHash`, `actorId`, `siteId`, `campaignDirectory`, `auxiliaryRoleIds`) and
  common `domain`, `blueprint` and `manifest` inputs; each cell is `id: "m<mask>"`. `exhaustiveRoleCoverageQualified`
  requires all 4096 role subsets with complete, verified page sets.
- Captures without `recordingInputs` (pre-query Run and operation readbacks) report
  `recordingInputWitness.verified: false`.

Replay covers physical reads, recorded plug-in artifacts and context, and query-template and API wire results. It does
not cover authentication, full-page dispatcher execution, browser JavaScript, anonymous CRUD or unrecorded backend
fault codes (`allRuntimeFaultCodesQualified` stays false for them).

## Native role campaign

```sh
node portal-harness/native-campaign.mjs <private-campaign.json>
```

Changes the live Contact's web roles: it collects a resumable campaign over subsets of the twelve business roles with
the existing authenticated Contact, clearing both portal caches on each change. Authorized environments only.

- The config sets `allowNativeRoleMutation: true`, `campaignDir`, `maxMasksPerBatch` (4096 runs the full lattice),
  `schema`, `siteId`, `contactId`, the deployment, connection and browser inputs, `nativeRegistration`,
  `assemblyReceipt` and the five `witnesses` returned by `campaignFrozenWitnesses`. Before changing memberships the
  runner verifies permissions, data, row versions, the complete website source, the registration graph and assembly
  bytes against that freeze.
- Memberships outside the twelve business roles are preserved; the original set and both caches are restored on exit.
  An interrupted lease is reconciled before collection resumes; unknown drift fails closed.
- `workerLock` is one shared absolute lock file named `<site-guid>-<contact-guid>.native-campaign.lock.json` (lowercase
  GUIDs). It is never stolen; after a crash, confirm the process is dead and reconcile its journal before removing it.
  An optional absolute `stopFile` requests a stop after the current role mask.
- `continuationPolicy` must be `per-page` (default); `mask-window` is rejected.
- Collected cells still need exact Mirage replay and stable native principal-path and cache proof before they count as
  parity.

## Other modules

- `query-drop-probes.mjs` prepares templates that use a FetchXML tag with no property access, `.xml` only,
  `.results` only and both, for admitted and limit-failing queries.
- `metadata-envelope.mjs` reads `RetrieveTimestamp()` and bounded `RetrieveMetadataChanges` through a supplied Dataverse
  client (`readNativeMetadataEnvelope`), and the portal's cached `@Microsoft.Dynamics.CRM.globalmetadataversion`
  through a primary-key-only control read on an actor-owned TestRun (`readPortalMetadataEnvelope`). Bracket a measured
  cohort with both and call `compareMetadataEnvelopeWindow`; only a stable, ordered window with the same source and
  actor qualifies the cohort's observed cache version.
- `query-budget-probes.mjs` declares the separate query-admission discriminator domain described in the
  [harness design](../../../docs/design/power-pages-permission-test-harness.md#separate-query-admission-qualification).

## References

[Liquid FetchXML](https://learn.microsoft.com/en-us/power-pages/configure/liquid/template-tags),
[portal API reads](https://learn.microsoft.com/en-us/power-pages/configure/read-operations),
[writes](https://learn.microsoft.com/en-us/power-pages/configure/write-update-delete-operations),
[Web API field configuration](https://learn.microsoft.com/en-us/power-pages/configure/web-api-overview),
[RetrieveTimestamp](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/retrievetimestamp),
[RetrieveMetadataChanges](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/retrievemetadatachanges).
