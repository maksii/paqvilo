# Simulated Dataverse Web API (design)

Status: in development on `feature/dataverse-api`. Target: 1.0.0.

Mirage simulates the Power Pages portal Web API (`/_api/`, cookie session, table permissions). This design adds a second, independent surface: the **Dataverse Web API** (`/api/data/v9.x/`) with Entra-shaped OAuth 2.0 token issuance, application registrations, `systemuser`/`businessunit`/`team`/`role` tables and security-role privileges. SDKs that connect to a real environment must connect to the simulator with no code changes beyond pointing them at loopback.

## Goals and gates

1. **Application registration simulation**: client id, client secrets (hashed at rest), certificates, public clients, redirect URIs; grants `client_credentials` (secret and certificate assertion), `authorization_code` (+PKCE), `device_code`, `refresh_token`, `password` (ROPC), on-behalf-of.
2. **Dataverse Web API parity** over the existing `DataStore`: service document, `$metadata`, entity CRUD, query options, paging, annotations, `$batch`, functions/actions, metadata entities, discovery, documented error envelopes and codes.
3. **Users and roles**: `organization`, `businessunit`, `systemuser` (interactive and application users), `team`, `role`, `systemuserroles`, `teammembership`, `teamroles`, `roleprivileges`, `privilege`, with depth-based privilege checks (Basic/Local/Deep/Global).
4. **Zero impact on the portal API**: no behaviour change under `/_api/`, `/_sim/` or page rendering. Existing tests stay green unchanged.
5. **SDK gates** (`mirage/test-sdk/`): the toolkit's own `DataverseClient`, `dynamics-web-api` + `@azure/msal-node`, Microsoft's Python `PowerPlatform-Dataverse-Client` + `msal`, Microsoft's `PowerApps-Samples` WebAPIService, `Microsoft.PowerPlatform.Dataverse.Client` ServiceClient (Web API path).

Research notes (wire contracts, SDK behaviour, codebase survey) live in `.paqvilo/dataverse-api-research/` (ignored) and the session scratchpad; this document is the contract between modules.

## Architecture decision: separate listeners

The Dataverse API runs **in the same Mirage process, sharing the same `DataStore`**, but on **its own HTTP listener(s)**, never on the portal origin.

- Real topology: the org URL, the portal URL and `login.microsoftonline.com` are three origins. SDKs build `${orgUrl}/api/data/v9.2/`; MSAL builds `${authority}/oauth2/v2.0/token`.
- Zero impact by construction: the portal's request pipeline (`Host`/`Origin` checks, audit classification, HTML error pages, `pageMode: live` forwarding) is untouched. No change to `mirage/server.mjs` dispatch order.
- Precedent: `mirage/lib/identity-provider.mjs` already runs a second `http.createServer` on its own port.

Listeners (all loopback, all served by one `handleDataverse(req, res)` handler):

| Listener | Default | Purpose |
| --- | --- | --- |
| `http://127.0.0.1:<port>` | ephemeral, or `dataverse.port` | Org URL and token authority for Node/.NET sample clients; port 80 for ServiceClient (it drops the port). |
| `https://127.0.0.1:<tlsPort>` | off, `dataverse.tls: true` | Same handler over TLS with a per-run self-signed certificate (written to `.paqvilo/mirage/dataverse-ca.pem`); needed by MSAL (any language) for OIDC discovery and by the Python SDK (`base_url` must be https). Never installed into the OS store. |

The token authority is `${origin}/${tenantId}`; `issuer` is `${origin}/${tenantId}/v2.0`. Every absolute URL the API emits (`@odata.context`, `@odata.nextLink`, `OData-EntityId`, `Location`, `token_endpoint`, `issuer`, discovery `ApiUrl`) uses the origin of the listener that received the request (`req.socket.encrypted`, `Host` header). On port 80 there is no port suffix.

A SOAP stub answers `POST /XRMServices/2011/Organization.svc/web` with HTTP 500 `text/xml` SOAP fault "SOAP organization service is not simulated" so ServiceClient reports a clean fault rather than a protocol error. SOAP parity is out of scope.

## Module layout (flat files, release allowlist `mirage/lib/[a-z0-9-]+.mjs`)

| Module | Owns |
| --- | --- |
| `mirage/lib/dataverse-auth.mjs` | RS256 keys, JWKS, OIDC documents, application registry checks, all grants, token issue/verify, AADSTS errors. |
| `mirage/lib/dataverse-security.mjs` | Security tables seed, principal resolution, privileges and depth, authorization, ownership columns. |
| `mirage/lib/dataverse-metadata.mjs` | `EntityDefinitions`, `Attributes`, `RelationshipDefinitions`, `GlobalOptionSetDefinitions`, service document, `$metadata` CSDL, `RetrieveMetadataChanges`, deterministic `MetadataId`, ObjectTypeCode. |
| `mirage/lib/dataverse-odata.mjs` | Route grammar, `Prefer` parsing, context/entity URLs, skiptoken cookies, error envelope and code mapping, response headers. |
| `mirage/lib/dataverse-batch.mjs` | `$batch` multipart parse/serialize, changesets, `$n` references (milestone 2). |
| `mirage/lib/dataverse-tls.mjs` | Self-signed certificate generation with `node:crypto` only (milestone 2). |
| `mirage/lib/dataverse-settings.mjs` | Validation of the `dataverse` configuration section. |
| `mirage/lib/dataverse-api.mjs` | Listeners, router, CRUD/query/function handlers, discovery, request log; wires the modules above. |
| `mirage/server.mjs` | `createSimulator({ dataverse })` option, start/stop, `exposedState().dataverse`, `/_sim/api/dataverse/*` admin endpoints, `/reset` preservation. |
| `mirage/lib/project-config.mjs`, `lense/config-schema.mjs`, `lense/config.mjs`, `mirage/cli.mjs` | `dataverse` section plumbing. |
| `mirage/test/dataverse-*.test.mjs` | Unit and HTTP regressions (invented schemas, loopback only). |
| `mirage/test-sdk/<gate>/` | Opt-in SDK gates, `npm run test:sdk`. Never part of `npm run validate`. |
| `mirage/docs/dataverse-api.md` | User documentation; row in `mirage/docs/README.md`. |

Shared conventions: ESM, Node 22+, no new dependencies, `node:crypto` only. Errors thrown to the router are `DataError` (`mirage/lib/data-error.mjs`) or plain `Error` with `status`/`code`; the router converts them with `dataverse-odata.mjs`. GUIDs are lowercase without braces in JSON, uppercase with braces inside paging cookies. All modules are pure except `dataverse-api.mjs` (sockets) and `dataverse-tls.mjs` (files).

## State

`state.dataverse` (new top-level section; persisted, exported and imported automatically by `StateStorage` checkpoints):

```js
{
  tenantId, organizationId, uniqueName, urlName, friendlyName, version: "9.2.25041.00000",
  environmentId, datacenterId: "00000000-0000-0000-0000-000000000000", geo: "NA",
  applications: [{
    appId, displayName, createdOn,
    secrets: [{ id, hash, salt, hint, expiresOn }],          // SHA-256(salt + secret), base64url; never the secret
    certificates: [{ thumbprint, publicKeyPem }],             // for client_assertion
    publicClient: false, redirectUris: [], allowedGrants: ["client_credentials", ...],
  }],
}
```

Security principals are ordinary rows in `state.tables` with `userConfigured: true` mappings so Solution re-import never drops them: `organization`, `businessunit`, `systemuser`, `team`, `role`, `systemuserroles`, `teammembership`, `teamroles`, `roleprivileges`, `privilege`. They are queryable through the Dataverse API like any other table, editable through `/_sim/api/records/<entity>`, and seeded by `ensureSecurityModel` (below). Default identifiers are deterministic from `organizationId` (`uuidV5(organizationId, name)`), so fixtures and documentation can quote them.

Tokens, authorization codes, device codes and refresh tokens are in-memory only. Secrets are returned once on creation and stored hashed. The simulator never writes a token or secret to disk or logs. `/reset` preserves `state.dataverse` the same way it preserves `simulator.scenarios`, then re-seeds the security tables.

## Configuration

Project file (`mirage/lib/project-config.mjs`, per portal entry or top level) and catalogue `mirage:` key (`lense/config-schema.mjs` `MIRAGE_KEYS`): `dataverse`:

```yaml
dataverse:
  enabled: true
  port: 0                 # 0 = ephemeral; 80 for ServiceClient
  tls: false              # also start https listener (ephemeral port, or tlsPort)
  tlsPort: 0
  tenantId: 11111111-1111-1111-1111-111111111111      # default: uuidV5 of the site id
  organizationId: ...
  uniqueName: orgsim
  friendlyName: Simulated environment
  applications:
    - appId: 22222222-2222-2222-2222-222222222222
      displayName: Integration client
      secretEnvironmentVariable: PAQVILO_SIM_CLIENT_SECRET   # plain secret only from env, never from YAML
      roles: ["System Administrator"]                        # creates the application user with these roles
  users:
    - domainname: maker@example.test
      fullname: Maker User
      objectId: 33333333-3333-3333-3333-333333333333        # azureactivedirectoryobjectid
      roles: ["System Customizer"]
  serviceProtection: { requestsPer300s: 6000 }               # optional; unset = never 429
```

`dataverse-settings.mjs` exports `dataverseSettings(value, label = 'dataverse')` → normalized object (defaults filled, GUIDs validated case-insensitively and lowercased, env var names `^[A-Z_][A-Z0-9_]*$`, roles must be strings) or throws `Error` with a `label.path` prefix. Absent/`false` → `{ enabled: false }`. The simulator starts the listeners only when `enabled`.

## Identity passed to the store

The Dataverse layer authorizes **before** calling the store, then calls the store with the internal bypass identity so portal table permissions never apply:

```js
const identity = { admin: true, id: systemuserid, systemUserId: systemuserid, businessUnitId, dataverse: { appId, accessMode, roles } };
```

Store options always include `dialect: "dataverse"`, `metadata: (logical) => fields`, `includeKeys: true`, `coerce: true` and never `portalRequest: true`. Writes run inside `change(() => store.transact(fn, { incremental: true }))` like the portal handler. Row filtering for depth-limited reads uses `options.backendRowFilter(row)` (OData) and `options.backendRowsFilter(logical, row)` (FetchXML), the same hooks `local-organization-service.mjs` uses.

Ownership and audit columns are injected into the payload by the Dataverse layer, not by the store: on create `ownerid` (caller unless bound), `owninguser`/`owningteam`, `owningbusinessunit`, `createdby`, `modifiedby`; on update `modifiedby`. If `coerceRecord` rejects a column that is not in the mapping, the implementer adds an additive store option `systemColumns` (object merged after coercion, only honoured when present) rather than changing default behaviour.

---

## Module contracts

### `dataverse-auth.mjs`

```js
export function createAuthority({ tenantId, applications, users, clock = () => Date.now(), accessTokenLifetimeSeconds = 3600 })
// applications: () => state.dataverse.applications (live getter)
// users: { byObjectId(oid) => systemuser row | null, byDomainName(upn) => row | null, verifyPassword(row, password) => boolean }
// Returns:
{
  kid, jwks(),                                      // { keys: [{ kty:'RSA', use:'sig', kid, alg:'RS256', n, e }] }
  openIdConfiguration(origin, version /* 'v2.0' | 'v1.0' */), // issuer `${origin}/${tenantId}/v2.0` (v1: `https://sts.windows.net/${tenantId}/` is NOT used; v1 issuer = `${origin}/${tenantId}/`), token_endpoint, authorization_endpoint, device_authorization_endpoint, jwks_uri, end_session_endpoint, userinfo_endpoint, response_modes_supported, response_types_supported, scopes_supported, token_endpoint_auth_methods_supported, claims_supported, tenant_region_scope: null, cloud_instance_name: 'microsoftonline.com', cloud_graph_host_name, msgraph_host, rbac_url
  handleToken({ origin, tenantSegment, form, headers }) => { status, body, headers },   // all grants
  handleAuthorize({ origin, tenantSegment, query, method, form }) => { status, body, headers }, // HTML user picker (GET) and code issue (POST)
  handleDeviceCode({ origin, tenantSegment, form }) => { status, body },
  handleDeviceVerification({ origin, query, form, method }) => { status, body, headers }, // /common/oauth2/deviceauth
  issueAccessToken({ origin, appId, user, scopes, audience, version, onBehalfOf }) => string,
  verifyBearer(authorizationHeader, { origin, tenantId }) => { ok: true, claims } | { ok: false, reason: 'missing'|'malformed'|'signature'|'expired'|'audience'|'issuer'|'tenant' },
}
export function hashSecret(secret, salt = randomBytes(16)) => { hash, salt }   // base64url(sha256(salt || secret))
export function verifySecret(secret, { hash, salt }) => boolean                // timingSafeEqual
export function newClientSecret() => string                                    // 40 chars base64url, returned once
export function aadError(code, { status = 400, description, traceId, correlationId }) => { status, body }
```

Wire rules (details in research `auth-contracts.md`):

- Paths (both listeners): `/{tenant}/oauth2/v2.0/token`, `/{tenant}/oauth2/v2.0/authorize`, `/{tenant}/oauth2/v2.0/devicecode`, `/{tenant}/oauth2/v2.0/logout`, `/{tenant}/v2.0/.well-known/openid-configuration`, `/{tenant}/.well-known/openid-configuration`, `/{tenant}/discovery/v2.0/keys`, `/{tenant}/discovery/keys`, v1 `/{tenant}/oauth2/token` (with `resource=`), `/{tenant}/oauth2/authorize`, `/common/discovery/instance`, `/common/oauth2/deviceauth`, `/common/userrealm/...` (204). `{tenant}` ∈ `{tenantId, 'common', 'organizations', 'consumers'}`; any other GUID → AADSTS90002 "Tenant 'x' not found". Query strings on the token endpoint are ignored (MSAL appends `client-request-id`).
- Scope handling: `scope` must contain `<orgOrigin>/.default` or `<orgOrigin>/user_impersonation` (trailing slash tolerant) or the Dataverse app id `00000007-0000-0000-c000-000000000000/.default`; also tolerate `openid profile offline_access`. Otherwise AADSTS70011 `invalid_scope`. Token `aud` = `<orgOrigin>` exactly as the scope resource (v2 keeps the resource string; v1 `resource=` likewise).
- Client authentication: `client_secret` (form or HTTP Basic), `client_assertion` (`client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer`, RS256 signed by a registered certificate, `aud` = token endpoint URL or `${origin}/${tenantId}/oauth2/v2.0/token`, `iss` = `sub` = appId, `exp` within 10 minutes, `nbf`/`exp` may arrive as numeric strings (MSAL.NET), `x5t` header matches thumbprint). Unknown app → 400 AADSTS700016 `unauthorized_client`; wrong secret → **401** AADSTS7000215 `invalid_client` (live-observed; every other error is 400); missing `grant_type` → AADSTS900144 `invalid_request`; unknown grant → AADSTS70003 `unsupported_grant_type`; neither secret nor assertion → AADSTS7000218 `invalid_client`; grant not in `allowedGrants` → AADSTS700016 `unauthorized_client`; bad code/refresh token → AADSTS9002313 `invalid_grant`; unknown tenant → AADSTS90002 `invalid_request`.
- Access tokens are always **v1.0 format**, which is what Dataverse issues regardless of endpoint: header `{ typ:'JWT', alg:'RS256', kid, x5t: kid }`; claims `aud` (the scope resource as requested, trailing slash preserved), `iss: ${origin}/${tenantId}/`, `iat, nbf, exp, appid, appidacr ('0' public, '1' secret, '2' cert), idtyp ('app'|'user'), oid, sub, tid, ver:'1.0', uti` (random). Delegated tokens add `name, upn, unique_name, given_name, family_name, scp:'user_impersonation', amr:['pwd']`; app-only tokens have no `scp`, and `oid` = the service principal object id (deterministic uuidV5(appId, 'sp')), which is also the application user's `azureactivedirectoryobjectid`. `id_token` (delegated, when `openid` requested) is v2 format with `iss: ${origin}/${tenantId}/v2.0`, `aud: appId`, `nonce`, `preferred_username`, `oid`, `tid`, `sub`, `ver:'2.0'`.
- Token response `{ token_type: 'Bearer', scope, expires_in, ext_expires_in, access_token, refresh_token?, id_token? }`; v1 endpoint adds `expires_on`, `not_before`, `resource`. Error response `{ error, error_description: 'AADSTS70011: <text> Trace ID: <guid> Correlation ID: <guid> Timestamp: 2026-10-19 10:00:00Z', error_codes: [70011], timestamp, trace_id, correlation_id, error_uri: `${origin}/error?code=70011` }`.
- Device code: response `{ user_code (9 chars A-Z0-9), device_code, verification_uri: ${origin}/common/oauth2/deviceauth, expires_in: 900, interval: 5, message }`; polling errors `authorization_pending`, `slow_down`, `expired_token`, `authorization_declined`.
- Authorization code: GET renders a minimal HTML form listing interactive `systemuser` rows (never application users) with `state`/`nonce`/PKCE fields echoed; POST issues a code (10 min, single-use), redirects to `redirect_uri` (must be registered, or `http://localhost[:port]` / `https://login.microsoftonline.com/common/oauth2/nativeclient` for public clients) with `code`, `state`, `session_state`. `response_mode=form_post` supported. PKCE S256 and plain verified on exchange.
- ROPC: `username` matches `systemuser.domainname` or `internalemailaddress` (case-insensitive); password verified by `users.verifyPassword` (admin-set per user; unset → AADSTS50126). Application users cannot sign in interactively (AADSTS50034 user not found).
- On-behalf-of: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`, `assertion` = a token this authority signed for another audience, `requested_token_use=on_behalf_of`; result is a delegated token for the same user.
- Refresh tokens are opaque random strings bound to app+user+scopes, 24 h, rotated on use.
- `verifyBearer`: RS256 signature with the authority key, `exp` with 5 minutes skew, `aud` ∈ `{origin, origin + '/', '00000007-0000-0000-c000-000000000000'}`, `tid` = tenantId. Tokens from a previous process are rejected (new key) → 401, SDKs re-acquire.

### `dataverse-security.mjs`

```js
export const ACCESS_RIGHTS = { Read: 1, Write: 2, Append: 4, AppendTo: 16, Create: 32, Delete: 65536, Share: 262144, Assign: 524288 };
export const DEPTH = { Basic: 1, Local: 2, Deep: 4, Global: 8 };                     // privilegedepthmask
export const PRIVILEGE_PREFIX = { Create: 'prvCreate', Read: 'prvRead', Write: 'prvWrite', Delete: 'prvDelete', Append: 'prvAppend', AppendTo: 'prvAppendTo', Assign: 'prvAssign', Share: 'prvShare' };
export const ACCESS_MODE = { ReadWrite: 0, Administrative: 1, Read: 2, SupportUser: 3, NonInteractive: 4, DelegatedAdmin: 5 };
export function uuidV5(namespace, name) => lowercase GUID (RFC 4122 v5, SHA-1)
export function privilegeId(organizationId, name) => uuidV5(organizationId, `privilege:${name}`)
export function privilegeName(operation, schemaName) => e.g. prvReadAccount           // schemaName PascalCase of the table SchemaName (capitalize logical name when unknown)
export function ensureSecurityModel(store, { organizationId, tenantId, uniqueName, friendlyName, version, applications = [], users = [] }, { schema } = {})
// Idempotent. Inside store.transact: adds userConfigured mappings for the ten security tables (entity sets: organizations, businessunits, systemusers, teams, roles, systemuserrolescollection, teammemberships, teamrolescollection, roleprivilegescollection, privileges; idColumn <logical>id except systemuserroles→systemuserroleid, teamroles→teamroleid, teammembership→teammembershipid, roleprivileges→roleprivilegeid; nameColumn fullname/name; fields with dataverseType; relationships incl. N:N intersects systemuserroles_association (systemuser↔role), teammembership_association (team↔systemuser), teamroles_association (team↔role), roleprivileges_association (role↔privilege), lookups businessunitid, parentbusinessunitid, parentsystemuserid, administratorid, organizationid), then rows:
//   organization (1), root businessunit (name = uniqueName), roles System Administrator / System Customizer / Basic User (built-in templates: Admin & Customizer = Global on every privilege; Basic User = Basic on Create/Read/Write/Delete/Append/AppendTo/Assign/Share for user-owned tables, Global Read on organization-owned reference tables), privilege rows for every table in schema/mappings × 8 rights (organization-owned tables omit Assign/Share), roleprivileges rows, SYSTEM user (fullname 'SYSTEM', accessmode 4, isdisabled false), application users for `applications` (fullname = displayName, applicationid = appId, azureactivedirectoryobjectid = uuidV5(appId,'sp'), accessmode 4, isdisabled false, businessunitid root, domainname = `${appId}@${tenantId}`), interactive users for `users`.
// Returns { organizationId, rootBusinessUnitId, systemUserId, roleIds: { 'System Administrator': id, ... }, userIds: { [appId|objectId]: systemuserid } }.
export function createPrincipals(store, settings) => {
  byObjectId(oid), byApplicationId(appId), byDomainName(name), byId(systemuserid),
  resolve(claims) => { user, reason } // app-only: applicationid === appid/azp; delegated: azureactivedirectoryobjectid === oid, fallback domainname === upn/preferred_username. reason: 'unknown' | 'disabled' | null
  roles(userId) => [{ roleid, name }] (direct + team roles),
  privileges(userId) => Map<privilegeName, depthMask>  // max depth across roles
  businessUnitChain(businessUnitId) => Set of this BU and all descendants
  authorize({ user, entity, operation, row, mapping, schema }) // throws DataError(403, 'PrivilegeDenied') with Dataverse message; checks table ownership type: organization-owned → any depth passes; user/team-owned → Basic requires owner = user or owner team ∈ user's teams, Local → owningbusinessunit = user BU, Deep → owningbusinessunit ∈ chain(user BU), Global → pass. Operation names: 'read'|'create'|'update'|'delete'|'append'|'appendto'|'assign'|'share'.
  readFilter({ user, entity, mapping }) => (row) => boolean   // same rule for collections; returns null when Global
  ownershipDefaults({ user, mapping, now }) => { ownerid: {id, logical_name:'systemuser', name}, owninguser, owningbusinessunit, createdby, modifiedby } (lookup object form the store uses)
  modifiedBy({ user }) => { modifiedby }
  canImpersonate(user) => boolean  // prvActOnBehalfOfAnotherUser
  retrieveUserPrivileges(userId) => [{ Depth: 'Basic'|'Local'|'Deep'|'Global', PrivilegeId, BusinessUnitId, PrivilegeName }]
  principalAccess({ user, entity, row }) => 'ReadAccess, WriteAccess, ...'  // flags string
}
export function createApplicationUser(store, settings, { appId, displayName, roles }) => systemuserid
export function assignRoles(store, { systemuserid, roleIds })
```

Privilege-denied message (403, code `0x80040220`):
`Principal user (Id=<systemuserid>, type=8, roleCount=<n>, privilegeCount=<m>, accessMode=<accessmode>), is missing prv<Op><Schema> privilege (Id=<privilegeid>) on OTC=<otc> for entity '<logical>' (LocalizedName='<display label>'). context.Caller=<systemuserid>. Consider adding missing privilege to one of the principal (user/team) roles for the request to succeed.`
Depth-denied on a specific row (403, code `0x80048306`): `Principal with ID <systemuserid> does not have <Read|Write|Delete|Append|AppendTo|Assign|Share>Access right(s) for record with ID <recordid> of entity <logical>.`

### `dataverse-metadata.mjs`

```js
export function createMetadataService({ organizationId, schema, mappings, lcid = 1033, virtualTables = () => ({}) })
// schema: () => solutionData.schema (may be null for fixture-only states); mappings: () => store.state.mappings
{
  metadataId(kind, ...parts) => uuidV5(organizationId, `${kind}:${parts.join(':')}`),   // 'entity:account', 'attribute:account:name', 'relationship:Schema', 'optionset:name', 'key:account:name'
  objectTypeCode(logical) => known standard OTC (account 1, contact 2, systemuser 8, team 9, businessunit 10, organization 1019, role 1036, annotation 5, activitypointer 4134, systemuserroles 1037?, privilege 1023, roleprivileges 1024, teammembership 1024?, queue 2020, transactioncurrency 9105) else 10000 + stable hash
  entities() => [EntityMetadata], entity(keyOrLogical) => EntityMetadata | null,
  attributes(logical, { cast, key, select, expand }) => [AttributeMetadata],
  keys(logical) => [EntityKeyMetadata { KeyAttributes, EntityKeyIndexStatus: 'Active', LogicalName, SchemaName, DisplayName, MetadataId }],
  manyToOne(logical), oneToMany(logical), manyToMany(logical) => relationship metadata arrays,
  relationship(schemaName) => OneToMany | ManyToMany | null, relationships({ cast }) => [],
  globalOptionSets(), globalOptionSet(name),
  serviceDocument(origin, version) => { '@odata.context': `${origin}/api/data/${version}/$metadata`, value: [{ name, kind: 'EntitySet', url }] },
  csdl(origin, { annotations }) => string (EDMX 4.0; Schema Namespace Microsoft.Dynamics.CRM Alias mscrm; crmbaseentity abstract; EntityType per table with Key, Property Edm.* types per `attribute-metadata.mjs` mapping, `_x_value` computed lookups, NavigationProperty single (Partner, ReferentialConstraint) and collection; EntityContainer Name="System" with EntitySet + NavigationPropertyBinding; ComplexType WhoAmIResponse, RetrieveVersionResponse, RetrieveCurrentOrganizationResponse (+OrganizationDetail, EndpointCollection), RetrieveTotalRecordCountResponse, RetrievePrincipalAccessResponse, RetrieveUserPrivilegesResponse, RolePrivilege; Function WhoAmI/RetrieveVersion/RetrieveCurrentOrganization/RetrieveTotalRecordCount/RetrievePrincipalAccess (bound)/RetrieveUserPrivileges (bound)/RetrieveMetadataChanges; Action CreateMultiple/UpdateMultiple/UpsertMultiple (bound to collections), GrantAccess, Merge),
  retrieveMetadataChanges(queryJson, { clientVersionStamp }) => { ServerVersionStamp, DeletedMetadata: {Count:0,IsReadOnly:false,Keys:[],Values:[]}, EntityMetadata: [Complex* shapes with requested properties, unrequested as null] },
  filterMetadata(items, odataFilter) => items  // eq/ne/and/or/not, enum literals Microsoft.Dynamics.CRM.X'Y', nested Value paths (RequiredLevel/Value), string/boolean/guid literals
  selectMetadata(item, select) => object (MetadataId always kept)
}
```

Shapes follow Microsoft Learn (`webapi-contract.md` §8): `EntityMetadata` includes `MetadataId, LogicalName, SchemaName, EntitySetName, LogicalCollectionName, PrimaryIdAttribute, PrimaryNameAttribute, ObjectTypeCode, OwnershipType ('UserOwned'|'OrganizationOwned'), IsCustomEntity, IsActivity, IsIntersect, IsValidForAdvancedFind, HasChanged: null, DisplayName/DisplayCollectionName/Description {LocalizedLabels, UserLocalizedLabel}, Keys?, Attributes? (expanded only)`. Attributes reuse `attributeMetadata()` from `attribute-metadata.mjs` (fill `MetadataId`, `EntityLogicalName`, `ColumnNumber`) and add `@odata.type: '#Microsoft.Dynamics.CRM.<Type>AttributeMetadata'`. Security tables get a built-in schema when the Solution schema lacks them.

### `dataverse-odata.mjs`

```js
export const VERSIONS = ['v9.0', 'v9.1', 'v9.2'];
export function parseDataverseRoute(pathname) => null | {
  version, kind: 'service' | 'metadata' | 'batch' | 'collection' | 'entity' | 'property' | 'value' | 'ref' | 'count' | 'navigation' | 'navigationCount' | 'navigationRef' | 'function' | 'boundFunction' | 'action' | 'boundAction' | 'metadataEntity' ...,
  set, key /* raw key text */, segment, cast /* Microsoft.Dynamics.CRM.X */, name /* function/action */, params /* raw inline params text */, targetKey, soap: boolean
}
export function parseKey(text) => { id } | { alternate: { col: value } } | null       // reuse parseKeySegment from data.mjs; reject guid'…' and parameter aliases
export function parseFunctionParameters(text, searchParams) => { name: value }       // inline `A='x',B=@p1` + aliases `@p1=...`; enum literal Microsoft.Dynamics.CRM.T'Member' → 'Member'; `{'@odata.id':'...'}` → { '@odata.id' }; JSON arrays
export function parsePrefer(header) => { annotations: string[] | '*' | null, maxPageSize: number | null, representation: boolean, continueOnError: boolean, trackChanges: boolean, respondAsync: boolean, raw }
export function preferenceApplied(prefer, { paged }) => string | null
export function annotationMatcher(spec) => (name) => boolean                          // reuse webapi-handler.mjs annotationMatcher
export function contextUrl(origin, version, suffix) => `${origin}/api/data/${version}/$metadata#${suffix}`
export function entityUrl(origin, version, set, keyText) => `${origin}/api/data/${version}/${set}(${keyText})`
export function encodeSkipToken({ pageNumber, lastId, firstId, idColumn, countOfRecords }) => string   // `<cookie pagenumber="2" pagingcookie="<double-encoded <cookie page="1"><idcol last="{GUID}" first="{GUID}" /></cookie>>" istracking="False" />`
export function decodeSkipToken(text) => { pageNumber, lastId, firstId, idColumn } | null
export function fetchXmlPagingCookie({ pageNumber, lastId, firstId, idColumn }) => string
export function dataverseError(error, { prefer, logical, requestId }) => { status, body: { error: { code, message, '@Microsoft.PowerApps.CDS.ErrorDetails.OperationStatus'?, ... } }, headers: { 'REQ_ID', 'x-ms-service-request-id', 'WWW-Authenticate'? , 'Retry-After'? } }
export function baseHeaders(requestId) => { 'OData-Version': '4.0', 'x-ms-service-request-id': requestId, 'REQ_ID': requestId, 'x-ms-ratelimit-burst-remaining-xrm-requests': '5999', 'x-ms-ratelimit-time-remaining-xrm-requests': '1199.99', 'x-ms-dop-hint': '4', 'cache-control': 'no-cache', 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' }
export const JSON_CONTENT_TYPE = 'application/json; odata.metadata=minimal';
export function orderAnnotations(object) => object   // annotations precede their value; '@odata.nextLink' last; '@odata.context' first, then '@odata.count', '@odata.etag'
```

Error mapping (store `DataError.code` → HTTP/code/message):

| Store condition | Status | `error.code` | message |
| --- | --- | --- | --- |
| Unknown entity set / route | 404 | `0x8006088a` | `Resource not found for the segment '<segment>'.` |
| Unknown function/action or wrong verb | 404 | `` | `No HTTP resource was found that matches the request URI '<url>'.` |
| Record not found (`NotFound`) | 404 | `0x80040217` | `<logical> With Id = <id> Does Not Exist` |
| Unknown property in `$select`/`$filter`/`$orderby`/`$expand` | 400 | `0x0` | `Could not find a property named '<p>' on type 'Microsoft.Dynamics.CRM.<logical>'.` |
| Unknown property in payload | 400 | `0x0` | `An error occurred while validating input parameters: Microsoft.Crm.CrmException: Invalid property '<p>' was found in entity 'Microsoft.Dynamics.CRM.<logical>'. ---> Microsoft.OData.ODataException: Does not support untyped value in non-open type.` |
| Bad nav bind / payload shape (`0x80048d19`) | 400 | `0x80048d19` | `Error identified in Payload provided by the user for Entity :'<set>'  ---->  InnerException : <detail>` |
| Query parse / unsupported option / `$skip` / URI too long | 400 | `0x80060888` | passthrough (`$skip` → `The query parameter $skip is not supported`) |
| Too many conditions | 400 | `0x8004430C` | `Number of conditions in query exceeded maximum limit.` |
| Validation (length, range, choice) | 400 | `0x80044331` | `A validation error occurred.  <detail>` |
| Invalid argument | 400 | `0x80040203` | `Invalid argument.` |
| Alternate key violation | 412 | `0x80060892` | `Entity Key <key> violated. A record with the same value for <cols> already exists. A duplicate record cannot be created. Select one or more unique values and try again.` |
| `If-None-Match: *` on existing | 412 | `` | `A record with matching key values already exists.` |
| ETag mismatch | 412 | `0x80060882` | `The version of the existing record doesn't match the RowVersion property provided.` |
| `If-Match: *` missing record | 404 | `` | `<logical> With Id = <id> Does Not Exist` |
| Privilege denied | 403 | `0x80040220` | see security module |
| Record access denied | 403 | `0x80048306` | see security module |
| Missing/invalid/expired token | 401 | (no body) | header `WWW-Authenticate: Bearer authorization_uri="<origin>/<tenantId>/oauth2/authorize", resource_id="<origin>/"` (quoted values; invalid tokens add `error="invalid_token", error_description="Error during token validation!"` before `authorization_uri`) |
| Principal not a user | 401 | `0x80072560` | `The user is not a member of the organization.` |
| User disabled | 401 | `0x80040225` | `The specified user(Id = <systemuserid>) is disabled. Consider enabling this user. Additional Details: The user is disabled in Dataverse.` |
| Business unit disabled | 401 | `0x8004032c` | `The business unit <name> for user(Id = <systemuserid>) is disabled.` |
| Unsupported write on intersect/virtual table | 405 | `` | `The requested resource does not support http method '<METHOD>'.` |
| Not implemented | 501 | `0x80040216` | `<feature> has not yet been implemented.` |
| Service protection | 429 | `0x80072322` | `Number of requests exceeded the limit of 6000 over time window of 300 seconds.` + `Retry-After` |
| Unexpected | 500 | `0x80040216` | `An unexpected error occurred.` |

With `Prefer: odata.include-annotations="*"` (or `Microsoft.PowerApps.CDS.*`), the error adds `@Microsoft.PowerApps.CDS.ErrorDetails.OperationStatus: "0"`, `@Microsoft.PowerApps.CDS.ErrorDetails.SubErrorCode: "-2146233088"`, `@Microsoft.PowerApps.CDS.HelpLink: "http://go.microsoft.com/fwlink/?LinkID=398563&error=Microsoft.Crm.CrmException%3a<code>&client=platform"`, `@Microsoft.PowerApps.CDS.TraceText: ""`, `@Microsoft.PowerApps.CDS.InnerError.Message: <message>`.

### `dataverse-api.mjs`

```js
export async function startDataverseApi({
  store, change, settings /* normalized */, host = '127.0.0.1',
  schema: () => solutionData?.schema ?? null, metadataFields: (logical) => fields,
  observed, clock = () => Date.now(), tls /* { key, cert } | null */, log = () => {},
}) => {
  origin, tlsOrigin /* null unless tls */, authority /* `${origin}/${tenantId}` */, tenantId, organizationId,
  servers: [http.Server, https.Server?],
  requests: () => [{ at, method, path, status, ms, appId, userId, grant? }]  // ring buffer 500, Authorization and bodies never logged
  close() => Promise<void>,
  handle(req, res) // exported for in-process tests
}
```

Routing inside `handle`:

1. `OPTIONS *` → 204 with `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Headers: *`, `Access-Control-Expose-Headers: OData-EntityId, ETag, Preference-Applied, x-ms-service-request-id, REQ_ID, Retry-After, x-ms-dop-hint`. Same `Access-Control-*` headers on every response (SPA clients).
2. STS paths (`/{tenant}/...`, `/common/...`, `/organizations/...`, `/consumers/...`) → auth module. No bearer needed.
3. `/api/discovery/v2.0/Instances`, `/api/discovery/v2.0/Instances(<id>)`, `/api/discovery/v2.0/Instances(UniqueName='x')` → bearer verified against `aud` ∈ {origin, `https://globaldisco.crm.dynamics.com`}; response `{ '@odata.context': `${origin}/api/discovery/v2.0/$metadata#Instances`, value: [{ Id, UniqueName, UrlName, FriendlyName, State: 'Enabled', Version, Url: origin, ApiUrl: origin, LastUpdated, Region: 'NA', OrganizationType: 'Default', TenantId, EnvironmentId, DatacenterId, Geo: 'NA', Purpose: null, StatusMessage: null, TrialExpirationDate: '9999-12-31T23:59:59.9999999Z', SchemaType: 'Standard' }] }`.
4. `POST /XRMServices/2011/Organization.svc/web` → 500 SOAP fault `text/xml; charset=utf-8`.
5. `/api/data/<version>/...` → parse route; `GET`, `HEAD`, `POST`, `PATCH`, `PUT`, `DELETE`; reject others 405. Bearer required for everything (service document and `$metadata` included; Dataverse requires auth for both). Then `principals.resolve(claims)` → 401 mappings above. Impersonation: `CallerObjectId` (oid) or `MSCRMCallerID` (systemuserid) requires caller `prvActOnBehalfOfAnotherUser` else 403 `0x80040220`; effective user = impersonated; `createdonbehalfby`/`modifiedonbehalfby` = caller.
6. Service protection (optional): sliding window per `userId` → 429.
7. Dispatch by `kind`:
   - `service` → `metadata.serviceDocument`; `metadata` → CSDL `application/xml`; `batch` → `dataverse-batch.mjs`.
   - `collection` GET: validate query options (`$select,$filter,$expand,$orderby,$top,$count,$apply,fetchXml,savedQuery,userQuery`, parameter aliases `@p`); `$skip`, `$search`, `$format` → 400 `0x80060888`. Paging: `Prefer: odata.maxpagesize` (≤ 5000) or default 5000; `$top` ignored when maxpagesize set; `$skiptoken` from `decodeSkipToken` → offset into the stable ordered result (order = `$orderby` then primary id ascending, same as the portal `sortRows` tie-break); `@odata.nextLink` only when more rows; `@odata.count` capped 5000 when `$count=true`; `@Microsoft.Dynamics.CRM.totalrecordcount` / `totalrecordcountlimitexceeded` when annotations request them (`-1` without `$count`). Authorization: `authorize read` on the table (privilege), then `backendRowFilter` from `readFilter`. `fetchXml=`: `store.fetchXml` with `profile: 'webapi'`? no: plain `store.fetchXml(xml, identity, { metadata, backendRowsFilter })`; set must match `<entity name>` (else 400 `0x80060888` `The entity set name '<set>' does not match the FetchXml entity '<name>'.`); null columns omitted; linked columns `alias.column`; paging annotations `@Microsoft.Dynamics.CRM.fetchxmlpagingcookie` / `morerecords` only when requested and more pages exist.
   - `collection` POST: body validation (`@odata.type`, `@odata.context` tolerated), `@odata.bind` resolution accepting `/set(key)`, `set(key)`, absolute `${origin}/api/data/vX/set(key)`, alternate-key form; deep insert passthrough (`store.splitDeepInsert`); `authorize create` + `authorize append/appendto` for binds; inject `ownershipDefaults`; `store.createRecord`; 204 + `OData-EntityId` or, with `return=representation`, 201 + body (`$select`/`$expand` honoured) + `Preference-Applied: return=representation`.
   - `entity` GET: `$select`/`$expand`; `If-None-Match: W/"..."` → 304 (no body; `OData-Version`, `Content-Type`) unless `$expand` or annotations requested; `ETag` header = `@odata.etag`.
   - `entity` PATCH: upsert semantics per `If-Match`/`If-None-Match`; alternate keys set key columns on create; `authorize update` (or `create` on upsert-create); 204 + `OData-EntityId` or 200 + representation. `ownerid@odata.bind` change requires `assign`. `statecode`/`statuscode` via `store` (`assertStateStatus`).
   - `entity` DELETE: `authorize delete`; 204; cascade handled by store.
   - `property` GET → `{ '@odata.context': `.../$metadata#<set>(<id>)/<prop>`, value }`; null → 204. `value` GET → `text/plain` (binary → `application/octet-stream`). `PUT property` body `{ value }` → 204. `DELETE property` → null → 204.
   - `navigation` GET single → entity response of the target set (context `$metadata#<targetset>(<select>)/$entity`); collection → collection response with nextLink `.../<set>(<id>)/<nav>?...`. `navigationCount` → `text/plain` count. `navigationRef` GET → `{ '@odata.context': '...$metadata#Collection($ref)', value: [{ '@odata.id' }] }` or single `{ '@odata.id' }`; `POST ref` (collection) → `store.associate` (`authorize append` on child, `appendto` on parent); `PUT ref` (single) → bind update; `DELETE ref` with `(key)` or `?$id=` → disassociate; 204.
   - `count` → `text/plain`, count capped 5000, `Content-Type: text/plain`.
   - `function` GET (unbound): `WhoAmI` → `{ '@odata.context': '...#Microsoft.Dynamics.CRM.WhoAmIResponse', BusinessUnitId, UserId, OrganizationId }`; `RetrieveVersion` → `{ Version }`; `RetrieveCurrentOrganization(AccessType=@p)` (also the literal form `RetrieveCurrentOrganization(AccessType='Default')` that ServiceClient sends, at any version) → `{ Detail: { OrganizationId, FriendlyName, OrganizationVersion, EnvironmentId, DatacenterId, Geo, TenantId, UrlName, UniqueName, OrganizationType: 'Default', SchemaType: 'Standard', State: 'Enabled', Endpoints: { Count: 3, IsReadOnly: false, Keys: ['OrganizationService','OrganizationDataService','WebApplication'], Values: [`${origin}/XRMServices/2011/Organization.svc`, `${origin}/XRMServices/2011/OrganizationData.svc`, `${origin}/`] } } }`; `RetrieveTotalRecordCount(EntityNames=@p)` → dictionary shape; `RetrieveMetadataChanges(Query=@p1[,ClientVersionStamp=@p2,DeletedMetadataFilters=@p3])`; `GetTimeZoneCodeByLocalizedName`/`FormatAddress`/others → 501 `0x80040216`. Unknown → 404.
   - `boundFunction`: `systemusers(id)/Microsoft.Dynamics.CRM.RetrieveUserPrivileges` → `{ RolePrivileges }`; `.../RetrievePrincipalAccess(Target=@p)` → `{ AccessRights }`; without FQN → 400 `Request message has unresolved parameters`.
   - `action` POST (unbound): `GrantAccess`, `RevokeAccess`, `ModifyAccess` (milestone 3, `principalobjectaccess` rows), `Merge` → 501, `WinOpportunity`/`ExecuteWorkflow` → 501, `PublishXml`/`PublishAllXml` → 204 no-op, `AddSolutionComponent`/`RemoveSolutionComponent`/`ExportSolution` → 501, `ExecuteFetchXml`? (not a Web API action) → 404.
   - `boundAction` POST on collections: `CreateMultiple` → 200 `{ Ids }`, `UpdateMultiple` → 204, `UpsertMultiple` → 204, `DeleteMultiple` → 501 `DeleteMultiple has not yet been implemented.` (standard tables); all-or-nothing inside one `store.transact`. `roles(id)/Microsoft.Dynamics.CRM.AddPrivilegesRole` → 204.
   - `metadataEntity` (`EntityDefinitions`, `RelationshipDefinitions`, `GlobalOptionSetDefinitions`): GET → metadata module; `+` decodes as space in query strings (use `URLSearchParams`, which already does). Writes (POST/PUT/DELETE) → 501 in milestones 1-2 (provisioning simulation is a later gate).
8. Every response: `baseHeaders(requestId)` + `Content-Type: application/json; odata.metadata=minimal` (JSON bodies) + `Preference-Applied` when applicable; `HEAD` mirrors GET without body; `orderAnnotations` on bodies; `stringifyExactJson` for exact numerics (money 4 decimals as the store reports).

### `dataverse-records.mjs` (record handlers, called by `dataverse-api.mjs`)

The router owns sockets, authentication, STS, discovery, functions and metadata routes. Everything that touches table rows lives here, behind one interface so both halves can be built and tested independently:

```js
export function createRecordHandlers({ store, change, principals, metadata, metadataFields, objectTypeCode, clock = () => Date.now() })
// returns { async handle(ctx) }
// ctx = {
//   method,                       // GET|POST|PATCH|PUT|DELETE (HEAD already mapped to GET by the router)
//   route,                        // result of parseDataverseRoute: kinds collection, count, entity, property, value, member, ref, navigationRef, navigationCount, boundAction (collection-bound CreateMultiple/UpdateMultiple/UpsertMultiple/DeleteMultiple)
//   url,                          // WHATWG URL of the request (searchParams carry $select etc.; '+' already decoded as space)
//   origin, version,              // e.g. 'http://127.0.0.1:5555', 'v9.2'
//   prefer,                       // parsePrefer(header)
//   headers,                      // lower-cased request headers (if-match, if-none-match, mscrm.*, callerobjectid ...)
//   body,                         // parsed JSON body (object) or undefined; parse errors were already answered by the router
//   user,                         // systemuser row of the effective caller (after impersonation)
//   caller,                       // systemuser row of the authenticated principal (same as user unless impersonating)
//   identity,                     // { admin: true, id, systemUserId, businessUnitId, dataverse: {...} } for store calls
//   requestId,
// }
// resolves to { status, headers?: {}, body?: object | string | null }
//   object body  → router serializes with orderAnnotations + stringifyExactJson, content-type application/json; odata.metadata=minimal
//   string body  → text/plain; charset=utf-8 (for $count and $value)
//   null/absent  → no body (204/304)
// Errors: throw DataError / Error; the router converts with dataverseError (pass `details.id` for NotFound so the message template can render).
```

The handlers call `principals.authorize(...)` before every store call and `principals.readFilter(...)` for collections; inject `principals.ownershipDefaults(...)` on create and `modifiedBy` on update; use `principals.canImpersonate` is the router's job. Paging: `Prefer: odata.maxpagesize` (default and cap 5000); `$skiptoken` decodes to `pageNumber` → offset `(pageNumber - 1) * pageSize` (ponytail: offset paging behind a Dataverse-shaped cookie; cursor paging if volumes ever matter); `@odata.nextLink` = same URL with `$skiptoken=<encodeURIComponent(encodeSkipToken(...))>` appended, only when more rows remain.

### Admin endpoints (`mirage/server.mjs`, inside `admin()` after the CSRF gate)

| Method and path | Effect |
| --- | --- |
| `GET /_sim/api/dataverse` | `{ enabled, origin, tlsOrigin, authority, tenantId, organizationId, uniqueName, version, applications: [{ appId, displayName, secrets: [{ id, hint, expiresOn }], certificates: [{ thumbprint }], allowedGrants, publicClient, redirectUris, systemuserid }], users: [{ systemuserid, fullname, domainname, applicationid, azureactivedirectoryobjectid, accessmode, isdisabled, roles: [names] }], roles: [{ roleid, name }], requests: [...] }` |
| `POST /_sim/api/dataverse/applications` | body `{ displayName, appId?, roles?, publicClient?, redirectUris?, allowedGrants? }` → 201 `{ appId, systemuserid, secret }` (secret shown once) |
| `POST /_sim/api/dataverse/applications/<appId>/secrets` | → 201 `{ id, secret, hint, expiresOn }` |
| `DELETE /_sim/api/dataverse/applications/<appId>/secrets/<id>` | 204 |
| `POST /_sim/api/dataverse/applications/<appId>/certificates` | body `{ publicKeyPem }` → 201 `{ thumbprint }` |
| `DELETE /_sim/api/dataverse/applications/<appId>` | removes registration and its application user; 204 |
| `POST /_sim/api/dataverse/users` | body `{ fullname, domainname, objectId?, roles?, password?, accessmode?, businessUnitId? }` → 201 `{ systemuserid, azureactivedirectoryobjectid }` |
| `PATCH /_sim/api/dataverse/users/<systemuserid>` | `{ roles?, isdisabled?, password?, accessmode? }` → 200 |
| `GET /_sim/api/dataverse/requests` | ring buffer (for gates) |
| `POST /_sim/api/dataverse/token` | test convenience: `{ appId }` → `{ access_token }` for an application user without a secret round-trip (admin-only, CSRF protected) |

Passwords (ROPC) are stored as `{ hash, salt }` in a private `state.dataverse.passwords[systemuserid]`.

`exposedState()` and `statusPayload()` add `dataverse: { enabled, origin, tlsOrigin, authority, tenantId, organizationId }`; `mirage status` prints the org URL and authority.

### `lense/dataverse/connection.mjs` change (gate #0 prerequisite)

Additive: `tokenProvider(connection, { fetchImpl, allowLoopback = false })` honours an optional `connection.authorityHost` only when `allowLoopback` is true and the host is an `http(s)://127.0.0.1|localhost|[::1]` origin; otherwise the hardcoded `https://login.microsoftonline.com` stays. `environmentOrigin` gains the same `allowLoopback` escape, and `connectedClient(connection, { allowLoopback })` passes it through. One regression: non-loopback `authorityHost` is rejected.

## Milestones

**M1 — auth, users, baseline API** (commit `feat(mirage): simulated Dataverse Web API with OAuth and security roles`)
auth module (client_credentials secret, refresh, OIDC, JWKS, verify), security module, metadata module (EntityDefinitions/Keys/ManyToOne/ManyToMany/Attributes, service document), odata module, api module (listeners, discovery, WhoAmI, RetrieveVersion, RetrieveCurrentOrganization, RetrieveTotalRecordCount, collection/entity/property/navigation/ref/count CRUD, fetchXml, paging, annotations, errors), settings, server wiring, admin endpoints, docs, gate #0 (toolkit client) and gate `dynamics-web-api` (variant B).

**M2 — surface completion** (commit `feat(mirage): Dataverse $batch, metadata document and delegated token flows`)
`$batch` with changesets and `$n` references, `$metadata` CSDL, `RetrieveMetadataChanges`, `$apply`, bulk actions, bound functions, authorization_code + PKCE, device_code, ROPC, OBO, certificate assertions, TLS listener and certificate generator, `python-dataverse` gate (TLS + MSAL OIDC), `dynamics-web-api` variant A, `webapi-samples` gate.

**M3 — error parity and corner cases** (commit `fix(mirage): Dataverse Web API error parity and corner cases`)
304 rules, ETag/If-Match matrix, alternate-key and duplicate errors, impersonation, access sharing (`GrantAccess`/`RetrievePrincipalAccess`), service protection 429 with `Retry-After`, header matrix (`MSCRM.*`, `Consistency`), `Prefer` malformed 400 `0x80097303`, URL and segment limits, change tracking (`odata.track-changes`, `$deltatoken`) if feasible, ServiceClient gate on port 80 + SOAP fault, Opus parity review against research notes, `/_sim/` admin UI panel.

Each milestone ends with `npm run check`, `npm --prefix mirage test` (full), the SDK gates built so far, and a conventional commit on `feature/dataverse-api`.

## Out of scope (stated, not deferred silently)

SOAP `Organization.svc`, Dataverse search (`/api/search/`), elastic tables, file/image streaming, solution import/export simulation, metadata writes (EntityDefinitions POST/PUT), plug-in registration through the API, `pac` CLI (cannot target loopback), browser-based MSAL.js sign-in UI beyond the minimal picker.
