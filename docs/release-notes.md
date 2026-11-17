# Release notes

Each version lists what changed for users of the package and what to do when upgrading. Update with
`npm install --save-dev paqvilo@^<version>`, commit the lockfile and run your project's tests.

## 0.9.8

This release lets you see and debug what the local runtime does: every request becomes a trace, original C#
plug-ins stop at breakpoints in VS Code, and a new analyzer reviews your Power Platform sources. Canvas apps
get a local player, Code Apps get a managed multi-app workflow, and the .NET Framework SDK can read a local
organization's metadata. Large datasets use far less memory.

### New

- **Request tracing and Monitor.** Each request becomes one tree of steps: HTTP request, Web API or form step, page
  render with its templates and Liquid reads, Dataverse operation, plug-in stages, table-permission decisions and the
  web hooks, jobs, flows and connector calls it starts. An activity whose plug-in refused the save reads `error` even
  when the page answered 200. The `_sim` **Monitor** has **Health** and **Activity** views. Read traces with
  `paqvilo mirage trace`, `/_sim/api/trace` or `connectRuntime().trace`, and export JSON, NDJSON or OTLP.
  `mirage.trace.level` is `off`, `summary` (default) or `full` (redacted payloads). See
  [request tracing](../mirage/docs/tracing.md).
- **Debug original C# plug-ins** in VS Code from your Debug DLL and PDB; `defaultMode: 'clr'` on a descriptor runs the
  original assembly on every start. See
  [debug original C# in VS Code](../mirage/docs/dataverse-plugins.md#debug-original-c-in-vs-code).
- **`paqvilo analyze`.** Offline rules for Dataverse and ALM, model-driven apps, Canvas, PCF, Code Apps, cloud flows,
  connectors, MCP, mobile declarations and Power Pages, on a folder or a project. Nothing is built or executed and no
  tenant is contacted; Doctor shows the findings and stays advisory unless you set `--fail-on`. See
  [static analysis](static-analysis.md).
- **Canvas player.** `/_apps/canvas/<app>` runs a Canvas app from its exported source, with an inspector for source
  locations, state and errors. `canvas.sources` folders reload on edit and replace a Solution app with the same unique
  name. A visitor without a Dataverse user gets 401 `CanvasPrincipalRequired`. See
  [Canvas apps](../mirage/docs/canvas-apps.md).
- **Code Apps development.** `mirage dev` starts your app servers and opens a workbench to switch apps, set parameters
  and watch connections and requests. The Vite plug-in keeps the SDK's `/app` and `/data` imports working against
  Mirage, with HMR and source breakpoints. See
  [Code Apps](../mirage/docs/code-apps.md#develop-sdk-apps-with-vite-and-the-workbench).
- **`CrmServiceClient` (.NET Framework)** connects through `AuthOverrideHook` and reads organization metadata from the
  SOAP Organization service. See [Dataverse API](../mirage/docs/dataverse-api.md#soap-organization-service).
- **Connector definitions.** Data packs can register captured Swagger 2.0 connector definitions; inputs are validated
  before your provider runs. See [data packs](../mirage/docs/data-packs.md).
- **Test data tooling** in `paqvilo/mirage/fixtures` and `paqvilo/mirage/testing`: generate datasets from your schema,
  remap identities, report coverage, emit TypeScript declarations, compare permission models and plug-in
  registrations. See [public API](public-api.md).
- **Large generated datasets.** `createOwned()` preset factories stream rows into compressed, checksummed record pages;
  `load()` presets are unchanged. See [paged record storage](../mirage/docs/state-storage.md#paged-record-storage).
- **Pack transactions.** Opt-in, authenticated, local-only pack endpoints with rollback, concurrency checks and
  idempotency receipts. See [data packs](../mirage/docs/data-packs.md#authenticated-local-endpoint-writes).
- **SPA registrations.** A `publicClient: true` Dataverse API registration takes `spaRedirectUris` (PKCE `S256`
  required, CORS for that origin). See [Dataverse API](../mirage/docs/dataverse-api.md).
- **Approvals** model Basic, AwaitAll, Custom and CustomAwaitAll; only assignees can respond.
- **Excel export.** The grid action `download-as-excel` returns a typed `.xlsx` workbook.

### Improved

- **Separate addresses.** `/_sim/` and `/_setup/` are served on their own loopback port (`adminUrl`), and on the Power
  Pages host the model-driven, Canvas and Code Apps surfaces on another (`appsUrl`). Portal pages cannot read the
  administration or call the apps. Tokens: `csrf` (administration, accepted everywhere), `portalToken`, `appsToken`.
  See [administration](../mirage/docs/sim-administration.md).
- **Dataverse behavior.** Plug-in contexts (images, shared variables, parent contexts, async targets), column security
  on every read path (Web API, FetchXML, `$apply`, SOAP, TDS), add-on message authorization, solution staged upgrades,
  custom API deletion, notes and file writes, TDS types and limits, SOAP decimals, FetchXML paging and `count`, money
  in the row's currency, and `AttributeType` codes follow the platform more closely. Mirage is still not complete
  Dataverse parity; see [plug-in execution boundaries](../mirage/docs/dataverse-plugins.md#execution-boundaries).
- **Model-driven apps** load metadata on demand, show counts above 5,000 as `5000+`, and match the platform's
  `data.save()` error codes, save-and-new, OnLoad state and form/grid controls. See
  [client API](../mirage/docs/model-driven-client-api.md).
- **Flows.** Stricter expression parsing (`inspectFlowExpression`), more functions, trigger conditions, JSON Schema for
  inputs, time functions on the run's clock, and a deadline only when `limits.timeoutMs` is set.
- **Power Fx.** Runaway regular expressions stop after `host.regexGuardMs` (default 10,000 ms); one scope budget covers a
  formula and its component functions (`host.scopeBudget`, default 5,000,000).
- **Liquid and forms.** A missing `include` renders `Template "<name>" not found.` as text; only the first
  `entityform`/`webform` on a page renders; `request.params` includes cookies; plug-in errors on basic-form saves show
  the platform's generic message unless `Site/EnableCustomPluginError` is `true`.
- **Code Apps.** `devServer.timeoutMs` (1000 to 300000, default 120000) bounds a dev server that never becomes ready;
  connector calls wait up to 120 s; `PAQVILO_MIRAGE_URL` is the apps address.
- **Server logic.** `serverLogicTimeoutMs` (and `runExportedServerLogic`'s `timeout`) replaces the local 5 s limit, from
  100 ms up to the site's `ServerLogic/TimeoutInSeconds`.
- **Performance.** Row writes no longer scale with solution size; start-up, restarts, status and the catalogue use less
  memory.
- **Lense.** `--startup-timeout <ms>` (default 120000, cap 600000) bounds silence without progress for `mirage start`,
  `mirage dev` and `model-driven dev`. `agent sessions --timeout <ms>` sets the probe budget. Source attribution finds
  grid columns, forms, quick views, modals and rich-text frames more reliably. Ctrl+C runs each command's own cleanup;
  a third interrupt exits at once (130, or 143 for SIGTERM). A failed cleanup exits 1 and names what was left running.
- **CLI.** Arguments are validated before any file, browser or PAC work; JSON errors go to stdout, readable errors to
  stderr; report paths cannot overwrite inputs or credentials.
- **Dataverse CLI.** A remote `dataverse plan` lists the membership writes and blocked roots of `apply`; reads retry on
  429 and 503.
- **Baseline capture.** Live writes need `--allow-writes`, live captures name scenarios with `--only` or
  `--all-scenarios`, and scenarios can wait for popups with `wait: { popup: <n> }`. Captures and acceptance flows on
  `live.cdpUrl` refuse writes from every page, popup and frame they drive.
- **`_sim` layout** is consistent, works at phone width and follows dark mode.
- **Redaction** covers connection strings, URL credentials and invitation codes.

### Fixed

- Locks left by killed or interrupted processes (Mirage ownership, setup save) no longer block later commands; a lock
  taken on another machine or in WSL is never taken over, and a lock that cannot be cleared ends the command after
  30 s with a message naming the file.
- Commands report Git that does not answer within 120 s, or is missing, instead of treating the folder as "not a
  repository"; `lense dev` keeps watching sources meanwhile.
- CLR plug-in hosts: slow host creation no longer fails steps, hosts end with Mirage, a host that is not verified
  stopped keeps its cache and reports `PLUGIN_CLR_CLEANUP`, and Windows path-limit compile errors (`CS1619`) name the
  cache path length.
- Mirage no longer ends with a V8 fatal error when a worker thread finishes, and a listener error is recorded as
  `LISTENER_ERROR` instead of ending the process.
- Trace timelines stay correct after a system clock step (VM or WSL time sync, laptop resume).
- Switching the model-driven target on a slow machine no longer ends the dev session; the Tweaks tab recovers from a
  slow or dropped runtime read.
- `lense verify` follows a start page that reloads itself or returns from sign-in, and reports interruption as
  `VERIFY_INTERRUPTED`.
- Local sources reach slow-starting tabs and popups; element provenance no longer stays pending on scripts read with
  `fetch` or XHR.
- `like` patterns, FetchXML, form XML, deeply nested `$filter` (400 above 100 levels) and malformed Canvas control
  versions can no longer hang the runtime.
- Sign-in and sign-out `returnUrl` values can no longer redirect off the site.
- `lense list --settings` and the `verify` sign-in message no longer print credentials or URL query values.
- `paqvilo analyze` reviews folders named `build`, `dist` or `metrics` and no longer flags unpacked solutions as
  incomplete.
- A missing record page stops the start with `StateIntegrity` and leaves the state file untouched.
- CreateMultiple and UpsertMultiple stay linear in the number of targets.
- Default grids work on partial exports without the primary name column; updates no longer fail on exported audit
  relationships; a server-logic Create no longer exposes a secured column.
- Absent or empty enhanced payloads report `PAQ-SOURCE-002` instead of a syntax error.
- The temporary Edge used for shell capture no longer signs in to the Windows Microsoft account.
- Monthly flow recurrences skip short months in every time zone.
- Two Code Apps on the same dev-server address are refused at start; Code App module scripts run in document order.
- The rich-text compatibility editor sanitizes with DOMPurify and keeps tables and paragraphs.
- Plug-in packages with overlapping ZIP entries or oversized content are refused.
- The Service Bus emulator transport connects only to loopback addresses.
- Source files are read in code-unit name order and Lense sorts names with English collation on every machine.
- `mirage stop` of a runtime started by `mirage dev` also ends that dev command and its browser.

### Upgrade notes

- Node.js 26.13.1 or a newer 26.x release is required.
- Tracing is on at `summary`; set `mirage.trace.level: off` to turn it off.
- Source and implementation fingerprints change once (code-unit name order). Saved native network baselines report
  `NATIVE_BASELINE_SOURCE_CHANGED` and must be captured again; saved verify and acceptance evidence shows as stale.
  For names that differ only in case or punctuation, which control or record wins can change.
- Old `_sim` addresses `#dashboard`, `#logs`, `#audit`, `#trace` and `#evidence` redirect to Monitor; `#overview` opens
  Home.
- The CLI rejects extra or misplaced arguments it used to ignore. Check scripts that call it.
- Reach the administration and apps on the printed `adminUrl` and `appsUrl`. A script that sends `Origin` or
  `Sec-Fetch-Site` to `/_sim/` or `/_apps/` on the portal address gets 403 `AdminOriginRequired` or
  `AppsOriginRequired`; clients without those headers keep the portal address. A request whose `Host` is not the
  listener's own address gets 403 `INVALID_REQUEST`.
- `handle.csrf` is the administration token; the portal form token is `handle.portalToken`, the apps token
  `handle.appsToken`.
- Delete a custom API's plug-in steps before the API: the delete answers 405 `0x80040227` while a step is registered.
  A second custom API with the same unique name answers 400 `0x80072013`.
- A staged upgrade of an unmanaged solution is refused with 400 `InvalidRequest`; use managed solutions for upgrades.
  `ImportJobId` must be an unused GUID.
- FetchXML `count` must be a positive integer (0 and other values answer 400 `InvalidFetchXml`); for a bounded total
  use `count="1" returntotalrecordcount="true"`.
- Browser session cookies are saved per portal scope in `<profile>.session.<hash>.json`; the old unscoped file is
  deleted, so a headed `verify --signed-in` signs in once more.
- Live baseline captures need `--allow-writes` for cache refresh and clear-cache steps, and `--only` or
  `--all-scenarios`.
- `mirage stop` exits 2 when it keeps a session it could not verify.
- Tests that pinned `AttributeType` 16 (multi-select) or 14 (partylist), or `...Type` names from Liquid
  `attribute_type`, use 17, 10 and the `AttributeTypeCode` names.
- `navigationCommitReserveMs` in `runAcceptance` reserves at most half of the remaining action time for held writes.
- On Linux and macOS, `paqvilo` does not forward SIGINT to its child (Ctrl+C reaches both); stop it from a script with
  SIGTERM, because a SIGINT sent only to the `paqvilo` process is ignored.
- Pack storage providers: `preflight` must settle once its `signal` aborts; closing a provider waits for its probes.
  The Service Bus emulator's `preflight()` without a probe context ends after a 30 s idle window with
  `SERVICEBUS_EMULATOR_UNREACHABLE`.
- Parity reference captures run under a debugging client: a message a cross-site frame posts within milliseconds of
  loading can be lost while a popup is held, and requests of a frame that another debugging client resumed first are
  not counted. Writes are refused in both cases.

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

### Fixed

- JSON `$batch` change sets keep their atomicity when requests depend on each other.
- Changed settings no longer reuse a running preview started with the old ones.
- Localized Solution labels apply to tabs, sections and nested quick forms.
- Setup and `/_sim/` fit narrow screens, and the system map no longer overlaps labels or tooltips.
- Setup preserves unchanged YAML scalar formatting, flow collections and comments when saving other settings.
- Exported JavaScript server logic allows separately bounded worker startup on busy hosts while retaining its
  script execution limits.

### Upgrade notes

Node.js **24.22.1 or a newer 24.x release** is required; Node 22 is no longer supported.

Update with `npm install --save-dev paqvilo@^0.9.6` and commit the lockfile. Model-driven Lense runs project scripts
in the live app, so it requires `modelDriven.trustedExtensions: true` in the project file. Turn the model-driven surface
off with `modelDriven.enabled: false`. Reference reads still require explicit authorization and the intended signed-in
browser.

## 0.9.5

This release fixes demo, panel and setup issues and adds an illustrated guide to the project site.

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
  Alt+Shift+L, the `markup` setting, `agent pages` fields, the debugger port, plugin DLL execution
  and Windows long paths are documented; `paqvilo mirage --help` examples are corrected.
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
