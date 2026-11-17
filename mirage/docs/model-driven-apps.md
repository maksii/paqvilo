# Model-driven apps in Mirage

Mirage serves a local model-driven shell at `/main.aspx` on the apps address (`appsUrl`), linked from `/_sim/` and the
setup navigation. It renders the apps, sitemaps, forms and views of the selected Solution sources over the local
organization. It is a development host, not the licensed Unified Interface client: anything not listed here is
unavailable, and unavailable features say so instead of pretending to succeed.

- On the Power Pages host, **Mirage Site Manager** is always present. Its Website, Content and Security navigation
  follows the export's data model (`mspp_*` tables for the enhanced model, `adx_*` for standard exports) and shows only
  the selected website and locally created configuration, not the connected organization.
- The [standalone model-driven runtime](standalone-organization.md) imports Solution apps without a portal. Configure
  its surface, default app (`runtime.defaultApp`) and [simulation level](simulation-levels.md) in `/_setup/`; restart
  to apply.
- Solution JavaScript, command actions and PCF controls run only when the project trusts them; see
  [Solution customizations](model-driven-customizations.md) and the [client API](model-driven-client-api.md).

## Apps, links and navigation

The importer reads `AppModules/**.xml`, `AppModuleSiteMaps/**.xml` and app components in `Customizations.xml`,
including Solution archives. Later selected Solution layers win. Forms and saved queries come from the same metadata
pipeline as portal forms; exported metadata takes precedence over generated field descriptions. Every app from the
configured `solutionRoots` appears in the app picker.

| Link                                                             | Opens                                                                                    |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `main.aspx?appname=<UniqueName>&pagetype=entitylist&etn=<table>` | A table list. `appname` is the portable app selector.                                    |
| `…&pagetype=entityrecord&etn=<table>&id=<record-id>`             | A record; omit `id` for a new record.                                                    |
| `…&formid=<form-id>`                                             | That imported main form of the app.                                                      |
| `…&appid=<guid>`                                                 | An imported app by ID.                                                                   |
| `…&pagetype=webresource&webresourceName=<name>[&data=…]`         | A trusted, imported HTML web resource as a page.                                         |
| `…&pagetype=dashboard&id=<id>`                                   | A Solution dashboard; see [SiteMap pages and dashboards](#sitemap-pages-and-dashboards). |

- A `formid` missing from the imported main forms is refused with `FormUnavailable`; a form excluded from the
  selected app falls back to the app's first eligible main form. Form-picker changes update the link, and saves keep
  the selected form.
- PAC exports can omit an app GUID. Such an app gets a stable local GUID derived from its unique name, reported as
  `idSource: derived-local`. It is not the deployed app ID: use `appname` for portable links. App IDs are never
  inferred from a live environment or a deployment commit.
- An unknown `appid` is unavailable when the owning app's exported ID is known; when that ID was derived locally, the
  page keeps its owning app's context.
- The area selector shows the app's authored sitemap groups. Relative `main.aspx` entity-list entries keep their table
  and saved view, including the view's filter. Area selection, view preferences, recent items and pins are stored in
  the local browser, keyed by app, table and view. Returning from a record restores the table, view, keyword, filters,
  page and area.

The shell first loads a compact app and navigation index and fetches table metadata on demand; refresh and staff
changes refetch metadata and permissions. The complete catalogue endpoint remains for existing integrations; see
[runtime performance](runtime-performance.md).

## Grids, forms and records

- **Grids.** Switch areas, views, search, sort, page, change and reorder columns, and add AND-combined filter
  conditions. The exported FetchXML, with its filters and joins, stays the base query. Text operators (Contains, Does
  not contain, Begins with, Ends with) treat `%` and `_` literally. A table's exported
  `Microsoft.PowerApps.PowerAppsOneGrid` default configuration selects paging: `EnablePagination=yes` gives server
  pages with first/previous/next controls; `no`, or the built-in default, loads further pages on scroll. Without that
  configuration Mirage pages the grid. Form and subgrid PCFs do not change the main grid.
- **Forms.** Exported main-form tabs, two- and three-column layouts, section columns, spacer cells, row and column
  spans, labels and visibility render as authored. Missing forms or views get labelled metadata-generated defaults.
  Unsupported controls and script dependencies stay visible as limitations.
- **Fields.** A control registry renders scalar, choice, multiselect, Boolean, date, multiline, JSON, duration and
  lookup fields. Date-only, time-zone-independent and user-local values stay distinct. The date/time editor offers
  48 half-hour choices and accepts typed minutes; user-local editors use the browser time zone unless the project sets
  `settings.timeZoneOffsetMinutes` (source PCFs keep the browser environment). Lookup suggestions and Advanced lookup
  read local target tables and exported lookup views; Advanced lookup stages a selection until Done. A polymorphic
  lookup keeps the selected table; a typed ID with several possible targets needs an explicit selection. File and image
  controls are read-only with a visible reason.
- **Saves.** Updates and deletes need the current ETag; a rejected stale save keeps the draft. An update sends only
  fields touched by control events, so untouched relationships and hidden values survive tab changes; a create sends
  the editable rendered values. Save commands lock the form until handlers and persistence finish.
- **Subgrids.** A table subgrid renders when its target table, saved view and a unique parent lookup or named
  relationship are imported. Exported view-picker settings choose the allowed views. Rows are filtered to the current
  record; you can open, search, sort, create (parent prefilled) and delete related rows. Ambiguous or missing
  relationships and many-to-many controls stay placeholders. Trusted dataset PCFs on subgrids render through the
  dataset host ([PCF inputs and limits](model-driven-customizations.md#pcf-inputs-and-limits)).
- **Inactive rows.** For exported two-state tables (states 0/1), a loaded inactive row opens as disabled form type 4
  with a status strip; Save and Save & Close are hidden. Client scripts can unlock controls, set values and save
  through the SDK, subject to source and staff write permissions. Changing an active draft's state takes effect when the
  saved row loads. Activation commands are unavailable.

### Portal configuration records

Site Manager edits do not change the export. They are sparse record overlays under `simulator.modelDriven.records`;
Mirage recompiles the portal from them, so settings, snippets, templates, page hierarchy, forms and permissions use
the edited records. A source reload reapplies the overlays and keeps later source edits to untouched fields.
Persistence follows the [simulation level](simulation-levels.md): legacy local state keeps overlays across restart,
dry run keeps them in memory, and file-backed modes need a declared pack DATA owner. New website records are local
configuration only: they do not provision a site or switch the runtime's source website. Deleting the running
website is disabled.

## Staff identity and permissions

The profile avatar opens **Staff profile**. Selecting an interactive organization user applies its roles, row access
and field security to grids, lookups, forms and writes. **Local administrator** is a development bypass, used only when
no staff cookie exists or when you choose it. Invalid, disabled, deleted or expired selections fail rather than
escalate. The staff cookie is signed by one runtime process and is not kept in the dev browser's session file, so after
a runtime restart choose a staff user again in `/_sim/`. Manage users, roles and application credentials under
`/_sim/#dataverse`. Portal visitors and token-authenticated application users are separate identities.

Create, update and delete commands follow the backend's table, row and field capabilities and DATA ownership; disabled
commands and read-only fields show the reason, and the backend enforces the same checks. Administration shows the
persistence level and target files.

## SiteMap pages and dashboards

SiteMap entries that are not tables carry a code: `MD_NAV_WEBRESOURCE` (`$webresource:` URLs), `MD_NAV_CUSTOM_PAGE`,
`MD_NAV_DASHBOARD` and `MD_NAV_URL`.

- **HTML web resources** (type 1) are imported and served only to trusted projects, as a page in the app, with a CSP
  that allows their inline scripts and same-origin framing. Relative links to sibling web resources do not resolve.
- **Dashboards.** Mirage reads organization-owned dashboards (systemform type 0) from `<Dashboards>` in
  `Customizations.xml` and from `Dashboards/` component files. A sitemap `DefaultDashboard` or
  `pagetype=dashboard&id=<id>` opens it in the app. Each list (a sub-grid control with `TargetEntityType` and `ViewId`)
  renders over the view query as the selected staff user, with the view's columns, sorting, paging, quick find and
  view-picker settings. Charts (`VisualizationId`), web resources, IFRAMEs, other controls and lists whose table or
  view is not imported appear under "Not rendered locally" with their reason. An app's dashboards are those its sitemap
  opens plus its SystemForm components; an app that names none gets all of them.
- **Custom pages.** A custom page that resolves to one of the app's own canvas app components runs that canvas app
  headless ([canvas apps](canvas-apps.md)); `navigateTo` to any other page name rejects with `CustomPageNotFound`.
- External URLs, custom pages that do not resolve and dashboards without a definition in the sources stay listed and
  disabled with their code.

Each sitemap dashboard is a preflight row `model-driven:dashboard/<app>/<subarea>`: `satisfied` when every component
renders, otherwise `unsupported` with `MD_DASHBOARD_COMPONENT_UNSUPPORTED` (naming the components) or `MD_NAV_DASHBOARD`
(no definition). A dashboard an app hosts never reports `DASHBOARD_NOT_RENDERED`. The capability record
`model-driven:dashboard` describes the host.

## Routes

`modelDriven.enabled: false` (catalogue `mirage.modelDriven`, or the project key) turns the model-driven surface off
on both hosts: its routes are not served, status `links.modelDriven` is `null` and the dashboard node
`host:model-driven` is `disabled`. The organization and its Web API are unaffected.

The `/_apps/` prefix is reserved. Both hosts mount the canvas (`/_apps/canvas/`) and code app (`/_apps/code/<name>/`)
surfaces before the model-driven handler, which answers 404 for any other unknown `/_apps/*` path. Solution scripts,
styles and PCF bundles are served from `/_apps/resources/` and `/_apps/controls/`, only from the app's allowlist.

`POST /_apps/api/webapi` serves [`Xrm.WebApi.execute`](model-driven-client-api.md#xrmwebapiexecute) wherever the
model-driven surface runs: the Power Pages host and the standalone `model-driven` runtime. A standalone
`dataverse-api` runtime answers 404. On the Power Pages host the route is on the apps address; a browser request on the
portal address is redirected (navigation) or refused with `AppsOriginRequired`. The route is admin-adjacent: it runs
any Web API request (CSRF-checked with the apps token) as the selected staff user, or as the local administrator when
no staff cookie is set; any other principal gets 401 `StaffPrincipalUnavailable`. Both hosts list it in status
`adminAdjacentRoutes`.

On the apps address, pages of the app (same-origin referrer `/main.aspx` or `/_apps/`) may `GET` and `HEAD`
`/api/data/v9.x/`; see [the Web API on the app address](model-driven-client-api.md#page-markers-and-the-web-api-on-the-app-address).

## Architecture

| Module (`mirage/lib/model-driven/`) | Role                                                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `solution.mjs`                      | Normalizes Solution AppModule, sitemap and form facts.                                                   |
| `catalogue.mjs`                     | Builds the versioned, data-only app/table/form/view contract.                                            |
| `power-pages.mjs`                   | Documented Power Pages schema and the portal-record adapter.                                             |
| `data.mjs`                          | The shell's data interface (`list`, `get`, `write`) over the shared organization core.                   |
| `http.mjs`                          | Confines routes and assets, validates methods and the simulator CSRF token, separates metadata and data. |
| `control-descriptors.mjs`           | Data-only control capabilities shared by catalogue, HTTP validation and the browser registry.            |
| `controls.mjs`                      | Renders those control types; unknown types stay placeholders.                                            |

- Ordinary and Power Pages management tables use the organization core's `DataStore` and record pipeline: staff
  authorization, field security, rules, plug-ins, audit and optimistic concurrency. The core stays active when the
  public HTTP API is off. Shell writes are visible through the Web API and the portal, and the reverse; catalogue and
  record reads wait for pending writes. The shell has no live-bridge path: keep any organization-service adapter behind
  `data.mjs`.
- Source app modules, sitemaps, forms, views and app membership also materialize as local Dataverse records. API edits
  overlay that metadata without changing the exported files. Solution ZIP imports keep inert component assets for
  export; unsupported components keep their provenance and reason.
- Importing an app executes nothing: no Solution URL, script, web resource or external navigation. The shell uses
  same-origin assets and a restrictive CSP; the host keeps its Host, Origin and cross-site checks. Resource
  `source`/`sourceFile` paths are relative to the project root when the host knows it, and import diagnostics reach the
  runtime diagnostics.
- Add a command only with its implementation and regression tests. Keep organization names, URLs and captured
  metadata in the owning project.

## Not available

Power BI, charts, reports, flows, sharing, email links, global search, quick create, Advanced Find, classic advanced
settings, business process flows and unsupported subgrids. The shell does not claim full model-driven or Dynamics
client parity.

## Validation

Toolkit tests use invented tables and loopback fixtures:

```sh
node --test mirage/test/model-driven.test.mjs mirage/test/model-driven-dataverse.test.mjs
node --test --import=./test/browser-bootstrap.mjs mirage/test-browser/model-driven.test.mjs
npm run validate
```

Keep app exports, browser observations, screenshots and acceptance tests in a separate project. Read-only reference
inspection does not authorize creating records, changing Solutions, exporting through a new unmanaged Solution,
publishing or deploying.
