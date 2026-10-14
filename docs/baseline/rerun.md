# Baseline parity runbook

How to rebuild the native-component baseline and rerun the live-versus-Mirage comparison. Every
step is a script; the two maker-portal steps that cannot be scripted are numbered in the
[Dataverse inventory](../../mirage/docs/baseline/dataverse-inventory.md#manual-steps-maker-portal-only).
Environment-specific values (site id, connection file, tester contact, browser profile) live in
your project, never in the toolkit; the commands below name the toolkit's generic scripts and the
project hooks they expect.

## Prerequisites

- Node 22+, PAC CLI, .NET SDK (plugin build), an authenticated PAC profile for the reference
  environment, and a private application connection created with `paqvilo dataverse register|connect`
  (System Customizer is enough for the fixture solution).
- The reference site is the deployed demo (`examples/project`), with the fixture extension
  uploaded on top of it. Fixture components use the `pqvd_` prefix and invented `Baseline…` names.
- A browser bridge that exposes a Playwright page of the signed-in reference profile: the
  reference captures use `@playwright/mcp --extension` against that profile (the project matrix
  carries the command; the toolkit never launches a browser on the live site for these captures).

## Phase 1: Dataverse fixture (tables, columns, forms, views, rules, plugins)

```sh
node examples/project/baseline/generate.mjs
node examples/project/baseline/provision.mjs --connection <private connection.json>            # plan, read-only
node examples/project/baseline/provision.mjs --connection <private connection.json> --apply --export
node examples/project/baseline/plugins.mjs --connection <private connection.json> --apply
node scripts/baseline-inventory.mjs
```

Expected: the plan reports only `exists` after a complete apply (`manual-step-pending` for the
rollup until the maker-portal step is done); `--export` unpacks the `PaqviloBaseline` solution to
`examples/project/baseline/solution/`; `plugins.json` lists eleven steps; the inventory shows every
catalog item as exercised or lists its reason.

## Phase 2: Power Pages fixture site

```sh
node examples/project/baseline/site.mjs
pac pages upload --path examples/project/baseline/site --modelVersion 2
pac pages download --path <project>/baseline/export --webSiteId <site id> --modelVersion Enhanced --overwrite
```

Expected: the upload reports no `XRM Network error`; the download refreshes the export Mirage
renders (`<project>/baseline/paqvilo.config.yml`, site `baseline`, solution roots include the
exported fixture solution, data packs include `examples/project/baseline/pack.mjs`).

## Phase 3 and 4: captures and comparison

```sh
node --env-file=<project>/.env mirage/baseline-suite.mjs capture --matrix <matrix.json> --out <evidence dir> --side live --ids <ids.json> --label live [--allow-writes]
node --env-file=<project>/.env mirage/baseline-suite.mjs capture --matrix <matrix.json> --out <evidence dir> --side live --ids <ids.json> --label live-2 [--allow-writes]
node mirage/baseline-suite.mjs capture --matrix <matrix.json> --out <evidence dir> --side mirage --config <project>/baseline/paqvilo.config.yml --site baseline --ids <ids.json>
node mirage/baseline-suite.mjs compare --matrix <matrix.json> --out <evidence dir> --second-live live-2 --allowlist <allowlist.json>
```

Each scenario folder holds `live/`, `live-2/`, `mirage/` with `requests.json`, `dom.html`,
`elements.json`, `console.json`, `screenshot.png`, `meta.json`, plus `diff.json`; `report.json`
and `summary.md` summarise verdicts (PASS, ALLOWED, FAIL, ERROR) and distinct difference
signatures. A capture whose `meta.json` status is not `captured` (sign-in page, missing expected
element, step error) is never evidence. `--allow-writes` is required for scenarios that save;
writes outside the matrix `writeScope` are aborted and listed in `blockedWrites`.

## Reading the reports

- `summary.md`: one row per scenario and a table of distinct differences, unexplained first.
- `diff.json` per scenario: every delta with scope (request, response, dom, element, console),
  location, field, both values, `allowlist` id when an allowlist entry covers it and
  `liveVariance` when the same delta appears between the two live captures.
- The allowlist is reviewed: every entry needs `proof` (`live-run-variance` or
  `platform-generated`) and an `evidence` path.
