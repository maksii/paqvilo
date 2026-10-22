# Run a native component comparison

Compare the same exported configuration and synthetic records on an authorized Power Pages
site and Mirage. The [baseline overview](../../../docs/baseline.md), [coverage](coverage.md)
and [comparison reference](parity.md) explain what is measured.

## Prepare the project

Keep your catalogue, scenario matrix, site identity, fixture IDs, persona/reset hooks,
allowlist and evidence in a separate project. Use ignored `.paqvilo/` for captures and
connection files. The public repository supplies reusable generators and invented fixtures;
it supplies no tenant connection, browser identity or ready-made project hooks.

You need Node.js 22 or later and the installed package. Use a toolkit checkout for the
optional fixture-generation scripts below. PAC and an authenticated profile are needed
only when provisioning or deploying a fixture. Original plugin builds also need .NET.
Install the Playwright MCP browser extension in the intended signed-in profile and configure
the project's bridge command. Keep its token in the project's ignored environment file.
Let the operator complete credential or MFA challenges in that browser.

Provisioning, uploads, resets and write scenarios change the selected live environment.
Use an explicitly authorized disposable fixture. Inspect plans before applying them and
keep cleanup receipts. Merely opening Lense or Mirage grants no permission for these actions.

## Optional: prepare the supplied fixture

From a toolkit checkout, inspect each script's help and prepare the synthetic fixture:

```sh
node examples/project/baseline/generate.mjs
node examples/project/baseline/provision.mjs --connection <private-connection-file>
node scripts/baseline-inventory.mjs
npm run test:example
```

Provisioning without `--apply` plans changes. An authorized apply can use `--apply --export`;
plugin registration has its own `examples/project/baseline/plugins.mjs` command. Provision
Dataverse forms before uploading the site's forms. Follow the inventory's
[manual steps](dataverse-inventory.md#manual-steps-maker-portal-only) for unsupported metadata.

Generate an upload folder with your own site identity, then use your PAC workflow to upload
and download the result. Import the downloaded site and the relevant Solution roots into
Mirage. Managed forms, environment rows and application-specific metadata that are absent
from exports need project-owned enrichment. Do not assume a configured root proves the
required component was imported.

The checkout's `scripts/baseline-matrix.mjs` generates scenarios from the supplied fixture
and a project-owned configuration file. Review the resulting matrix, aliases, write scope,
persona probes and reset hooks before capture. Those hooks are project code, not commands
automatically created by the installed toolkit.

## Capture and compare

Run these commands from your project, replacing the example file paths. `paqvilo` means
the locally installed command; use `npx --no-install paqvilo` in an ordinary terminal.
For a checkout, use `node <toolkit>/bin/paqvilo.mjs`.

```sh
paqvilo mirage baseline-suite --help
paqvilo mirage baseline-suite capture --matrix matrix/full.json --out .paqvilo/parity --side live --label live --ids matrix/ids.json
paqvilo mirage baseline-suite capture --matrix matrix/full.json --out .paqvilo/parity --side mirage --config paqvilo.config.yml --site baseline --label mirage --ids matrix/ids.json
paqvilo mirage baseline-suite compare --matrix matrix/full.json --out .paqvilo/parity --allowlist allowlist.json
```

Live capture denies writes by default. Add `--allow-writes` only after reviewing the
matrix's fixture table/page scope and obtaining authorization. Keep authentication,
persona selection and cleanup within the intended browser identity.

Use `--only <ids>` or `--only @matrix/subset.txt` for focused reruns. A list file takes
the first whitespace-delimited token of each nonblank, noncomment line. Reset only the
owned fixture rows affected by that subset. A failed or timed-out mutation may already
have committed: reconcile its planned record IDs before retrying.

For variance evidence, capture an independently repeated live subset with `--label live-2`
and compare using `--second-live live-2`. For changed live fixtures, use the reviewed
`--evidence-changes` contract in the [comparison reference](parity.md#evidence-age-third-kind).
Stale evidence remains a coverage gap until recaptured.

## Interpret the result

Read `report.json`, `summary.md` and each scenario's `diff.json`. Capture folders contain
metadata, DOM, elements, requests, console output, screenshots and same-origin frame data.
A failed capture, unexpected sign-in page or blocked scenario is not successful coverage.
Each capture records `summary.settlements`. Quiet-network readiness waits for visible
loaders and explicitly busy or indeterminate progress controls. A determinate wizard
position indicator does not delay readiness. A settle timeout makes the capture fail
and remains in its problems and settlement records; it is not silently accepted.
`ALLOWED` means differences were explained by the supplied allowlist; it does not mean
identical output. Screenshots are retained but are not compared by the tool.

Review allowlist proposals against their evidence. Do not hide missing controls, permission
failures or incorrect saved data behind broad patterns. Keep raw project evidence private;
publish only deliberately sanitized summaries.
The capture redacts URL query values in embedded DOM, response bodies, frames,
element inventories and console text as well as request URLs. Keep source paths and
structural differences visible when reviewing the sanitized evidence.

Reference portals cache role changes, rows and rendered markup independently. Probe the
effective persona and actual fixture values before capturing; a fixed delay alone is not
proof of readiness. Keep business-rule chains settled and use separate mutation records
for concurrent scenarios. Captcha-protected or otherwise unreachable states need explicit
not-observed reasons rather than invented successful captures.

Record the tested toolkit revision, source fingerprints and evidence dates. Re-run affected
scenarios after fixes, restore owned live changes, close only task-owned browser pages and
runtimes, and retain cleanup receipts. The generated offline reference is a snapshot of a
particular fixture, not a current result for every portal or package version.
