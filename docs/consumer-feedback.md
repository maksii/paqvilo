# Consumer feedback decisions for 0.9.4

These changes use invented data, exported fixture structures and loopback services. Customer exports, business rules, capture receipts, personas and acceptance suites remain in their own project. See [project extensions](project-extensions.md), [public APIs](public-api.md) and [release notes](release-notes.md).

| # | Toolkit implementation and intended use | Verification |
| --- | --- | --- |
| 1 | Reversible footer repair checks clipping and hit testing; fixed/sticky/modal layers are excluded. `mirage.compat.footerSpacing: false` omits the fallback. | Footer browser regression and local override tests |
| 2 | Retain raw navigation names alongside normalized plugin targets for enforced create/update validation and atomic rejection. | DataStore unknown-binding rollback and existing known-binding CRUD regressions |
| 3 | Authored structural entity-form CSS is the uncaptured fallback. Placeholder/captured state appears in status, doctor and administration; form diagnostics and missing head stylesheet lists remain explicit. Confirmed native HTTP failures of dependent assets are classified separately. | Form geometry, provider/diagnostic, platform manifest and shell capture tests |
| 4 | Explicit catalogue shell capture owns an anonymous temporary browser or uses supplied loopback CDP. Matching runtime ownership selects the admin API; otherwise a temporary simulator persists state. Cleanup disconnects and closes only owned resources. | Failure cleanup, refusal, standalone state, running runtime and temporary CDP browser tests |
| 5 | Add supported runtime, acceptance, testing and Lense entry points with an export contract and semver policy. Existing deep imports receive a full minor release migration period. | Public export contract and packed distribution smoke |
| 6 | Check actual Node resolution and locked Mirage dependency versions in npm layouts without a second install. Expose `paqvilo doctor --setup`. | Synthetic packed layouts and readiness before setup in package smoke |
| 7 | Use a public tool registry for standalone Mirage routing/help, including the missing reference/query/verify tools. | Every registered tool's public help and existing CLI regressions |
| 8 | `createMirageContext` accepts one `packs` input and translates legacy options while binding the common library. Synchronous APIs keep their signatures instead of becoming unexpectedly asynchronous. Catalogue and Mirage-project packs are explicit. | Bound store/runtime/bootstrap presets, configured packs and pack isolation |
| 9 | A loopback runtime client resolves catalogue ports/discovered sessions, carries CSRF automatically, and provides configured-persona sign-in and local administration helpers. | Fetch/Playwright sign-in, CSRF rejection, configured port and capture integration |
| 10 | Named boolean compat switches and confined project head assets provide local-only overrides. They are served from a reserved local path and reported; no source export changes. | Unknown switches, confinement, order, asset serving and bundled adapter omission |
| 11 | Public resolved catalogue paths include source root, site sources, Solution roots, port/state file and provenance. A starter workspace generator consumes them. Shared external catalogues/local settings support worktrees explicitly. | Shell, .env, local configuration and catalogue provenance |
| 12 | Starter LF attributes are copied during scaffolding; consumer docs describe installation, readiness, project tests and capture. | Release allowlist/links and installed scaffold smoke |
| 13 | Package/locks use 0.9.4; the version command and release notes explain explicit migration from incompatible old ranges. | Version CLI, lock consistency and release checks |
| 14 | Toolkit-owned regressions cover three-way state migration, compact pack persistence, admin preset hydration/editing and permission-filtered plugin relationship traversal. Migration respects explicit mapping overrides even when old inference provenance remains. | Small synthetic migration, preset persistence, admin API and plugin-expression fixtures; no reference reads or large generated libraries |


| 15 | Fallback modal frames fill their body without a border and use the platform's 700px height; captured CSS still replaces the fallback. | Synthetic modal width, height and inside-column browser assertions |
| 16 | The client retains incomplete capture reports and includes API error messages; the CLI prints failures and exits one. | Fake responses and an actual loopback CLI/runtime failure with cleanup |
| 17 | External jQuery references and external dependencies of exported CSS are visible diagnostics without downloading third-party bytes. Optional external resources can leave an applied, incomplete report. Required platform resource failures still block application. | Synthetic shell capture, no external requests |
| 18 | `--all` captures each configured site once, choosing a safe default or the matching runtime environment; caution targets and shared state files are reported as skipped. | Two-site catalogue with caution environments |
| 19 | Supported packs/fixtures entry points and additional acceptance helpers replace the requested deep imports. | Public export contract |
| 20 | Quoted and unquoted relative CSS URLs already parse correctly on this branch; regression coverage pins the identical resolved path and deduplicated fetch. | Three quoting forms in one small CSS fixture |
| 21 | Root help uses the tool registry, and doctor has its own option help. | Public CLI help assertions |
| 22 | Lookup selection, native change and jQuery change reload quick views with the full parameter contract; clearing blanks them. | Browser lookup selection, scripted change and clear |
| 23 | Quick view documents use the modal document's platform head and structural readonly controls. | Captured/placeholder stylesheet comparison and browser geometry |
| 24 | Metadata without a FormXml PCF binding renders the native control and records a diagnostic. Real unsupported bindings retain their alert. | Native email input and status diagnostic browser assertions |
| 25 | Authorized sandbox observations confirmed presentation markup in field, section and subgrid labels. Authored labels preserve sanitized markup by default; record values remain encoded. The evidenced subgrid encoding override remains available. | Synthetic markup, script/handler sanitization and encoded override |
| 26 | Opt-in `mirage.presetMode: bootstrap` / `--preset-mode bootstrap` seeds only a new state file; `always` preserves existing behavior. Startup/status reports the decision. | Seed, create, restart preservation and explicit reset |
| 27 | Hidden panel state is named in startup output with its configured reveal shortcut. | Persisted panel state and startup notice |

Shell capture stays an explicit reference read. The optional automatic-capture mode is not enabled: opening Mirage alone must not silently read a reference portal. Worktrees do not automatically inherit another checkout's `.env`; a shared external project catalogue and local settings provide the documented opt-in arrangement. Disabling a local adapter does not rewrite authored or captured scripts.

Usable default geometry and synthetic compatibility tests do not establish complete hosted parity. The structural CSS and stable error/capture contracts are reusable core behavior; exact deployed styles and observation evidence remain project-owned.
