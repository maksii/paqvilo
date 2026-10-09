# Paqvilo

Paqvilo is a Power Pages development toolkit with two workflows:

- **Lense** overlays local JavaScript, CSS, images and supported literal HTML edits in a dedicated browser on your live portal. It inspects source mappings, resources and browser sessions.
- **Mirage** renders exported portal sources on loopback with Liquid, simulated Dataverse and a local administration workspace at `/_sim/`. Its browser panel includes **Inspect** and **Tweaks**.

`paqvilo lense` and `paqvilo mirage` share configuration and browser integration. Portal exports, business data, project presets and acceptance tests belong in your own project. Paqvilo ships no organisation-specific catalogue or data pack.

## Install

Requires Node.js 22 or later (24 LTS recommended), Git, and Edge, Chrome or Playwright Chromium.

```sh
# From a source checkout:
npm run setup
node bin/paqvilo.mjs --help

# Install a reviewed local distribution into your portal project:
npm install /path/to/paqvilo
npx paqvilo --help
```

The source checkout's setup installs both locked dependency sets without lifecycle scripts. The distributable declares all runtime dependencies, so a normal project installation can run both products. Nothing is published to npm by installing locally.

## Connect your portal

Copy [paqvilo.config.yml](paqvilo.config.yml) to your portal project. Change `sourceRoot`, the site's `source` and environment URLs to your exported sources and references. Paths are resolved relative to the catalogue; `--repo` overrides the checkout root. Standard, enhanced and code-site exports are supported. Unpacked Dataverse Solutions can be listed in `mirage.solutionRoots`.

```sh
npx paqvilo lense list --config ./paqvilo.config.yml --json
npx paqvilo lense doctor --config ./paqvilo.config.yml --all --json
npx paqvilo lense dev --config ./paqvilo.config.yml --site portal --env dev
npx paqvilo mirage init --config ./paqvilo.config.yml --site portal
npx paqvilo mirage dev --config ./paqvilo.config.yml --site portal
```

From the Paqvilo checkout replace `npx paqvilo` with `node bin/paqvilo.mjs` or use `npm run lense -- …` and `npm run mirage -- …`.

Lense saves refresh relevant pages; **Online / Local** compares sources and **Alt+Shift+P** opens the panel. The default HEAD baseline is captured when a target activates. Select an actual deployed Git ref explicitly for deployment comparisons. Sign in through the portal's own sign-in action using your intended work account; SSO may complete automatically.

Mirage starts with exported configuration and empty business tables. Generate deterministic rows from Solution metadata or add a project-owned [data pack](mirage/docs/data-packs.md). Portal requests remain anonymous until this browser signs in as a local persona; each runtime has its own session cookie. **Inspect** shows the page's templates, forms, tables, columns, permissions, snippets and settings. **Tweaks** controls local identity, permission enforcement and scenarios.

```sh
npx paqvilo mirage data scaffold --config ./paqvilo.config.yml --site portal --profile smoke --state .paqvilo/state.json
npx paqvilo mirage status --json
npx paqvilo mirage stop --config ./paqvilo.config.yml --site portal
```

Several portals can share a catalogue with `portals: all`; each Mirage runtime uses its own port and state. `--portals selected` limits a session to the selected site. [Configuration](docs/configuration.md) covers multi-source projects and personal settings.

## Keep your project separate

Use [the project starter](examples/project/README.md) for an exported synthetic portal, an external data pack and a project-owned test. Register modules explicitly in `mirage.dataPacks` or a Mirage project's `dataPacks`. Packs contain your personas, business rules, generators and acceptance scenarios. Core validation never runs your project tests or accesses your portal.

See [project extensions and tests](docs/project-extensions.md), [architecture](docs/architecture.md), [Lense](docs/lense.md), and [Mirage documentation](mirage/docs/README.md). [Migration](docs/migration.md) explains the command, configuration and state naming changes.

## Scope and evidence

Lense changes local browser responses; Liquid, permissions and Dataverse still execute online. Browser actions can affect live data and require task-specific authorization. Mirage binds to loopback and defaults to local providers; reference reads and cached platform assets are separate explicit operations. No command authorizes deployment, PAC, source synchronization or live writes. The explicit live-write flag remains opt-in.

An export inventory or local rendering does not prove parity. Use recorded comparisons and inspect diagnostics, skipped checks and runtime errors. Keep browser storage, agent discovery files (which contain bearer tokens), state and business evidence under ignored `.paqvilo/`. Legacy state remains ignored during migration.

## Develop and distribute

```sh
npm run validate
npm run release:check
npm pack --ignore-scripts
```

Tests use synthetic loopback fixtures without a portal account. The release check rejects private project content and verifies packaged files, documentation and editor tasks. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Paqvilo's original code is licensed under [GNU AGPLv3](LICENSE) (AGPL-3.0-only). Commercial use and selling copies are permitted; distribution must preserve notices and provide corresponding source, and modified versions used over a network must offer their corresponding source to interacting users. Private development does not require publishing every internal change. Using Paqvilo to inspect or render independent portal sources does not by itself relicense those sources. See the license for the precise conditions on combined works. Third-party assets retain their own licenses and notices in [NOTICE](NOTICE).
