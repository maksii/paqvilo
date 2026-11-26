# Dataverse Web API simulation

Mirage serves a simulated Dataverse organization on its own loopback origin, separate from the portal origin. It runs
[without Power Pages](standalone-organization.md), beside model-driven apps or beside a portal; every surface shares one
organization record pipeline and store. A portal reaches Dataverse tables only through its own `Webapi/<table>/enabled`,
`Webapi/<table>/fields` and table permissions, and its visitor identity and error contracts stay separate from staff
users and application tokens. Security roles never apply to the portal, and portal table permissions and web roles never
apply to this API, so a test of one says nothing about the other.

The reasons behind the separate listeners, token handling and principals-as-rows model are in the
[design decisions](../../docs/design/dataverse-api.md).

This page describes local behaviour. Status codes, error codes and messages come from Microsoft's documentation, private
captures or local choices, and the tests that check them are local contracts, not proof that Dataverse answers the same
way. The only recorded parity cases for these surfaces (`mirage/test/parity/cases/dataverse-webapi`, `dataverse-soap`
and `tds-sql`) cover the 400 answer to unknown query options, the `Microsoft.Xrm.Sdk` serialization of SOAP values and
TDS scalar expression results compared with Microsoft SQL Server (not with the Dataverse SQL endpoint).

| Surface                    | Path or listener                                                                                                                                                                              |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web API (OData v4)         | `/api/data/v9.x/`: service document, `$metadata`, entity sets, actions and functions, `$batch`                                                                                                |
| SOAP organization service  | `/XRMServices/2011/Organization.svc` and `/web`, used by `ServiceClient` and `CrmServiceClient` ([messages](#soap-organization-service))                                                      |
| Token authority            | `/<tenantId>/oauth2/v2.0/token`, `/authorize`, `/devicecode`, `/logout`, the v1 `oauth2/token` and `oauth2/authorize`, OpenID configuration and JWKS; `common` and `organizations` also match |
| Device sign-in page        | `/common/oauth2/deviceauth`                                                                                                                                                                   |
| Discovery                  | `/api/discovery/v2.0/Instances` and its `$metadata`                                                                                                                                           |
| Dataverse search           | `/api/search/v1.0` and `/api/search/v2.0`                                                                                                                                                     |
| Background operations      | `/api/backgroundoperation/<id>` (status monitor of `Prefer: respond-async` custom API calls)                                                                                                  |
| Managed identity endpoints | `/msi/token` or `/metadata/identity/oauth2/token`, by [mode](#managed-identity-and-federated-credentials)                                                                                     |
| SQL (TDS) endpoint         | A separate loopback TCP listener, reported as `tdsPort` ([SQL endpoint](#sql-tds-endpoint))                                                                                                   |

Error responses use the Dataverse error envelope (except a malformed `Prefer` header and an unknown `MSCRMCallerID`,
described below) and never contain .NET stack traces. The JSON reader accepts one leading UTF-8 BOM and keeps numeric
literals exactly as sent, so a typed conversion error echoes your value.

## Enable it

Use **Project setup → Runtime configuration** to enable the HTTP API and choose its port, then restart Mirage. A
standalone project puts `dataverse` at its top level; a catalogue uses `defaults.mirage.dataverse` or
`sites.<id>.mirage.dataverse` (see [configuration](../../docs/configuration.md)). Model-driven staff sessions use the
organization even while the HTTP listener is off.

```yaml
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
      secretEnvironmentVariable: SIM_CLIENT_SECRET
      roles: ['System Administrator']
  users:
    - domainname: maker@example.test
      fullname: Maker User
      objectId: 33333333-3333-3333-3333-333333333333
      roles: ['System Customizer']
```

Unknown keys are refused.

| Key                                                            | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                                                      | A `dataverse` section (or `dataverse: true`) starts the listeners; `enabled` defaults to `true` inside it. No section, `dataverse: false` or `enabled: false` leaves the API off.                                                                                                                                                                                                                                                                                                                              |
| `port`                                                         | HTTP port. `0` (default) picks an ephemeral port. Use `80` for `Microsoft.PowerPlatform.Dataverse.Client`, which drops the port.                                                                                                                                                                                                                                                                                                                                                                               |
| `tls`, `tlsPort`                                               | `tls: true` adds an `https` listener on `tlsPort` (`0` is ephemeral). The certificate is a self-signed CA name-constrained to the loopback hosts, reused while valid for more than 7 days and regenerated when the hosts change, written to `dataverse-ca.pem` beside the state file under `.paqvilo/` and reported as `certificateFile`. Dry run has no state file, so the CA stays in memory and no file exists to trust. The file also holds the CA's private key. It is never installed into the OS store. |
| `serviceProtection`                                            | `{ requestsPer300s, executionMsPer300s, concurrentRequests }` per user, in a sliding 300-second window. Over the request limit: 429 `0x80072322`; over the execution-time limit: 429 `0x80072321`; over the concurrency limit: 429 `0x80072326`; all with `Retry-After`. Unset limits do not apply. `executionTimeMsPer300s` is an alias of `executionMsPer300s`.                                                                                                                                              |
| `tenantId`                                                     | Tenant in the authority. Defaults to a GUID derived from `uniqueName`.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `organizationId`, `uniqueName`, `friendlyName`                 | Organization identity returned by `WhoAmI` and `RetrieveCurrentOrganization`. `uniqueName` defaults to `orgsim`, `friendlyName` to `Simulated environment`.                                                                                                                                                                                                                                                                                                                                                    |
| `version`                                                      | Four-part version reported by `RetrieveVersion` and the SOAP organization detail. Default `9.2.25041.00000`.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `managedIdentity`                                              | `{ mode }`: `appservice` (default), `imds` or `arc`. See [managed identity](#managed-identity-and-federated-credentials).                                                                                                                                                                                                                                                                                                                                                                                      |
| `managedIdentities`                                            | `{ clientId, principalId?, displayName, roles }`; `roles` defaults to `Basic User`. Each becomes an application user.                                                                                                                                                                                                                                                                                                                                                                                          |
| `federatedIssuers`                                             | `{ issuer, jwks: { keys } }`, public keys only. They verify the RS256 client assertions of `applications[].federatedCredentials`.                                                                                                                                                                                                                                                                                                                                                                              |
| `auditing`                                                     | Sets `organization.isauditenabled`. Tables and columns are audited by their own flags. Default `false`.                                                                                                                                                                                                                                                                                                                                                                                                        |
| `duplicateDetection`                                           | Sets `organization.isduplicatedetectionenabled`. Default `true`. See [duplicate detection](#duplicate-detection).                                                                                                                                                                                                                                                                                                                                                                                              |
| `tds`                                                          | `{ enabled, port }`. Default `{ enabled: true, port: 0 }`. Port `1433` or `5558` is opt-in. See [SQL endpoint](#sql-tds-endpoint).                                                                                                                                                                                                                                                                                                                                                                             |
| `pluginTimeoutSeconds`                                         | Execution limit of a custom API's trusted handler ([custom API handlers](../../docs/project-extensions.md#custom-api-handlers)); past it the call fails with 400 `0x80040224` and its writes roll back. 1 to 3600, default `120` (the platform's 2-minute sandbox limit).                                                                                                                                                                                                                                      |
| `asyncStartDelayMs`                                            | Delay before an asynchronous plug-in step or web hook job may start after its commit, 0 to 600000, default `1000`. See [asynchronous steps](dataverse-plugins.md#asynchronous-steps-and-system-jobs).                                                                                                                                                                                                                                                                                                          |
| `maxUploadSessions`, `maxUploadBytes`                          | Memory bounds for in-flight uploads: open sessions (chunked `PATCH`, `Initialize*BlocksUpload`, SAS upload) and bytes held across them plus inline note and attachment SAS download copies. Exceeding either answers 400 naming the setting. Sessions expire after 15 minutes without a block. Defaults `32` and `268435456` (256 MiB).                                                                                                                                                                        |
| `currencyCode`, `currencySymbol`                               | Base currency (`transactioncurrency` row). Defaults `USD` and `$`.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `localeId`                                                     | Organization LCID (`organization.localeid` and `languagecode`). Default `1033`.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `gitRemoteDirectory`                                           | Local Git working directory standing in for the source-control remote. No organization URL or remote credential belongs here.                                                                                                                                                                                                                                                                                                                                                                                  |
| `applications`                                                 | Application registrations `{ appId, displayName, ... }`. `roles` creates an application user with those roles (none by default).                                                                                                                                                                                                                                                                                                                                                                               |
| `applications[].secretEnvironmentVariable`                     | Name of the environment variable holding the client secret. A `secret` or `clientSecret` key is refused.                                                                                                                                                                                                                                                                                                                                                                                                       |
| `applications[].publicClient`, `redirectUris`, `allowedGrants` | A public client may use only the authorization code, device code, refresh token and password grants. `redirectUris` are http(s) URLs. `allowedGrants` (`client_credentials`, `authorization_code`, `device_code`, `refresh_token`, `password`, `on_behalf_of`) limits the grants; default all.                                                                                                                                                                                                                 |
| `applications[].spaRedirectUris`                               | Single-page application redirect URIs: http(s), no fragment or wildcard, public clients only. See [token behaviour](#token-behaviour).                                                                                                                                                                                                                                                                                                                                                                         |
| `applications[].federatedCredentials`                          | `[{ issuer, subject, audiences }]`: trusts a client assertion from `issuer` with that `subject`. Exactly one audience; default `api://AzureADTokenExchange`.                                                                                                                                                                                                                                                                                                                                                   |
| `users`                                                        | Interactive users `{ domainname, fullname, objectId?, roles? }`. `objectId` is the Entra object id (`azureactivedirectoryobjectid`); without it a deterministic id is derived from `domainname`. `roles` defaults to `Basic User`.                                                                                                                                                                                                                                                                             |

Secrets come only from named environment variables; Administration can also generate a secret and show it once. Secrets
and user passwords are stored hashed, with private control-plane persistence selected by the
[simulation level](simulation-levels.md); dry run keeps control-plane changes in memory.

`mirage status` prints the organization URL as `dataverse api <origin>` and the token authority as `authority
<origin>/<tenantId>` (`links.dataverseApi` and `links.dataverseAuthority` with `--json`). `GET /_sim/api/dataverse`
returns the origin, the token authority and the TDS port, with the same shape on the Power Pages host and a standalone
runtime (see [endpoints](#endpoints)).

## Connect an SDK

Three values connect an SDK:

- **Org URL**: the `origin` from `GET /_sim/api/dataverse`, for example `http://127.0.0.1:53124`; with `tls: true`,
  `tlsOrigin`.
- **Authority**: `<origin>/<tenantId>`.
- **Scope**: `<origin>/.default`.

Request a token with `client_credentials` (the secret goes in the form body, not the URL), then call `WhoAmI`:

```sh
curl -s -X POST "$ORIGIN/$TENANT_ID/oauth2/v2.0/token" \
  -d grant_type=client_credentials \
  -d client_id=22222222-2222-2222-2222-222222222222 \
  -d client_secret="$SIM_CLIENT_SECRET" \
  -d scope="$ORIGIN/.default"

curl -s "$ORIGIN/api/data/v9.2/WhoAmI" -H "Authorization: Bearer $ACCESS_TOKEN"
```

Client notes:

- **MSAL** needs an https authority: set `tls: true`, use `<tlsOrigin>/<tenantId>` and disable instance discovery
  (`@azure/msal-node`: `knownAuthorities` with the tlsOrigin host; MSAL Python: `validate_authority=False` and
  `instance_discovery=False`; .NET: `WithInstanceDiscovery(false)`). Trust the CA file (`certificateFile`; none in dry
  run) with `NODE_EXTRA_CA_CERTS` or `REQUESTS_CA_BUNDLE`; .NET clients that read only the OS store need their own trust
  configuration. Microsoft's Python Dataverse SDK takes `tlsOrigin` as `base_url`.
- **`Microsoft.PowerPlatform.Dataverse.Client`** drops the port from the org URL: set `port: 80` (it must be free) and
  use the constructor that takes a token provider. `IOrganizationService` calls go to the
  [SOAP endpoint](#soap-organization-service).
- **`Microsoft.CrmSdk.XrmTooling.CoreAssembly`** (`CrmServiceClient`, .NET Framework, used by XrmToolBox) lets Entra
  validate the authority of its own authentication types, so it cannot use the local authority. Set `port: 80`, register
  an `IOverrideAuthHookWrapper` in `CrmServiceClient.AuthOverrideHook` and construct
  `CrmServiceClient(new Uri(origin), true)`. Its SOAP responses deserialize with `Microsoft.Xrm.Sdk` 9.0.

```csharp
sealed class LocalToken : IOverrideAuthHookWrapper
{
    // RequestClientCredentialsToken is yours: post client credentials to the local token endpoint and return access_token.
    public string GetAuthToken(Uri connectedUri) => RequestClientCredentialsToken();
}

CrmServiceClient.AuthOverrideHook = new LocalToken();
var client = new CrmServiceClient(new Uri("http://127.0.0.1"), useUniqueInstance: true);
```

The hook is static, so it applies to the whole process; set it before constructing the client. `GetAuthToken` returns
the bare token, without `Bearer`.

`ExternalTokenManagement Authentication Requested but not configured correctly. 003` after a restart means the
application is unknown: the token request answered `AADSTS700016` and `GET /_sim/api/diagnostics` lists a
`DATAVERSE_API` diagnostic `dataverse token refused: unknown application`. In dry run, applications registered in
`/_sim/` live only in memory; declare the application in `dataverse.applications` or register it again.

## Token behaviour

Grants: `client_credentials` (client secret or certificate assertion), `authorization_code` with PKCE, `device_code`,
`password` (ROPC), on-behalf-of and `refresh_token` rotation. OpenID Connect discovery, JWKS and instance discovery are
served. Tokens, codes and refresh tokens live in memory, so they do not survive a restart.

- `expires_in` is 3599 for a 3600-second token. `client_info` is returned when requested.
- Certificate assertions accept RS256 and PS256 and match a registered certificate by `x5t` or `x5t#S256`. A reused
  `jti` is rejected as a replay.
- Federated assertions (RS256) match a `federatedCredentials` entry by issuer, subject and audience and verify against
  the issuer's keys in `federatedIssuers`.
- Public clients must send PKCE with `authorization_code`. An authorization request to a `spaRedirectUris` URI must
  carry `code_challenge` with method `S256`, otherwise AADSTS9002325.
- A browser origin other than the listener's may redeem a code or refresh token only when it was issued to a single-page
  redirect URI of that application, the request comes from that URI's origin and carries no client credential. The
  answer then names that origin in `Access-Control-Allow-Origin` with `Vary: Origin`. Every other cross-origin
  redemption, and any client secret or assertion sent from a browser origin, is refused with AADSTS9002326. Device code,
  password and on-behalf-of requests are not affected by this rule.
- A refresh token issued to a single-page redirect URI lasts 24 hours from sign-in; rotation keeps that expiry.
- An authorization code is spent on any redemption attempt.
- Interactive users sign in through a local picker at `/<tenantId>/oauth2/v2.0/authorize` and device sign-in through
  `/common/oauth2/deviceauth`. The pickers list only enabled interactive users with an Entra object id (never SYSTEM or
  application users). A POST to either page from another origin, or `Origin: null`, answers 403 and issues nothing;
  requests with neither `Origin` nor `Sec-Fetch-Site` (SDKs, scripts) are unaffected. The pages send no CORS headers and
  cannot be framed.
- The `password` grant needs a password set through the admin API; a user without one is refused.

## Users, roles and privileges

On start the simulator seeds the security tables:

| Seeded item                               | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `organization`, `businessunit`            | One organization row and its root business unit.                                                                                                                                                                                                                                                                                                                                                                                                        |
| `systemuser`                              | `SYSTEM` (non-interactive) and each configured user.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `role`                                    | `System Administrator`, `System Customizer`, `Basic User`, and every security role of the Solution sources with its Solution id.                                                                                                                                                                                                                                                                                                                        |
| `privilege`, `roleprivileges`             | System Administrator: Global on every table and every miscellaneous privilege. System Customizer: the same, but Basic on `account`, `contact` and the activity tables, and without `prvBypassCustomPlugins`, `prvBypassCustomBusinessLogic`, `prvBulkDelete` and the step secure configuration and service endpoint tables. Basic User: Basic on user-owned tables and Global Read on organization-owned tables; nothing on tables created at run time. |
| `fieldsecurityprofile`, `fieldpermission` | The System Administrator profile and every Solution field security profile with its permissions.                                                                                                                                                                                                                                                                                                                                                        |
| `transactioncurrency`                     | The base currency from `currencyCode` and `currencySymbol`.                                                                                                                                                                                                                                                                                                                                                                                             |
| `teamtemplate`                            | Access-team templates.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `principalobjectaccess`                   | Empty. Sharing writes one row per record and principal. No role holds a privilege on it, so a Web API read answers 403 `0x80040220`; use the sharing messages instead.                                                                                                                                                                                                                                                                                  |

Application users come from `applications` or `POST /_sim/api/dataverse/applications`; interactive users from `users` or
`POST /_sim/api/dataverse/users`. Roles are ordinary `systemuserroles` rows; a configured or administered user names a
Solution role by its name. Profiles are assigned through `systemuserprofiles` and `teamprofiles`.

**Solution roles and profiles.** Roles are read from `Roles/*.xml`, `<Roles>` and the YAML layout's `roles/*.yml`
(privilege names with depths `Basic`, `Local`, `Deep`, `Global`); field security profiles from `<FieldSecurityProfiles>`
and `fieldsecurityprofiles/*.yml` (`canread`, `cancreate`, `canupdate`, `canreadunmasked`). A later Solution layer
replaces a role's privileges and a profile's permissions. A privilege the organization does not have is not granted and
is reported as `SOLUTION_ROLE_PRIVILEGE_UNKNOWN` in `state.dataverse.securityDiagnostics`. `ImportSolution` imports
roles and profiles the same way. Roles and profiles share one layer table: a managed import pushes a layer, the next
managed import replaces it unless the role or profile was changed after its last import (`AddPrivilegesRole`,
`ReplacePrivilegesRole`, `RemovePrivilegeRole`, profile edits), which stays on top. Uninstalling a managed solution
restores the layer below; uninstalling the last solution that carries a role or profile removes it with its privileges
or field permissions and its user and team associations.

**Caller resolution.** A delegated token (`idtyp` `user` or an `scp` claim: authorization code, device code, password,
on-behalf-of and refresh grants) resolves the user whose `azureactivedirectoryobjectid` is the token's `oid`, never the
client application's user. When that user no longer exists, the Web API answers 401 `0x80072560` ("The user is not a
member of the organization.") and TDS refuses the login. An application token (client credentials, managed identity)
resolves the application user of its `appid`.

**Ownership and audit columns.** Every write stamps `createdby` and `modifiedby`, plus `createdonbehalfby` and
`modifiedonbehalfby` under impersonation. User-owned tables receive `ownerid`, `owninguser` or `owningteam`, and
`owningbusinessunit` on create and on an `ownerid@odata.bind` reassignment. These columns are written whether or not the
export declares them, so depth checks always have an owner and a business unit. `statecode` and `statuscode` take their
defaults on create.

**Depth.** A user-owned row is evaluated against its owner's business unit; a user-owned row without an owner is visible
only at Global depth.

| Depth  | Rows the caller can access                                       |
| ------ | ---------------------------------------------------------------- |
| Basic  | Rows the caller owns, or owned by a team the caller belongs to.  |
| Local  | Rows in the caller's business unit.                              |
| Deep   | Rows in the caller's business unit and its child business units. |
| Global | All rows in the organization.                                    |

Team privileges apply as if the team were the caller: Basic covers team-owned rows, and Local, Deep and Global are
evaluated against the team's business unit. `RetrieveUserPrivileges` reports team grants as Basic.

**Sharing** adds to depth: a row shared with the caller or one of its teams is accessible for the rights in the share's
mask, but the table privilege is still required. `GrantAccess` and `ModifyAccess` take
`{ Target, PrincipalAccess: { AccessMask, Principal } }` (`GrantAccess` ORs the mask into an existing share,
`ModifyAccess` replaces it); `RevokeAccess` takes `{ Target, Revokee }`. Entity parameters look like
`{ "widgetid": "<guid>", "@odata.type": "Microsoft.Dynamics.CRM.widget" }`, and `AccessMask` is a list such as
`ReadAccess, WriteAccess`. The caller needs Share on the target. Only `systemuser` and `team` principals are supported;
an `organization` principal answers 400 `0x80040203` ("Invalid argument."). `RetrievePrincipalAccess` reports shared and
role rights together and takes the target as a reference, not an entity:
`systemusers(<id>)/Microsoft.Dynamics.CRM.RetrievePrincipalAccess(Target=@t)?@t={"@odata.id":"widgets(<guid>)"}`.
Cascading shares are described under [cascade](dataverse-contract-modules.md#cascade).

## Request handling

### Validation

- Decimal and Money request values: `Content-Type: application/json; IEEE754Compatible=true` selects JSON strings;
  otherwise JSON numbers. Each `$batch` part uses its own `Content-Type`. Strings are parsed as invariant Decimal
  (96-bit coefficient, at most 28 fractional digits) before column precision and range checks. Responses always write
  Decimal, Money and Int64 as JSON numbers, exactly: `12345678.1234567891`, `922337203685477.5807` and
  `9223372036854775807` round-trip, also in `$batch`.
- An unknown payload property, or an undeclared navigation binding, answers 400 `0x80048d19` ("Invalid property"). The
  binding rules are in [navigation binding](dataverse-parity.md#navigation-binding).
- An unknown property in `$select`, `$filter`, `$orderby` or `$expand` answers 400 `0x80060888` ("Could not find a
  property named ..."). The portal `/_api/` has its own codes; see [Dataverse queries](dataverse-parity.md).
- Entity sets match case-sensitively by set name; a logical name or another casing answers 404 `0x80060888`
  ("Resource not found for the segment ...").
- `$skip` and `$format` answer 400 `0x80060888`; OData `$search` answers 501 `0x8006088a`.
- URLs up to 32,768 characters are accepted; a longer one answers 400 `0x80060888` ("Invalid URI: The Uri string is too
  long."). A path segment over 260 characters answers 400 "Bad Request - Invalid URL". Request bodies are limited to
  128 MB (413 `0x8004418a`).
- `$filter` nests parentheses, lambdas and function calls up to 100 levels.
- Alternate-key values containing control characters are rejected.
- A malformed `Prefer` header (an unterminated quoted string, or `\` outside quotes) answers 400
  `{ "Message", "ErrorCode": "0x80097303" }`. Unknown or empty preferences are ignored.

### Headers

- `Preference-Applied` echoes only applied preferences: `return=representation`, `odata.include-annotations`,
  `odata.maxpagesize` (paged responses) and `odata.track-changes` (tracked collections). `odata.continue-on-error` and
  `respond-async` are never echoed.
- `Prefer: respond-async` applies to custom API calls only (202 with a `Location` status monitor, see
  [async operations](#async-operations)); elsewhere it is accepted and ignored.
- `MSCRM.BypassCustomPluginExecution` needs `prvBypassCustomPlugins`; `MSCRM.BypassBusinessLogicExecution` and
  `MSCRM.BypassBusinessLogicExecutionStepIds` need `prvBypassCustomBusinessLogic`. Both privileges are System
  Administrator only. See [bypass](dataverse-plugins.md#bypass-and-business-logic-ownership).
- `MSCRM.SuppressDuplicateDetection: false` turns the duplicate check on. `MSCRM.SolutionUniqueName` records metadata
  writes as solution components; `MSCRM.MergeLabels` and `Consistency` are accepted as no-ops.
- `x-ms-client-request-id` is echoed. Every response carries `x-ms-service-request-id`, `REQ_ID` and `x-ms-dop-hint`.
  Authenticated responses carry `x-ms-ratelimit-burst-remaining-xrm-requests` and
  `x-ms-ratelimit-time-remaining-xrm-requests` only while the matching `serviceProtection` limit is set.

### Impersonation

`CallerObjectId` and `MSCRMCallerID` require `prvActOnBehalfOfAnotherUser` (403 `0x80040220` without it). A disabled
target answers 401 `0x80040225`; an unknown `MSCRMCallerID` answers 404 `0x80040217` in the legacy `_error` body
(`Code`, `Description`, `ErrorCode`, ...), not the envelope. Metadata writes and metadata messages (table, column,
relationship, option set and key definitions, publish, solution import, export and component messages) check the
privilege against the intersection of the caller's and the impersonated user's privileges: an administrator
impersonating a user without it gets 403 `0x80040220` naming the impersonated principal.

### Batch

`$batch` supports change sets, `$n` references and JSON batch (`{ "requests": [...] }`, run in `dependsOn` order and
answered in multipart form), up to 1,000 requests per batch (more answer 400 `0x80048d19`). Part errors use the
Dataverse envelope. Nested change sets and `GET` inside a change set are refused. Without `Prefer:
odata.continue-on-error` the batch stops at the first failing part and answers with that part's status; parts that
already ran stay applied. A change set rolls back as a whole and answers only its failing part, and reads never see a
partly applied change set; this is local queued atomicity, not distributed transaction behaviour.

### Change tracking

`Prefer: odata.track-changes` on a collection read is applied. The last page carries `@odata.deltaLink`, whose
`$deltatoken` names the store revision. Following it answers `…/$delta` with the changed rows (selected columns), one
`…/$deletedEntity` entry per deleted row (`id`, `reason: "deleted"`) and a new delta link. The change log is in memory,
keeps the last 10,000 changes, and is reset by a restart and, on the Power Pages host, by `POST /_sim/api/reset`.

| Case                                                                                   | Answer                                                                                              |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Token from before a restart or reset, trimmed from the log, or not issued by this host | 400 `0x80044352` (ExpiredVersionStamp), "Please perform a full sync."                               |
| Malformed `$deltatoken`                                                                | 400 `0x80060888`, "The $deltatoken is not valid."                                                   |
| `$filter`, `$orderby`, `$expand`, `$top`, `fetchXml` or `$apply` with tracking         | 400 `0x80060888`, "isn't supported when Change Tracking is enabled."                                |
| A table whose metadata sets `ChangeTrackingEnabled` false                              | 400 `0x80072491`, "Entity … isn't enabled for change tracking."                                     |
| Caller without Global read on the table                                                | 403 `0x80040220` for `prvRead<Table>`, because the delta lists deleted ids of rows it might not see |

A table created through `EntityDefinitions` is tracked only when the POST or a later PUT sets `ChangeTrackingEnabled`
true; omitted, it is off.

## Queries and metadata

- Query options `$select`, `$filter`, `$orderby`, `$top`, `$expand`, `$count`, annotations and `$apply` (run by the
  local query engine). Paging with `odata.maxpagesize` and `$skiptoken`. Navigation properties and `$ref`.
- `fetchXml` queries, and `savedQuery=<id>` / `userQuery=<id>` from stored FetchXML (a many-to-many navigation in a
  predefined query answers 501).
- Collation: grouping and distinct compare under the organization collation (`settings.collation`, default `CI_AI`, as
  `$filter` equality): OData `groupby`, FetchXML `distinct`, `groupby` and `countcolumn` with `distinct`, and TDS
  `DISTINCT`, `GROUP BY`, `UNION` and string comparisons fold case and accents; an `_AS` collation keeps accented
  variants apart. A folded group answers the value of its first stored row.
- Primitive `/$value` and `/$count` text responses carry the Dataverse UTF-8 BOM, also in batch parts.
- Money columns answer four decimals (`12.5000`), formatted values with the base currency symbol (`$12.50`), and
  `_transactioncurrencyid_value` with its annotations. All money rows report the base currency.
- The service document and CSDL advertise `EntityDefinitions`, `RelationshipDefinitions` and
  `GlobalOptionSetDefinitions` beside the entity sets the exported model defines. `$metadata` declares the complex types
  `OrganizationDetail`, `RolePrivilege` and `RetrieveMetadataChanges` and a single `ownerid` navigation typed
  `principal`. `ownerid` and customer columns are `LookupAttributeMetadata` with `AttributeType` `Owner` or `Customer`.
  `OwnershipType` is `UserOwned`, `OrganizationOwned` or `BusinessOwned` (the security tables).
  `GlobalOptionSetDefinitions` rejects `$filter`.
- Operations are declared from a platform contract catalogue that keeps native action/function kinds, overloads,
  parameter order, nullability and nested types; project custom APIs keep their authored signatures. A declared
  operation does not mean every option's business semantics are implemented.

## Messages

An unknown action, or an operation called with the wrong verb, answers 404 "No HTTP resource was found ...", with an
empty error code; an unknown function call (`Name()`) answers 404 `0x80060888` ("Resource not found for the segment
..."). Operations declared with platform signatures but not implemented answer 501 unless a project handler
supplies one: synchronous `UninstallSolution` and `ImportSolutions`, `_Downloademailasattachment`,
`_InvokeHideReserveEntities`, `_SyncKnowledgeManagementSettings` and `cascadeAsync_SuccessAPI`.

### Records and bulk

- Create, read, update, delete and upsert. Upsert by alternate key (`PATCH /<set>(<key>=<value>)` without `If-Match`,
  `UpsertMultiple`, SDK `Upsert`): when the record exists, body values for the URL key columns are dropped; when it does
  not, the body's key values win and only missing ones are copied from the URL.
- Collection-bound `CreateMultiple`, `UpdateMultiple` and `UpsertMultiple`. `DeleteMultiple` deletes on elastic tables;
  on a standard table it validates `Targets` (empty: 400 `0x80040216`), runs bulk and per-record PreValidation, then
  answers 405 `0x8004023b` "DeleteMultiple has not yet been implemented" and deletes nothing.
- `WhoAmI`, `RetrieveVersion`, `RetrieveCurrentOrganization`, `RetrieveTotalRecordCount`, `RetrieveUserPrivileges`,
  `RetrievePrincipalAccess`, `RetrieveMetadataChanges`, `GrantAccess`, `ModifyAccess`, `RevokeAccess`.
- `Merge` for `account`, `contact`, `lead` and `incident`: the target gains the subordinate's empty values and
  `UpdateContent` applies (not on `incident`); ownership, audit and state columns are never copied.
- `InitializeFrom`, `CalculateRollupField`, `IsValidStateTransition` and `FormatAddress`.
- `activitypointer` is a read-only view over the activity tables, read through each source table's privileges,
  ownership and sharing. A read needs `prvReadActivity`; `$filter`, `$orderby`, `$count` and paging work on the combined
  rows, single-row `$expand`, property and `$value` reads go to the source table, and other verbs are refused.

### SOAP Organization service

`/XRMServices/2011/Organization.svc/web` answers these messages through the same record handlers; any other message
answers a SOAP fault (HTTP 500):

- Body operations: `Create`, `Retrieve`, `RetrieveMultiple`, `Update`, `Delete`, `Associate`, `Disassociate`.
- Execute messages: `Upsert`, `Assign`, `SetState`, `WhoAmI`, `RetrieveVersion`, `RetrieveCurrentOrganization`,
  `ExecuteMultiple`, `ExecuteTransaction`.
- Queries: `QueryExpression`, `QueryByAttribute` and `FetchExpression`, run as FetchXML.
- Metadata: `RetrieveEntity`, `RetrieveAttribute`, `RetrieveAllEntities`, `RetrieveOptionSet`,
  `RetrieveAllOptionSets`, `RetrieveRelationship` and `RetrieveMetadataChanges` (typed nested metadata queries and
  deletion stamps).
- Any registered Web API action or function, named by `RequestName` on a generic `OrganizationRequest`
  (`ExecuteWorkflowRequest` among them).

### Metadata writes

Metadata writes need the message's metadata privilege (`prv*Entity` or `prv*Attribute`), which System Administrator and
System Customizer hold, and a [simulation level](simulation-levels.md) that allows schema changes: in dry run they
answer 403 `0x80040216` ("Schema changes require deep simulation. ...").

- Tables: `EntityDefinitions` POST, PUT, DELETE. A created table is user-configured and `dataverseOnly`; seeded and
  Solution tables are read-only at table level. `IsAuditEnabled` (`{ "Value": true }`) in a POST or PUT turns table
  auditing on or off; without it a new table is not audited.
- Columns: `Attributes` POST, PUT, DELETE; they are kept with the table across Solution refreshes. PUT and DELETE
  address the column as `Attributes(<MetadataId>)` or `Attributes(LogicalName='…')`. `IsSecured` and `IsAuditEnabled`
  in a POST or PUT turn column security and column auditing on or off. A file or image column's `MaxSizeInKB` (a
  positive integer on PUT), and an image column's `CanStoreFullImage`, are stored on POST and PUT, and every upload
  route enforces the stored `MaxSizeInKB`.
- Alternate keys: `Keys` POST and DELETE (`Keys(<MetadataId>)` or `Keys(LogicalName='…')`). A new key is `Pending`
  with a system job `Create index for {key} for table {table}` that checks its non-empty values under the record
  pipeline's collation: unique values make it `Active`, duplicates make it `Failed` and fail the job naming them.
  `ReactivateEntityKey` reruns the job. Keys imported by `ImportSolution` get the same job; a seeded key whose rows
  already repeat starts Failed with an `ALTERNATE_KEY_DUPLICATES` diagnostic.
- Relationships: `RelationshipDefinitions` POST (one-to-many, many-to-many), PUT and DELETE.
- Lookups: `CreateCustomerRelationships`, `CreatePolymorphicLookupAttribute`.
- Choices: `GlobalOptionSetDefinitions` POST, PUT, DELETE; `InsertOptionValue`, `UpdateOptionValue`,
  `DeleteOptionValue`, `OrderOption`, `InsertStatusValue`, `UpdateStateValue`.
- `PublishXml` and `PublishAllXml` are accepted (writes already apply) and run the plug-in steps registered on the
  `Publish` and `PublishAll` messages; `PublishAllXmlAsync` is a type 204 system job.

### Files and images

- Single upload: `PATCH` of a file or image column with the bytes as body. Chunked: `InitializeFileBlocksUpload`,
  `UploadBlock`, `CommitFileBlocksUpload` (sessions live in memory; a restart drops them).
- Download: `$value` (ranged reads included), `InitializeFileBlocksDownload` and `DownloadBlock`. `DeleteFile` clears
  the column.
- Downloads answer `Content-Disposition` with `filename=<name>` when the name is an HTTP token, else a quoted ASCII
  fallback and `filename*=UTF-8''<name>`. `x-ms-file-name` on
  a download is the name when printable ASCII, else its UTF-8 percent-encoding; an upload header in raw UTF-8 bytes is
  decoded. A file's MIME type comes from its extension.
- File and image columns come from the table mapping's `fields` and its Solution `fieldMetadata`. The size limit is the
  column's `MaxSizeInKB`: a project mapping's `MaxSizeInKB`, the value a metadata POST or PUT stored, or the exported
  `MaxValue` of a Solution file or image column; without one, the file and image defaults apply. An upload over it
  answers 400 ("Attachment file size is too big." for a file; "Error occured when processing image. Reason: File size
  is too big. …" for an image), for a single `PATCH` and for each `UploadBlock` alike. An image whose blob is missing
  reads null and records `STORAGE_OBJECT_MISSING` (see [storage providers](storage-providers.md#routing)).

### Solutions

- `ExportSolution` (`prvExportCustomization`) returns the zip as `ExportSolutionFile`, including metadata written with
  `MSCRM.SolutionUniqueName`. A base solution with child patches cannot be exported until they are removed or rolled up.
  `ExportSolutionAsync` and `DownloadSolutionExportData` expose the job and download.
- `ImportSolution` (`prvImportCustomization`) reads `CustomizationFile` (base64 zip): tables, supported columns, global
  choices, relationships and alternate keys, plus app, site-map, form, view and workflow definitions with their GUIDs
  and opaque asset bytes. A failed import rolls everything back and keeps the failure in its `importjob` row; a file
  that is not a solution archive answers 400 `0x80060888` before any `importjob` row exists.
  `ImportSolutionAsync` answers `AsyncOperationId` and `ImportJobKey` and imports on a later tick.
- Layers: each managed import adds a layer to the component's stack. The incoming definition becomes active when its
  layer is the top managed layer and no unmanaged customization is on top; `OverwriteUnmanagedCustomizations` only
  decides whether such a customization is replaced. Managed tables, keys, relationships and global choices report
  `IsManaged: true`, and so does every column of a managed table, its primary name and system columns included. A
  metadata `DELETE` of one answers `0x8004F013` ("Deletion cannot be performed when … is managed (solution …)"; the
  400 status is a local choice), and a `PUT` is accepted (as an unmanaged layer on top) only while the top managed
  layer is customizable, else 400 `0x80047008` ("The specified attribute <table>.<column> is not customizable", or
  "The specified entity <table> is not customizable" for a table). The archive's `IsCustomizable` on a table
  (`<entity>`) and on a column decides it. `RemoveActiveCustomization`, `RemoveActiveCustomizations` (a function:
  `RemoveActiveCustomizations(SolutionComponentName='attribute',ComponentId=…)`) and
  `BulkRemoveActiveCustomizationsAsync` restore the top managed definition.
  `RetrieveComponentLayers(ComponentId=…,SolutionComponentName='attribute')` lists the layers bottom first as
  `msdyn_componentlayer`-style rows (empty for a component no managed solution carries); this function is Mirage's
  own.
- `CloneAsPatch`, `CloneAsSolution`, `StageSolution` (checks without importing), `StageAndUpgrade` (and async),
  `DeleteAndPromote` and `UninstallSolutionAsync` (removes a managed solution's components after a dependency check and
  restores the layer below). Failed imports and blocked removals keep the prior state.
- `AddSolutionComponent`, `RemoveSolutionComponent`, `UpdateSolutionComponent` (stores its setting strings
  uninterpreted), dependency queries and async component additions share one membership model. A metadata component's
  id is its `MetadataId`, the one the metadata endpoints return; a relationship's derives from its lower-cased schema
  name.
- Model-driven apps come from selected Solution sources or imported archives and share the API store: app, form and view
  edits, sitemap association, membership and deletion tombstones survive restart and export/re-import.
- Limits: a zip is bounded to 128 MiB compressed, 256 MiB uncompressed and 10,000 entries; persisted import layers to
  256 and 256 MiB. Imported scripts, assemblies, controls and workflow XAML are retained but never executed by the
  import; `PublishWorkflows` does not activate imported workflows; export-settings flags are not modelled.

### Custom APIs

Custom APIs come from the Solution's `customapi` rows. Unbound, entity-bound and collection-bound functions answer GET,
actions POST. Without a handler, response properties take their defaults. A trusted pack can supply a handler
([custom API handlers](../../docs/project-extensions.md#custom-api-handlers)); a Dataverse Function or an uploaded or
trusted plug-in can be the main operation ([plug-ins](dataverse-plugins.md#custom-apis-and-dataverse-functions)).

### Add-on messages

Messages of other Power Platform services are registered with their platform signatures and are stand-ins: a trusted
pack's `dataverseMessages` handler for the message name wins, then a local store-backed behaviour where one exists,
else the default refusal. Several response shapes and error codes are local choices, not captured native answers.

- AI Builder, AI functions and Copilot (`Predict` and others): refused with 403 `0x80048d06` unless a fixture answers;
  see [service fixtures](service-fixtures.md).
- Power Automate work queues (`EnqueueWorkQueueItem`, `Dequeue`, `ClearWorkQueue` and others): store-backed.
- Git source control (`ConnectToGit`, `CommitToGit`, `PullChangesFromGit` and others): against the local directory in
  `gitRemoteDirectory`, without network or a git binary.
- Power Automate desktop flows, Copilot Studio bots, Dynamics 365 application messages, feature controls and
  ALM/analytics probes: partly store-backed; the rest answer a feature-not-enabled or internal-only refusal.

### Duplicate detection

Rules come from `duplicaterule` rows and their `duplicaterulecondition` rows (a condition names its rule through
`regardingobjectid@odata.bind`); only published rules apply. Create and update are checked only when the request sends
`MSCRM.SuppressDuplicateDetection: false`, and only while `isduplicatedetectionenabled` is on. A duplicate answers 412
`0x80040333`. Rule operators `0` to `6` are supported (exact match, same first or last characters, same date, same date
and time, picklist label and value); matching ignores case unless the rule sets `iscasesensitive`.
`PublishDuplicateRule` (bound to the rule) and `UnpublishDuplicateRule` (unbound, `{ "DuplicateRuleId": "<id>" }`)
switch a rule on and off, `RetrieveDuplicates` returns the rows the published rules match for a `BusinessEntity`, and
`BulkDetectDuplicates` runs the rules over a table as a system job.

### Auditing

The organization flag (the `auditing` key, or `PATCH /_sim/api/dataverse/environment` `{ "auditing": true }`) enables
auditing; tables and columns are audited by their own `IsAuditEnabled` flags. A table's flag comes from its Solution
`Entity.xml` (`<IsAuditEnabled>1</IsAuditEnabled>` on `<entity>`) or from an `EntityDefinitions` POST or PUT; a
column without a flag is audited. Tables imported from a Solution (columns in `fieldMetadata` only) are audited and
readable like any other. Writes through the portal and `/_sim/` are audited too, and so are:

- shares (`GrantAccess` 14, `ModifyAccess` 48, `RevokeAccess` 49) on an audited table;
- role assignments, from the user, team or role side: Assign Role To User 55, Remove Role From User 56, Assign Role To
  Team 53 and Remove Role From Team 54, recorded on the user or team whenever organization auditing is on;
- role privilege changes (`AddPrivilegesRole` 57, `RemovePrivilegeRole` 58, `ReplacePrivilegesRole` 59), recorded on
  the role when the `role` table is audited (a Solution `Entity.xml` for `Role` with `IsAuditEnabled` 1).

- `RetrieveRecordChangeHistory(Target=@t)?@t={"@odata.id":"<set>(<id>)"}` answers `AuditDetailCollection`, newest
  first; `RetrieveAttributeChangeHistory(Target=@t,AttributeLogicalName='<column>')` keeps the entries that changed
  that column (an unknown column answers 400 "`<column>` is not a valid attribute of `<table>`.");
  `audits(<id>)/Microsoft.Dynamics.CRM.RetrieveAuditDetails()` answers one `AuditDetail` with `OldValue` and
  `NewValue`. They need `prvReadRecordAuditHistory` and `prvReadAuditSummary`.
- `DeleteRecordChangeHistory` (needs `prvDeleteRecordChangeHistory`) takes `Target` as `{ "@odata.id": "<set>(<id>)" }`
  or as a typed reference `{ "@odata.type": "Microsoft.Dynamics.CRM.<table>", "<primary id>": "<id>" }` and answers
  `DeletedEntriesCount`; any other `Target` answers 400 "Target must be an entity reference.". `DeleteAuditData`
  (`EndDate` required) deletes the rows created before it.
- `GetAuditStorageDetails` answers synthetic sizes (the JSON length of the rows per table, `ObjectTypeCode` 0) and
  `RetrieveAuditPartitionList()` one placeholder partition.

### Async operations

- `BulkDelete` (`prvBulkDelete`, System Administrator only) queues a system job and returns its `JobId`. The job runs
  later as the submitter through the record handlers; an empty `QuerySet` answers 400. `StartDateTime` postpones it;
  `RecurrencePattern` accepts `FREQ=HOURLY`, `DAILY`, `WEEKLY` or `MONTHLY` with an optional `INTERVAL`, and any other
  form answers 501 `0x80040216` ("Only FREQ=HOURLY, DAILY, WEEKLY or MONTHLY with an INTERVAL is simulated for
  RecurrencePattern."). Each run writes a
  `bulkdeleteoperation` row and a `bulkdeletefailure` row per row it could not delete. Jobs resume after a restart.
- A custom API call with `Prefer: respond-async` answers 202 and runs as a background operation; its status monitor is
  `GET` or `DELETE` on `/api/backgroundoperation/<id>`, outside `/api/data`.

### Workflows

- The Solution's `Workflows` folder seeds one `workflow` row per data file (classic XAML and cloud flow JSON) and an
  activation row (type 2) for each activated definition. A PATCH of only `statecode` (and `statuscode`) activates or
  deactivates. Other changes to an activated definition answer 400 `0x80045002`, any change to an activation row
  `0x80045003` and its deletion `0x80045004`; activating an automatic workflow without triggers answers `0x80045018`,
  and activating a Solution row whose `Type` is neither a definition (1) nor a template (3) `0x8004500D` ("Only
  workflow definition or draft workflow template can be published."). A Web API create with another `type` answers 400
  `0x8004431a` ("… The value 9 of 'type' on record of type 'workflow' is outside the valid range. Accepted Values:
  1,2,3"), and creating a classic workflow with XAML through the Web API answers 400 `0x80040203`.
- `POST workflows(<id>)/Microsoft.Dynamics.CRM.ExecuteWorkflow` with `{ "EntityId": "<id>" }` returns the
  `asyncoperationid` of a job of type 10 (Workflow). A background classic run and every cloud flow run is that job; a
  real-time classic run executes inside the request and answers the empty id. Refusals (400): no `EntityId`
  `0x80040203`, a draft `0x80045047`, a classic workflow that is not on-demand `0x80045046`, a cloud flow that is not
  on-demand `0x80060479` or not Dataverse-triggered `0x80060476`.
- `POST workflows(<template id>)/Microsoft.Dynamics.CRM.CreateWorkflowFromTemplate` with `{ "WorkflowName": "…" }`
  copies a template (type 3) into a new draft definition; another row type answers 400 `0x80040203`.
- Classic XAML is never interpreted. A run uses a trusted pack handler
  (`workflows: { '<workflowid or uniquename>': handler }`, see [project extensions](../../docs/project-extensions.md))
  or a mode set in `/_sim/`; otherwise it is a placeholder: a background job ends Canceled with "Simulator: classic
  workflow XAML is not executed; register a trusted pack workflow handler or a mock." and both kinds record a
  `WORKFLOW_PLACEHOLDER` diagnostic. Handler and mock runs write a `workflowlog` row (a handler's `{ message }` is the
  job's and the log's `message`); a real-time failure with `syncworkflowlogonfailure` writes a `processsession` row. A
  failed real-time run, from a handler's error or a mock set to status 31, answers 400 `0x80040265` with its message
  (a handler's own Dataverse error keeps its code). A chain of runs that start one another runs 16 times; the 17th is
  cancelled (job status 32, `errorcode` `0x80044182`, which the Web API returns as the signed integer -2147204734,
  "This workflow job was canceled because the workflow that started it included an infinite loop. …"). Background runs
  are committed jobs ([asynchronous steps](dataverse-plugins.md#asynchronous-steps-and-system-jobs)).
  Preflight lists active definitions as `classic-workflow:<workflowid>` requirements. A trusted handler satisfies the
  requirement. Placeholder, mock and disabled choices remain visible to a scenario that requires the workflow.

### Model-driven app customization

`RetrieveAppComponents`, `AddAppComponents`, `RemoveAppComponents` and `ValidateApp` expose app membership; additions
validate every source reference first and are idempotent. `InstantiateFilters` copies referenced system-view templates
into personal queries owned by the bound user. Reports expose their definition and categories; rendering is not
implemented.

### Elastic tables and search

Elastic records have partition-aware identity and expiry (`ttlinseconds`); the same primary id can exist in distinct
partitions, and bulk operations keep each target's partition. `ExecuteCosmosSqlQuery` evaluates a Cosmos SQL subset
locally and returns an `expando` result with scoped paging cookies; unsupported SQL fails explicitly.

Dataverse search actions and `/api/search/v1.0` and `v2.0` apply the caller's security and field security. Search is a
local token matcher: no distributed index, Lucene, fuzzy matching, boosting or proximity.

### Security messages and field security

- Privileges: `AddPrivilegesRole`, `RemovePrivilegeRole`, `ReplacePrivilegesRole`, `RetrieveRolePrivilegesRole`,
  `RetrieveUserPrivilegeByPrivilegeName`, `RetrieveUserPrivilegeByPrivilegeId`, `RetrieveUserSetOfPrivilegesByNames`,
  `RetrieveUserSetOfPrivilegesByIds`, `RetrieveTeamPrivileges`.
- Teams and hierarchy: `AddMembersTeam`, `RemoveMembersTeam`, `AddUserToRecordTeam`, `RemoveUserFromRecordTeam`,
  `SetBusinessSystemUser`, `SetParentSystemUser`, `RetrieveBusinessHierarchyBusinessUnit`. Access-team lifecycle is
  described in [Dataverse queries](dataverse-parity.md#access-team-membership).
- Entra users: `RetrieveAadUserRoles`, `RetrieveAadUserPrivileges`. Sharing: `RetrieveSharedPrincipalsAndAccess`,
  `RetrieveAccessOrigin`.
- Field security: profiles, field permissions, field sharing and masking rules; `RetrievePrincipalAttributePrivileges`.
  - **One read projection.** Every read route (entity, collection, property, `$value`, navigation, `$expand`, FetchXML
    with link-entities, `$apply`, change tracking, SOAP and TDS) applies computed columns, then column security, then
    masking. An unreadable secured column is null (`$value` answers 204).
    `api.records.projectRow(context, logical, row, { select, unmask, single })` applies the same projection outside the
    Web API.
  - **Masking.** A secured column with an `attributemaskingrule` reads masked for every principal, System Administrators
    included: each match of the rule's regular expression becomes one `maskedcharacter`. The case-sensitive
    `UnMaskedData=true` query option (SOAP: the `UnMaskedData` parameter) returns clear values when `CanReadUnmasked`
    allows it: All Records (3) on every read, One Record (1) on single-record reads. Other casings answer 400
    `0x80060888`; without the permission the read answers 200 masked. Rules run as JavaScript regular expressions; one
    that cannot compile reads null with `MASKING_RULE_UNSUPPORTED`. Audit details show masked values; unmasked reads
    write no audit row.
  - **Unreadable columns in queries** evaluate as null in every operand (`$filter` with navigation paths and lambdas,
    `$orderby`, `$expand` options, `$apply`, FetchXML conditions, orders and link-entities), so a right and a wrong
    guess answer alike. An aggregate or `groupby` over one answers 403 `0x8004f508`. Lookups cannot be secured, so joins
    keep working.
  - **Masked columns in queries.** A masked column the read does not unmask cannot be a filter, order, `groupby`,
    `distinct` or aggregate operand (FetchXML `count`/`countcolumn` excepted) on any route: Web API, FetchXML, the local
    organization service (`query()`, `fetch()`, connector List rows), `ExportRetainedData` and `ExecuteCosmosSqlQuery`
    on `c.props.<column>`. These answer 400 `0x80041155` "Filtering on masked attributes without the read unmasked
    column permission is not allowed." TDS applies the same rule and answers error 50000 with that message for a masked
    column in `WHERE`, `JOIN ... ON`, `GROUP BY`, `HAVING`, `ORDER BY` (expression, name or ordinal), `DISTINCT`,
    `UNION` without `ALL`, or as an aggregate argument (`COUNT(column)` is allowed, `COUNT(DISTINCT column)` is not).
    The select list and `UNION ALL` show the masked value. A scalar subquery that returns a masked column compares the
    masked text, so a guess of the clear value matches no row.
  - `ExecuteCosmosSqlQuery` documents, `InitializeFrom` answers and the `ExportRetainedData` workbook carry hidden
    columns as null and masked columns masked.

**Record hooks** (extension authors). Write hooks run in three stages: `beforeWrite` (pre-operation, before the store
write), `external` (the main operation, after the store write passed every check, inside its transaction; virtual-table
providers use it) and `afterWrite` (post-operation). `external` and `afterWrite` hooks share one info object, so an
`external` hook that re-keys a created row sets `info.id` for later hooks. `api.recordHooks.add(name, fn, module)` takes
an optional module name that refusals name. Non-Web API writers (plug-ins, flows, the portal) run the same hooks; see
[one write pipeline](dataverse-parity.md#one-write-pipeline). Only text columns with the Email format and Email-typed
columns are normalized to lower case.

### Managed identity and federated credentials

`managedIdentity.mode` picks the one endpoint that answers; all share one token issuer:

- `appservice`: `/msi/token` with the identity header secret (shown on the first `GET /_sim/api/dataverse` only).
- `imds`: `/metadata/identity/oauth2/token` with the `Metadata` header.
- `arc`: the Arc challenge on the IMDS path; each challenge secret is a single-use file under `.paqvilo/mirage`.

Both resource selectors, `mi_res_id` and `msi_res_id`, are accepted. The other mode's path is refused, and these
endpoints send no CORS headers, so a page on another origin cannot read a token. Managed identities are application
users, listed in the `managedidentities` table. Federated credentials come from `applications[].federatedCredentials`
with `federatedIssuers`, or from the [administration endpoint](#endpoints).

### SQL (TDS) endpoint

The read-only SQL endpoint ("Enable TDS endpoint") listens on loopback, on an ephemeral port unless `tds.port` is set,
reported as `tdsPort` in the API status and `/_sim/`. With `tds.enabled: false` (or `tdsEnabled: false` at runtime) the
listener stays up and refuses every login with "TDS protocol endpoint is disabled for this organization.". The error
numbers and texts of TDS refusals are local choices, not captured answers.

- Login takes an Entra access token (FEDAUTH); SQL and Windows logins are refused ("Sign-in failed: Request is not
  authenticated."). Each table read runs as the caller through the record handlers, so table, field and row security
  apply. A write answers error 102 with a "read-only" message, every refused construct answers error 102 naming it, and
  an unsupported aggregate such as `CHECKSUM_AGG` answers error 195.
  Service-protection rejections answer 40501.
- Query time limit: 2 minutes when the batch has a JOIN or APPLY, a nested FROM or a `*` column, else 5 minutes; it also
  applies between `GO <count>` repeats (at most 1,000).
- Statements: `SELECT` with `DISTINCT`, `TOP n [PERCENT]`, aliases, `*` and `alias.*`, `SELECT @v = expr`, `DECLARE`
  and `SET`, separated by `;` or a line break; `GO` ends a batch. Output column names must be unique and every
  expression column needs an alias (`SELECT COUNT(*) AS n`). Parameterized client queries arrive as `sp_executesql` RPC
  calls, the only procedure accepted; `EXEC` in batch text is refused.
- Sources: `dbo` tables and derived tables (alias required). Joins: `INNER`, `LEFT`, `RIGHT`, `FULL` (optional
  `OUTER`), `CROSS JOIN`, `CROSS APPLY` and `OUTER APPLY` over a derived table.
- Clauses: `WHERE`, `GROUP BY`, `HAVING`, `ORDER BY` (expressions or ordinals), `UNION`, `UNION ALL`. Predicates:
  comparisons, `LIKE` (see [Dataverse queries](dataverse-parity.md)), `BETWEEN`, `IN`, `IS NULL`, `EXISTS`, `CASE`,
  scalar and derived subqueries, `ANY`, `SOME`, `ALL`.
- Aggregates: `AVG`, `COUNT`, `COUNT_BIG`, `MAX`, `MIN`, `STRING_AGG`, `SUM`, `STDEV`, `STDEVP`, `VAR`, `VARP`.
  Scalar functions model T-SQL semantics (string, date, math, null handling, `CAST`, `CONVERT`, `TRY_CONVERT`); the
  `tds-sql` parity cases compare their results with Microsoft SQL Server.
- Refused: `CHECKSUM_AGG`, `GROUPING`, window functions (`OVER`), CTEs (`WITH`), `OFFSET`/`FETCH`, `EXCEPT`,
  `INTERSECT`, `INTO`, `PIVOT`, `UNPIVOT`, `ROLLUP`, `CUBE`, `GROUPING SETS`, non-`dbo` schemas, DML, DDL and `EXEC`.

## Administration

The **Organization identity & API** view (`/_sim/#dataverse`) shows organization availability separately from the HTTP
listeners and manages staff users and roles, model-driven browser sessions, application registrations, one-time secrets,
public certificates and federation. Staff administration works with the HTTP API off; listener settings change in
Project setup and apply after restart. A created secret is shown once; dismissing it, leaving the view or reloading
drops it, and later reads return only a hint.

### Endpoints

Under the administration API (`/_sim/`). Every write needs the `X-Sim-CSRF` header. Secrets appear only in create
responses; reads show `hint` and `expiresOn`. A `password` is 8 to 256 characters, stored hashed, never returned (reads
show `passwordSet`).

| Method and path                                                             | Effect                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /_sim/api/dataverse`                                                   | Status: `enabled`, `organizationAvailable`, `origin`, `tlsOrigin`, `authority`, `tenantId`, `organizationId`, `uniqueName`, `version`, `tdsPort`, `managedIdentity`, `grantTypes`, applications, managed identities, `environment`, users (`passwordSet`), roles, workflows, recent requests, `certificateFile` and `certificateFingerprint`.                                     |
| `GET /_sim/api/dataverse/requests`                                          | The newest 500 Web API requests. Tokens, secrets and bodies are never recorded.                                                                                                                                                                                                                                                                                                   |
| `GET /_sim/api/dataverse/session`                                           | Current model-driven staff principal with roles, eligible users and the local-administrator option; `current.kind: "unavailable"` with a `message` when this runtime cannot verify the selection (data requests then answer 401).                                                                                                                                                 |
| `POST /_sim/api/dataverse/session`                                          | `{ userId }`: select an enabled interactive user in this browser's signed, runtime-specific HttpOnly session cookie.                                                                                                                                                                                                                                                              |
| `DELETE /_sim/api/dataverse/session`                                        | Reset this browser to local administrator. An invalid, deleted, disabled or expired selection otherwise fails without escalating.                                                                                                                                                                                                                                                 |
| `POST /_sim/api/dataverse/applications`                                     | `{ displayName, appId?, roles?, publicClient?, redirectUris?, spaRedirectUris?, allowedGrants? }`, checked as in settings; `roles` defaults to System Administrator and `allowedGrants` to `client_credentials`. 201 `{ appId, systemuserid, secret }`. An `appId` that already has an application user (managed identities included) answers 409 `DATAVERSE_APPLICATION_EXISTS`. |
| `PATCH /_sim/api/dataverse/applications/<appId>`                            | `{ displayName?, publicClient?, redirectUris?, spaRedirectUris?, allowedGrants? }`, checked as at registration; a new `displayName` renames the application user. 200. 404 `DATAVERSE_APPLICATION_NOT_FOUND`.                                                                                                                                                                     |
| `DELETE /_sim/api/dataverse/applications/<appId>`                           | Removes the registration and its application user. 204.                                                                                                                                                                                                                                                                                                                           |
| `POST /_sim/api/dataverse/applications/<appId>/secrets`                     | 201 `{ id, secret, hint, expiresOn }`.                                                                                                                                                                                                                                                                                                                                            |
| `DELETE /_sim/api/dataverse/applications/<appId>/secrets/<id>`              | 204.                                                                                                                                                                                                                                                                                                                                                                              |
| `POST /_sim/api/dataverse/applications/<appId>/certificates`                | `{ certificatePem }` (SHA-1 and SHA-256 fingerprints become `x5t` / `x5t#S256`) or `{ publicKeyPem }` (digests of its DER SPKI). 201 `{ thumbprint, thumbprint256 }`.                                                                                                                                                                                                             |
| `DELETE /_sim/api/dataverse/applications/<appId>/certificates/<thumbprint>` | By SHA-1 or SHA-256 thumbprint. 204. 404 `DATAVERSE_CERTIFICATE_NOT_FOUND`.                                                                                                                                                                                                                                                                                                       |
| `POST /_sim/api/dataverse/applications/<appId>/federated-credentials`       | `{ issuer, subject, audiences?, jwks }`: adds a credential and its issuer's public keys. 201. A duplicate issuer and subject answers 409.                                                                                                                                                                                                                                         |
| `DELETE /_sim/api/dataverse/applications/<appId>/federated-credentials`     | `{ issuer, subject }`; the issuer's keys stay. 204. 404 `DATAVERSE_FEDERATED_CREDENTIAL_NOT_FOUND`.                                                                                                                                                                                                                                                                               |
| `POST /_sim/api/dataverse/users`                                            | `{ fullname, domainname, objectId?, roles?, accessmode?, businessUnitId?, password? }`. 201 `{ systemuserid, azureactivedirectoryobjectid }`. A `domainname` already in use (any casing) answers 409 `DATAVERSE_USER_EXISTS`.                                                                                                                                                     |
| `PATCH /_sim/api/dataverse/users/<systemuserid>`                            | `{ roles?, isdisabled?, accessmode?, password? }`. 200.                                                                                                                                                                                                                                                                                                                           |
| `POST /_sim/api/dataverse/managed-identities`                               | `{ displayName, clientId?, principalId?, roles? }` (new GUIDs and `Basic User` by default). 201 `{ clientId, systemuserid }`. 409 `DATAVERSE_MANAGED_IDENTITY_EXISTS`.                                                                                                                                                                                                            |
| `DELETE /_sim/api/dataverse/managed-identities/<clientId>`                  | Removes an identity added here with its application user. 204. 409 `DATAVERSE_MANAGED_IDENTITY_CONFIGURED` for one from settings, 404 `DATAVERSE_MANAGED_IDENTITY_NOT_FOUND`.                                                                                                                                                                                                     |
| `PATCH /_sim/api/dataverse/workflows/<id>`                                  | `{ mode, mock? }`: `handler`, `placeholder`, `mock` (`{ status: 30 or 31, message? }`) or `disabled`. Trigger rules are not editable. 200. 404 `DATAVERSE_WORKFLOW_NOT_FOUND`.                                                                                                                                                                                                    |
| `PATCH /_sim/api/dataverse/environment`                                     | Any of `auditing`, `duplicateDetection` (booleans on the organization row; 404 `DATAVERSE_ORGANIZATION_NOT_FOUND` without it), `tdsEnabled`, `pluginTimeoutSeconds` (1 to 3600), `requestsPer300s` (positive, or `null` for no limit). Applies on the next request. 200.                                                                                                          |
| `POST /_sim/api/dataverse/token`                                            | 501 `NOT_AVAILABLE`: create a secret and use the token endpoint.                                                                                                                                                                                                                                                                                                                  |

On the Power Pages host, `POST /_sim/api/reset` keeps registrations, passwords, users and their role assignments,
re-seeds the other security tables and expires change-tracking tokens. A standalone runtime has no reset route (404).
The seeded tables are ordinary tables to the portal: `/_api/systemusers` answers 404 `9004010C` until
`Webapi/systemuser/enabled` is true, then follows table permissions (403 `90040120` without read);
Liquid and FetchXML read them under the same permissions.

## Standard tables

The simulator seeds the 167 standard tables of the [Dataverse table
reference](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/about-entity-reference),
generated from a pinned revision of its source into `mirage/lib/dataverse-standard-tables.json` (names, types, option
labels, ownership and relationships; no descriptions; CC BY 4.0, see [NOTICE](../../NOTICE)). Seven are elastic
(`backgroundoperation`, `appnotification`, `flowrun` and the four `sourcecontrol*` tables). Columns prefixed `adx_`,
`msa_`, `msdyn_`, `mspp_`, `msdynce_`, `msft_` or `msfp_` are left out, except in six allow-listed `msdyn_` tables.

- They are seeded when the API starts, as empty `dataverseOnly` stand-ins. A Solution table with the same name replaces
  the stand-in; nothing writes into a Solution mapping.
- The portal sees a standard table only through `Webapi/<table>/enabled` and table permissions (until enabled,
  `/_api/accounts` answers 404 `9004010C`).
- A contact or lead write composes `fullname` from `firstname`, `middlename` and `lastname` in the organization's
  `fullnameconventioncode` order (default 1: first and last name); a supplied `fullname` is replaced, and `yomifullname`
  is composed from the yomi parts, or is the `fullname` when there are none.
- Regenerate with `node scripts/dataverse-standard-tables.mjs`; the first run caches the pinned pages in
  `.paqvilo/standard-tables-cache/`. `--check` exits 1 when the committed file differs, `--out <path>` writes elsewhere,
  `--commit <sha>` reads another revision and `--allow <table>,...` accepts parse problems for the named tables.

## Not simulated

- A hosted Dataverse service, PAC deployment or external OAuth federation. Sources, the app catalogue, trusted
  implementations and local state decide behaviour; uploaded plug-in assemblies run as described in
  [plug-ins](dataverse-plugins.md).
- The complete native business logic of installed Dynamics applications; registered operations follow modelled or
  documented contracts.
- Unsupported metadata query criteria and operators fail explicitly; a declared schema type does not prove every native
  query shape executes.
- Browser MSAL.js sign-in beyond the minimal picker.

## SDK compatibility checks

Real clients from `mirage/test-sdk/` run against a local organization. `toolkit-client` runs in the first Mirage unit
lane of `npm run validate`. `npm run ci:sdk:prepare` prepares the other clients (a pinned Python environment and a clone
of Microsoft's samples under `.paqvilo/sdk-gates/`), and `npm run ci:sdk` runs all gates and fails when a client is
missing; full validation runs it on Windows and Linux. `npm run test:sdk` runs the gates directly and skips one whose
client is not prepared.

| Gate               | Client                                                    | Exercises                                                                                                       |
| ------------------ | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `toolkit-client`   | `paqvilo/dataverse` `DataverseClient` and the data loader | `WhoAmI`, metadata reads, stable-GUID upsert, lookup binds, `$ref`, FetchXML paging                             |
| `dynamics-web-api` | `dynamics-web-api` with `@azure/msal-node`                | client credentials over http and TLS, CRUD, query options, paging, alternate keys, `$batch`, error codes        |
| `python-dataverse` | Microsoft `PowerPlatform-Dataverse-Client` with `msal`    | TLS `base_url`, picklist labels through `EntityDefinitions`, CRUD, `CreateMultiple`, `$batch`, error details    |
| `webapi-samples`   | Microsoft `PowerApps-Samples` WebAPIService (C#)          | Microsoft's request shapes for CRUD, `RetrieveMultiple` and `$batch`                                            |
| `serviceclient`    | `Microsoft.PowerPlatform.Dataverse.Client` (C#)           | port 80, SOAP CRUD, `QueryExpression`, FetchXML, `ExecuteMultiple`, `ExecuteTransaction`, impersonation, faults |
| `cert-auth`        | `@azure/msal-node` and `Microsoft.Identity.Client` (C#)   | certificate client authentication over the TLS authority                                                        |
| `tds`              | `tedious` (Node)                                          | FEDAUTH login, `SELECT`, `JOIN`, `GROUP BY`, `UNION`, security trimming, refused `INSERT`                       |

A passing gate shows that the client authenticates and receives the documented shapes, not that every live environment
behaves identically.

## Record and compare Web API responses

`mirage/dataverse-parity.mjs` records explicit request plans against one Web API, replays them against another and
compares the responses. It infers nothing from SDK mocks or metadata. Keep plans, observations and transcripts in the
owning project under ignored `.paqvilo/`.

```sh
node mirage/dataverse-parity.mjs record --plan plan.json --base http://127.0.0.1:9000/api/data/v9.2/ --out .paqvilo/reference
node mirage/dataverse-parity.mjs replay --plan plan.json --base http://127.0.0.1:9001/api/data/v9.2/ --out .paqvilo/replay --reference .paqvilo/reference/run.json
node mirage/dataverse-parity.mjs diff --reference .paqvilo/reference/run.json --actual .paqvilo/replay/run.json --out .paqvilo/comparison.json [--rules rules.json] [--plan plan.json]
node mirage/dataverse-parity.mjs catalogue --metadata .paqvilo/metadata.xml --out .paqvilo/catalogue.json
node mirage/dataverse-parity.mjs assert --checks checks.json --actual .paqvilo/replay/run.json --out .paqvilo/assertions.json
```

- Exit status is 1 for response differences (including `replay --reference`), failed or unrecorded assertions, a case
  that is not observed, or failed execution. A run directory and an output file cannot be reused ("already exists;
  evidence is never overwritten"). Remote targets need `--allow-remote` and HTTPS; plans with writes need
  `--allow-writes`. Refusals name the missing option or flag, and an unknown option is named ("Unknown option '--x'.
  Run with --help to see supported options."); unexpected failures print only "Dataverse parity command failed; inspect
  private journal and arguments. No automatic retry was attempted." These are tool policy, not authorization to change
  an environment. `--token-env NAME` reads a bearer token from that variable; the transport injects it outside the
  recorded request.
- A plan is `{ schemaVersion: 1, id, cases: [...] }`; each case has a unique `id`, a `family`, a `request` (`method`,
  `path`, and one of `body` (JSON), `bodyText` or `bodyBase64`), optional `acceptStatus`, `dependsOn` (earlier ids),
  `capture` (JSON pointers into the sealed response, such as `/headers/etag` or `/json/@odata.nextLink`) and `covers`.
  `{{variable}}` templates keep a captured primitive's type when used alone. A case without `acceptStatus` records
  whatever happens; an observed response is not proof the feature works.
- Programmatic use: `runSuite(plan, { transport, sink })` with `createRunWriter(directory)`, plus `compareRuns`,
  `coverageReport(plan, run, catalogue, requiredFamilies)`, `inspectCsdl(xml)` and `evaluateAssertions(run, checks)`
  from `paqvilo/mirage/dataverse-parity.mjs`. A transport returns `{ status, headers, bodyBase64 }` from real response
  bytes, must not follow redirects or send credentials outside its origin, and returns `{ transportError: '<code>' }`
  for an unknown outcome; nothing is invented for network failures.
- Writes are journaled: `journal.jsonl` records an fsynced `intent` before each request and each result; a failed or
  interrupted write is never retried. Without `run.json` the run is not complete. Fixtures, identities, cleanup and
  readbacks belong to the plan's owner.
- Comparison covers completeness, plan hashes, status, every header, raw bytes, JSON field presence, types and array
  order, and nested multipart parts. Nothing is sorted, normalized or rewritten, so clocks, ids and ETags usually
  differ. A `rules` file can classify an exact case/path/reference/actual tuple with a reason; classified differences
  still count toward `exactMatch` and the exit status. Unknown or blocked cases never match. Each run embeds its plan,
  and requests are reconstructed from it, so a changed request cannot inherit a response; for a run without an embedded
  plan, pass `diff --plan`. Browser and fetch transports see decoded bytes and normalized headers, not header casing,
  order or compression.
- `evaluateAssertions` checks documentation or SDK claims: each check has an `id`, `caseId`, source kind
  (`documentation`, `sdk-fixture`, `native`), source URL and assertions `{ op, path, expected? }` (`op` is `exists`,
  `absent`, `equals`, `type` or `includes`; `path` is a JSON pointer such as `/json/UserId`). Passing assertions does
  not prove native parity.
- Authorization headers and cookies are withheld; credential-shaped bodies and multipart credential headers are
  rejected before the plan is journaled. Do not run token issuance or credential APIs through the recorder, and keep
  evidence private.
