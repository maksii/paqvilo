# Dead-code and duplication review

`npm run review:code` runs inside `npm run quality`, the pre-commit hook and CI. It first checks that the five generated
jQuery compatibility watchers match their single authored fragment (`scripts/generate-compat-watchers.mjs --check`),
then runs `scripts/code-review.mjs --check` (`--help` lists its modes):

| Analysis   | Tool        | Scopes                                                                                                      |
| ---------- | ----------- | ----------------------------------------------------------------------------------------------------------- |
| Dead code  | Knip 6.45.1 | `runtime` (product entries only) and `full` (product and test entries)                                      |
| Duplicates | jscpd 5.4.3 | `runtime` (`bin/`, `lense/`, `mirage/`), `tests`, `support` (scripts, example components and build support) |

Findings are written to `.paqvilo/code-review/findings.json` with per-scope reports beside it, and compared with the
reviewed baseline `scripts/code-review-baseline.json`. New files, exports, unresolved imports and clone occurrences
fail; so do tool errors and empty clone scans. Clone keys combine the file pair and a normalized fragment digest, so
line shifts do not create noise, and occurrences are counted: another copy of an accepted fragment still fails. CI never
removes code or refreshes the baseline.

## How the graph is modelled

`scripts/code-review.config.mjs` names the entries: commands, supported public APIs, browser URLs (aliases mirror the
asset routers) and independently spawned workers. Package wildcard paths are implementation details under the
[public API contract](public-api.md), and Knip would promote them to entries and hide orphan modules, so the analysis
runs on a temporary snapshot whose manifest omits the wildcard keys. Named APIs and dependency resolution stay intact;
the real manifest is never changed, inspected code is never executed, and ignored or linked paths (`.paqvilo/`,
`node_modules/`, junctions) are refused. Named and wildcard reexports of the public entries are followed statically to
their declarations, so public names are preserved.

Runtime-only findings include exported test seams that only the full unit, browser or SDK graph consumes; such a seam
may keep a reviewed baseline disposition when removing the export would weaken a direct assertion. The three fake
modules named below have test consumers and intentionally no product caller. `dashboard-icons.icon` is a namespace false
positive: both apps pass the module to the renderer, which calls `icons.icon`.

## Updating the baseline

Fix actionable findings first. Then inspect `findings.json` and run:

```sh
node scripts/code-review.mjs --write-baseline
```

It keeps the reason of every finding the baseline already holds and gives a new finding the standard reason for its
category. It refuses unresolved imports, full-graph orphan files, unused full-graph exports, runtime orphans other than
the three `mirage/testing` fakes (`amqp-fake-broker`, `azurite-fake`, `owned-fixture`) and runtime clones without a
category in `reviewedCloneReason`. Review every baseline diff by hand. Static tools cannot prove the absence of every
dead path or semantic duplicate; `test/code-review.test.mjs` uses synthetic canaries (body-only orphans behind package
wildcards, unused exports, copied logic, count growth, URL resolution, public reexports) to show the tools still detect
them.
