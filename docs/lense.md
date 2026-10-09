# Lense

Run `paqvilo lense --help` for the full command/options reference.

| Command | Purpose |
| --- | --- |
| `list`, `use` | Inspect available targets and remember a personal site/environment |
| `doctor` | Check configuration, source mapping, Solution inputs and baseline offline |
| `map`, `resources` | Discover online-to-local mappings and editable source descriptors |
| `audit --all --strict` | Independently inventory exports and expose blocked or unaccounted code |
| `dev` | Open a dedicated browser, apply local overlays and watch saves |
| `status` | Compare local resources with authenticated online responses |
| `verify` | Edit a disposable copy and check the browser applies supported changes |
| `agent` | Inspect and control a running owned browser through the bounded authenticated API |

JavaScript, CSS, images and supported inline fields map from discovered export metadata. Literal markup uses baseline patches and rejects ambiguous matches. Lense does not evaluate Liquid locally or apply server-side portal settings. Enhanced XML and code-bearing YAML fields are edited using their discovered field/JSON descriptors; `source-edit.mjs` preserves sibling values and rejects stale identity or paths outside the source extract.

The default scope overlays every local source. `--scope changed` limits overlays to changes since the captured baseline. HEAD is pinned when a target activates; committing later does not erase the baseline. Explicit deployment refs remain explicit. The panel reports Git drift and can pin a fresh HEAD. Shared sources refresh the affected portal's tabs; page sources affect that page; CSS can hot-swap. Pausing reload preserves an unsaved form while saves accumulate.

The panel's **Online / Local** switch compares the browser's responses. **Alt+Shift+P** opens the panel. Mirage sessions add **Inspect** and **Tweaks**. Independent targets stay isolated by origin, environment and source selection.

Agent discovery files contain bearer tokens and stay under ignored `.paqvilo/agents`. Use `agent sessions` to locate a session; `status`, `pages`, `events`, `state`, `snapshot` and `screenshot` inspect it. Page IDs are different from offline resource IDs. Agent control is origin-confined and has no arbitrary evaluation or proxy endpoint. Consume `nextSequence` and report dropped events.

Inspect applied resources, unmatched markup patches, deployment requirements, errors and failed requests after refresh. Audit coverage reports source classification, not successful navigation or browser application. A sign-in page is not successful target coverage. `verify --signed-in` requires closing the matching dev identity first; headed sign-in can be bounded with `--sign-in-timeout`.
