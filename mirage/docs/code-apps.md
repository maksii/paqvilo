# Code apps

Mirage hosts a local bridge for Power Apps code apps under `/_apps/code/<name>/`. It answers the documented
`getContext()` shape and selected Dataverse operations from the local organization, and runs connector operations only
through configured local simulations. It does not implement Microsoft's player, the `pa app run` Local Play host or
the SDK's host wire protocol: Microsoft publishes no contract for replacing that host. The capability level is
`contract` (`capabilities.codeApps`). A connector operation without a simulation answers `501` and never reports
success.

| Module                             | Role                                                               |
| ---------------------------------- | ------------------------------------------------------------------ |
| `mirage/lib/code-app-settings.mjs` | Validates the `codeApps` setting (`codeAppSettings(value, label)`) |
| `mirage/lib/code-apps-config.mjs`  | Reads `power.config.json` (never writes it) and builds app records |
| `mirage/lib/code-apps-http.mjs`    | The bridge HTTP handler                                            |
| `mirage/lib/code-apps-client.js`   | Browser shim (`paqvilo/mirage/code-apps/client`)                   |
| `mirage/lib/code-apps-sdk.js`      | Optional SDK data executor (`paqvilo/mirage/code-apps`)            |
| `mirage/lib/code-apps-vite.mjs`    | Vite plugin (`paqvilo/mirage/code-apps/vite`)                      |

## Configuration

The project `codeApps` setting is an array:

| Field         | Required | Meaning                                                                                                     |
| ------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `name`        | yes      | URL segment: 1–64 letters, digits or hyphens, starting with a letter or digit, unique ignoring case         |
| `dir`         | yes      | App folder, relative to the project root                                                                    |
| `localAppUrl` | no       | The app's dev server, a loopback http(s) URL without credentials or fragment; overrides `power.config.json` |
| `config`      | no       | Configuration file relative to `dir`; default `power.config.json`                                           |
| `devServer`   | no       | A server `mirage dev` starts; see [Start app servers with Mirage dev](#start-app-servers-with-mirage-dev)   |

`readCodeAppConfig(dir, file, { bindings })` returns `appId`, `environmentId`, `localAppUrl`, `connectionReferences`
(`{ key, apiId, displayName, dataSources }`), `databaseReferences`, `appSettings` and `entitySets` derived from
unambiguous data-source aliases and logical names; unused fields stay in `raw`. It checks the fields Mirage consumes,
not Microsoft's full schema. `loadCodeApps(entries, projectRoot, { bindings })` builds the served app records, and
`codeAppInventoryRecord(app)` the capability record (level `contract`, connection dependencies, diagnostic codes).

| Diagnostic                        | When                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `CODEAPP_CONFIG_MISSING`          | The configuration file does not exist                                                                         |
| `CODEAPP_CONFIG_INVALID`          | Not a JSON object, a field of the wrong type, or `localAppUrl` not a loopback http(s) URL without credentials |
| `CODEAPP_LOCAL_URL_MISSING`       | Neither the project nor the configuration supplies a valid local URL                                          |
| `CODEAPP_CONNECTION_UNBOUND`      | A connection reference has no matching binding                                                                |
| `CODEAPP_DATASOURCE_AMBIGUOUS`    | An alias or logical name maps to several entity sets; that mapping is omitted                                 |
| `CODEAPP_TOKEN_REFUSED`           | `token` was asked for a resource other than the local Dataverse origin                                        |
| `CODEAPP_CONNECTOR_NOT_SIMULATED` | A connector operation has no simulation                                                                       |

Bindings are project `connections` entries keyed by the reference key or, failing that, the connector ID, with the
matching `connector` and a configured simulated provider. A binding does not prove the provider implements every
operation and grants no access to an online connection. An unbound connection does not stop the app from loading.

Diagnostics appear in `GET status`, the loader page, `/_sim/` and the runtime state (`GET /_sim/api/state`,
`simulator.state()`). The hosts reread `power.config.json` per request; restart Mirage after changing the project
settings, registered apps, dev server commands or bindings.

## Endpoints

Both hosts serve the bridge, before the model-driven handler, for the apps in `codeApps`. Paths are relative to
`/_apps/code/<name>/`. The app's user is the staff user selected in `/_sim/`. Every Dataverse and connector request,
GET included, needs the apps token in `x-sim-csrf` (some Dataverse functions are GET and write); `GET context` returns
the token in its `x-sim-csrf` response header. Responses send `cache-control: no-store` and
`x-content-type-options: nosniff`.

| Endpoint                                     | Behavior                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET status`                                 | Simulation mode, level, local app URL, connection dependencies and configuration diagnostics (never the raw config). Needs no staff selection.                                                                                                                                                                                                                                  |
| `GET context`                                | `IContext`: `{ app: { appId, appSettings, environmentId, queryParams, dataverseOrgUrl, appUrl }, user: { fullName, objectId, systemUserId, tenantId, userPrincipalName }, host: { sessionId } }` for the selected staff user. `401` with the local administrator or an unavailable user. `dataverseOrgUrl` is the local Dataverse origin; `queryParams` is the request's query. |
| `POST token` `{ resource }`                  | `{ access_token, expires_on }` from the local Dataverse authority. The resource must be the local Dataverse origin, optionally with `/` or `/.default`; otherwise `400 InvalidResource`. Needs `dataverse.enabled`, else `501 DataverseApiDisabled`. Tokens are never logged.                                                                                                   |
| `GET/POST/PATCH/PUT/DELETE dataverse/<path>` | Runs `/api/data/v9.2/<path>` in process as the staff user (reads in a read transaction, writes atomically), forwarding method, query, JSON or binary body (up to 16 MiB) and `accept`, `content-type`, `prefer`, `if-match`, `if-none-match` and OData version headers. Never uses the portal `/_api`.                                                                          |
| `POST connectors/<reference>/<operationId>`  | `<reference>` is a connection-reference key or data-source name (keys win; an alias shared by several references answers `409 ConnectionReferenceAmbiguous`). Unknown references answer `404`. The binding's provider answers; without one, `501 ConnectorNotSimulated` or `ConnectorNotConfigured`.                                                                            |
| `GET` (root)                                 | Loader page that frames `localAppUrl` with `allow="local-network-access"` and forwards the query string, like Local Play. CSP: the model-driven shell's plus `frame-src <localAppUrl origin>`.                                                                                                                                                                                  |

An unknown app answers `404 CodeAppNotFound`; `/_apps/code/<name>` redirects (`308`) to the trailing-slash path.

`createCodeAppsHandler({ apps, sessions, user, organization, issueToken, dataverse, connectors, csrf, diagnostic })`
returns `async (req, res, url?) => boolean`, `false` outside `/_apps/code/`. `authorityTokenIssuer({ issueAccessToken,
origin, appId })` adapts the Dataverse authority (`dataverse-auth.mjs`) to `issueToken`.

## Browser shim

`paqvilo/mirage/code-apps/client` exports `configure({ app, origin?, onEvent? })`, `getStatus()`, `getContext()`,
`getToken(resource)` and `dataClient` with `create(entitySet, record)`, `get(entitySet, id, options)`,
`getAll(entitySet, options)`, `update(entitySet, id, changes)`, `delete(entitySet, id)` and
`execute(reference, operationId, parameters)`.

- Call `configure({ app: '<name>' })` first. Data methods resolve to `{ data }` and throw on errors; Microsoft's
  generated services return a richer result, so this client is not an SDK replacement.
- Calls use `credentials: 'same-origin'` and send the CSRF header once `context` supplied it. Serve the app and Mirage
  from the same host name (`localhost` or `127.0.0.1`) so the staff cookie is sent.
- An explicit `origin` must be an http(s) root origin on the current browser origin, without credentials, path, query
  or fragment. Entity sets must be Dataverse identifiers.
- `getContext()` caches its result, including caller mutations to its query parameters, as the official SDK does;
  `configure()` clears the cache and rejects pending results of the previous configuration. A write already sent cannot
  be rolled back: check the records before repeating an interrupted write.
- Query options: `select`, `filter`, `orderBy`, `top`, `count` and `skipToken` map to OData; `maxPageSize` sets
  `Prefer: odata.maxpagesize`. `skip`, `expand`, `partitionId` and other options are rejected (Dataverse
  [has no `$skip`](https://learn.microsoft.com/power-apps/developer/data-platform/webapi/query/page-results)). Follow
  `skipToken`; pages are not fetched automatically.
- The single-file client loads the gesture-trace helper from `/_apps/code/_assets/trace-gesture.js` after
  `configure()` and works without it.

For a hand-built integration, proxy `/_apps/code` to Mirage so app and bridge share one origin. A Vite proxy needs
`changeOrigin: true` and must validate the incoming Host and Origin before forwarding an Origin rebased to Mirage; the
[example server](../../examples/project/code-app/server.mjs) shows these checks. Never expose such a proxy to a
network. The Vite plugin's proxy refuses a request whose `Host` is not the dev server's, whose `Origin` differs, or whose
`Sec-Fetch-Site` is cross-site, then strips `Origin` and `Sec-Fetch-*` so Mirage treats the call as programmatic and the
apps token authorizes it.

### Optional SDK data executor

Apps that keep generated SDK data services can install an executor for Mirage through Microsoft's documented
[`IDataOperationExecutor`](https://learn.microsoft.com/javascript/api/@microsoft/power-apps/idataoperationexecutor?view=powerapps-js-latest)
and `setDataOperationExecutor`, exported from the internal-named `@microsoft/power-apps/internal/data` subpath; pin and
retest it when you upgrade the SDK. The SDK stays an application dependency; Paqvilo does not bundle it. The Vite
plugin installs this automatically; by hand:

```js
// Mirage-only entry. Keep this registration out of the native build.
import { setDataOperationExecutor } from '@microsoft/power-apps/internal/data';
import { createCodeAppSdkExecutor } from 'paqvilo/mirage/code-apps';
import { configure, getContext } from 'paqvilo/mirage/code-apps/client';

configure({ app: 'invented-items' });
setDataOperationExecutor(createCodeAppSdkExecutor({ entitySets: { Items: 'x_items' } }));
const context = await getContext();
```

`entitySets` maps generated source names to exported entity sets; other names pass through. The executor returns
`{ success, data, error?, skipToken?, count? }` and keeps failed results instead of throwing.

| Operation                                                                           | Mirage behavior                                                                                            |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| CRUD with `select`, `filter`, `orderBy`, `top`, `count`, `skipToken`, `maxPageSize` | Local Dataverse pipeline                                                                                   |
| Entity metadata                                                                     | Scalar selection, column and relationship expansions                                                       |
| Connectors                                                                          | Configured simulated operations; missing operations fail                                                   |
| Dataverse actions                                                                   | Registered unbound custom actions and functions, and `WhoAmI`                                              |
| Files and images                                                                    | Single-request upload, download and delete, up to 16 MiB                                                   |
| Other                                                                               | Bound actions and functions, partition IDs, `skip`, chunked uploads and other raw requests fail explicitly |

The executor supplies data only; other host services need the native host. `examples/project/test/baseline-code-app-sdk.test.mjs`
runs the real SDK entry points against the bridge; it does not prove native player compatibility.

## Develop SDK apps with Vite and the workbench

Install `paqvilo`, Vite and `@microsoft/power-apps` in the app project. Keep Microsoft's plugin for native serving and
builds, and select the Mirage plugin only for local serving; never activate both:

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

- The plugin runs only while Vite serves, and only when `PAQVILO_MIRAGE_URL` is set, the mode is `mirage`, or
  `enabled: true` is passed. It reads the app name from `PAQVILO_CODE_APP` and the Mirage origin from
  `PAQVILO_MIRAGE_URL` (the apps address on the Power Pages host, the main address on the standalone host), or from
  `codeApps({ app: 'alpha', mirageUrl: 'http://127.0.0.1:8787', enabled: true })`.
- App code keeps `getContext` from `@microsoft/power-apps/app` and generated services using `getClient`; the plugin
  installs Mirage's context and data adapters, using the app's `power.config.json` mappings. Production builds keep the
  native SDK path without the Mirage bootstrap.
- Bind the dev server to loopback. Vite hot updates apply; a `power.config.json` change reloads the app. Vite wraps
  inline module scripts, so their `import.meta.url` is a virtual module: move URL-dependent code to an external module.

A standalone project can register several apps, each with a fixed port and a trusted command:

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

```sh
paqvilo mirage dev --project ./mirage.project.yml --port 0 --debug-port 9222
```

The runtime starts first, then each declared dev server, then the dedicated browser opens the workbench at
`/_apps/code/`. The workbench lists the apps; select one, set query parameters, reload it, inspect bridge activity and
open administration. It checks each app server on open and Refresh and marks an app loaded once its document posts the
bridge event. Select a staff user in `/_sim/` before calling context or data. `--path` sets a different start page
(origin-relative, with query and fragment); attach DevTools or an editor to the debug port and pick the framed app's
source to set breakpoints. Command output and workbench status are local logs, not evidence of an online session.

### Start app servers with Mirage dev

`devServer` fields:

- `command`: an argument array run without a shell. On Windows a `.cmd` or `.bat` command (such as the `npx`, `pnpm`,
  `yarn` or `vite` shim) runs through the command interpreter with each argument quoted and escaped, so none is split,
  expanded or executed. A bare name resolves on `PATH` with each `PATHEXT` extension; a name with a path is used as
  written. An `npm` command needs `npm_execpath`, or give the Node executable and npm CLI path. An element containing
  NUL or a line break is refused when the configuration is read.
- `cwd`: relative to the app directory. `env`: string environment values.
- `timeoutMs`: start-up hang guard, an integer from 1000 to 300000 (default 120000). It ends only a wait for a server
  that never answers; the error names the app, origin and bound.

Mirage supplies `PAQVILO_MIRAGE_URL` (the actual origin, also with `--port 0`) and `PAQVILO_CODE_APP` to each server it
starts. The app must serve its fixed `localAppUrl` and proxy the bridge to Mirage. Two `devServer` apps on the same
loopback listener are refused at start. A URL that already answers is reused and stays user-owned, as do entries
without `devServer`. The session waits for its servers before opening the browser, prefixes their bounded logs with the
app name (Vite's "points to missing source files" warnings for `node_modules` are hidden), and on exit stops only the
servers it started and its owned browser. `mirage stop` for the project ends the session the same way and exits 0; an
attached browser keeps running and only the page the command opened is closed. A server that fails readiness or exits
fails the start and owned resources are cleaned up. Shutdown waits for each owned server's stdout and stderr to close;
if it reports streams that did not close, look for descendants holding inherited handles. Keep dev commands in the
foreground.

## Run the invented example

The [example project](../../examples/project/code-app/) contains a dependency-free browser app, a loopback app server
and an invented `x_item` Solution; it needs no Power Platform account, Power Apps CLI or Vite. In the toolkit checkout,
install dependencies, then run `npm install` in `examples/project`. With an installed package,
`paqvilo mirage demo --scaffold --dir ./my-code-app-project` creates an editable copy; run `npm install` there.

In two terminals from `examples/project`:

```sh
npm run code-app:mirage
npm run code-app:dev
```

The first starts a standalone Dataverse simulator on `http://127.0.0.1:8787` with `code-app` registered as
`invented-items`; the second serves the app on `http://127.0.0.1:5199` and proxies the bridge. Open the printed
`adminUrl` (`/_sim/`), create an invented interactive staff user with the System Administrator role and select it, then
open `http://127.0.0.1:8787/_apps/code/invented-items/`. Create, rename and delete an item. **Try connector** answers
`501 ConnectorNotSimulated` because the example declares a reference without a simulation.

If a port is taken, set the same free `CODE_APP_PORT` in both terminals, `MIRAGE_PORT` for Mirage, and `MIRAGE_URL`
(loopback only) for the app server. For a separate project, register
`codeApps: [{ name: invented-items, dir: code-app, localAppUrl: 'http://127.0.0.1:5199/' }]`, enable Dataverse and
supply Solution metadata for the tables you use.

### Debug and troubleshoot

| Symptom                       | Cause                                                                               |
| ----------------------------- | ----------------------------------------------------------------------------------- |
| `401` from `context`          | No eligible staff user selected; the local administrator is not a code app user     |
| `502` from the example server | Mirage is not running, or on another port                                           |
| Blank frame                   | App server stopped, wrong `localAppUrl`, or the browser blocks local-network access |
| Staff cookie not sent         | App and Mirage use different host names; use `127.0.0.1` for both                   |
| Config diagnostics            | See `/_sim/` and `GET status`; malformed JSON names the file without echoing it     |

Inspect the framed app's console and its requests to `context` and `dataverse/...` in browser developer tools. Debug
the example server with `node --inspect=127.0.0.1:0 code-app/server.mjs` and the runtime with
`node --inspect=127.0.0.1:0 code-app/mirage.mjs`. The example server has no hot reload; reload the loader after edits,
and select a staff user again after restarting Mirage. If Mirage drops a response mid-stream, the example proxy closes
it and the browser reports a network error. Never share tokens or session cookies.

Tests: `node --test --import=./test/browser-bootstrap.mjs examples/project/test/code-app-browser.test.mjs` (real frame,
a source breakpoint, CRUD and the unsupported connector) and `node --test mirage/test/code-apps-*.test.mjs`
(configuration, bindings, client and bridge contracts).

## Native Power Apps development

Build the real app in a separate project from Microsoft's
[quickstart](https://learn.microsoft.com/power-apps/developer/code-apps/how-to/create-an-app-from-scratch) (`pa app init`,
`pa app add data-source`, `pa app run`). The template registers `powerApps()` from `@microsoft/power-apps-vite/plugin`; keep it for the native build, and keep
the CLI's `localhost` URLs for Local Play (Mirage's broader loopback support says nothing about the native player).
Online connectors need an existing connection in the environment (`pa connection list`), the correct connector ID and
consent; never map a native connection ID to an invented local provider. `pa app push` publishes and is a separate
online action. Native authentication, connectors, delegation, security and player behavior need validation in an
authorized environment. Mirage does not implement Microsoft's separate Copilot Managed Runtime preview.

Microsoft documentation: [overview](https://learn.microsoft.com/power-apps/developer/code-apps/overview),
[architecture](https://learn.microsoft.com/power-apps/developer/code-apps/architecture),
[get context](https://learn.microsoft.com/power-apps/developer/code-apps/how-to/retrieve-context),
[connect to Dataverse](https://learn.microsoft.com/power-apps/developer/code-apps/how-to/connect-to-dataverse),
[CLI](https://learn.microsoft.com/power-apps/developer/code-apps/reference/cli).
