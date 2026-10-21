# Model-driven apps in Mirage

Start Mirage as usual, then open `/main.aspx` (also linked from `/_sim/` and
Mirage's setup navigation). Power Pages Management is available by default. Its
Website, Content and Security navigation uses the selected export's data model.
The enhanced model projects `mspp_*` management tables; standard exports use
`adx_*`. Only the selected source website and locally created configuration are
present. This is not an inventory of the connected organization.

A [standalone model-driven runtime](standalone-organization.md) imports Solution apps without a portal or website. Its organization core remains available when the public HTTP API is disabled. Configure the runtime surface, default imported app and [simulation level](simulation-levels.md) in `/_setup/`; restart to apply changes.

The shell loads a compact application/navigation index and requests table metadata as needed. All imported forms and views remain available through table navigation, form switching, lookups and subgrids. Refresh and staff changes fetch current metadata and permissions. The complete catalogue endpoint remains available for existing integrations; see [loading measurements](runtime-performance.md).

App definitions from configured `solutionRoots` appear in the application picker.
The picker opens an application-card dialog with search and keyboard navigation.
Exported application names and descriptions populate its cards; switching apps
retains the unsaved-change check. View and form choices use anchored menus with
search for views, and overflowing form tabs stay available through the tab menu.
The importer reads `AppModules/**.xml`, `AppModuleSiteMaps/**.xml`, and app
components embedded in `Customizations.xml`, including solution archives. Later
selected solution layers win. Forms and saved queries come from the same metadata
pipeline as portal forms. `main.aspx?appname=<UniqueName>&pagetype=entitylist&etn=<table>`
opens a table; `pagetype=entityrecord&id=<record-id>` opens a record. Omit `id`
for a new record. `formid=<form-id>` selects an imported main form available to
the selected app. Form-picker changes update that link, and saves retain the
selected form. An unavailable form ID falls back to the app's first main form.
`appid` selects an imported app ID. Exported IDs are not inferred
from a live environment or a deployment commit. PAC exports can omit the app GUID;
those apps receive a stable local GUID derived from their unique name, reported as
`idSource: derived-local`. Use `appname` for a portable link, or the local catalogue's
GUID for `runtime.defaultApp`. A generated local GUID is not the deployed app ID.

The area selector shows the selected module's authored navigation groups. Its
selection belongs to the local browser and application; direct table/view links
activate a matching source area. Relative `main.aspx` entity-list destinations
in a sitemap retain their imported table and saved view, including the default
page's filter. Remote URLs, other page types and missing table/view metadata stay
unavailable. A known native `appid` can select another imported application;
an unknown one is unavailable when the owning app's exported native ID is known.
When that ID was omitted and the local app ID is derived, the source page retains
its owning app's local context rather than comparing unlike IDs.

## Baseline behavior

- Switch exported navigation areas and groups, switch views, search, sort, page, change/reorder
  columns, and combine filter conditions with AND. Exported FetchXML remains the
  base query, including its filters and joins. View preferences, recent items and
  pins belong to the local browser and are keyed by application/table/view.
  Filter editors use metadata-derived choices, booleans, numbers and dates.
  Contains, Does not contain, Begins with and Ends with treat text as literal
  values, including percent signs and underscores.
- Create, read, edit and delete local records. Scalar, choice, multiselect,
  boolean, date, multiline, JSON and lookup fields use a control registry.
  Choice controls expose labelled options and keyboard selection. Date-only,
  timezone-independent and user-local fields retain their distinct values.
  Date/time editors include the native half-hour time list and accept typed
  minutes. User-local editors use the browser zone unless the project supplies
  an explicit fixed `settings.timeZoneOffsetMinutes`; that offset changes the
  native editor while source PCFs retain their browser environment. Rule-based
  formatted-value profiles remain separate from this fixed editor setting.
  Lookup suggestions and Advanced lookup read local target tables, including
  exported lookup views. Advanced lookup stages a selection until Done; Cancel
  leaves the field unchanged. Record updates/deletes require a current ETag.
  A rejected stale save retains the draft. Choice, duration and lookup lists
  scroll their own options without moving the form; scrolling the form or
  resizing dismisses their obsolete popup position.
- Render exported main-form tabs, two- and three-column layouts, section columns,
  empty spacer cells, row/column spans, labels and visibility. Missing
  forms/views get explicitly labelled metadata-generated defaults. Unsupported
  controls and script/event dependencies remain visible as limitations.
- Render table subgrids whose exported target table, saved view and unique parent
  lookup or named relationship are available. Exported view-picker settings
  select the allowed views while retaining the parent filter. Related rows are
  filtered to the current record. Open a
  related record, search/sort the grid, create one with its parent prefilled, or
  select and delete local related rows. Ambiguous/missing
  relationships and unsupported many-to-many controls remain explicit placeholders.
- Edit portal customization without editing the export: sparse record overlays
  under `simulator.modelDriven.records` feed the portal projection. Mirage runs the
  regular portal compiler again, so settings, snippets, templates, page hierarchy,
  forms and permissions use the updated local records. A source reload reapplies
  these sparse overlays, preserving later source edits to untouched fields;
  persistence/restart behavior follows the selected simulation level. Legacy
  local-state retains overlays across restart; dry run keeps edits in memory.
  Explicit file-backed modes require declared pack DATA ownership. Resetting runtime
  state restores its configured inputs.
- New website records are local configuration records. They do not provision a
  hosted site, attach a new source checkout, or switch the runtime's source
  website. Deleting the source website from its own running instance is disabled.

Power BI visualization, charts, reports, flows, sharing, email links, global
search, quick create, Advanced Find and classic advanced settings are disabled.
Solution JavaScript/events, supported JavaScript command actions and standard
field PCF controls can run through an explicitly enabled
[trusted extension host](model-driven-customizations.md). Trust is off by default.
Business process flows, dashboards and unsupported subgrids remain unavailable.
This baseline does not claim full model-driven or Dynamics client parity.

For exported two-state tables with states 0/1, an inactive loaded row uses disabled
form type 4, a status strip and initially disabled fields. Save and Save & Close
are hidden. Explicit client scripts can unlock controls, set attribute values and
save the inactive record through the supported SDK, subject to source and staff
write permissions. Editing an active draft's state does not disable it before
saving; loading the saved row applies its new state. Activation commands remain
explicitly unavailable locally.

The top-right profile avatar opens **Staff profile**. Select an eligible interactive organization user to apply canonical staff roles, row access and field security to grids, lookup candidates, forms and mutations. **Local administrator** is an explicit development bypass, selected only when no staff cookie exists or you explicitly choose it. Invalid, disabled, deleted or expired staff selections fail instead of escalating. Manage users, roles and application credentials under `/_sim/#dataverse`. Portal visitor identity/table permissions and token-authenticated application identities remain separate.

Create, update and delete commands follow the backend's table/row/field capabilities and DATA ownership. Unsupported operations and read-only fields are disabled with the reported reason. The backend enforces the same checks. File-backed simulation/deep modes require a declared pack DATA owner; dry run permits record edits in memory. Persistence level and exact target files are shown in Administration, with configuration changes applied only after restart.

The shell displays progress while loading apps, records, lookups and related grids. Loading content stays unavailable for editing until it is current; failed reads offer a retry. Save commands show pending feedback and lock the form through event handlers and persistence, preventing duplicate saves. Failed saves retain the draft and explain the error. Loading animations respect reduced-motion preferences.

## Architecture and extension boundaries

`lib/model-driven/solution.mjs` normalizes solution AppModule, sitemap and form
facts. `catalogue.mjs` builds the versioned data-only app/table/form/view contract.
`power-pages.mjs` owns documented Power Pages schema and the portal-record adapter;
organization names, URLs and captured metadata must stay in the owning project.
Exported metadata takes precedence over generated field descriptions.

`data.mjs` is the shell's data interface (`list`, `get`, `write`). Ordinary and Power Pages management tables use the shared organization core's canonical `DataStore` and record pipeline, including staff authorization, field security, rules, plugins, audit values and optimistic concurrency. The core remains active when the public HTTP listener is off. Management writes update sparse source overlays; Mirage recompiles the portal after committed records. API writes become visible in the shell and portal, and shell writes are visible through the enabled API. Queries use the existing FetchXML engine; catalogue and record reads wait for pending writes.
The model-driven UI has no live-bridge path. Keep future organization-service
adapters behind this interface.

Source app modules, sitemaps, forms, views and supported app membership references
also materialize as local Dataverse records. Local API edits overlay source
metadata without changing the exported files. Solution ZIP imports contribute
the same metadata and preserve inert component assets for export. Scripts and
custom controls remain inert unless the project explicitly trusts the supported
extension host. Unsupported components retain their source provenance and reason.

`http.mjs` confines app routes and assets to Mirage, validates methods and the
existing simulator CSRF token, and returns metadata separately from record data.
The host retains its Host/Origin/cross-site checks. The shell uses same-origin
assets and a restrictive CSP. No solution URL, script, web resource, or external
navigation is executed as part of importing an app. Explicitly trusted supported
scripts and PCF resources load only through the local app resource allowlist.

`control-descriptors.mjs` defines shared data-only control capabilities consumed by the catalogue, HTTP validation and browser registry. `controls.mjs` renders those types; unknown types remain explicit placeholders. Polymorphic lookups preserve the selected table alongside the ID and canonical logical-name annotation. A manually entered ID with multiple targets requires an explicit lookup selection. Existing-record PATCH requests contain only fields touched by actual control events, preserving untouched relationships and hidden values across tab changes. Create requests include editable rendered values.

Add richer controls, command eligibility, related grids, client API/event execution and business process flows as separate
capabilities. Extend the bounded related-grid adapter for richer relationships.
Do not enable a command until its implementation and regression
coverage exist. Preserve source provenance and report unsupported components.

The shell uses local vector icons and Segoe UI, with separate grid, command,
record-summary, section-card and typed-control layouts. Form XML retains tab
column widths, section columns, row positions, spans and visibility. Overflowing
tabs stay available through the tab menu. Responsive rules preserve local
administration on smaller screens. The local-environment notice and disabled
unsupported commands remain explicit.

The app chooser uses a searchable card modal; view, form, tab and column choices
use anchored menus. Grid columns and filters have separate drawers. Source-typed
fields include searchable choices, checkbox multiselects, inline and advanced
lookups, a two-pane date calendar and duration choices with editable units. Date
and time values retain their source behavior; the time list exposes 48 half-hour
choices while retaining arbitrary typed minutes. Unsupported file, image and dataset controls
retain visible reasons instead of accepting edits.

Trusted scalar PCF controls receive the selected local staff identity and use the
same bounded record adapters as form scripts. Record queries share the local
organization query engine, including supported expansion, FetchXML and paging;
lookup bindings resolve imported navigation properties and entity-set names.
These adapters preserve local permissions, CSRF checks and concurrency tokens.

## Validation

Toolkit regressions use invented tables and loopback fixtures:

```sh
node --test mirage/test/model-driven.test.mjs
node --test mirage/test/model-driven-dataverse.test.mjs
node --test mirage/test-browser/model-driven.test.mjs
npm run validate
```

Keep actual Power Pages app exports, browser observations, screenshots and
site acceptance tests in a separate project. Read-only reference inspection does
not authorize creating records, changing solutions, exporting through a new
unmanaged solution, publishing, or deploying to the organization.

The table's exported desktop `Microsoft.PowerApps.PowerAppsOneGrid` default configuration selects grid paging. `EnablePagination=yes` uses server pages with the native row range and first/previous/next controls; `no` (or the built-in control's omitted default) loads further server chunks on scroll. A table without an exported recognized grid configuration retains Mirage's paged fallback. These facts come from the table default configuration; form and subgrid PCFs do not override the main grid. Returning from a record preserves the originating imported table, source view, keyword, filters, page and area in the local browser history.
