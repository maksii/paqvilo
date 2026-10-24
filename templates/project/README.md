# {{name}}

This project owns portal sources, settings, data packs and acceptance tests. Paqvilo
provides live overlays and local simulation. Generation installs nothing and contacts
no portal. Complete marked choices before selecting a real environment.

## First checkout

Use Node **{{node}} or newer**, its npm CLI, Git on PATH and the catalogue's browser (Edge
by default). Install the browser separately; presence is not launch/OS readiness.
PAC, .NET and source build tools are not generally needed to consume exports;
project-specific plugin workflows can add them.

1. Run `npm run setup`. Without a lockfile it uses `npm install --ignore-scripts`;
   with one it uses `npm ci --ignore-scripts`. Commit the lockfile. A ci failure stops
   setup without a fresh-resolution fallback. Dependency preparation may access the
   registry/cache; dependency lifecycle scripts stay disabled.
2. Run `npm run configure` in the local configuration workspace. Missing clones do
   not prevent configuration. Select the personal layer for ignored overrides.
3. {{editorStep}} Settings apply on the next preview start; restart only your owned
   previews after reviewing the changes.
4. Resolve `npm run check:scaffold`, then run `npm run check:project`. The latter gates
   all sites' Sources/Mirage readiness and mapped paths without executing pack code.
   `npm run check:setup` separately checks tools and the effective browser.
5. Run `npm run mirage:init`, then `npm run mirage:dev` locally. `npm run dev` uses live
   overlays and requires authorization for the selected reference environment.
6. Run `npm run validate` for starter tests. Implement meaningful
   [acceptance cases](docs/acceptance.md), then use `npm run validate:configured` for
   configured-project/CI readiness. Empty/skipped smoke cases prove no page coverage.

## Where to change what

| Path                                  | Owns                                                        | Committed?       |
| ------------------------------------- | ----------------------------------------------------------- | ---------------- |
| `paqvilo.config.yml`                  | Shared sites, environments and paths                        | Yes              |
| `.env.example`                        | Personal settings template                                  | Yes              |
| `.env`, `paqvilo.config.local.yml`    | Worktree overrides                                          | No               |
| External export/Solution checkouts    | Source metadata                                             | Project decision |
| `support/mirage.mjs` when packs exist | Source-free pack unit binding                               | Yes              |
| `support/site.mjs`                    | Optional site-bound runner/attachment recipe                | Yes              |
| `pack/` or `packs/<id>/`              | Records, permissions, generators, rules, personas, matching | Yes              |
| `test-browser/`                       | Synthetic fixtures and acceptance cases                     | Yes              |
| `tools/`                              | Dependency bootstrap and test discovery/coverage reporting  | Yes              |
| `.vscode/` when enabled               | Tasks and debugger launches                                 | Yes              |
| `*.code-workspace`                    | Resolved checkout paths                                     | No               |
| `.paqvilo/`                           | State, logs, browser profiles and private evidence          | No               |

Generation registers each requested pack on each requested site, while new packs
match nothing. Review the ownership matrix and test intended and unrelated website
identities. Shared packs remain an explicit project choice.

## Repeatable setup and upgrades

The initial range is based on Paqvilo **{{version}}**. Your committed lockfile owns the
exact dependency graph. Later checkouts use setup or `npm ci --ignore-scripts` with
the same project npm configuration. Do not remove a lockfile merely to make ci pass.
For an intentional upgrade, run `npm install --save-dev paqvilo@<chosen-version> --ignore-scripts`,
review/commit manifest and lockfile, refresh/check the project and run both validation
levels. No nested toolkit dependency install is needed.

Use `node_modules/paqvilo/docs/` and `node_modules/paqvilo/mirage/docs/` as version-matched
guides. Online main-branch docs can describe newer behavior. Use
`npx --no-install paqvilo --version` and `--help` to identify the installed contract.

## Offline CI and boundaries

After committing a lockfile, a provider-neutral configured CI sequence is:

```sh
npm ci --ignore-scripts
npm run check:setup
npm run validate:configured
```

Prepare the selected browser and its OS dependencies in the runner. Use synthetic
export fixtures and block unexpected external requests in browser CI. Loopback
hosting alone does not make authored external assets offline. `confinePortalPages`
can block assets and change appearance; it does not replace browser network isolation.
Live reads, capture, PAC, sync and deployment remain separately selected/authorized.
Setup performs none of them. Keep tokens/discoveries in ignored `.paqvilo/` and stop
only owned sessions.

Into-existing generation adds files; it does not integrate an existing package or
catalogue. Inspect skipped files and `paqvilo init --ready` adoption findings, then
reconcile scripts/dependencies/configuration yourself. Generation success is not readiness.

See [workflows](docs/workflows.md), [configuration](docs/configuration.md),
[data lifecycle](docs/data-lifecycle.md), [acceptance](docs/acceptance.md), [AGENTS.md](AGENTS.md),
and the maintained [setup]({{docs}}docs/getting-started.md),
[configuration reference]({{docs}}docs/configuration.md) and [public API]({{docs}}docs/public-api.md).
