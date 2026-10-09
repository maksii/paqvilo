# Getting started

Install Paqvilo, try the included example, then connect your own Power Pages export. The toolkit runs on your computer; you do not need to clone its repository.

## 1. Install

### Prepare your computer

| Tool | Why you need it |
| --- | --- |
| [Node.js 24 LTS](https://nodejs.org/en/download) | Runs Paqvilo and includes npm and npx. Node.js 22+ is supported. |
| Edge or Chrome | Displays your portal and the integrated development panel. Edge is the default. |
| [Git](https://git-scm.com/downloads) | Provides source baselines for browser overlays and change comparisons. |
| [Visual Studio Code](https://code.visualstudio.com/download) | Recommended editor for your exported sources and configuration. |

After installing Node.js, reopen VS Code. Open **Terminal > New Terminal** and enter:

```sh
node --version
npm --version
```

Both commands should print a version. A terminal is the command window where you enter the examples below. Run each line separately.

### Install in a working folder

For a first trial, create an empty folder:

```sh
mkdir paqvilo-demo
cd paqvilo-demo
npm init -y
npm install --save-dev paqvilo
npx --no-install paqvilo --help
```

For an existing project, open that folder in VS Code and use its terminal. Skip `mkdir` and `cd`; run `npm init -y` only if it has no `package.json`.

- `npm init -y` creates `package.json`, the project's tool and dependency list.
- `npm install --save-dev paqvilo` downloads Paqvilo into `node_modules/` and records it as a development tool.
- `npx --no-install paqvilo` runs that installed copy.

Keep `package.json` and `package-lock.json` with your project. Ignore `node_modules/` and `.paqvilo/` in Git. Installation needs internet access. The example needs no npm or Power Pages account.

### Try the included example

```sh
npx --no-install paqvilo mirage serve --source ./node_modules/paqvilo/examples/project/portal --state .paqvilo/demo-state.json --port 8787
```

Open [http://127.0.0.1:8787](http://127.0.0.1:8787). You should see the example home page as **Anonymous**. Open [`/_sim/`](http://127.0.0.1:8787/_sim/) for local administration.

Keep the terminal running. Stop with **Ctrl+C**. If the port is occupied, replace `--port 8787` with `--port 0` and open the printed address.

This example reads installed sources. To edit it and add test data, copy the [project starter](../examples/project/README.md) into your working folder.

## 2. Connect your site

You need a local Power Pages export. If you do not have one, follow Microsoft's [download website content guide](https://learn.microsoft.com/en-us/power-pages/configure/power-platform-cli-tutorial#download-website-content). Paqvilo reads exported files; it does not download or deploy the site.

Use this layout in your own project:

```text
my-portal-project/
  package.json
  paqvilo.config.yml
  sources/portal-export/    # your exported site
  solutions/               # optional unpacked Dataverse Solutions
  .paqvilo/                # ignored local state
```

In VS Code, create `paqvilo.config.yml` beside `package.json` and paste:

```yaml
sourceRoot: ./sources
defaultSite: portal
portals: selected
sites:
  portal:
    source: portal-export
    defaultEnv: dev
    environments:
      dev: https://your-portal.example.test
    mirage:
      port: 8787
      solutionRoots: []
```

Replace the example URL with your online development environment. Put your export in `sources/portal-export/`, or change `sourceRoot` and `source` to match its location. This directory must contain the exported site, such as `website.yml` and `web-pages/` for a standard export.

Solution paths resolve from `sourceRoot`. A Solution at `solutions/Core/` in the layout above is `../solutions/Core` in `solutionRoots`.

Check that Paqvilo can read your export:

```sh
npx --no-install paqvilo mirage inspect --config ./paqvilo.config.yml --site portal
```

The output should list your expected pages under `pages`. Review any `diagnostics` before continuing. For settings, export formats and several sites, see [configuration](configuration.md).

## 3. Work locally with Mirage

```sh
npx --no-install paqvilo mirage init --config ./paqvilo.config.yml --site portal
npx --no-install paqvilo mirage dev --config ./paqvilo.config.yml --site portal
```

The first command creates a local runtime project under `.paqvilo/`. The second opens your rendered portal in a dedicated browser. **Alt+Shift+P** opens the panel:

| Tool | Use it for |
| --- | --- |
| **Inspect** | Follow templates, snippets, settings, forms, tables and access rules to their sources. |
| **Tweaks** | Sign this browser in as a local persona and select permission or data scenarios. |
| **`/_sim/`** | Manage simulated records and runtime settings. |

New states contain portal configuration and empty business tables. Local sign-in is separate from your Microsoft account. Each runtime has its own session cookie.

For realistic test cases, add Solution metadata and register your own [data pack](../mirage/docs/data-packs.md). For generated sample rows, stop the session and run:

```sh
npx --no-install paqvilo mirage data scaffold --config ./paqvilo.config.yml --site portal --profile smoke --state .paqvilo/smoke-state.json
npx --no-install paqvilo mirage dev --config ./paqvilo.config.yml --site portal --state .paqvilo/smoke-state.json
```

Close the dev browser or press **Ctrl+C** to stop runtimes started by that session. For background sessions and several portals, see the [Mirage guide](../mirage/README.md).

## 4. Preview live with Lense

```sh
npx --no-install paqvilo lense dev --config ./paqvilo.config.yml --site portal --env dev
```

Sign in through the portal's own sign-in action with your intended account. Open an exported CSS file in VS Code, change a style and save. Check the affected page, then use **Online / Local** in the panel to compare responses.

Lense previews supported local resources while Liquid and Dataverse execute online. Portal actions can change live data. Server-side changes may still need your normal deployment process. See [Lense](lense.md) for supported edits and verification.

## Troubleshooting

| Problem | Action |
| --- | --- |
| `node` or `npm` is not recognized | Install Node.js, then reopen the terminal and VS Code. |
| PowerShell blocks `npm.ps1` | Choose **Command Prompt** from VS Code's terminal dropdown and run the same commands. |
| The Paqvilo command is missing | Open the folder containing `package.json`, then run `npm install --save-dev paqvilo`. |
| Edge cannot launch | Install Edge or add `--browser chrome` to `mirage dev` or `lense dev` for installed Chrome. |
| Exported pages are missing | Check the directory containing your exported site and run `mirage inspect` again. |
| Mirage lists are empty or access is denied | Add simulated rows and sign this browser in as a local persona; inspect its table permissions. |
| A saved change is missing | Check applied resources, unmatched patches, `needsDeploy` and failed requests in the panel. |

[Documentation index](index.md) | [Project starter](../examples/project/README.md)
