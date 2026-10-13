# Release notes

## 0.9.4

- `paqvilo init` generates an empty consumer project from dedicated templates, with catalogue placeholders, scripts, packs, offline tests, agent guidance and VS Code workflows. `init --check` reports unfinished values without executing packs; `init --refresh-editor` resolves current checkout paths and preserves edited documents. `createMirageContext({ config })` binds all explicitly configured catalogue packs without requiring source exports; pass `site` to retain site-specific imports/runtime defaults. See [project scaffold](project-scaffold.md).
- Scaffold agent guidance links to maintained online docs instead of duplicating the workflow reference. Editor development tasks follow changed catalogue sites/browser settings, workflow names avoid picker/debugger collisions, completion checks honor shell overrides and Git ignores, and nonempty enhanced/code-site fixtures run through the normal importer. Unsafe editor output paths fail before any document changes.

The published package line is 0.9.x. If older source metadata led your project to depend on `^1` or `1.2.0`, change that range explicitly: it cannot select a 0.9.x release. After 0.9.4 is published, run `npm install --save-dev paqvilo@^0.9.4` (or use your existing dependency category), commit your updated lockfile and run your project tests. `paqvilo --version` reports the installed version.

- Unknown navigation `@odata.bind` keys on create are rejected atomically under association enforcement. Plugin update validation retains raw names too.
- Footer repair checks ancestor clipping and topmost elements, ignores modal/fixed/sticky controls, reports the affected control, and restores source positioning when overlap ends.
- Uncaptured entity forms receive authored structural CSS. Status, doctor and administration distinguish placeholder/captured styles; form pages record `PLATFORM_STYLES_PLACEHOLDER`.
- `paqvilo mirage capture-shell` supports catalogue selection, an anonymous temporary browser and capture through a matching runtime's admin API. Confirmed native HTTP failures of CSS dependencies remain visible as `NATIVE_ASSET_HTTP` without making an otherwise complete capture incomplete. Missing directly referenced stylesheets still fail capture and are listed.
- Public CLI routes include `enrich-reference`, `reference-parity`, `query-inventory` and `verify`. A tool registry supplies public help.
- npm installations resolve Mirage dependencies from the installed root without a duplicate install. `paqvilo doctor --setup --json` provides read-only readiness output.
- Per-site compat switches and confined local head CSS/JavaScript provide explicit, reported local-only project overrides.
- The starter supplies LF attributes, npm-consumer instructions and a resolved-path workspace generator.
- Scenario migration preserves explicitly configured entity-set names even when a mapping retains an older `inferred` flag. Only conventional names that remain inferred are refreshed.
- Small toolkit regressions now cover migration edits/deletions and exported grants, origin-separated asset manifests, lazy pack persistence and Solution enrichment, admin preset hydration and name-only edits across restart, and permission-filtered `related` expressions without intersection-table read grants.
- Maintainers can request [branch testing packages](branch-packages.md) before merge. Immutable preview versions and per-branch npm tags use the existing trusted publisher; all gates test the preview metadata and publishing reuses the gated archive. Normal releases keep their main-only checks.

Public API additions: `paqvilo/mirage`, `paqvilo/mirage/acceptance`, `paqvilo/mirage/testing`, `paqvilo/lense`, `createMirageContext`, `connectRuntime` and `resolveCatalogue`. Existing deep imports remain available; see the [compatibility policy](public-api.md). The branch also includes the [compatibility baseline](../mirage/docs/compatibility-baseline.md) for forms, Liquid, PCF, local CLR plugins and supported flows. Synthetic tests establish local contracts, not complete hosted parity.

## Additional consumer feedback (15–27)

- Fix modal fallback frame geometry and readonly quick view styles; quick views reload after lookup changes.
- Preserve incomplete capture reports, report server error details, and keep safe external dependencies visible without blocking platform styles. `capture-shell --all` captures one safe environment per configured site and reports skips.
- Add semver-covered `paqvilo/mirage/packs` and `paqvilo/mirage/fixtures`, plus cache, paging, audit and rich-text acceptance helpers. Existing public names stay available.
- Add opt-in bootstrap-only preset seeding, registry-derived root CLI help, doctor help and hidden-panel startup notices.
- Render native fields without an in-page PCF alert when no desktop FormXml binding exists. Native validation confirmed authored field, section and subgrid label markup; preserve sanitized presentation markup while keeping record values encoded.
- Modal and quick-view documents include exported site styles and native container wrappers, deduplicating captured styles. Cleared quick views leave the tab order and restore it on reload.
- The starter stacks modal fields at narrower frame widths so lookup values fit beside accessible controls with native container padding.
- Captured Bootstrap 3/5 preform bundles can supply jQuery; the shell records its provider. Passive inspection also accepts a loaded library under an authored filename. A missing provider blocks application.
- Pin quoted CSS URL resolution with a synthetic regression; no parser change was needed on this branch.

## Follow-up consumer feedback (28–31)

- Confirmed native HTTP and non-CSS stylesheet failures remain visible without blocking the shell. Preserve literal percent-encoded CSS URL quotes, flag blocking failures, and report safe hosts and reasons for excluded resources.
- Catalogue/project observations reach form rendering and runtime status. The native-validated sanitized label default remains; an evidenced `encoded` subgrid override applies correctly.
- Accept `mirage.presetMode` in defaults and site settings. Startup and `mirage status` report the preset's application or preservation decision.
- Stable footer repairs avoid repeated style restoration on harmless tooltip mutations, preserving hover. Layout, source-style and stacking changes still re-evaluate overlap and restore the footer when appropriate.

Public API names are unchanged; capture and status reports gain additive provider, observation and failure details.

## Follow-up consumer feedback (32–37)

- Keep report caches, sweep state selection and matrix output in the consumer project, including when the catalogue is outside the working directory. Discovery with no explicit cache performs no writes. Installed-package checks pin cold/warm cache reuse; `--no-cache` remains explicit.
- Inventories and matrix accept `--config`; shared option tables generate registry help and drive all four source-tool parsers.
- Acceptance preserves messages for Chromium SyntaxErrors with an empty stack. `pageErrors` stays a string array; additive `pageErrorDetails` records name, message and stack with the existing redaction policy.
- Local Bootstrap 3.4.1 compatibility exposes plugin constructors, patchable prototypes, instances and `noConflict()`, and supports button toggle/loading/reset. Native plugin implementations stay authoritative; the adapter remains visible in diagnostics.
- Supply missing system choices from the documented [FieldPermission](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/fieldpermission), [ActivityPointer](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/activitypointer) and [SocialProfile](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/socialprofile) references. Solution definitions take precedence. ActivityTypeCode is an open EntityName, so installed/custom activity object codes are not invented. Reference labels are English fallbacks; translations and application-specific extensions come from exported metadata.

No stable public API names are removed. System-choice field metadata gains additive provenance and open-choice indicators.
