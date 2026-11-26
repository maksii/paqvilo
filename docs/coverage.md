# Coverage

**Lense** previews local resources against a live Power Pages backend. **Mirage** renders exported sources with local
data and supported platform adapters. Use this matrix to choose the workflow for a change.

| Area                              | Lense                                                                                                                                 | Mirage                                                                                                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JavaScript, CSS, images and fonts | Overlay discovered browser resources; preview supported page/form/list inline fields                                                  | Serve exported assets and page/form/list inline fields locally                                                                                                                          |
| Page copy, templates and snippets | Apply unambiguous literal baseline patches; report changes requiring deployment                                                       | Render supported Liquid, includes and exported language variants                                                                                                                        |
| Source navigation                 | Inspect page dependencies and [selected owner/source evidence](lense.md#selection-evidence), with independent certainty and freshness | The same evidence summary with local runtime context                                                                                                                                    |
| Forms, lists and views            | Run online; Solution sources add FormXml, view and field links                                                                        | Build native forms, lists, lookups, subgrids, quick views and notes from exported metadata                                                                                              |
| Fields and validation             | Use the online platform's controls and rules                                                                                          | Supported typed editors and exported validation; unsupported controls retain diagnostics                                                                                                |
| PCF                               | Run online with local bundles and styles laid over; Inspect links manifests and bindings; `audit` checks every tag                    | Liquid tags, form fields, lists and subgrids with the Power Pages context, grid data and saves; React via `pcf.platformLibraries`                                                       |
| Web API and FetchXML              | Use the online backend; Inspect maps observed entity sets using Solution metadata                                                     | Supported CRUD, queries, relationships and permission checks against local tables                                                                                                       |
| Web roles and table permissions   | Inspect exported rules; live effective access remains unknown                                                                         | Evaluate configured roles and supported permission scopes for the local identity                                                                                                        |
| Server logic and cloud flows      | Execute online; server-side edits need deployment                                                                                     | Supported exported request/row-trigger flows and basic actions, JSON mocks, explicitly enabled server code and trusted project providers                                                |
| Dataverse plug-ins                | Execute online; Inspect links exported steps, types, assemblies and mapped C# sources                                                 | Supported read/write stages, mocks, trusted handlers and original CLR execution on Windows (assemblies with content, or a trusted descriptor); unsupported contracts retain diagnostics |
| Identity and data                 | Portal sign-in and live Dataverse                                                                                                     | Separate local personas, generated rows or registered project data packs                                                                                                                |
| Deployment                        | Separate PAC/site deployment process                                                                                                  | Separate PAC/site deployment process; demo includes deployable sources and archives                                                                                                     |

## What determines coverage?

A portal export identifies pages, templates, assets and access rules. Unpacked Solution sources add forms, views, fields
and component manifests. Missing managed metadata and dynamic references can leave a binding unresolved. Inspect labels
exported references and observed browser elements separately.

Mirage supports selected platform contracts, not every Power Pages feature. Code-site (`.powerpages-site`) exports are
imported, but SPA builds use their own tooling. PCF controls follow the Power Pages host: a dataset control gets rows
on a list or subgrid, while the Liquid tag binds no data set unless `pcf.liquidDatasetBinding` selects the local view
binding, and a list or subgrid outside the supported bindings falls back to the ordinary grid. React and virtual
controls need the React, ReactDOM and Fluent UI files in `pcf.platformLibraries`. External connectors, custom APIs and
unsupported flow actions need a project provider or a local mock. A successful local scenario does not establish
complete platform parity.

For details, read [forms and lists](../mirage/docs/forms-lists-parity.md), [PCF](../mirage/docs/code-components.md),
[operations](../mirage/docs/operations.md), [plug-ins](../mirage/docs/dataverse-plugins.md),
[Dataverse](../mirage/docs/dataverse-parity.md) and [parity evidence](../mirage/docs/parity-evidence.md). Add
business-specific behaviour through [project extensions](project-extensions.md).

## How to validate a change

In Lense, check the rendered page, applied resources, unmatched patches and failed requests after refresh.
`lense audit --all --strict` measures source classification; it does not prove a browser applied every change.

In Mirage, verify your persona, permission scope, saved records and operation results. Use your project's acceptance
tests for repeatable business scenarios, then validate the deployed result in an authorized live environment.
