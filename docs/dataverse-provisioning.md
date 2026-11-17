# Dataverse schema provisioning

`paqvilo dataverse` creates schema through the Dataverse Web API, exports the server-generated solution
and seeds reproducible data. It is an explicit workflow, separate from Lense overlays and Mirage
simulation. The toolkit is generic; the project's manifest owns table names, publisher, relationships,
component ownership and XML templates. Run `paqvilo dataverse --help` for every command.

Requirements: Node `^26.13.1`, and PAC with an authenticated administrator for the initial app
registration. Later metadata operations use the application's own client credentials without switching
the active PAC profile. Only the public Microsoft cloud is supported. Windows connections use DPAPI
CurrentUser; other hosts use an environment-secret reference. Tokens stay in memory. Never commit
connections, registration recovery files, real exports or journals.

## Application and connection

```sh
paqvilo dataverse register --name "Project Schema Provisioning" --role "System Customizer" --connection .paqvilo/dataverse/connection.json
paqvilo dataverse inspect --connection .paqvilo/dataverse/connection.json
paqvilo dataverse verify --connection .paqvilo/dataverse/connection.json
```

`register` runs `pac admin create-service-principal` against the active PAC environment (or
`--environment`). PAC creates the Entra application and service principal and attempts the Power
Platform/Dataverse registration; this wrapper's default role is System Customizer instead of PAC's System
Administrator. Tenant permissions are separate from Dataverse roles. PAC can fail after creating the
Entra app, including with exit code zero
([PAC contract](https://learn.microsoft.com/en-us/power-platform/developer/cli/reference/admin#pac-admin-create-service-principal)).

Duplicate protection, before any application is created:

1. An existing connection or registration marker stops the attempt.
2. Every `*.json` directly in the `--connection` folder is read for its environment and name fields;
   one with the same environment origin or application name (case-insensitive) refuses with
   `REGISTRATION_EXISTS`, naming the file to reuse with `inspect` or `verify`. Unreadable files and files
   without an environment are ignored.
3. `pac admin list-service-principal --filter NAME --max 50` must list no application whose whole name
   equals the requested one (case-insensitive); otherwise `REGISTRATION_EXISTS`. If the listing fails,
   registration stops.

`--allow-additional-application` skips steps 2 and 3 when a second application is intended. PAC output
is captured privately (recovery evidence is encrypted before parsing) and never printed. After a partial
registration, inspect the `.registration.json` state, complete that application's user/role assignment
and obtain a credential for the same application; the toolkit never creates another app or escalates
roles.

```sh
paqvilo dataverse connect --registration .paqvilo/dataverse/connection.json.registration.json --secret-file .paqvilo/dataverse/credential.txt --connection .paqvilo/dataverse/connection.json --role "System Customizer" --consume-secret-file
```

The secret file holds the value alone, a JSON object (`clientId`, `tenantId`, `value`, `secretId`,
optional `expiration`), labelled lines, or a two-line CSV with those headers. Identity fields are
validated and must match the registration. `connect` authenticates, verifies the organization, records
the application user's roles, saves the DPAPI-protected secret and, with `--consume-secret-file`, deletes
the plaintext file after saving. `secretId` is metadata; credential expiry is unknown unless supplied.

Connection records and secret files must be inside ignored `.paqvilo/`. DPAPI ciphertext works only for
the Windows user and machine that wrote it. For another runner, write a private connection with
`schemaVersion: 1`, `environmentUrl`, `tenantId`, `clientId`, optional `organisationId`,
`credentialSource: "environment"` and `secretEnvironmentVariable: "PROJECT_DATAVERSE_SECRET"`, and inject
that variable from the runner's secret store. Never put a secret in committed JSON or arguments.

The token request always goes to `https://login.microsoftonline.com`, with tenant and client GUIDs
validated, the scope confined to the configured HTTPS organization and redirects disabled, so a
connection file cannot send the credential elsewhere.

`saveProtectedState(file, value, { purpose, exclusive })` and `loadProtectedState(file, { purpose })`
store caller-generated credentials as JSON encrypted with DPAPI CurrentUser under ignored `.paqvilo/`,
with atomic fsynced writes. Creation is exclusive by default (`exclusive: false` replaces); the purpose
label is checked inside and outside the ciphertext. Save returns metadata only; load decrypts into
memory. There is no fallback on non-Windows platforms, and these functions create no identities.

## Manifest and execution

Keep `dataverse/manifest.json` in the owning project. Minimal shape:

```json
{
  "schemaVersion": 1,
  "language": 1033,
  "publisher": {
    "uniqueName": "ExamplePublisher",
    "friendlyName": "Example Publisher",
    "prefix": "exmp",
    "optionValuePrefix": 12345
  },
  "solutions": [{ "uniqueName": "ExampleSchema", "friendlyName": "Example Schema", "version": "1.0.0.0" }],
  "tables": [
    {
      "name": "exmp_item",
      "entitySetName": "exmp_items",
      "label": "Item",
      "pluralLabel": "Items",
      "ownership": "organization",
      "solution": "ExampleSchema",
      "primaryName": { "name": "exmp_name", "label": "Name", "maxLength": 160 },
      "columns": [{ "name": "exmp_code", "label": "Code", "type": "string", "maxLength": 40, "required": "required" }],
      "keys": [{ "name": "exmp_item_code", "columns": ["exmp_code"] }]
    }
  ]
}
```

```sh
paqvilo dataverse plan --manifest dataverse/manifest.json --out .paqvilo/dataverse/offline-plan.json
paqvilo dataverse plan --manifest dataverse/manifest.json --connection .paqvilo/dataverse/connection.json --out .paqvilo/dataverse/remote-plan.json
paqvilo dataverse apply --manifest dataverse/manifest.json --connection .paqvilo/dataverse/connection.json
paqvilo dataverse publish --manifest dataverse/manifest.json --connection .paqvilo/dataverse/connection.json
paqvilo dataverse keys --manifest dataverse/manifest.json --connection .paqvilo/dataverse/connection.json
paqvilo dataverse export --connection .paqvilo/dataverse/connection.json --solution ExampleSchema --out .paqvilo/exports/ExampleSchema.zip --unpack solutions/ExampleSchema
```

**plan** without a connection makes no requests. With one it reads metadata and reports
create/exists/drift and the solution membership apply will write: `membership:add` (missing components
and primary-name/lookup attributes; a null object ID for components apply will create),
`membership:scope-root` (declared table roots apply re-scopes with RemoveSolutionComponent then
AddSolutionComponent) and `blocked` (undeclared IncludeAll roots), summarized in `summary.membershipAdd`,
`summary.rootScoping` and `summary.blocked`. Membership of solutions apply will create, and roots apply
narrows on tables it creates, cannot be listed. Plan never writes; `--out` saves full payloads and
prints a summary, `--json` prints the plan.

**apply** verifies the organization, preflights every component, refuses blocked roots before its first
write, rechecks each identity before creating it and repairs solution membership. Incompatible metadata
blocks creation before the first write; a compatible rerun with complete membership writes nothing. The
publisher identity of an existing solution is checked separately from its display name. Order:
publisher, solutions, global choices, table shells, scalar columns, relationships/lookups, alternate
keys, forms, public views. `MSCRM.SolutionUniqueName` and explicit membership keep export scope precise;
standard tables join without unrelated subcomponents, and primary-name attributes are added explicitly.

Apply is additive: no deletes, no overwrites, no general update migration. Metadata updates would need a
PUT with every property preserved and labels merged, which ordinary PATCH logic cannot do
([update semantics](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/create-update-entity-definitions-using-web-api#update-table-definitions)).
Forms and views come from project-owned XML; default views are not edited. The one completion step:
Dataverse can ignore lookup auditing in relationship deep insert, so apply verifies each new lookup and,
if needed, enables only its audit flag with a full typed PUT using `MSCRM.MergeLabels`. `audit-lookups`
repeats that after an interruption without touching targets, cascades or other columns.

**scope-solutions** (also run by apply): table creation can add an Include Subcomponents root even when
later components belong to another solution, and re-adding a root does not narrow it. The repair
journals membership, removes only the unmanaged solution membership, re-adds the table with explicit
subcomponents and restores declared primary-name, column, relationship, key, form and view memberships,
keeping other memberships. Records and metadata stay. Rerun after an interruption; reconcile forms and
views kept outside the manifest yourself
([root behaviours](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/solutioncomponent#rootcomponentbehavior)).

Scoped exports are update packages for existing tables. A fresh environment needs the schema created
through this toolkit first; a first-time native table import requires Include All Objects
([segmented solutions](https://learn.microsoft.com/en-us/power-platform/alm/segmented-solutions-alm)).

**keys** exits 2 until every alternate key is Active. **publish** targets only declared tables and
choices. **export** writes an unmanaged ZIP from Dataverse and unpacks it with PAC; importing or
deploying code components is separate.

Live requests are confined to the configured HTTPS API origin; cross-origin or cross-path continuations
and redirects are rejected. Reads allow 30 seconds; schema mutations, publishing and exports 180 seconds.
A failed or uncertain mutation is never retried automatically. The ignored journal stores component
IDs, payload hashes and checkpoints, and a rerun starts with fresh reconciliation. A schema change is
many requests, not a transaction: partial completion is possible.

## Supported components

- **Tables**: label, plural label, organization or user ownership, explicit primary name, optional
  `notes: true` and `activities: true` (both default false). `existing: true` declares a standard table
  that must exist remotely; only declared custom extensions are created, and `existingColumns` lets keys
  use known standard fields.
- **Columns**: string, memo, integer, decimal, double, money, Boolean, DateTime with explicit behaviour
  (DateOnly uses DateOnly behaviour), global choice and multi-select choice; `maxLength`, numeric
  min/max/precision, required level, audit flag and optional defaults. `column.solution` assigns an
  extension to another solution; keys inherit table ownership unless overridden.
- **Choices**: explicit integer values and labels. Columns bind `GlobalOptionSet@odata.bind` with the
  server's MetadataId (name-key bindings fail with a GUID parsing error)
  ([choice API](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/create-update-optionsets)).
- **Relationships**: one-to-many with parent, child and lookup name/label/required level, created by deep
  insert, defaulting to Delete Restrict and NoCascade otherwise; many-to-many with intersect name and
  optional intersect attributes (distinct sides for self relationships). Platform-enforced cascades are
  real differences and must be reflected in the manifest.
- **Alternate keys**: explicit names and column lists; unsupported types, missing columns and obviously
  oversized indexes are rejected. Nullable values and uniqueness still need project tests.
- **Forms**: stable id, table, solution, name, type (default 2), `formXml` or `formXmlFile`. **Views**:
  stable id, table, solution, name, queryType (default 0), `fetchXml`/`layoutXml` or file references.
  Files resolve relative to the manifest; Dataverse validates the XML.

```js
import { readManifest, compileManifest, planManifest, connectedClient, loadConnection } from 'paqvilo/dataverse';

const manifest = await readManifest('./dataverse/manifest.json');
const payloadPlan = compileManifest(manifest); // offline
const client = connectedClient(await loadConnection('./.paqvilo/dataverse/connection.json'));
const observedPlan = await planManifest(manifest, { client }); // read only
```

Toolkit tests use invented schemas on loopback; they do not prove live creation or export of every
metadata type. Qualify that with an authorized disposable solution. The
[Company Operations project](../examples/company-operations/README.md) is a complete project-owned
example (manifest, seeded catalogues, forms and views, portal security and plug-ins).

## Reproducible data and retrievals

`data-plan`, `data-apply`, `data-compare` and `data-query` take `--catalogue FILE` and, when connected,
the same `--connection FILE`. Plan can run offline; connected plan only reads. Apply refuses
incompatible fixtures, creates missing rows, fills deferred links and adds missing associations; it never
deletes or repairs drift. Compare and query exit 2 when a check fails. `--out FILE` writes ignored reports
and exclusive apply journals.

A schemaVersion 1 catalogue declares datasetId, version and fixed clock; tables (logical, entity-set and
primary-key names, alternate-key columns); records with stable GUIDs, scalar `fields`, lookup `refs` to
other record aliases (or null) and `deferredRefs` for cycles; N:N `associations` (relationship, from, to);
and queries with FetchXML, selected columns and expected rows. `@ref:alias` resolves expected GUIDs,
`{{ref:alias}}` query GUIDs, `{{operationId}}` a fresh marker and `{{markerUtc}}` a fresh UTC timestamp
while the dataset clock stays fixed.

The loader verifies entity sets, primary keys and Active alternate keys, discovers lookup and association
navigation properties and detects business-key collisions before creating anything. Stable-GUID creation
uses PATCH with `If-None-Match: *`; deferred references use the row ETag. Multi-select values serialize as
comma-separated strings. Existing reference records can be matched and reused without overwriting.

Compare checks only declared values and associations (explicit null lookups and absent or extra links
included). Query checks compare complete canonical rows with multiplicity. FetchXML paging follows
more-records and paging-cookie annotations (cookies decoded twice, XML-escaped), requests another page
after a full page without a terminal annotation, and is bounded by a page limit and, without cookies,
50,000 rows; exceeding a bound fails the check.

Gotchas: alias linked attributes uniquely (for example `scopedaccountid`), because the Web API omits an
Account link's ID aliased as `accountid`. DateOnly expectations are calendar-date strings. An
administrator application's query proves fixture integrity only; persona expectations must run through
the portal, which applies the signed-in contact's web roles and table permissions. Form metadata uses
the `formid` key, and published FetchXML is compared structurally because Dataverse adds `savedqueryid`
and reformats it.
