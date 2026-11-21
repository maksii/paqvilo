# Local setup workspace

```sh
npx --no-install paqvilo setup --open     # or `npm run configure` in a generated project or the demo
```

`paqvilo setup` serves the local `/_setup/` workspace: a browser editor for the [configuration](configuration.md). It
works before exports exist and with missing or invalid configuration, and never falls back to the toolkit's bundled
catalogue. `paqvilo lense setup` and `paqvilo mirage setup` are aliases.

| Option             | Effect                                                        |
| ------------------ | ------------------------------------------------------------- |
| `--config <file>`  | Shared catalogue to edit (default `./paqvilo.config.yml`)     |
| `--project <file>` | Standalone Mirage project file instead of a catalogue         |
| `--port <n>`       | Loopback port; a free port is chosen when omitted             |
| `--open`           | Open the workspace in the browser                             |
| `--json`           | Print `url` and `config` as JSON (`project` with `--project`) |

`--config` and `--project` are alternatives: giving both fails and names them. Commands the page shows are built for the
folder it serves: an npm script only when the project's `package.json` defines that same command, otherwise
`npx --no-install paqvilo …` in a project that depends on paqvilo and `npx paqvilo …` elsewhere.

Ctrl+C stops only the setup server. Starting a project whose configuration file does not exist from a terminal
(`lense dev`, `mirage dev` or `mirage start`, without `--project`) opens setup instead of failing. Without a terminal
the command fails and prints the `setup` command to run; with `--json` it fails with `CONFIG_NOT_FOUND`.

Setup configures; [`/_sim/`](../mirage/docs/sim-administration.md) manages a running preview. Both share one shell with
an **Areas** switch. Setup does not install packages or browsers ([getting started](getting-started.md)), deploy,
synchronize, run PAC, read live references, execute data packs or authorize live writes.

## Quick setup

The page opens on **Quick setup**, five steps for someone who has an exported site or Solution and does not know the
configuration format. **All settings** switches to the full [journey](#journey); the choice is remembered in the
browser.

| Step                 | What it does                                                                                                                                                                                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What you want to run | Any combination of a Power Pages website, model-driven apps, canvas apps and the Dataverse Web API. The choice sets the runtime kind and the `dataverse.enabled`, `modelDriven.enabled` and `canvas.enabled` switches.                                            |
| Your exported files  | Pick the website export and Solutions from the folders setup found, or browse. Solutions are required for model-driven or canvas apps.                                                                                                                            |
| Data (optional)      | Starting data set of a registered data module, and whether record changes last only while the preview runs (dry run) or are saved into project data files ([simulation levels](../mirage/docs/simulation-levels.md)). Data sets are listed once the preview runs. |
| Run it               | Start, restart and stop the preview; open the website, apps, canvas apps and simulator. A failed start shows its reason and links the startup log.                                                                                                                |
| Check                | Findings in plain words with the step that fixes them and, while the preview runs, what is ready, what runs as a local stand-in and what is missing.                                                                                                              |

In a folder without configuration, setup searches up to four folders deep (skipping dot folders and `node_modules`) for
website exports, unpacked Solutions and `pack.mjs` data modules. **Create project** writes one target that uses them,
with a free local port (8787 when available), a free Web API port (8790 when available) when the API is chosen, and dry
run. A found data module is registered only when ticked, by its path.

Setup starts and stops only local Mirage previews the toolkit owns, through `paqvilo mirage start|stop` in a detached
runner (`.paqvilo/setup/preview-operation.json` records the last operation). A preview started from a terminal is shown
with the command to restart it there. A Lense preview is never started, stopped or contacted from setup.

## Journey

**All settings** is one guided page: a status strip, the system map, and nine stages. Each stage is `done`, `next`,
`blocked` or `optional`, derived from the findings and the configuration.

| Stage                 | Required                       | Holds                                                                                                                      |
| --------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Project               | yes                            | The settings file; four example templates with invented names and `example.test` origins, all dry run                      |
| What to run           | yes                            | Runtime kind and switches, local port, Web API port, first model-driven app, what happens to changed records               |
| Exported files        | yes                            | Website export, Solution folders, `canvas.sources`, `modelDriven.clientSources`, `deploymentProfiles`, `codeApps`          |
| Sample data           | no                             | Data pack modules (a path, or `id \| path`), starting data and when it loads                                               |
| Live environments     | when a site serves Power Pages | Lense origins, first page, route mappings, scope. A placeholder origin alone leaves the stage optional                     |
| Test people & sign-in | no                             | How many test people sign in side by side (`personaContexts`) and the local sign-in                                        |
| Outside services      | no                             | Connections, storage, messaging and declared services                                                                      |
| Web API access        | no                             | Dataverse API users and app registrations                                                                                  |
| Start & check         | yes                            | Preview controls and on-demand preflight (ids or globs, optionally strict). Done when the running preview matches the file |

A key without a dedicated form appears in the **More settings** editor of its stage as a guided control or a YAML
snippet validated on save. `secrets`, `connections` and `dataverse.applications` accept references only; their values
are redacted in the guided view. The document editor edits every setting and can repair invalid YAML.

## Configure through the page

- **Layers.** The shared layer is the team catalogue; the personal layer is the ignored `paqvilo.config.local.yml`.
  Precedence is unchanged ([configuration](configuration.md#select-a-catalogue)). The page shows effective shell and
  `.env` choices without exposing `.env` contents or discovery records, and does not edit them. In a catalogue session,
  each `sites.<id>.mirage.project` file inside the catalogue folder is a further layer, `project:<site>`.
- **Paths.** Sources and Solution roots resolve below the source root, which resolves from the catalogue directory;
  absolute paths work for separate checkouts. Origins must be HTTP(S) origins without credentials, paths or query
  strings.
- **Several websites** are several projects, each with its own local port.
- **Saves.** Guided edits preserve unrelated fields and comments; replacing a whole document is an explicit action; JSON
  project files stay JSON; schema errors reject the save. Missing folders and placeholder origins are findings, not
  errors, so configuration can be completed step by step. When another process edited the file, reload before saving;
  unsaved form edits stay visible.
- **A valid configuration is not proof** of navigation, browser application or a deployed commit.

### API

| Route                                                        | Purpose                                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `GET /_setup/api/status`                                     | Findings, stages, planned topology and `settingsCatalogue` (every editable key) |
| `GET /_setup/api/quick`                                      | Exports found in the folder                                                     |
| `GET /_setup/api/folders?path=`                              | One folder of the folder picker (read-only)                                     |
| `GET /_setup/api/port`                                       | A free local port                                                               |
| `GET /_setup/api/preview`                                    | Running previews of this configuration and the last operation                   |
| `POST /_setup/api/preview`                                   | `{ action: start \| stop \| restart, site }`; setup token required              |
| `GET /_setup/api/runtime/{dashboard,status,packs,preflight}` | Read-only relay to a Mirage preview on a loopback origin                        |

## During a preview

Mirage serves the workspace at `/_setup/` on each runtime's administration address (the `setupUrl` it reports;
`/_setup/` on the portal address redirects there). Lense prints a separate loopback setup URL and links it from the
Paqvilo panel; the workspace is never mounted on a live portal origin. If development cannot start, run `paqvilo setup`
on its own to repair the project.

Saves apply on the next preview start: saving never redirects a running browser, resets simulator data, flushes
in-memory edits or changes source watchers. The workspace compares the runtime settings the preview loaded with those of
the saved configuration, not file contents, and when they differ shows the exact restart command for the running product
and site.

Saves ensure project ignore rules for `.env`, personal configuration and local runtime state, preserving existing
ignore-file content. A personal file already tracked in Git must be untracked before private overrides can be saved.

Tooling requests have a two-minute deadline and timed-out writes are never retried automatically: the server may have
completed the write, so check the refreshed configuration before retrying.

## Security

The service accepts loopback connections only, confines file access to its selected configuration layers, validates
Host, Origin and a CSRF token for saves, and refuses symlinked configuration outputs. Treat it as a local development
tool with the same project access as the CLI.
