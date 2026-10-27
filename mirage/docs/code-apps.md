# Code apps

Mirage hosts a local bridge for Power Apps code apps under `/_apps/code/<name>/`. The bridge provides a Mirage adapter for the documented `getContext()` shape and selected Dataverse operations. It does not implement Microsoft's player or `pa app run` local-host protocol. Microsoft documents the host architecture and SDK APIs, but does not provide a supported public contract for replacing that host; private implementation symbols are not that contract. The bridge is at capability level `contract`. A connector operation without a simulation answers `501` and never reports success.

Modules: `mirage/lib/code-apps-config.mjs` (settings and the read-only `power.config.json` parser), `mirage/lib/code-apps-http.mjs` (HTTP handler) and `mirage/lib/code-apps-client.js` (browser shim).

Both hosts serve the bridge, before the model-driven handler, for the apps in the project `codeApps` setting. The selected staff user is the app's user. `token` issues a Dataverse token for the local Dataverse origin through the organization's authority, so it needs the Dataverse API (`dataverse.enabled`); without it `token` answers `501 DataverseApiDisabled`. `dataverse/*` runs the Web API call through the organization record pipeline as that user: reads in a read transaction, writes atomically. `connectors/<reference>/<operation>` prefers the project `connections` entry keyed by the reference key, then one keyed by the connector ID, and otherwise uses the connector's built-in provider, and reports a `501` when no local provider implements the operation (`ConnectorNotConfigured` or `ConnectorNotSimulated`, depending on the host). `capabilities.codeApps` is `contract`.

## Configuration

The project `codeApps` setting is an array, validated by `codeAppSettings(value, label)`:

| Field         | Required | Meaning                                                                                                                                   |
| ------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | yes      | URL segment, 1 to 64 letters, digits or hyphens. Must be unique, compared without case.                                                   |
| `dir`         | yes      | The app folder, relative to the project root.                                                                                             |
| `localAppUrl` | no       | The app's dev server, for example `http://localhost:3000`. Must be a loopback http(s) URL. It overrides the value in `power.config.json`. |
| `config`      | no       | The configuration file, relative to `dir`. The default is `power.config.json`.                                                            |
| `devServer`   | no       | Trusted local server command and options for `mirage dev`; see the managed workflow below.                                                |

`readCodeAppConfig(dir, file, { bindings })` reads `power.config.json` and **never writes it**. It returns `appId`, `environmentId`, `localAppUrl`, `connectionReferences` (normalised to `{ key, apiId, displayName, dataSources }`), `databaseReferences`, `appSettings` and derived `entitySets`. Entity-set mappings come from unambiguous exported data-source aliases and logical names. Fields it does not use stay in `raw`. It reports these diagnostics:

| Code                           | When                                                                                                |
| ------------------------------ | --------------------------------------------------------------------------------------------------- |
| `CODEAPP_CONFIG_MISSING`       | The file does not exist.                                                                            |
| `CODEAPP_CONFIG_INVALID`       | The file is not a JSON object, a field has the wrong type, or `localAppUrl` is not a loopback URL.  |
| `CODEAPP_CONNECTION_UNBOUND`   | A connection reference has no matching reference-key or connector-ID entry in `bindings`.           |
| `CODEAPP_DATASOURCE_AMBIGUOUS` | A data-source alias or logical name maps to multiple entity sets; the ambiguous mapping is omitted. |

`loadCodeApps` also reports `CODEAPP_LOCAL_URL_MISSING` when neither the project override nor the configuration supplies a valid local URL. Reference maps and the fields Mirage consumes are checked; this is not a complete Microsoft schema validator. Bindings are project `connections` objects keyed by the reference key or, as a fallback, the connector ID, with the matching `connector` and an explicitly configured simulated provider where needed. A binding does not prove that its provider implements every operation or grant access to an online connection.

`loadCodeApps(entries, projectRoot, { bindings })` builds the app records that the handler serves. `codeAppInventoryRecord(app)` returns the app's capability record: level `contract`, with its connection-reference dependencies and diagnostic codes.

## Endpoints

Every path below is relative to `/_apps/code/<name>/`. Every Dataverse and connector request, GET included, requires the `x-sim-csrf` header (some Dataverse functions are GET and write). `GET context` returns that token in its `x-sim-csrf` response header. Every response sends `cache-control: no-store` and `x-content-type-options: nosniff`.

`GET status` reports the simulation mode, `contract` level, local app URL, connection dependencies and configuration diagnostics without serving the raw config. It requires no staff selection so configuration can be debugged before sign-in. The loader displays the same configuration diagnostics; both hosts include them in their runtime diagnostic stream. The hosts reread `power.config.json` when serving app requests; the Vite plugin reloads the app after that file changes. Restart Mirage for changes to the project settings, registered apps, dev server commands or bindings.

| Endpoint                                    | Level               | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET context`                               | behaviour (mapping) | Returns `IContext` `{ app: { appId, appSettings, environmentId, queryParams, dataverseOrgUrl, appUrl }, user: { fullName, objectId, systemUserId, tenantId, userPrincipalName }, host: { sessionId } }`, built from the staff persona selected in `/_sim/`. Answers `401` when no persona is selected (local administrator) or the persona is unavailable. `appSettings` comes from the local app configuration (empty if absent); `queryParams` holds the query of the context request. `dataverseOrgUrl` is the local Dataverse origin. The browser adapter creates a session ID for each configuration; direct requests without a valid adapter session header use the host fallback ID. |
| `POST token` `{ resource }`                 | behaviour           | Returns `{ access_token, expires_on }` from the local authority. The resource must be the local Dataverse origin, optionally followed by `/` or `/.default`. Any other resource answers `400 InvalidResource` and reports a `CODEAPP_TOKEN_REFUSED` diagnostic. Token values are never logged.                                                                                                                                                                                                                                                                                                                                                                                              |
| `ANY dataverse/<path>`                      | behaviour           | Runs `/api/data/v9.2/<path>` in process as the staff principal. Forwards the method, query, JSON or binary body and the `accept`, `content-type`, `prefer`, `if-match`, `if-none-match` and `odata-*` version headers. Never uses the portal `/_api` contract.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `POST connectors/<reference>/<operationId>` | mock                | `<reference>` is a connection-reference key or data-source name from `power.config.json`. An unknown reference answers `404`. The injected connector hook answers the call. Without a hook, or when the hook returns `undefined`, it answers `501 ConnectorNotSimulated` and reports a `CODEAPP_CONNECTOR_NOT_SIMULATED` diagnostic. A host can instead report `501 ConnectorNotConfigured` for an unbound provider.                                                                                                                                                                                                                                                                        |
| `GET` (root)                                | mock                | A loader page. When `localAppUrl` is set, it frames that URL with `allow="local-network-access"` and forwards the query string, mirroring Local Play. The page uses the model-driven shell CSP plus `frame-src <localAppUrl origin>`. Without `localAppUrl`, the page explains that the setting is missing.                                                                                                                                                                                                                                                                                                                                                                                 |

An unknown app answers `404 CodeAppNotFound`. `/_apps/code/<name>` without a trailing slash redirects (`308`) to `/_apps/code/<name>/`.

Connector reference keys take precedence over data-source aliases. An alias shared by multiple references answers `409 ConnectionReferenceAmbiguous`; use the explicit reference key to select the intended local provider.

`createCodeAppsHandler({ apps, sessions, user, organization, issueToken, dataverse, connectors, csrf, diagnostic })` returns `async (req, res, url?) => boolean`. It returns `false` for any path outside `/_apps/code/`. `authorityTokenIssuer({ issueAccessToken, origin, appId })` adapts the Dataverse authority's `issueAccessToken` (`dataverse-auth.mjs`) to `issueToken`.

## Browser shim

`code-apps-client.js` exports `configure({ app, origin?, onEvent? })`, `getStatus()`, `getContext()`, `getToken(resource)` and `dataClient`. `dataClient` provides `create(entitySet, record)`, `get(entitySet, id, options)`, `getAll(entitySet, options)`, `update(entitySet, id, changes)`, `delete(entitySet, id)` and `execute(reference, operationId, parameters)`. Data methods resolve to `{ data }` and throw on errors. Microsoft generated services return a richer operation result, so this is not a complete substitute. Every call sends `credentials: 'same-origin'`, and every call sends the CSRF header once `context` has supplied it.

For a hand-built Mirage integration, import the Mirage adapter explicitly. The Vite plugin below configures the context and SDK data executor automatically for its development entry. Proxy `/_apps/code` to Mirage so the app and bridge share one browser origin. A Vite proxy needs `changeOrigin: true`, and must validate the incoming Host and Origin before forwarding an Origin rebased to the Mirage origin. The [example server](../../examples/project/code-app/server.mjs) shows these checks for a loopback-only server. Do not expose that development proxy to a network.

Call `configure({ app: '<name>' })` before the first call. Use the same host name (`localhost` or `127.0.0.1`) for the dev server and Mirage, so the browser sends the staff-session cookie.

An explicit `origin` must be an HTTP(S) root origin on the current browser origin, without credentials, a path, query or fragment. A trailing slash is normalized. Entity-set arguments must be Dataverse identifiers (a leading letter followed by letters, digits or underscores); use the SDK executor's `entitySets` mapping for generated source aliases.

Reconfiguration rejects pending results from the previous app configuration. A write already sent to the server cannot be rolled back by this check. Inspect the local records before manually repeating a write whose result was interrupted.

### Optional SDK data executor

Applications that retain generated SDK data services can install an explicit executor override for Mirage. Microsoft documents [`IDataOperationExecutor`](https://learn.microsoft.com/javascript/api/@microsoft/power-apps/idataoperationexecutor?view=powerapps-js-latest) and [`setDataOperationExecutor`](https://learn.microsoft.com/javascript/api/@microsoft/power-apps/?view=powerapps-js-latest). The setter is exported from the internal-named `@microsoft/power-apps/internal/data` subpath in SDK 1.5.0; pin and validate this integration when upgrading the SDK. The SDK remains an application dependency; Paqvilo does not bundle it.

```js
// Mirage-only application entry. Keep this registration out of the native build.
import { setDataOperationExecutor } from '@microsoft/power-apps/internal/data';
import { createCodeAppSdkExecutor } from 'paqvilo/mirage/code-apps';
import { configure, getContext } from 'paqvilo/mirage/lib/code-apps-client.js';

configure({ app: 'invented-items' });
setDataOperationExecutor(createCodeAppSdkExecutor({ entitySets: { Items: 'x_items' } }));
const context = await getContext();
// Generated data services can now call their real SDK getClient() methods.
```

`entitySets` explicitly maps generated source names to exported entity sets; omitted names pass through unchanged. The executor supports CRUD, query options accepted by the Mirage client, and explicit connector operations. It returns `{ success, data, error?, skipToken?, count? }` and preserves failed results, unlike the simpler throwing client. The executor also supports entity metadata selection and expansions, single-request file and image upload/download/delete (up to the 16 MiB bridge limit), and registered unbound custom actions and functions, plus `WhoAmI`. Other raw Dataverse requests, bound APIs and partitioned operations return unsupported failures. This override supplies data execution only. Without the Vite integration below, select the Mirage context import in the simulation entry; other Microsoft host services still require their native host.

The pinned SDK 1.5.0 development dependencies in the toolkit and example project and `baseline-code-app-sdk.test.mjs` exercise the actual SDK entry points, mapped CRUD, CSRF and connector success/failure through the loopback bridge. This is separate from the app's real browser/organization acceptance test and does not prove native player compatibility.

## SDK data executor coverage

| Operation                                                                          | Mirage behavior                                                                                                                     |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| CRUD and `select`, `filter`, `orderBy`, `top`, `count`, `skipToken`, `maxPageSize` | Simulated through the local Dataverse pipeline.                                                                                     |
| Entity metadata                                                                    | Scalar selection and column/relationship expansions.                                                                                |
| Connectors                                                                         | Configured simulated connector operations; missing operations fail explicitly.                                                      |
| Dataverse actions                                                                  | Registered unbound custom actions and functions, and `WhoAmI`.                                                                      |
| Files and images                                                                   | Single-request upload, download and delete; the bridge accepts bodies up to 16 MiB.                                                 |
| Other operations                                                                   | Bound actions and functions, partition IDs, `skip`, chunked uploads and the native host bridge are unsupported and fail explicitly. |

The SDK executor is tested locally; native browser host compatibility has not been established by these tests.

## Limits

- Mirage does not reproduce the player's own wire protocol with `@microsoft/power-apps`, or the `pa app run` host on port 8080.
- The simple client is not a drop-in SDK replacement. Retaining generated data services requires the explicit optional executor above; context and other host services remain separate.
- The client maps `select`, `filter`, `orderBy`, `top`, `count` and `skipToken` to OData query options; `maxPageSize` sets `Prefer: odata.maxpagesize`. `skip`, `expand`, `partitionId` and other unsupported options are rejected explicitly. Dataverse itself [does not support `$skip`](https://learn.microsoft.com/power-apps/developer/data-platform/webapi/query/page-results). Pagination uses the returned `skipToken`; the adapter does not fetch every page automatically.

Microsoft also documents a separate [Copilot Managed Runtime preview](https://learn.microsoft.com/microsoft-365/managed-apps/developer/ms-cli-command-reference?view=o365-worldwide), with an `ms` CLI and its own development workflow. Mirage does not implement or validate that preview. Its type declarations do not establish compatibility with the Power Apps Code Apps host.

Microsoft documentation: [overview](https://learn.microsoft.com/power-apps/developer/code-apps/overview), [architecture](https://learn.microsoft.com/power-apps/developer/code-apps/architecture), [get context](https://learn.microsoft.com/power-apps/developer/code-apps/how-to/retrieve-context), [connect to Dataverse](https://learn.microsoft.com/power-apps/developer/code-apps/how-to/connect-to-dataverse), [create an app](https://learn.microsoft.com/power-apps/developer/code-apps/how-to/create-an-app-from-scratch), [CLI](https://learn.microsoft.com/power-apps/developer/code-apps/reference/cli), [pac code](https://learn.microsoft.com/power-platform/developer/cli/reference/code).

## Develop SDK apps with Vite and the workbench

Install `paqvilo`, Vite and `@microsoft/power-apps` in each app project. For Microsoft's React/Vite template, keep its React plugin and select one Power Apps integration at a time:

```js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { powerApps } from '@microsoft/power-apps-vite/plugin';
import { codeApps } from 'paqvilo/mirage/code-apps/vite';

export default defineConfig(({ command, mode }) => {
  const mirage = command === 'serve' && (mode === 'mirage' || Boolean(process.env.PAQVILO_MIRAGE_URL));
  return { plugins: [react(), mirage ? codeApps() : powerApps()] };
});
```

This selects Microsoft's plugin for native serving and builds, and the Mirage plugin for managed local serving. Do not activate both plugins in the same Vite server. For independent local serving, use `vite --mode mirage` and supply the app name and Mirage origin through explicit `codeApps` options or the corresponding environment variables.

For an app started by `mirage dev`, the plugin reads its registered name and local Mirage origin from `PAQVILO_CODE_APP` and `PAQVILO_MIRAGE_URL`. It runs only during Vite serving when this environment is present, when Vite mode is `mirage`, or when explicitly enabled. For an independently started server, supply `codeApps({ app: 'alpha', mirageUrl: 'http://127.0.0.1:8787', enabled: true })`. Bind the dev server to loopback. The plugin installs Mirage context and data adapters for local development: app code can keep `getContext` from `@microsoft/power-apps/app` and generated services using SDK `getClient`. The app's `power.config.json` supplies the data source mappings used by the local executor. Production builds keep the native SDK path; they do not include the Mirage bootstrap.

A standalone `mirage.project.yml` can register several apps, each with its own fixed app port and a trusted explicit command:

```yaml
version: 2
runtime: { kind: dataverse-api }
simulation: { level: dry-run }
dataverse: { enabled: true }
solutions:
  - { id: sample, path: ./solution }
codeApps:
  - name: alpha
    dir: apps/alpha
    localAppUrl: http://127.0.0.1:5199/
    devServer:
      command: [node, node_modules/vite/bin/vite.js, --host, 127.0.0.1, --port, '5199', --strictPort]
  - name: beta
    dir: apps/beta
    localAppUrl: http://127.0.0.1:5200/
    devServer:
      command: [node, node_modules/vite/bin/vite.js, --host, 127.0.0.1, --port, '5200', --strictPort]
```

Run `paqvilo mirage dev --project ./mirage.project.yml --port 0 --debug-port 9222`. The owned runtime starts first, then each declared dev server; the existing dedicated browser opens `/_apps/code/`. The workbench lists the registered apps and lets you select one, set query parameters, reload it, inspect bridge activity and open local administration. Select an invented staff user in `/_sim/` before invoking context or data operations. The runtime's actual origin is supplied to owned dev servers, even when `--port 0` chooses a port. Each app's own URL must have a known port. If a configured URL already answers successfully, Mirage reuses that listener without taking ownership; entries without `devServer` are externally managed. Closing the owned browser or stopping the dev command closes servers started by that command and its owned runtime; reused servers and runtimes remain running. An app server that fails readiness or exits reports a failure and owned resources are cleaned up.

Vite wraps inline module scripts so their relative imports resolve from the original HTML file. Their `import.meta.url` identifies a virtual module rather than the HTML page; move code that depends on its own URL to an external module. Use the configured browser debugger port to attach DevTools or an editor, select the framed app's source, and set a breakpoint. Vite hot updates apply to the running app; changes to `power.config.json` trigger a full app reload. `--path` overrides the initial workbench URL with an origin-relative path, including its query and fragment. For logs and configuration diagnostics, inspect the dev command output and the workbench status; neither is evidence of an online Power Apps session.

## Run the invented example

The repository's [example project](../../examples/project/code-app/) contains a small browser app, a local app server and an invented `x_item` Solution. In the toolkit checkout, use the pinned Node/npm versions and install dependencies once, then in `examples/project` run `npm install`. No Power Platform account, Power Apps CLI or Vite is needed for the browser sample. Its SDK development dependency is used only by the separate executor regression. The app uses local simulation and does not deploy or connect to an environment.

With Paqvilo installed, `paqvilo mirage demo --scaffold --dir ./my-code-app-project` creates an editable copy including the Code Apps sources, commands and test dependencies. Run `npm install` inside that project before starting the commands below.

Start these in two terminals from `examples/project`:

```sh
npm run code-app:mirage
npm run code-app:dev
```

The first starts a standalone Dataverse simulator on `http://127.0.0.1:8787`, registers `code-app` as `invented-items`, and enables the local Dataverse API. The second serves the app on `http://127.0.0.1:5199` and proxies bridge requests to Mirage. Keep both terminals open. Open `http://127.0.0.1:8787/_sim/`, create an invented interactive staff user with the System Administrator role in the staff controls, and select that user. Then open `http://127.0.0.1:8787/_apps/code/invented-items/`. The loader frames the app; the context shows the selected local staff user. Create an item, rename it and delete it. **Try connector** reports `501 ConnectorNotSimulated` because this example declares a reference but supplies no simulation. A project-provided connector implementation can return a simulated result instead. Stop the two owned terminals when finished.

The sample's `Items` adapter calls Mirage's `dataClient`; its UI and data are deliberately invented. Its `power.config.json` is a read-only fixture. For a separate project, install `paqvilo`, register `codeApps: [{ name: invented-items, dir: code-app, localAppUrl: 'http://127.0.0.1:5199/' }]` in the Mirage project settings, enable Dataverse and supply Solution metadata for the tables you use. Paths are relative to the project root. Start your app server independently and proxy `/_apps/code` to the runtime. Configure the adapter with the registered name before calling it. The example's no-dependency server is a development aid, not a production server.

### Debug and troubleshoot

Use the browser developer tools on the framed app: inspect its console and the Network requests to `/_apps/code/invented-items/context` and `dataverse/...`; the latter include the CSRF header established by context. Inspect `/_sim/` diagnostics and the runtime status for missing or invalid config, an unbound connection, missing local URL, or unsupported connector. A 401 on context means an eligible staff user has not been selected; the default local administrator is not a Code Apps persona. A 502 from the sample server means its Mirage target is not running or has the wrong port. A blank frame can mean the app server is stopped, the configured URL differs, or browser local-network access is blocked. Use `127.0.0.1` consistently for both servers so the browser can send the staff cookie, and check the browser's local-network permission. Do not share tokens or session cookies while collecting diagnostics.

Malformed JSON diagnostics identify the configuration file without echoing its contents; open that file in an editor for syntax details. If the Mirage connection drops after response headers arrive, the sample proxy closes the incomplete response and the browser reports a network error. A client disconnect also cancels the pending upstream request.

To debug app code, select the app frame in browser developer tools and set breakpoints in `app.js`; to debug the server, launch `node --inspect=127.0.0.1:0 code-app/server.mjs` from the project directory and attach your Node debugger to the printed port. For runtime code, launch `node --inspect=127.0.0.1:0 code-app/mirage.mjs` separately. Each process gets its own debugger port. Reload the loader after restarting Mirage and select a staff user again when the runtime session changes. Browser edits require a reload; the sample server does not implement hot module replacement.

Run the focused browser acceptance from the toolkit checkout with `node --test examples/project/test/code-app-browser.test.mjs`. It uses ephemeral ports and invented data, selects a staff session, renders the real frame, pauses at an application-source breakpoint, resumes CRUD, and checks the unsupported connector response and page errors. `node --test mirage/test/code-apps-*.test.mjs` covers config, bindings, client queries/errors and bridge contracts. Full repository validation is `npm run validate`.

## Native Power Apps development

For a real code app, follow Microsoft's [quickstart](https://learn.microsoft.com/power-apps/developer/code-apps/how-to/create-an-app-from-scratch): use a code-app-enabled environment, Node LTS and the Power Apps CLI, initialize the app, then run `pa app run` and open **Local Play** in the signed-in browser profile. Microsoft documents `getContext` from `@microsoft/power-apps/app` and generated Dataverse services created with `pa app add data-source --connector dataverse --table <logical-name>`. The SDK's default execution uses Microsoft's host; Mirage does not implement that host protocol. Keep the native build on its normal SDK configuration. For simulation, select the project's Mirage adapter or the explicit data executor above, while using Mirage's context import. Never alias the whole SDK to the Mirage adapter or assume the simpler client's result and error behavior is identical. Native authentication, online connectors, delegated queries, security and player behavior require separate validation in an authorized environment.

Create a separate native project with the official template and its SDK/Vite integration:

```sh
npx degit github:microsoft/PowerAppsCodeApps/templates/vite my-code-app
cd my-code-app
npm install
npm install --global @microsoft/power-apps-cli
pa app init --display-name "My code app" --environment-id <environment-id>
pa app add data-source --connector dataverse --table <table-logical-name>
npm run build
pa app run
```

The template installs `@microsoft/power-apps` and `@microsoft/power-apps-vite`, and registers `powerApps()` from `@microsoft/power-apps-vite/plugin` in Vite. Preserve that integration in the native build. Online connector setup needs an existing connection in the same environment, the correct connector identifier, user consent and source access. Discover connections with `pa connection list` and use the connection when adding the data source; do not map a native connection ID to an invented local provider implicitly. Generated files and `power.config.json` belong to the native project. `pa app push` publishes the compiled app and is a separate online action.

The baseline was checked against Microsoft's current documentation and official Vite template on 2026-10-26, with SDK 1.5.0, Vite plugin 1.0.13 and PAC 2.13.1. The template's SDK context component compiled, `pac code init` generated local configuration, and PAC/Vite startup served their local endpoints. PAC's `code` namespace is the older preview path; current documentation recommends the npm Power Apps CLI above. In the intended signed-in browser, a native attempt using `127.0.0.1` displayed an app error; retries using `localhost` remained at “Fetching your app” for 45 seconds. No SDK context or loopback request was observed. The cause remains unproven. Preserve the official CLI/plugin URL and its `localhost` defaults for native Local Play; Mirage's broader loopback URL support does not establish native player URL compatibility. These startup checks do not establish native host rendering, authentication or connector execution.

If either fixed port is occupied, set `CODE_APP_PORT` to the same free port in both terminals and set `MIRAGE_PORT` for Mirage; set `MIRAGE_URL` to that runtime's loopback URL for the app server. For example, set `CODE_APP_PORT=5200`, `MIRAGE_PORT=8788` and `MIRAGE_URL=http://127.0.0.1:8788` in the respective terminal environments. The app server accepts loopback HTTP only. The Vite proxy example is for a loopback-only development server; the proxy must validate the browser's origin before rebasing it to Mirage, as the example server does.

`GET /_sim/api/state` and `simulator.state()` expose runtime capabilities and diagnostics. `CODEAPP_CONFIG_MISSING`, `CODEAPP_CONFIG_INVALID`, `CODEAPP_LOCAL_URL_MISSING` and `CODEAPP_CONNECTION_UNBOUND` point to project configuration issues; an unbound connector need not prevent the app from loading. See the status and diagnostics in `/_sim/` before changing the app.

### Start app servers with Mirage dev

For a standalone Mirage project, `paqvilo mirage dev --project ./mirage.project.yml --port 0 --debug-port 9222` starts the runtime, then any explicitly configured Code Apps development servers and opens the local Code Apps workbench. For example:

```yaml
codeApps:
  - name: invented-items
    dir: code-app
    localAppUrl: http://127.0.0.1:5199/
    devServer:
      command: [node, server.mjs]
      cwd: .
      timeoutMs: 30000
```

`command` is an argument array executed without a shell; `cwd` is relative to the app directory, and optional `env` supplies string environment values. The app must serve the fixed loopback URL and proxy the bridge to the running Mirage origin. Mirage supplies `PAQVILO_MIRAGE_URL` and `PAQVILO_CODE_APP` to each owned server, including when the runtime uses an ephemeral port. Multiple entries can each configure a server. A listener already responding at an app URL is reused and remains user-owned; an entry without `devServer` also remains externally managed. The development session waits for configured servers to respond before opening the browser, prefixes their bounded logs with the app name, and stops the servers it started when the session ends. Select an app in the workbench; select a local staff user to use its data. Use `--path` to choose a different starting page and `--debug-port` to attach the browser debugger. On Windows an `npm` command needs npm's configured CLI (`npm_execpath`), or provide an explicit Node executable and npm CLI path.
