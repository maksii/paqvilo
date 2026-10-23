# Release notes

## 0.9.6

This release addresses feedback 176–218 on source inspection, local visitor tools,
acceptance observation, offline diagnostics and consumer scaffolds. The changes use synthetic exports
and loopback fixtures; they do not certify complete Power Pages parity.

### Changed

- **Model-driven Lense Actions:** use the shared Power Pages Lense panel with model-driven source inspection and an Actions tab for searchable results, native navigation, diagnostics, reversible form adjustments, scoped Web API request identity, and explicit asynchronous custom commands. See the [functionality map and behavior contracts](model-driven-actions.md).

- **Consumer follow-up (191, 206–218):** preserve JSON batch atomicity through dependency ordering; compose standalone managed identity and platform settings; correct field/validation diagnostics; expose relocation-stable Solution content fingerprints; retain configured site defaults in matrix runtimes; and scope client-extension sources independently of metadata. Organization startup shares one private seed transaction, bootstrap-only presets preserve restart edits, and catalogue security work yields between tables. Startup reports phases and separates listener, document and application readiness. X-ray keeps generic inactive-template matches uncertain and inspects individual accessible same-origin frame controls. See the [feedback review and regression map](consumer-feedback.md) and [measured loading improvements](../mirage/docs/runtime-performance.md).

- **Consumer projects (194–205):** setup selects first install or frozen lockfile ci,
  and browser checks follow effective configuration. Separate completion, offline
  all-site readiness and strict executed-acceptance gates prevent empty starters from
  implying coverage. Site-bound runners remain optional alongside source-free pack tests.
  Editor refresh proposes npm reconciliation, includes mapped settings repositories,
  uses relative tracked paths where possible, flags cross-drive references for review
  and preserves custom files. Optional recipes connect
  multi-repository paths, pack ownership, persona/state lifecycle, network boundaries
  and existing-project adoption; the active starter remains empty and minimal.

- **X-ray (176, 177, 190, 191):** reuse unchanged inspection results and source hints,
  restrict extra markup candidates to rendered elements, and display relative
  paths in truncation notes. Refresh checks source changes before rebuilding.
  Large exports retain current-source hints across global cache eviction; exact
  IDs take priority over broad class matches, and omitted oversized sources are
  reported even when the page does not reference them. Refresh also checks explicitly
  mapped external plugin source files without scanning their broader project roots.
- **Acceptance (180, 183):** reserve a conservative portion of action time for
  document commits and expose a public request lifecycle observer for project-owned
  Playwright runners. Document lifecycle evidence is required to separate
  superseded reads from failures; writes remain visible. Context settling includes
  newly opened pages and bounds attachment and observation with one deadline.
- **CLI (181, 182):** screenshot result paths use the same relative display rules
  as errors; unknown Mirage commands suggest only nearby spellings.
- **Identity (184, 185, 192):** configured-persona sign-in rejects missing contacts
  before posting; identity scope behavior is documented; reference parity accepts
  explicit local visitors without changing the runtime's configured identity.
  Custom contact primary keys resolve memberships consistently, and malformed
  comparison options fail before any local or reference reads.
- **Diagnostics (186, 187):** `doctor --lint-profiles` optionally reports syntax
  errors in unbound exported profiles as warnings; ineligible system forms produce
  one specific diagnostic per reference, including advanced-form steps. JSON
  syntax locations are consistent across supported Node versions.
- **Generated data (193):** explicit opt-in persona membership materialization
  resolves exported web-role IDs. Default additive generation and catalogue
  metadata continue to grant no memberships. Additive merges recognize equivalent
  braced GUIDs, validate dataset shapes and reject misplaced CLI arguments before
  writing. Own-property lookups keep inherited JavaScript names out of table reports
  and schema definitions while preserving explicitly configured fields.
- **Localized forms:** selected Solution language labels apply to tabs, sections,
  cells and nested quick forms, including the existing local tab-label fallback
  after name/ID matching.
- **Security checks:** the required Security gate checks open CodeQL findings for
  the analyzed ref after processing, in addition to successful analysis jobs.
- **One shell for setup and `/_sim/`:** both pages share one sidebar, top bar and
  component styles, an **Areas** switch, and the Paqvilo wordmark with the area label
  (`PROJECT SETUP`, `SIMULATOR WORKSPACE`). See [setup](setup.md).
- **Infrastructure dashboard:** `/_sim/` opens on an Infrastructure view with a system
  map, activity tiles, a request and diagnostics feed, node details and on-demand
  preflight, fed by the new read-only `GET /_sim/api/dashboard` on both hosts. See
  [simulation administration](../mirage/docs/sim-administration.md#infrastructure-feed).
- **New `/_sim/` views:** Providers & services, Flows & jobs, Capabilities & preflight and
  Data packs (`GET /_sim/api/packs`); the sidebar is grouped, and views follow the routes
  each host publishes in `status.routes`. The standalone host serves the environment
  routes, and `/_sim/` sends a strict Content-Security-Policy and `nosniff` on both hosts.
- **Setup journey:** a ten-stage progress rail, four example templates, a settings
  catalogue covering every key, linked project files as `project:<site>` layers, a
  System map (planned or live) and a restart banner with the exact command, driven by
  the runtime identity rather than the file contents. See [setup](setup.md#journey).
- **Quick setup:** `/_setup/` opens on five plain-language steps that find the exports in
  the project folder, create the configuration, and start, open, restart and stop the local
  preview without a terminal; All settings keeps every key. You choose any combination of
  website, model-driven apps, canvas apps and the Dataverse Web API, pick export folders in a
  folder picker that marks exports and Solutions, and choose the starting data from the
  running preview. Starting a project without configuration from a terminal opens setup.
  See [setup](setup.md#quick-setup).
- **Surface switches:** `modelDriven.enabled: false` turns the model-driven surface
  (`/main.aspx`) off on both hosts, and a catalogue site can set `mirage.canvas` as a project
  can.
- **Compact setup page:** a one-line status strip with the save target, the system map
  first, guidance behind (i) tooltips, up to four fields per row and preflight under
  Start & check. A setup page that `mirage dev` serves on its own port reads the
  running preview through a read-only relay, so its map goes live too.
- **All settings configures, the simulator manages:** stages and sections share plain names
  (What to run, Exported files, Sample data, Live environments, Test people & sign-in, Outside
  services, Web API access, Start & check). Runtime data is no longer repeated in setup: each
  section links its simulator view once the preview runs. Exported files covers every folder type
  (website exports, Solutions, canvas app folders, model-driven script folders, deployment
  profiles with their files, code apps in project files) with folder and file pickers; several
  website exports become several projects, each with its own local address, and Start & check
  chooses the project to start. A sample data module registered by its path stays a path when a
  form is saved (it was rewritten with the id `pack`, so the preview refused to start). A repaint
  keeps the section you are reading in place, and the save notice no longer covers the page.
- **System map layout:** band titles sit in a label column beside their cards, every
  connector has a lane of its own in the gap between layers (gaps grow with their lanes),
  connectors across several layers run down a free column gap, and neighbours in one layer
  join with a short arrow, so no connector crosses a title or a card or shares a line with
  another. The header names its facts in plain words with an (i) each.
- **System map connections:** every connection on the map is a call the runtime makes,
  traced to code. Save hooks hang off the organization store, Web API messages off the Web
  API host, background work off background jobs; Power Fx, storage routes, the outbox and
  secrets are reached from the modules that use them (no longer from the store as a hub, which
  made Power Fx look connected to the website). The model-driven apps use their in-app Web
  API, not the Web API listener. TDS, visitor sign-in, code components, the live portal
  connection, persona runtimes, administration, setup, local services and Azurite and Service
  Bus emulators are connected. A switched-off part lists the connections it would have on its
  card instead of drawing them; hovering a card lights its direct connections only;
  connections from one card share a bus lane, a column gap holds up to three trunks and no
  connector crosses a card or shares a line with another. Custom APIs, work queues,
  calendars and staff user settings sit in the right groups; "Identity & tokens" is now the
  visitor sign-in provider and the live bridge is the live portal connection.
- **Offline preflight presets:** `mirage preflight` applies the startup preset (`--preset`
  or the site's `mirage.preset`) as a fresh host does, so service endpoints a preset seeds
  resolve plug-in steps as on the running host.
- **Portal grid lookups:** lists, subgrids and lookup dialogs name lookups stored as bare
  ids through their N:1 relationship, as forms already did.
- **Shared host composition:** the offline `mirage preflight` composes the same host
  description a running host reports; pack `storageProviders`, `messageProviders` and
  `outboxHandlers` are instantiated by both hosts; provider `preflight()` probes report
  readiness. See [capabilities and preflight](../mirage/docs/capabilities-and-preflight.md#preflight).
- **Persistence:** every persistent level keeps blobs under `<stateDirectory>/blobs`; pack
  DATA notes up to 64 KiB stay inline; missing stored objects read as null with
  `STORAGE_OBJECT_MISSING`. See [storage providers](../mirage/docs/storage-providers.md).
- **Committed jobs:** asynchronous plug-in, web hook, row-trigger flow and classic
  background workflow jobs are staged inside the triggering transaction. A web hook to a
  non-loopback endpoint ends Canceled instead of Succeeded.
- **Record pipeline:** SDK calls from plug-ins, flow Dataverse actions and portal writes
  run the organization record pipeline and read projection; masking rules, exact JSON
  numbers, collation-aware grouping, key-set paging for Web API and FetchXML, and
  calculated columns in filters and orders. See [Dataverse API](../mirage/docs/dataverse-api.md).
- **Solution security and layers:** Solution roles and field security profiles are
  imported; managed layers, alternate key activation jobs and delegated-token caller
  resolution follow the documented rules.
- **Flows and connectors:** Until and the data operations, Recurrence and on-demand HTTP
  Request triggers, pack `flowActions` and `flowTriggers`, Solution custom connectors at
  contract, more Dataverse connector operations, frozen parameters on resume and
  `ReplayDiverged`. See [operations](../mirage/docs/operations.md).
- **Portal surfaces:** global search and the default `/search/` page, modern lists and the
  `$pages` client API, the local document control, server logic bridges and `ServerLogic/*`
  site settings. See [forms and lists](../mirage/docs/forms-lists-parity.md#modern-lists-and-the-client-api).
- **Model-driven host:** `Xrm.WebApi.execute`, `navigateTo` and side panes, one staff
  context with user settings, dataset PCF controls and project-supplied platform
  libraries for virtual controls. See [model-driven client API](../mirage/docs/model-driven-client-api.md).
- **Sources and organization seams:** YAML source-control repositories import tables,
  forms and views; source load failures become preflight rows; virtual tables read
  through their provider; Dataverse Functions and automated low-code plug-ins
  evaluate on the core Power Fx engine; project `canvas` sources and switch.
- **Power Fx engine:** formula columns, Dataverse Functions (also defined in a Solution's
  `fxexpressions/` folder), automated low-code plug-ins and canvas apps evaluate on
  Mirage's own Power Fx interpreter, with delegation to the store and the
  `POWERFX_DELEGATION` warning. See [Canvas apps](../mirage/docs/canvas-apps.md#power-fx).
- **Canvas apps:** screens, controls, formulas, data sources and navigation run headlessly
  at `/_apps/canvas/<app>` and `POST /_apps/api/canvas/<app>`; apps are not rendered.
  See [Canvas apps](../mirage/docs/canvas-apps.md).
- **Azurite:** `providers.storage` `kind: azurite` is a core Blob REST transport with
  Shared Key authorization and a `timeoutMs` bound. See [storage providers](../mirage/docs/storage-providers.md#azurite).
- **Service Bus emulator:** `providers.messaging` `kind: servicebus-emulator` is a core
  AMQP 1.0 bus with an `amqpPort` setting; synchronous service endpoint steps send
  through it. See [messaging](../mirage/docs/messaging-and-outbox.md#service-bus-emulator).
- **Provider lifecycle:** composition failures, host close and settle attempt every
  provider (`PROVIDER_CLOSE_FAILED`, `PROVIDER_SETTLE_FAILED`), and pack factories
  register what they open with `own(resource)`.
- **Source reloads:** a reload whose Solution scan has a new error is rejected with
  `SOURCE_RELOAD_REJECTED` and changes nothing. See [standalone organization](../mirage/docs/standalone-organization.md).
- **Enhanced authorization:** a site in the enhanced Power Pages authorization model runs
  it locally (mapped Dataverse users and security roles, column security profiles);
  `portal:enhanced-authorization` is satisfied. See [Dataverse](../mirage/docs/dataverse-parity.md#enhanced-authorization).
- **Portal reads and column security:** every portal read masks secured columns as a
  Dataverse read by the reading principal and refuses filters over masked columns;
  Dataverse queries evaluate unreadable secured columns as null. See [Dataverse](../mirage/docs/dataverse-parity.md#column-security-on-portal-reads).
- **Portal file columns and client API:** `/_api` file and image column routes,
  `$pages` forms and controls, file column methods and `languages.setActive`, and
  subfolders in the document control. See [forms and lists](../mirage/docs/forms-lists-parity.md#modern-lists-and-the-client-api).
- **Mobile offline:** a model-driven app with a Solution mobile offline profile goes
  offline per staff session; `Xrm.WebApi.offline` reads and writes the session copy.
  See [model-driven client API](../mirage/docs/model-driven-client-api.md).
- **Model-driven dashboards:** Solution dashboards open in the app with their lists;
  other components are listed as not rendered. See [model-driven apps](../mirage/docs/model-driven-apps.md).
- **Cloud flows:** Recurrence `timeZone` and `schedule`, the Dataverse "When an action is
  performed" trigger, waits that hold only their branch, waiting child flows, loop
  replay, List rows `$expand`, `fetchXml` and paging, and custom connector body media
  types and OAuth client credentials. See [operations](../mirage/docs/operations.md).
- **Virtual tables:** the provider runs as the main operation inside the transaction and
  can enlist with `begin`, `commit` and `rollback`; SDK writes use `createSync`,
  `updateSync` and `deleteSync`. See [Dataverse contract modules](../mirage/docs/dataverse-contract-modules.md#virtual-providers).
- **Metadata and upsert:** metadata privileges under impersonation use both users'
  privileges, solution components use the `MetadataId`, and an alternate-key upsert
  follows Learn's key precedence. See [Dataverse API](../mirage/docs/dataverse-api.md).
- **Mirage-only sites:** a `model-driven` or `dataverse-api` site without a portal export
  passes `init --check`, `lense list` and `lense doctor`. See [configuration](configuration.md#select-a-catalogue).
- **Lense X-ray:** Inspect keeps focus out of embedded frames, so Enter and Space cannot
  activate a control in a frame. See [Lense](lense.md).

### Upgrade notes

Update with `npm install --save-dev paqvilo@^0.9.6` and commit the lockfile.
Reference reads still require explicit authorization and the intended signed-in
browser. No deployment or live-data changes are part of these improvements.

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
