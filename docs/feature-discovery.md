# External feature discovery

The [finalization ledger](discovery-finalization.md) records incorporation of the selected findings and two independent review rounds, superseding earlier candidate/backlog wording below.

Reviewed on 2026-10-28 against the fetched `origin/0.9.8` commit
`adf1b72c14e3b7060bc656fe7c479be39923e909`.

The reference repositories are separate research clones. No reference source,
assets, generated code, fixtures or package dependencies are included in this
change. The implementations use Paqvilo's existing abstractions and independently
written synthetic regressions. Public feature descriptions identify useful
requirements; Microsoft documentation supplies platform behavior where available.
Repository tests were inspected as evidence of scope, not imported or run against
live environments. Local regression results do not establish live parity.

## First round: requested projects

| Reference and inspected commit                                                                                                        | Useful behavior                                                                              | Existing coverage                                                                                        | Implemented here                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [SeedBomb](https://github.com/RyanMakesAndBreaksStuff/SeedBomb/tree/00e6c41fd078ea3ecd1907dc3a43968bd3e0a212)                         | Deterministic metadata-directed population, field rules, relationship planning and preflight | Schema scaffolding, required target discovery, additive merge and dangling-reference checks              | Pure `generateDataset` helper: per-table counts; constant, one-of, sequence, range, null and lookup rules; generated/existing lookup pools; identities reserved before relationships, allowing cycles     |
| [Side Pane Studio](https://github.com/RyanMakesAndBreaksStuff/SidepaneStudio_PPTB/tree/af2247202c8272de8f0501748889e61a1506b7d5)      | Pane lifecycle, selected-record contexts, presentation and configuration checks              | Local record, list, custom page, web resource and dashboard targets                                      | Collision-free generated pane IDs, selection after close, expand-on-select, hidden headers, badge clearing, accessible title updates and programmatic close independent of header close-button visibility |
| [Expression Builder](https://github.com/RyanMakesAndBreaksStuff/ExpressionBuilder_PPTB/tree/0595be284dead6ee01df0cdf7d1cf877ea62c9fe) | Nested typed predicates, null-safe composition and rooted payload references                 | Nested conditions, comparisons, `coalesce`, string wrappers, `body`, `outputs`, `item` and `items` paths | Case-insensitive `startsWith` and `endsWith`, strict two-string inputs, and complete local Filter array / If / failure-path regressions                                                                   |

`generateDataset` is exported from `paqvilo/mirage/fixtures`; see
[the pack guide](../mirage/docs/dataset-generation.md). Business selections,
realistic values and scenario generators remain project-owned. This helper never
contacts Dataverse, writes files or executes server rules. Reserving identities
works for an offline fragment; it does not claim SeedBomb's live bulk-create,
retry, deferred backfill or association machinery.

The side-pane changes follow Microsoft's [pane creation API](https://learn.microsoft.com/en-us/power-apps/developer/model-driven-apps/clientapi/reference/xrm-app/xrm-app-sidepanes/createpane)
and [AppSidePane API](https://learn.microsoft.com/en-us/power-apps/developer/model-driven-apps/clientapi/reference/xrm-app-appsidepane).
Studio-specific builder restrictions are not imposed on the simulated platform.
There is no visual builder, copied script generator or imported pane helper.

The predicate behavior follows the [Workflow Definition Language reference](https://learn.microsoft.com/en-us/azure/logic-apps/workflow-definition-language-functions-reference).
Source trigger conditions, exact 100-nanosecond UTC `ticks` and pure syntax/function/arity diagnostics are now incorporated. Rooted payload references already execute in the local engine. Dynamic payload types require explicit samples/schema; no copied visual composer is needed to use these APIs. Unicode case-folding parity has not been established.

## Second round: GitHub discovery

Searches included `fetchxml builder`, `SQL4CDS`, `XrmMockup`, `fake-xrm-easy`,
`power pages testing`, `dataverse devtools` and `power automate expression
evaluator`. Generic searches returned unrelated repositories too; the table below
contains the relevant candidates actually cloned and reviewed. Forks were not
treated as independent projects.

| Reference and inspected commit                                                                                                                              | Applicable ideas and disposition                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Power Automate Expression Lab](https://github.com/lukoplt/power-automate-expression-lab/tree/3ae8121ae1338c5e4c96bc2ba2243cddff2cff05)                     | Strict parsing, explicit unsupported results, typed diagnostics and conformance confidence. Reproduced Paqvilo accepting `concat('a','b',)` and fixed omitted trailing arguments, including whitespace, nesting, interpolation and runtime failure handling. Do not adopt the reference's unverified short-circuit assumptions.                                                                                                 |
| [Microsoft Power Platform Playwright samples](https://github.com/microsoft/power-platform-playwright-samples/tree/0b41791ced0dbb30076d3f6c29273255b8355483) | Form-context interaction, dirty/valid state and semantic readiness are useful compatibility requirements. Added bounded model-driven form validity APIs and synthetic regressions. Existing Playwright setup is sufficient; no second browser automation framework or authentication package is required.                                                                                                                       |
| [SQL 4 CDS](https://github.com/MarkMpn/Sql4Cds/tree/3e74819ea6509f13518cbe993b43fab057c3e9ce)                                                               | Query semantics, collation coverage, paging and metadata-aware diagnostics. A focused SQL audit reproduced ignored accent sensitivity, matching of dangling escapes and silently truncated escape expressions. Independently fixed `LIKE` using existing text folding and explicit escape validation. Its SQL-to-FetchXML planner, DML and metadata virtual tables are separate products, not Dataverse TDS endpoint contracts. |
| [FetchXML Builder](https://github.com/rappen/FetchXMLBuilder/tree/53a522d3d3020ec0a6befa3f075771e678e1028d)                                                 | Metadata-aware authoring, validation and query conversion. Paqvilo already validates query structure, aliases, joins, projections, types and limits. A visual query editor and SQL/OData conversion remain candidates; importing a Windows desktop builder does not improve the current runtime boundary.                                                                                                                       |
| [XrmMockup](https://github.com/context-and-oss/XrmMockup/tree/0972ef9be11d95ce554e5562faa59d58b18b1bb1)                                                     | Instance metadata, pipeline/security tests, controlled time, snapshot/reset workflows. Paqvilo already has explicit runtime clocks, local store snapshots, trusted plug-in adapters and permission models. Keep broader security/pipeline differential coverage as future independent synthetic cases; do not embed a second simulator.                                                                                         |
| [FakeXrmEasy](https://github.com/DynamicsValue/fake-xrm-easy/tree/f83a1f98d716394cc7e61d016a6c45f20ae1323c)                                                 | Explicit middleware composition, request executors and plug-in test isolation. These are valuable design/coverage references; Paqvilo already routes writes through its pipeline and exposes trusted pack handlers. The umbrella spans several packages/repositories and licensing choices; no integration proposed.                                                                                                            |

For `LIKE`, the authority is Microsoft's [SQL specification](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/like-transact-sql)
and [Dataverse collation description](https://learn.microsoft.com/en-us/power-platform/admin/language-collations),
not another project's implementation. Tests cover accent-sensitive and insensitive
matching, case, character sets, combining accents, escape validation, negation and
nulls. Existing evaluator and loopback TDS suites remain applicable. This does not
claim full SQL Server linguistic range matching or a SQL 4 CDS engine.

## Further rounds: expressions, client APIs, PCF and diagnostics

Discovery continued while the first implementations and validation work ran.
The following additional repositories were cloned outside the toolkit. Their
feature descriptions, contracts and test coverage were compared with Paqvilo;
no reference implementation was imported.

| Reference and inspected commit                                                                                                              | Findings and disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [ExpressionEngine](https://github.com/delegateas/ExpressionEngine/tree/960ce9a1ee8180c4386a83026b8ef906d3e504a8)                            | Useful common exported-flow string/array transforms. Independently added `split`, `join`, `substring`, `skip` and `take`, with strict arity/type/index checks, exact numeric join serialization, bounded output and complete flow regressions. Empty split delimiters remain explicitly unsupported pending qualification. Last repository push was November 2024, so do not adopt as a maintained runtime dependency.                                                                                                                                 |
| [xrm-mock](https://github.com/davidjbclark/xrm-mock/tree/bf9f2b478f3865de4d9400a0032cb637cea47983)                                          | Its attribute contracts exposed missing `getMin`, `getMax`, `getPrecision` and `getMaxLength`. Added source-backed metadata getters and source-to-browser regressions; unavailable metadata is explicit. Follow-on review also fixed form-selector GUID lookup and implemented per-control Choice/Choices option mutation with source metadata and selected values preserved. MIT, but the inspected v3.6.2 tree is from April 2025 with an older TS/Jest/TSLint stack, insufficient active-maintenance confidence.                                    |
| [ComponentFramework Mock](https://github.com/Shko-Online/ComponentFramework-Mock/tree/e1177598be86b5ca432bf9b866f7531ed8675a68)             | Lifecycle, responsive layout, property types and dataset APIs are useful coverage requirements. Found model-driven dataset `trackContainerResize` was a no-op. Added opt-in width tracking, layout update reasons, coalescing and deterministic observer cleanup, with controlled browser delivery tests. Height remains the documented unconstrained `-1`. Existing field hosting, paging and filtering cover much of the reference surface. MIT, active in August 2026; adding its Sinon/SQL/mocking dependency stack would duplicate our live host. |
| [Cloud Flow Analyzer](https://github.com/leduc212/cloud-flow-analyzer/tree/7a238662da009ae574e26a9c7501282878741a64)                        | Concurrent variable mutation rules prompted a concrete preflight audit. Replaced brittle regex variable-read detection with the existing expression parser, handling case, whitespace, interpolation and quoted names. Unknown dynamic/malformed read sets cannot qualify beside a concurrent writer; rejected flows invoke no provider. No arbitrary score, copied rule catalogue or live run-history integration. Young September 2026 project; MIT and visible CI do not establish long-term maintenance.                                           |
| [Dataverse REST Builder](https://github.com/GuidoPreite/DRB/tree/0e7d46d9fd13da8d523c517241bc06960a4c4f63)                                  | Metadata-aware request construction, alternate-key/navigation selection and portable request collections. Paqvilo already has metadata-aware query/write validation and API clients. An independently owned request collection/export tool is a future developer feature; do not embed the UI or its generated scripts. MIT, but no repository push since April 2023 in the checked metadata.                                                                                                                                                          |
| [dataverse-odata-builder search result](https://github.com/lvigerust/dataverse-odata-builder/tree/3fd114c3f95a4b3718cdd587bc3dff9b3ea7007c) | Typed fluent query composition and lambda/function escaping are useful authoring ideas. The README/package identifies upstream `nbyx/odata-builder`; this is not evidence of an independently maintained Dataverse product. Existing OData parsing/validation remains core; type generation and a fluent authoring API are backlog items, without adding a query-builder dependency.                                                                                                                                                                   |
| [Level Up](https://github.com/rajyraman/Levelup-for-Dynamics-CRM/tree/7cec0f8aa09bcafed675684731d7291ca3a38258)                             | Logical names, changed-field highlighting, option values, record identity and form-event inspection are relevant local diagnostics. Existing Inspect and source-backed Xrm APIs cover parts of this. Its impersonation, cloning and admin-changing features are not implied by local development authorization. MIT and a long history, but no browser-extension integration is needed.                                                                                                                                                                |
| [XrmDefinitelyTyped](https://github.com/context-and-oss/XrmDefinitelyTyped/tree/b0d19a934e86ccdfb2c438560ab214f42e092825)                   | Source-derived declarations, option-set enums and compile-time query contracts suggest an optional project-owned typings generator. Paqvilo's imported metadata already supplies runtime identities and field types; adding a separate F#/build subsystem is not justified. Test generation requires organization configuration, so those reference tests were not run. MIT; branch history/release evidence needs separate qualification.                                                                                                             |
| [Power Automate Expressions](https://github.com/gncnpk/power-automate-expressions/tree/abe2ecee4954ced561cd4fe8baae7e7f42f5cee1)            | Syntax highlighting, function completion and language-server diagnostics suggest an editor surface over our existing parser. No editor package was added; parser correctness improvements above remain usable without a language server. MIT with limited visible adoption; editor integration needs its own public diagnostic API.                                                                                                                                                                                                                    |
| [pp-lint](https://github.com/alvesmaia/pp-lint/tree/ffcda3901bd485125402bebcf6a9ba0de762f682)                                               | Read-only exported-artifact analysis, structured findings and checked/total denominators are useful reporting approaches. Generic structure/reference validation belongs in preflight; organization naming conventions and arbitrary scores do not belong in core. The inspected LICENSE is MIT despite the GitHub API's unclassified license label. August 2026 history is too short for dependency adoption.                                                                                                                                         |
| [dataverse-simulate](https://github.com/Cloud-Awesome/dataverse-simulate/tree/0386d7c3860ef61528b1122ac6c2a7c2da664d99)                     | Injected clocks/identities, separate entity/log/telemetry stores and simulator message audit are useful testing contracts. Paqvilo already supplies controlled clocks, trusted plug-in services and journals. A second NSubstitute-based .NET service simulator duplicates those boundaries. GPL-3.0 and current activity are recorded, without adopting source or dependency.                                                                                                                                                                         |
| [DataverseFakes](https://github.com/TarogStar/DataverseFakes/tree/72b2592a788e1e31c1c9b72dff7fa9e2c18e663e)                                 | Plugin assertion helpers, cascades, access-team lifecycle and elastic-table constraints are useful coverage prompts. Independently implemented primary-documented final-member cleanup for system-managed access teams, preserving direct shares and manually managed teams; re-adding creates a fresh identity. Actual LICENSE.md and package metadata state MIT despite the GitHub detector label. This modern continuation of archived FakeXrmEasy needs its own maintenance qualification.                                                         |
| [Power Automate Mock-Up](https://github.com/thygesteffensen/PowerAutomateMockUp/tree/f6aa6ca37138f93c3fd7aec521f2d5204ad293e2)              | Connector/action executor composition and action input/output reports map to existing trusted pack providers and local run journals. Its optional success-for-unknown-action behavior would hide missing coverage and was not adopted. MIT; inspected default-branch code dates to 2022 and repository push metadata to 2024. No second flow engine is needed.                                                                                                                                                                                         |
| [Power Apps Test Engine](https://github.com/microsoft/PowerApps-TestEngine/tree/a497d6c19880d5a4496127ec9c20d682a8cb38c9)                   | YAML/Power Fx test authoring, logical control references, connector mocks and evidence capture are useful concepts, already partly covered by local acceptance plans and providers. Crucially, the inspected README declares deprecation and removal on **2026-11-01**. This is rejected as an integration despite Microsoft ownership, years of history and recent repository activity. Microsoft directs users to its Playwright samples.                                                                                                            |

The PCF resize contract follows Microsoft's
[trackContainerResize documentation](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/mode/trackcontainerresize).
The flow transforms follow the WDL reference already linked above. Bounded local
coverage is documented separately from full native parity.

The access-team cleanup follows Microsoft's [Access Teams guidance](https://www.microsoft.com/en-us/download/details.aspx?id=41190),
page 14: final-member removal removes the team share and deletes the system-managed
team. This is historical CRM 2013 guidance, not a fresh native capture. Synthetic
regressions cover warm authorization caches, remaining members, direct shares,
ordinary teams and fresh identity after re-adding. The existing empty `204`
RemoveUserFromRecordTeam response remains unchanged; its documented payload needs
separate qualification for existing-team and absent-team cases. Full action parity
is not claimed.

The DataverseFakes review found Windows build/test and checked tag publishing,
but no coverage gate or security-analysis lane in the inspected workflows.
dataverse-simulate has build/test and coverage artifacts, while its inspected
Azure tag-release pipeline still has build/test/deploy TODOs. Test attributes and
workflow files are maintenance signals, not proof of passing CI or coverage.

The Test Engine finding demonstrates why recent activity or a prominent owner
does not establish future maintenance. Microsoft's
[migration guide](https://learn.microsoft.com/en-us/power-platform/developer/playwright-samples/migration-guide)
maps its concepts to Playwright. EasyRepro was also rejected during search because
the official repository is archived; it was not cloned or counted among the 23
reviewed reference checkouts.

## Validation-driven reliability finding

The full local run exposed a demo CSS live-edit timeout. Investigation found a
definite protocol hole: the rendered document carries a source revision and the
event stream announces its current revision, but the client ignored that initial
announcement. A change before subscription, or while the page was suspended,
could therefore be missed forever. The client now reconciles those revisions.
Controlled protocol gates reproduce initial and resumed subscription gaps, and
confirm equal revisions do not cause a reload. This fixes independently reproduced
ordering failures; an isolated successful rerun does not prove the exact timing
of the original loaded-suite timeout. No sleep or existing timeout was increased.

The research report lives in `docs/`, which is an admitted release documentation
path, so package checks retain their existing whitelist.

A later full run exposed an X-ray editor-status timeout. A controlled evidence
refresh at the editor-result boundary reproduced feedback being erased by card
rendering. Feedback now belongs to a selection/document/source scope and survives
same-scope rendering; late editor responses and disable boundaries cannot label a
new selection. The exact ordering of the original full-suite timeout is unproven.

The same run caught retained render-sweep HTML being filled by an expanded
simulator script before authored content reached its existing 20,000-character
cap. Retained HTML now omits simulator-owned injected runtime scripts before
sampling, with explicit omission/truncation metadata; response classification
still examines the full original response. Oversized injection and deep nesting
are covered, alongside the original persona/row/state assertions. Registry
descriptions in the search inventory are rendered as text, preventing package
Markdown from becoming broken local documentation links.

## Integration decision

No new integration or dependency is warranted. Activity, stars and test filenames
alone cannot establish maintenance quality or predict future ownership.

- The three requested projects are active but young (created in May, June and
  October 2026), with BSD-3-Clause licenses. SeedBomb and Expression Builder have
  workflow and test files; the inspected Side Pane Studio tree has tests but no
  GitHub Actions workflow. There is not enough maintenance history to accept a
  runtime dependency under the requested bar, and the .NET/WPF or React/PPTB
  application boundaries do not match these core gaps.
- SQL 4 CDS (created 2020) and XrmMockup (2017) show longer histories, recent
  repository activity, CI configuration and substantial test trees. They are the
  strongest future interoperability candidates. Neither has been qualified here
  for build health, coverage, security process, support commitments or our exact
  integration boundary; both would add a substantial .NET subsystem.
- FetchXML Builder has a long history (2015) and recent activity, but its desktop
  editor, GPL-3.0 license and lack of a workflow in the inspected tree do not
  justify incorporating it. Use its functionality to guide independently owned
  authoring features if those are prioritized.
- Microsoft's Playwright samples have CI and tests but only a 2026 history. The
  inspected CI formats, lints and builds on pushes/manual runs; it does not run
  the tests or trigger on pull requests. The local reference is useful for
  compatibility ideas, not a reason to replace our browser/test stack or run
  its environment-specific live samples.
- Expression Lab began in August 2026, with limited visible adoption and history.
  Its confidence labeling is useful; its runtime is not qualified as a dependency.
- FakeXrmEasy shows recent activity, multiple workflows and tests, but its
  multi-repository architecture and nonstandard aggregate license classification
  require a separate review before any future interoperability proposal.

These are evidence-limited assessments as of the review date, not guarantees of
future maintenance. A future integration proposal must establish sustained
maintainer activity, passing required CI, meaningful coverage, security and
release practices, clear licensing and a concrete architectural fit first.

## Follow-on findings incorporated

The finalization pass adds named fixture recreation with state/clock/IDs/manual scheduling, public expression diagnostics, hosted trigger conditions, exact UTC ticks, project-owned TypeScript schema declarations, offline permission and registration comparison, explicit identity transport, fixture population/relationship coverage and a paged source event inventory. Native pane navigation now preserves named tab and record/form context, with selected-row command composition verified. Existing query parsing/preflight, bounded CSV export and access-origin APIs were verified rather than duplicated. The [finalization ledger](discovery-finalization.md) records each reference, implementation, regression and concrete platform boundary.

## Completed follow-on rounds

The [keyword inventory](discovery-search-index.md) covers 95 capability buckets
and retains every first-page hit from 127 GitHub and 105 npm queries. The
[npm review](npm-discovery.md) includes missing/non-GitHub source declarations
and the independently implemented bounded flow JSON Schema validator. The final
[XrmToolBox top 50 review](xrmtoolbox-discovery.md) records every plugin decision,
trace survival through rollback and source-LCID propagation for ribbon/form
inspection. The [kudos index](kudos.md) connects ideas and guidance to references.
