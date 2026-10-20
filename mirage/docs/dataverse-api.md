# Dataverse Web API simulation

Mirage serves a Dataverse-shaped Web API on its own loopback origin. It can run [without Power Pages](standalone-organization.md), alongside model-driven apps, or beside a portal. Enabled surfaces share one organization record pipeline and storage. A portal sees Dataverse tables only under its own `Webapi/<table>/enabled`, `Webapi/<table>/fields` and table permissions; its visitor identity and error contracts remain separate from organization staff and application tokens.

## Enable it

Use **Project setup → Runtime configuration** to enable the HTTP API and select its port, then restart Mirage. A standalone project puts `dataverse` at its top level; a catalogue uses `defaults.mirage.dataverse` or `sites.<id>.mirage.dataverse`. See [configuration](../../docs/configuration.md) and the [standalone project example](standalone-organization.md). Model-driven staff sessions use the organization core even while the HTTP listener is off.

Project configuration fragment:

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
| `tls`, `tlsPort` | `tls: true` adds an `https` listener on `tlsPort` (`0` picks an ephemeral port). Its certificate is a self-signed CA, reused while it stays valid for more than 7 days (regenerated when the hosts change), name-constrained to the loopback hosts, and written to the certificate file reported by status (`dataverse-ca.pem` beside the state file under `.paqvilo/`; kept in memory when there is no state file). Trust it with `NODE_EXTRA_CA_CERTS` or `REQUESTS_CA_BUNDLE`. It is never installed into the OS store. |
| `serviceProtection` | `{ requestsPer300s, executionMsPer300s, concurrentRequests }`. Limits per user: requests and combined execution time in a sliding 300 second window, and concurrent requests. A caller over the request limit receives 429 `0x80072322`, and over the execution-time limit 429 `0x80072321`, each with `Retry-After`. Unset limits do not apply. `executionTimeMsPer300s` is accepted as an alias of `executionMsPer300s`. |
| `tenantId` | Tenant in the token authority. Defaults to a GUID derived from the site id. |
| `organizationId`, `uniqueName`, `friendlyName` | Organization identity returned by `WhoAmI` and `RetrieveCurrentOrganization`. |
| `version` | Four-part version reported by `RetrieveVersion` and the SOAP organization detail. Default `9.2.25041.00000`. |
| `managedIdentity` | Server key, outside the settings reader: `{ mode }` with `appservice` (default), `imds` or `arc`. Selects the managed identity token endpoint, see [Managed identity](#managed-identity-and-federated-credentials). |
| `managedIdentities` | Managed identities `{ clientId, principalId?, displayName, roles }`. `roles` defaults to `Basic User`. Each becomes an application user. |
| `federatedIssuers` | External issuers `{ issuer, jwks: { keys } }`, public keys only. They verify the RS256 client assertions of the applications' `federatedCredentials`. |
| `auditing` | `true` sets `organization.isauditenabled`; a table and its columns are audited by their own flags. Default `false`. |
| `tds` | The read-only SQL endpoint (Dataverse "Enable TDS endpoint"). `{ enabled, port }`. Default `{ enabled: true, port: 0 }`: a loopback listener on an ephemeral port, reported as `tdsPort` on the API and in `/_sim/` status. Port `1433` or `5558` is opt-in. With `enabled: false` the listener still runs and every login is refused with "TDS protocol endpoint is disabled for this organization." (as Dataverse keeps the endpoint reachable). Login takes an Entra access token (FEDAUTH); SQL and Windows logins are refused. Each query runs as the caller through the record handlers, so table, field and row security apply. The query limit is 2 minutes when the parsed batch has a JOIN or APPLY, a nested FROM or a `*` column, else 5 minutes. Service-protection rejections answer 40501. The refusal texts and limits are unverified against live Dataverse. |
| `duplicateDetection` | Sets `organization.isduplicatedetectionenabled`. `false` switches the duplicate check off for the organization. Default `true`. The check still runs only on requests that send `MSCRM.SuppressDuplicateDetection: false`, see [Duplicate detection](#duplicate-detection). |
| `pluginTimeoutSeconds` | The execution limit of a custom API's trusted handler (see [custom API handlers](../../docs/project-extensions.md#custom-api-handlers)). A handler past it fails as a timeout (400 `0x80040224`), and its writes roll back. Whole seconds from 1 to 3600. Default `120`, the platform's 2-minute sandbox limit. |
| `currencyCode`, `currencySymbol` | ISO code and symbol of the organization's base currency (its `transactioncurrency` row). Defaults `USD` and `$`. |
| `localeId` | Organization locale (LCID), written to `organization.localeid` and `languagecode`. Default `1033`. |
| `gitRemoteDirectory` | Optional local Git working directory used by the source-control operation adapter. It is project configuration; no organization URL or remote credential belongs in core. |
| `applications` | Application registrations. `roles` creates an application user with those roles (none by default). |
| `applications[].secretEnvironmentVariable` | Name of the environment variable that holds the plain client secret. |
| `applications[].publicClient`, `redirectUris`, `allowedGrants` | A public client (`publicClient: true`) may use only the authorization code, device code, refresh token and password grants. `redirectUris` are http(s) URLs. `allowedGrants` limits the grants the application may use; default all. |
| `applications[].federatedCredentials` | `[{ issuer, subject, audiences }]`. Trusts a client assertion from `issuer` whose subject is `subject`. One audience; default `api://AzureADTokenExchange`. |
| `users` | Interactive users. `objectId` is the Entra object id (`azureactivedirectoryobjectid`). `roles` lists role names; default `Basic User`. |

Configured secrets come only from named environment variables; a plain secret in YAML is rejected. Administration can also generate a local secret and show it once. Secrets and user passwords are stored hashed, with private control-plane persistence selected by the simulation level. Plain tokens/secrets never belong in configuration, pack DATA or request logs. Dry run keeps control-plane changes in memory. See [simulation levels](simulation-levels.md).

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
- **`Microsoft.PowerPlatform.Dataverse.Client`** drops the port from the org URL. Set `port: 80`, and use the constructor that takes a token provider. Port 80 must be free on the machine. `IOrganizationService` calls go to the SOAP endpoint, which is simulated for the messages listed under [SOAP Organization service](#soap-organization-service).

## Token behaviour

- `expires_in` is 3599 for a token with a 3600-second lifetime.
- `client_info` is returned when the request asks for it.
- Certificate assertions accept RS256 and PS256 and match a registered certificate by `x5t` or `x5t#S256`. A reused `jti` is rejected as a replay.
- Federated client assertions (RS256) match a `federatedCredentials` entry by issuer, subject and audience, and verify against the issuer's keys in `federatedIssuers`.
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
| `privilege`, `roleprivileges` | Privileges per role. System Administrator and System Customizer hold Global depth on every table. Basic User holds Basic depth on user-owned tables and Global Read on organization-owned tables, except the share table. |
| `transactioncurrency` | The organization's base currency (`Base currency`). Its symbol comes from the simulator setting `currencySymbol`, default `$`. |
| `principalobjectaccess` | Empty at start. `GrantAccess`, `ModifyAccess` and `RevokeAccess` write one row per shared record and principal. Only the administrator roles can read it. |

Application users come from two places: the `applications` list in `mirage.dataverse`, or `POST /_sim/api/dataverse/applications` at runtime. Interactive users come from `users` or `POST /_sim/api/dataverse/users`. Their roles are ordinary `systemuserroles` rows.

Every write through this API stamps `createdby` and `modifiedby`, and `createdonbehalfby` and `modifiedonbehalfby` when the caller impersonates another user. User-owned tables also receive `ownerid`, `owninguser`, `owningteam` and `owningbusinessunit`; an `ownerid@odata.bind` reassignment recomputes the owning user, team and business unit. These columns are written whether or not the export declares them, so depth checks always have an owner and a business unit to evaluate.

Interactive users sign in through the authority's local picker page at `/<tenantId>/oauth2/v2.0/authorize`, and device-code sign-in through the device page at `/common/oauth2/deviceauth`. The `password` (ROPC) grant needs a password set through the admin API (`password` on `POST` or `PATCH` users); a user without one is refused.

Privilege depth decides which rows a caller can read or change:

| Depth | Rows the caller can access |
| --- | --- |
| Basic | Rows the caller owns, or rows owned by a team the caller belongs to. |
| Local | Rows in the caller's business unit. |
| Deep | Rows in the caller's business unit and its child business units. |
| Global | All rows in the organization. |

Sharing adds to depth: a row shared with the caller, or with one of the caller's teams, is accessible for the rights in the share's mask. The table privilege is still required, so a share never opens a table the caller's roles do not grant. `POST GrantAccess` and `POST ModifyAccess` take `{ Target, PrincipalAccess: { AccessMask, Principal } }`. `GrantAccess` ORs its mask into an existing share of the same record and principal; `ModifyAccess` replaces the mask. `POST RevokeAccess` takes `{ Target, Revokee }`. `Target`, `Principal` and `Revokee` are entity parameters (`{ "widgetid": "<guid>", "@odata.type": "Microsoft.Dynamics.CRM.widget" }`), and `AccessMask` is a comma-separated list such as `ReadAccess, WriteAccess`. The caller needs the Share privilege on the target. `RetrievePrincipalAccess` reports shared rights together with the rights the roles grant.

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
- `$skip` and `$format` answer 400 `0x80060888`. `$search` answers 501 `0x8006088a`.
- URLs up to 32,768 characters are accepted. A longer URL answers 400 `0x80060888`, "Invalid URI: The Uri string is too long."
- A path segment over 260 characters answers 400 "Bad Request - Invalid URL".
- Alternate-key values containing control characters are rejected.
- A malformed `Prefer` header answers 400 with the envelope `{ "Message", "ErrorCode": "0x80097303" }`.

### Headers

- `Preference-Applied` echoes only the preferences that were applied: `odata.include-annotations`, `odata.maxpagesize`, `odata.track-changes` (on a tracked collection), `return=representation`, and `odata.continue-on-error` inside `$batch`.
- `Prefer: respond-async` on a custom API call is applied: the call answers 202 with a `Location` for its status monitor and `Preference-Applied: respond-async`. On other requests it is accepted and not applied.
- `MSCRM.BypassCustomPluginExecution` needs the `prvBypassCustomPlugins` privilege, which System Administrator and System Customizer hold. `MSCRM.BypassBusinessLogicExecution` needs `prvBypassCustomBusinessLogic`. A bypass skips the project's exported plug-ins for that write, and `customsync` also skips the synchronous plug-in phase.
- `MSCRM.SuppressDuplicateDetection: false` turns the duplicate check on, see [Duplicate detection](#duplicate-detection). `MSCRM.SolutionUniqueName`, `MSCRM.MergeLabels` and `Consistency` are accepted as no-ops.
- `x-ms-client-request-id` is echoed.
- Every response carries `x-ms-service-request-id`, `REQ_ID`, the rate-limit headers and `x-ms-dop-hint`.

### Impersonation

`CallerObjectId` and `MSCRMCallerID` require `prvActOnBehalfOfAnotherUser`. Rows record `createdonbehalfby` and `modifiedonbehalfby` when the mapping declares them. A disabled or unknown target is refused.

### Batch

`$batch` part errors use the Dataverse error envelope. A change set runs under the runtime's mutation boundary and rolls back as a whole on failure. Organization/app reads use the shared serialized read boundary so they do not observe a partially applied change set. This is a local queued atomicity model, not distributed Dataverse transaction behavior.

### Change tracking

`Prefer: odata.track-changes` on a collection read is applied and echoed in `Preference-Applied`. The last page carries `@odata.deltaLink`, a link whose `$deltatoken` names the store revision of that page. Following the link answers `…/$delta` with:

- the rows changed since that revision, with the selected columns;
- one `…/$deletedEntity` entry per deleted row, with `id` and `reason: "deleted"`;
- a new `@odata.deltaLink`.

The change log is in memory and keeps the last 10,000 changes. It is reset by a restart and by `POST /_sim/api/reset`.

| Case | Answer |
| --- | --- |
| Token from before a restart or a reset, trimmed out of the log, or not issued by this simulator | 400, `0x80044352` (ExpiredVersionStamp), "Please perform a full sync." The client starts over with a full read. |
| Malformed `$deltatoken` | 400, `0x80060888`, "The $deltatoken is not valid." |
| `$filter`, `$orderby`, `$expand` or `$top` with track-changes or `$deltatoken` | 400, `0x80060888`, "isn't supported when Change Tracking is enabled." |
| `fetchXml` or `$apply` with track-changes or `$deltatoken` | 400, `0x80060888`, the same message. |
| Table whose metadata sets `ChangeTrackingEnabled` to false | 400, `0x80072491`, "Entity … isn't enabled for change tracking." |
| Caller without organization-level read on the table | 403, privilege error for `prvRead<Table>` (`0x80040220`). The delta includes deleted ids, so a limited reader is refused. |

## Metadata

- `ownerid` and customer columns are `LookupAttributeMetadata` with `AttributeType` `Owner` or `Customer`.
- `OwnershipType` is `UserOwned`, `OrganizationOwned` or `BusinessOwned`. The security tables report `BusinessOwned`.
- `$metadata` declares the response complex types `OrganizationDetail`, `RolePrivilege` and `RetrieveMetadataChanges`, and a single `ownerid` navigation typed `principal`.
- The operation registry and metadata builder share a platform contract catalogue. It preserves native action/function kinds, collection and entity overloads, parameter order, nullability, optional annotations and nested enum/complex/metadata types. Only referenced type dependencies are emitted. Project custom APIs retain their own authored signatures. A declared parameter or matching catalogue does not establish that every native option's business semantics are implemented.
- `GlobalOptionSetDefinitions` rejects `$filter`.

## Administration

The **Organization identity & API** view at `/_sim/#dataverse` shows organization availability separately from HTTP listeners. It manages staff users/roles, model-driven browser sessions, application registrations, one-time secrets, public certificates and federation. Staff administration remains available with the HTTP API off. Listener configuration is changed in Project setup and applied after restart. A created secret is shown once; dismissing it, leaving the view or reloading drops it, and later reads return only a hint. Control-plane changes follow the simulation level's private persistence policy.

### Endpoints

These endpoints live under the local administration API (`/_sim/`).

| Method and path | Effect |
| --- | --- |
| `GET /_sim/api/dataverse` | Status: origins (`origin`, `tlsOrigin`), certificate file and fingerprint, authority, tenant, applications, users (with `passwordSet`), roles, requests. |
| `GET /_sim/api/dataverse/session` | Current model-driven staff principal with roles, eligible users and the explicit local-administrator option. |
| `POST /_sim/api/dataverse/session` | Body `{ userId }`; select an enabled interactive user in this browser's signed, runtime-specific HttpOnly session cookie. |
| `DELETE /_sim/api/dataverse/session` | Explicitly reset this browser to local administrator. Invalid/deleted/disabled/expired selections otherwise fail without escalating. |
| `POST /_sim/api/dataverse/applications` | Body `{ displayName, appId?, roles?, publicClient?, redirectUris?, allowedGrants? }`. 201 `{ appId, systemuserid, secret }`. The secret is shown once. A public client (`publicClient: true`) uses only the authorization code, device code, refresh token and password (ROPC) grants. `redirectUris` must be http(s) URLs and `allowedGrants` names known grants. |
| `POST /_sim/api/dataverse/applications/<appId>/secrets` | 201 `{ id, secret, hint, expiresOn }`. The secret is shown once. |
| `DELETE /_sim/api/dataverse/applications/<appId>/secrets/<id>` | 204. |
| `POST /_sim/api/dataverse/applications/<appId>/certificates` | Body `{ certificatePem }` (an X.509 certificate PEM; its SHA-1 and SHA-256 fingerprints become `x5t` / `x5t#S256`) or `{ publicKeyPem }` (a bare public key; digests of its DER SPKI). 201 `{ thumbprint, thumbprint256 }`. |
| `POST /_sim/api/dataverse/applications/<appId>/federated-credentials` | Body `{ issuer, subject, audiences?, jwks }`. Adds a federated credential and its issuer's public keys. 201 with the credential. A duplicate issuer and subject answers 409. |
| `DELETE /_sim/api/dataverse/applications/<appId>` | Removes the registration and its application user. 204. |
| `POST /_sim/api/dataverse/users` | Body `{ fullname, domainname, objectId?, roles?, accessmode?, businessUnitId?, password? }`. 201 `{ systemuserid, azureactivedirectoryobjectid }`. |
| `PATCH /_sim/api/dataverse/users/<systemuserid>` | Body `{ roles?, isdisabled?, accessmode?, password? }`. 200. |
| `GET /_sim/api/dataverse/requests` | Ring buffer of recent Web API requests. |

Every write needs the `X-Sim-CSRF` header with the runtime CSRF token. Secrets appear only in the create responses above. Subsequent reads show `hint` and `expiresOn`. A `password` is 8 to 256 characters, stored hashed, and never returned; reads show only `passwordSet`. The request log never contains tokens.

`POST /_sim/api/reset` keeps registrations and re-seeds the security tables. The tables it seeds (`systemuser`, `role`, `businessunit` and the others) are ordinary tables to the portal: `/_api/systemusers` answers 404 `9004010C` until `Webapi/systemuser/enabled` is true, then follows the table permissions (403 `90040120` without a read grant), as on a live site. Liquid and FetchXML read them under the same table permissions.

## Supported surface

- Service document, and entity sets with create, read, update, delete.
- Query options `$select`, `$filter`, `$orderby`, `$top`, `$expand`, `$count` and annotations. `$skip`, `$search` and `$format` are not supported. `$apply` aggregation is passed through to the local query engine.
- Paging with the `odata.maxpagesize` preference and `$skiptoken`.
- Change tracking on collections, described under Request handling.
- `fetchXml` queries.
- Navigation properties and `$ref` associations.
- `$batch` with change sets and `$n` references, and JSON batch (`{ "requests": [...] }`), whose items run in `dependsOn` order. JSON batch answers in the multipart form.
- Functions and actions: `WhoAmI`, `RetrieveVersion`, `RetrieveCurrentOrganization`, `RetrieveTotalRecordCount`, `RetrieveUserPrivileges`, `RetrievePrincipalAccess`, `RetrieveMetadataChanges`, `GrantAccess`, `ModifyAccess`, `RevokeAccess`.
- Metadata reads: the `$metadata` document, `EntityDefinitions`, `RelationshipDefinitions`, `GlobalOptionSetDefinitions`.
- Discovery: `Instances`.
- Documented error envelope and error codes.
- Money columns: JSON values with four decimals (`12.5000`), formatted values with the base currency symbol (`$12.50`), and `_transactioncurrencyid_value` (with its lookup annotations) on every row that returns a money column. The simulator has one currency, so every money row reports the base currency.
- Collection-bound `CreateMultiple`, `UpdateMultiple` and `UpsertMultiple`; elastic tables also support `DeleteMultiple`.
- OAuth 2.0 grants: `client_credentials` (client secret or certificate assertion), `authorization_code` with PKCE, `device_code`, `password` (ROPC), on-behalf-of, and `refresh_token` rotation. OpenID Connect discovery, JWKS and instance discovery.
- Impersonation through `CallerObjectId` or `MSCRMCallerID` for callers holding `prvActOnBehalfOfAnotherUser`.

### SOAP Organization service

`/XRMServices/2011/Organization.svc/web` answers these messages, backed by the same record handlers:

- Body operations: `Create`, `Retrieve`, `RetrieveMultiple`, `Update`, `Delete`, `Associate` and `Disassociate`.
- Execute messages: `Upsert`, `Assign`, `SetState`, `WhoAmI`, `RetrieveVersion`, `RetrieveCurrentOrganization`, `ExecuteMultiple` and `ExecuteTransaction`.
- Queries: `QueryExpression`, `QueryByAttribute` and `FetchExpression`, run as FetchXML.
- Metadata: `RetrieveEntity`, `RetrieveAttribute`, `RetrieveAllEntities`, `RetrieveOptionSet`, `RetrieveRelationship` and `RetrieveMetadataChanges`, including typed nested metadata queries and deletion stamps.
- A registered Web API action or function, named by `RequestName` on the generic `OrganizationRequest`.

Any other message answers a SOAP fault (HTTP 500).

### Metadata writes

Metadata writes need the metadata privilege of the message (`prv*Entity` or `prv*Attribute`). System Administrator and System Customizer hold them.

- Tables: `EntityDefinitions` POST, PUT and DELETE. A created table is user-configured and `dataverseOnly`. Seeded and Solution tables are read-only at table level.
- Columns: `Attributes` POST, PUT and DELETE. Columns made here are kept with the table, so a Solution refresh keeps them.
- Alternate keys: `Keys` POST and DELETE, with activation jobs. `PublishXml` and `PublishAllXml` accept publication; writes already apply immediately. `PublishAllXmlAsync` exposes publication as a type 204 system job.
- Relationships: `RelationshipDefinitions` POST for one-to-many and many-to-many, and PUT and DELETE by key.
- Lookups: `CreateCustomerRelationships` and `CreatePolymorphicLookupAttribute`.
- Choices: `GlobalOptionSetDefinitions` POST, PUT and DELETE. Option actions: `InsertOptionValue`, `UpdateOptionValue`, `DeleteOptionValue`, `OrderOption`, `InsertStatusValue` and `UpdateStateValue`.

### Files and images

- Single upload: a `PATCH` of a file or image column with the bytes as the body.
- Chunked upload: `InitializeFileBlocksUpload`, `UploadBlock` and `CommitFileBlocksUpload`. Upload sessions live in memory, so a restart drops the uploads in progress.
- Download: `$value` reads, including ranged reads, and `InitializeFileBlocksDownload` and `DownloadBlock` for chunks.
- `DeleteFile` removes the file from its column.

### Record messages and predefined queries

- `Merge` for `account`, `contact`, `lead` and `incident`. The target gains the subordinate's empty values, and `UpdateContent` applies (not on `incident`). Ownership, audit and state columns are never copied.
- `InitializeFrom`, `CalculateRollupField`, `IsValidStateTransition` and `FormatAddress`.
- `savedQuery=<id>` and `userQuery=<id>` answer from the stored FetchXML. Navigation through a many-to-many relationship in a predefined query answers 501.

### Solutions

- `ExportSolution` (needs `prvExportCustomization`) returns the zip of a solution as `ExportSolutionFile`. The zip holds its component membership, including metadata writes with the `MSCRM.SolutionUniqueName` header. A base solution with child patches is locked for export until its patches are removed or rolled up. `ExportSolutionAsync` and `DownloadSolutionExportData` expose the job and download lifecycle.
- `ImportSolution` (needs `prvImportCustomization`) reads `CustomizationFile` (base64 zip) and creates or keeps tables, supported columns, global choices, relationships and alternate keys. It retains app, site-map, form, view and workflow definitions with their exported GUIDs, plus opaque asset bytes. A failed import rolls back metadata, component rows and retained assets; its `importjob` row keeps the failure. `OverwriteUnmanagedCustomizations` replaces existing columns and imported record definitions. `ImportSolutionAsync` answers with `AsyncOperationId` and `ImportJobKey` and runs the import on a later tick.
- `CloneAsPatch` and `CloneAsSolution` create patches and roll them up. `StageSolution` checks an archive without importing it; `StageAndUpgrade` and its asynchronous counterpart import a holding solution, and `DeleteAndPromote` replaces the base. `UninstallSolutionAsync` removes a managed solution's introduced components only after checking dependencies. Failed imports and blocked removals preserve prior state.
- `AddSolutionComponent`, `RemoveSolutionComponent`, dependency queries and asynchronous component additions share the membership model. `UpdateSolutionComponent` persists its opaque included-setting strings per membership; their individual platform meanings remain unverified. Preferred solutions are stored per user. Managed table/column layers support removing active customizations.
- Model-driven apps can come from selected local Solution sources or API-imported archives. Their metadata records share the API store: local app/form/view edits affect the catalogue, source sitemap navigation stays associated with its app, and deletion tombstones survive restart. App membership edits survive export and re-import. Exported relationship cascades, menu settings, versions, customizability and choice external values retain their source facts through that round trip. Sparse source overlays leave exported files untouched. Imported assets have solution ownership through staged upgrades, uninstall and patch rollup; unrelated solution assets remain intact.
- Export regenerates current supported schema and the solution manifest, merges retained XML components, and preserves opaque script/assembly bytes. Form/view metadata edits are included on export. ZIP transport is bounded to 128 MiB compressed, 256 MiB total uncompressed and 10,000 entries; persisted import layers are bounded to 256 and 256 MiB aggregate decoded content. Paths, CRCs and entry sizes are validated without extraction. Arbitrary imported scripts, assemblies, controls and workflow XAML are retained without gaining execution support. `PublishWorkflows` does not activate imported workflows, and export-settings flags remain unmodelled.
- Microsoft documents synchronous `UninstallSolution` and `ImportSolutions` as internal-only. Their signatures are available, with the shared explicit project-override contract and an honest 501 default.

### Custom APIs

Custom APIs come from the Solution's `customapi` rows. Unbound, entity-bound and collection-bound functions answer GET, and actions answer POST. Without a handler, the response properties take their defaults. A trusted pack can supply a handler, see [custom API handlers](../../docs/project-extensions.md#custom-api-handlers).

### Duplicate detection

Duplicate rules come from the `duplicaterule` and `duplicaterulecondition` rows. Create and update are checked only when the request sends `MSCRM.SuppressDuplicateDetection: false`; the default suppresses the check. The organization's `isduplicatedetectionenabled` flag (the `duplicateDetection` setting) switches it off for the whole organization. A duplicate answers 412 `0x80040333`. Rule operators `0` to `6` are simulated: exact match, same first or last characters, same date, same date and time, picklist label and picklist value. `PublishDuplicateRule`, `UnpublishDuplicateRule` and `RetrieveDuplicates` are available.

### Auditing

`RetrieveRecordChangeHistory`, `RetrieveAttributeChangeHistory` and `RetrieveAuditDetails` read the `audit` table. `DeleteRecordChangeHistory` deletes history entries and needs `prvDeleteRecordChangeHistory`. The organization flag enables auditing, and each table and column has its own flag. Shares, role privileges and role assignments are audited too, and so are writes made through the portal and `/_sim/`.

### Async operations

- `BulkDelete` needs `prvBulkDelete` (System Administrator only). It queues a system job and returns its `JobId`. The job runs later as the submitter, through the record handlers, so privileges and row access apply. `StartDateTime` postpones it. `RecurrencePattern` accepts `FREQ=DAILY`, `WEEKLY` or `MONTHLY`, with an optional `INTERVAL`.
- Each job writes one `bulkdeleteoperation` row, and one `bulkdeletefailure` row per row it could not delete. Jobs resume after a restart.
- A custom API call with `Prefer: respond-async` answers 202 and runs as a background operation. Its status monitor is `GET` or `DELETE` on `/api/backgroundoperation/<id>`, outside `/api/data`.

### Workflows

- The Solution's `Workflows` folder seeds one `workflow` row per data file (classic XAML and cloud flow JSON), and an activation row (type 2) for each activated definition. A PATCH of `statecode` activates or deactivates; other columns of an activated definition, and any change to an activation row, are refused with Learn's codes (`0x80045002`, `0x80045003`, `0x80045004`, `0x80045018`, `0x8004500D`).
- `ExecuteWorkflow` takes `EntityId` and returns the id of an asyncoperation of type 10 (Workflow). A background run is that job; a real-time classic run executes inside the request and answers the empty id. A cloud flow is always a job. Learn's codes cover a draft or unpublished classic workflow, one that is not on-demand, a cloud flow that is not on-demand or whose trigger is not Dataverse. A call with no `EntityId` is refused with an unverified code.
- `CreateWorkflowFromTemplate` copies a template (type 3) into a new draft definition named `WorkflowName`.
- Classic workflow XAML is never interpreted. A run uses a trusted pack handler (`workflows: { '<workflowid or uniquename>': handler }`, documented in `docs/project-extensions.md`), or it is a placeholder that ends the job Canceled with "Simulator: classic workflow XAML is not executed" and records a `WORKFLOW_PLACEHOLDER` diagnostic. A handler or mock run writes a `workflowlog` row; a real-time failure with `syncworkflowlogonfailure` writes a `processsession` row. A chain of runs deeper than 16 is canceled with `0x80044182`.
- Creating a classic workflow through the Web API is refused (unverified code, LC-W1c). `ExecuteWorkflowRequest` reaches the same workflow operation through the generic SOAP bridge when the workflow extension is installed by Mirage.

### Model-driven app customization

`RetrieveAppComponents`, `AddAppComponents`, `RemoveAppComponents` and `ValidateApp` expose local app membership. Adds validate all source references before writing, and duplicate additions are idempotent. `InstantiateFilters` copies referenced system-view templates into personal queries owned by the bound user; exact Outlook duplication and column-copy behavior remain unverified. Reports expose their stored definition and related categories; rendering is not implemented.

### Elastic tables and search

Elastic records have partition-aware identity and expiry (`ttlinseconds`). The same primary id can exist in distinct partitions. Collection bulk operations preserve each target's partition; `DeleteMultiple` remains unavailable for standard tables. `ExecuteCosmosSqlQuery` evaluates the modeled Cosmos SQL subset locally and returns an `expando` result with scoped paging cookies. Unsupported SQL shapes fail explicitly.

Dataverse search actions and `/api/search/v1.0` and `/api/search/v2.0` routes query records through the caller's security and field-security checks. Search uses a local token matcher, without Dataverse's distributed index, Lucene, fuzzy matching, boosting or proximity. This search surface is separate from unsupported OData `$search`.

### Security messages and field security

- Privileges: `AddPrivilegesRole`, `RemovePrivilegeRole`, `ReplacePrivilegesRole`, `RetrieveRolePrivilegesRole`, `RetrieveUserPrivilegeByPrivilegeName`, `RetrieveUserPrivilegeByPrivilegeId`, `RetrieveUserSetOfPrivilegesByNames`, `RetrieveUserSetOfPrivilegesByIds` and `RetrieveTeamPrivileges`.
- Teams and hierarchy: `AddMembersTeam`, `RemoveMembersTeam`, `AddUserToRecordTeam`, `RemoveUserFromRecordTeam`, `SetBusinessSystemUser`, `SetParentSystemUser` and `RetrieveBusinessHierarchyBusinessUnit`. Access-team templates (`teamtemplate`) are seeded.
- Entra ID users: `RetrieveAadUserRoles` and `RetrieveAadUserPrivileges`.
- Sharing: `RetrieveSharedPrincipalsAndAccess` and `RetrieveAccessOrigin`.
- Field security: field security profiles, field permissions and field sharing. Record hooks null or refuse secured columns. `RetrievePrincipalAttributePrivileges` reports the column privileges of a principal.

### Activity pointer

`activitypointer` is a read-only view over the activity tables. Each source table is read through the record handlers, so its privileges, ownership and sharing apply. A read needs `prvReadActivity`. `$filter`, `$orderby`, `$count` and paging work on the combined rows. Single-row `$expand`, property and `$value` reads go to the source table. Other verbs are refused.

### Managed identity and federated credentials

`managedIdentity.mode` picks the endpoint shape. All three share one token issuer:

- `appservice`: `/msi/token`, with the identity header secret.
- `imds`: `/metadata/identity/oauth2/token`, with the `Metadata` header.
- `arc`: the Arc challenge on the IMDS path. Each challenge secret is a single-use file under `.paqvilo/mirage`.

Both resource selectors, `mi_res_id` (App Service) and `msi_res_id` (IMDS), are accepted.

Managed identities are application users, listed in the `managedidentities` table. Federated credentials come from `applications[].federatedCredentials` with `federatedIssuers`, or from the administration endpoint above.

### SQL (TDS) endpoint

- Login takes an Entra access token (FEDAUTH). Each table read runs as the caller through the Web API record handlers, so table, field and row security apply. The endpoint is read-only: a write answers error 102 with a "read-only" message.
- Statements: `SELECT` with `DISTINCT`, `TOP n [PERCENT]`, aliases, `*` and `alias.*`, `SELECT @v = expr`, `DECLARE` and `SET`. Statements are separated by `;` or a line break, and `GO` ends a batch. `sp_executesql` is the only procedure mapped, and its parameters arrive as `@p1` and so on.
- Sources: `dbo` tables and derived tables (alias required). Joins: `INNER`, `LEFT`, `RIGHT` and `FULL` (with optional `OUTER`), `CROSS JOIN`, and `CROSS APPLY` or `OUTER APPLY` over a derived table.
- Clauses: `WHERE`, `GROUP BY`, `HAVING`, `ORDER BY` (expressions or ordinals), `UNION` and `UNION ALL`.
- Predicates and subqueries: comparisons, `LIKE`, `BETWEEN`, `IN`, `IS NULL`, `EXISTS`, `CASE`, scalar and derived subqueries, and `ANY`, `SOME` and `ALL` comparisons.
- Aggregates: `AVG`, `COUNT`, `COUNT_BIG`, `MAX`, `MIN`, `STRING_AGG`, `SUM`, `STDEV`, `STDEVP`, `VAR` and `VARP`. `CHECKSUM_AGG` and `GROUPING` are refused.
- Functions: 66 scalar functions with T-SQL semantics, including string, date, math, null handling, `CAST`, `CONVERT` and `TRY_CONVERT`.
- Refused: window functions (`OVER`), CTEs (`WITH`), `OFFSET`/`FETCH`, `EXCEPT`, `INTERSECT`, `INTO`, `PIVOT`, `UNPIVOT`, `ROLLUP`, `CUBE`, `GROUPING SETS`, non-`dbo` schemas, DML, DDL and `EXEC`.

## Standard tables

The simulator seeds the 167 standard tables of the Microsoft Learn Dataverse table reference (`MicrosoftDocs/powerapps-docs` at commit `c3a8c43b`). The data file, `mirage/lib/dataverse-standard-tables.json`, holds names, types, option labels, ownership and relationships. It holds no description text. The data is CC BY 4.0, see [NOTICE](../../NOTICE). Columns whose names start with `adx_`, `msa_`, `msdyn_`, `mspp_`, `msdynce_`, `msft_` or `msfp_` are left out, except in the six allow-listed `msdyn_` tables (`PREFIXED_TABLES`).

| Item | Count |
| --- | --- |
| Tables | 167: 160 standard, 7 elastic (`backgroundoperation`, `appnotification`, `flowrun`, `sourcecontrolconfiguration`, `sourcecontrolbranchconfiguration`, `sourcecontrolcomponent`, `sourcecontrolcomponentpayload`) |
| Columns | 6,584, including 167 primary keys |
| Relationships | 1,873: 1,855 one-to-many, 18 many-to-many |
| Global option sets | 78 |
| Local option sets (choice columns) | 838 |
| Ownership | 74 user-owned, 47 organization-owned, 5 business-owned, 41 none |

- The tables are seeded when the Dataverse API starts, as stand-ins that exist only in the simulator (`dataverseOnly`). They start with no rows.
- A Solution that defines a table with the same name replaces the seeded stand-in. Nothing writes into a Solution mapping.
- The portal sees a standard table only through its own settings: `Webapi/<table>/enabled` and table permissions. Until it is enabled, `/_api/accounts` answers 404 `9004010C`, as on a live site. Liquid and FetchXML read the table under the same table permissions.
- Regenerate with `node scripts/dataverse-standard-tables.mjs`. The first run fetches the pages at the pinned commit into the ignored `.paqvilo/standard-tables-cache/`. `--check` regenerates in memory and exits 1 when the committed file differs. `--out <path>` writes elsewhere, and `--allow <table>,...` accepts parse problems for the named tables.

## Not simulated

Not simulated:

- A hosted Dataverse service, PAC deployment, external OAuth federation, or execution of arbitrary uploaded assembly content. This is a local simulator; sources, app catalogue, trusted implementations and local state determine behavior.
- The complete native business logic of every installed Dynamics application. Registered operations follow the modeled or documented contracts; unverified details remain identified in source and tests.
- Sharing with an `organization` principal (`GrantAccess`, `ModifyAccess`, `RevokeAccess`): answers 400 `InvalidKey`. Only `systemuser` and `team` principals are simulated.
- `DeleteMultiple` on a standard table answers 501 `0x80040216`. Actions and functions without a registered handler answer 404, "No HTTP resource was found", with no error code.
- `$skip` and `$format` (400 `0x80060888`), and `$search` (501 `0x8006088a`).
- Recurring BulkDelete schedules outside the modeled `FREQ=DAILY`, `WEEKLY` or `MONTHLY` forms, and unsupported metadata criteria/operators, fail explicitly. A declared schema type alone does not prove that every native query shape executes.
- `_Downloademailasattachment`, `_InvokeHideReserveEntities`, `_SyncKnowledgeManagementSettings` and `cascadeAsync_SuccessAPI` have captured native signatures but no qualified implementation contract. They support an explicit project handler and otherwise answer 501. A matching name or successful catalogue comparison is not behavior-parity evidence.
- Browser-based MSAL.js sign-in beyond the minimal picker.

### Unverified against a live tenant

These details follow the research notes rather than a live capture, and stay as they are until one exists:

- `error_uri` (`https://login.microsoftonline.com/error?code=<n>`) is returned on every AADSTS error. A live probe showed it absent for 50059, 70003 and 7000014.
- `invalid_client` for AADSTS7000218, 700027 and 7000222 answers 400; only 7000215 (wrong secret) was observed live as 401.
- The HTTP status and body of a `DELETE` with `If-Match: *` on a missing row, and the `0x80060882` code on an `If-Match` mismatch (the documented sample shows an empty code).
- `GrantAccess` ORs its mask into an existing share. Microsoft's documentation describes the share, not the merge, and no live tenant has confirmed it.
- The change-tracking codes and messages (`0x80044352`, `0x80072491`) follow Microsoft's error-code reference, not a live capture.
- `Merge` for `lead` and `incident`, and its same-table and same-record rules. The Merge reference lists `account` and `contact` only.
- Metadata write messages, status codes and parameter rules that the Learn pages do not confirm.
- `UpdateMultiple` and `UpsertMultiple` with empty or mixed `Targets`.
- The file MIME type, taken from the file extension.
- Managed identity `credentialsource`, `subjectscope` and `version` values, and the body of an `api-version` error.
- The `Locked` transitional statuses of a bulk delete job that is cancelled or paused.
- SQL endpoint: `ORDER BY NULL` ordering, `OFFSET`/`FETCH` and `PIVOT` support, the messages for refused constructs, and the `FORMATMESSAGE` missing-parameter text.
- Standard tables: whether `activitypointer_prioritycode` is a global or a local option set. The privilege noun of `queueitem` and `environmentvariablevalue`.

## Evidence

The local behaviour is a simulation. Parity claims rest on the SDK gates under `mirage/test-sdk/` (opt-in `npm run test:sdk`) and on the research notes.

| Gate | Client | Proves |
| --- | --- | --- |
| `toolkit-client` | `paqvilo/dataverse` `DataverseClient` and the data loader | `WhoAmI`, metadata reads the loader needs, stable-GUID upsert with `If-None-Match`, deferred lookup binds, `$ref` association, FetchXML paging, compare and query status |
| `dynamics-web-api` | `dynamics-web-api` 2.5.1 with `@azure/msal-node` 7.1.0 | client_credentials over `authorityMetadata` (http) and over OpenID Connect discovery on the TLS listener, CRUD, `$select`/`$filter`/`$expand`/`$count`, paging, alternate keys, FetchXML paging cookies, `$batch` change sets, error codes |
| `python-dataverse` | Microsoft `PowerPlatform-Dataverse-Client` 1.1.0 with `msal` 1.39.0 | TLS `base_url`, OpenID Connect discovery with `instance_discovery=False`, picklist label resolution through `EntityDefinitions` and `OptionSet` expansion, CRUD, query builder, `CreateMultiple`, `$batch`, 400 and 404 error details |
| `webapi-samples` | Microsoft `PowerApps-Samples` WebAPIService (C#, pinned commit) | Microsoft's own request shapes: `WhoAmI`, create with `OData-EntityId`, retrieve, update, `RetrieveMultiple`, delete, `$batch` change set, `x-ms-dop-hint` |
| `serviceclient` | `Microsoft.PowerPlatform.Dataverse.Client` 1.2.27 (C#, token-provider constructor) | Port 80 (ServiceClient drops the port), `RetrieveCurrentOrganization` on v9.0 with the version switch to v9.2. Two passes. The SOAP pass covers CRUD, `QueryExpression` paging, FetchXML, `Associate`, `ExecuteMultiple`, `ExecuteTransaction`, `WhoAmI`, CallerId impersonation and a `FaultException` for a missing row. The Web API pass covers CRUD over the Web API and `RetrieveEntityRequest` over SOAP |
| `cert-auth` | `@azure/msal-node` 7.1.0 `clientCertificate` and `Microsoft.Identity.Client` 4.91.0 `WithCertificate` (C#) | Certificate client authentication: a per-run self-signed certificate registered by its fingerprints, PS256 assertions carrying `x5t#S256` and `x5c` redeemed over the TLS authority (MSAL.NET with `WithInstanceDiscovery(false)` and a CA-trusting `IMsalHttpClientFactory`), `appidacr` 2, `WhoAmI`, the token and `WhoAmI` requests in the simulator log, and AADSTS700027 for a tampered assertion |
| `tds` | `tedious` 20.3.8 (Node) | Login with an Entra access token (FEDAUTH) over the TDS listener, `SELECT TOP`, `JOIN`, `GROUP BY` with `COUNT(*)` and `ORDER BY`, `UNION`, security trimming (a Basic User token sees fewer rows than the admin token), and an `INSERT` refused with error 102 |

`npm run test:sdk` runs all seven gates.

Gate dependencies stay out of the package: Node packages install under `mirage/test-sdk/<gate>/node_modules`, the Python environment and the cloned sample repository live under the ignored `.paqvilo/sdk-gates/`. A passing SDK gate shows that the client could authenticate and receive the documented shapes. It does not show that every live environment behaves identically.
