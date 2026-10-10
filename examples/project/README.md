# Paqvilo demo project

One account workflow in three Power Pages approaches: native lists and basic forms, custom Web API, and PCF field editors. Includes 12 invented accounts, 24 contacts, notes, an attachment, typed field metadata and the solution sources.

Run the demo from an empty folder:

```sh
npx paqvilo mirage demo
```

The command creates `paqvilo-example` and opens a dedicated development browser. Keep the terminal running. Click **Sign in**, choose **Alex Example 01**, then open **Web API → Arcwell Services**.

1. Edit its service score, date or primary contact. Save and reopen the record.
2. Create a related contact. View, edit and delete it in the contact dialog.
3. Download the service brief, add a note or attach a small file.
4. Compare Active, All and Inactive views in the native and custom lists.
5. Press **Alt+Shift+P** for Inspect and Tweaks. Open `/_sim/` to edit data, switch personas or apply the empty workspace preset.
6. Edit `portal/web-files/demo.css` and save. The browser applies the local source change.

Changes in Mirage stay local. Each demo start restores the populated dataset and preserves source edits. Close the browser or press **Ctrl+C** to stop.

Use **Alex Example 01** for editor access and **Blair Demo 01** for reader access. Readers can view accounts and their related contacts and notes; their create, update and delete requests are rejected. Change personas through local sign-in or `/_sim/`. Permissions come from the exported web roles and table permissions, including parent scopes.

Native customization lives in page HTML, page CSS/JavaScript and basic-form JavaScript. The Web API approach keeps request logic in `portal/web-files/demo-workspace.js` and shared CSS in `portal/web-files/demo.css`; its list page includes a presentation template. Three content snippets provide native guidance, access guidance and the home tagline.

| Area | Current local coverage |
|---|---|
| Web API | Account/contact CRUD, views, lookups, typed fields, notes and attachments |
| Native | Account list, fields, lookups, Contacts modal CRUD and native notes with attachments |
| PCF | Imported standard-control bundle with 14 typed editors; account, contact and notes CRUD |
| Extended | Registered exported calculations, role-scoped local Dataverse reads and Example Location request/response |

Try the same account in all three approaches. On **Extended**, calculate an estimate, read the account overview and send a location through the imported flow definition. Mirage executes the explicitly registered local operations; it does not call Power Automate or a live Dataverse environment. Unsupported connector calls and flow actions require a project handler. The PCF host covers standard controls; dataset and React hosts require further support.

`portal/` contains the sanitized PAC portal export. `solution/` contains unpacked solution sources. `components/` includes editable PCF projects. `deployment/` includes the importable solution, PAC-cloned project and sample data export. Follow the [deployment instructions](deployment/README.md) to run the same sample in your own Power Pages environment. `metadata/` supplements standard Dataverse metadata omitted from solution exports. `pack/` owns the invented dataset and presets. The default catalogue points only to loopback.

Install dependencies with `npm install`, then run `npm test` for the project’s local CRUD acceptance check. See [project extension guidance](https://github.com/maksii/paqvilo/blob/main/docs/project-extensions.md) when developing your own portal project.
