# Explore the demo

The demo is a populated Power Pages workspace for comparing native, Web API and PCF development. It includes editable sources and deployment artefacts. It runs locally without a Power Pages account.

After [installing Paqvilo](getting-started.md#1-install), run from your project terminal:

```sh
npx --no-install paqvilo mirage demo
```

The command creates `paqvilo-example/`, selects a free port and opens the browser. Keep the terminal running. Close the browser or press **Ctrl+C** to stop.

## Prefer VS Code tasks

Create a folder and open it through **File > Open Folder** in VS Code. In **Terminal > New Terminal**, run these lines once:

```sh
npm init -y
npm install --save-dev paqvilo
npx --no-install paqvilo mirage demo --scaffold
```

Open **File > Open Workspace from File**, then select `paqvilo-example/paqvilo-demo.code-workspace`. In **Run and Debug**, select **Demo: Mirage and browser debugger** and press **F5**. Its task installs the demo's dependencies, starts Mirage and attaches the debugger to that dedicated Edge browser. The scaffold command itself starts no runtime.

Use **Inspect** to open a source file in VS Code. Edit and save to preview it; set a JavaScript breakpoint in `portal/web-files/demo-workspace.js` to debug the custom workspace. **Terminal > Run Task** also offers **demo: Start Mirage** and **demo: Run acceptance tests**.

Close the development browser before starting another session. Disconnecting the debugger alone keeps that browser running. Debug tasks use port `9222`; change both the task and launch configuration if that port is occupied. To use **Demo: Lense and browser debugger**, first add your deployed portal as an environment in `paqvilo.config.yml`, then enter its environment name when prompted. Sign in through that browser; its form submissions use live data.

## Try a complete account scenario

1. Choose **Sign in**, then select **Alex Example 01**.
2. Open **Approach > Web API**. Compare **Active**, **All** and **Inactive**, search by name and use **Next** and **Previous**. Open **Arcwell Services**, edit a typed field, save and reopen it.
3. Select a primary contact or parent account through its lookup dialog. Search, page through the results and choose a row. Use **Tab** to move between controls, **Enter** to search or select, and **Escape** to close the dialog.
4. Search the related contact list. Add a contact, edit it in its dialog and delete the test row. Use an account with more than eight contacts, or add enough test rows, to exercise contact paging.
5. Download the service brief. Edit its note and confirm the attachment remains available. Add a note with a small attachment; the custom workspace accepts files up to 1 MB.
6. Open **Out of the box**, select the same account and choose **New contact** in its subgrid. Check the prefilled account, save, then use the row menu to view, edit and delete the contact. Open **PCF** to compare 14 typed code-component editors. The sample does not include a PCF dataset control.
7. Open **Extended** to calculate an estimate, read an account overview and run the location request/response simulation.
8. Open **Liquid > Partials and parameters**, **Lists and views**, then **Data and conditions**. Compare the two- and four-row previews, choose a view with **Apply view**, and use **Apply filter** to compare statuses. Inspect parameterized includes, the component manifest, custom view cells and filtered FetchXML results.
9. In **Web API**, try an account name shorter than three characters or a contact last name shorter than two. Check the validation message. Save a valid name and email with surrounding spaces, then reopen the record to inspect normalization. These scenarios use the sample's local models of its eight registered plugin steps.
10. Press **Alt+Shift+P** and open **Inspect**. Follow the page, template, form, view, field, plugin and permission links into their source files.

| Approach | Source pattern | What to inspect |
| --- | --- | --- |
| Out of the box | Native lists/forms, page/template markup and form scripts/styles | Exported views, FormXml, contact modal actions and notes |
| Web API | Liquid template with JavaScript and CSS web files | `/_api` entity sets, assets, custom dialogs and save results |
| PCF | Web API workspace with exported typed code components | Component manifests, resources and editor outputs |
| Extended | Server logic and a local flow simulation | Operation contracts and returned results |
| Liquid | Parameterized partials, manifest-backed components, custom lists/views and queries | Include chains, view columns, variables, loops, snippets and FetchXML |
| Plugins | Account/contact validation and normalization on Create and Update | Eight exported steps, C# sources and explicit local models |

These are implemented sample scenarios. They do not demonstrate every Power Pages field or platform feature. See [coverage](coverage.md) for the supported boundary.

## Check access and empty states

Use **Tweaks** to switch from **Alex Example 01**, the editor, to **Blair Demo 01**, the reader. Blair can read accounts, related contacts and notes. Web API and PCF hide write actions; native redirect links can open a form that denies creation or editing. Write requests are denied. Switch back to Alex to continue editing. Compare global account access with contact relationships scoped through the parent account. Inspect shows the exported role grants and local permission context.

Open **Manage data and personas > Operations** to inspect the exported server logic and flow. Set a local JSON response mock, call the operation from **Extended** and compare its result. Choose **Use source default** to restore its configured behavior. These controls affect local simulation. See [operation modes](../mirage/docs/operations.md) before enabling exported code.

The same catalogue shows the plugin steps. The sample pack supplies their synchronous local handlers; Mirage does not execute the compiled assembly. Other imported plugins start as visible placeholders unless configured. See the [plugin guide](../mirage/docs/dataverse-plugins.md) before relying on a local write result.

Open **Manage data and personas > Plugins & presets**. Apply **Empty account workspace**, refresh and check the empty views. Restore **Populated account workspace** to continue. Running the demo command again preserves source edits and restores the sample dataset.

## Make your first source edit

Open `paqvilo-example/portal/web-files/demo.css` in VS Code, change a style and save. Check the browser after refresh. Use Inspect to locate another source before editing it.

The sample also contains PAC exports, unpacked Solution sources and PCF projects. Its [project guide](../examples/project/README.md) describes the files; its [deployment guide](../examples/project/deployment/README.md) explains deployment to your own environment. Your online sign-in, environment settings and data remain separate from the local demo.
