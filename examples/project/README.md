# Paqvilo demo project

One account workflow in three Power Pages approaches: native lists and forms, custom Web API, and PCF field editors. Includes 12 invented accounts, 24 contacts, notes, an attachment, access roles and deployable sources.

From an empty working folder, run:

```sh
npx paqvilo mirage demo
```

npx downloads and runs the published toolkit. The command creates `paqvilo-example/`, loads the sample data and opens a dedicated browser. Keep the terminal running. Choose **Sign in**, select **Alex Example 01**, then open **Approach > Web API > Arcwell Services**.

For VS Code, add `--scaffold` and open `paqvilo-example/paqvilo-demo.code-workspace`. Select **Demo: Mirage and browser debugger** in **Run and Debug**, then press **F5**. Prepared tasks install dependencies, start the browser and run acceptance tests. Inspect opens the related sources in your editor. See the [VS Code walkthrough](https://github.com/maksii/paqvilo/blob/main/docs/demo.md#prefer-vs-code-tasks).

## Explore the workflow

Search and page through accounts, compare Active/All/Inactive views, and save a typed account field. Select contacts or parent accounts through searchable, paged lookups. Their dialogs support Tab, Enter and Escape. Search related contacts and test create, read, edit and delete. Add more than eight contacts to check contact paging.

Download the service brief, edit its note and confirm the attachment is preserved. Add another note with a small attachment. Compare the same records through **Out of the box** and **PCF**, then open **Extended** for server logic and a location request/response simulation.

Open **Liquid** for parameterized partials, a manifest-backed component, custom views and filtered FetchXML. On **Web API**, try a short account name or contact last name to check plugin validation; save a valid name and email with surrounding spaces to inspect normalization. Eight exported plugin steps have matching local models and editable C# sources.

Press **Alt+Shift+P** for **Inspect** source links and **Tweaks** persona controls. Open **Manage data and personas** for records, presets and **Operations**. Follow the complete [demo walkthrough](https://github.com/maksii/paqvilo/blob/main/docs/demo.md).

Use **Alex Example 01** for editor access and **Blair Demo 01** for reader access. Readers can view accounts, related contacts and notes; their write requests are denied. Exported web roles and table permissions provide global account access and contact access scoped through parent accounts.

## Compare the source patterns

| Approach | Implementation |
| --- | --- |
| Out of the box | Native lists/forms with HTML, CSS and JavaScript in pages, templates and forms; contact modal CRUD and notes |
| Web API | Liquid presentation template, `demo-workspace.js` and `demo.css` web files; account/contact CRUD, paging, search, lookups and notes |
| PCF | The Web API workspace with an imported standard-control bundle containing 14 typed editors |
| Extended | Exported server logic and a supported local location request/response flow |
| Liquid | Include parameters, component manifest, custom entity lists/views, variables, loops and queries |
| Plugins | Account/contact PreValidation and PreOperation on Create and Update; explicit local models |

Content snippets supply shared home, access and native-workflow copy. Inspect connects those references, assets and controls to their source files.

The sample demonstrates selected scenarios. It does not include every platform control or a PCF dataset host. The generic runtime supports explicitly bound standard dataset controls; native list/subgrid PCF hosting, React controls and external flow connectors have separate limits. See [coverage](https://github.com/maksii/paqvilo/blob/main/docs/coverage.md), [PCF hosting](https://github.com/maksii/paqvilo/blob/main/mirage/docs/code-components.md) and [operations](https://github.com/maksii/paqvilo/blob/main/mirage/docs/operations.md).

## Edit or deploy

Change `paqvilo-example/portal/web-files/demo.css` and save to check a local style edit. Running the demo command again preserves source edits and restores sample data. Close its browser or press **Ctrl+C** to stop.

| Source | Purpose |
| --- | --- |
| `portal/` | PAC portal export: pages, templates, web files, snippets, forms, lists and permissions |
| `solution/` | Unpacked Solution sources for forms, views, fields, flow, plugin assembly/steps and site components |
| `code-solution/` | Separate exported PCF manifests and resources |
| `components/` | Editable TypeScript PCF and C# Dataverse plugin projects |
| `deployment/` | PAC-built importable Solutions, cloned solution project, sample data and setup helper |
| `metadata/` | Standard metadata absent from the sample's Solution export |
| `pack/` | Invented data, personas, plugin models and populated/empty presets |

Follow [deployment instructions](deployment/README.md) to import the portal, components and data into your own environment. Local personas are not online credentials. Add your portal address to the catalogue before using Lense; its form submissions use live data.

Inside the installed demo folder, install dependencies and run its local acceptance tests:

```sh
npm install
npm test
```

Keep business data, observations and project tests in your own project. See [project extensions](https://github.com/maksii/paqvilo/blob/main/docs/project-extensions.md).
