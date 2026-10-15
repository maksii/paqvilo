# Native component baseline

The baseline measures how closely Mirage renders native Power Pages components compared with a real portal. It also lets you run the same measurement against your own portal.

## What it is

The baseline has four parts:

- **A fixture.** Invented Dataverse tables, forms, views, business rules and plugin steps, and Power Pages records under `/baseline/`: pages, basic forms, lists, multistep forms, table permissions, web roles and page rules. Scripts in [`examples/project/baseline/`](../examples/project/baseline/) generate and provision it.
- **A scenario matrix.** One scenario per component, variation, state and persona, generated from the fixture.
- **Paired captures.** Each scenario runs once on the live portal, through your own signed-in browser profile, and once on an isolated Mirage built from the downloaded export. Both runs record requests, responses, DOM, an element inventory, console output and a screenshot.
- **A comparison.** It lists every difference. Each difference is either explained by a reviewed allowlist entry or reported as unexplained.

The generated [Dataverse](../mirage/docs/baseline/dataverse-inventory.md) and [Power Pages](../mirage/docs/baseline/power-pages-inventory.md) inventories map the catalog to the fixture. The [reference](../mirage/docs/baseline/reference.md) records what the live portal showed for each scenario.

## What it guarantees

- **Observed, not assumed.** Every claim rests on a capture with status `captured`. A sign-in page, an HTTP 200 or a configured mapping is never counted as coverage. States the reference portal cannot show are listed with a reviewed reason ([coverage](../mirage/docs/baseline/coverage.md)).
- **Explained differences only.** A scenario passes when every remaining difference is covered by an allowlist entry. Each entry carries proof that the platform generates the value, or that it varies between two live runs. Mirage never embeds live output to close a gap ([parity](../mirage/docs/baseline/parity.md)).
- **Bounded live writes.** Live writes happen only in runs started with `--allow-writes`, and only inside the matrix's write scope: fixture pages and fixture tables. Every other write is aborted and recorded.
- **No secrets in evidence.** Tokens, cookies and query values are redacted before anything is written. Evidence stays under your project's ignored `.paqvilo/`.

It does not guarantee pixel equality, because screenshots are evidence, not compared. It does not cover pages outside the fixture, or configuration the PAC export cannot express.

## Run it against your own portal

You need an environment you are authorised to change, and a site you can upload the fixture to. The baseline writes fixture components and rows. It never changes your site's shared settings.

1. **Set up a project.** Keep it separate from the toolkit ([project extensions](project-extensions.md)). It holds:
   - your site identity file and catalogue
   - the persona and reset hooks
   - `matrix/project.json`: your origin, browser bridge, sign-in, sign-out and cache-refresh steps
   - the allowlist, the reasons file and the evidence
2. **Provision the fixture and upload the site**, then download the export. Use the scripts in `examples/project/baseline/` and your PAC profile.
3. **Generate the matrix** from the fixture manifest and your project file.
4. **Capture live, capture Mirage, then compare** with `mirage/baseline-suite.mjs`.

The [runbook](../mirage/docs/baseline/rerun.md) lists every command in order. It also covers the prerequisites (PAC, a private Dataverse connection, the signed-in browser profile and its bridge token) and the live caching behaviour to plan for. Your results stay in your project: keep the toolkit generic.
