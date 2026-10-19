# Model-driven apps in Mirage

Start Mirage as usual, then open `/main.aspx` (also linked from `/_sim/` and
Mirage's setup navigation). Power Pages Management is available by default. Its
Website, Content and Security navigation uses the selected export's data model.
The enhanced model projects `mspp_*` management tables; standard exports use
`adx_*`. Only the selected source website and locally created configuration are
present. This is not an inventory of the connected organization.

App definitions from configured `solutionRoots` appear in the application picker.
The importer reads `AppModules/**.xml`, `AppModuleSiteMaps/**.xml`, and app
components embedded in `Customizations.xml`, including solution archives. Later
selected solution layers win. Forms and saved queries come from the same metadata
pipeline as portal forms. `main.aspx?appname=<UniqueName>&pagetype=entitylist&etn=<table>`
opens a table; `pagetype=entityrecord&id=<record-id>` opens a record. Omit `id`
for a new record. `appid` selects an imported app ID. Exported IDs are not inferred
from a live environment or a deployment commit.

## Baseline behavior

- Navigate application groups, switch views, search, sort, page, change/reorder
  columns, and combine filter conditions with AND. Exported FetchXML remains the
  base query, including its filters and joins. View preferences, recent items and
  pins belong to the local browser and are keyed by application/table/view.
- Create, read, edit and delete local records. Scalar, choice, boolean, date,
  multiline, JSON and lookup fields use a control registry. Lookup selection
  reads local target tables. Record updates/deletes require a current ETag.
- Render exported main-form tabs, sections, labels and field layouts. Missing
  forms/views get explicitly labelled metadata-generated defaults. Unsupported
  controls and script/event dependencies remain visible as limitations.
- Render table subgrids whose exported target table, saved view and unique parent
  lookup are available. Related rows are filtered to the current record. Open a
  related record, search/sort the grid, create one with its parent prefilled, or
  select and delete local related rows. Ambiguous/missing
  relationships and unsupported many-to-many controls remain explicit placeholders.
- Edit portal customization without editing the export: record overlays persist
  in the runtime state under `simulator.modelDriven.records`. Mirage runs the
  regular portal compiler again, so settings, snippets, templates, page hierarchy,
  forms and permissions use the updated local records. A source reload reapplies
  these sparse overlays, preserving later source edits to untouched fields;
  restarting with the same state retains them. Resetting runtime
  state also resets these changes.
- New website records are local configuration records. They do not provision a
  hosted site, attach a new source checkout, or switch the runtime's source
  website. Deleting the source website from its own running instance is disabled.

Power BI visualization, charts, reports, flows, sharing, email links, global
search, quick create, Advanced Find and classic advanced settings are disabled.
Solution JavaScript/events, business process flows, custom controls, dashboards,
and unsupported subgrids are not executed. This baseline does not claim full
model-driven or Dynamics client parity. It does not emulate Dataverse security
roles for staff users: this is a local administration surface like `/_sim/`.
Portal visitor identity and table permissions remain separate.

## Architecture and extension boundaries

`lib/model-driven/solution.mjs` normalizes solution AppModule, sitemap and form
facts. `catalogue.mjs` builds the versioned data-only app/table/form/view contract.
`power-pages.mjs` owns documented Power Pages schema and the portal-record adapter;
organization names, URLs and captured metadata must stay in the owning project.
Exported metadata takes precedence over generated field descriptions.

`data.mjs` is the shell's local data interface (`list`, `get`, `write`). Ordinary
tables use the existing transactional `DataStore` and its plugin/rule pipeline.
Power Pages virtual management tables validate a projected local store, then save
record overlays through Mirage's state replacement/recompile boundary. Queries
use the existing FetchXML engine. The model-driven UI has no live-bridge path.
This makes the shell independent of the organization Web API HTTP host: the
Dataverse API and this adapter can share `DataStore` without either becoming a
second database. Keep future organization-service adapters behind this interface.

`http.mjs` confines app routes and assets to Mirage, validates methods and the
existing simulator CSRF token, and returns metadata separately from record data.
The host retains its Host/Origin/cross-site checks. The shell uses same-origin
assets and a restrictive CSP. No solution URL, script, web resource, or external
navigation is executed as part of importing an app.

`controls.mjs` registers controls by metadata type; unknown types remain explicit
placeholders. Add richer controls, command eligibility, related grids, staff
authorization, client API/event execution and business process flows as separate
capabilities. Extend the bounded related-grid adapter for richer relationships.
Do not enable a command until its implementation and regression
coverage exist. Preserve source provenance and report unsupported components.

The shell uses local vector icons and Segoe UI, with separate grid, command,
record-summary, section-card and typed-control layouts. Form XML retains tab
column widths, section columns, row positions, spans and visibility. Overflowing
tabs stay available through the tab menu. Responsive rules preserve local
administration on smaller screens. The local-environment notice and disabled
unsupported commands remain explicit.

## Validation

Toolkit regressions use invented tables and loopback fixtures:

```sh
node --test mirage/test/model-driven.test.mjs
node --test mirage/test-browser/model-driven.test.mjs
npm run validate
```

Keep actual Power Pages app exports, browser observations, screenshots and
site acceptance tests in a separate project. Read-only reference inspection does
not authorize creating records, changing solutions, exporting through a new
unmanaged solution, publishing, or deploying to the organization.
