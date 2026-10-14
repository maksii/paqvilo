# Release notes

## 0.9.4

Example qualification tools serialize browser request inputs as data, verify immutable
archive bytes through the exclusive file descriptor, and normalize every relative archive
label prefix. A bounded parser reads the collector's fixed identity context as data without
building a DOM from page text. Hostile-input and archive replacement regressions cover these
security fixes.

Consumer feedback 44, 46-56: declared N:N traversals may select their structural intersect
keys under endpoint permissions, without granting arbitrary intersect-table reads.
Permission joins preserve authored `distinct=false`, including row multiplication.
`PERMISSION_QUERY_ROW_MULTIPLICATION` reports returned/unique roots and grant paths in page
diagnostics and render-sweep summaries. For consumer queries, retain the generated default
`distinct=true`, explicitly select the root primary key, and select only needed columns.
`QueryLinkEntityLimit` includes generated permission links; `PERMISSION_LINK_BUDGET_EXCEEDED`
reports authored/generated counts and grant paths. Evidenced catalogue/project `platform`
defaults reach runtimes, contexts and bootstrap/sweep tools; local overrides still win.

Frame release consumes its response and simulator background traffic no longer delays
acceptance settling. Evidenced paragraph error markup supports hosts reading MessagePanel
paragraphs. Incomplete cached rich-text resources retain compatibility controls; styles-only
capture is available with `--no-rich-text`. Capture success follows usable applied shells,
while `--strict` requires completeness.

Deployment profiles accept source-relative paths and ordered Solution settings file lists.
Unset connection references are skipped with a named diagnostic; malformed entries still
fail. Doctor reports profile file/parse readiness, and YAML errors identify safe file and
line/column locations. Explicitly selected invalid profiles remain startup errors. Dead
runtime discovery records are pruned without removing records owned by living processes.

Parallel local testing now has cookie-isolated `createPortalSession` clients,
`connectRuntime().createSession` and `runSessionMatrix` in `paqvilo/mirage/testing`.
The runner bounds concurrency, serializes caller-owned result recording, reports
throughput/latency, and cancels without retrying mutations. Ten actual HTTP visitors
are covered for scoped Liquid/API reads, own writes and cross-identity denial.
Protected JSON state storage in `paqvilo/dataverse` keeps generated test credentials
encrypted with Windows DPAPI and atomic persistence. Native qualification remains
bound to actual recorded source, actor, query and data witnesses.
Runtime clients also expose sanitized audit export and diagnostics, with exact
actor/correlation filters, bounded sequence windows and visible retention loss
for parallel test investigations.
Validated platform, site-setting, snippet and preset controls are available on
runtime clients with automatic CSRF. Parallel matrices preserve each visitor's
case order while independent visitors advance concurrently.

Consumer feedback 43-45: Liquid has a configurable `mirage.render.timeLimitMs` budget,
cooperative scheduling and per-render FetchXML planning/read indexes. Budget overruns are
checked after async nodes as well as during iteration. Dropdown lookups expose the native
prefixed hidden `_entityname` input, including an empty selection. Synthetic regressions
cover nested queries, concurrent status, budget errors, cache invalidation and lookup anchors.

Outer-link `entityname` NULL conditions already join readable intersect rows by their explicit
columns, with or without relationship metadata; regression tests now cover both. Under
permission enforcement an unmapped intersect remains an ordinary table and needs its own
read grant. A pack can instead declare the N:N relationship for existing structural traversal
with endpoint permissions. Query column names do not establish permission to read private
intersection rows.

Consumer feedback 38-42: usable shell captures survive bounded rich-text discovery, and
default capture exit status follows applied/ready shells (`--strict` requires completeness).
Additional reference ActivityPointer choices fill partial exports. Local modal/quick-view
load follows queued jQuery ready handlers, with diagnostics and an evidenced immediate
override. Atomic basic-form write failures re-render posted values and an error MessagePanel in
both transports; internal details stay in request evidence. Evidenced plain-text error
wording can override the toolkit fallback. Empty native lookup entity-name controls no
longer falsely fail decoding. Advanced forms retain their existing inline save-error contract;
CSRF and malformed/forged controls retain rejection behavior.

- `paqvilo setup` provides a local `/_setup/` workspace for incomplete or broken projects, with portal/source/Git status, guided settings, shared/personal layers and YAML recovery. Mirage mounts it alongside `/_sim/`; Lense prints and links a separate local workspace. Saves validate and detect concurrent edits, preserve unrelated YAML and report when a preview needs restarting. Generated projects and demos include `npm run configure`. See [project setup](setup.md).

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

Reference social-channel choices remain open to installed application extensions, as shown by the additional channels in the [Conversation reference](https://learn.microsoft.com/en-us/dynamics365/developer/reference/entities/msdyn_ocliveworkitem#community); exported choices retain strict validation. No stable public API names are removed. System-choice field metadata gains additive provenance and open-choice indicators.

## Dataverse laboratory and instance configuration

- Reject empty or malformed ports before starting any portal; runtime reuse respects Solution layer order. Failed browser attachment stops the newly created simulator. Shutdown drains accepted read observers, and CLR mode changes reuse or close only their owned hosts.
- Preserve FetchXML string whitespace, restrict parent grants to their named parent and retain permission-filter dependencies during optimization. Large joins enforce row budgets without argument-stack overflow. Ordinary serialized reads avoid cloning unrelated state until an observer or SDK mutation needs rollback protection.
- Compile Mirage portal FetchXML permission paths before RetrieveMultiple observers, with outer hierarchy/N:N joins, alternative grants, scoped query defaults and combined authored/generated link limits. Add bounded role-mask regressions and an evidence-qualified inactive-parent replay. These modeled contracts and historical query comparisons do not establish universal native permission parity.
- Execute read plugin stages 10, 20 and 40, expose explicit portal Context2 identity and clear it in nested SDK calls. Serialized read boundaries support SDK observation writes, preserve independent recordings after later failures and defer successful HTTP responses until persistence completes. Distinct compiler-owned permission paths avoid Cartesian intermediate rows without changing recorded XML.
- Add company-project query/row replay and comparison tools with full-payload checksum/part validation, operation binding, duplicate-row preservation and strict native snapshot/cache qualification. Reports separate structural matches, differences and incomplete observations; unrecorded role subsets remain coverage gaps.

- Add the reusable `paqvilo/dataverse` API and CLI for app connection, additive schema/data provisioning, comparison, paged retrieval checks and scoped server-generated solution exports. The separate Company Operations example supplies the synthetic model, portal harness and plugin source. Its offline tests and loopback browser check run in validation and CI; Windows CI also builds and tests the plugins.
- Add Mirage's Platform rules and Settings & snippet overrides pages with saved/imported/exported presets. Overrides persist per state file without editing shared source, including localized snippets. Nine controls have modeled behavior; the remaining catalogue entries explicitly report their unimplemented services. QueryLinkEntityLimit defaults to 15 and can simulate a support-managed increase.
- Preserve duplicate-row counts in data-query diffs, journal the schema action before mutation, classify interrupted successful responses as unknown mutation outcomes, and enforce attachment policy after plugin changes.
- Replace potentially quadratic alternate-key and whole-template Liquid shorthand regex paths with linear scanners. Preserve shorthand whitespace behavior, reject incomplete/duplicate keys, and validate OAuth identities at the fixed Entra endpoint before sending credentials.
