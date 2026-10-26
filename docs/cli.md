# Command-line usage

Run `npx --no-install paqvilo --help` for command families, then append `--help` to
the command you need. Help and version output require no configuration. Running
`paqvilo`, `paqvilo lense`, `paqvilo mirage` or `paqvilo dataverse` without a command
prints help and exits successfully. An unknown command fails, including when
combined with `--help`.

For scripts in a toolkit checkout, use `node bin/paqvilo.mjs` instead of `npx`.
`npm run` adds a preamble to stdout, so avoid it when parsing JSON.

## Paths and quoting

Quote each path or value containing spaces or shell punctuation. Paths retain
Unicode, including Cyrillic. Package, site and pack identifiers have their own
validation: a Unicode or spaced project directory needs an explicit package slug.

PowerShell:

```powershell
npx --no-install paqvilo init 'C:\Users\example\OneDrive - Example\Проєкт' --name portal-project
npx --no-install paqvilo lense resources --config 'C:\Projects\My Portal\paqvilo.config.yml' --search 'Header & Footer' --json
npx --no-install paqvilo lense list --config 'C:\Projects\My Portal\paqvilo.config.yml' --repo 'D:\Exports\Портал' --json
```

Linux shell:

```sh
npx --no-install paqvilo init './Мій проєкт' --name portal-project
npx --no-install paqvilo lense resources --config './My Portal/paqvilo.config.yml' --search 'Header & Footer' --json
npx --no-install paqvilo lense list --config './My Portal/paqvilo.config.yml' --repo '/home/example/Exports/Портал' --json
```

In PowerShell single quotes preserve `$`, `&` and spaces; double an embedded
apostrophe, for example `'C:\Projects\O''Brien'`. In a POSIX shell, single quotes
also preserve shell punctuation; an embedded apostrophe can be written as
`'./O'"'"'Brien'`. Command Prompt uses double quotes around paths, and has different
expansion rules from PowerShell. Use the examples for your shell.

Options that take strings accept `--option=value`, which is also how to supply a
value beginning with `-`, for example `--search=--help`. Use `--` before positional
directory names that begin with `-`: `paqvilo init --name portal-project -- ./-portal`.
Flags after `--` are positional values; they do not request help or JSON output.
Use repeated options only where help marks them repeatable, such as
`--solution-root DIR --solution-root OTHER_DIR`.

Relative catalogue paths resolve from the current working directory. Export roots
follow the catalogue/project rules; use `--repo` or `PAQVILO_REPO` to select the
portal checkout. See [project extensions](project-extensions.md) and
[configuration](configuration.md). `~`, `%USERPROFILE%` and `$HOME` expand only when
your shell expands them; Paqvilo does not perform a second shell expansion.

OneDrive-style directory names work as ordinary local paths. The CLI does not
download online-only placeholders or change OneDrive availability or permissions.
Make required files available locally. Missing paths, a file where a directory is
required, and permission failures produce a failed command. Grant access or choose
a writable output directory; do not assume that changing the working directory
changes a configured source root.

## Output and exit status

Human reports and successful help go to stdout; command errors go to stderr.
Commands supporting `--json` emit JSON results and errors. For example,
`liquid-conformance --json --out FILE` writes a successful report to that file
and leaves stdout empty; without `--out`, its report goes to stdout. Progress for
long-running commands may still appear on stderr. Capture the two streams
separately. Data reports retain command-specific schemas; do not assume every
command returns the same fields.

| Commands                                                                                            | Output and failure status                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init`, `setup`, `doctor --setup`                                                                   | `--json` supported; ordinary failure is 1. `init --check` and `--ready` return 1 for unfinished projects.                                                                                             |
| Lense `list`, `map`, `status`, `doctor`, `audit`, `resources`, `verify`                             | `--json` supported; invocation, configuration and failed checks return 1. Strict audit/verify failures also return 1.                                                                                 |
| Lense `agent`                                                                                       | Always JSON, including errors; failure is 1. Session discovery and browser page IDs come from the running session.                                                                                    |
| Lense `use`                                                                                         | Human report; writes the chosen site/environment to `.env`; failure is 1. Supply positional selectors or named selectors without duplicating the same selector.                                       |
| Lense `dev`, `model-driven dev`; Mirage `dev`, `start`                                              | Long-running/session workflows; use command help for supported output and browser options.                                                                                                            |
| Mirage `inspect`, lifecycle `init/status/stop/inspect`                                              | `--json` supported; ordinary failure is 1. Lifecycle operations use catalogue/project selection.                                                                                                      |
| Mirage `preflight`                                                                                  | `--json` supported; 0 means nothing blocking in scope, 1 means blocking requirements, 2 means invalid invocation or configuration.                                                                    |
| Mirage `data`                                                                                       | JSON report; generation/scaffold options are specific to the data action. Ordinary failure is 1.                                                                                                      |
| Mirage `serve`                                                                                      | JSON readiness report; `--json` also selects JSON errors. Progress goes to stderr. Ordinary failure is 1.                                                                                             |
| Mirage `render-sweep`, `portal-matrix`, `liquid-inventory`                                          | `--json` supported; strict findings return 1, invocation/runtime errors return 2.                                                                                                                     |
| Mirage `liquid-conformance`                                                                         | JSON with `--json`, Markdown with `--markdown`; invocation/runtime errors return 2. These output flags are mutually exclusive.                                                                        |
| Mirage `bootstrap-report`, `webapi-inventory`, `query-inventory`, `capture-shell`, `verify-storage` | `--json` supported; ordinary failure is 1. `capture-shell --strict` also fails on unresolved captures.                                                                                                |
| Dataverse commands                                                                                  | Success reports are JSON. `--json` also sends failures to stdout; otherwise failures are text on stderr. Ordinary failure is 1; failed data comparisons/queries or non-ready alternate keys return 2. |

For example, capture a report without mixing in diagnostic output:

```sh
node bin/paqvilo.mjs lense resources --config './My Portal/paqvilo.config.yml' --limit 100 --offset 0 --json > resources.json 2> resources-errors.log
node bin/paqvilo.mjs mirage preflight --project './My Portal/mirage.project.yml' --json > preflight.json 2> preflight-errors.log
```

Check `$LASTEXITCODE` immediately in PowerShell, or `$?` immediately in a POSIX
shell. A parseable JSON report alone does not establish success.

## Defaults and validation

- `doctor --setup` is the dependency/browser readiness check. `lense doctor`
  checks a configured catalogue and exports. `doctor` alone fails with guidance.
- Lense configuration uses explicit flags, shell settings, `.env`, then catalogue
  defaults. See [Lense](lense.md). Empty option values are rejected rather than
  silently selecting a default; an empty resource search means no filter.
- `resources` defaults to 100 results at offset 0; its limit is 1–500.
- Browser selection defaults to Edge unless configuration overrides it. `--headed`
  and `--headless` conflict. `--debug-port 0` disables debugging; valid explicit
  ports are 0–65535.
- `setup` uses a free loopback port by default. `mirage demo` also chooses a free
  port. Catalogue Mirage lifecycle commands use the configured port, otherwise
  8787; `--port 0` selects a free port. A startup timeout defaults to 120000 ms.
- `mirage serve` is the server-only workflow; `mirage dev` owns a development
  browser. A bare `mirage` prints help. Use `--project`, a configured catalogue,
  or `--source` as shown by command help.
- `map` normally writes mapping reports; `--no-write` suppresses those writes.
  List may persist an ignored Solution-discovery cache and reports successful
  cache writes in its JSON `writesFiles` field.
- `mirage status --project FILE --json` can discover owned sessions even after
  that project file is removed. The path still selects its ownership directory.
- Direct Mirage source commands use `--portal` with `--project`; it cannot select
  a portal from a plain `--source` directory. Data-generation flags such as
  `--pack` and `--count` belong to `data generate`, rather than `data scaffold`.
- Dataverse `--out` reports, journals and archives must use a different file from
  the manifest, catalogue and connection inputs, including existing file aliases.
  For example, use `dataverse plan --manifest './schema.json' --out './.paqvilo/schema-plan.json'`.
- List output and Dataverse connection inspection redact URL query values and
  fragments. Redaction affects displayed output and preserves stored settings.
- Argument mistakes are rejected before source reads or startup where the command
  can validate them independently. Unknown options and options belonging to
  another action fail rather than being silently ignored.

## Command coverage

The CLI audit checks public dispatch/help for every command, all Dataverse command
argument contracts, every registered Mirage tool's unknown-option rejection,
Lense action validation, JSON failure streams, and shell/path round trips. Tests
use invented exports, disposable directories and loopback services. Windows runs
PowerShell quoting tests; Linux runs POSIX-shell quoting and non-root file
permission tests. OneDrive tests use representative directory names, not a cloud
sync service. Functional suites cover runtime and browser behavior separately.

Live sign-in, actual PAC registration, online Dataverse writes and cloud-sync
recovery are not prerequisites of the CLI regressions. Follow the relevant
[Dataverse provisioning](dataverse-provisioning.md), [Lense](lense.md) or
[Mirage](../mirage/README.md) guide when those operations are needed.
