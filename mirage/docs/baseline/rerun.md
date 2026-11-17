# Run a native component comparison

Compare the same exported configuration and synthetic records on an authorized Power Pages site and in Mirage. The
[baseline overview](../../../docs/baseline.md), [coverage](coverage.md) and [comparison reference](parity.md) explain
what is measured.

Provisioning, uploads, resets, write scenarios and cache steps change the live environment. Use an explicitly
authorized disposable fixture, review plans before applying them and keep cleanup receipts. Opening Lense or Mirage
grants no permission for these actions.

## 1. Prepare the project

Keep the catalogue, scenario matrix inputs, site identity, fixture IDs, persona and reset hooks, allowlist, reasons
file, evidence changes and captures in a separate project, with captures and connection files under ignored
`.paqvilo/`. The toolkit supplies generators and invented fixtures, not a tenant connection, browser identity or hooks.

You need:

- Node.js matching the package `engines` (`^26.13.1`) and the installed package; a toolkit checkout for the fixture
  scripts below.
- PAC and an authenticated profile only to provision or deploy the fixture; .NET only to rebuild the plug-in assembly.
- A browser bridge that exposes a Playwright page, configured in the matrix's `live.command` and `live.args` (for
  example `@playwright/mcp --extension` in the intended signed-in profile). Keep its token in the project's ignored
  environment file. The operator completes credential and MFA challenges.
- Optionally `live.cdpUrl`: the loopback debugging endpoint of the live browser, for a bridge started with
  `--cdp-endpoint`. With it, the suite holds a browser-level write net around every live run, covering every page the
  capture drives (popups and frames included) from their first request, even with another debugging client attached.
  A tab opened in that browser during a capture counts as the capture's own; its portal writes are refused and listed,
  as is a write whose page cannot be identified. Without `live.cdpUrl`, the capture runner guards writes per page.
  An unreachable or non-loopback `live.cdpUrl` (or one with credentials) fails every live run, and a capture whose page
  did not open in that browser stops with `live.cdpUrl is not the bridge browser: the capture page did not open there,
so the browser-level write net did not cover it.` without merging evidence.

## 2. Prepare the fixture (toolkit checkout)

```sh
node examples/project/baseline/generate.mjs
node examples/project/baseline/provision.mjs --connection <private-connection.json>
node examples/project/baseline/provision.mjs --connection <private-connection.json> --apply --export
node examples/project/baseline/plugins.mjs --connection <private-connection.json> --apply
node examples/project/baseline/plugins.mjs --connection <private-connection.json> --verify
node examples/project/baseline/site.mjs --identity <site-identity.json> --out <upload-folder>
node scripts/baseline-inventory.mjs
npm run test:example
```

- `generate.mjs` writes the Dataverse manifest and extras for the invented tables.
- `provision.mjs` without `--apply` prints the plan; `--apply` writes, `--export` exports the unmanaged fixture
  Solution next to the script for Mirage. The connection file is a private application connection from
  `paqvilo dataverse register|connect`. Provision Dataverse forms before uploading the site.
- `plugins.mjs --apply` registers the plug-in steps; `--verify` is read-only and writes `plugins-readback.json`.
- `site.mjs` writes an upload-ready PAC site folder with only the fixture records, for your site identity (default:
  the bundled `site-identity.json`). Upload and download it with your PAC workflow, then import the downloaded site and
  the Solution roots into Mirage. Managed forms, environment rows and metadata absent from exports need project-owned
  enrichment; a configured root does not prove a component was imported.
- `scripts/baseline-inventory.mjs` regenerates [dataverse-inventory.md](dataverse-inventory.md) and
  [power-pages-inventory.md](power-pages-inventory.md) and fails on an unexplained catalog item. Rerun it after any
  fixture change, provisioning export or plug-in readback. Follow the
  [manual steps](dataverse-inventory.md#manual-steps-maker-portal-only) for metadata the scripts cannot provision.

Generate the matrix from the fixture manifest and your project file (origin, bridge, sign-in and sign-out, persona and
cache-refresh steps, hooks), then review its aliases, write scope, persona probes and hooks before capturing:

```sh
node scripts/baseline-matrix.mjs --out matrix/full.json --project matrix/project.json
```

## 3. Capture and compare

From the project (`paqvilo` is the installed command: `npx --no-install paqvilo`, or `node <toolkit>/bin/paqvilo.mjs`):

```sh
paqvilo mirage baseline-suite capture --matrix matrix/full.json --out .paqvilo/parity --side live --label live --only @matrix/subset.txt
paqvilo mirage baseline-suite capture --matrix matrix/full.json --out .paqvilo/parity --side mirage --config paqvilo.config.yml --site baseline --label mirage --ids matrix/ids.json
paqvilo mirage baseline-suite compare --matrix matrix/full.json --out .paqvilo/parity --allowlist allowlist.json
```

- A live capture must name its scenarios with `--only <ids>`, `--only @<file>` or `--all-scenarios`; otherwise it is
  refused before the bridge starts, and an unknown `--only` ID is refused before anything is written. A list file takes
  the first whitespace-delimited token of each nonblank, non-`#` line. `--ids` holds record alias values only and never
  selects scenarios.
- Live capture refuses writes unless `--allow-writes` is given; add it only after reviewing the matrix's fixture table
  and page scope and obtaining authorization. A matrix with live cache-refresh or clear-cache steps is refused at
  set-up without `--allow-writes`, because those steps write to the portal.
- For focused reruns, reset only the owned fixture rows the subset touches. A failed or timed-out mutation may have
  committed: reconcile its planned record IDs before retrying.
- For variance proof, capture an independent repeat of a live subset with `--label live-2` and compare with
  `--second-live live-2`. For live changes after older captures, pass `--evidence-changes FILE`
  ([evidence changes](parity.md#evidence-changes)). Stale evidence stays a coverage gap until recaptured.

From the toolkit checkout, regenerate the offline [reference](reference.md) from the live captures (never edit it by
hand); `--out` defaults to `mirage/docs/baseline/reference.md`:

```sh
node scripts/baseline-reference.mjs --evidence <project>/.paqvilo/parity --matrix <project>/matrix/full.json --label live --reasons <project>/reasons.json
```

## 4. Interpret the result

| Command   | Exit code                                                                                                                                     |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `capture` | `0` every scenario succeeded; `1` failed assertions or blocked writes, or a validation/setup failure; `2` execution errors in a completed run |
| `compare` | `0` no `FAIL` or `ERROR` verdict; `1` otherwise                                                                                               |

A completed capture writes `run-<label>.json` (latest) and `run-<label>-<startedAt>.json` (history) before setting
its exit code; `compare` writes `report.json` and `summary.md`. Read those and each scenario's `diff.json` even when
the command fails.

- Capture folders hold metadata, DOM, elements, requests, console output, screenshots and same-origin frames. A failed
  capture, an unexpected sign-in page or a blocked scenario is not coverage.
- `summary.settlements` records readiness: quiet-network waits include visible loaders and busy or indeterminate
  progress controls (not a determinate wizard position). A settle timeout fails the capture and stays in its problems.
- `stepOutcomes` marks each top-level matrix action `performed`, `skipped` (optional absent or hidden target) or
  `error` (including an invalid optional selector). The step count and timeline include skipped actions, so they do
  not prove an action ran.
- `ALLOWED` means the allowlist explained the differences, not identical output. Screenshots are not compared.
- The capture redacts URL query values in requests, embedded DOM, response bodies, frames, element inventories and
  console text. Keep raw evidence private; publish only deliberately sanitized summaries.
- Reference portals cache role changes, rows and rendered markup independently: probe the effective persona and actual
  fixture values before capturing; a fixed delay is not readiness. Use separate mutation records for concurrent
  scenarios. Captcha-protected or unreachable states get reviewed not-observed reasons, never invented captures.

Finish by recording the toolkit revision, source fingerprints and evidence dates, restoring owned live changes,
closing only task-owned browser pages and runtimes, and keeping cleanup receipts.
