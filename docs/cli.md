# Command-line usage

Run `npx --no-install paqvilo --help`, then append `--help` to any command for its own options: every Lense command,
every Mirage command and lifecycle action, every public Mirage tool and every `paqvilo dataverse <command>`
(`paqvilo lense resources --help`, `paqvilo mirage serve --help`, `paqvilo dataverse plan --help`);
`paqvilo lense --help` lists every Lense and catalogue Mirage lifecycle option. Help needs no configuration, nor does
`--version` (`paqvilo`, `paqvilo lense` and `paqvilo mirage` accept it). `paqvilo`, `paqvilo lense`, `paqvilo mirage`
and `paqvilo dataverse` without a command print help and exit 0. Unknown commands and options fail as
[argument errors](#argument-errors) describe, also beside `--help`. Public Mirage tool help
(`paqvilo mirage liquid-conformance --help`) checks any arguments beside it against the tool's options without running
it.

In a toolkit checkout, use `node bin/paqvilo.mjs`. Avoid `npm run` when parsing JSON: npm adds a preamble to stdout.

## Command groups

| Command                                         | Purpose                                                                                                                                                                                                                                                                                                                                       | Guide                                                      |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `paqvilo lense <command>`                       | `dev`, `list`, `use`, `map`, `status`, `verify`, `doctor`, `analyze`, `audit`, `resources`, `agent`, `model-driven inspect\|dev`                                                                                                                                                                                                              | [Lense](lense.md), [model-driven](model-driven-actions.md) |
| `paqvilo mirage demo`                           | Copy the populated sample and open it                                                                                                                                                                                                                                                                                                         | [Demo](demo.md)                                            |
| `paqvilo mirage init\|dev\|start\|status\|stop` | Catalogue-driven Mirage lifecycle; runs through the Lense CLI and shares its catalogue and browser options                                                                                                                                                                                                                                    | [Mirage](../mirage/README.md)                              |
| `paqvilo mirage <command>`                      | `serve`, `inspect`, `render`, `data generate\|scaffold`, `preflight`, `capture-stylesheets`, `capture-snippet-composition`                                                                                                                                                                                                                    | [Mirage](../mirage/README.md)                              |
| `paqvilo mirage <tool>`                         | Public tools: `bootstrap-report`, `render-sweep`, `liquid-inventory`, `webapi-inventory`, `portal-matrix`, `parity-suite`, `baseline-suite`, `liquid-conformance`, `acceptance`, `enrich-reference`, `reference-parity`, `query-inventory`, `verify`, `verify-storage`, `capture-shell`, `trace`                                              | [Mirage reference](../mirage/docs/README.md)               |
| `paqvilo init [dir]`                            | Generate an empty consumer project; `--check`, `--ready`, `--refresh-editor` maintain it                                                                                                                                                                                                                                                      | [Project scaffold](project-scaffold.md)                    |
| `paqvilo setup`                                 | Serve the local `/_setup/` workspace (`lense setup` and `mirage setup` are aliases)                                                                                                                                                                                                                                                           | [Setup](setup.md)                                          |
| `paqvilo doctor --setup`                        | Check installed dependencies, Node and Git, and that the browser named by `--browser`, `--config` or `./paqvilo.config.yml` is installed; with none of these, or with an unreadable `./paqvilo.config.yml`, it reports the browser as not checked and why. An explicit `--config` that cannot be read fails. `doctor` without `--setup` fails | [Getting started](getting-started.md)                      |
| `paqvilo analyze`                               | Offline source review (same as `lense analyze`)                                                                                                                                                                                                                                                                                               | [Static analysis](static-analysis.md)                      |
| `paqvilo dataverse <command>`                   | Register a provisioning app, plan/apply/publish metadata and data, export Solutions                                                                                                                                                                                                                                                           | [Dataverse provisioning](dataverse-provisioning.md)        |

## Paths and quoting

Quote each path or value containing spaces or shell punctuation. Paths keep Unicode, including Cyrillic. Package, site
and pack identifiers have their own validation, so a Unicode or spaced project directory needs an explicit `--name`.

PowerShell:

```powershell
npx --no-install paqvilo init 'C:\Users\example\OneDrive - Example\Проєкт' --name portal-project
npx --no-install paqvilo lense resources --config 'C:\Projects\My Portal\paqvilo.config.yml' --search 'Header & Footer' --json
npx --no-install paqvilo lense list --config 'C:\Projects\My Portal\paqvilo.config.yml' --repo 'D:\Exports\Портал' --json
```

POSIX shell:

```sh
npx --no-install paqvilo init './Мій проєкт' --name portal-project
npx --no-install paqvilo lense resources --config './My Portal/paqvilo.config.yml' --search 'Header & Footer' --json
npx --no-install paqvilo lense list --config './My Portal/paqvilo.config.yml' --repo '/home/example/Exports/Портал' --json
```

In PowerShell, single quotes preserve `$`, `&` and spaces; double an embedded apostrophe (`'C:\Projects\O''Brien'`). In
a POSIX shell, write an embedded apostrophe as `'./O'"'"'Brien'`. Command Prompt uses double quotes and has its own
expansion rules.

- String options accept `--option=value`, which is how to pass a value beginning with `-` (`--search=--help`).
- `--` ends options: later arguments are positional, never help or JSON flags
  (`paqvilo init --name portal-project -- ./-portal`).
- Repeat an option only where help marks it repeatable (`--solution-root A --solution-root B`). Every command refuses
  a repeated single-value option with `--X may be given only once` ([argument errors](#argument-errors)).
- Relative `--config` paths resolve from the current directory (for `init [dir]`, from that project directory); export
  roots follow the catalogue rules ([configuration](configuration.md)). `--repo` or `PAQVILO_REPO` selects the portal
  checkout.
- `~`, `%USERPROFILE%` and `$HOME` expand only if your shell expands them.
- OneDrive folders work as ordinary paths. The CLI does not download online-only placeholders; make files available
  locally. Missing paths, a file where a directory is required and permission failures fail the command.

## Output and exit status

Human reports and help go to stdout; errors go to stderr. With `--json`, results and errors are JSON on stdout; progress
from long-running commands can still appear on stderr, so capture the streams separately. Report schemas are
command-specific. Check `$LASTEXITCODE` (PowerShell) or `$?` (POSIX) immediately: a parseable report alone is not
success.

```sh
node bin/paqvilo.mjs lense resources --config './My Portal/paqvilo.config.yml' --limit 100 --offset 0 --json > resources.json 2> resources-errors.log
node bin/paqvilo.mjs mirage preflight --project './My Portal/mirage.project.yml' --json > preflight.json 2> preflight-errors.log
```

| Commands                                                                                            | Output and exit status                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init`, `setup`, `doctor --setup`                                                                   | `--json` supported; failure 1. `init --check` and `--ready` return 1 for unfinished projects.                                                                                                  |
| Lense `list`, `map`, `status`, `doctor`, `audit`, `resources`, `verify`, `analyze`                  | `--json` supported; invocation, configuration and failed checks return 1, as do strict `audit`/`verify` failures and an interrupted `verify`.                                                  |
| `analyze`                                                                                           | Fails at `--fail-on` (default `error`) or on incomplete inspection; text reports head with READY, INCOMPLETE or ERROR. Doctor's default threshold is `none`.                                   |
| Lense `agent`                                                                                       | Always JSON, including errors; failure 1.                                                                                                                                                      |
| Lense `use`                                                                                         | Human report; writes the chosen site/environment to the catalogue folder's `.env`; without a catalogue it writes nothing; failure 1.                                                           |
| Lense `dev`, `model-driven dev`; Mirage `demo`, `dev`                                               | Long-running sessions; see command help for output and browser options.                                                                                                                        |
| Mirage `init`, `start`, `status`, `stop`                                                            | `--json` supported; failure 1. `start` returns once the runtime is ready and prints its stop command.                                                                                          |
| Mirage `inspect`                                                                                    | JSON report, with or without `--json`; failure 1.                                                                                                                                              |
| Mirage `preflight`                                                                                  | `--json` supported; 0 nothing blocking in scope, 1 blocking requirements, 2 invalid invocation or configuration.                                                                               |
| Mirage `data`                                                                                       | JSON report; failure 1.                                                                                                                                                                        |
| Mirage `serve`                                                                                      | JSON readiness report; `--json` also makes errors JSON. Progress on stderr. Failure 1.                                                                                                         |
| Mirage `render-sweep`, `portal-matrix`, `liquid-inventory`                                          | `--json` supported; strict findings 1, invocation/runtime errors 2.                                                                                                                            |
| Mirage `liquid-conformance`                                                                         | `--json` or `--markdown` (giving both is a usage error, exit 2); `--out FILE` writes the report and leaves stdout empty; invocation/runtime errors 2.                                          |
| Mirage `bootstrap-report`, `webapi-inventory`, `query-inventory`, `capture-shell`, `verify-storage` | `--json` supported; failure 1. `capture-shell --strict` also fails on unresolved captures.                                                                                                     |
| Mirage `trace`                                                                                      | `--json` prints `{ schemaVersion, ok, command, result }` (`watch`: one per line); a refused filter or setting exits 2, other failures 1. See [request tracing](../mirage/docs/tracing.md#cli). |
| Dataverse commands                                                                                  | Success reports are JSON. `--json` also sends failures to stdout, otherwise text on stderr. Failure 1; failed data comparisons/queries or non-ready alternate keys 2.                          |

### Argument errors

An unknown command or subcommand is one stderr line naming it and the valid choices, exit 1, also with `--help`
(`paqvilo`, `lense`, `lense model-driven`, `lense mirage`, `mirage`, `mirage data`, `mirage trace`,
`mirage baseline-suite`, `dataverse`):

```text
paqvilo: Unknown command "bogus". Choose lense, mirage, dataverse, analyze, init, setup or doctor. Run paqvilo --help for options.
```

With `--json`, an unknown command of `paqvilo`, `lense`, `mirage` or `dataverse` has the code `unknown_command`. An
unknown action of a command is an argument error with its family's code from the table below: `lense model-driven bogus`
is `invalid_argument`, `mirage data bogus` is `MIRAGE_FAILED` and `mirage trace bogus` is `InvalidArguments`.
`lense agent` answers an unknown action in JSON on stdout, like its other errors (`invalid_argument`, exit 1).

An unknown option fails in one line, also beside `--help`:
`paqvilo: Unknown option '--bogus'. Run with --help to see supported options.` (the prefix names the command, such as
`paqvilo mirage verify:`). An option of another action fails the same way (`--limit is not supported by list`), and so
does an option without its value (`Option '--config <value>' argument missing. Run with --help to see supported
options.`). The exit code is the command's argument-error code: 2 for `mirage preflight`, `render-sweep`,
`portal-matrix`, `liquid-inventory` and `liquid-conformance`, 1 for every other command.

In a command that accepts `--json`, the error is then JSON on stdout. An unknown option has the code
`unsupported_option` in every such command, and a missing catalogue (no `--config` and no `paqvilo.config.yml` in the
working directory, or a `--config` file that does not exist) has the code `CONFIG_NOT_FOUND`; `setup` instead opens the
workspace that creates that file. Other argument errors keep the code of their command family:

| Commands                                                                        | Code of other argument errors                                         |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Lense commands, Mirage lifecycle (`init`, `start`, `status`, `stop`), `analyze` | `invalid_argument`                                                    |
| `paqvilo init`, `setup`, `doctor --setup`                                       | `INIT_FAILED`, `SETUP_FAILED`, `SETUP_CHECK_FAILED`                   |
| `paqvilo dataverse <command>`                                                   | `DATAVERSE_COMMAND_FAILED`                                            |
| Direct Mirage commands and public tools                                         | `MIRAGE_FAILED`                                                       |
| A public Mirage tool's `--help` with an invalid argument beside it              | `INVALID_ARGUMENT`                                                    |
| `mirage trace`                                                                  | `InvalidArguments` ([request tracing](../mirage/docs/tracing.md#cli)) |

A repeated single-value option is `invalid_argument` in every command.

## Defaults and validation

- Lense settings resolve from explicit flags, shell `PAQVILO_*`, `.env`, `paqvilo.config.local.yml`, then the catalogue
  ([precedence](configuration.md#personal-settings-and-worktrees)). Empty option values are rejected rather than falling
  back to a default; an empty resource search means no filter.
- Argument mistakes are rejected before source reads or startup where the command can check them independently; Mirage
  `data --rows` and `--count` are checked even when the selected catalogue or project is missing.
- `resources`: 100 results at offset 0 by default; `--limit` is 1–500.
- Browser: Edge unless configuration overrides it. `--headed` and `--headless` conflict. `--debug-port` is 0–65535; 0
  turns debugging off.
- Ports: `setup` and `mirage demo` pick a free loopback port. Catalogue Mirage lifecycle commands and
  `mirage serve --config --site` use the site's `mirage.port`, else 8787; `--port 0` picks a free port.
  `--startup-timeout` defaults to 120000 ms (1000–600000).
- `mirage serve` is server-only; `mirage dev` owns a development browser. Direct Mirage source commands select a portal
  with `--portal` and `--project`; a plain `--source` directory has no portal choice.
- `data generate` takes `--pack` and `--count`; `data scaffold` does not. `data scaffold` generates rows only for tables
  whose Solution metadata it finds (the rest are listed in `referencedWithoutMetadata`); `--rows 0` creates no ordinary
  rows, but persona rows required by exported web roles are still created.
- `map` writes mapping reports unless `--no-write`. `list` may persist an ignored Solution-discovery cache and reports
  the files it wrote in JSON `writesFiles`.
- Which runtimes `mirage status` and `mirage stop` select:
  [Mirage in the Lense browser](../mirage/docs/toolkit-integration.md#which-runtimes-status-and-stop-select).
- Output files must not overwrite inputs: Dataverse `--out` reports, journals and archives must differ from the
  manifest, catalogue and connection files (including links to them); `liquid-conformance --out` from its suite and
  rules; and Dataverse `connect` needs separate registration and secret files, also with `--consume-secret-file`.
  Bootstrap reports, Liquid inventories and rendered HTML must be written outside portal and Solution source folders.
- `list` output and Dataverse connection inspection redact URL query values and fragments in what they print; stored
  settings are unchanged.
