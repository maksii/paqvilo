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
| `tls`, `tlsPort` | `tls: true` adds an `https` listener on `tlsPort` (`0` picks an ephemeral port). Its certificate is a per-run self-signed CA written to the certificate file reported by status (`dataverse-ca.pem` beside the state file under `.paqvilo/`, reused while valid). Trust it with `NODE_EXTRA_CA_CERTS` or `REQUESTS_CA_BUNDLE`. It is never installed into the OS store. |
| `serviceProtection` | `{ requestsPer300s: <n> }` enables service-protection limits: a caller that exceeds `n` requests in a sliding 300 second window receives 429 `0x80072322` with `Retry-After`. Unset means no limit. |
| `tenantId` | Tenant in the token authority. Defaults to a GUID derived from the site id. |
| `organizationId`, `uniqueName`, `friendlyName` | Organization identity returned by `WhoAmI` and `RetrieveCurrentOrganization`. |
| `applications` | Application registrations. `roles` creates an application user with those roles. |
| `applications[].secretEnvironmentVariable` | Name of the environment variable that holds the plain client secret. |
| `users` | Interactive users. `objectId` is the Entra object id (`azureactivedirectoryobjectid`). `roles` lists role names. |

Secrets come only from environment variables. A plain secret in YAML is not accepted. The simulator stores secrets and user passwords hashed, returns a new secret once on creation, and never writes a token or secret to disk or to the request log.

`mirage status` prints the org URL (origin) and the token authority. `GET /_sim/api/dataverse` returns the same values as JSON, with `tlsOrigin`, `certificateFile` and `certificateFingerprint` when TLS is on, plus the registered applications, users (with `passwordSet`), roles and recent requests.

## Connect an SDK

Three values connect an SDK:

- **Org URL**: the `origin` printed by `mirage status`, for example `http://127.0.0.1:53124`. With `tls: true`, use `tlsOrigin` instead.
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

- **MSAL libraries** need an https authority: set `tls: true` and point the authority at `<tlsOrigin>/<tenantId>` with instance discovery disabled. `@azure/msal-node`: `knownAuthorities` containing the tlsOrigin host. MSAL Python: `validate_authority=False, instance_discovery=False`. .NET: `WithInstanceDiscovery(false)`. Trust the CA as described above; .NET clients that read only the OS store need their own trust configuration. Microsoft's Python Dataverse SDK takes `tlsOrigin` as `base_url`.
- **`Microsoft.PowerPlatform.Dataverse.Client`** drops the port from the org URL. Set `port: 80`, and use the constructor that takes a token provider. Port 80 must be free on the machine. SOAP `IOrganizationService` calls receive a SOAP fault, because only the Web API is simulated.

## Token behaviour

- `expires_in` is 3599 for a token with a 3600-second lifetime.
- `client_info` is returned when the request asks for it.
- Certificate assertions accept RS256 and PS256 and match a registered certificate by `x5t` or `x5t#S256`. A reused `jti` is rejected as a replay.
- Public clients must send PKCE with `authorization_code`.
- An authorization code is spent on any redemption attempt.
- The sign-in pickers list only interactive, enabled users with an Entra object id. SYSTEM and application users never appear.
- A configured `users` entry without `objectId` gets a deterministic object id.

## Users, roles and privileges

On start, the simulator seeds the security tables for the organization:

| Seeded item | Content |
| --- | --- |
| `organization` | One row from `organizationId`, `uniqueName` and `friendlyName`. |
| `businessunit` | The root business unit of the organization. |
| `systemuser` | `SYSTEM` (non-interactive) and each configured user. |
| `role` | `System Administrator`, `System Customizer`, `Basic User`. |
| `privilege`, `roleprivileges` | Privileges per role. System Administrator and System Customizer hold Global depth on every table. Basic User holds Basic depth on user-owned tables and Global Read on organization-owned tables. |
| `transactioncurrency` | The organization's base currency (`Base currency`). Its symbol comes from the simulator setting `currencySymbol`, default `$`. |

Application users come from two places: the `applications` list in `mirage.dataverse`, or `POST /_sim/api/dataverse/applications` at runtime. Interactive users come from `users` or `POST /_sim/api/dataverse/users`. Their roles are ordinary `systemuserroles` rows.

Interactive users sign in through the authority's local picker page at `/<tenantId>/oauth2/v2.0/authorize`, and device-code sign-in through the device page at `/common/oauth2/deviceauth`. The `password` (ROPC) grant needs a password set through the admin API (`password` on `POST` or `PATCH` users); a user without one is refused.

Privilege depth decides which rows a caller can read or change:

| Depth | Rows the caller can access |
| --- | --- |
| Basic | Rows the caller owns, or rows owned by a team the caller belongs to. |
| Local | Rows in the caller's business unit. |
| Deep | Rows in the caller's business unit and its child business units. |
| Global | All rows in the organization. |

Portal table permissions and web roles never apply to this API. Security roles never apply to the portal. The two access models are independent, so a test of one says nothing about the other.

## Ownership

User-owned tables get `ownerid`, `owninguser` or `owningteam`, and `owningbusinessunit` on create and when `ownerid` is reassigned. Only the columns the mapping declares are filled. `statecode` and `statuscode` take their defaults on create.

- Privilege depth for a user-owned row is evaluated against the owner's business unit.
- Team-inherited privileges apply as if the team were the caller. Basic covers team-owned rows. Local, Deep and Global are evaluated against the team's business unit. `RetrieveUserPrivileges` reports team grants as Basic.
- A row without an owner on a user-owned table is visible only at Global depth.

## Request handling

### Validation

- An unknown payload property answers 400, error code `0x0`, with the documented "Invalid property" message.
- An unknown property in `$select`, `$filter`, `$orderby` or `$expand` answers 400, `0x0`, "Could not find a property named ...".
- Entity sets are matched case-sensitively by set name. A logical name answers 404 `0x8006088a`.
- `$skip`, `$search` and `$format` answer 400 `0x80060888`.
- URLs up to 32,768 characters are accepted. A longer URL answers 400 `0x80060888`, "Invalid URI: The Uri string is too long."
- A path segment over 260 characters answers 400 "Bad Request - Invalid URL".
- Alternate-key values containing control characters are rejected.
- A malformed `Prefer` header answers 400 with the envelope `{ "Message", "ErrorCode": "0x80097303" }`.

### Headers

- `Preference-Applied` echoes only the preferences that were applied: `odata.include-annotations`, `odata.maxpagesize`, `return=representation`, and `odata.continue-on-error` inside `$batch`.
- `odata.track-changes` and `respond-async` are accepted but not applied. No `@odata.deltaLink` is returned.
- `MSCRM.BypassCustomPluginExecution` and `MSCRM.BypassBusinessLogicExecution` require the `prvBypassCustomPlugins` privilege, which System Administrator and System Customizer hold. They are then accepted as no-ops, because the simulated API runs no plug-ins.
- `MSCRM.SuppressDuplicateDetection`, `MSCRM.SolutionUniqueName`, `MSCRM.MergeLabels` and `Consistency` are accepted as no-ops.
- `x-ms-client-request-id` is echoed.
- Every response carries `x-ms-service-request-id`, `REQ_ID`, the rate-limit headers and `x-ms-dop-hint`.

### Impersonation

`CallerObjectId` and `MSCRMCallerID` require `prvActOnBehalfOfAnotherUser`. Rows record `createdonbehalfby` and `modifiedonbehalfby` when the mapping declares them. A disabled or unknown target is refused.

### Batch

`$batch` part errors use the Dataverse error envelope. A change set runs under the runtime's single mutation queue and is rolled back as a whole on failure (snapshot and restore). This is a local atomicity model, not transaction isolation for readers.

## Metadata

- `ownerid` and customer columns are `LookupAttributeMetadata` with `AttributeType` `Owner` or `Customer`.
- `OwnershipType` is `UserOwned`, `OrganizationOwned` or `BusinessOwned`. The security tables report `BusinessOwned`.
- `$metadata` declares the response complex types `OrganizationDetail`, `RolePrivilege` and `RetrieveMetadataChanges`, and a single `ownerid` navigation typed `principal`.
- `GlobalOptionSetDefinitions` rejects `$filter`.

## Administration

The **Dataverse API** view at `/_sim/#dataverse` shows the status (origins, authority, tenant and organization ids, certificate file and fingerprint), the registered applications with secret hints and certificate thumbprints, the users with roles, access mode and disabled state, and the recent requests. Its forms call the endpoints below with the runtime CSRF token: register an application, add a secret or a certificate (or bare public key), remove a secret or an application, create an interactive user with roles and an optional password, save roles, enable or disable a user, and reset the workspace. A created secret is shown once in the view with a copy button; dismissing it, leaving the view or reloading the page drops it, and no later read returns it. When the API is off the view shows "Dataverse API is disabled for this runtime".

### Endpoints

These endpoints live under the local administration API (`/_sim/`).

| Method and path | Effect |
| --- | --- |
| `GET /_sim/api/dataverse` | Status: origins (`origin`, `tlsOrigin`), certificate file and fingerprint, authority, tenant, applications, users (with `passwordSet`), roles, requests. |
| `POST /_sim/api/dataverse/applications` | Body `{ displayName, appId?, roles?, publicClient?, redirectUris?, allowedGrants? }`. 201 `{ appId, systemuserid, secret }`. The secret is shown once. |
| `POST /_sim/api/dataverse/applications/<appId>/secrets` | 201 `{ id, secret, hint, expiresOn }`. The secret is shown once. |
| `DELETE /_sim/api/dataverse/applications/<appId>/secrets/<id>` | 204. |
| `POST /_sim/api/dataverse/applications/<appId>/certificates` | Body `{ certificatePem }` (an X.509 certificate PEM; its SHA-1 and SHA-256 fingerprints become `x5t` / `x5t#S256`) or `{ publicKeyPem }` (a bare public key; digests of its DER SPKI). 201 `{ thumbprint, thumbprint256 }`. |
| `DELETE /_sim/api/dataverse/applications/<appId>` | Removes the registration and its application user. 204. |
| `POST /_sim/api/dataverse/users` | Body `{ fullname, domainname, objectId?, roles?, accessmode?, businessUnitId?, password? }`. 201 `{ systemuserid, azureactivedirectoryobjectid }`. |
| `PATCH /_sim/api/dataverse/users/<systemuserid>` | Body `{ roles?, isdisabled?, accessmode?, password? }`. 200. |
| `GET /_sim/api/dataverse/requests` | Ring buffer of recent Web API requests. |
| `POST /_sim/api/dataverse/token` | Test convenience: body `{ appId }` returns `{ access_token }` for an application user, without a secret round-trip. |

Every write needs the `X-Sim-CSRF` header with the runtime CSRF token. Secrets appear only in the create responses above. Subsequent reads show `hint` and `expiresOn`. A `password` is 8 to 256 characters, stored hashed, and never returned; reads show only `passwordSet`. The request log never contains tokens.

`POST /_sim/api/reset` keeps registrations and re-seeds the security tables. The security tables it seeds (`systemuser`, `role`, `businessunit` and the others) are marked as Dataverse-only mappings in the shared local state: the portal `/_api/` resolver ignores them, so enabling the API does not change which entity sets the portal recognises. Liquid FetchXML on the portal can still query those tables, subject to the portal's table permissions, exactly as it can on a live site.

## Supported surface

- Service document, and entity sets with create, read, update, delete.
- Query options `$select`, `$filter`, `$orderby`, `$top`, `$expand`, `$count` and annotations. `$skip`, `$search` and `$format` are not supported. `$apply` aggregation is passed through to the local query engine.
- Paging with the `odata.maxpagesize` preference and `$skiptoken`.
- `fetchXml` queries.
- Navigation properties and `$ref` associations.
- `$batch` with change sets and `$n` references.
- Functions and actions: `WhoAmI`, `RetrieveVersion`, `RetrieveCurrentOrganization`, `RetrieveTotalRecordCount`, `RetrieveUserPrivileges`, `RetrievePrincipalAccess`, `RetrieveMetadataChanges`.
- Metadata reads: the `$metadata` document, `EntityDefinitions`, `RelationshipDefinitions`, `GlobalOptionSetDefinitions`.
- Discovery: `Instances`.
- Documented error envelope and error codes.
- Money columns: JSON values with four decimals (`12.5000`), formatted values with the base currency symbol (`$12.50`), and `_transactioncurrencyid_value` (with its lookup annotations) on every row that returns a money column. The simulator has one currency, so every money row reports the base currency.
- Collection-bound `CreateMultiple`, `UpdateMultiple` and `UpsertMultiple`.
- OAuth 2.0 grants: `client_credentials` (client secret or certificate assertion), `authorization_code` with PKCE, `device_code`, `password` (ROPC), on-behalf-of, and `refresh_token` rotation. OpenID Connect discovery, JWKS and instance discovery.
- Impersonation through `CallerObjectId` or `MSCRMCallerID` for callers holding `prvActOnBehalfOfAnotherUser`.

## Not simulated

Not simulated, by design:

- SOAP `Organization.svc` (answers with a SOAP fault).
- Dataverse search (`/api/search/`), elastic tables, file and image column streaming.
- Solution import and export, plug-in registration through the API, the `pac` CLI.
- Metadata writes (`EntityDefinitions` POST and PUT).
- Browser-based MSAL.js sign-in beyond the minimal picker.
- Bound functions and actions other than `RetrieveUserPrivileges`, `RetrievePrincipalAccess`, `CreateMultiple`, `UpdateMultiple` and `UpsertMultiple`; `GrantAccess`, `Merge`, `WinOpportunity`, `ExecuteWorkflow` and `DeleteMultiple` answer 501.

## Evidence

The local behaviour is a simulation. Parity claims rest on the SDK gates under `mirage/test-sdk/` (opt-in `npm run test:sdk`) and on the research notes.

| Gate | Client | Proves |
| --- | --- | --- |
| `toolkit-client` | `paqvilo/dataverse` `DataverseClient` and the data loader | `WhoAmI`, metadata reads the loader needs, stable-GUID upsert with `If-None-Match`, deferred lookup binds, `$ref` association, FetchXML paging, compare and query status |
| `dynamics-web-api` | `dynamics-web-api` 2.5.1 with `@azure/msal-node` 7.1.0 | client_credentials over `authorityMetadata` (http) and over OpenID Connect discovery on the TLS listener, CRUD, `$select`/`$filter`/`$expand`/`$count`, paging, alternate keys, FetchXML paging cookies, `$batch` change sets, error codes |
| `python-dataverse` | Microsoft `PowerPlatform-Dataverse-Client` 1.1.0 with `msal` 1.39.0 | TLS `base_url`, OpenID Connect discovery with `instance_discovery=False`, picklist label resolution through `EntityDefinitions` and `OptionSet` expansion, CRUD, query builder, `CreateMultiple`, `$batch`, 400 and 404 error details |
| `webapi-samples` | Microsoft `PowerApps-Samples` WebAPIService (C#, pinned commit) | Microsoft's own request shapes: `WhoAmI`, create with `OData-EntityId`, retrieve, update, `RetrieveMultiple`, delete, `$batch` change set, `x-ms-dop-hint` |
| `serviceclient` | `Microsoft.PowerPlatform.Dataverse.Client` 1.2.27 (C#, token-provider constructor) | Port 80 (ServiceClient drops the port), `RetrieveCurrentOrganization` on v9.0 with the `Endpoints` dictionary and the version switch to v9.2, `ExecuteWebRequest` CRUD, `WhoAmI` over the Web API, and a clean `FaultException` for the SOAP `IOrganizationService` call |
| `cert-auth` | `@azure/msal-node` 7.1.0 `clientCertificate` and `Microsoft.Identity.Client` 4.91.0 `WithCertificate` (C#) | Certificate client authentication: a per-run self-signed certificate registered by its fingerprints, PS256 assertions carrying `x5t#S256` and `x5c` redeemed over the TLS authority (MSAL.NET with `WithInstanceDiscovery(false)` and a CA-trusting `IMsalHttpClientFactory`), `appidacr` 2, `WhoAmI`, the token and `WhoAmI` requests in the simulator log, and AADSTS700027 for a tampered assertion |

`npm run test:sdk` runs all six gates, and all six pass.

Gate dependencies stay out of the package: Node packages install under `mirage/test-sdk/<gate>/node_modules`, the Python environment and the cloned sample repository live under the ignored `.paqvilo/sdk-gates/`. A passing SDK gate shows that the client could authenticate and receive the documented shapes. It does not show that every live environment behaves identically.
