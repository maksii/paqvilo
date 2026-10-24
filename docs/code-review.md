# Dead-code and duplication review

Run `npm run review:code` after installing the locked development dependencies. It also runs
inside `npm run quality` and CI. Knip 6.43.0 reviews runtime and test-inclusive graphs;
jscpd 5.4.2 reviews runtime, tests and example/build support separately. CI never removes
code or refreshes the reviewed baseline.

`scripts/code-review.config.mjs` names commands, supported public APIs, browser URLs and
independently spawned workers. URL aliases mirror the asset routers. Package wildcard paths
are implementation details under [the public API contract](public-api.md). Knip normally
promotes wildcard package targets to entries, hiding orphan modules. The adapter analyzes a
temporary source snapshot whose manifest omits those wildcard keys. Named APIs and dependency
resolution remain intact. It never changes the real manifest, executes inspected runtime code
or copies private `.paqvilo` evidence.

Named and wildcard reexports from supported API entries are followed statically to their
canonical declarations; public names remain preserved. The API contract test independently
checks package imports. Runtime-only findings include exported test seams consumed by the
full unit/browser/SDK graph. Three fake-service/fixture modules under `mirage/testing` also
have test consumers and intentionally have no product caller.

`scripts/code-review-baseline.json` records reviewed dispositions. Clone keys contain the file
pair and normalized fragment digest, so line shifts do not create noise. Occurrences are
counted: another copy of an accepted fragment still fails. New files, exports, unresolved
imports and clone occurrences fail. Tool errors and empty clone scans fail too. Synthetic
canaries verify body-only orphans behind package wildcards, unused exports, copied logic,
count growth, URL resolution and public reexport preservation.

Inspect `.paqvilo/code-review/findings.json` and its per-scope reports before updating a
baseline. Fix actionable findings first. `node scripts/code-review.mjs --write-baseline`
requires specific runtime clone dispositions and refuses unresolved imports, full-graph
orphan files and unused full-graph exports. Review every resulting baseline diff. Static
tools cannot establish absence of every dead path or semantic duplicate.

## October 2026 audit dispositions

All 41 tasks and 199 export candidates were reviewed against current consumers and API
origins. The 199 modifiers were removed while keeping implementations and local callers.
Reruns found further unnecessary facade/modifier exports and five additional unused
declarations; those were also removed. Supported API names remain unchanged.

| Task    | Resolution                                                                                                                                 |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| A01     | Canonical portal catalogue shared by import/census, including types 33 and 35.                                                             |
| A02–A07 | Removed unused date module, placeholder/numeric/state/CLR/token wrappers, eight shadow constants and two aliases. Active engines retained. |
| A08     | Retired unused GUID inventory and its implementation-only test.                                                                            |
| A09     | Retired test-only migration writer; pure public migration and active CAS/rollback paths retained.                                          |
| A10     | Legacy operator contract documented and tested through DataStore.                                                                          |
| A11–A15 | Reviewed all 199 export candidates; further unused facades/modifiers cleaned up on rerun.                                                  |
| A16     | Shared ordered mapper with strict/clamped adapters; adjacent static prefetch pools included.                                               |
| A17     | Shared traversal mechanics with explicit import-order and fingerprint policies.                                                            |
| A18     | Shared bounded XML decoder; invalid numeric references remain text instead of throwing.                                                    |
| A19     | Shared synthetic metadata-version hash/cache.                                                                                              |
| A20–A21 | Shared message context/read dispatch and security reader with explicit effective principal.                                                |
| A22     | Shared PCF services/cleanup; destroy still runs after virtual-unmount failure.                                                             |
| A23     | Shared CLR parsing/bounds; distinct worker ownership/error policies retained.                                                              |
| A24     | Shared derived-column validation and source-type enumeration.                                                                              |
| A25     | Shared byte-preserving HTTP reader with protocol-specific limits.                                                                          |
| A26     | Shared live Dataverse override composition.                                                                                                |
| A27     | Shared inspection summary with explicit legacy panel adapter.                                                                              |
| A28     | Shared owned shutdown/discovery cleanup and combined failure handling; detached EOF preserved.                                             |
| A29     | Shared JSON string-span scanning with separate redaction policies.                                                                         |
| A30     | Shared read-grant selection; authorization/calibration remain separate.                                                                    |
| A31     | One authored watcher generates five standalone scripts; drift/independent-loading tests added.                                             |
| A32     | Deliberate standalone CSS copy retained with byte-prefix/accessibility drift regression.                                                   |
| A33–A35 | Shared invented sign-in, reader/text and form fixtures; scenario assertions stay independent.                                              |
| A36     | Shared owned browser/server/agent setup; acquisition-stage failures covered.                                                               |
| A37     | Shared example editor helpers; controls, typed outputs and manifests retained.                                                             |
| A38     | Pinned tools, scoped entry/asset maps, explicit baseline and synthetic canaries.                                                           |
| A39     | Shared lookup accessor preserving direct-field/null/alias precedence.                                                                      |
| A40     | Shared parity admission; sign-in/unsettled captures cannot become successful observations.                                                 |
| A41     | Shared readiness/serve acquisition with exit, partial JSON and timeout disposal.                                                           |

Remaining runtime clone dispositions distinguish generated watchers, standalone CSS, locale
identity, declarative schemas, security seed policy, form dirty-state policy and operation-specific
transaction/response contracts. `dashboard-icons.icon` is a namespace false positive: both
apps pass the module to the renderer, which calls `icons.icon` through options.
