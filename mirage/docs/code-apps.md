# Code apps

Mirage hosts a local bridge for Power Apps code apps under `/_apps/code/<name>/`. The bridge implements the **documented client-library surface**: `getContext()` and the generated data-service calls. It does not implement Microsoft's player or `pa app run` local-host protocol, because that protocol is not publicly documented. The bridge is at capability level `contract`. A connector operation without a simulation answers `501` and never reports success.

Modules: `mirage/lib/code-apps-config.mjs` (settings and the read-only `power.config.json` parser), `mirage/lib/code-apps-http.mjs` (HTTP handler) and `mirage/lib/code-apps-client.js` (browser shim).

Both hosts serve the bridge, before the model-driven handler, for the apps in the project `codeApps` setting. The selected staff user is the app's user. `token` issues a Dataverse token for the local Dataverse origin through the organization's authority, so it needs the Dataverse API (`dataverse.enabled`); without it `token` answers `501 DataverseApiDisabled`. `dataverse/*` runs the Web API call through the organization record pipeline as that user: reads in a read transaction, writes atomically. `connectors/<reference>/<operation>` binds the project `connections` entry whose id is the reference key, else the connector's built-in provider, and answers `501 ConnectorNotSimulated` when no provider implements the operation. `capabilities.codeApps` is `contract`.

## Configuration

The project `codeApps` setting is an array, validated by `codeAppSettings(value, label)`:

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | URL segment, 1 to 64 letters, digits or hyphens. Must be unique, compared without case. |
| `dir` | yes | The app folder, relative to the project root. |
| `localAppUrl` | no | The app's dev server, for example `http://localhost:3000`. Must be a loopback http(s) URL. It overrides the value in `power.config.json`. |
| `config` | no | The configuration file, relative to `dir`. The default is `power.config.json`. |

`readCodeAppConfig(dir, file, { bindings })` reads `power.config.json` and **never writes it**. It returns `appId`, `environmentId`, `localAppUrl`, `connectionReferences` (normalised to `{ key, apiId, displayName, dataSources }`) and `databaseReferences`. Fields it does not use stay in `raw`. It reports these diagnostics:

| Code | When |
| --- | --- |
| `CODEAPP_CONFIG_MISSING` | The file does not exist. |
| `CODEAPP_CONFIG_INVALID` | The file is not a JSON object, a field has the wrong type, or `localAppUrl` is not a loopback URL. |
| `CODEAPP_CONNECTION_UNBOUND` | A connection reference has no entry in `bindings`. |

`loadCodeApps(entries, projectRoot, { bindings })` builds the app records that the handler serves. `codeAppInventoryRecord(app)` returns the app's capability record: level `contract`, with its connection-reference dependencies and diagnostic codes.

## Endpoints

Every path below is relative to `/_apps/code/<name>/`. Every Dataverse and connector request, GET included, requires the `x-sim-csrf` header (some Dataverse functions are GET and write). `GET context` returns that token in its `x-sim-csrf` response header. Every response sends `cache-control: no-store` and `x-content-type-options: nosniff`.

| Endpoint | Level | Behaviour |
| --- | --- | --- |
| `GET context` | behaviour (mapping) | Returns `IContext` `{ app: { appId, environmentId, queryParams, dataverseOrgUrl, appUrl }, user: { fullName, objectId, systemUserId, tenantId, userPrincipalName }, host: { sessionId } }`, built from the staff persona selected in `/_sim/`. Answers `401` when no persona is selected (local administrator) or the persona is unavailable. `queryParams` holds the query of the context request. `dataverseOrgUrl` is the local Dataverse origin. `sessionId` is fixed for each Mirage process. |
| `POST token` `{ resource }` | behaviour | Returns `{ access_token, expires_on }` from the local authority. The resource must be the local Dataverse origin, optionally followed by `/` or `/.default`. Any other resource answers `400 InvalidResource` and reports a `CODEAPP_TOKEN_REFUSED` diagnostic. Token values are never logged. |
| `ANY dataverse/<path>` | behaviour | Runs `/api/data/v9.2/<path>` in process as the staff principal. Forwards the method, query, JSON body and the `accept`, `content-type`, `prefer`, `if-match`, `if-none-match` and `odata-*` version headers. Never uses the portal `/_api` contract. |
| `POST connectors/<reference>/<operationId>` | mock | `<reference>` is a connection-reference key or data-source name from `power.config.json`. An unknown reference answers `404`. The injected connector hook answers the call. Without a hook, or when the hook returns `undefined`, it answers `501 ConnectorNotSimulated` with the operation id and reports a `CODEAPP_CONNECTOR_NOT_SIMULATED` diagnostic. |
| `GET` (root) | mock | A loader page. When `localAppUrl` is set, it frames that URL with `allow="local-network-access"` and forwards the query string, mirroring Local Play. The page uses the model-driven shell CSP plus `frame-src <localAppUrl origin>`. Without `localAppUrl`, the page explains that the setting is missing. |

An unknown app answers `404 CodeAppNotFound`. `/_apps/code/<name>` without a trailing slash redirects (`308`) to `/_apps/code/<name>/`.

`createCodeAppsHandler({ apps, sessions, user, organization, issueToken, dataverse, connectors, csrf, diagnostic })` returns `async (req, res, url?) => boolean`. It returns `false` for any path outside `/_apps/code/`. `authorityTokenIssuer({ issueAccessToken, origin, appId })` adapts the Dataverse authority's `issueAccessToken` (`dataverse-auth.mjs`) to `issueToken`.

## Browser shim

`code-apps-client.js` exports `configure({ app, origin? })`, `getContext()`, `getToken(resource)` and `dataClient`. `dataClient` provides `create(entitySet, record)`, `get(entitySet, id, options)`, `getAll(entitySet, options)`, `update(entitySet, id, changes)`, `delete(entitySet, id)` and `execute(reference, operationId, parameters)`. Data methods resolve to `{ data }`, like the generated services do. Every call sends `credentials: 'same-origin'`, and every call sends the CSRF header once `context` has supplied it.

For Mirage runs only, alias the library in Vite and proxy `/_apps/code` to Mirage, so the app and the bridge share one origin:

```js
// vite.config.js (Mirage runs only)
export default {
  resolve: { alias: { '@microsoft/power-apps/app': '<paqvilo>/mirage/lib/code-apps-client.js' } },
  server: { proxy: { '/_apps/code': 'http://127.0.0.1:<mirage port>' } },
};
```

Call `configure({ app: '<name>' })` before the first call. Use the same host name (`localhost` or `127.0.0.1`) for the dev server and Mirage, so the browser sends the staff-session cookie.

## Limits

- Mirage does not reproduce the player's own wire protocol with `@microsoft/power-apps`, or the `pa app run` host on port 8080.
- Only the client surface above is shimmed. The generated service files call internal client APIs, so they are not drop-in compatible with the shim; code that runs against Mirage calls `dataClient` instead.
- The shim maps the `select`, `filter`, `orderBy`, `top` and `skipToken` options to OData query options.

Microsoft documentation: [overview](https://learn.microsoft.com/power-apps/developer/code-apps/overview), [architecture](https://learn.microsoft.com/power-apps/developer/code-apps/architecture), [get context](https://learn.microsoft.com/power-apps/developer/code-apps/how-to/retrieve-context), [connect to Dataverse](https://learn.microsoft.com/power-apps/developer/code-apps/how-to/connect-to-dataverse), [create an app](https://learn.microsoft.com/power-apps/developer/code-apps/how-to/create-an-app-from-scratch), [CLI](https://learn.microsoft.com/power-apps/developer/code-apps/reference/cli), [pac code](https://learn.microsoft.com/power-platform/developer/cli/reference/code).
