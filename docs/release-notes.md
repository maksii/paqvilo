# Release notes

## 0.9.8

- Offer explicit `createOwned()` preset factories for private generated datasets, preserving existing `load()`
  memoization/copying, user-authored presets, defaults and configuration validation. Reuse the validated startup
  owned body instead of generating it again. Document ownership and deterministic reapplication.
- Defer relationship-body copies in the lightweight catalogue index; selected/full metadata retains every
  relationship. Avoid redundant capability-description column scans and repeated fixed-capability JSON/network
  allocations during status polling; dynamic adapters and public state snapshots remain fresh.
- Bound large committed journal replay with private candidates, retaining checksum verification and incomplete-tail
  recovery without holding every operation object until commit. Count administration visibility without a row list
  and avoid the redundant offline generation input snapshot.
- Store unique row-index positions as scalars, allocating lists only for duplicates. Preserve sorted positions,
  wild/null keys, mutation maintenance and rollback; distinguish a captured undefined key from an omitted argument.
- Reduce wide-record and FetchXML projection metadata derivation to one request-scoped set, retaining
  fresh labels/security on subsequent requests. Avoid per-character JSON parsing and duplicate source XML
  copies; bound recurring-text reuse during checkpoint restore and stream parse-cache persistence.
- Compose unpublished startup state without full rollback copies, deferring atomic persistence until commit
  and discarding failed initialization. Keep published transaction isolation and snapshot ownership.
- Journal only changed startup sections/tables and reuse the preceding durable comparison receipt, retaining
  detection of intervening edits and external-file conflicts. Avoid an unused full-state return copy during
  standard-module initialization. Preserve caller-provided reset baselines.
- Compile large complete metadata responses in a request-owned worker, transferring one encoded table at a
  time and negotiating gzip without accepting `gzip;q=0`. Retain exact JSON, numeric precision, source
  references, security epochs, backpressure, cancellation and the uncompressed representation.
- Carry FetchXML's total-count-limit flag into model-driven grids, paging and subgrids, so a capped count
  displays as `5000+` while subsequent pages and exact smaller filtered counts remain available.
- Keep root client-resource provenance out of repeated table-body work, while retaining complete table and
  root references. Separate source-tree traversal and client-asset budgets so large Solution trees retain
  their scripts and PCF controls. Record constrained measurements and unresolved large-scale resource
  failures in [consumer qualification](consumer-feedback.md); larger heaps are not laptop qualification.
- Admit observed same-origin `/_pcfwebresource/<guid>` stylesheets after verifying CSS response bytes, retaining
  credential, path, origin and size checks. Duplicate observations fetch once; failed captures keep the prior shell.
- Preserve paragraphs, tables, preformatted blocks and native-style JSON hidden values in rich-text editors;
  avoid unchanged synchronization feedback in both adapters. Wait for the actual editor document before readiness,
  and retain read-only behavior. Exercise repeated postback/reopen and authored jQuery observers; the consumer's
  exact unseen exception remains unverified in [consumer qualification](consumer-feedback.md).
- Compare unchanged metadata against retained row stamps without allocating a field-pair tree on every read.
  Invalidate column metadata, component presence and changed same-ID solution assets independently of row epochs.
  Report runtime-module and context-preparation phases before listener startup.
- Construct selected model-driven form bodies lazily while preserving the complete catalogue API. Avoid redundant
  preset graph clones and off-page FetchXML payload copies, retaining totals, cookies, security and distinct semantics.
  Qualify 1,000 tables / 1,000,000 rows / three roots across fresh, unchanged, journal and source-change starts,
  plus a 900,000-row single-table distribution; see [measurements and limits](consumer-feedback.md).
- Stage shell capture bytes and manifest entries until state publication succeeds. Roll back valid siblings as well
  as failures, clean rejected staging/blobs, preserve stylesheet media/cascade occurrences, and reject origin collisions.
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
- Extend regressions for crowded cards, frame shortcuts, dynamic modal/quick-view identities, nested editors and
  owned-browser target isolation. The latter drops actual CDP requests in an independent loopback WebSocket proxy,
  covering tab/popup deadlines, cancellation, retry, watcher/agent continuity and shared transport loss.
  Include a [redacted owned-browser test receipt](owned-target-timeout.md) in the installed package.

Synthetic and native qualification are distinct. Loopback passes establish the exercised contracts; they do not
establish native control coverage, a deployed source revision or production readiness.

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
