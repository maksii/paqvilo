# Release notes

## 0.9.4

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

Public API additions: `paqvilo/mirage`, `paqvilo/mirage/acceptance`, `paqvilo/mirage/testing`, `paqvilo/lense`, `createMirageContext`, `connectRuntime` and `resolveCatalogue`. Existing deep imports remain available; see the [compatibility policy](public-api.md). The branch also includes the [compatibility baseline](../mirage/docs/compatibility-baseline.md) for forms, Liquid, PCF, local CLR plugins and supported flows. Synthetic tests establish local contracts, not complete hosted parity.
