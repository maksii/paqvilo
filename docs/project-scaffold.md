# Scaffold a consumer project

`paqvilo init` creates an empty project for your own portal exports, catalogue, data packs and tests. `paqvilo mirage init` creates a local runtime project for an existing catalogue. `paqvilo mirage demo` copies the populated example. These are separate workflows.

```sh
npx paqvilo@^0.9.5 init ./my-portals --name my-portals --site customer --site partner
cd my-portals
npm run setup
npm run configure
npx paqvilo init --check
```

Generation performs no installation, network access or browser launch. It does not create sources, runtime state, `.env`, a lockfile or `node_modules`. `setup` explicitly installs dependencies, checks the chosen browser and refreshes editor paths. `configure` opens the [local setup workspace](setup.md) for sources, environments and settings. Afterwards, resolve remaining findings described by the generated `AGENTS.md`.

## Options

| Option | Default | Use |
| --- | --- | --- |
| `[dir]` | `.` | New or empty target directory |
| `--name` | Target basename | Lowercase package slug; also the default pack ID |
| `--site` (repeatable) | `portal` | Site IDs; ports start at 8787 and increment |
| `--default-env` | `dev` | Placeholder environment per site |
| `--source-root` | `./sources` | Portal/Solution checkout root |
| `--pack` (repeatable) | Project name | One pack uses `pack/`; several use `packs/<id>/` |
| `--no-pack` | Off | Omit pack modules/adapter; retain catalogue and smoke tests |
| `--browser` | `msedge` | `msedge`, `chrome` or `chromium`; Chrome debugger for the latter two |
| `--toolkit` | `^<installed-version>` | Dependency spec, including `file:../paqvilo` |
| `--no-vscode` | Off | Omit tasks, launches, workspace and setup refresh |
| `--into-existing` | Off | Add missing files only and report every skipped file |
| `--interactive` | Off | Choose the browser through the terminal picker |
| `--json` | Off | Machine-readable schemaVersion 1 reports |

Names, site IDs, environment IDs and pack IDs use lowercase letters, digits and hyphens, start with a letter or digit, and are at most 64 characters. Reserved object/Windows device names and duplicate IDs are rejected. `--name` is required when the target basename does not follow these rules. This narrower scaffold convention keeps paths, scripts and task labels portable; existing catalogues still support the broader configuration identifier contract. Sites named `pick` or `debug` use `dev:site:<id>:dev` and `mirage:dev:site:<id>:dev` shortcuts, preserving the project-wide picker/debugger commands.

The command refuses nonempty targets without `--into-existing` and rejects symbolic links/junctions in output paths. It never replaces existing files. Into-existing mode does not merge an existing package or catalogue: inspect skipped files and reconcile those values yourself.

## Completion checks

`paqvilo init --check [dir] [--config file] [--json]` reads the project without importing pack JavaScript. It lists `TODO(paqvilo-init):` markers with file/line, validates the catalogue and site/environment selections, and reports placeholder `.example.test` origins, missing pack modules, and missing source/Solution folders. Personal environment overrides cannot hide a shared placeholder URL. Missing source paths have warning severity because an external checkout may be absent, but any unfinished item still yields exit code 1. Resolve them in the checkout where you validate readiness. Removing a marker is an explicit project decision, including confirming that no Solution roots are needed.

In Git projects the scan includes tracked and untracked text files while respecting ignores, including when the index is empty. Outside Git it uses a directory scan. Files larger than 1 MiB, symlinks, dependency directories, private `.env`/local config, runtime state and legacy state are excluded. `.env.example` is included. Source diagnostics follow the same shell/`.env` overrides as development commands. The checker is a scaffold readiness check; it does not establish page coverage, pack matching or live parity. `lense doctor` provides a nonfatal reminder when a generated project still has markers.

## Editor refresh

```sh
npx paqvilo init --refresh-editor
npx paqvilo init --refresh-editor --workspace-only
```

Refresh uses the resolved catalogue, including `.env`, personal overrides and `PAQVILO_REPO`, to write existing project/source/Solution folders into the ignored `<name>.code-workspace` and set debugger `webRoot`. Point `PAQVILO_REPO` at your active portal worktree when using an external shared catalogue. Project configuration and local state retain their catalogue location.

Development tasks invoke the installed CLI with the resolved catalogue's sites and browser; refresh adds/removes these tasks when the catalogue changes. Other tasks invoke the project's npm scripts. Browser launches attach to the corresponding toolkit browser. Lense uses profile `lense` and debugger port 9222, Mirage uses `mirage` and 9223. Their background matcher comes from the toolkit's development-ready message. The generated `tools/test-browser.mjs` collects actual test files under the project's browser-test folders, so empty pack folders work on Windows too. Add fixtures before claiming successful browser coverage; only empty fixture folders skip. Nonempty exports use the runtime's importer, including enhanced and code-site layouts; invalid fixtures fail visibly.

Generated editor documents are plain JSON with a `paqvilo.scaffold` marker and content hash. Refresh replaces only untouched generated documents. It preserves hand-edited documents and writes `launch.generated.json`/`tasks.generated.json` or a generated workspace alternative for review. Edited alternatives are preserved too. Refresh does not change your project scripts: update those when changing site IDs or browser command options. No force overwrite or scaffold migration is provided.

Templates live in `templates/project/`, separately from `examples/project/`. They contain no customer data, personas, observations or deployed sources. The short generated `AGENTS.md` links to maintained online setup/configuration, Lense, Mirage and project-extension guides. Links derive from the toolkit package's repository metadata; the installed CLI and bundled docs are the fallback when online documentation differs from the installed version. See [project extensions](project-extensions.md), [configuration](configuration.md) and [getting started](getting-started.md).
