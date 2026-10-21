# Release notes

## 0.9.6

This release addresses feedback 176–218 on source inspection, local visitor tools,
acceptance observation, offline diagnostics and consumer scaffolds. The changes use synthetic exports
and loopback fixtures; they do not certify complete Power Pages parity.

### Changed

- **Model-driven Lense Actions:** integrate reviewed Level Up workflows into a contextual inspector with searchable results, native navigation, diagnostics, reversible form adjustments, scoped Web API request identity, and explicit asynchronous custom commands. See the [functionality map and behavior contracts](model-driven-actions.md). Power Pages retains its separate inspector.

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
