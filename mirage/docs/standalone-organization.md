# Apps and APIs without a portal

Mirage can run Power Pages, solution-based model-driven apps, or an organization API without a Power Pages export. A model-driven runtime and an API listener share one organization, record pipeline and security model. An API-only runtime has no portal renderer or app shell.

Create `mirage.project.yml` in your project:

```yaml
version: 2
runtime:
  kind: model-driven
simulation:
  level: dry-run
solutions:
  - id: core
    path: ./solutions/Core
dataPacks:
  - id: fixtures
    module: ./pack/pack.mjs
dataverse:
  enabled: true
  port: 0
  tls: false
```

Select existing exported Solution folders and explicitly trusted pack modules. Remove `dataPacks` if none are needed. Solutions supply table, relationship, form, view and app definitions; packs supply your local data and trusted handlers. To run supported form JavaScript, command actions and standard field PCF controls, explicitly enable [trusted Solution extensions](model-driven-customizations.md). No `portals`, website record, portal origin or live reference is required.

```sh
npx --no-install paqvilo mirage inspect --project ./mirage.project.yml --json
npx --no-install paqvilo mirage serve --project ./mirage.project.yml --port 0
```

Inspect reports imported applications, tables and diagnostics. Serve prints the loopback workspace and API addresses. Open the reported `adminUrl`, then **Project setup** for configuration. Stop a foreground runtime with Ctrl+C. Use the same project file for [background lifecycle commands](../README.md#pick-the-session-that-fits):

```sh
npx --no-install paqvilo mirage dev --project ./mirage.project.yml
npx --no-install paqvilo mirage start --project ./mirage.project.yml --json
npx --no-install paqvilo mirage status --project ./mirage.project.yml --json
npx --no-install paqvilo mirage stop --project ./mirage.project.yml
```

`dev` opens a dedicated local browser; it does not attach a live portal or apply source overlays to a deployed page. An API-only browser opens Administration. Reusing a background runtime preserves its ownership when the development browser closes.

## Choose a surface

| `runtime.kind` | Available surfaces |
| --- | --- |
| `power-pages` | Portal rendering, portal visitor personas, model-driven apps and optional organization HTTP API |
| `model-driven` | Imported model-driven apps and optional organization HTTP API; no portal rendering |
| `dataverse-api` | Organization HTTP API and local administration; no portal rendering or app shell |

For API only, set `runtime.kind: dataverse-api`. The HTTP API is enabled by default for that profile; explicitly disabling it is rejected. For model-driven apps without an external API listener, use `runtime.kind: model-driven` and `dataverse.enabled: false`. The shared organization core still handles the app's records and staff security. `runtime.defaultApp` can select an imported application's GUID for a model-driven surface; omit it to use the available default. The Power Pages Management provider is available on Power Pages runtimes and derives its records from the selected export.

## Configure through the browser

1. Open `/_setup/` and choose the runtime surface, imported default app, simulation level, Solution folders and explicitly trusted packs. Existing configurations keep their omitted simulation setting until you change it. New guided configurations select dry run.
2. Start or restart Mirage. Configuration saves do not change a running level, switch its source or flush in-memory edits. Administration shows the effective surface, persistence level and exact pack DATA targets.
3. Open **Organization identity & API** in `/_sim/`. Create staff users with explicit roles, then select a staff session for model-driven testing. Register a separate application for an integration client. Copy a generated client secret when it is shown once; subsequent reads contain its hint only. Certificates and federation accept public material. Use local simulated credentials; no live Entra identity or credentials are imported.
4. Open **Model-driven apps** when that surface is enabled. The top-right profile avatar opens the staff selector and displays roles. Staff roles, row ownership and field security apply to reads, lookups and writes. **Local administrator** is an explicit development bypass. A disabled, deleted or expired staff session fails; select a valid identity or explicitly reset it. Inspect the effective persistence level and target files in Administration.
5. For API clients, copy the reported organization URL, authority and scope from Administration. Obtain an access token for the registered application and use the [SDK setup](dataverse-api.md#connect-an-sdk). API tokens, model-driven staff cookies and portal visitor cookies are separate identities.

Dry run permits in-memory record edits and disables schema changes. Simulation writes existing records to declared pack DATA files. Deep simulation also permits schema changes at declared schema/new-table destinations. Tables without a DATA owner remain read-only in file-backed modes. Control-plane identity settings and hashed credentials stay private, outside pack DATA. Read the complete [simulation level contract](simulation-levels.md) before enabling file-backed writes.

Administration links follow the runtime's capabilities. API-only profiles offer no portal or model-driven links; standalone profiles offer no portal personas, live-reference bridge or page-render controls. `GET /_sim/api/status` exposes `runtime`, `capabilities`, `links` and `simulation`; `GET /_sim/api/simulation` reports persistence destinations and readiness. These are local control-plane endpoints protected against cross-origin mutations.

## Validate your project

Keep organization data, captured metadata, connection details, scenarios and acceptance tests in your separate project. Use invented fixtures for reusable toolkit tests. Verify the specific app navigation, form/view/control support, identities, reads and mutations your integration needs. A discovered operation or imported app is not proof of complete platform parity. See [model-driven limits](model-driven-apps.md), [API evidence](dataverse-parity-suite.md) and [project extensions](../../docs/project-extensions.md).
