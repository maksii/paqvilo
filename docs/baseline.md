# Native component baseline

The baseline measures how closely Mirage renders native Power Pages components compared with a real portal. It also lets you run the same measurement against your own portal. It is unrelated to the [compatibility baseline](../mirage/docs/compatibility-baseline.md), which summarizes local regression coverage for ordinary Lense and Mirage flows.

## What it is

The baseline has four parts:

- **A fixture.** Invented Dataverse tables, forms, views, business rules and plugin steps, and Power Pages records under `/baseline/`: pages, basic forms, lists, multistep forms, table permissions, web roles and page rules. Scripts in [`examples/project/baseline/`](../examples/project/baseline/) generate and provision it.
- **A scenario matrix.** One scenario per component, variation, state and persona, generated from the fixture.
- **Paired captures.** Each scenario runs once on the live portal, through your own signed-in browser profile, and once on an isolated Mirage built from the downloaded export. Both runs record requests, responses, DOM, an element inventory, console output and a screenshot.
- **A comparison.** It lists every difference. Each difference is explained by a reviewed allowlist entry, counted as stale evidence of a recorded live change, or reported as unexplained.

The generated [Dataverse](../mirage/docs/baseline/dataverse-inventory.md) and [Power Pages](../mirage/docs/baseline/power-pages-inventory.md) inventories map the catalog to the fixture. The [reference](../mirage/docs/baseline/reference.md) records what the live portal showed for each scenario.

## What it guarantees

- **Observed, not assumed.** Successful coverage needs completed capture steps, the expected control state, request outcomes and any saved-row checks. `captured` records completion of the steps. Failed and incomplete captures remain negative evidence, never successful coverage. A sign-in page, an HTTP 200 or a configured mapping is never counted as coverage. States the reference portal cannot show are listed with a reviewed reason ([coverage](../mirage/docs/baseline/coverage.md)).
- **Explained differences only.** A scenario passes when every remaining difference is covered by an allowlist entry. Each entry carries proof that the platform generates the value, or that it varies between two live runs. A live change made after older captures is captured once on representative scenarios and recorded; matching deltas in the older captures count as stale, never as explained behaviour. Mirage never embeds live output to close a gap ([parity](../mirage/docs/baseline/parity.md)).
- **Bounded live writes.** Live writes happen only in runs started with `--allow-writes`, and only inside the matrix's write scope: fixture pages and fixture tables. Every other write is aborted and recorded.
- **No secrets in evidence.** Known platform tokens, cookies and query values are redacted before anything is written, including signed control configurations inside declared encoded view layouts, the attachment upload session handle and declared CSP/HTML nonces. Exact copies of a declared long nonce are protected across that capture's evidence. Changed text hashes describe the redacted text and carry explicit provenance; unchanged assets retain their byte hashes. Evidence stays under your project's ignored `.paqvilo/`. Project hooks and custom components must identify and protect any additional secret fields they introduce.
- **Owned evidence paths.** Scenario IDs use safe relative directory segments, and labels use one portable directory name. The suite checks output paths before starting a runtime or live bridge and rejects linked descendants and hardlinked artifact files. An explicitly selected linked output root remains supported.

It does not guarantee pixel equality, because screenshots are evidence, not compared. It does not cover pages outside the fixture, or configuration the PAC export cannot express.

## Run it against your own portal

You need an environment you are authorised to change, and a site you can upload the fixture to. The baseline writes fixture components and rows. It never changes your site's shared settings.

1. **Set up a project.** Keep it separate from the toolkit ([project extensions](project-extensions.md)). It holds:
   - your site identity file and catalogue
   - the persona and reset hooks
   - `matrix/project.json`: your origin, browser bridge, sign-in and sign-out steps, and optional cache-refresh steps
   - the allowlist, the reasons file, the recorded live changes (`evidence-changes.json`) and the evidence
2. **Provision the fixture and upload the site**, then download the export. Use the scripts in `examples/project/baseline/` and your PAC profile.
3. **Generate the matrix** from the fixture manifest and your project file.
4. **Capture live, capture Mirage, then compare** with `paqvilo mirage baseline-suite`.

The [runbook](../mirage/docs/baseline/rerun.md) explains project inputs and the supported capture/compare commands. It also covers the prerequisites (PAC, a private Dataverse connection, the signed-in browser profile and its bridge token) and the live caching behaviour to plan for: role additions and page markup can lag behind a role change. Your results stay in your project: keep the toolkit generic.

Hooks run in the configured working directory; quote paths and arguments that contain spaces. Windows preserves the authored command line. A successful temporary-admin add hook is paired with its removal hook even when cache refresh fails. Each project hook remains responsible for journalling and reconciling its own partial failure and preserving pre-existing memberships. A failed persona, temporary-admin or reset hook stops further operations and marks remaining scenarios as not attempted until reconciliation. Safe retries belong inside the project hook; the runner does not repeat an uncertain mutation. A browser bridge that fails during setup is closed, and late or incomplete evidence posts cannot satisfy a later scenario's wait.
