# Getting started

Install Paqvilo into a project folder, try the demo, then connect your own Power Pages export. You do not need to clone
the toolkit repository. For model-driven apps or the Dataverse Web API without a portal, follow the
[standalone organization guide](../mirage/docs/standalone-organization.md) instead.

## 1. Install

| Tool                                                                        | Why                                                       |
| --------------------------------------------------------------------------- | --------------------------------------------------------- |
| [Node.js 26.13.1 or later in the 26.x line](https://nodejs.org/en/download) | Runs Paqvilo; includes npm and npx                        |
| Edge (default) or Chrome                                                    | The dedicated development browser                         |
| [Git](https://git-scm.com/downloads)                                        | Baselines for Lense markup patches and change comparisons |
| An editor such as [VS Code](https://code.visualstudio.com/download)         | Inspect opens sources in it (`code` by default)           |

In a new or existing project folder (run `npm init -y` only if there is no `package.json`):

```sh
npm init -y
npm install --save-dev paqvilo
npx --no-install paqvilo --help
npx --no-install paqvilo doctor --setup --browser msedge
```

`npx --no-install paqvilo` runs the installed copy; one install supplies both Lense and Mirage. `doctor --setup` checks
installed dependencies, Node and Git, and that the browser is installed: the one named by `--browser` (use `chrome` for
Chrome), else the one in `./paqvilo.config.yml`; with neither, or when that file cannot be read, it reports the browser
as not checked and why. Commit
`package.json` and `package-lock.json` (use `npm ci --ignore-scripts` for repeatable installs) and ignore
`node_modules/` and `.paqvilo/`. On Windows, run `git config core.longpaths true` in any repository that will hold deep
portal exports. On macOS, Inspect finds VS Code in `/Applications` or `~/Applications` when its `code` shell command is
not installed, and the panel shortcuts written **Alt+Shift+…** use the Option key.

### Try the demo

```sh
npx --no-install paqvilo mirage demo
```

This copies an editable sample into `paqvilo-example/`, loads invented data and opens the development browser on a free
port; no portal export or Power Pages account is needed. Keep the terminal running; close the browser or press
**Ctrl+C** to stop. Rerunning keeps your source edits and restores the sample dataset. Options: `--dir <folder>` (an
unrelated nonempty folder is never overwritten), `--browser chrome`, `--scaffold` (prepare the VS Code workspace without
starting). The [demo guide](demo.md) is the walkthrough.

## 2. Scaffold your project

For your own site, generate an empty project (a new folder with its own `package.json`, outside the demo folder) and
configure it in the browser:

```sh
npx paqvilo@^0.9.8 init ./my-portal-project
cd my-portal-project
npm run setup
npm run configure
npm run check:project
```

`init` writes files only. `setup` installs dependencies and checks tools; `configure` opens the
[setup workspace](setup.md); `check:project` is the offline readiness gate. The
[project scaffold guide](project-scaffold.md) covers every generated script, multi-site projects and adopting an
existing project.

### Connect an export

Paqvilo reads a local export; it does not download or deploy the site. If you have none, use
[`pac pages download`](https://learn.microsoft.com/en-us/power-pages/configure/power-platform-cli-tutorial#download-website-content).
A layout that works without extra settings:

```text
my-portal-project/
  package.json
  paqvilo.config.yml
  sources/portal-export/   # the exported site (website.yml, web-pages/, ...)
  solutions/               # optional unpacked Dataverse Solutions
  .paqvilo/                # ignored local state
```

For that layout, set these values in the generated `paqvilo.config.yml` (in the setup workspace or by hand), keep its
other keys, and remove each `TODO(paqvilo-init)` marker as you settle it:

```yaml
sourceRoot: ./sources
sites:
  portal:
    source: portal-export
    environments:
      dev: https://your-portal.example.test
defaults:
  mirage:
    solutionRoots: [../solutions/Core] # [] when you have no Solution export
```

Replace the URL with your online development environment. `source` and `solutionRoots` resolve from `sourceRoot`, so
`solutions/Core/` above is `../solutions/Core`. Check that the export is readable:

```sh
npx --no-install paqvilo mirage inspect --config ./paqvilo.config.yml --site portal
```

Its `pages` should list your pages; review any `diagnostics`. Settings and export formats are in
[configuration](configuration.md).

## 3. Work locally with Mirage

```sh
npx --no-install paqvilo mirage dev --config ./paqvilo.config.yml --site portal
```

`mirage dev` reads the catalogue, opens the rendered portal in a dedicated browser and stops the runtime when that
browser closes. **Alt+Shift+P** opens the panel: **Inspect** follows an element to its templates, forms, tables and
access rules; **Tweaks** signs the browser in as a local persona and selects scenarios; the administration address
(`/_sim/`) manages simulated records and runtime settings.

A new state holds portal configuration and empty business tables, and every visitor starts anonymous. For generated
rows, stop the session and run:

```sh
npx --no-install paqvilo mirage data scaffold --config ./paqvilo.config.yml --site portal --profile smoke --state .paqvilo/smoke-state.json
npx --no-install paqvilo mirage dev --config ./paqvilo.config.yml --site portal --state .paqvilo/smoke-state.json
```

Scaffolding generates rows only for tables whose Solution metadata it finds; the report lists the others under
`referencedWithoutMetadata`. For realistic cases, add Solution metadata and register a
[data pack](../mirage/docs/data-packs.md). Background sessions and several portals are in the
[Mirage guide](../mirage/README.md).

## 4. Preview live with Lense

Lense compares local files with a Git baseline to patch literal markup. If the export is not yet committed:

```sh
git init
git config core.longpaths true
git add sources/portal-export
git commit -m "Baseline portal export"
```

The baseline records local files; it does not establish what is deployed online.

```sh
npx --no-install paqvilo lense dev --config ./paqvilo.config.yml --site portal --env dev
```

Sign in through the portal's own sign-in with your intended account, edit an exported CSS file and save; the stylesheet
is swapped in place (other saved files reload the affected tabs). **Online / Local** in the panel compares responses.
Liquid and Dataverse still run online, so portal actions change live data and server-side changes still need deployment.
See [Lense](lense.md).

## Troubleshooting

| Problem                                      | Action                                                                                                                  |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `node` or `npm` is not recognized            | Install Node.js, then reopen the terminal and editor.                                                                   |
| PowerShell blocks `npm.ps1`                  | Use Command Prompt (VS Code terminal dropdown) for the same commands.                                                   |
| The `paqvilo` command is missing             | Run from the folder containing `package.json`, after `npm install --save-dev paqvilo`.                                  |
| A demo folder is rejected                    | Choose a new folder with `--dir ./another-demo`.                                                                        |
| Edge cannot launch                           | Install Edge, or add `--browser chrome`.                                                                                |
| Mirage does not start                        | Read the failure's phase, then `.paqvilo/mirage/logs/startup-*.log`; `mirage preflight` names blocking requirements.    |
| A command fails in a script                  | Rerun with `--json` and read `error.code`; see [CLI exit status](cli.md#output-and-exit-status).                        |
| Exported pages are missing                   | Point `sourceRoot`/`source` at the folder holding the export and rerun `mirage inspect`.                                |
| Mirage lists are empty or access is denied   | Add rows, sign the browser in as a local persona and check its table permissions.                                       |
| A saved change is missing in Lense           | Check applied resources, unmatched patches, `needsDeploy` and failed requests in the panel.                             |
| Inspect cannot open the editor               | Set top-level `editor` in `paqvilo.config.yml`, or `PAQVILO_EDITOR`, to the editor command or executable, then restart. |
| A deep export fails to add to Git on Windows | Run `git config core.longpaths true` in that repository.                                                                |
