# Release notes

## 0.9.8

- Preserve platform-owned audit stamps in Update plug-in Targets without demanding visitor association grants for
  unchanged platform values. Explicit bindings and plug-in lookup edits retain authorization and rollback.
- Expose opt-in authenticated, local-only [pack transactions](../mirage/docs/data-packs.md#authenticated-local-endpoint-writes)
  with declared targets, scoped CRUD, concurrency checks and bounded atomic idempotency receipts.
  Pack routes also retain requester audit/trace attribution, including repeated global-pattern matches.
- Return detached primary-key acknowledgments from pack mutations, keeping protected row data and mutable pipeline
  references behind explicit permission-scoped reads. Project server-logic connector Create responses through current
  column security, including values assigned by plug-ins, without masking the stored record.
- Recover one `ECONNRESET` for safe [configuration assignments](public-api.md), retaining a fixed diagnostic and
  propagating other failures. Uncertain record writes and preset application are never replayed automatically.
- Distinguish absent/empty enhanced record payloads from syntax errors with `PAQ-SOURCE-002`; withheld settings
  remain incomplete without advice to disclose values. Keep declared primary names/keys queryable in partial
  Solution exports, while rejecting genuinely unknown columns.
- Bound whole-metadata resolution in rollup write scans independently of unrelated table count. Preserve structured
  metadata invalidation, current authorization, the full plug-in pipeline and atomic rollback.
- Add `paqvilo analyze` and shared Doctor source analysis with 126 rules across Dataverse, ALM, model-driven apps,
  Canvas, PCF, Code Apps, cloud flows, connectors, MCP, mobile declarations and Power Pages. Direct folders and
  declared project sources work without a portal catalogue. Errors, warnings and hints remain separate; Doctor
  is advisory unless an explicit threshold is selected. See [static analysis](static-analysis.md).
- Inspect supported source and package contents within shared read and archive budgets without running project
  code, formulas, builds, PAC or tenant requests. Reports retain partial/unsupported coverage and 18 separate
  operation/evidence capabilities; local declarations do not certify compilation, authorization or native runtime behavior.
- Load model-driven apps with only the navigation index and the selected table's metadata. Forms, views and fields
  of other tables arrive when a lookup or subgrid needs them. The complete catalogue at `/_apps/api` still returns
  every table, form, view and field, and a large catalogue is gzip-compressed when the client accepts gzip. See [startup and responsiveness](../mirage/docs/runtime-performance.md#model-driven-catalogue).
- Derive column metadata once per request for wide records and FetchXML pages instead of once per row and column.
  Edited labels and field security appear on the next request.
- Add `createOwned()` preset factories, which hand a freshly generated dataset to the runtime without a retained
  copy. Inside a factory, `records.table()` streams rows into checksummed paged record storage beside the state
  file, with bounded read caches and a primary-key index. Snapshots, exports and record results remain ordinary
  data, and existing `load()` presets keep their memoized, detached copies. See [data packs](../mirage/docs/data-packs.md)
  and [generated record storage](../mirage/docs/record-storage.md).
- Reduce memory and copying on large datasets during startup, journal replay, checkpoint restore and status polling.
  Unchanged restarts journal only changed sections and tables, and still detect edits made between restarts. A
  failed startup initialization is discarded instead of persisted.
- Show a count above the native 5,000-record limit as `5000+` in model-driven grids and subgrids. Next-page
  navigation continues past the limit, and smaller filtered results keep their exact count.
- Keep scripts and PCF controls in very large Solution trees: source discovery and client-asset discovery have
  separate budgets. Source edits to column labels or security, component presence and same-name solution assets
  reach the served metadata even when no record changed.
- Capture observed same-origin `/_pcfwebresource/<guid>` stylesheets, which have no file extension, after verifying
  that the response is CSS; origin, credential, path and size checks still apply. Duplicate observations fetch once
  and keep their media and cascade order. Two origins that would share one local path fail explicitly. A failed
  capture or refresh keeps the previous shell, including its valid stylesheets.
- Sanitize the local rich-text compatibility editor's content with DOMPurify: scripts, event handlers, `javascript:`
  URLs, frames, objects and SVG/MathML markup are removed. A captured native CKEditor keeps its own filtering. See
  [public API](public-api.md). Both editors keep paragraphs, tables and preformatted blocks across save and reopen,
  store native-style JSON hidden values, skip writes and change events for unchanged content (so authored mutation
  observers cannot loop) and report ready only after the editor's own document loads. Read-only fields stay read-only.
- Admit each shared model-driven source file once per synchronous metadata projection, retaining fresh filesystem
  validation for subsequent queries and source-opening actions. Keep the source-byte cache bounded.
- Use native Windows path resolution during source-index construction, preserving root confinement, file identity,
  size limits and every before/after pathname and content-version check.
- Stream complete model-driven metadata one table at a time with backpressure and disconnect handling, retaining
  the same JSON bytes, exact numeric precision, forms, fields and security capabilities. Avoid cloning business
  state to initialize the live-bridge configuration.
- Resolve explicitly table-bound custom-grid column declarations through the direct-observation adapter, including
  explicitly linked scroll-head clones. Load their exported table definitions on demand, including selected grids
  beyond the bounded page scan, and keep those tables admitted when the sources reload, so Open source still finds
  them after an edit. Unbound columns retain candidates; API requests and cell values supply no ownership.
- Accept a verified native basic-form wrapper when its optional layout reports an all-zero form ID. Explicit
  unknown form declarations remain unresolved. A generic native modal can join its same-origin `data-page`
  placement, rendered list/subgrid, exported action type/form and layout table when the join is unique and consistent.
  Definition URL hints can reject conflicts; unresolved joins retain table and declared-form context without field ownership.
- Reject modal list/view contradictions and retain subgrid ownership when the grid is its own subgrid wrapper.
  Join rendered advanced-form layouts only to matching configured steps, including subsequent step replacements.
- Join native quick-view iframe declarations to a verified parent form and exported QuickForms target. Check
  the current document path and conflicting navigation hints; retain unknown or conflicting boundaries.
- Read only approved form/table query hints for definition context, leaving row and unrelated query values unread.
- Carry verified attribute-host identity through accessible same-origin rich-text editor frames. Independent inner
  forms, conflicting declarations, missing exports and inaccessible frames retain their evidence boundaries.
- Retain original-table conflicts on linked grid clones, admit selected late clones within the scan bound, and
  validate quick-view target declarations independently from the containing form across supported themes.
- Preserve model-driven recommended requirement levels and PCF schema requirement values. Update every rendered
  control bound to an attribute, retaining distinct control IDs and correct label associations across tabs.
- Keep row-spanning baseline form controls within their declared section columns, including subsequent quick views.
- Reuse the complete startup implementation fingerprint for the first state request while retaining source-change
  invalidation and concurrent-file-removal handling. Defer unused runtime imports in scaffolded smoke tests and
  declaration-only helpers; preserve strict content, authentication, denial and external-asset acceptance checks.
- Remove verification's temporary copy asynchronously, so queued Windows directory-handle releases can finish, and retry
  a profile file the exited browser still holds with a linear backoff of up to 11 s.
- Run a code app's module scripts in document order under `codeApps()`, as the browser does without it, so an
  application module never runs before an earlier inline script. The code apps workbench launches each app in a new
  frame, so a dev-server reload of the previous document cannot drop applied query parameters.
- Scan FetchXML and form XML markup in linear time, with the same results, on unterminated comments, tags and
  attributes.
- Extend regressions for crowded cards, frame shortcuts, dynamic modal/quick-view identities, nested editors and
  owned-browser target isolation. The latter drops actual CDP requests in an independent loopback WebSocket proxy:
  a tab or popup whose interception setup fails or is cancelled closes alone, healthy tabs keep their drafts, watchers
  and agent endpoints continue, a retried tab applies current sources, and losing the shared browser connection ends
  the session. See [Lense](lense.md).
- Local validation reproduces the hosted checks that previously failed only on GitHub: the Security workflow's
  CodeQL analysis with its pinned bundle, compared with GitHub's dismissed alerts; Windows browser lanes in both
  Chromium and Edge; an 8.3 `TEMP` alias and an empty npm cache for the package smoke, as on hosted runners; and two
  extra runs of each changed test file. See [CONTRIBUTING](../CONTRIBUTING.md).
- Write the code app bootstrap specifier as an inert module string literal, as page script URLs already are.
- Trace each local request as a tree of spans: the HTTP request, portal Web API call, form submission, Dataverse
  operation, function, action, bulk message and `$batch` part, permission decisions, plug-in stages and steps with
  their SDK calls and trace lines, secrets, outbound HTTP, web hook and Service Bus deliveries, asynchronous and
  background jobs, classic workflows, server logic, cloud flow runs and actions, connector calls, canvas app actions
  and page renders. Every host of a runtime shares one store: Power Pages, the standalone host with its model-driven,
  canvas and code apps, the Dataverse Web API listener and its SOAP endpoint, TDS and the local identity provider, and
  `/_sim/api` administration writes are traced too. Loopback calls, portal pages, the model-driven shell, the canvas player, the
  code-app client and staged jobs join the trace of the request that caused them, with `staged-by` and `triggered`
  links, and each audit entry links to its trace. `mirage.trace` sets the level (`off`, `summary` by default, or `full`
  with redacted inputs and outputs), retention and optional persistence under the state folder; the level and the
  retention limits also change at run time. Read traces in the `_sim` **Activity** view, through `/_sim/api/trace`, with
  `paqvilo mirage trace list|show|spans|stats|settings|clear|flush|export|watch` or with `connectRuntime().trace`. See
  [request tracing](../mirage/docs/tracing.md).
- Every span that acts on a row names its table and record id, from the dispatch and the plug-in steps to the jobs,
  web hooks and flows it starts; filter on `recordId` in the API, `--record-id` in the CLI or **Same record** in the
  view. Plug-in step spans keep their registered images by alias, shared variables and execution context at `full`,
  and a plug-in fault keeps one identity (type, code, status, plug-in type, step, stage, depth) on the step, the
  dispatch and the request. Jobs are named by their process, a failed flow run names its failing action, a connector
  error keeps the provider's own code and cause, sealed flow runs are marked `secure: true`, and spans can end
  `cancelled`.
- JavaScript plug-in handlers receive the operation's `sharedVariables` (and `context.SharedVariables` for a
  `pluginTypes` handler), shared with later JavaScript and CLR steps of the operation. See
  [project extensions](project-extensions.md#plug-in-type-handlers).
- The `_sim` navigation has **Home** (Workspace) and **Monitor** with **Health** and **Activity**. Home holds the
  first-run checklist, how this browser signs in and where to go next; Runtime state holds the runtime, persistence and
  workspace configuration panels. Health starts with a banner (readiness, site, address, source version, uptime and a
  strip of key numbers), then compact tiles with **Expand** for their graphs, the system map open by default, Blocking
  and Configuration, and each counter opens the matching activity. Activity replaces the Live logs, Request audit,
  Traces and Render & diagnostics views with one workspace: tabs Activities, Log stream, Findings, Pages & render and
  Stats under one set of filters (time, result, who, table, record id, host, search) that is the page address, and an
  activity detail with a **Why**
  line, Steps, Log & findings, Rendered (template source file and line), Request and JSON. One vocabulary (activity,
  step, finding, log line, who, result) and one time format (local `HH:MM:SS.mmm`, date and UTC on hover) are used in
  Monitor and Flows & jobs. At level `off` Activities lists the request audit. The old addresses `#dashboard`,
  `#overview`, `#logs`, `#audit`, `#trace` and `#evidence` redirect to their new place with their filters. Flows & jobs,
  Backend operations, Data records, Portal identity and Organization identity & API link to the activity of what they
  ran. With tracing off, Live follows the request audit. See
  [`_sim` administration](../mirage/docs/sim-administration.md#monitor).
- Every `_sim` view shares one page layout: the breadcrumb names the page (current item in the accent colour) with the
  view's (i) after it, one toolbar row with the actions and **Filters · n**, a filter drawer on the right, chips under
  the toolbar, and explanations behind (i) buttons and tooltips. Every table is one shared table with sortable
  headings, row dividers, row actions pinned right, ↑/↓ and Enter, and a bottom bar with the count, rows per page and
  paging; paged Data records sort on the runtime. At phone width the sidebar folds behind **Menu**, the top bar's links
  move into **Apps & actions**, and Activity's tabs become a dropdown. See
  [`_sim` administration](../mirage/docs/sim-administration.md#page-layout).
- Table filters take a logical or an entity set name, and `recordId`, `actorId`, `sessionKey` and `visitorId` take a
  prefix of at least 8 hexadecimal characters, in traces and the audit. Audit entries record `visitorId` and
  `sessionKey`. `GET /_sim/api/dashboard` answers `runtime.startedAt` and `runtime.uptimeMs`. `trace list` and
  `trace spans` print local times with the UTC offset in the header, or ISO UTC with `--utc`. `simulator.trace.subscribe`
  takes `events` and `traceId` like `connectRuntime().trace.subscribe`.
- Sort activities by time, duration, step count or errors; search the steps of an activity, keep only its errors and
  denials, read it as JSON, copy its id or link, and compare two activities side by side with the duration delta of
  each matched step. Stats compares the root p95 with the previous range of the same length and lists the slowest steps
  and latest errors. The list sits beside the open activity on wide screens and names each activity's first error; the
  step drawer shows the path from the root, Parent and Root, and links flow run, job and plug-in step ids to their
  views. The `_sim` pages follow the browser's dark colour scheme.
- Link the audit and the trace both ways: the root span of an audited request carries `auditId`, a Liquid read's audit
  entry names its own `read` span, sign-in entries name their span, and trace summaries carry `auditId`. Filter traces
  by `auditId` and by `result` (the activity's own result) in the routes, `connectRuntime().trace` and the CLI
  (`--audit-id`, `--result`), and audit entries by `traceId` (up to 200 ids). Findings raised during a request, the
  portal and Dataverse request rings and flow runs (`traceSpanId`) name their trace. Inbound `X-Sim-Trace-Id` is read
  as an audit id only, and outbound calls send it only as the audit id of an audited ancestor.
- Keep the runtime log stream on the server: `mirage.logs.retain` lines (default 2000), with startup and reload lines
  and one `plugin` line per declarative plugin rule evaluated, read through `GET /_sim/api/logs` and
  `connectRuntime().logs()`. A plugin rule evaluation is also a `rule` event on its span. The trace channel takes
  `events=` and `traceId=`, `GET /_sim/api/render-sources` resolves template steps to their source file and line, and
  `GET /_sim/api/activity/export?format=bundle` (`connectRuntime().exportBundle()`,
  `paqvilo mirage trace export --format bundle`) streams one NDJSON bundle of activities, audit entries, log lines,
  findings and the evidence reference. See [request tracing](../mirage/docs/tracing.md#activity-bundle).
- Export traces as JSON, NDJSON or OTLP JSON (`resourceSpans`), streamed one trace at a time and bounded by `limit`
  (200 by default, at most 2000). `trace watch` takes the list filters and `--trace-end`, and ends with exit 0 when the
  runtime stops; every `trace --json` action prints one envelope, and failures name a code such as `TraceNotFound` or
  `RuntimeUnreachable`. A filter outside its values answers 400 `InvalidTraceFilter` naming its `parameter`, and the
  CLI exits 2 for it. `connectRuntime().trace` adds `ancestry`, `subscribe` and `flush`, and a runtime that closes the
  connection before its response completed rejects with `RuntimeConnectionLost` (CLI exit 1).
- A trace that reaches `spansPerTrace` stays one trace and counts the refused spans; trace ids from headers must be
  UUIDs, and `/_sim/api/trace/id/<traceId>` reads any trace id. Persisted traces are written as delta lines after the
  response, a runtime without a state folder reports `NoStateDirectory`, and trace ids stay out of the state file. File
  and binary columns are captured as their size and SHA-256, never their bytes.

Synthetic and native qualification are distinct. Loopback passes establish the exercised contracts; they do not
establish native control coverage, a deployed source revision or production readiness.

### Consumer feedback qualification, 2026-11-06

The reported preview maps to release commit `e7fa18402f72`. On that exact source, 71 focused unit checks and
28 browser checks passed on Node 24.22.1, Windows x64, using invented schemas and disposable loopback browsers.
This receipt contains no customer data, source paths, tenant identifiers or authentication material.
The following stable feedback IDs distinguish reproduced defects from qualification already supported by that release:

| ID  | Review outcome and verification                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 215 | Fixed redundant whole-metadata work in write observation; `write-metadata-cost.test.mjs` compares the old per-table path, current snapshots, structured edits and rollback. Existing startup/cache tests and the source-volume browser readiness test preserve source/data coverage and local edits. See the measured workload below.                                                                                                                                                                                                |
| 232 | No current toolkit defect reproduced: `test-browser/xray-feedback.test.mjs` checks selected sources before crowded context, paging, retained disclosure choices, unknown elements and card movement without activating native controls.                                                                                                                                                                                                                                                                                              |
| 234 | No current toolkit defect reproduced: the same browser suite checks uniquely joined generic modal placement in lists/subgrids, multiple action forms/lists, replacements, conflicting URL/layout hints, absent exports and source changes. Unjoined context stays qualified.                                                                                                                                                                                                                                                         |
| 237 | No current toolkit defect reproduced: the same suite checks two empty/disabled editor hosts and nested repeated IDs at 4 and 900 candidates, advanced-step replacement and explicit unknown/inaccessible boundaries, without reading values.                                                                                                                                                                                                                                                                                         |
| 238 | Owned-browser executable fault receipt: `dev-session-close-errors.test.mjs` passed a real independently proxied `Page.getFrameTree` stall in a cancelled initializer, explicit tab and popup. Both 10-second deadlines fired; only failed tabs closed. Two unsaved drafts, watcher updates, agent session/events/pages and a new tab executing changed source survived. Actual shared transport loss stopped the owned session and removed its watcher/discovery. Test duration: 23.1 seconds. No existing user browser was faulted. |
| 239 | No current toolkit defect reproduced: `richtext-form.test.mjs` checks empty/plain/quoted formatted HTML through repeated edit/postback/reopen, actual hidden JSON, authored jQuery and mutation observers, bounded events, paragraph structure and zero page errors. Editor-document readiness uses a controlled blank-document gate.                                                                                                                                                                                                |
| 240 | No current toolkit defect reproduced: `shell-capture.test.mjs` checks managed GUID CSS, duplicate/query observations, non-CSS/404/oversize/unsafe inputs, origin/credential protection and failed-refresh rollback retaining the prior shell.                                                                                                                                                                                                                                                                                        |
| 241 | Added the missing public capability; `pack-endpoint-writes.test.mjs` exercises authenticated HTTP transactions, token/target/provider refusal, children/rollback, stale revisions, capability expiry, concurrent duplicate keys, changed inputs, payload bounds and independent runtimes.                                                                                                                                                                                                                                            |
| 242 | Added bounded configuration recovery; `runtime-configuration-recovery.test.mjs` checks before-send and after-commit resets, second-reset/server/unreachable refusal, no create replay and a retained real client after a 4,000-row preset replacement. Lost snippet creation resumes by reading its committed identity. The operating system connection-reuse cause remains unproven.                                                                                                                                                |
| 243 | Reproduced scalar Update refusal with audit relationships and no systemuser AppendTo; fixed its authorization input. `audit-binding-authorization.test.mjs` retains audit values and Targets, denied/permitted explicit binds, plug-in edits and rollback.                                                                                                                                                                                                                                                                           |
| 244 | Reproduced absent enhanced payload misdiagnosis; `analysis-component-payload.test.mjs` covers absent/empty/optional/null values, invalid JSON, malformed XML and unknown kinds without disclosing values. Existing secret/parser security assertions remain intact.                                                                                                                                                                                                                                                                  |
| 245 | Corrected documentation to distinguish request validation from native-qualified 405 refusal. Existing bulk, PreValidation, elastic and permission tests retain their native assertions and row-preservation guarantees.                                                                                                                                                                                                                                                                                                              |
| 246 | Reproduced an empty default grid failing on a declared primary name. `partial-primary-metadata.test.mjs` now verifies usable empty/populated HTTP grids, exact declared fields and rejection of unknown fields.                                                                                                                                                                                                                                                                                                                      |

The separate `--large` performance probe used 256 invented tables, 10,240 forms and 20,000 records. Fresh,
unchanged and journal-grown starts took 4.793, 2.891 and 1.742 seconds; first status responses took 26, 11 and
8 ms. First grid API reads took 27, 20 and 20 ms. Complete catalogue reads took 8.9–10.2 seconds, with a maximum
concurrent status heartbeat of 45 ms. All declared probe budgets passed, all 20,000 records remained, and the
journal edit survived. Cumulative process peak RSS reached 2,755 MiB across these same-process runs. This includes
the complete source/state and catalogue workload plus V8 retained heap capacity; it is not a per-phase retained-heap
measurement or proof of a leak. Cold module import precedes the first exported callback; context preparation has
its own progress phases, as described in [runtime performance](../mirage/docs/runtime-performance.md).

A separate visible-browser fixture with 64 tables, 256 forms and 4,096 records measured fresh/restart runtime calls
at 651/525 ms, usable grid search at 188/146 ms, and refresh at 89/95 ms. It searches for an actual row, observes no
page-script errors and retains all tables/rows and a local edit without reapplying bootstrap. These sequential local
samples are neither a randomized package comparison nor a portable hardware budget. Full source volume, native
deployment differences and a consumer's signed-in native requalification require that consumer's own authorized
environment; synthetic receipts establish the toolkit contracts and do not claim native/live parity.

Hosted Edge qualification also exposed two test synchronization defects. The code-app workbench now holds the
requested frame response and observes that exact frame's navigation before using its bridge. Owned CLI readiness
listens to process output, exit and cancellation under the test's existing deadline, rather than imposing a shorter
independent startup deadline. Both retain their functional assertions and pass locally in Edge; the workbench also
passes in Chromium. Neither fix increases sleeps or changes runtime/parity behavior.

A full Chromium run also expired its default locator wait before finding the live-write opt-in switch. A controlled
initial-state response gate now proves that document load can precede workspace readiness; the test waits for the
observed connected state under its unchanged owning deadline, reports startup failures directly, and retains every
disabled/enabled, saved-state and error assertion. This exercises initialization ordering without sleeps or retries.

The same local run exposed CPU oversubscription: the all-CPU CodeQL process overlapped timed CLR semantic tests,
and an ordinary observer exceeded its existing 10-second fixture budget. CodeQL now runs as an exclusive local
validation step, matching its dedicated hosted job. Barrier regressions prove it drains preceding work, excludes
other lanes, preserves subsequent concurrency and continues all functional lanes after an analysis failure. Native
parity assertions, fixture budgets and production timeout behavior are unchanged.

Strict acceptance also caught implementation drift caused by the concurrent SDK-lock test itself: its temporary
portal and runtime state were written beside generated SDK output in the watched toolkit tree. The fixture now
keeps them under that output's existing `obj` exclusion. A before/after implementation-hash assertion reproduced
the old drift and passes with the corrected layout. The evidence suite and synthetic acceptance recipe pass together;
implementation-drift rejection, locked-file checks and every deliberate acceptance-failure variant remain active.

An Ubuntu browser job also exhausted its deadline before tests: the hosted APT mirror fell back for release metadata
but stalled on package indexes. Hosted Linux browser preparation now replaces only the exact Azure archive token
with the working official HTTPS archive, preserves other sources/priorities, and sets bounded transport retries and
timeouts. Incomplete index updates fail explicitly. Non-hosted machines retain their package configuration. A real
loopback APT timeout regression exercises failure without changing system packages or contacting external mirrors.

Full-source Sonar review found two new maintainability findings: split declared-primary-field construction from
the table projection, and make JSON wire normalization explicit for pack results. The latter is serialization,
not a generic deep clone: Date/toJSON, omitted properties and non-finite numbers must match the response and saved
receipt. A regression checks these values, duplicate receipts and rollback on an unserializable result.

The other 69 findings reproduce reviewed false positives on the reported release. All match the same rule,
component, message, issue hash and unchanged surrounding source; 67 also retain the exact range, with two shifted
by the metadata-snapshot callback. Of these, 66 have identical complete files; the other three have unrelated
metadata callback changes. Review retained the necessary checks rather than changing native/security assertions:

| Finding family            | Count | Current-source evidence                                                                                                                                  |
| ------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S3403 comparisons         | 37    | Optional captures, missing map/array keys, mutable state, defaulted public inputs and native value unions retain both possible outcomes.                 |
| S2259 nullability         | 8     | Caller admission, successful initialization, short-circuit guards and throwing parsers protect the dereferences.                                         |
| S3782 arguments           | 5     | Numeric branches are filtered/lazy; `String.slice` explicitly permits an omitted/undefined end.                                                          |
| S5869 character classes   | 6     | Non-whitespace and the four whitespace line terminators are disjoint; the negated class intentionally admits only horizontal whitespace.                 |
| S8786 regular expressions | 2     | Bounded XML input ends at a tag close; the anchored multipart expression accepts every remaining byte as body, preventing repeated failing suffix scans. |
| S4123 promises            | 4     | Injected principals, pending storage flushes and CDP body operations can be asynchronous; completion is observable.                                      |
| S4036 executable lookup   | 2     | The developer/CI verifier invokes fixed `git` arguments without a shell or request-controlled toolchain.                                                 |
| S5332 parser base         | 2     | The `.invalid` HTTP origin is an inert URL parser/equality sentinel; only validated relative paths are retained, without network access.                 |
| S2189 / S1994 loops       | 2     | Closing-tag position and fetched record count advance; exhausted/empty pages terminate pagination.                                                       |
| S2187 test registration   | 1     | The shared storage contract registers real tests against the loopback authenticated transport.                                                           |

The existing dispositions are carried to this branch only for those exact matches. No analysis rules, coverage
lanes, thresholds, native parity assertions or security assertions are removed or weakened.

Final API review reproduced two additional security failures with invented data: a pack handler could read and mutate
the internal write-result row, and an exported server-logic Create response exposed a protected value assigned by a
plug-in. Pack mutators now return detached keys, with explicit reads retaining table permissions and column masks.
The server-logic response applies the current column-read projection. Regressions verify attempted result tampering,
create/update/delete acknowledgments, denied reads and rollback, masked reads, newly granted read access, and unchanged
stored protected values. Existing exact-numeric connector responses and authorization assertions remain intact.

## 0.9.7

### Improved

- Share selected-element evidence between Inspect and X-ray, with independent owner/source certainty,
  explicit alternatives, search limits and served/executed distinctions.
- Retain one-shot selections while hidden; clear detached nodes and navigated frames, reject stale updates,
  and preserve keyboard focus and disclosures across redraws.
- Validate evidence source identity and revisions before opening; label candidate actions explicitly and disable stale links.
  Recheck local content after the final browser selection check so a save during that check cannot open a stale location.
- Trace Power Pages rendering to the actual template, snippet, page field and platform component, retaining language,
  deployment profile and record identity across shared export files.
- Resolve model-driven forms, views, columns and control placements from Solution metadata and current browser observations;
  keep generated controls and unavailable definitions explicit.
- Link script-created DOM to acknowledged local implementation bytes and observed creation, clone or insertion callsites.
- Keep ordinary Mirage project stop hints readable across Windows shells while preserving directory and special-path handling.
- Add model-driven JavaScript/CSS debugger maps. To serve original asset bytes, set `mirage.sourceMaps: false`
  on the catalogue site, or `sourceMaps: false` in a Mirage project, and restart. Lense overlay source maps are
  configured separately; see [configuration](configuration.md).

### Fixed

- Fix native model-driven startup hangs and cancellation; honor the configured editor for source opening.
- Guard corrective startup navigation when a tab loads before interception attaches. Preserve edited controls and
  observed rich-text edits, cancel an owned corrective load if typing begins before it commits, keep newer
  documents intact, and report when a manual reload is needed. Clean popups still receive a one-time GET repair
  across initial blank-page and rapid document transitions; form submissions are never replayed.
- Preserve runtime selection and literal paths in Mirage stop commands across CMD, PowerShell and POSIX shells.
  Keep recorded ownership when project mappings change or portals are renamed or removed, so copied stop commands
  cannot select a same-source sibling runtime.
- Reject pipes and other nonregular external stop-command payloads before reading, preventing copied commands from hanging.
- Report disabled-preview edits requiring deployment and reveal Tweaks scenario/preset confirmations.
- Clear grid loading notices after completion, cancellation or failure; restore alternating column sort direction.
- Retain demo view/search through reload and history, include demo agent guidance and test dependencies,
  and clarify preset `personaRoles` behavior.

### Contributor validation

- Keep the required `CI gate` name stable and validate the complete PR diff on every edit, including description
  edits. Check effective PR merge readiness with `npm run check:pr -- --pr <number>`; a blocked PR cannot qualify
  from historical successful jobs alone.
- Report all CodeQL configurations present on main for every PR, including unchanged languages and documentation-only
  changes, so a successful security workflow cannot omit analyses required for merge protection.
- Explicit `npm run validate` and `ci:verify -- --full` always execute fresh. Starting verification revokes the previous
  receipt; a failed audit, preparation step or suite cannot leave an earlier qualifying pass. Cached pre-push reuse
  rechecks the source tree, toolchain and fixtures after dependency audits.
- Panel regressions wait for actual intercepted-request replies, including delayed source metadata reads, while
  retaining paused, online and local-response assertions without fixed-sleep timing assumptions.
- Keep the original concurrent API regression and add a deterministic paused-commit test for queued writes and reads,
  preserved sibling values and stale ETag rejection. Requests share the existing bounded test deadline and identify
  the failing method/path, avoiding independent ten-second fetch timers that expire on busy hosted Windows runners.
  This improves test reliability without changing production transaction semantics.

Update with `npm install --save-dev paqvilo@^0.9.7` and commit the lockfile.

## 0.9.6

This release runs much more of the Power Platform locally: a simulated Dataverse organization with its Web API,
model-driven and canvas apps from Solutions, and the automation around them. Setup and the simulator workspace are
redesigned, and Lense works on model-driven apps.

### New

- **Dataverse Web API:** a local organization API with OAuth (client secret, certificate and delegated flows),
  security roles, teams, sharing, column security, `$batch`, `$metadata`, change tracking, file and image columns,
  metadata writes, platform messages and a read-only TDS (SQL) endpoint. It can run without a Power Pages export.
  See [Dataverse API](../mirage/docs/dataverse-api.md) and [apps and APIs without a portal](../mirage/docs/standalone-organization.md).
- **Model-driven apps:** apps from your Solutions open at `/main.aspx` with their forms, views, dashboards, ribbon
  commands, web resources, PCF controls and the `Xrm` client API, including mobile offline. See
  [model-driven apps](../mirage/docs/model-driven-apps.md) and [client API](../mirage/docs/model-driven-client-api.md).
- **Canvas and code apps:** canvas apps run headlessly on Mirage's Power Fx interpreter, which also evaluates formula
  columns, Dataverse Functions and low-code plug-ins; code apps get a local client-library bridge. See
  [canvas apps](../mirage/docs/canvas-apps.md) and [code apps](../mirage/docs/code-apps.md).
- **Automation:** plug-ins, cloud flows, classic workflows, custom connectors and background jobs run against the
  local organization, with jobs committed in the triggering transaction. See [operations](../mirage/docs/operations.md)
  and [plug-ins](../mirage/docs/dataverse-plugins.md).
- **Platform services:** Azurite blob storage, the Service Bus emulator, the outbox, SharePoint document adapters and
  fixtures for services Paqvilo does not execute. See [platform stack](../mirage/docs/platform-stack.md).
- **Enhanced authorization:** sites on the enhanced Power Pages authorization model use mapped Dataverse users, roles
  and column security locally.
- **Model-driven Lense:** the Lense panel, Inspect, X-ray and Explore work on model-driven apps and name the table,
  column, form and view behind what you select. An **Actions** tab adds inspection, navigation, diagnostics,
  reversible form overrides and Web API request impersonation. See [model-driven actions](model-driven-actions.md).
- **Quick setup:** `/_setup/` starts with five plain steps that find your exports, write the configuration and start
  the preview without a terminal; **All settings** covers every key. See [setup](setup.md#quick-setup).
- **Simulator workspace:** `/_sim/` opens on an Infrastructure view with a live system map, activity and diagnostics,
  and adds Providers & services, Flows & jobs, Capabilities & preflight and Data packs. Setup and `/_sim/` share one
  shell. See [simulation administration](../mirage/docs/sim-administration.md).

### Improved

- X-ray identifies sources faster on large exports, inspects same-origin frames in place and never activates a control
  inside a frame.
- Large Solutions and data sets start and load their first catalogue several times faster; startup reports its
  progress and can be cancelled.
- Portal lists, subgrids and lookups resolve bare-ID lookups; portal reads mask secured columns as Dataverse does.
- New projects set up dependencies and browsers explicitly, and readiness checks no longer treat an empty starter as
  tested.
- Acceptance runners can observe request lifecycles; reference parity accepts explicit local visitors.
- **Contributor checks:** local validation and GitHub Actions share dependency-aware suite selection. Isolated Lense
  overlay changes select Lense tests; shared changes expand the selection, and main, release and manual full runs
  cover every suite. Strict ESLint 10, Prettier and workflow checks run before commits against the staged sources.
  Formatting writes files atomically and rejects conflicting editor saves. See [contributing](../CONTRIBUTING.md).
- **Test reliability:** browser fixtures close their browser connections before stopping local servers, avoiding
  teardown hangs in CI.

### Fixed

- JSON `$batch` change sets keep their atomicity when requests depend on each other.
- Changed settings no longer reuse a running preview started with the old ones.
- Localized Solution labels apply to tabs, sections and nested quick forms.
- Setup and `/_sim/` fit narrow screens, and the system map no longer overlaps labels or tooltips.
- Setup preserves unchanged YAML scalar formatting, flow collections and comments when saving other settings.
- Exported JavaScript server logic allows separately bounded worker startup on busy hosts while retaining its
  script execution limits.

### Upgrade notes

Node.js **24.22.1 or a newer 24.x release** is required; Node 22 is no longer supported. Toolkit contributors use
Node 24.22.1 with npm 11.19.1 and run `npm run setup:repo` to prepare checks and install Git hooks. Mirage and example
validation use the pinned .NET SDK 10.0.113. Platform compatibility libraries retain their required versions.

Update with `npm install --save-dev paqvilo@^0.9.6` and commit the lockfile. Model-driven Lense runs project scripts
in the live app, so it requires `modelDriven.trustedExtensions: true` in the project file. Turn the model-driven surface
off with `modelDriven.enabled: false`. Reference reads still require explicit authorization and the intended signed-in
browser.

## 0.9.5

This release fixes what the recorded walkthroughs and a documentation review surfaced, and
adds an illustrated guide to the project site.

### Changed

- **Demo:** the reader persona is Alex Demo 01 everywhere; the access-denied and page-not-found
  pages no longer reference a missing image; narrow viewports keep their side padding; `yaml`
  and `playwright-core` are declared so `npm test` passes in a fresh demo; the VS Code launch
  configurations use `msedge` with source-map resolution and no path mapping; Solution roots
  are listed in dependency order; the copied scaffold uses LF line endings so a Git baseline
  matches the served bytes.
- **Lense panel and X-ray:** hold **Ctrl** (previously Alt) to use the portal while X-ray is on;
  the Details button reports its state; the card shows code-component bindings and Web API
  page context; the header links to Project setup and, in Mirage, to Manage data and personas;
  a save toast is not replayed when you switch Online / Local.
- **Inspect:** Forms & controls lists the modal forms configured by a list's actions.
- **Setup workspace:** a form save writes only the fields you changed and keeps the original
  scalar formatting and comments; the workspace links back to the running portal.
- **Mirage:** DateOnly values keep their calendar date on non-UTC hosts; saving a configuration
  preset, or re-applying one already in effect, no longer reloads open pages; stale per-port
  session cookies are dropped from toolkit browser profiles.
- **Documentation and CLI help:** the page is called Backend operations; Alt+Shift+O and
  Alt+Shift+L are documented; the `markup` setting is documented; `agent pages` fields, the
  debugger port, plugin DLL execution and Windows long paths are described as implemented;
  counts, setting names and `paqvilo mirage --help` examples are corrected; statements about
  future versions and deprecation windows are removed.
- **Site:** an interactive guide with clips and stills from the recorded walkthroughs.

### Upgrade notes

Update with `npm install --save-dev paqvilo@^0.9.5` and commit the lockfile. If you relied on
Alt to interact with the portal while X-ray is on, use Ctrl.

## 0.9.4

This release expands project configuration, improves local rendering and makes large
datasets and automated testing more practical.

### New

- **Project setup:** `paqvilo init` creates an empty project with packs, tests and editor
  tasks. `paqvilo setup --open` provides a local configuration workspace.
- **Personas and scenarios:** grouped, searchable persona catalogues, isolated setups,
  deployment profiles and project-owned settings, snippet and presentation overrides.
- **Public APIs:** supported runtime, pack, fixture, acceptance, testing, Lense and
  Dataverse entry points. `createMirageContext` binds packs once; `connectRuntime` and
  session helpers support independent visitors and concurrent tests.
- **Shell capture:** `paqvilo mirage capture-shell` captures platform styles using a
  temporary browser or an existing loopback browser connection. Reports identify missing,
  excluded and blocking resources.
- **Dataverse tooling:** a separate API and CLI for project-owned schema/data provisioning,
  comparison and solution exports. These are explicit operations, separate from previews.

### Improved

- Forms, lists, lookups, quick views, modal dialogs, multistep navigation, attachments and
  validation use more of the exported configuration. The [native component baseline](baseline.md)
  provides reusable fixtures and comparison tools; it does not certify complete parity.
- Liquid, FetchXML, permissions, PCF, supported local plugins and flows have broader
  regression coverage and clearer diagnostics for unsupported behavior.
- Large states use streamed checkpoints and durable row journals. Ordinary writes avoid
  rewriting every record. Acceptance handles document replacement and bounded settling.
- npm installations pass readiness checks without a second dependency install. CLI help,
  runtime status, worktree paths and the local demo have been refreshed.

### Fixed

- Unknown navigation bindings are rejected atomically under association enforcement.
- Footer spacing repairs respect clipping and modal layers and restore the original layout.
- Capture recognizes platform-provided jQuery and distinguishes broken native resources
  from local capture failures.
- DateOnly storage is distinguished from date-only display. Fractional seconds truncate;
  independent values avoid UserLocal shifts. Evidenced month-first parsing and seasonal
  formatting profiles are available for sites that need them.
- Migration and preset persistence preserve local edits and explicit definitions. Concurrent
  browser identities remain isolated; Windows state reads do not invalidate writer ownership.
- Staged attachments belong to their browser and persona, survive failed saves and are
  consumed once. Editor refresh preserves project scripts and validates debugger settings.
- Administration preserves active inputs, selections and drafts while background data loads.
- Inactive plugin steps preserve scoped-create behavior and efficient row persistence.
  Executing trusted handlers retain authorization and transaction safeguards.
- Persona pages follow group order and keep the default reachable. Saved configuration
  collisions remain manageable; linked configuration can be applied explicitly at startup.
- Acceptance and parity settling distinguish hash/history changes from document commits,
  and redirects share one bounded navigation wait.
- Native checkboxes save Boolean values using the platform's posted-control semantics.
  Solution date-only display and configured minimum-date errors retain their source meaning.
- X-ray source matches compare container modifiers and complete class lists, keep ambiguous
  snippets as possible matches, and reuse unchanged inspection reports and source hints.
  Element picks consume the full mouse or touch gesture before reopening the panel.
- Content-policy provenance survives unrelated configuration edits. Persona shortcuts,
  permission diagnostics, dialog reporting and CLI argument errors are more consistent.

### Upgrade notes

The published version line is **0.9.x**. Projects pinned to old checkout versions such as
`^1` or `1.2.0` must change that range explicitly.

For previews, follow [branch package installation](branch-packages.md). Update to stable
0.9.4 with `npm install --save-dev paqvilo@^0.9.4`, commit the lockfile and
run your project tests. Use your existing dependency category if it differs.

Large state files may use a format older releases cannot read. Back up state before
upgrading and use `readStateFile` rather than `JSON.parse`; see [state storage](../mirage/docs/state-storage.md).
Deep imports such as `paqvilo/mirage/lib/data.mjs` are not supported entry points; use the
[public API](public-api.md).

Mirage implements selected platform contracts. Validate critical project scenarios against
Power Pages; see [coverage](coverage.md) and the relevant [runtime reference](../mirage/docs/README.md).
