# Deploy the sample to Power Pages

The local demo needs Node.js and Paqvilo. A live deployment also needs [Power Platform CLI](https://learn.microsoft.com/power-platform/developer/cli/introduction), a Dataverse environment with Power Pages, and permission to import solutions and upload sites.

From the installed demo folder:

```powershell
npm install
pac auth create --environment https://YOUR-ENVIRONMENT.crm.dynamics.com
pac solution import --path ./deployment/PaqviloDemoCodeComponents.zip --publish-changes
pac solution import --path ./deployment/PaqviloDemoSample.zip --publish-changes
node ./deployment/configure.mjs --environment https://YOUR-ENVIRONMENT.crm.dynamics.com
pac pages upload --path ./portal --modelVersion 2
pac data import --data ./deployment/demo-data.zip
```

The configuration command resolves the PCF component ID created in your environment and updates its Liquid tag and local Inspect/Mirage binding. It reads Dataverse through your selected PAC identity. It changes local source files; the upload command applies them online.

Open [Power Pages](https://make.powerpages.microsoft.com), select your environment, then **Inactive sites → Paqvilo demo → Reactivate**. Choose its address and open it. See Microsoft's [site reactivation instructions](https://learn.microsoft.com/power-pages/admin/reactivate-website).

Register two portal users. In **Power Pages Management → Contacts**, give one user the **Workspace Editors** web role for this website. Leave the second with its automatic **Authenticated Users** role. Readers can view accounts and related contacts and notes. Editors can perform CRUD. Local sign-in uses Alex Example 01 and Blair Demo 01; the invented contacts are sample data, not online credentials.

In Power Automate, open **Example Location**, select **Turn on** if required, and confirm that the portal's cloud-flow consumer allows Authenticated Users. The flow returns the submitted location. It has no external connector or connection reference. Clear the portal cache after changing web roles or settings.

The import adds 12 accounts, 24 related contacts, two notes, an attachment and a EUR currency record. The data export uses fixed sample IDs. Reimporting restores those sample records.

| Folder or file | Purpose |
|---|---|
| `portal/` | Editable PAC portal export: pages, forms, templates, snippets, web files and permissions |
| `solution/` | Unpacked solution: account columns, forms, views, flow and site components |
| `code-solution/` | Separate PCF solution sources with the components' exa publisher |
| `deployment/PaqviloDemoCodeComponents.zip` | Importable PCF solution; import before the main sample solution |
| `deployment/PaqviloDemoSample.zip` | Importable unmanaged solution built with PAC |
| `deployment/PaqviloDemoSample.cdsproj` | PAC-cloned solution project pointing to `solution/` |
| `deployment/demo-data.zip` | Filtered PAC data export containing only the invented records |
| `components/` | TypeScript and manifest sources for the field editors and additional PCF examples |

To rebuild the solution after source changes:

```powershell
pac solution pack --folder ./solution --zipfile ./deployment/PaqviloDemoSample.zip --packagetype Unmanaged
pac solution pack --folder ./code-solution --zipfile ./deployment/PaqviloDemoCodeComponents.zip --packagetype Unmanaged
```

To rebuild a PCF, run `npm install` and `npm run build` in its `components/` project. Import or push the rebuilt control into your environment before resolving its ID again. The composite account control imports the 14 typed editor classes from the same field-types project.

For Lense, add your live address as an environment in `paqvilo.config.yml`, then run:

```powershell
npx paqvilo lense dev --config ./paqvilo.config.yml --site example --env online --profile demo-live --debug-port 9337
```

Sign in in that dedicated browser. Lense previews local sources over the live portal; saves through its forms and Web API affect your environment. `npm run dev` starts the local Mirage workflow.
