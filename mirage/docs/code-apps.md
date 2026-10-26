# Code apps

Mirage hosts a local bridge for Power Apps code apps under `/_apps/code/<name>/`. The bridge provides a Mirage adapter for the documented `getContext()` shape and selected Dataverse operations. It does not implement Microsoft's player or `pa app run` local-host protocol, because that protocol is not publicly documented. The bridge is at capability level `contract`. A connector operation without a simulation answers `501` and never reports success.

Modules: `mirage/lib/code-apps-config.mjs` (settings and the read-only `power.config.json` parser), `mirage/lib/code-apps-http.mjs` (HTTP handler) and `mirage/lib/code-apps-client.js` (browser shim).

Both hosts serve the bridge, before the model-driven handler, for the apps in the project `codeApps` setting. The selected staff user is the app's user. `token` issues a Dataverse token for the local Dataverse origin through the organization's authority, so it needs the Dataverse API (`dataverse.enabled`); without it `token` answers `501 DataverseApiDisabled`. `dataverse/*` runs the Web API call through the organization record pipeline as that user: reads in a read transaction, writes atomically. `connectors/<reference>/<operation>` binds the project `connections` entry whose id is the reference key, else the connector's built-in provider, and reports a `501` when no local provider implements the operation (`ConnectorNotConfigured` or `ConnectorNotSimulated`, depending on the host). `capabilities.codeApps` is `contract`.

## Configuration

The project `codeApps` setting is an array, validated by `codeAppSettings(value, label)`:

| Field         | Required | Meaning                                                                                                                                   |
| ------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | yes      | URL segment, 1 to 64 letters, digits or hyphens. Must be unique, compared without case.                                                   |
| `dir`         | yes      | The app folder, relative to the project root.                                                                                             |
| `localAppUrl` | no       | The app's dev server, for example `http://localhost:3000`. Must be a loopback http(s) URL. It overrides the value in `power.config.json`. |
| `config`      | no       | The configuration file, relative to `dir`. The default is `power.config.json`.                                                            |

`readCodeAppConfig(dir, file, { bindings })` reads `power.config.json` and **never writes it**. It returns `appId`, `environmentId`, `localAppUrl`, `connectionReferences` (normalised to `{ key, apiId, displayName, dataSources }`) and `databaseReferences`. Fields it does not use stay in `raw`. It reports these diagnostics:

| Code                         | When                                                                                               |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| `CODEAPP_CONFIG_MISSING`     | The file does not exist.                                                                           |
| `CODEAPP_CONFIG_INVALID`     | The file is not a JSON object, a field has the wrong type, or `localAppUrl` is not a loopback URL. |
| `CODEAPP_CONNECTION_UNBOUND` | A connection reference has no entry in `bindings`.                                                 |

`loadCodeApps` also reports `CODEAPP_LOCAL_URL_MISSING` when neither the project override nor the configuration supplies a valid local URL. Reference maps and the fields Mirage consumes are checked; this is not a complete Microsoft schema validator. Bindings are project `connections` objects keyed by the reference key, with the matching `connector` and an explicitly configured simulated provider where needed. A binding does not prove that its provider implements every operation or grant access to an online connection.

`loadCodeApps(entries, projectRoot, { bindings })` builds the app records that the handler serves. `codeAppInventoryRecord(app)` returns the app's capability record: level `contract`, with its connection-reference dependencies and diagnostic codes.

## Endpoints

Every path below is relative to `/_apps/code/<name>/`. Every Dataverse and connector request, GET included, requires the `x-sim-csrf` header (some Dataverse functions are GET and write). `GET context` returns that token in its `x-sim-csrf` response header. Every response sends `cache-control: no-store` and `x-content-type-options: nosniff`.

`GET status` reports the simulation mode, `contract` level, local app URL, connection dependencies and configuration diagnostics without serving the raw config. It requires no staff selection so configuration can be debugged before sign-in. The loader displays the same configuration diagnostics; both hosts include them in their runtime diagnostic stream. Restart Mirage after configuration changes.

| Endpoint                                    | Level               | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET context`                               | behaviour (mapping) | Returns `IContext` `{ app: { appId, environmentId, queryParams, dataverseOrgUrl, appUrl }, user: { fullName, objectId, systemUserId, tenantId, userPrincipalName }, host: { sessionId } }`, built from the staff persona selected in `/_sim/`. Answers `401` when no persona is selected (local administrator) or the persona is unavailable. `queryParams` holds the query of the context request. `dataverseOrgUrl` is the local Dataverse origin. `sessionId` is fixed for each Mirage process. |
| `POST token` `{ resource }`                 | behaviour           | Returns `{ access_token, expires_on }` from the local authority. The resource must be the local Dataverse origin, optionally followed by `/` or `/.default`. Any other resource answers `400 InvalidResource` and reports a `CODEAPP_TOKEN_REFUSED` diagnostic. Token values are never logged.                                                                                                                                                                                                     |
| `ANY dataverse/<path>`                      | behaviour           | Runs `/api/data/v9.2/<path>` in process as the staff principal. Forwards the method, query, JSON body and the `accept`, `content-type`, `prefer`, `if-match`, `if-none-match` and `odata-*` version headers. Never uses the portal `/_api` contract.                                                                                                                                                                                                                                               |
| `POST connectors/<reference>/<operationId>` | mock                | `<reference>` is a connection-reference key or data-source name from `power.config.json`. An unknown reference answers `404`. The injected connector hook answers the call. Without a hook, or when the hook returns `undefined`, it answers `501 ConnectorNotSimulated` and reports a `CODEAPP_CONNECTOR_NOT_SIMULATED` diagnostic. A host can instead report `501 ConnectorNotConfigured` for an unbound provider.                                                                               |
| `GET` (root)                                | mock                | A loader page. When `localAppUrl` is set, it frames that URL with `allow="local-network-access"` and forwards the query string, mirroring Local Play. The page uses the model-driven shell CSP plus `frame-src <localAppUrl origin>`. Without `localAppUrl`, the page explains that the setting is missing.                                                                                                                                                                                        |

An unknown app answers `404 CodeAppNotFound`. `/_apps/code/<name>` without a trailing slash redirects (`308`) to `/_apps/code/<name>/`.

`createCodeAppsHandler({ apps, sessions, user, organization, issueToken, dataverse, connectors, csrf, diagnostic })` returns `async (req, res, url?) => boolean`. It returns `false` for any path outside `/_apps/code/`. `authorityTokenIssuer({ issueAccessToken, origin, appId })` adapts the Dataverse authority's `issueAccessToken` (`dataverse-auth.mjs`) to `issueToken`.

## Browser shim

`code-apps-client.js` exports `configure({ app, origin? })`, `getContext()`, `getToken(resource)` and `dataClient`. `dataClient` provides `create(entitySet, record)`, `get(entitySet, id, options)`, `getAll(entitySet, options)`, `update(entitySet, id, changes)`, `delete(entitySet, id)` and `execute(reference, operationId, parameters)`. Data methods resolve to `{ data }` and throw on errors. Microsoft generated services return a richer operation result, so this is not a complete substitute. Every call sends `credentials: 'same-origin'`, and every call sends the CSRF header once `context` has supplied it.

For Mirage runs only, import the Mirage adapter explicitly. Proxy `/_apps/code` to Mirage so the app and bridge share one browser origin. A Vite proxy needs `changeOrigin: true`, and must validate the incoming Host and Origin before forwarding an Origin rebased to the Mirage origin. The [example server](../../examples/project/code-app/server.mjs) shows these checks for a loopback-only server. Do not expose that development proxy to a network.

Call `configure({ app: '<name>' })` before the first call. Use the same host name (`localhost` or `127.0.0.1`) for the dev server and Mirage, so the browser sends the staff-session cookie.

## Limits

- Mirage does not reproduce the player's own wire protocol with `@microsoft/power-apps`, or the `pa app run` host on port 8080.
- Only the client surface above is shimmed. The generated service files call internal client APIs, so they are not drop-in compatible with the shim; code that runs against Mirage calls `dataClient` instead.
- The shim maps `select`, `filter`, `orderBy`, `top` and `skipToken` to OData query options; `maxPageSize` sets `Prefer: odata.maxpagesize`. `skip`, `expand`, `count`, `partitionId` and other unsupported options are rejected explicitly. Pagination uses the returned `skipToken`; the adapter does not fetch every page automatically.

Microsoft documentation: [overview](https://learn.microsoft.com/power-apps/developer/code-apps/overview), [architecture](https://learn.microsoft.com/power-apps/developer/code-apps/architecture), [get context](https://learn.microsoft.com/power-apps/developer/code-apps/how-to/retrieve-context), [connect to Dataverse](https://learn.microsoft.com/power-apps/developer/code-apps/how-to/connect-to-dataverse), [create an app](https://learn.microsoft.com/power-apps/developer/code-apps/how-to/create-an-app-from-scratch), [CLI](https://learn.microsoft.com/power-apps/developer/code-apps/reference/cli), [pac code](https://learn.microsoft.com/power-platform/developer/cli/reference/code).

## Run the invented example

The repository's [example project](../../examples/project/code-app/) contains a small browser app, a local app server and an invented `x_item` Solution. In the toolkit checkout, use Node 24 and install dependencies once, then in `examples/project` run `npm install`. No Power Platform account, Power Apps CLI, SDK or Vite is needed for this example. It is local simulation and does not deploy or connect to an environment.

Start these in two terminals from `examples/project`:

```sh
npm run code-app:mirage
npm run code-app:dev
```

The first starts a standalone Dataverse simulator on `http://127.0.0.1:8787`, registers `code-app` as `invented-items`, and enables the local Dataverse API. The second serves the app on `http://127.0.0.1:5199` and proxies bridge requests to Mirage. Keep both terminals open. Open `http://127.0.0.1:8787/_sim/`, create an invented interactive staff user with the System Administrator role in the staff controls, and select that user. Then open `http://127.0.0.1:8787/_apps/code/invented-items/`. The loader frames the app; the context shows the selected local staff user. Create an item, rename it and delete it. **Try connector** reports `501 ConnectorNotSimulated` because this example declares a reference but supplies no simulation. A project-provided connector implementation can return a simulated result instead. Stop the two owned terminals when finished.

The sample's `Items` adapter calls Mirage's `dataClient`; its UI and data are deliberately invented. Its `power.config.json` is a read-only fixture. For a separate project, install `paqvilo`, register `codeApps: [{ name: invented-items, dir: code-app, localAppUrl: 'http://127.0.0.1:5199/' }]` in the Mirage project settings, enable Dataverse and supply Solution metadata for the tables you use. Paths are relative to the project root. Start your app server independently and proxy `/_apps/code` to the runtime. Configure the adapter with the registered name before calling it. The example's no-dependency server is a development aid, not a production server.

### Debug and troubleshoot

Use the browser developer tools on the framed app: inspect its console and the Network requests to `/_apps/code/invented-items/context` and `dataverse/...`; the latter include the CSRF header established by context. Inspect `/_sim/` diagnostics and the runtime status for missing or invalid config, an unbound connection, missing local URL, or unsupported connector. A 401 on context means an eligible staff user has not been selected; the default local administrator is not a Code Apps persona. A 502 from the sample server means its Mirage target is not running or has the wrong port. A blank frame can mean the app server is stopped, the configured URL differs, or browser local-network access is blocked. Use `127.0.0.1` consistently for both servers so the browser can send the staff cookie, and check the browser's local-network permission. Do not share tokens or session cookies while collecting diagnostics.

To debug app code, select the app frame in browser developer tools and set breakpoints in `app.js`; to debug the server, launch `node --inspect=127.0.0.1:0 code-app/server.mjs` from the project directory and attach your Node debugger to the printed port. For runtime code, launch `node --inspect=127.0.0.1:0 code-app/mirage.mjs` separately. Each process gets its own debugger port. Reload the loader after restarting Mirage and select a staff user again when the runtime session changes. Browser edits require a reload; the sample server does not implement hot module replacement.

Run the focused browser acceptance from the toolkit checkout with `node --test examples/project/test/code-app-browser.test.mjs`. It uses ephemeral ports and invented data, selects a staff session, renders the real frame, pauses at an application-source breakpoint, resumes CRUD, and checks the unsupported connector response and page errors. `node --test mirage/test/code-apps-*.test.mjs` covers config, bindings, client queries/errors and bridge contracts. Full repository validation is `npm run validate`.

## Native Power Apps development

For a real code app, follow Microsoft's [quickstart](https://learn.microsoft.com/power-apps/developer/code-apps/how-to/create-an-app-from-scratch): use a code-app-enabled environment, Node LTS and the Power Apps CLI, initialize the app, then run `pa app run` and open **Local Play** in the signed-in browser profile. Microsoft documents `getContext` from `@microsoft/power-apps/app` and generated Dataverse services created with `pa app add data-source --connector dataverse --table <logical-name>`. Those services and the Microsoft SDK require their native Power Apps host; Mirage does not implement that host protocol. Keep native SDK imports and generated services in the native build, and select the project's Mirage adapter for local simulation. Never alias the whole SDK to the Mirage adapter or assume the adapter's result and error behavior is identical. Native authentication, connectors, delegated queries, security and player behavior require separate validation in an authorized environment.

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

The baseline was checked against Microsoft's current documentation and official Vite template on 2026-10-26, with SDK 1.5.0, Vite plugin 1.0.13 and PAC 2.13.1. The template's SDK context component compiled, `pac code init` generated local configuration, and PAC/Vite startup served their local endpoints. PAC's `code` namespace is the older preview path; current documentation recommends the npm Power Apps CLI above. These startup checks alone do not establish native host rendering, authentication or connector execution. A native Local Play check must observe app content and SDK context in the intended signed-in browser.

If either fixed port is occupied, set `CODE_APP_PORT` to the same free port in both terminals and set `MIRAGE_PORT` for Mirage; set `MIRAGE_URL` to that runtime's loopback URL for the app server. For example, set `CODE_APP_PORT=5200`, `MIRAGE_PORT=8788` and `MIRAGE_URL=http://127.0.0.1:8788` in the respective terminal environments. The app server accepts loopback HTTP only. The Vite proxy example is for a loopback-only development server; the proxy must validate the browser's origin before rebasing it to Mirage, as the example server does.

`GET /_sim/api/state` and `simulator.state()` expose runtime capabilities and diagnostics. `CODEAPP_CONFIG_MISSING`, `CODEAPP_CONFIG_INVALID`, `CODEAPP_LOCAL_URL_MISSING` and `CODEAPP_CONNECTION_UNBOUND` point to project configuration issues; an unbound connector need not prevent the app from loading. See the status and diagnostics in `/_sim/` before changing the app.
