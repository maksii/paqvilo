# Mirage

![Mirage: a simulated portal shown as a solid page above its shifting reflection.](../docs/assets/mirage-visual.png)

Mirage is a local simulator. It serves Power Pages exports, solution-based model-driven apps and a simulated Dataverse
organization API on loopback addresses, with its own local data. Forms, lists, settings and permissions come from the
exported sources and Solution metadata; personas, datasets and project rules come from data packs that your project
registers explicitly.

Mirage does not deploy, upload, run PAC or contact a live environment unless you ask for an explicit reference read or
enable live writes. Local rendering covers selected platform contracts: see the [coverage matrix](../docs/coverage.md),
and claim parity only where replay cases built from recorded reference captures prove it
([test kinds](../docs/test-kinds.md)).

[Getting started](../docs/getting-started.md) | [Configuration](../docs/configuration.md) |
[Mirage reference](docs/README.md)

## Start a runtime

From your project, with a catalogue (`paqvilo.config.yml`):

```sh
npx --no-install paqvilo mirage init --config ./paqvilo.config.yml --site portal
npx --no-install paqvilo mirage dev --config ./paqvilo.config.yml --site portal
```

For apps or APIs without a Power Pages export, use a `mirage.project.yml` and `--project` instead; see
[standalone organization](docs/standalone-organization.md).

## Pick the session that fits

| Command          | What it does                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| `demo`           | Copies a populated, editable example and opens the development browser                         |
| `init`           | Writes a per-site runtime project from your catalogue                                          |
| `dev`            | Starts runtimes and opens the development browser; stops the runtimes it started when it ends  |
| `start`          | Starts owned runtimes in the background                                                        |
| `status`, `stop` | Inspects or stops background runtimes in the same project scope                                |
| `serve`          | Runs one foreground runtime without the development browser; stop with Ctrl+C                  |
| `inspect`        | Prints what the importer read from the sources (`--json`)                                      |
| `data`           | `data scaffold` and `data generate` write local datasets ([data packs](docs/data-packs.md))    |
| `preflight`      | Reports missing prerequisites for a scenario ([preflight](docs/capabilities-and-preflight.md)) |
| `trace`          | Reads the activity of a running runtime ([request tracing](docs/tracing.md))                   |

`paqvilo mirage --help` lists the other tools (render, inventories, parity and verification runners).

```sh
npx --no-install paqvilo mirage status --config ./paqvilo.config.yml --json
npx --no-install paqvilo mirage stop --config ./paqvilo.config.yml --site portal
npx --no-install paqvilo mirage serve --source ./portal-export --solution-root ./solutions/Core --port 0
```

Run lifecycle commands with the same catalogue or `--project` that started the session. A runtime that was already
running before `dev` keeps running when the browser closes. A multi-portal catalogue runs one runtime per site, each with
its own state and session cookie.

`start` prints a stop command. Copy it exactly: it keeps the project or catalogue selectors and runtime overrides (port,
state), and an encoded `node -e` form preserves characters the shell would otherwise interpret. A long command refers to
a payload file in the runtime's ownership state directory under ignored `.paqvilo/`; replay checks its size and digest
and fails if the file is missing or changed. Keep that directory under your own control. If a printed command no longer
works, run `status` with the same selectors and stop the runtime by its `--state` file and actual `--port` (port `0`
cannot identify an older session).

## Addresses and sign-in

A runtime prints its portal address, `adminUrl` (the `/_sim/` administration workspace) and, on the Power Pages host,
`appsUrl` (model-driven apps at `/main.aspx`). `/_sim/` on the portal address redirects to `adminUrl`. Each address is a
separate loopback origin; see [simulation administration](docs/sim-administration.md).

Portal requests are anonymous until a browser signs in locally: through the portal's sign-in page, Lense **Tweaks**,
`/_sim/`, `simulator.signIn()` or the [testing helpers](../docs/public-api.md#test-many-visitors-concurrently). The
session is a per-runtime cookie, so signing one browser in never signs another in. [Persona catalogues](docs/persona-catalog.md)
group test identities and isolated setups.

## Data and persistence

A new state holds the exported configuration and empty business tables. Generate rows with `mirage data scaffold`, or
supply your own scenarios in a [data pack](docs/data-packs.md). The [simulation level](docs/simulation-levels.md)
decides whether record edits stay in memory (`dry-run`) or are written to declared pack DATA files (`simulation`,
`deep`). Large states use streamed checkpoints; see [state storage](docs/state-storage.md).

## Debugger trailers

Mirage appends debugger metadata to exported scripts, stylesheets, inline scripts and model-driven client resources. Set
`mirage.sourceMaps: false` on a catalogue site, or `sourceMaps: false` in a Mirage project, to serve the original bytes
(applies on restart). The catalogue's top-level `sourceMaps` controls Lense overlays separately. Each listener accepts
only its own `Host` and the registered identity-provider reply origin, so a proxy in front of Mirage is not supported.

## Boundaries

`/_sim/` changes affect only local data, permissions, settings, scenarios and providers. Live reference reads and cached
assets are explicit operations with their own provenance. Live create, update and delete stay disabled unless both
`--allow-live-writes` and the `/_sim/` live-writes switch allow them; neither is authorization to change live data.
Project data, personas and tests belong in a separate project: see [project extensions](../docs/project-extensions.md)
and the [project starter](../examples/project/README.md).
