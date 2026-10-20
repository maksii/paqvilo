# Local setup workspace

Run `paqvilo setup --open` from your project to open the local `/_setup/` workspace. It works before exports exist and with missing or invalid configuration. It never falls back to editing the toolkit's bundled catalogue. Select a different shared catalogue with `--config <file>` or a standalone Mirage project with `--project <file>`. `--port 0` chooses a free loopback port; `--json` prints the URL. Ctrl+C stops this setup server. `paqvilo lense setup` and `paqvilo mirage setup` are aliases.

Generated projects and demos include `npm run configure`. Install the toolkit first (`npm run setup` in a scaffold); the workspace does not install packages or browsers. Use [getting started](getting-started.md) for installation and [the configuration reference](configuration.md) for settings.

## Configure through the page

The overview shows actionable configuration findings and the current project directory. Portal cards show resolved export paths, detected layouts, Git branch/commit and tracked changes, environment origins, explicit pack modules and Solution-folder status. A valid configuration is not proof of navigation, browser application or a deployed commit.

Start with **Runtime configuration**: Power Pages, model-driven apps, or an organization API only. Model-driven/API projects use exported Solutions and optional trusted packs without a portal source or environment URL. Guided creation defaults to dry run; existing configurations retain omitted legacy persistence until explicitly changed. Select an imported default application, API listener/port and simulation level. The project form also edits Solution paths and explicit pack registrations. See [standalone organization setup](../mirage/docs/standalone-organization.md).

Dry run permits record edits in memory and disables schema changes. Simulation updates declared existing pack DATA files; deep simulation also permits declared schema changes. The page describes these differences without executing packs. After starting Mirage, Administration shows exact targets/readiness and disables writes to unowned tables. Changes require restart and never flush in-memory edits; see [simulation levels](../mirage/docs/simulation-levels.md).

Use the shared layer for team configuration and the personal layer for local overrides in ignored `paqvilo.config.local.yml`. They use the existing precedence: CLI, shell, `.env`, personal overrides, shared catalogue. The page identifies supported effective shell/`.env` choices and their origins without exposing `.env` contents or discovery records. Deleting a personal override reveals its shared value; removing shared environments should be done in the shared layer. The page does not edit shell settings or `.env`.

Portal forms configure sources, default environments, local ports, Solution roots, presets, route mappings and scope. Sources and Solution roots resolve below the source root; the source root resolves from the catalogue directory. Absolute paths work for separate Git checkouts. Origin fields require HTTP(S) origins without credentials, paths or query strings. Mark real-data environments with caution. Packs remain explicitly registered trusted project modules; setup checks paths without executing them.

The document editor supports all existing settings and repairs invalid YAML. Guided edits preserve unrelated fields/comments; replacing a whole document is an explicit action. Standalone Mirage projects use their project schema and do not receive unused portal/environment readiness findings. Switching profiles retains existing portal selections so switching back reuses them; a new standalone project can add a portal export through the runtime form. Source files remain unchanged. JSON project files retain JSON encoding. Missing folders and placeholder environments are readiness findings, so configuration can be completed incrementally. Schema errors reject saves. When another process edits configuration, reload before saving; unsaved form edits stay visible after a conflict.

## During a preview

Saves ensure project ignore rules for `.env`, personal configuration and local runtime state. A personal file already tracked in Git must be untracked before the page will save private overrides. Existing ignore-file content is preserved.

Mirage serves the workspace at `/_setup/` on each runtime and links to it from `/_sim/`. The development browser's Paqvilo panel also links to setup. Lense prints a separate loopback setup URL and links it from the panel; the workspace is never mounted on a live portal origin. If development cannot start, use the independent `paqvilo setup` command to repair the project.

Saves apply on the next preview start. The workspace identifies the running source and reports when project configuration has changed since startup. Restart to apply changes; saving cannot silently redirect a running browser, reset simulator data or change source watchers. Refresh status to see external changes.

The service accepts loopback connections only, confines file access to its selected configuration layers, validates Host/Origin and CSRF for saves and refuses symlinked configuration outputs. It does not deploy, synchronize, execute PAC, read live references, import packs or authorize live writes. Treat it as a local development tool with the same project access as the CLI.
