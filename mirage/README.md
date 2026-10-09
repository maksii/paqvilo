# Mirage

Mirage renders exported Power Pages on loopback with Liquid, simulated Dataverse, native forms/lists, local identities and `/_sim/` administration. It derives behavior from portal sources and Solution metadata; custom business data and rules are explicitly registered external packs.

```sh
paqvilo mirage init --config ./paqvilo.config.yml --site portal
paqvilo mirage dev --config ./paqvilo.config.yml --site portal
paqvilo mirage status --json
paqvilo mirage stop --config ./paqvilo.config.yml --site portal

# Direct foreground runtime without the Lense browser:
paqvilo mirage serve --source ./portal-export --solution-root ./solutions/Core --port 0
paqvilo mirage inspect --source ./portal-export --json
```

`init` writes a per-site multi-source project file. `dev` starts owned runtime processes and the integrated browser, stopping the runtimes when the browser closes. `start` runs the owned runtimes in the background; `status` and `stop` manage those sessions. A direct `serve` process stops with Ctrl+C. Multi-portal catalogues support one runtime per site and selector navigation.

New states contain exported configuration and empty business tables. Use `data scaffold` for deterministic metadata-shaped rows or register your project's pack/preset. The portal is anonymous until a local browser signs in; identity comes from a per-runtime cookie. The `_sim` session and Lense Tweaks control only that browser's identity. Tests use the public [session helpers](testing/session.mjs).

Local `_sim` changes affect simulated data, permissions, settings, scenarios and runtime providers. Live-reference reads and cached assets are explicit operations with separate provenance. Live writes remain disabled unless the runtime flag and administration switch both permit them; neither is authorization to perform a business operation.

See [documentation](docs/README.md), [project extension guidance](../docs/project-extensions.md), and [migration](MIGRATION.md). Local rendering is a simulation; claim parity only for recorded reference comparisons.
