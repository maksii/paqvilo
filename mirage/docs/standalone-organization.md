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

## Shared composition

Both hosts (the Power Pages simulator and this standalone runtime) compose the organization through `composeOrganizationHost` in `mirage/lib/organization-host.mjs`. It owns the pack handler maps, the operation and plug-in catalogues (memoised on the committed store revision and the loaded sources), the providers object (`api.providers`: storage router, message buses, outbox, connector runtime, secret resolver when `secrets` is configured, service fixtures, Power Fx evaluator and the declared local services; pack provider factories are called once), the organization runtime, its backend, the Dataverse API with managed identity, and one close order: backend, flow run timers, organization, API, managed identity, then the instantiated providers. Selecting `clr` for a plug-in step through `PATCH /_sim/api/config` prepares the step's trusted CLR runtime before the choice is stored; a runtime that cannot be prepared refuses the change. The organization api also carries `api.packs` and `api.packExport(name)`. Repeated `*_NOT_SIMULATED` diagnostics from one extension install are reported once per code, with the tables they name.

Every request runs in one request context (`mirage/lib/request-context.mjs`). A Web API or portal request's `x-ms-correlation-request-id` (a plain token up to 128 characters), or else its own id, becomes the context's `correlationId`. Committed events carry it as `correlationId`, beside their chain, and the plug-in web hooks, asynchronous jobs and row-triggered flows they start report it. `createSimulator` accepts `clock`, `ids` and `scheduler` (see `fixedClock`, `sequentialIds` and `createScheduler` in `paqvilo/mirage/testing`) for both hosts. The local identity provider and the portal sign-in consumer share this clock: tokens, codes, nonces, state and the external sign-in cookie are issued and validated on it, so a fixed clock far from wall time signs in.

The standalone runtime loads `deploymentProfiles` as the Power Pages host does: the default profile (or the pin saved in state) supplies environment variable values and connection reference bindings to the Solution data, the preflight source graph and `GET /_sim/api/environment` (`profileSelection`). Selecting a profile through `PUT /_sim/api/environment/profiles` is a Power Pages host feature and answers 501 here. A source reload (`reload()` or the watcher) re-registers custom APIs, duplicate rules, classic workflow definitions and activations and plug-in registrations from the reloaded Solution in the same transaction as the Solution data, so a reload equals a restart: a definition gone from the sources is deactivated and removed. `SOURCE_EXTENSIONS_REFRESHED` lists the added, changed and removed rows per table. A reload that fails keeps the previous registrations. A reload whose Solution scan reports an error that the last accepted scan did not have (for example `SOLUTION_ROOT_READ_FAILED` for a root renamed or unreadable during a checkout, or `SOLUTION_XML_INVALID`) is rejected before anything changes: `reload()` rejects with `SOURCE_RELOAD_REJECTED` (status 409), its `details.diagnostics` list the new errors, and registrations, Solution data and metadata stay as they were. The watcher reports the rejection as `RELOAD_FAILED`. An error already present at startup does not block later reloads; the next reload after the source is repaired succeeds.

Status (`GET /_sim/api/status`) adds `inventory` (Solution inventory counts per component and level), `providers` (provider descriptors, never a value or secret) and `services` (service fixture records).

## Choose a surface

| `runtime.kind`  | Available surfaces                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------- |
| `power-pages`   | Portal rendering, portal visitor personas, model-driven apps and optional organization HTTP API |
| `model-driven`  | Imported model-driven apps and optional organization HTTP API; no portal rendering              |
| `dataverse-api` | Organization HTTP API and local administration; no portal rendering or app shell                |

For API only, set `runtime.kind: dataverse-api`. The HTTP API is enabled by default for that profile; explicitly disabling it is rejected. For model-driven apps without an external API listener, use `runtime.kind: model-driven` and `dataverse.enabled: false`. The shared organization core still handles the app's records and staff security. `runtime.defaultApp` can select an imported application's GUID for a model-driven surface; omit it to use the available default. The Mirage Site Manager provider is available on Power Pages runtimes and derives its records from the selected export.

Standalone projects accept a root `platform` block, for example
`{ QueryLinkEntityLimit: 50, evidence: "Invented approved organization setting" }`.
Settings and evidence are validated before startup and compose the same organization
store as programmatic `platform` options. `GET /_sim/api/platform-settings`, runtime
status and configuration expose effective values and origins. Local instance
overrides use `PATCH /_sim/api/platform-settings`; delete a named override to return
to the project value. The organization HTTP listener also composes the documented
`dataverse.managedIdentity.mode` adapters (`appservice`, `imds`, `arc`) on both
standalone profiles. With that listener disabled, administration reports the
managed identity adapter disabled. App Service secret headers are revealed only
on the first identity administration read; routine status never discloses them.

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
