# Baseline coverage

What the native-component baseline exercises on the reference portal, what that portal cannot show, and what is deliberately left out. Three generated documents back each claim:

- the [Dataverse inventory](dataverse-inventory.md) and the [Power Pages inventory](power-pages-inventory.md): configuration to fixture
- the scenario matrix: fixture to scenario
- the [reference](reference.md): scenario to live observation

[Parity](parity.md) covers how Mirage is measured against that observation. The [runbook](rerun.md) covers how to regenerate all of it.

## The fixture

The fixture extends the deployed demo, so the reference portal needs no second site.

- **Dataverse.** The unmanaged `PaqviloBaseline` solution (publisher prefix `pqvd`) holds three invented tables (`pqvd_baselineparent`, `pqvd_baselineitem`, `pqvd_baselinechild`). It carries:
  - columns of every kind the catalog lists, forms and views
  - business rules, plugin steps on the demo assembly, and column security
  - membership-only entries for the platform lookup views and columns its forms render
- **Power Pages.** The site records live under `/baseline/`:
  - pages, basic forms and their metadata, lists, and multistep forms with steps and step metadata
  - table permissions, including every privilege combination on a role without members
  - web roles, a page rule, site settings, and page and web templates
- **Data.** The fixture rows have stable GUIDs, and the same rows feed the live reset and the Mirage data pack.

Each inventory row cites the catalog items its configuration exercises. The citations come from each record's fields and values, so they cannot drift from the fixture. A catalog item or state that no row exercises is listed with a reason, and the inventory generator fails when a reason is missing.

## What the matrix covers

`scripts/baseline-matrix.mjs` generates one scenario per component, variation, state and persona from the fixture site manifest. The matrix has 257 scenarios over 73 component variations:

| Component | Scenarios | States |
| --- | ---: | --- |
| Basic form | 149 | `empty`, `insert`, `required-missing`, `populated`, `minimal`, `inactive-record`, `save-text`, `read-only`, validation (`regex-error`, `range-error`, `required-message`), plugin errors per message and stage, `plugin-mutation`, rule states, lookup dialog/search/select/clear/create, `note-add`, actions (delete, activate, deactivate, create-related), associate/disassociate, `permission`, `permission-denied`, `record-not-found`, `record-missing-id`, `insert-captcha` |
| List | 68 | `default`, `search`, `sort`, `paging`, `view-selector`, filters (text, dropdown, checkbox, reset), modal details/create/edit/delete, `feed` |
| Multistep form | 20 | `step1`, `step1-submit`, `step2-back`, `resume` |
| Page | 20 | `render`, page-rule `access` |

There are seven personas: `editor`, `reader`, `none`, `contact-scope`, `account-scope`, `parent-scope` and `anonymous`. On the live portal, each signed-in persona is a set of web roles applied to the single test contact. Mirage applies the same role names to its synthetic contact.

### Trimming decisions

The first full matrix repeated identical screens. The matrix was trimmed only where the live evidence showed the extra scenarios added nothing:

- **Representative pages for non-editor personas (`personaPages`).** The reader, role-less, anonymous and scope personas render the same denial panel or read-only form on every record of a kind. They run only on the pages the project lists: item create, edit and read, child create, parent edit, the item list and the modal list.
- **Canonical forms for behaviour (`behaviourPages`).** Validation, plugin, lookup and note states run on one canonical form per table. A presentation variant keeps only the states its own configuration changes:
  - edit variants keep `populated` and `save-text`
  - insert variants keep `empty` and `insert`
  - stepped forms keep `required-missing`
- **Declared configuration only.**
  - Lists filtered by state keep only their default state.
  - Filter states follow the filter types each list declares.
  - Paging runs only where the persona sees enough rows.
  - A deactivated form expects no form.
- **Growth from review.** Two review rounds added the states that were missing:
  - persona probes derived from the fixture permissions
  - validation states from the forms' metadata records
  - action dialogs, associate and disassociate
  - page render and page-rule access
  - the list OData feed
  - scope personas on the item list and item read pages

## Not observable on the reference portal

These states stay in the matrix. The reference prints each one with a reviewed reason from the project's `reasons.json`, so the gap is visible instead of silently dropped.

| State | Why it cannot be observed |
| --- | --- |
| Multistep insert step (`step1-submit`, `step2-back`, `resume`) | The step shows the reference entity's read-only form above the create form. Both forms contain the same name control, so the create form renders "An entry with the same key already exists." instead of the input. The step cannot be submitted. `step1` holds the evidence. This failure is kept as observed platform behaviour. The fixed variant (`multistep-insert-fixed`, next section) covers submit, back and resume. |
| Captcha forms and steps | Captchas are never bypassed. `insert-captcha` and the survey's `step1-submit` hold the captcha validation state. The survey's `step2-back` and `resume` have no step 2. |
| Survey step 5 subgrid | The only step subgrid with a column override sits on survey step 5. No scenario can reach that step past the captcha on step 1, so the override is configured but unobserved. |
| Auto-generated step tabs (`multistep-user/step2-back`) | The step renders its first auto-generated tab with a Next button only, with no Previous button. |
| List OData feed | Power Pages removed list OData feeds. The request and its 404 page are recorded. |

Rows that are captured but carry a note:

- **Geolocation edit form.** The fixture configures a fake Bing Maps key (list map credentials and the geolocation site settings); no real key is used. With it, the form still answers the platform's 500 error page. That page is the observed broken-key state and the reference row.
- **Map lists.** With the fake key, the map list page renders without a Bing or credentials error and with no rows in the DOM.
- **Fixed multistep insert variant (`multistep-insert-fixed`).** Its reference read-only form shows only parent columns, so no control id collides with the create form, and the step submits. `step1` and `step1-submit` are observed.
- **Stepped insert form.** The form's last tab used to host a quick view, which fails on an insert form (no record yet) with "Unable to find control with id … that is associated with the Label" and no submit button. The stepped form now uses a main form without the quick view. Its `insert` state renders with no error panel and stays on the form page.
- **Page rules for signed-in personas.** A site-wide rule that grants change to the site's administrator role overrides restrict-read, so the personas hold no administrator role. Observed per the rule configuration: the restricted page answers Access Denied (403) for the editor, whom the rule does not name, and renders for the reader, whom it names. The change-only editors page renders for both, with content-editing markup only for the editor, whose role the rule grants change.
- **Modal list and create dialogs.** The dialog form loads in a same-origin iframe, which the capture inventories (`frames.json`). This is observed for all three dialog kinds: modal details (3 frames), modal create (2) and the lookup create dialog (1). Older captures of other dialog scenarios count the host page only; the evidence-age record explains those deltas ([parity](parity.md#evidence-age-third-kind)).
- **Inline web resource.** An HTML web resource renders framed or inline. Only a non-HTML web resource on a form that renders web resources inline fails, with a platform error in its cell, while the rest of the form renders.
- **Business rules on basic forms.** These show no client effect. The show-error rule does not stop a save, and the hide rule leaves the column visible. Learn states that basic forms do not support business rules, and the live evidence agrees.
  - Caveat: the fixture provisions its rules as background workflows. The designer-made rules in the same environment are real-time. The recorded result holds for that provisioning, and the fixture keeps it so the captured save behaviour stays stable.

## Deliberately out of scope

- **Pages outside the fixture.** The matrix is generated from the fixture site manifest, so it covers `/baseline/` only. The demo's own pages and the platform's account pages (profile, registration, sign-in) are not scenarios. The sign-in page appears only as a redirect: the sign-in flow of the live side, and the effect of a restrict-read page rule.
- **Shared site settings.** The fixture never changes the shared site's global settings: date and time settings, the Bootstrap flag, default roles, and header and footer snippets. Their live values are recorded as observed values instead.
- **Configuration the PAC export cannot express.** Each of these is recorded in the inventory with its reason:
  - Power Pages column permission profiles (no file kind in the export)
  - the modern list flag
  - timeline metadata and step auto-number shapes
  - JSON-format string columns (elastic tables only)
  - rollup and calculated column definitions (maker portal only)
- **Pixels.** Screenshots are captured as evidence, but no comparison reads them.

## How coverage is proven

| Claim | Proof |
| --- | --- |
| A catalog item is configured | An inventory row names the fixture record that exercises it. Otherwise the inventory lists the item with its reason. The generator fails on any unexplained item. |
| A configured item is exercised | A matrix scenario opens the page that hosts the record and drives the state. |
| A state was observed on live | The reference row comes from a capture with status `captured`. It is judged from the element inventory's visible nodes and the DOM text, so hidden templates do not count. It quotes visible messages, open dialogs, data grids and the watched control values. |
| A state cannot be observed | The reference row says "not observed" with a reviewed reason. Rows without a capture say "no evidence". |
| Mirage matches the observation | A compare verdict of `PASS` or `ALLOWED` for that scenario ([parity](parity.md)). |

Configured coverage is not proof of rendering. A sign-in page, an HTTP 200 or an inventory mapping alone does not count as an observed state.
