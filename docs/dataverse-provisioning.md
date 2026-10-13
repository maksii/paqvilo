# Dataverse schema provisioning

`paqvilo dataverse` creates schema in Dataverse through its Web API and exports the server-generated solution. Its implementation and public API are reusable; a project's manifest owns table names, publisher, relationships, component ownership and XML templates. This is an explicit provisioning workflow, independent of Lense overlays and Mirage simulation.

Node 22+, PAC and an authenticated administrator are required for initial app registration. Metadata operations then use the application's own client credentials, without switching the active PAC profile. This release supports the public Microsoft cloud. Windows connections use DPAPI CurrentUser; other hosts can supply an environment-secret reference. Access tokens stay in memory. Do not commit connections, registration recovery files, real exports or provisioning journals.

## Application and connection

```sh
paqvilo dataverse register --name "Project Schema Provisioning" --role "System Customizer" --connection .paqvilo/dataverse/connection.json
paqvilo dataverse inspect --connection .paqvilo/dataverse/connection.json
paqvilo dataverse verify --connection .paqvilo/dataverse/connection.json
```

Registration uses `pac admin create-service-principal` and the explicitly selected active environment. PAC creates the Entra application/service principal and attempts Power Platform/Dataverse registration. Its default role is System Administrator; this wrapper defaults explicitly to System Customizer. Required tenant permissions are separate from Dataverse security roles. The command can fail after creating the Entra app, including errors reported with process exit code zero. [PAC registration contract](https://learn.microsoft.com/en-us/power-platform/developer/cli/reference/admin#pac-admin-create-service-principal).

The wrapper captures output privately, encrypts recovery evidence before parsing it, and never prints credentials. An existing connection or registration marker prevents a duplicate creation attempt. If registration is partial, inspect the `.registration.json` state, complete the existing application's user/role assignment, and obtain a credential for **that same application**. The toolkit does not automatically create another app or escalate roles.

```sh
paqvilo dataverse connect --registration .paqvilo/dataverse/connection.json.registration.json --secret-file .paqvilo/dataverse/credential.txt --connection .paqvilo/dataverse/connection.json --role "System Customizer" --consume-secret-file
```

The secret file can contain the value alone; a JSON object with `clientId`, `tenantId`, `value`, `secretId`, optional `expiration`; labelled lines; or a two-line CSV with those headers. Client/tenant identity fields are validated. A provided application ID must match registration. Connect authenticates, verifies the expected organisation, records application-user roles, saves the DPAPI-protected secret, and optionally removes the temporary plaintext file after successful persistence. Secret ID is metadata, not the credential used to authenticate. Credential expiry stays unknown unless supplied; token expiry is a different value.

Connection records and secret files must be inside ignored `.paqvilo/`. DPAPI ciphertext works only for its originating Windows user/machine. For a non-Windows runner, author a private connection with `schemaVersion:1`, environmentUrl, tenantId, clientId, optional organisationId, `credentialSource:"environment"` and `secretEnvironmentVariable:"PROJECT_DATAVERSE_SECRET"`. Inject that variable through the runner's secret store. Never put a literal secret in committed JSON or command arguments.

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
  "solutions": [
    { "uniqueName": "ExampleSchema", "friendlyName": "Example Schema", "version": "1.0.0.0" }
  ],
  "tables": [
    {
      "name": "exmp_item",
      "entitySetName": "exmp_items",
      "label": "Item",
      "pluralLabel": "Items",
      "ownership": "organization",
      "solution": "ExampleSchema",
      "primaryName": { "name": "exmp_name", "label": "Name", "maxLength": 160 },
      "columns": [
        { "name": "exmp_code", "label": "Code", "type": "string", "maxLength": 40, "required": "required" }
      ],
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

Without a connection, plan performs no network requests. With one, it reads existing metadata and reports create/exists/drift; it never writes. `--out` saves complete API payloads and prints a short summary; `--json` also prints the full plan. Apply verifies the organisation, preflights every component, rechecks each identity before creation and repairs solution membership. A compatible rerun performs no writes when membership is already complete. Incompatible metadata blocks creation before the first write. Existing solution publisher identity is checked separately from its display name.

The ordered components are publisher, solutions, global choices, table shells, scalar columns, relationships/lookups, alternate keys, forms and public views. `MSCRM.SolutionUniqueName` and explicit component membership keep ownership/export scope precise; standard tables are included without their unrelated subcomponents. Primary-name attributes are explicitly included in custom-table solutions. [Table creation and solution association](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/create-update-entity-definitions-using-web-api), [component membership](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/addsolutioncomponent?view=dataverse-latest).

Table creation can add an Include Subcomponents root even when later components belong to another solution. Before export, `apply` scopes declared table roots and restores explicit metadata membership. `scope-solutions --manifest FILE --connection FILE --out PRIVATE_JOURNAL` performs the same repair independently. On the qualified environment, re-adding an existing root did not narrow it: the repair journals membership, removes only the unmanaged solution membership, re-adds the table with explicit subcomponents, preserves existing non-table memberships and restores declared primary-name/column/relationship/key/form/view memberships. Dataverse records and metadata remain present. Reconcile project-specific forms/views afterward when they live outside the schema manifest; then inspect exported dependency direction. Rerunning restores declared memberships after interruption. [Root-component behaviours](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/solutioncomponent#rootcomponentbehavior), [remove membership](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/removesolutioncomponent?view=dataverse-latest).

Scoped exports are update packages for existing tables. Create the manifest's schema through this API toolkit before importing them into a fresh environment. Microsoft requires Include All Objects for a first-time native table import; a standalone initial ZIP therefore needs separate full-table packaging and dependency qualification. [Initial table imports and segmentation](https://learn.microsoft.com/en-us/power-platform/alm/segmented-solutions-alm).

Apply is additive. It does not delete columns/tables or overwrite existing definitions. Metadata updates require PUT with complete preserved properties and deliberate label merging; ordinary PATCH logic is unsuitable. Destructive reconciliation and general update migration are outside this release. Forms/views are created from project-owned XML; the toolkit does not invent production form layouts or edit server-generated default views automatically. [Metadata update semantics](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/create-update-entity-definitions-using-web-api#update-table-definitions).

One narrow creation-completion step is supported: Dataverse can ignore lookup auditing in relationship deep insert. Apply verifies the newly created lookup and, when necessary, enables only its audit flag through a full typed PUT preserving labels/properties with `MSCRM.MergeLabels`. `audit-lookups --manifest FILE --connection FILE` completes this setting after an interrupted creation. It does not change lookup targets, cascade settings or general column definitions. Boolean metadata reads expand OptionSet, and alternate-key comparison treats component ordering as unordered. Platform-enforced cascade settings remain actual differences and must be explicitly reflected in the project manifest.

## Supported components and constraints

- Columns: string, memo, integer, decimal, double, money, Boolean, DateTime with explicit behaviour, global choice and multi-select choice. Use `maxLength`, numeric min/max/precision, required level, audit flag and optional defaults. DateOnly uses DateOnly behaviour. Each new table has an explicit primary-name definition and organisation or user/team ownership.
- `existing:true` declares a standard/external table; it must exist remotely. `existingColumns` permits known standard fields in keys. Only declared custom extensions are created. `column.solution` can assign a later extension to a different solution; keys inherit table ownership unless overridden.
- Choices provide explicit integer values and labels. Columns bind `GlobalOptionSet@odata.bind`; they do not recreate an existing global choice as a local one. Offline plans reference names; apply resolves them to the server's MetadataId for the binding URI. This avoids the GUID parsing failure observed with Name-key write bindings on the connected environment. [Choice API](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/create-update-optionsets).
- One-to-many relationships contain parent, child and lookup name/label/required level. Lookup creation uses relationship deep insert. Defaults are Delete Restrict and other cascades NoCascade. Many-to-many definitions specify intersect name and optional two intersect attributes; self relationships require distinct intersect sides. [Relationship creation](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/create-update-entity-relationships-using-web-api).
- Alternate keys have explicit names and column lists. Validation rejects unsupported declared types, missing columns and obvious oversized index definitions. Dataverse's asynchronous key creation is checked separately; `keys` exits 2 until every key is Active. Nullable key values, backend-required validation and uniqueness failures still need project tests. [Key constraints](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/define-alternate-keys-entity).
- Forms: stable id, table, solution, name, type (default 2), formXml or formXmlFile. Views: stable id, table, solution, name, queryType (default 0), fetchXml/layoutXml or file references. Files resolve relative to the manifest. Dataverse validates the supplied XML; project tests must qualify layout/query compatibility.

Live requests are confined to the configured HTTPS API origin. Cross-origin/path continuations and redirects are rejected. Reads allow 30 seconds; schema mutations, publishing and exports allow 180 seconds because table creation can exceed the read deadline. A failed/uncertain mutation is not automatically retried. The ignored journal stores component IDs, payload hashes and checkpoints; rerunning starts with fresh reconciliation. Partial completion is possible across many metadata requests; this is not an atomic schema transaction. Publish targets only declared tables/choices. Export writes an unmanaged ZIP from Dataverse, then PAC unpacks it; import/deployment of code components is separate.

## Public npm API and current project

```js
import { readManifest, compileManifest, planManifest, connectedClient, loadConnection } from 'paqvilo/dataverse';

const manifest = await readManifest('./dataverse/manifest.json');
const payloadPlan = compileManifest(manifest); // offline
const client = connectedClient(await loadConnection('./.paqvilo/dataverse/connection.json'));
const observedPlan = await planManifest(manifest, { client }); // read only
```

The [Company Operations project](../examples/company-operations/README.md) owns conversion from the three implementation specifications. Its manifest includes 27 tables (24 new), 26 choices, 71 relationships and 27 keys. The project also owns seeded catalogues, named forms/views, portal security/templates/assets, plugin assemblies/steps/images and qualification tools. External collector/flow deployment and structural projection reconciliation remain separate dependencies. Business-specific conversion and tests stay in that project.

Core tests use invented schemas and loopback fixtures only. They cover payload order, idempotency, origin confinement, drift, no blind write retry, identity checks and credential-output redaction. These tests and a live read-only plan do not prove live creation/export for every supported metadata type; qualify that next with an authorized disposable solution. Runtime changes require `npm run validate`.

## Reproducible data and retrievals

`data-plan`, `data-apply`, `data-compare` and `data-query` accept `--catalogue FILE`; connected operations use the same `--connection FILE` as schema provisioning. Plan can run offline. Connected plan reads without writing; apply refuses incompatible fixtures, fills missing rows/deferred links and adds missing associations. Compare/query return exit code 2 when checks fail. Use `--out FILE` for ignored reports and exclusive apply journals. The npm API exports `readCatalogue`, `validateCatalogue`, `planData`, `applyData`, `compareData`, `runDataQueries` and `retrieveFetchXml` from `paqvilo/dataverse`.

A schemaVersion 1 catalogue declares datasetId/version/fixed clock, tables with logical/entity-set/primary-key names and alternate-key columns, records with stable GUIDs and scalar `fields`, lookup `refs` keyed by other record aliases (or null), `deferredRefs` for cycles, N:N `associations` with relationship/from/to aliases, and queries with FetchXML/selected columns/expected rows. `@ref:alias` resolves expected GUIDs; `{{ref:alias}}` resolves query GUIDs and `{{operationId}}` receives a fresh marker. Projects own persona/scenario oracles and domain integrity tests. The generic toolkit contains no business schema.

The loader verifies entity sets/primary keys and Active alternate keys, discovers actual lookup and association navigation properties, and detects business-key collisions before creating anything. Stable-GUID creation uses PATCH with `If-None-Match: *`; completion of deferred references uses the row ETag. Multiple-choice arrays serialize to the Web API comma-separated value. Existing reference records can be matched explicitly and reused without overwriting them. Missing reference rows use the declared stable-GUID fallback. There is no automatic destructive reset or drift repair. [Conditional upsert](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/update-delete-entities-using-web-api), [association navigation](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/associate-disassociate-entities-using-web-api).

Comparison covers only declared values and associations, including explicit null lookups and absent/extra links. Query checks compare complete canonical rows with multiplicity; they retain counts, page XML, operation IDs, query errors and missing/unexpected rows in local reports. FetchXML paging requests more-records/cookie annotations, decodes server cookies twice, XML-escapes them and increments the page. A full page without a terminal annotation is followed by another request; the following empty/short page proves completion. Cookie-free fallback is bounded to 50,000 rows and all paging has a page limit. Exceeding either bound fails the check. [FetchXML paging](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/fetchxml/page-results?tabs=webapi).

`{{markerUtc}}` gets a fresh UTC timestamp per query while the dataset clock stays fixed. Use unique linked-attribute aliases such as `scopedaccountid`: the connected Web API omitted an Account link's ID when aliased as `accountid`. DateOnly expectations use calendar-date strings, not midnight date/time strings. These transport details are preserved in the example's authored queries and regression tests.

An administrator application's successful query proves fixture integrity. Power Pages applies the signed-in Contact's website role/table-permission configuration, so persona expectations execute through that portal. The [merged example catalogue](../examples/company-operations/data/stress-catalogue.json) separates backend checks from 29 permission scenarios and their prerequisites. It has 842 fixture/reference records, 434 association links and 25 personas, including separate CRUD canaries and incomplete trigger fixtures. Observations are created by execution.

Form metadata uses the platform's `formid` primary key. Published FetchXML is compared structurally because Dataverse adds `savedqueryid` and reformats XML; normalization preserves filters, values, joins, selected columns and ordering. The example's form toolkit discovers object-type codes, modifies the existing custom Lookup/Quick Find views and preserves standard Account/Contact views. Quick Find record updates fail on this connected environment; the example edits only the affected view nodes in a native exported solution, imports asynchronously, publishes each solution before exporting the next dependency, and verifies full readback. Import journals retain job IDs for reconciliation after interruption. See [view customization](https://learn.microsoft.com/en-us/power-apps/developer/model-driven-apps/customize-entity-views) and [asynchronous solution import](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/importsolutionasync).
