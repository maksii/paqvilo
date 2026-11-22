# Explore the demo

The demo is a populated Power Pages workspace that implements one account workflow in several ways (native, Web API,
PCF, server logic, Liquid, plug-ins) with editable sources and deployment archives. It runs locally without a Power
Pages account. After [installing Paqvilo](getting-started.md#1-install):

```sh
npx --no-install paqvilo mirage demo
```

The command creates `paqvilo-example/`, selects a free port and opens the browser. Keep the terminal running; close the
browser or press **Ctrl+C** to stop. Rerunning preserves source edits and restores the sample dataset. The
[demo project README](../examples/project/README.md) describes its files and the simulated Microsoft Entra sign-in.

## Prefer VS Code tasks

In an empty folder opened in VS Code (**File > Open Folder**), run once in **Terminal > New Terminal**:

```sh
npm init -y
npm install --save-dev paqvilo
npx --no-install paqvilo mirage demo --scaffold
```

`--scaffold` prepares the project and workspace without starting a runtime. Open
`paqvilo-example/paqvilo-demo.code-workspace` (**File > Open Workspace from File**), select **Demo: Mirage and browser
debugger** in **Run and Debug** and press **F5**: its task installs the demo's dependencies, starts Mirage and attaches
the debugger to the dedicated Edge browser. Set breakpoints in `portal/web-files/demo-workspace.js`. **Terminal > Run
Task** also offers **demo: Start Mirage**, **demo: Run acceptance tests** and **demo: Build Dataverse plugins**.

- The generated `AGENTS.md` gives coding agents the demo's commands, folders and local/live boundaries. Rerunning the
  scaffold command keeps your edits to it and restores it if missing.
- Close the development browser before starting another session; disconnecting the debugger alone leaves it running.
- Debug configurations use port `9222`; if it is taken, change it in both the task and the launch configuration.
- **Demo: Lense and browser debugger** needs your deployed portal as an environment in `paqvilo.config.yml`; it prompts
  for the environment name. Its form submissions use live data.

## Try a complete account scenario

1. Choose **Sign in to try CRUD**, then **Alex Example 01** (editor).
2. Open **Approach > Web API**. Choose **Active accounts**, **All accounts** or **Inactive accounts** in **View**, or
   type part of a name, and press **Search**; page with **Next** and **Previous**. Open **Arcwell Services**, choose
   **Edit account**, change a typed field, choose **Save account** and reopen it. The selected view and search are kept
   in the URL, so a reload after a source edit restores them.
3. Pick a primary contact or parent account in its lookup dialog: search, page and choose a row (**Tab**, **Enter** and
   **Escape** work).
4. Search the related contacts; add, edit and delete one. Contacts page after eight rows.
5. Download the service brief, edit its note and check the attachment remains. Add a note with a file under 1 MB.
6. Open **Out of the box**: choose **New contact** in the subgrid, check the prefilled account, save, then view, edit
   and delete it from the row menu. Open **PCF** to edit the account through 14 typed code-component editors (no page
   hosts a PCF dataset control).
7. Open **Extended** to calculate an estimate, read an account overview and run the location request/response flow.
8. Open **Liquid > Partials and parameters**, **Lists and views** and **Data and conditions**. Compare the two- and
   four-row previews, use **Apply view** and **Apply filter**, and inspect the includes, component manifest, view cells
   and FetchXML results.
9. In **Web API**, save an account name shorter than three characters or a contact last name shorter than two to see the
   plug-in validation message; save a name and email with surrounding spaces to see normalization.
10. Open an account in **Out of the box**, press **Alt+Shift+P**, open **Inspect** and follow the page, template, form,
    view, field, plug-in and permission links into their sources. The **Web API** pages have no basic forms, so their
    inspection lists the page, templates, snippets and rendered controls.

| Approach       | Source pattern                                                                     | What to inspect                                                       |
| -------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Out of the box | Native lists/forms, page/template markup and form scripts/styles                   | Exported views, FormXml, contact modal actions and notes              |
| Web API        | Liquid template with JavaScript and CSS web files                                  | `/_api` entity sets, assets, custom dialogs and save results          |
| PCF            | Web API workspace with exported typed code components                              | Component manifests, resources and editor outputs                     |
| Extended       | Server logic and a local flow simulation                                           | Operation contracts and returned results                              |
| Liquid         | Parameterized partials, manifest-backed components, custom lists/views and queries | Include chains, view columns, variables, loops, snippets and FetchXML |
| Plug-ins       | Account/contact validation and normalization on Create and Update                  | Eight exported steps, C# sources and their local JavaScript models    |

These are sample scenarios, not every Power Pages feature; [coverage](coverage.md) states the supported boundary.

## Check access, backend logic and empty states

- **Reader access.** In **Tweaks**, switch to **Alex Demo 01** (reader). Readers see accounts, related contacts and
  notes; Web API and PCF hide write actions and write requests are denied. Account access is global; contact access is
  scoped through the parent account. Inspect shows the exported role grants.
- **Backend operations.** Under **Manage data and personas > Backend operations**, set a local JSON response mock, call
  the operation from **Extended** and compare; **Use source default** restores it. See
  [operation modes](../mirage/docs/operations.md) before enabling exported code.
- **Plug-ins.** The same catalogue lists the plug-in steps. The sample pack supplies their local handlers, which is
  why the compiled assembly does not run until you choose **Execute trusted original CLR assembly** for a step
  (Windows). See the [plug-in guide](../mirage/docs/dataverse-plugins.md).
- **Empty state.** Under **Manage data and personas > Plugins & presets**, apply **Empty account workspace**, refresh,
  then apply **Populated account workspace** to restore.

## Edit and deploy

Open `paqvilo-example/portal/web-files/demo.css`, change a style and save; the browser refreshes with the edit. Use
Inspect to find any other source. To put the sample in your own environment, follow its
[deployment guide](../examples/project/deployment/README.md). Before `git add` of the demo on Windows, run
`git config core.longpaths true`: exported multistep metadata exceeds the default path limit.
