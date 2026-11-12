# Release notes

## 0.9.8

This release lets you see and debug what the local runtime does: every request becomes a trace, original C#
plug-ins stop at breakpoints in VS Code, and a new analyzer reviews your Power Platform sources. Canvas apps
get a local player, Code Apps get a managed multi-app workflow, and the .NET Framework SDK can read a local
organization's metadata. Large datasets use far less memory.

### New

- **Request tracing and Monitor.** Each request becomes one tree of steps: the HTTP call, portal Web API,
  table permissions, the Dataverse operation, plug-in stages and steps with their trace lines, web hooks, jobs,
  workflows, cloud flow runs and connectors, and the page render. The `_sim` **Monitor** has **Health** and
  **Activity** views with filters, step search, side-by-side comparison and stats. Read traces with
  `paqvilo mirage trace`, `/_sim/api/trace` or `connectRuntime().trace`, and export JSON, NDJSON or OTLP.
  `mirage.trace.level` sets the level: `off`, `summary` (default) or `full` with redacted payloads. See
  [request tracing](../mirage/docs/tracing.md).
- **Debug original C# plug-ins.** Point a trusted plug-in descriptor at your Debug DLL and PDB, build, restart
  Mirage, trigger the operation and attach Microsoft's C# debugger in VS Code. A descriptor can set
  `defaultMode: 'clr'` so its step runs the original assembly on every start. See
  [debug original C# in VS Code](../mirage/docs/dataverse-plugins.md#debug-original-c-in-vs-code).
- **`paqvilo analyze` and Doctor guidance.** 126 rules check Dataverse and ALM, model-driven apps, Canvas, PCF,
  Code Apps, cloud flows, connectors, MCP, mobile declarations and Power Pages. Point it at a folder or a
  project; no portal catalogue is needed. Findings are errors, warnings or hints. Doctor stays advisory unless
  you set a threshold. Nothing is built or executed and no tenant is contacted. See
  [static analysis](static-analysis.md).
- **Canvas player.** `/_apps/canvas/<app>` runs a Canvas app from its exported source: controls, Power Fx,
  components, PCF, media, galleries and local data, with an inspector for source locations, state and errors.
  Source edits reload the app. Start opens a new instance, `Notify` honours its timeout and survives reload, the
  native `Form.Unsaved` is true only after input, and PCF resources are served from the apps address at
  `/_apps/canvas/pcf/<token>/`. A visitor without a Dataverse user answers 401 `CanvasPrincipalRequired`.
  See [Canvas apps](../mirage/docs/canvas-apps.md).
- **Code Apps development.** `mirage dev` starts your app servers, opens a workbench to switch between apps and
  set parameters, and shows connections and requests. The Vite plug-in keeps the Microsoft SDK's `/app` and
  `/data` imports working against Mirage, with HMR and source breakpoints. See
  [Code Apps](../mirage/docs/code-apps.md#develop-sdk-apps-with-vite-and-the-workbench).
- **`CrmServiceClient` (.NET Framework).** The SOAP Organization service answers organization and metadata
  messages in the .NET Framework SDK's contracts, so `CrmServiceClient`, the client XrmToolBox uses, connects
  through `AuthOverrideHook` and reads metadata. See
  [Dataverse API](../mirage/docs/dataverse-api.md#soap-organization-service).
- **Connector definitions.** A data pack can register captured Swagger 2.0 connector definitions. Calls are
  matched by operation ID or method and path, and inputs are validated before your provider runs. See
  [data packs](../mirage/docs/data-packs.md).
- **Test data tooling.** `paqvilo/mirage/fixtures` and `paqvilo/mirage/testing` generate datasets from your
  schema, remap identities and relationships, report coverage, emit TypeScript declarations and compare
  permission models and plug-in registrations. See [public API](public-api.md).
- **Large generated datasets.** `createOwned()` preset factories stream rows into compressed, checksummed record
  pages beside the state file. Existing `load()` presets are unchanged. See
  [generated record storage](../mirage/docs/record-storage.md).
- **Pack transactions.** Opt-in, authenticated, local-only pack endpoints write records with declared targets,
  rollback, concurrency checks and idempotency receipts. See
  [data packs](../mirage/docs/data-packs.md#authenticated-local-endpoint-writes).
- **Single-page application registrations.** A Dataverse API application registration with `publicClient: true`
  takes `spaRedirectUris`. An authorization request to one needs PKCE with `S256`. Its code and refresh token
  are redeemed from that URI's origin, and the response names that origin in `Access-Control-Allow-Origin`.
  See [Dataverse API](../mirage/docs/dataverse-api.md).
- **Approval types.** Approval actions model Basic, AwaitAll, Custom and CustomAwaitAll. A responder must be an
  assignee, and the `/_sim/` flows view lists the approval's response options and an assignee picker.
- **Excel export.** The grid action `download-as-excel` returns an `.xlsx` workbook with typed cells on one
  sheet.

### Improved

- **Administration and apps on their own addresses.** `/_sim/` and `/_setup/` are served on their own loopback
  port, printed as `adminUrl`. On the Power Pages host, the model-driven, Canvas and Code Apps surfaces are
  served on another, printed as `appsUrl`; the standalone host serves its apps on its main address. Opening
  them on the portal address in a browser redirects there (a document) or answers 403 `AdminOriginRequired`
  or `AppsOriginRequired` (any other request). A request whose `Host` is not the listener's own address
  answers 403 `INVALID_REQUEST`. Scripts in portal pages cannot read or change the administration or call the
  apps. The administration token (`csrf`) differs from the portal's anti-forgery token (`portalToken`) and
  from the apps token (`appsToken`); the administration token is accepted wherever either of them is. Clients
  that send neither `Sec-Fetch-Site` nor `Origin`, such as Node `fetch`, `connectRuntime` and the CLI, use
  `/_sim/api` on the portal address with `csrf`. A persona with its own setup (a context persona) opens from
  the administration, and the sign-in picker on the portal links there; the persona catalogue served to portal
  pages carries the names of a context's variables, snippets and settings without their values. The
  administration signs a browser in through the portal with a single-use link. See
  [administration](../mirage/docs/sim-administration.md).
- **Plug-in parity.** Reads, images, shared variables, parent contexts, request IDs, tags, async targets and
  SOAP serialization follow native behavior more closely. JavaScript plug-ins receive `sharedVariables`. This
  does not make Mirage complete Dataverse parity; see
  [plug-in execution boundaries](../mirage/docs/dataverse-plugins.md#execution-boundaries).
- **Model-driven apps.** Apps load only the navigation and the selected table's metadata; other tables arrive
  when a lookup or subgrid needs them. Counts above 5,000 show as `5000+`. Side panes, form and choice
  contracts, PCF resize, ribbon labels and requirement levels behave more like the platform.
- **Flows.** Stricter expression parsing with diagnostics (`inspectFlowExpression`), more functions, exact UTC
  `ticks`, JSON Schema for request inputs and ParseJson, and trigger conditions evaluated before a run starts. A
  run has a deadline only when `limits.timeoutMs` is set. `utcNow`, `formatDateTime`, `addToTime`,
  `subtractFromTime`, `startOfDay`, `startOfHour`, `startOfMonth`, `dayOfWeek`, `dayOfMonth`, `dayOfYear`, `guid`
  and the tick-span functions (`addDays`, `addHours` and the like) evaluate on the run's clock. Failed runs show
  their reason in `/_sim/`. `CancelAllCloudFlowRuns` cancels through the record pipeline.
- **Performance at scale.** A row write no longer scales with the size of the solution. Startup, restarts,
  status polling and the full catalogue use less memory and stream their output. Qualified with invented data
  up to 100 million records.
- **Lense source attribution.** Open source finds custom grid columns, basic forms, quick views, modals and
  rich-text frames more reliably, and keeps unresolved cases explicit.
- **`_sim` layout.** Every view shares one layout: breadcrumb, toolbar, filter drawer and one table style. It
  works at phone width and follows the browser's dark mode.
- **CLI.** Commands validate their arguments before any file, browser or PAC work. JSON errors go to stdout and
  readable errors to stderr. Report paths cannot overwrite inputs or credentials.
- **Column security.** A column marked not valid for read is hidden from every read path: Web API projections,
  FetchXML attributes and conditions, `$apply`, SOAP and TDS. Using one as an operand answers the error that an
  unknown column gets. The secure configuration of plug-in steps, service endpoints and the plug-in trace log
  are readable by administrators and customizers only.
- **Message authorization.** Add-on messages (Power Virtual Agents, feature control, knowledge search, email
  templates, work queues, bound flow messages, business process flow reports) check privileges and the caller's
  read access to their target rows. `Restore` applies field security and lookup checks like `Create`.
  `ReassignObjectsOwner` and team moves stamp the caller and advance the row version.
- **Solution import and uninstall.** A staged upgrade answers 400 `InvalidRequest` when either solution is
  unmanaged, so `DeleteAndPromote` cannot delete unmanaged tables or rows. `ImportJobId` must be a GUID that no
  import job uses. Uninstalling a solution removes the message and filter of a custom API it contained.
- **Custom APIs.** Deleting a custom API while a plug-in step is registered on its message answers 405 with
  `0x80040227`; after the step is deleted, deleting the API removes its message and filter. A second custom API
  with the same unique name answers 400 with `0x80072013`. This matches the behaviour observed on a native
  environment.
- **Notes and files.** A failed write of a note body, file, image or chunk answers 503. The saved row keeps its
  body inline until the blob write succeeds.
- **TDS.** `decimal`, `money` and `datetime` values are returned, `nvarchar` defaults to 4000 or `max`, a
  statement that builds more than 1,000,000 intermediate rows answers error 40000, and long queries yield so the
  time limit and cancel apply. Pre-login packets over 64 KiB are refused.
- **SOAP Organization service.** Decimal and money values keep their exact digits, an untyped `entity` element
  is decoded, and every message validates its required inputs.
- **Web API and FetchXML.** Paging cookies continue past boolean and untyped numeric order columns, `count="0"`
  returns no rows, a bare id binds to a polymorphic lookup, `$expand=transactioncurrencyid` is kept, and money
  columns read in the row's own currency with `exchangerate` and `_base` values. Metadata `$filter` and
  `$expand` depth is limited to 100. Paging links carry the address of the listener that served the request.
- **Column types.** Multi-select columns report `AttributeType` 17 (Virtual) and partylist columns 10. Liquid
  `attribute_type` returns the documented `AttributeTypeCode` names (`DateTime`, `Lookup`), and
  `AttributeTypeName` keeps the `...Type` names. Liquid renders a multi-select column as its labels on every
  path, related rows included. A table that only a mapping declares reports its typed columns to forms, grids
  and layouts.
- **Power Fx.** A regular expression that can backtrack without bound is stopped by a hang guard
  (`host.regexGuardMs`, default 10,000 ms) and answers a Power Fx error. One scope counter covers a formula and
  the component functions it calls. `Distinct` runs in linear time, `DateValue` follows the language argument, and
  `Date` accepts years before 1900.
- **Model-driven client API.** A refused `data.save()` rejects with a plain object holding `errorCode`, `code`,
  `message` and `title` (2200000005 when OnSave prevents the save, 2200000007 when a required column is empty,
  2200000003 when a save is in flight). The form context survives a save, `entity.save('saveandnew')` opens a
  blank create form, OnLoad reports load state 1, 2 or 3, and OnChange `getEventArgs()` returns `undefined`.
  This matches the behaviour observed on a native environment. See
  [client API](../mirage/docs/model-driven-client-api.md).
- **Model-driven forms and grids.** Date Only columns show a date picker, Two Options columns without labels
  render as a toggle, the list search matches the start of the Quick Find columns (lookup and choice columns by
  label), a missing form ID is refused with `FormUnavailable`, and the command bar fits phone width.
- **Code Apps.** Connector calls wait up to 120 s by default. A Windows `.cmd` or `.bat` dev-server command
  runs through the command interpreter with its arguments escaped. `devServer.timeoutMs` (1000 to 300000, default 120000) bounds a server that never becomes ready, and a dev server that exits is reported with its own status.
  The Vite proxy refuses cross-site requests. `PAQVILO_MIRAGE_URL` is the address that serves the Code Apps
  surface (`appsUrl` on the Power Pages host). The `/_sim/` staff session panel selects the user for Canvas and
  Code Apps.
- **Liquid and portal rendering.** An `include` of a missing template renders `Template "<name>" not found.` as
  escaped text, never as Liquid. Only the first `entityform` or `webform` tag of a page renders and the others
  report a diagnostic. `request.params` includes cookies, and the renderer uses the runtime clock. A file name
  outside Latin-1 uploads intact through `x-ms-file-name-encoding: uri-component`. A basic form's validation
  message is inserted without HTML encoding, with summary links on or off, as observed on a native site.
- **Plug-ins.** A pooled C# host that died while idle is replaced on the next call. `RelatedEntitiesQuery` and
  N:1 related queries survive the `Retrieve` pipeline, a Delete step runs as the SYSTEM user, and queue sequence
  numbers are kept per entity in `paqvilo_queuesequence`.
- **Redaction.** Audit and trace redaction covers connection strings, URL credentials and unclosed secret
  conditions.
- **Lense start-up.** `--startup-timeout <ms>` (default 120000, cap 600000) bounds the silence without progress,
  not the total start-up time, for `mirage start`, `mirage dev` and `model-driven dev`. Closing the browser
  during start-up stops the command. A second `mirage start` on a state file that a running Mirage uses with
  different settings is refused and names the pid.
- **Lense stop and interrupts.** `mirage stop` exits with status 2 when a selected session could not be verified
  and was kept. `verify` ends at its next wait on Ctrl+C, SIGINT or SIGTERM, writes its report with `errorCode`
  `VERIFY_INTERRUPTED`, cleans up and exits 1; a third interrupt while cleanup runs ends the process with status
  130 (SIGINT) or 143 (SIGTERM), as it does for `dev`, `mirage` and `model-driven`.
- **Lense agent API.** `agent sessions --timeout <ms>` (2000 to 120000, default 35000) sets the probe budget for
  each session file. A model-driven agent API serves one target origin: it survives a sign-in redirect and is
  retired when the target switches to another origin.
- **Lense catalogue commands.** The documented `PAQVILO_*` tool variables do not break catalogue commands,
  repeated options share one parser, and `--help` lists every option.
- **Dataverse CLI.** A remote `dataverse plan` lists the membership writes and blocked roots that `apply` makes,
  and `apply` refuses blocked roots before its first write. Reads retry on 429 and 503.
- **`paqvilo analyze`.** UTF-8 byte-order marks parse, plug-in rules read the SDK message ID, form rules know
  the standard columns of standard tables, unreadable configuration reports its own error code, and a Canvas
  source that the runtime plays is accepted.
- **Baseline capture.** Live writes need `--allow-writes`, including the cache refresh and clear-cache steps,
  and a live capture names its scenarios with `--only` or `--all-scenarios`. Sign-in callback bodies, identity
  tokens and hidden credential inputs are redacted, and popups are covered by the write guard.

### Fixed

- Acceptance observation works with script-disabled sandboxed frames, including the compatibility rich-text editor.
  Authored script, console, page and HTTP failures still fail acceptance.
- Standalone Mirage tools accept their own options before or after `--help` / `-h`. Help reads no inputs and runs
  nothing.
- Moving a record directory to a new owner retries Windows sharing errors with bounded backoff instead of failing
  after a fixed short window. Lease updates retry briefly, so a request's write waits well under a second.
- Updates no longer fail when exported audit relationships stamp modifier fields.
- Default grids work on partial Solution exports whose primary name column is declared but not exported.
- A server-logic Create response no longer exposes a column that column security hides.
- Absent or empty enhanced payloads are reported as missing (`PAQ-SOURCE-002`), not as syntax errors.
- A configuration assignment recovers from one dropped connection (`ECONNRESET`); record writes are never replayed.
- Code app module scripts run in document order, and the workbench keeps query parameters across dev-server reloads.
- A malformed Canvas control version can no longer hang the runtime; FetchXML and form XML scan in linear time.
- Code app servers finish writing their output before shutdown is reported.
- The rich-text compatibility editor sanitizes content with DOMPurify and keeps tables and paragraphs across saves.
- `verify` cleanup waits for Windows to release the browser profile.
- The temporary Edge browser used for shell capture no longer signs in to the Windows Microsoft account.
- A missing record page file stops the start with `StateIntegrity` and leaves the state file untouched; the saved
  state is no longer replaced by a new one.
- A `like` pattern with many wildcards (FetchXML, OData string functions, T-SQL `LIKE` and `PATINDEX`) can no longer
  hang the runtime, and a malformed character set no longer answers an unexpected error.
- TDS `GO <count>` accepts up to 1,000 repeats and honours the query time limit.
- `$filter` expressions nested deeper than 100 levels answer 400 instead of an unexpected error.
- A sign-in or sign-out `returnUrl` with dot segments can no longer redirect off the site. A forged `//host` or
  backslash `returnUrl` and encoded dot segments cannot redirect off the site.
- `paqvilo analyze` reviews portal pages, templates and web resources in folders named like build output (`metrics`,
  `build`, `dist`), runs from a checkout under such a folder, and no longer reports an unpacked solution as
  incomplete because of ribbon, formula or web resource content files. The text report names every skipped source.
- `lense list --settings` and the `verify` sign-in message no longer print credentials or query values from URLs.
  Invitation codes are redacted in traces and audit records.
- Switching the model-driven target on a slow or loaded machine no longer ends the dev session and closes the
  browser: retiring a target waits for the browser to finish its cleanup.
- The panel's Tweaks tab recovers on its own when a read of the local runtime is slow or dropped, and returning to a
  portal that was visited before refreshes its runtime summary.
- `lense verify` reads the displayed document when the start page reloads itself or returns from a sign-in round trip
  on the same address.
- A span opened after its trace left the retained set no longer recreates a partial trace under the same id.
- Plug-in packages with overlapping ZIP entries or content beyond the local size limit are refused, and deeply
  nested or deeply derived types no longer exhaust the assembly reader.
- The Service Bus emulator transport connects only to addresses that resolved to loopback, trying each in turn.
- A monthly flow recurrence on a day that short months lack skips those months in UTC as in every other time zone.
- Two Code Apps that Paqvilo starts on the same dev-server address are refused at start.
- A Power Fx record field named `__proto__` keeps its value, and a formula that enters more than 5,000,000 row
  scopes stops with `PowerFxLimitExceeded` (`host.scopeBudget` changes the limit).
- Offline data generation and scaffolding answer existing keys of a paged table from its key index instead of
  loading every key.
- An interrupted setup save no longer blocks later saves: a lock left by a stopped process is removed.
- The `_sim` top bar keeps the page title readable at tablet width, and `mirage serve` reports the `/_sim/` address.
- A request to `/_sim/api/presets/<name>` with the name of an inherited object property answers 404.
- Shutdown does not wait for a stalled request body: a body without progress for 30 s is dropped, and accepted
  streaming requests are drained.

### Upgrade notes

- Tracing is on at `summary`. Set `mirage.trace.level: off` to turn it off.
- The old `_sim` addresses `#dashboard`, `#logs`, `#audit`, `#trace` and `#evidence` redirect to Monitor with their
  filters; `#overview` opens Home.
- The CLI now rejects extra or misplaced arguments that it used to ignore. Check scripts that call it.
- The administration and the apps are reached on `adminUrl` and `appsUrl`. A script that sends `Origin` or
  `Sec-Fetch-Site` to `/_sim/` or `/_apps/` on the portal address gets 403 `AdminOriginRequired` or
  `AppsOriginRequired`: point it at the printed addresses. Clients without those headers keep the portal address.
- `handle.csrf` is the administration token; the portal form token is `handle.portalToken`, and the apps token is
  `handle.appsToken`.
- Delete the plug-in steps of a custom API's message before deleting the API: the delete answers 405
  `0x80040227` while a step is registered.
- Browser session cookies are saved per portal scope in `<profile>.session.<hash>.json`. An unscoped
  `<profile>.session.json` is deleted and never read, so a headed `verify --signed-in` signs in once more.
- A staged upgrade of an unmanaged solution is refused with 400; export and import managed solutions for
  upgrades.
- Live baseline captures need `--allow-writes` for cache refresh and clear-cache steps, and `--only` or
  `--all-scenarios` for every live capture.
- `mirage stop` exits 2 when it keeps a session it could not verify; scripts that read the exit status handle 2.
- Tests that pinned `AttributeType` 16 for multi-select columns or 14 for partylist columns, or `...Type`
  names from Liquid `attribute_type`, use 17, 10 and the `AttributeTypeCode` names.
- `navigationCommitReserveMs` in `runAcceptance` reserves at most half of the remaining action time for held
  writes.

### Contributor validation

- `npm run validate` and pre-push reproduce the hosted checks: CodeQL with the pinned bundle, Windows browser
  lanes in both Chromium and Edge, the hosted runner's `TEMP` alias and an empty npm cache, and the test-kind check
  against the default branch. Lanes run concurrently (`paqvilo.ci.jobs` or `PAQ_CI_JOBS`), and changed test files run
  twice more.
- Every new or changed test declares its kind with `// @test-kind`. See [test kinds](test-kinds.md).
- SonarQube analyzes branches and pull requests. It is not a required check.
- The test suite was audited: sleeps and wall-clock assertions were replaced by real signals, and slow hosts no
  longer fail tests.
- Parity is asserted by replay cases. `node scripts/parity-cases.mjs build` records cases from two or more oracle
  captures, `check` validates every case file and `report` counts cases per oracle kind. One runner replays each
  case into Mirage. A new hand-written test cannot be tagged `parity`; the tags that predate replay cases are listed in
  `scripts/parity-tags-legacy.json`, and that list only shrinks. See [test kinds](test-kinds.md).
- When the SonarQube quality gate fails, the last step of its job prints the failed conditions and the open issues in
  new code.
- `check:pr` reads the newest result of each check per workflow. The test-kind checker treats an insertion
  inside a `parity` test body as a change to it, reads runner modules that call `test(`, and runs from the staged
  snapshot. Pre-push accepts annotated tags, and `check:workflows` has pinned actionlint and ShellCheck assets
  for macOS and Linux arm64.

Update with `npm install --save-dev paqvilo@^0.9.8` and commit the lockfile.

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
