# Scaffold a consumer project

`paqvilo init` creates an empty project for your own portal exports, catalogue, data packs and tests. `paqvilo mirage init` creates a local runtime project for an existing catalogue. `paqvilo mirage demo` copies the populated example. These are separate workflows.

```sh
npx paqvilo@^0.9.8 init ./my-portals --name my-portals --site customer --site partner
cd my-portals
npm run setup
npm run configure
npm run editor:refresh
npm run check:scaffold
npm run check:project
```

Generation performs no installation, network access or browser launch. It creates no sources, runtime state, `.env`, lockfile or `node_modules`. `setup` runs consumer dependency preparation: first install creates the lockfile; subsequent checkouts use `npm ci --ignore-scripts`, stop on mismatch and never fall back to fresh resolution. Commit the lockfile and retain the npm configuration that created it. Tool/browser readiness follows the effective catalogue browser; explicit `doctor --setup --browser` overrides it. Configure before refreshing editor files. Configuration saves apply at the next preview start; restart only owned previews.

## Options

| Option                | Default                | Use                                                                                      |
| --------------------- | ---------------------- | ---------------------------------------------------------------------------------------- |
| `[dir]`               | `.`                    | New or empty target directory                                                            |
| `--name`              | Target basename        | Lowercase package slug; also the default pack ID                                         |
| `--site` (repeatable) | `portal`               | Site IDs; ports start at 8787 and increment                                              |
| `--default-env`       | `dev`                  | Placeholder environment per site                                                         |
| `--source-root`       | `./sources`            | Portal/Solution checkout root                                                            |
| `--pack` (repeatable) | Project name           | One pack uses `pack/`; several use `packs/<id>/`                                         |
| `--no-pack`           | Off                    | Omit pack modules/source-free binding; retain optional site-bound helper and smoke tests |
| `--browser`           | `msedge`               | `msedge`, `chrome` or `chromium`; Chrome debugger for the latter two                     |
| `--toolkit`           | `^<installed-version>` | Dependency spec, including `file:../paqvilo`                                             |
| `--no-vscode`         | Off                    | Omit tasks, launches, workspace and setup refresh                                        |
| `--into-existing`     | Off                    | Add missing files only and report every skipped file                                     |
| `--interactive`       | Off                    | Choose the browser through the terminal picker                                           |
| `--json`              | Off                    | Machine-readable schemaVersion 1 reports                                                 |

Names, site IDs, environment IDs and pack IDs use lowercase letters, digits and hyphens, start with a letter or digit, and are at most 64 characters. Reserved object/Windows device names and duplicate IDs are rejected. `--name` is required when the target basename does not follow these rules. This narrower scaffold convention keeps paths, scripts and task labels portable; existing catalogues still support the broader configuration identifier contract. Sites named `pick` or `debug` use `dev:site:<id>:dev` and `mirage:dev:site:<id>:dev` shortcuts, preserving the project-wide picker/debugger commands.

The command refuses nonempty targets without `--into-existing` and rejects symbolic links/junctions in output paths. It never replaces existing files. Into-existing mode does not merge an existing package or catalogue: inspect skipped files and reconcile those values yourself.

## Completion checks

`paqvilo init --check [dir] [--config file] [--json]` reads the project without importing pack JavaScript. It lists `TODO(paqvilo-init):` markers with file/line, validates the catalogue and site/environment selections, and reports placeholder `.example.test` origins, missing pack modules, and missing source/Solution folders. Personal environment overrides cannot hide a shared placeholder URL. Missing source paths have warning severity because an external checkout may be absent, but any unfinished item still yields exit code 1. Resolve them in the checkout where you validate readiness. Removing a marker is an explicit project decision, including confirming that no Solution roots are needed.

In Git projects the scan includes tracked and untracked text files while respecting ignores, including when the index is empty. Outside Git it uses a directory scan. Files larger than 1 MiB, symlinks, dependency directories, private `.env`/local config, runtime state and legacy state are excluded. `.env.example` is included. Source diagnostics follow the same shell/`.env` overrides as development commands. The checker is a scaffold readiness check; it does not establish page coverage, pack matching or live parity. `lense doctor` provides a nonfatal reminder when a generated project still has markers.

## Configured-project readiness and adoption

`paqvilo init --ready [dir] [--config file] [--json]` (generated `check:project`)
composes completion, read-only integration/path checks and the existing all-site
doctor Sources/Mirage gate. It checks export/Solution layouts, pack/project files
and every mapped profile path, including nonselected profiles, without executing
pack code. Output contains diagnostic codes, status and paths, not deployment or
observed values. Doctor may probe ignored state/cache and loopback port availability;
it does not contact a portal. Initial `--check`/`configure` still work before cloning.
In a repository without commits, the markup baseline is skipped with a warning ("the
repository has no commits yet") instead of failing `lense doctor` and `init --ready`;
changed scope (`scope: changed`) still needs an existing commit.

Adoption diagnostics name missing dependency, script and private-ignore wiring.
Into-existing generation remains additive; generation success does not integrate an
unrelated package. Apply reconciliation deliberately and preserve custom commands.

`validate` remains a lightweight starter check. `validate:configured` adds project
readiness and strict browser validation: each currently configured site needs a
successful declared `acceptanceTest` case. Skipped and todo-marked cases and the starter HTTP
smoke do not count. This proves declared tests executed, not the quality of an
author's assertions. The generated optional acceptance recipe checks content and
authenticated/denied access, uses isolated state and blocks unexpected browser hosts.

## Editor refresh

```sh
npx --no-install paqvilo init --refresh-editor
npx --no-install paqvilo init --refresh-editor --workspace-only
```

Refresh uses effective configuration, including personal overrides and `PAQVILO_REPO`, to discover project/export/Solution and mapped deployment-file repositories. Real/nested paths are deduplicated without reading deployment values. Resolved folders stay in the ignored workspace; tracked tasks and launches use workspace-relative paths when both locations share a filesystem volume. Windows paths on different drives require absolute editor references: review those generated files before committing, or keep the catalogue and exports on the same drive. Keep configuration/evidence with the catalogue when selecting another export worktree.

Development tasks invoke the installed CLI with the resolved catalogue's sites and browser; refresh adds/removes these tasks when the catalogue changes. Other tasks invoke the project's npm scripts. Browser launches attach to the corresponding toolkit browser. Lense uses profile `lense` and debugger port 9222, Mirage uses `mirage` and 9223. Their background matcher comes from the toolkit's development-ready message. The generated `tools/test-browser.mjs` collects actual test files under the project's browser-test folders, so empty pack folders work on Windows too. Add fixtures before claiming successful browser coverage; only empty fixture folders skip. Nonempty exports use the runtime's importer, including enhanced and code-site layouts; invalid fixtures fail visibly.

Generated editor documents have a `paqvilo.scaffold` marker and content hash. Refresh replaces only untouched generated documents; edited files and alternatives remain protected. New npm development commands resolve their browser from configuration. Site additions/removals and older browser-pinned shortcuts produce explicit add/update/remove script proposals (`scriptChanges` in JSON); custom commands require manual review. Refresh never rewrites package.json. Apply intended proposals before the configured readiness gate, which diagnoses proven generated drift while treating custom differences as advisory.

Proposals target the catalogue selected for refresh. Paths containing shell interpolation or control characters require manual quoting; refresh reports the required review without generating an executable npm proposal for those paths.

Generated guides (`README.md`, `AGENTS.md`, `docs/workflows.md`, `docs/configuration.md`, `docs/data-lifecycle.md`,
`docs/acceptance.md` and each pack's `README.md`) link to the online docs of this repository's main branch; the installed
CLI's `--help` and `node_modules/paqvilo/docs/` match the installed version when they differ. `docs/configuration.example.yml`
is an optional two-site recipe: copy it to the project root before passing it as `--config`, so its relative paths use
that base. Templates live in `templates/project/`, separately from the demo in `examples/project/`, and contain no
customer data, personas, observations or deployed sources. See [project extensions](project-extensions.md),
[configuration](configuration.md) and [getting started](getting-started.md).
