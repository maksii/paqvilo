# Setup workspace design and implementation plan

The setup workspace manages local project configuration before a portal can run and remains available during development. It reuses the catalogue, optional personal override and existing validators; it introduces no second settings format. It never executes packs, accesses references, installs dependencies, changes exports or starts live workflows.

## Experience

`paqvilo setup` serves a loopback `/_setup/` page from the current project, including an empty folder or broken catalogue. `--open` opens that page in the system browser. `--config` selects a catalogue; `--project` selects a standalone Mirage project. The default must never fall back to editing the toolkit's bundled catalogue.

The page starts with readiness, actionable findings and source/Git status. Portal cards edit source paths, environments and Mirage ports/Solution roots. Project controls edit the source root, defaults and browser. Rules and advanced settings use a validated YAML editor, with shared and personal layers clearly distinguished. Personal values and their effective origins remain visible; `.env` contents and discovery files do not appear. Empty projects can create a minimal catalogue directly. Invalid YAML stays editable with diagnostics.

Mirage serves the same workspace at `/_setup/` with a link from `/_sim/`. Lense development serves a separate local setup URL and links it from its panel, avoiding a live portal's URL namespace. Saving updates project files for the next start. A runtime reports configuration drift; changing files cannot silently change the browser's live destination or reset simulator state.

## Persistence and boundaries

Guided edits modify YAML nodes and preserve unrelated fields/comments. Advanced edits replace only the explicitly selected document. Schema validation happens before writing; absent exports and placeholder environments are readiness findings, so incremental onboarding remains possible. Edits use a revision over the shared/personal/environment files, an exclusive write lock and atomic replacement. Concurrent edits return a conflict requiring reload. Symlinked config outputs are refused.

The HTTP surface binds to loopback, checks Host and Origin, rejects cross-site requests, uses a per-server CSRF token, limits payloads, sends no CORS headers and serves only fixed assets. It reads no credentials or bearer-token discovery records. It uses the toolkit's current documentation links and installed help for instructions.

## Implementation sequence

1. Add a reusable configuration store, safe YAML patching, readiness/source/Git summaries and conflict checks.
2. Add the loopback handler/command and a responsive, accessible setup UI with guided forms and recovery editor.
3. Integrate with Mirage and Lense lifecycle/panels, generated project workflows and documentation.
4. Add persistence/security regressions and browser coverage. Exercise a temporary demo and a separate scaffold with multiple local Git source repositories, including missing/broken settings, effective overrides and running previews.
5. Run repository validation and installed-package smoke checks from an isolated staged snapshot; commit only setup changes.
