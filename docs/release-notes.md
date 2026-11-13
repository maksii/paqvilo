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
  readable errors to stderr. Report paths cannot overwrite inputs or credentials. On Linux, closing the dedicated
  browser ends `dev` with status 0 while Chromium is still exiting.
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
  body inline until the blob write succeeds. A create that names the id of a stored note is refused without changing
  the stored note's body, and the bytes of a refused write are released.
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
- Ctrl+C or SIGTERM in `dev`, `mirage dev`, `model-driven dev` and `mirage demo` runs the command's own cleanup
  (browser, Mirage, Code App dev servers, session cookies) before the command exits, including while the browser is
  still launching. A stop requested before the browser launch skips the launch. From the start of `dev` until its
  cleanup begins, for example while the dev browser launches or its sessions start, a second Ctrl+C is absorbed and a
  third ends the process at once with status 130 (143 for SIGTERM) without waiting for the launch, as a third interrupt
  during cleanup does.
- A dev command whose cleanup fails (a browser that does not close: `browser cleanup failed: <first line>`; a Mirage it
  started that could not be stopped: `mirage   could not stop pid <n>…; run: <stop command>`) reports the failure on
  stderr and exits with status 1, also when the command was interrupted.
- `mirage dev` for Code Apps and Dataverse runtimes prints `mirage   stopped <url> (pid <n>)` once the Mirage it
  started is verified stopped, as Power Pages dev does.
- Stopping a dev session or switching a model-driven target waits for a running agent screenshot (up to its
  `timeoutMs`, at most 120 s) or navigation (at most 60 s) to end.
- Retiring a model-driven target waits up to 18 s for a panel call in progress; with the page paused in a debugger a
  target switch can take up to 48 s.
- Inspect reports server logic and Web API tables that a page called after its first 250 requests as observed
  requests.
- Lense agent API: a page action sends `--timeout` as the browser deadline (navigate and reload at most 60000 ms). The
  client waits 30000 ms longer for the session's answer before it reports `request_timeout`.
- The parity suite, live acceptance flows and live baseline captures that name the browser's debugging endpoint
  (`live.cdpUrl` for captures) refuse writes of every page they drive at the browser level: the page, its popups
  (including a form posted into a new window), frames inside those pages and popups those popups open are refused from
  their first request, also when Lense or another debugging client attached to the same browser lets the page start
  first. A write whose page cannot be established (a frame removed before the browser answers, or a frame of a tab that
  is closing) is refused, in every tab of that browser. A page that is closing keeps its owner: its own close-time
  writes are decided like its other writes.
- Other tabs in that browser keep working, with two exceptions: a tab opened in that browser while a live capture runs
  counts as the capture's own, and while a live acceptance flow runs, tabs that were already open in the attached
  browser cannot write; their attempts are listed in the flow's `blockedRequests`.
- A live capture whose page did not open in the browser of `live.cdpUrl` stops with `live.cdpUrl is not the bridge
browser…` and merges no evidence. Without `live.cdpUrl` a capture reports that only the per-page guard protects it.
- The write guard reads the browser debugging endpoint with hang guards: 10 s for its version read and 30 s for the
  socket to open (`The browser debugging socket did not open.`).
- The parity suite, local and live acceptance, the Mirage side of a baseline capture and shell capture launch or
  attach to their browser under a 120 s hang guard. The dev panel opens a launched scenario runtime's first document,
  and `verify` takes its evidence screenshot, under a 120 s hang guard.
- Live acceptance: a route answer that fails is ignored only when its page or context has closed. Any other failure
  fails the run, whatever its message.
- Baseline scenarios can wait for popups with `wait: { popup: <n> }`. The step fails when fewer popups have opened
  within the step `timeout` (default 20 s).
- Baseline capture reads every finished response body before its screenshot. A body that never ends does not hold the
  capture past its settle timeout. A page the scenario did not open is not recorded.
- Baseline capture: closing the browser bridge waits for the bridge to exit. A bridge still running 60 s after its
  input ended is asked to stop, and 60 s after that it is killed.
- A TDS connection that sends nothing for 30 s before login is closed. While the client acquires its Microsoft Entra
  token after FEDAUTHINFO the limit is 15 minutes. After a rejected login the 30 s limit applies again and any further
  login on that connection closes it. After a malformed FEDAUTH token the same limit applies and the connection stays
  open for a new login.
- A connector call cancelled by its flow run or by a disconnected Code Apps client is recorded as cancelled
  (`FlowRunCancelled`), not as a timeout. A sign-in whose token write has started completes as signed in even if the
  runtime closes meanwhile.
- A cancelled custom connector script build ends its process tree before the call returns, and a failed build leaves
  no partial host assembly behind. On Linux and macOS a build still running 10 s after SIGTERM is killed.
- Closing an organization host cancels the open full-level body captures of the trace store it created; their spans
  end `cancelled`. A persona runtime that shares its parent's store leaves the parent's captures running.
- A `/_sim/` reset or `close` releases the `ImportJobId` of a staged solution job whose row it removed.
- `clrHostPoolStatus()` entries carry `session`, a serial number per pooled host.
- A CLR step's timeout starts when its host process exists, so a slow process creation no longer fails the step
  with `LocalPluginTimeout`; a host process that is not created within the 120 s hang guard, or that cannot be
  started, fails the step with 503 `LocalPluginHostUnavailable`.
- A CLR host verifies itself that the parent PID it is given is the process that created it, so no parent identity
  probe process runs before the first CLR call (it had a 30 s limit). A host that cannot bind its parent fails the
  call with 409 `LocalPluginParentUnavailable`.
- A CLR host ends when its input closes, so it ends with Mirage even when plug-in code runs on threads of its own.
- A fresh CLR host starts from its runtime's verified host executable instead of a copy written for each call, so a
  call no longer pays the first execution of a newly written executable (an on-access scan). Each call still copies
  the plug-in assembly, its dependencies and symbols, but not the SDK.
- A CLR host compile that fails at the Windows path limit (`CS1619`) names the length of the runtime cache path and
  asks for a shorter project or cache path.
- The simulator option `serverLogicTimeoutMs`, like the `timeout` of `runExportedServerLogic`, replaces the local 5 s
  server-logic limit with a value from 100 ms up to the site's `ServerLogic/TimeoutInSeconds` (default 120 s, at
  most 240 s); a smaller value becomes 100 ms and a larger one is capped at the site setting. A value that is not a
  finite number greater than 0 is refused with a `TypeError`, by `createSimulator` at start-up for the option.
- When exported server logic runs past its local time limit and the host stops it, the 504 message names the limit it
  applied, for example `Server-logic execution exceeded its local time limit of 1000 ms.`
- The local identity provider generates its signing key off the event loop when a request first needs it, so a
  runtime start does not wait for it.

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
- The panel's Tweaks tab recovers when a read of the local runtime is slow or dropped: the dev panel waits up to 60 s
  for a slow local Mirage before it shows the runtime as unavailable; a read that fails sooner, such as a dropped
  connection, is read again at once, at most three reads in all, so the Tweaks tab recovers on its own. A failure that
  remains is shown in the Tweaks tab with **Read again**, and the next navigation also reads again. Returning to a
  portal that was visited before refreshes its runtime summary.
- `lense verify` has no fixed pause after the start page loads. It reads the displayed document when the start page
  reloads itself or returns from a sign-in round trip on the same address. A start page that replaces its document
  before the edits are chosen is read again, at most three times; after that `verify` fails and names the redacted
  addresses the page went to. A redirect that a page timer starts after the edits were chosen is not detected.
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
- Mirage no longer ends with a V8 fatal error when a worker thread finishes a server logic, a CLR plug-in call, a
  synchronous I/O bridge call or a metadata compile: a worker that has answered ends by itself. Any of these but a CLR
  plug-in call's worker is terminated only when it is still running 30 s after it answered; a CLR plug-in call's
  worker is never terminated: it ends once its host's exit is reported.
- A CLR plug-in host counts as stopped only when its own exit is reported, waiting up to 120 s, not when it disappears
  within one second. A runtime or snapshot whose host is not verified stopped is kept and reported as
  `PLUGIN_CLR_CLEANUP` (`CLR host not verified stopped; runtime cache directory kept: <name>` or `…; snapshot kept:
<name>`); the runtime directory is released once the system reports no process with that host's PID.
- A snapshot file that another process still holds after its host exited is retried for up to 120 s (was 1 s) before
  `PLUGIN_CLR_CLEANUP` is reported.
- A CLR call past the plug-in depth limit starts no host.
- A pooled CLR host that ends before it reads a call fails that call as `LocalPluginHostExited` at once.
- An error on a running portal, administration or apps listener is recorded once per listener as a `LISTENER_ERROR`
  diagnostic (with `listener`) instead of ending the process.
- A failed browser launch names the profile as in use only while the browser's lock file shows a live browser on this
  machine; a launch that times out or a browser that is not installed is reported as such.
- Every step of opening the dev browser ends at the 120 s hang guard: the first window's set-up, the debugger endpoint
  query, the restore of the portal session and the detach from an attached browser that exposes more than one context,
  not only the launch. A step that fails or ends at the guard closes the browser it launched. A step that ends at the
  guard is named, for example
  `Setting up the browser window did not finish within 120000 ms. That is the browser hang guard, not a readiness deadline.`;
  any other failure is reported as the step's own error.
- Stopping Code App dev servers on Windows no longer needs System32 on PATH.
- An interrupt while `verify` or `model-driven dev` waits for the source watcher no longer leaves the command hanging.
- A start that cannot read the identity of a running Mirage keeps that runtime's ownership record instead of
  dropping it. A runtime that took over the process ID of an owner that ended while the start waited is still
  recognised as the owner.
- A save-and-new that fails after its error handling is reported to the page as an error instead of being dropped.
- The parity driver no longer stalls on a popup or frame whose first request is paused before its interception is
  acknowledged.
- A parity reference capture of a page with cross-site frames is reported settled once the page's requests and the
  requests of those frames, including frames nested inside them, have finished, instead of waiting the full settle
  limit and reporting unsettled. Frame requests still in flight are named in `pendingRequests`, and writes from nested
  frames are refused by the page's own interception.
- A parity reference capture runs the dedicated workers of the page, of its cross-site frames and of the popups it
  opens; they were held at start and never ran. A worker's requests count as its page's requests, and its writes are
  refused like the page's.
- Trace spans are dated by the wall clock and timed by a monotonic clock. After a system clock step (time sync in a
  virtual machine or WSL, a laptop resume) the Health timeline and the Activity filters still find the requests in the
  window in which they happened; they were dated by process start plus uptime and could fall outside it.
- Interception setup for a new tab or popup waits for each DevTools answer until the tab closes or the session
  stops, so a tab whose renderer starts slowly still gets local sources. Only a renderer that gives no answer for
  30 s ends the setup.
- Element provenance (markup and script) waits up to 30 s for each answer from the browser or the local Mirage. A
  DOM node's source stays pending until every proof read for its document has settled, and is marked unmapped at once
  when no read can still prove it; a script file that a page reads with `fetch` or XHR no longer keeps it pending.
- When provenance for a tab cannot be delivered, the event log shows one warning:
  `Local provenance for this tab is incomplete: … Reload this tab to deliver it again.` Closing the browser, its
  context or a tab while a provenance read is in flight logs no warning.
- Removing the development panel completes once the panel is gone from every open tab, including a tab that loads
  several documents in a row during the removal. A tab whose debugger is paused is given up after 30 s and a crashed
  tab at once; removal then fails with
  `The development panel could not be confirmed removed from <n> tab(s): …`, naming each tab's reason.
- A Git command that gives no answer within 120 s is reported as such, never read as "not a repository", "no commits"
  or "not tracked": the setup save answers 503 and asks to retry, `lense list` stops with
  `Git did not answer where the repository of <folder> starts`, and the project check of `lense doctor`,
  `init --check` and `init --ready` stops with `Git did not answer which project files to check` or reports a
  `PRIVATE_IGNORE_REVIEW` finding for its ignore check. When Git is not installed or not on PATH, they say
  `Git was not found. Install Git or add it to PATH, then try again.` The setup page shows a Git that does not answer
  its source status as timed out.
- `lense dev` keeps watching sources while Git does not answer: it warns once per outage
  (`Git did not answer (…); asking again on the next repository check`), keeps polling HEAD and the baseline, sets up
  the repository watcher once Git answers, and stops polling Git in a folder that is not a repository. A session
  whose HEAD read gets no answer starts with HEAD unknown and fills it in once Git answers; the model-driven panel
  shows no Git state meanwhile. A baseline file read that Git does not answer makes the baseline unavailable until
  Git answers again, instead of showing the file as new.
- `lense list` lists the configured sites when a checkout folder does not exist yet. `lense doctor`,
  `init --check` and `init --ready` work in repositories whose Git file list is larger than 4 MiB.
- A setup save keeps its lock for as long as it runs, so a second save cannot run beside a slow one. It asks Git
  whether the personal configuration is tracked before it takes the lock, and its busy message names the lock file.
- A Mirage ownership lock or setup save lock left by a killed process no longer blocks for ever when its process
  number is reused. After 30 s, a waiter checks whether the process now using that number is the one that took the
  lock, and takes the lock over when it is not. A lock held by a running Paqvilo command is never taken over,
  whatever the system clock does: on Linux the holder is recognised by its process start in kernel ticks, on Windows
  and macOS by a lock time that cannot fall before the holder's own start. Both locks record the operating system
  and machine they were taken on: a lock taken elsewhere (for example in WSL while the command runs on Windows) is
  never taken over, and the waiting command or the busy answer of a setup save names where it was taken.
- When a folder refuses the file used to remove an abandoned Mirage ownership lock, or Windows keeps refusing to
  remove the abandoned lock file, the command ends after 30 s with a message naming the files, instead of waiting
  until it is interrupted or failing with a bare `EBUSY` error.
- A Mirage ownership lock that names no process is taken over only after the waiting command has itself seen it
  unchanged for 30 s, so a file server whose clock is behind cannot cause a live command's lock to be removed. When
  several Mirage commands wait on the same abandoned lock, each takes it in turn.
- When a lock file cannot be removed after its work, the command reports it once and keeps its result, and the same
  process reuses that lock the next time it needs it.
- A setup save in a folder that refuses new files says so, and a save lock whose record could not be written is
  removed at once.
- The Mirage ownership records are replaced whole by a rename, so a command reading them sees the old or the new
  records. A records file that cannot be read or is not valid JSON stops the command with an error that names the
  file and says how to recover; it is no longer read as empty.
- A Mirage ownership lock is taken over as soon as the process it names has exited, and never while that process
  runs under it. A lock still held after 30 s ends the command with
  `The Mirage ownership records stayed locked by process <pid> for 30 s: <lock>. … If no Paqvilo command is running, remove that lock file and run the command again.`
  A records file that stays read-only or open in another program, or a lock folder that refuses new files, also ends
  the command after 30 s with a message that says what to change.
- `mirage start` reuses the runtime it started with the same settings while that runtime's process lives, even when
  its status answers late. It refuses the start, naming the PID and a stop command, when the status stays silent past
  `--startup-timeout`, and launches a new runtime when the process has exited.
- A baseline hook counts as finished when its output closes, so output written by a process the hook started is not
  lost.
- Changing operation modes or a custom API's registration no longer waits for the old plug-in runtime's cache folder
  to be removed; closing the simulator waits for it. When another program keeps a file in that folder open,
  `PLUGIN_CLR_CLEANUP_HELD` is reported after about two seconds and the removal is retried for up to 120 s.
- An uploaded assembly's CLR runtime is released like any other: its folder is kept and reported when its host is not
  verified stopped, and a failed removal is reported as `CLR runtime cache cleanup failed: <code>`.
- CreateMultiple and UpsertMultiple no longer scan the written targets once per row, so their work stays linear in
  the number of targets.
- Source files are read in code-unit name order on every file system and in every locale. For names that differ only
  in case or punctuation, which control or record wins can change.
- Lense sorts names with English collation whatever the system locale: agent session lists, `lense doctor`
  diagnostics, the setup preview, the panel and Dataverse provisioning and data output keep one order on every
  machine.
- Lense's Git commands honour `GIT_CEILING_DIRECTORIES`.
- Persona runtimes use the simulator's own `shutdownBodyIdleMs`, so closing a simulator with a stalled request body on
  a persona runtime waits only as long as that option says.
- A server-logic run whose answer is already on its way when its time limit falls due returns that answer; the limit
  ends only a run that has not answered.
- A synchronous webhook post or Service Bus send made from the plug-in pipeline counts its time limit from when the
  synchronous I/O worker has started, so a slow worker start no longer fails the call. A worker whose code cannot load
  fails the call at once with 502 `SyncIoWorkerFailed`; a worker that never reports its start fails it after 120 s.
- Mirage ends a CLR host only through the process it started, never by process ID, so a process that later reuses a
  host's ID is never signalled.
- Parity captures retry a step only when the browser reports that the page's execution context was lost (destroyed,
  not found, or its target navigated or closed). A crashed page or another navigation failure fails the step. A page
  evaluation that does not finish is reported as `PAGE_UNRESPONSIVE`.

### Upgrade notes

- Tracing is on at `summary`. Set `mirage.trace.level: off` to turn it off.
- Source and implementation fingerprints change once, because source files are read in code-unit name order. Saved
  native network baseline observations report `NATIVE_BASELINE_SOURCE_CHANGED` and must be captured again; saved
  verify and acceptance evidence shows as stale, as after any upgrade.
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
- On Linux and macOS, `paqvilo` does not forward SIGINT to the command it runs, because Ctrl+C in a terminal
  already reaches both. To stop `paqvilo` from a script or a parent process, send SIGTERM; a SIGINT sent only to the
  `paqvilo` process is ignored.
- Service Bus emulator provider: `preflight()` called without a probe context is bounded by the 30 s idle window and
  reports `SERVICEBUS_EMULATOR_UNREACHABLE` when it ends there.
- Storage providers from packs: `preflight` must settle once its `signal` aborts; closing the provider waits for
  every probe it started.
- Parity reference captures run under a debugging client, and two browser limits apply: a message that a cross-site
  frame posts to its parent within a few milliseconds of loading can be lost while the capture holds a popup of that
  page at start, so a widget that waits for such a message can stay in its loading state in the capture; and when
  another debugging client resumes a cross-site frame before the capture tracks it, requests that frame already started
  are not counted, so the capture can be reported settled while they still load. Writes are refused in both cases.

### Contributor validation

- `npm run validate` and pre-push reproduce the hosted checks: CodeQL with the pinned bundle, Windows browser
  lanes in both Chromium and Edge, the hosted runner's `TEMP` alias and an empty npm cache, the test-kind check
  against the default branch, and the unit lanes under Node coverage as the SonarQube lanes run them. Lanes run
  concurrently (`paqvilo.ci.jobs` or `PAQ_CI_JOBS`), and changed test files run twice more.
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
- `check:workflows` downloads actionlint and ShellCheck through the GitHub releases API. In CI the step that
  provisions them is the only `run` step whose environment receives the job token (actions with a `token` input
  receive it through that input's default); the token is sent to `api.github.com` only, and the verified
  archives are cached under a key derived from their pins alone and saved right after provisioning, so a run whose
  checks fail still keeps them. A throttled download honours a `retry-after` in seconds and waits for an exhausted
  rate limit to reset, a 429 with neither waits one minute, and any other 403 fails at once; a wait over 60 s or a
  third throttled reply fails naming the host, status and rate-limit headers. CI caches the public ecosystem fixture
  and CLR SDK reference archives the same way, keyed by their pins and saved right after preparation, in the lanes
  that use them; preparation re-verifies each restored archive before it extracts it and downloads one that fails
  verification again. A download that GitHub rejects with 401 because of the token is repeated once without it.
- Local unit lanes write their coverage data under `.paqvilo/ci/runs/` and remove it when each command ends; a lane
  needs about 2 GB of free disk space while it runs.
- Local validation approximates the SonarQube rule profile on changed JavaScript files (`npm run check:sonar-rules`)
  and fails only on findings a change adds.
- `scripts/runtime-performance.mjs` aborts a request at its budget only in strict mode; recording mode measures each
  request to its end and reports a missed budget as a finding.

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
