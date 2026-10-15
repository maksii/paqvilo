# Baseline rerun runbook

How to rebuild the native-component baseline from a fresh clone and rerun the live-versus-Mirage comparison. The toolkit holds the generic half: the fixture generators under [`examples/project/baseline/`](../../../examples/project/baseline/), the harness (`mirage/baseline-capture.mjs`, `mirage/baseline-suite.mjs`, `mirage/baseline-compare.mjs`) and the generators under `scripts/baseline-*.mjs`. Your project holds the other half: the reference site's identity, the test contact, the persona and reset hooks, the scenario matrix, the allowlist and all evidence. [Coverage](coverage.md) explains what the matrix covers. [Parity](parity.md) explains how the comparison is measured.

Commands below use `<toolkit>` for the toolkit checkout and `<project>` for the project folder that holds the baseline files (`package.json`, `paqvilo.config.yml`, `matrix/`, `scripts/`, `allowlist.json`). Run the project's npm scripts from `<project>`. Run the toolkit commands from `<toolkit>`.

## Prerequisites

| Need | Detail |
| --- | --- |
| Toolkit | Node 22+. Run `npm install` and `node scripts/ensure-dependencies.mjs --check --json --browser msedge`. The plugin build needs the .NET SDK. |
| PAC CLI | An authenticated PAC profile for the reference environment. Site upload and download use it. |
| Dataverse connection | A private application connection created with `paqvilo dataverse register` and `paqvilo dataverse connect` ([provisioning guide](../../../docs/dataverse-provisioning.md)). System Customizer is enough for the fixture solution. The fixture scripts read it from `<toolkit>/.paqvilo/dataverse/provisioning.connection.json`, which is ignored. |
| Reference site | The deployed demo site (`examples/project`, Enhanced data model), with the fixture uploaded on top of it. Fixture components use the `pqvd_` prefix, invented `Baseline…` names and pages under `/baseline/`. |
| Signed-in browser profile | The browser profile of the single test identity, already signed in to the tenant. Personas are web-role sets applied by script to this contact. They are not separate users, because each user would need its own credential or MFA step. |
| Browser bridge | The Playwright MCP extension installed in that profile, and `@playwright/mcp` installed in the project. `matrix/project.json` `live.command`/`live.args` start it (`--extension --browser msedge --profile-dir-name <profile>`). The toolkit never launches its own browser on the live site for these captures. |
| Bridge token | Keep it in the project's ignored `.env` as `PLAYWRIGHT_MCP_EXTENSION_TOKEN`. Every live-side command runs with `node --env-file=<project>/../.env` (the project scripts below already do this). Without it, the MCP call hangs. |
| Project catalogue | `<project>/paqvilo.config.yml`, site `baseline`. Its `source` is the downloaded export. Its `solutionRoots` include `examples/project/baseline/solution` and the project's `platform-solution/`. Its `dataPacks` include the environment-rows pack, and `preset` is `baseline`. Its `observed` settings each carry evidence: `siteVisibility`, `loginPath`, `azureAdAuthority`, `portalApplicationUser`, `portalApplicationUserId` and `listODataFeeds` ([configuration](../../../docs/configuration.md)). |

### Never printed or stored

- The bridge token, the Dataverse connection and its secret, and the `.paqvilo/` discovery files (they hold bearer tokens). Do not print them, copy them into notes or commit them.
- In evidence, the capture writes cookie names only. It replaces anti-forgery tokens, `__VIEWSTATE`, `__EVENTVALIDATION`, file-upload continuation tokens (body and `x-ms-file-continuation-token` header), bearer values and request ids with `{token}`. It redacts query values and stores the live origin as `{site}`.
- Evidence stays under the project's ignored `.paqvilo/`. Readable reports may cite evidence paths, never token values.
- Sign-in runs through the site's own sign-in page and the profile's single sign-on. Credential and MFA prompts belong to the human. When sign-in fails, the suite saves the page under `<out>/_sign-in/` and stops. Sign in once in the profile, then rerun.

## Order of operations

Each step is a script. Run them in this order. A later step reads what the earlier one wrote.

### 1. Fixture generation, provisioning and solution export

From `<toolkit>`:

```sh
node examples/project/baseline/generate.mjs
node examples/project/baseline/provision.mjs --connection .paqvilo/dataverse/provisioning.connection.json            # plan (read-only)
node examples/project/baseline/provision.mjs --connection .paqvilo/dataverse/provisioning.connection.json --apply --export
node examples/project/baseline/plugins.mjs --connection .paqvilo/dataverse/provisioning.connection.json --apply
node examples/project/baseline/plugins.mjs --connection .paqvilo/dataverse/provisioning.connection.json --verify
node scripts/baseline-inventory.mjs
node --test examples/project/test/baseline-*.test.mjs test/dataverse-provisioning.test.mjs
```

What to expect:

- After a complete apply, the plan reports only `exists`.
- `--export` unpacks the `PaqviloBaseline` solution to `examples/project/baseline/solution/`. The export fails on any `MissingDependency` entry except self-dependencies on the System solution.
- `--verify` is read-only. It writes `plugins-readback.json`, which the inventory reads.
- The rollup column cannot be scripted, because Dataverse accepts rollup definitions from the maker portal only. Follow the numbered [manual steps](dataverse-inventory.md#manual-steps-maker-portal-only). Until you do, the plan reports `manual-step-pending`.

Provision the Dataverse forms before you upload the site. `pac pages upload` resolves each basic form's or step's form name to a form id. When the form does not exist yet, the upload fails with "Expected non-empty Guid".

### 2. Site upload and export download

From `<project>`:

```sh
npm run site:generate     # node <toolkit>/examples/project/baseline/site.mjs --identity site-identity.json --out ../.paqvilo/baseline/site-upload
npm run site:upload       # pac pages upload --path ../.paqvilo/baseline/site-upload --modelVersion 2
npm run export:download   # pac pages download --path export --webSiteId <website id> --modelVersion Enhanced --overwrite
```

- The toolkit commits `examples/project/baseline/site/`, generated with the demo's own identity. The project generates its upload folder with its own site identity (`site-identity.json`) into an ignored folder.
- The upload adds and updates records under `/baseline/` only. It never changes the shared site's global settings, default roles or header and footer snippets ([coverage](coverage.md#deliberately-out-of-scope)).
- Mirage renders the refreshed export, so download again after every upload.

### 3. Platform components and environment rows

From `<project>` (both scripts are read-only Web API reads, deterministic, and rewrite their output on every run):

```sh
node --env-file=../.env scripts/platform-components.mjs   # platform-solution/: managed forms and app-owned columns the fixture renders
npm run environment-rows                                  # node --env-file=../.env scripts/environment-rows.mjs → data/environment-rows.json
```

- **`platform-components.mjs`** writes platform components that the fixture solution cannot carry. Dataverse does not export an unmodified managed form, and the fixture does not customise managed forms. The output is the managed Contact main form, the columns that an installed app owns, and their global choices, plus the ActionCards view and the `actioncard` and `cardtype` table definitions that form's subgrid renders. Mirage merges attribute definitions across solution roots.
- **`environment-rows.mjs`** writes three kinds of data:
  - `views` and `tables`: the rows that the live lookups show from shared tables, such as the default contact and account lookup views. It reads them with the view's filter and sort, so Mirage holds the same records. The live tester is left out of these rows, because the suite rekeys the fixture tester to that id.
  - `records`: the fixture rows' live `createdon`/`modifiedon` stamps and file columns, so Mirage renders the same values as live.
  - `identity`: the tester contact's form columns, and its parent account both at rest and under the account-scope persona.
- The pack module wraps the fixture pack, because two packs cannot both define the `baseline` preset. When ids collide, the fixture row wins.
- `mirage inspect --json` shows forms only as a count and does not list data packs. To check that a root or pack is loaded, recapture an affected scenario and compare.

### 4. Matrix generation

```sh
npm run matrix   # node <toolkit>/scripts/baseline-matrix.mjs --out matrix/full.json --project matrix/project.json
npm test         # offline project checks (matrices, aliases, hooks, catalogue)
```

The generator reads the fixture site manifest and merges in the project file: `origin`, the `live` bridge with its `signIn` and `signOut` steps (and optional `refresh` steps), the `hooks`, `mirageContact`, `mirageIdentity`, `formTabs`, `personaPages` and `behaviourPages`. `matrix/ids.json` is the project's private alias map. It holds the fixture aliases (`item1`, `parent1` and so on), the live `tester` contact and `missing` (the zero GUID).

### 5. Live capture

Reset the live fixture rows first, then capture:

```sh
npm run reset:live          # node scripts/reset-live.mjs --apply
node --env-file=../.env <toolkit>/mirage/baseline-suite.mjs capture --matrix matrix/full.json --out .paqvilo/parity/full --side live --label live --ids matrix/ids.json --allow-writes [--only <ids>|@<file>]
```

The project script `npm run capture:live -- --matrix … --out …` wraps the same command. Run it in the background and follow its log. It prints one JSON line per scenario, with the phase timings in `ms` (persona, reset, capture).

For each scenario, the suite runs the steps below:

1. **Personas.** The suite groups scenarios by persona. On each switch it runs the persona hook (`node baseline/scripts/persona.mjs --persona {persona} --apply`), and confirms sign-in. It then runs the persona's `verify` probes, which include a check that the session holds no administrator rights (`/_services/about` offers no clear-cache control). Every probe must pass in the same attempt (8 attempts, 10 s apart, then a 3 s settle). No cache clear runs, so the probes are the only gate: role removals reach the portal in about 20 s, but role additions (table-permission roles in particular) can lag past the probe window. A project whose test identity may clear the cache can still add optional `live.refresh` steps, which the suite runs after the switch and before the probes. When a persona group fails its probes and the project configures `hooks.liveAdminAdd`, `hooks.liveAdminRemove` and `live.clearCache`, the suite runs one cache-clear cycle and probes again (see [Live gotchas](#live-gotchas)). Anonymous personas sign the portal session out first. When a persona fails, its whole group fails at once and the bridge stays open.
2. **Settle-aware reset.** The reset hook (`node baseline/scripts/reset-live.mjs --apply`) writes only fields whose live value differs, and skips an unchanged file. It then waits until the written rows are quiet: `modifiedon` unchanged for 10 s and no workflow job open, polled every 3 s, bounded at 120 s. If Dataverse returns a transient error, the suite retries the reset once.
3. **Write guard.** Without `--allow-writes`, every non-GET is aborted and listed in `meta.blockedWrites`. With it, writes are still limited to the matrix `writeScope` (fixture page paths, `/_services/`, `/_portal/`, `/_api/` and the fixture entity sets). The portal's read-only POSTs (grid data, subgrid data, notes listing) always pass.

### 6. Mirage capture

```sh
node <toolkit>/mirage/baseline-suite.mjs capture --matrix matrix/full.json --out .paqvilo/parity/full --side mirage --label mirage --config paqvilo.config.yml --site baseline --ids matrix/ids.json [--only <ids>|@<file>]
```

The Mirage side starts an isolated runtime from the catalogue: export, solution roots, data packs, preset and observed settings. Before every scenario it resets the whole simulated state. It then mirrors the live tester's observed name, parent account and base roles onto the preset contact, and rekeys that contact to the live contact id (`mirageIdentity`). The mirror is persona-aware: the suite re-applies it on every persona switch, with the fields that persona changes on live (for example the account-scope parent account). The capture browser keeps its scrollbars, because the live browser has one and dialogs measure it.

### 7. Compare with the allowlist

```sh
node <toolkit>/mirage/baseline-suite.mjs compare --matrix matrix/full.json --out .paqvilo/parity/full --allowlist allowlist.json [--second-live live-2] [--evidence-changes evidence-changes.json] [--only <ids>|@<file>]
```

`--evidence-changes` names the project file of recorded live changes (D15: a change is captured once, on representative scenarios, not on every page it touches). Deltas in older live captures that match a recorded change count as stale once its proof scenarios pass ([parity](parity.md#evidence-age-third-kind)). Record a change there, with its proof ids, whenever a fixture upload, a role change or new rows alter what live renders, instead of recapturing every affected scenario.

The compare writes `diff.json` per scenario, plus `report.json` and `summary.md` at the evidence root. [Parity](parity.md) explains how to read them.

### 8. Reference document


```sh
node <toolkit>/scripts/baseline-reference.mjs --evidence <project>/.paqvilo/parity/full --matrix <project>/matrix/full.json --reasons <project>/matrix/reasons.json
```

This regenerates [reference.md](reference.md) from the live evidence only. For each component, state and persona it lists what was visible, the request sequence, the driving configuration record, and the reviewed reason or note. Its header counts observed, noted and not-observed rows.

### 9. Variance run

Capture a second live run of a reviewed subset only (no blanket recaptures, D13). Derive the subset from the current `diff.json` files: the fewest scenarios such that each `live-run-variance` allowlist entry is matched in two paired scenarios. Record the entry-to-scenario map in the project (for example `matrix/live-2-subset.json`) and write its ids to the `--only` list. Then compare with `--second-live`:

```sh
node --env-file=../.env <toolkit>/mirage/baseline-suite.mjs capture --matrix matrix/full.json --out .paqvilo/parity/full --side live --label live-2 --ids matrix/ids.json --allow-writes --only @matrix/live-2-only.txt
node <toolkit>/mirage/baseline-suite.mjs compare --matrix matrix/full.json --out .paqvilo/parity/full --allowlist allowlist.json --second-live live-2
```

In a paired scenario, an allowlist entry with `live-run-variance` proof explains a Mirage delta only when the two live captures also differ under that entry. In unpaired scenarios it applies on the strength of the paired evidence, which the report's `variance` table shows ([parity](parity.md#allowlist-model)). Run the subset on final evidence.

## Evidence layout

```text
<project>/.paqvilo/parity/full/
  <component>/<variation>/<state>/<persona>/
    live/      meta.json  dom.html  elements.json  requests.json  console.json  frames.json  screenshot.png
    live-2/    (same files, second live run)
    mirage/    (same files, Mirage run)
    diff.json  (written by compare)
  run-<label>.json                    latest run of a label (totals, per-scenario status and timings)
  run-<label>-<startedAt>.json        every earlier run, kept
  report.json  summary.md             compare output
  _sign-in/                           pages saved by a failed sign-in, sign-out, refresh or persona probe
```

`frames.json` holds the DOM of each same-origin frame by URL path, and the frame's elements appear in `elements.json` with the selector prefix `frame(<path>) `. Captures taken before frames were inventoried have no `frames.json`.

`meta.json` records the status (`captured`, `failed`, `error`), problems, `blockedWrites`, the phase `timeline`, the redacted final URL and the title. A capture whose status is not `captured` is never evidence. This covers a sign-in page where the site page was expected, a missing expected element and a step error. Keep superseded folders out of the evidence root, for example in an archive folder. Compare ignores folders of ids that are no longer in the matrix.

## Live gotchas

- **Permission cache.** The portal caches permissions. After a web-role change or a site upload, it kept serving the previous persona's permissions for minutes, and in one run for 59 min of polling. Record pages opened by an earlier persona kept their old permissions for more than 10 min. Those runs used personas that kept an administrator role, whose `/_services/about` clear-cache control made a role change visible on the next request. The personas are now admin-less, so that control is gone:
  - **Removals** land in about 20 s.
  - **The administrator role** itself reached the portal in about 20–27 s, both when added and when removed (four measurements).
  - **Additions** can lag. Table-permission roles written for the editor and account-scope personas were not applied within the 8 × 10 s probe window, nor five minutes after the write.
  - **Per-page lag.** Markup tied to a role, such as the content-editing attributes administrators get, leaves the portal page by page. One page kept it about 32 min after the role write while other pages had switched. A passing probe therefore does not prove every page has switched. Record such a change with a `staleBefore` instant (see the compare step).

  Persona-switch procedure:
  1. Write the persona's web roles (the persona hook).
  2. Probe until every probe passes in the same attempt. Make each persona's probes tell it apart from the editor and from the persona captured before it, and use a probe record that no other persona opens.
  3. If the group still fails, the suite runs one cycle: the `liveAdminAdd` hook re-adds the site's administrator role (by id) to the test contact, the `live.clearCache` steps are retried until `/_services/about` offers the control and clear the cache, and the `liveAdminRemove` hook removes the role. It then probes again; the admin-less probe keeps any capture from starting before the removal has landed. A second failure fails the group. Each cycle settled the persona within about 3 min (run 8b).
- **Record cache.** After a reset, the portal served a stale record for minutes (an activated row still looked deactivated). Each actions variant therefore acts on its own reserved deactivated row (`T.actionRecords`, `item9` to `item11`). A deactivate scenario activates its row first and then deactivates it. When the project defines `live.refresh`, the action scenarios and a save followed by a reload run those steps as harness-only steps (`harness: true`, no evidence recorded); without it they run without a cache clear.
- **Business-rule chain.** The fixture provisions its rules as background workflows. A rule's write sends the whole record image back. Before the rules had guard conditions, one reset started a chain that rewrote fixture rows every ~5 s for ~90 s. Any portal save inside that window was silently overwritten. Two things prevent it: the guard conditions on the set-value and clear-value rules, and the diff-only, settle-aware reset. Treat a capture of a save made inside a chain window as suspect, and recapture it.
- **Captcha.** Captchas are never bypassed. A form or step that requires one is captured in its captcha-validation state. Every state behind it is recorded as not observable.
- **Scope personas.** A parent-scoped (child) table permission inherits the web roles of its parent permission. Give the parent-scope chain its own root permission, or every role that reads the parent reads every child through it. The account-scope persona also sets the tester's parent account, and the next persona switch restores it.
- **Site-wide page rules.** A site-wide rule that grants change to a role the tester keeps (for example, administrators) overrides restrict-read for every signed-in persona, so page-rule effects are then observable for the anonymous visitor only. Keep that role off every persona: the matrix then derives each page-rule scenario's expectation from the rule configuration (for example a 403 for a signed-in persona the rule does not admit).
- **Search.** List search is begins-with. Scenarios search with a leading wildcard (`*Alpha`).
- **Hit targets.** When site CSS collapses a submit control to a few pixels, the step uses `{ click, dispatch: true }`.

## Extending the baseline

**Add a scenario.**

1. Add the record to the fixture site generator (`examples/project/baseline/site.mjs`) or add the state to `scripts/baseline-matrix.mjs`. Scenarios derive from the manifest's records, their table facts (`TABLES`) and their metadata records.
2. Regenerate the matrix.
3. Capture only the new or changed ids with `--only @<file>`, on both sides. A list file has one scenario per line, and the first whitespace-delimited token is the id. That means `id<tab>reason` and `id  # reason` lines both work. `#` comment lines and blank lines are skipped. A list that yields no id stops the suite with an error.
4. Compare those ids with `--only`.

Non-editor personas run only on the pages listed in `personaPages`. Behaviour states (validation, plugins, lookups, notes) run only on the forms listed in `behaviourPages`. Variant forms capture only the states their own configuration changes.

**Add a persona.**

1. Add the web role and its table permissions to the fixture site.
2. Add an entry to `PERSONAS` in `scripts/baseline-matrix.mjs`, with `roles` and `verify` probes that tell it apart from every persona it can follow. Probes must use records no other persona opens.
3. Teach the project's persona hook to apply it.

Mirage mirrors the same role names, plus the project's observed base roles, on the synthetic contact.

**Add an allowlist entry.**

1. Write a proposal to `<project>/allowlist-proposals/<area>.json` with `{ id, scope, pattern, field, reason, proof, evidence }`. You can add an optional `value` regex. The proposal is not self-approved.
2. Set `proof` to `platform-generated` or `live-run-variance`:
   - `platform-generated`: cite the Learn page or the live evidence that shows the platform generates the value (hosting headers, correlation ids, telemetry, platform runtime assets).
   - `live-run-variance`: the value differs between two live captures of the same scenario.
3. The author reviews the proposal. The author merges it into `allowlist.json` and extends the file's `reviewed` stamp, or moves it to `allowlist-proposals/rejected.json` with `rejectedBecause`. A difference the compare can normalise without hiding a missing element is fixed in the compare, not allowlisted ([parity](parity.md#allowlist-model)).

**Add a reason entry.**

- Add `"<scenario id>": "<reviewed note>"` to `matrix/reasons.json` to explain a captured row.
- Add `{ "notObserved": "<reason>" }` for a state the reference portal cannot show.

The reference prints the text on the row. Every reason names the evidence or the ledger item it rests on. A sign-in page, an HTTP 200 or a configured mapping is not a reason.
