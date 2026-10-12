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

Shell capture stays an explicit reference read. The optional automatic-capture mode is not enabled: opening Mirage alone must not silently read a reference portal. Worktrees do not automatically inherit another checkout's `.env`; a shared external project catalogue and local settings provide the documented opt-in arrangement. Disabling a local adapter does not rewrite authored or captured scripts.

Usable default geometry and synthetic compatibility tests do not establish complete hosted parity. The structural CSS and stable error/capture contracts are reusable core behavior; exact deployed styles and observation evidence remain project-owned.
