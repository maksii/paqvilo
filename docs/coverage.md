# Coverage

Paqvilo supports two local-first, pro-code workflows. **Lense** previews local resources against a live Power Pages backend. **Mirage** renders exported sources with local data and supported platform adapters. Use this matrix to choose the right workflow for a change.

| Area | Lense | Mirage |
| --- | --- | --- |
| JavaScript, CSS, images and fonts | Overlay discovered browser resources; preview supported page/form/list inline fields | Serve exported assets and page/form/list inline fields locally |
| Page copy, templates and snippets | Apply unambiguous literal baseline patches; report changes requiring deployment | Render supported Liquid, includes and exported language variants |
| Source navigation | Inspect page/template/snippet/asset chains and rendered controls | The same Inspect tools with local runtime context |
| Forms, lists and views | Run online; Solution sources add FormXml, view and field links | Build native forms, lists, lookups, subgrids, quick views and notes from exported metadata |
| Fields and validation | Use the online platform's controls and rules | Supported typed editors and exported validation; unsupported controls retain diagnostics |
| PCF | Run online components; Inspect links manifests, resources, native FormXml and literal dataset bindings | Standard page controls, enabled native single-field bindings and explicit Liquid view/table dataset bindings |
| Web API and FetchXML | Use the online backend; Inspect maps observed entity sets using Solution metadata | Supported CRUD, queries, relationships and permission checks against local tables |
| Web roles and table permissions | Inspect exported rules; live effective access remains unknown | Evaluate configured roles and supported permission scopes for the local identity |
| Server logic and cloud flows | Execute online; server-side edits need deployment | Inventory exported operations; supported Request/Response flows, JSON mocks, explicitly enabled local server code and trusted project providers |
| Dataverse plugins | Execute online; Inspect links exported steps, types, assemblies and mapped C# sources | Import registrations; simulate supported write stages with mocks or trusted handlers; placeholders report skipped logic |
| Identity and data | Portal sign-in and live Dataverse | Separate local personas, generated rows or registered project data packs |
| Deployment | Separate PAC/site deployment process | Separate PAC/site deployment process; demo includes deployable sources and archives |

## What determines coverage?

A portal export identifies pages, templates, assets and access rules. Unpacked Solution sources add forms, views, fields and component manifests. Missing managed metadata and dynamic references can leave a binding unresolved. Inspect labels exported references and observed browser elements separately.

Mirage supports selected platform contracts, not every Power Pages feature. PCF dataset hosting requires an explicit Liquid table/view binding. Native list/subgrid PCF hosting is diagnosed and falls back to the native grid. React/virtual controls, platform libraries, advanced dataset operators and record navigation remain unsupported. External connectors, custom APIs and unsupported flow actions need a project provider or a local mock. A successful local scenario does not establish complete platform parity.

For details, read [forms and lists](../mirage/docs/forms-lists-parity.md), [PCF](../mirage/docs/code-components.md), [operations](../mirage/docs/operations.md), [plugins](../mirage/docs/dataverse-plugins.md), [Dataverse](../mirage/docs/dataverse-parity.md) and [parity evidence](../mirage/docs/parity-evidence.md). Add business-specific behavior through [project extensions](project-extensions.md).

## How to validate a change

In Lense, check the rendered page, applied resources, unmatched patches and failed requests after refresh. `lense audit --all --strict` measures source classification; it does not prove a browser applied every change.

In Mirage, verify your persona, permission scope, saved records and operation results. Use your project's acceptance tests for repeatable business scenarios, then validate the deployed result in an authorized live environment.
