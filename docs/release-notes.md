# Release notes

## 0.9.4 (preview)

This release expands project configuration, improves local rendering and makes large
datasets and automated testing more practical. Preview builds are available for testing;
use an exact preview version until the stable release is published.

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

### Upgrade notes

The published version line is **0.9.x**. Projects pinned to old checkout versions such as
`^1` or `1.2.0` must change that range explicitly.

For previews, follow [branch package installation](branch-packages.md). Once stable 0.9.4
is published, update with `npm install --save-dev paqvilo@^0.9.4`, commit the lockfile and
run your project tests. Use your existing dependency category if it differs.

Large state files may use a format older releases cannot read. Back up state before
upgrading and use `readStateFile` rather than `JSON.parse`; see [state storage](../mirage/docs/state-storage.md).
Existing deep imports remain available during the documented migration period. New code
should use the [public API](public-api.md).

Mirage implements selected platform contracts. Validate critical project scenarios against
Power Pages; see [coverage](coverage.md) and the relevant [runtime reference](../mirage/docs/README.md).
