# Dataverse Web API simulation

Mirage serves a Dataverse-shaped Web API on its own loopback origin, beside the portal. The API shares the portal's local state (`DataStore`), but it does not change the portal `/_api/` behaviour, page rendering or `/_sim/` routes.

## Enable it

Add a `dataverse` key under `mirage:` in the catalogue, or under `sites.<id>.mirage` for one portal. See [configuration](../../docs/configuration.md).

```yaml
mirage:
  dataverse:
    enabled: true
    port: 0
    tls: false
    tenantId: 11111111-1111-1111-1111-111111111111
    organizationId: 44444444-4444-4444-4444-444444444444
    uniqueName: orgsim
    friendlyName: Simulated environment
    applications:
      - appId: 22222222-2222-2222-2222-222222222222
        displayName: Integration client
        secretEnvironmentVariable: PAQVILO_SIM_CLIENT_SECRET
        roles: ["System Administrator"]
    users:
      - domainname: maker@example.test
        fullname: Maker User
        objectId: 33333333-3333-3333-3333-333333333333
        roles: ["System Customizer"]
```

| Key | Meaning |
| --- | --- |
| `enabled` | Starts the listeners. Absent or `false` leaves the API off. |
| `port` | HTTP listener port. `0` picks an ephemeral port. Use `80` for `Microsoft.PowerPlatform.Dataverse.Client`, which drops the port. |
| `tls`, `tlsPort` | Accepted by validation; the `https` listener is not available in this build, so these keys have no effect yet. |
| `serviceProtection` | `{ requestsPer300s: <n> }` enables service-protection limits: a caller that exceeds `n` requests in a sliding 300 second window receives 429 `0x80072322` with `Retry-After`. Unset means no limit. |
| `tenantId` | Tenant in the token authority. Defaults to a GUID derived from the site id. |
| `organizationId`, `uniqueName`, `friendlyName` | Organization identity returned by `WhoAmI` and `RetrieveCurrentOrganization`. |
| `applications` | Application registrations. `roles` creates an application user with those roles. |
| `applications[].secretEnvironmentVariable` | Name of the environment variable that holds the plain client secret. |
| `users` | Interactive users. `objectId` is the Entra object id (`azureactivedirectoryobjectid`). `roles` lists role names. |

Secrets come only from environment variables. A plain secret in YAML is not accepted. The simulator stores secrets hashed, returns a new secret once on creation, and never writes a token or secret to disk or to the request log.

`mirage status` prints the org URL (origin) and the token authority. `GET /_sim/api/dataverse` returns the same values as JSON, with `tlsOrigin` when TLS is on, plus the registered applications, users, roles and recent requests.

## Connect an SDK

Three values connect an SDK:

- **Org URL**: the `origin` printed by `mirage status`, for example `http://127.0.0.1:53124`.
- **Authority**: `<origin>/<tenantId>`.
- **Scope**: `<origin>/.default`.

Request a token with `client_credentials`. The secret goes in the form body, not in the URL:

```sh
curl -s -X POST "$ORIGIN/$TENANT_ID/oauth2/v2.0/token" \
  -d grant_type=client_credentials \
  -d client_id=22222222-2222-2222-2222-222222222222 \
  -d client_secret="$PAQVILO_SIM_CLIENT_SECRET" \
  -d scope="$ORIGIN/.default"
```

Call `WhoAmI` with the `access_token` from the response:

```sh
curl -s "$ORIGIN/api/data/v9.2/WhoAmI" \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

Notes for specific clients:

- **MSAL libraries require an https authority.** This build serves plain `http` only. With `@azure/msal-node`, set `auth.authorityMetadata` to a document whose `token_endpoint` is `<origin>/<tenantId>/oauth2/v2.0/token`; the https authority host is then never contacted. MSAL for Python and .NET, and Microsoft's Python Dataverse SDK (which requires an https `base_url`), cannot connect until the https listener exists.
- **`Microsoft.PowerPlatform.Dataverse.Client`** drops the port from the org URL. Set `port: 80`, and use the constructor that takes a token provider. Port 80 must be free on the machine. SOAP `IOrganizationService` calls receive a SOAP fault, because only the Web API is simulated.

## Users, roles and privileges

On start, the simulator seeds the security tables for the organization:

| Seeded item | Content |
| --- | --- |
| `organization` | One row from `organizationId`, `uniqueName` and `friendlyName`. |
| `businessunit` | The root business unit of the organization. |
| `systemuser` | `SYSTEM` (non-interactive) and each configured user. |
| `role` | `System Administrator`, `System Customizer`, `Basic User`. |
| `privilege`, `roleprivileges` | Privileges per role. System Administrator and System Customizer hold Global depth on every table. Basic User holds Basic depth on user-owned tables and Global Read on organization-owned tables. |

Application users come from two places: the `applications` list in `mirage.dataverse`, or `POST /_sim/api/dataverse/applications` at runtime. Interactive users come from `users` or `POST /_sim/api/dataverse/users`. Their roles are ordinary `systemuserroles` rows.

Privilege depth decides which rows a caller can read or change:

| Depth | Rows the caller can access |
| --- | --- |
| Basic | Rows the caller owns, or rows owned by a team the caller belongs to. |
| Local | Rows in the caller's business unit. |
| Deep | Rows in the caller's business unit and its child business units. |
| Global | All rows in the organization. |

Portal table permissions and web roles never apply to this API. Security roles never apply to the portal. The two access models are independent, so a test of one says nothing about the other.

## Administration endpoints

These endpoints live under the local administration API (`/_sim/`).

| Method and path | Effect |
| --- | --- |
| `GET /_sim/api/dataverse` | Status: origins, authority, tenant, applications, users, roles, requests. |
| `POST /_sim/api/dataverse/applications` | Body `{ displayName, appId?, roles?, publicClient?, redirectUris?, allowedGrants? }`. 201 `{ appId, systemuserid, secret }`. The secret is shown once. |
| `POST /_sim/api/dataverse/applications/<appId>/secrets` | 201 `{ id, secret, hint, expiresOn }`. The secret is shown once. |
| `DELETE /_sim/api/dataverse/applications/<appId>/secrets/<id>` | 204. |
| `POST /_sim/api/dataverse/applications/<appId>/certificates` | Body `{ publicKeyPem }`. 201 `{ thumbprint }`. |
| `DELETE /_sim/api/dataverse/applications/<appId>` | Removes the registration and its application user. 204. |
| `POST /_sim/api/dataverse/users` | Body `{ fullname, domainname, objectId?, roles?, accessmode?, businessUnitId? }`. 201 `{ systemuserid, azureactivedirectoryobjectid }`. |
| `PATCH /_sim/api/dataverse/users/<systemuserid>` | Body `{ roles?, isdisabled?, accessmode? }`. 200. |
| `GET /_sim/api/dataverse/requests` | Ring buffer of recent Web API requests. |
| `POST /_sim/api/dataverse/token` | Test convenience: body `{ appId }` returns `{ access_token }` for an application user, without a secret round-trip. |

Every write needs the `X-Sim-CSRF` header with the runtime CSRF token. Secrets appear only in the create responses above. Subsequent reads show `hint` and `expiresOn`. The request log never contains tokens.

## Supported surface

- Service document, and entity sets with create, read, update, delete.
- Query options `$select`, `$filter`, `$orderby`, `$top`, `$expand`, `$count` and annotations. `$skip`, `$search` and `$format` are not supported.
- Paging with the `odata.maxpagesize` preference and `$skiptoken`.
- `fetchXml` queries.
- Navigation properties and `$ref` associations.
- Functions and actions: `WhoAmI`, `RetrieveVersion`, `RetrieveCurrentOrganization`, `RetrieveTotalRecordCount`, `RetrieveUserPrivileges`, `RetrievePrincipalAccess`.
- Metadata reads: `EntityDefinitions`, `RelationshipDefinitions`, `GlobalOptionSetDefinitions`.
- Discovery: `Instances`.
- Documented error envelope and error codes.
- Collection-bound `CreateMultiple`, `UpdateMultiple` and `UpsertMultiple`.
- OAuth 2.0 `client_credentials` with a client secret, `refresh_token` rotation, OpenID Connect discovery, JWKS and instance discovery.
- Impersonation through `CallerObjectId` or `MSCRMCallerID` for callers holding `prvActOnBehalfOfAnotherUser`.

## Not simulated

Not simulated, by design:

- SOAP `Organization.svc` (answers with a SOAP fault).
- Dataverse search (`/api/search/`), elastic tables, file and image column streaming.
- Solution import and export, plug-in registration through the API, the `pac` CLI.
- Metadata writes (`EntityDefinitions` POST and PUT).
- Browser-based MSAL.js sign-in beyond the minimal picker.

Not available in this build:

- `$batch`, `$apply` and the `$metadata` document.
- `RetrieveMetadataChanges`, bound functions and bulk actions.
- Delegated token flows: `authorization_code` with PKCE, `device_code`, the `password` grant, on-behalf-of, and certificate assertion for `client_credentials`.

## Evidence

The local behaviour is a simulation. Parity claims rest on the SDK gates under `mirage/test-sdk/` (opt-in `npm run test:sdk`) and on the research notes. A passing SDK gate shows that the client could authenticate and receive the documented shapes. It does not show that every live environment behaves identically.
