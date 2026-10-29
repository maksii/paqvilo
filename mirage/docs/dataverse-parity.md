# Dataverse simulation

Mirage supports FetchXML, portal Web API and list OData contracts over local state. Queries use imported mappings, relationship metadata, column types and permission scopes. Results support platform-shaped choice/lookup values, paging, counts, expansion and error envelopes. Unsupported constructs and unresolved mappings fail with diagnostics rather than silently querying unrelated tables.

The read-only SQL evaluator's `LIKE` uses the configured `CI_AI` or `CI_AS`
text folding for literal characters and character sets. `ESCAPE` requires one
character; a pattern ending in an unmatched escape never matches, and null
operands retain SQL unknown semantics. These cases follow the documented
[SQL pattern contract](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/like-transact-sql)
and [Dataverse accent sensitivity](https://learn.microsoft.com/en-us/power-platform/admin/language-collations).
This bounded folding model does not establish full linguistic collation parity.

Local identities come from request sessions. Exported table permissions, web roles and parent/contact/account/self relationships control queries and writes when enforcement is enabled. Page access and table access are separate concerns. Metadata/scaffold discovery does not grant a persona permission to business rows.

The local store simulates create/update/delete, validation, bindings, declared backend rules and atomic state-file writes. [Dataverse plugin registrations](dataverse-plugins.md) are imported from selected Solutions; supported write/read stages can execute an explicitly trusted original CLR assembly, project model or mock, or be disabled. Unconfigured steps report skipped business logic. Top-level PreValidation SDK writes and asynchronous SDK requests commit independently; nested PreValidation and stages 20/40 join their caller transaction. [Operations](operations.md) inventories exports and runs supported basic imported request or Dataverse row-trigger flows with separate backend profiles. Completed connector writes survive a later failed action. Unsupported connectors/settings require explicit local choices. New states contain no business records from references.

Every organization write runs one pipeline: Web API and SOAP writes through the records layer (TDS is read-only), and SDK calls from CLR plug-ins, flow Dataverse actions, portal `/_api` writes, portal form writes, activity messages and note, attachment and SharePoint rows through its internal entries. They share the state defaults, record hooks, audit and version columns and alternate-key errors (`0x80048d19` for a calculated-column value, `0x80060892` for a duplicate alternate key). `Merge` (the target update, the subordinate deactivation and the moved children) and the `CalculateRollupField` store write (which keeps `modifiedon`) run the same pipeline. An `@odata.bind` names a navigation property, case-sensitively: a name no relationship declares (a column name, another casing) answers 400 `0x80048d19` "An undeclared property … which only has property annotations in the payload …" on every surface and stores nothing; the system lookups every table carries (`ownerid`, `owninguser`, `owningteam`, `owningbusinessunit`, `createdby`, `modifiedby`, `createdonbehalfby`, `modifiedonbehalfby`, `transactioncurrencyid`) bind on their column name. The portal `/_api` answers it in its generic 400 `9004010A` envelope.

These internal writers write system-owned rows directly to the store, deliberately, because no user-facing rule (business rules, column security, plug-in steps on user tables) applies to them: `dataverse-duplicates.mjs` (publishing and unpublishing `duplicaterule` and `duplicaterulecondition`), `dataverse-addon-d365.mjs` (`asyncoperation` cancel), `dataverse-predefined.mjs` (`appnotification` rows of `SendAppNotification`). The user-table writes of `dataverse-addon-d365.mjs` (goal rollup, the bulk e-mail draft addressing), `dataverse-bpf.mjs` (the business process flow instance a flow starts) and `dataverse-org-messages.mjs` (the `socialprofile` row `GenerateSocialProfile` creates) run the pipeline's internal entries like every other write. The portal keeps its own table permissions and value rules and wraps an organization error in its CDS envelope (`9004010D`) with the organization's code and message as `innererror`.

`MODERN_LIST_RENDERED_CLASSIC` is a preflight requirement (`portal:modern-list` at `contract`), so `--strict` blocks on a site whose modern list include names a map, calendar or code component list. `ENHANCED_AUTHORIZATION` reports a site in the enhanced authorization model; its requirement `portal:enhanced-authorization` is `satisfied` at `behaviour` (see [enhanced authorization](#enhanced-authorization)). See [capabilities and preflight](capabilities-and-preflight.md#report-shape).

An exported unsupported server-logic endpoint answers HTTP 501 with the camelCase fields `requestId`, `success`, `serverLogicName`, `data` and `error`. This is an explicit unsupported result, not a successful execution.

Use `webapi-inventory`, `bootstrap-report` and `portal-matrix` to find source calls, unresolved table identities and schema gaps. Use a project-owned parity plan for read-only comparisons against an authorized reference browser. Local correctness and live parity are reported separately.

## Access-team membership

`AddUserToRecordTeam` reuses the system-managed access team for a record/template
while it has members. Removing its final member deletes the team and its record
share in the same local transaction; adding a member afterward creates a fresh
team identity from the runtime's ID source. Other members, independent user
shares and manually managed teams keep their existing access. This follows the
lifecycle in Microsoft's [Access Teams whitepaper](https://www.microsoft.com/en-us/download/details.aspx?id=41190).

`RemoveUserFromRecordTeam` returns 204 with no body; it does not return the
`AccessTeamId` declared by Microsoft's [action contract](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/removeuserfromrecordteam?view=dataverse-latest).

## Choosing a read-only reference

An organization Dataverse CLI can supplement explicitly authorized, bounded organization API comparisons. Qualify the selected CLI version, effective identity, exact request and response shape against an independent signed-in browser capture before using its output as evidence. A scriptable JSON option alone does not establish raw OData, HTTP status, headers, annotations or continuation fidelity. Keep the original captures separately; record unavailable fields as limitations rather than normalizing them away.

Organization-user results do not establish Power Pages portal-session authorization, query rewriting or portal error behavior. The [portal Web API](https://learn.microsoft.com/en-us/power-pages/configure/web-api-overview) applies its own enabled table/field settings, permissions and session rules. Keep separate portal-persona captures for those claims, including when a CLI and browser read the same records.

Microsoft's preview [Dataverse CLI](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/cli/) is not a Paqvilo dependency or an automatically selected reference. Review its current authentication, tenant consent and environment prerequisites with the owner before adoption; this guide does not authorize changing them. A project experiment should select reviewed record IDs and bounded read-only cases, verify the intended organization and user, compare several fresh captures with the same Mirage query, and preserve failures and output-shape differences. Keep identities, identifiers, query values, credentials and evidence in the project; never put them in toolkit fixtures or public reports.

## Permission queries and recording

Portal FetchXML reads compile effective root-table grants into outer relationship joins and an OR permission filter before RetrieveMultiple observers execute. The compiler retains separate relationship paths, shares equivalent paths, traverses imported N:N intersections, and applies the configured Dataverse link-entity budget to the expanded query. The returned `xml` is the query used for local execution. `permissionQuery` reports authored/generated join counts, diagnostics and `qualification: "modeled"`: the XML comes from the local compiler and need not equal the hosted Power Pages rewrite byte for byte. Microsoft's [Liquid FetchXML documentation](https://learn.microsoft.com/en-us/power-pages/configure/liquid/template-tags#xml-attribute) describes the resultant query exposed by Liquid.

Independent backend retrieval and FetchXmlToQueryExpression controls distinguish two budgets: 15 ordinary joins and 27 ordinary joins plus existential filter links. A filter's `any`, `not any`, `all` or `not all` root does not consume an ordinary join; its ordinary descendants do. Every node remains in the query and combined count. Thus some 17-node trees succeed while a sixteenth ordinary join or twenty-eighth combined node fails with CDS `0x8004430d`. `QueryLinkEntityLimit` and the simulator experiment `FetchLinkAndFilterLimit` configure those separate limits. The evidenced `fetchLinkBudgetError: "reported-counts"` observation selects the backend's count-specific error text; omission retains the documented generic message.

The portal Web API validates enabled fields, column permissions and authored linked-table access before executing FetchXML. Generated permission links inspect relationship rows without exposing their columns. Default execution retains authored-table row checks.

An evidence-backed `observed.tablePermissionQueryPipeline: "native-classic"` selects the captured lane admission contract. Liquid executes its compiled root query against backend relationship rows, including authored joins; a denied root returns an empty result and normalized authored XML without a Dataverse invocation. Web API reads check authored table grants and expanded query budgets before invoking plugins. Liquid encounters execution budgets after PreOperation, so its failed read can still have recorded incoming queries. This observation reproduces the selected site's classic authorization behavior, including joined columns that its Liquid query exposes. Omitted or `"row-filtered"` keeps the default row checks. The setting requires `observed.evidence`.

The separate evidence-backed `observed.webApiUpdatePermissionQuery: "native-classic"` models Update admission when a portal constructs its complete source-derived Update permission query before checking the addressed row. An expanded query above the configured Dataverse join budget returns the generic `500 9004010A` admission error before any record hook or write, including for a foreign row that would otherwise return `403 90040102`. An admitted query still uses the ordinary row permissions. The compiler counts the actual Update grant paths; it does not select outcomes by table name. Before selecting it, confirm on the site that the 500 comes from permission admission and not from a business plug-in. The flag requires `observed.evidence`, is independent of the FetchXML read profile, and does not change SDK writes, Create or Delete.

An independently observed `webApiMutationPermissionText: "table"` selects the captured Update/Delete denial text with the Unicode apostrophe and table terminology. This changes message text only, requires the same named site evidence, and leaves error codes and permission decisions unchanged.

In that observed Web API profile, authored linked tables receive their own existential permission paths: the first relationship uses `link-type="any"`, later relationships use inner joins, and the terminal principal condition is applied inside the linked table's filter. Paths are compiled from the selected source grants. Only metadata-verified structural N:N intersections bypass independent table admission; an authored `intersect="true"` flag alone grants no access. Microsoft's [FetchXML filter documentation](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/fetchxml/filter-rows) defines the existential operator.

The same observed profile compiles scoped Liquid and Web API FetchXML with `distinct="true"`, including when the author supplied `false`. This removes repeated projected tuples from overlapping permission paths; selected linked columns remain part of the tuple. Aggregate input rows still include permission-join multiplicity: a root collection and `count` need not have the same cardinality. Permission paths and their link-budget cost remain intact. A Global root grant retains authored DISTINCT, with omission meaning false for Web API queries. SDK/backend reads retain their separate authored query contract.

The default row-filtered profile also supplies scoped DISTINCT when omitted, preventing permission-path duplicates and repeated identifiers across Web API pages. It retains explicit `false` and reports `PERMISSION_QUERY_DISTINCT_FALSE_UNQUALIFIED`. Global Web API omission still means false. Selecting native-classic changes additional authorization and admission behavior and requires site evidence; it is not necessary merely to restore the scoped omission default.

`observed.webApiFetchXmlLinkTypes: "portal-classic"` models an independently observed Web API conversion of authored `exists`, `in` and `matchfirstrowusingcrossapply` links into ordinary inner-join results. It also reproduces the observed CDS `0x8004111c` rejection for `not any`, `all` and `not all` links inside filters. It requires `observed.evidence`; without it, the documented Dataverse link semantics apply. The conversion runs before permission expansion and never rewrites compiler-generated permission subqueries, Liquid or SDK queries. Confirm it on the site with queries whose duplicate rows show the difference.

`observed.liquidFetchXmlLinkTypes: "portal-classic"` applies the same implicit-inner fallback to those three authored Liquid link types, retaining their projections and link-budget cost. The writer also omits `link-type` for authored filter links using `not any`, `all` or `not all`. These nodes remain visible in the rewritten XML; their invalid implicit-inner filter form fails during backend execution, after PreOperation. This differs from the Web API's earlier rejection. Deferred XML preview uses the same authoring conversion, DISTINCT rule and alias allocation as execution. Both settings leave compiler-owned permission subqueries and SDK/backend reads unchanged.

`observed.webApiFetchXmlTransport` describes an observed backend GET transport as `{encoding: "double-rfc3986", maxHeaderXmlBytes, maxUrlXmlBytes, maxConstructedXmlBytes}`. The ordered positive integer limits are effective double-escaped XML byte budgets after the deployment's fixed backend URI/header overhead. Measure each limit on the site just below and just above the boundary. Construction failure returns the native generic 500; URL overflow returns CDS 414; header overflow returns CDS 400 with its HTTP.sys inner message. They precede backend query admission and observers. This check evaluates the complete permission-expanded XML and never removes links. It applies to the qualified portal Web API FetchXML transport; Liquid and SDK reads retain their independent execution contracts. No token/header values or per-table outcome fixtures are configuration inputs.

Backend subquery joins validate unsupported projections/orders with `0x80041121`. Cross-apply selects a qualifying candidate after evaluating its unprojected descendants. `observed.fetchAllWithoutFilter: "sql-error"` separately reproduces a witnessed backend `0x80044150` execution failure for an `all` link with no own filter. This defect profile requires evidence and does not affect filtered quantifiers or silently replace their documented semantics.

`observed.fetchPreOperationSerialization` can map exact logical tables to `"compact"` when captures show a platform serialization change between PreValidation and PreOperation. Stage 10 retains the initial expanded bytes; later stages receive compact XML. In the native Liquid profile, `xml` retains the exposed Liquid query and `executedXml` identifies the backend query. Neither field substitutes for a plugin capture. The mapping requires evidence and does not infer behavior for other tables.

`observed.liquidFetchExecution: "lazy-query-drop"` models deferred FetchXML results. The tag creates a source permission preview; reading `xml` alone does not execute RetrieveMultiple. The first `results` access executes once and caches its result or failure. A failed result can therefore remain observable on repeated access while the initial expanded XML stays readable. `liquidFetchErrorMessage: "target-invocation"` selects the captured invocation-wrapper message; simulator infrastructure failures still propagate. Both choices require evidence of the site's execution timing and failure display, and are opt-in. The default eager provider contract remains available.

`observed.liquidFetchRights: "native-classic"` enables the independently captured
Liquid `right` contract. Read/default and an invalid right use Read grants; Write
uses Update grants, and Delete/Append/AppendTo use their respective grants. Valid
names are case-insensitive; `append_to` is an invalid spelling and uses Read.
Create checks a selected Create grant and
executes the normalized authored query without scoped permission joins or an added
DISTINCT default. A denied right produces an empty collection without a backend
invocation. Preview flags and execution use the same selected operation. This can
expose a broader authored read under Create than under Read, so it requires evidence
for the selected site. Web API and SDK reads remain bound to their own operations.
Omitting the setting or selecting `read-only` keeps the default Read-only
Liquid provider behavior.

`observed.tablePermissionGrantOrder` records an otherwise unexported ordering of permission alternatives as `{ normalizedGraphHash, tables: { logicalTable: [[permissionGuid], ...] } }`. The SHA256 binds the complete normalized permission graph, including names, activation, roles, operations and relationships. Each group contains source grants with the same qualified ordering position. Both root grants and permission alternatives inside authored linked tables follow their table's groups; their full paths and principal predicates still come from source permissions. A changed graph or a selected grant missing from the mapping fails rather than silently using stale ordering. The configuration requires evidence. An order captured with all roles is not guaranteed to hold for every subset of roles.

Liquid query serialization supplies `mapping="logical"` and a default of `distinct="true"`, including aggregate queries, placing order elements before filters and permission filters before links. Generated XML uses CRLF and two-space indentation. The native classic profile reserves explicitly aliased authored occurrences of each table when allocating generated permission aliases, including an authored link with a different alias. An unaliased authored link does not advance that permission-alias counter. A distinct query requires an explicit primary-key attribute when its caller needs the identity. Unqualified compiler callers retain explicit DISTINCT. For distinct nonaggregate queries, compiler-owned principal paths can be pruned during local evaluation to avoid Cartesian intermediate rows; the recorded XML and Dataverse join budget stay unchanged. Observer changes to principal predicates or additional conditions on generated ancestors disable that optimization. Structural link changes require a separate mutation adapter and fail explicitly.

An inactive exported parent normally disables its child chain. A site's `observed.tablePermissionOrphans: "unrestricted"`, with `observed.evidence`, can replay the captured inactive-parent case: a surviving child with explicit roles and a resolved many-to-one parent lookup uses that lookup's non-null condition. This choice emits a diagnostic and leaves missing parents, unresolved relationships, reverse/N:N parent traversals, cycles and children without explicit roles closed. It reproduces a platform defect seen on one site; do not use it as a permission design. Omitted or `"closed"` retains the default.

Supported scalar portal OData reads can pass through a local query-to-FetchXML adapter for observation. The separate evidence-backed `observed.odataPermissionQueryPipeline: "native-classic"` constructs the bounded captured compact FetchExpression contract from the authored scalar OData AST and source permissions. It preserves the observed authored boolean writer order, independently ordered permission alternatives, uppercase braced identity GUIDs and scoped any/inner joins. Its ordering uses `odataPermissionGrantOrder`, separate from the Liquid ordering. The captured same-table Parent anchor requires `odataSameTableParentAnchor: "shared-root"`. These values require evidence. Compiler-owned `anyallalias` annotations carry exact filter-position sidecars; they do not relax authored FetchXML grammar. Initial default Web API pages execute this query through the actual RetrieveMultiple pipeline; unsupported conversion contracts fail explicitly.

Cross-table lookup Parent paths preserve the captured nullable guards: two lookups produce three links, including a `not any` null guard and the terminal nested `any` traversal. Source-derived navigation binding failures precede RetrieveMultiple admission: an N:N lambda beneath a lookup produces CDS `0x80040216` (400), while excessive generated scalar lookup depth produces `0x8006088a` (501). Binding visits OR alternatives in their independently qualified writer order, checking scalar null guards before the collection lambda within each path. Reversing alternatives can change the first error from 400 to 501. No links are removed to meet the query budget. The profile does not model further navigation, continuation, permission deduplication that depends on authored links, Custom Access filters, enhanced authorization or other graph combinations. [Permission access types](https://learn.microsoft.com/en-us/power-pages/security/table-permissions) and [Web API capabilities](https://learn.microsoft.com/en-us/power-pages/configure/web-api-overview) depend on the deployed platform version as well as the exported graph.

## Enhanced authorization

A site record whose `enhancedauthorization` is 1 (Migration in progress), 2 (Migration Failed) or 3 (Enabled) runs the enhanced authorization model locally ([unify Power Pages security with Dataverse](https://learn.microsoft.com/en-us/power-pages/security/unify-pages-security-with-dataverse)); 0 or no value runs the standard model. Each start records `PORTAL_AUTHORIZATION_MODEL` (info) naming the state and the model, and a denied request's `TABLE_PERMISSION_DENIED` diagnostic names the model.

In the enhanced model every web role maps to a Dataverse security role whose privileges are derived from the role's table permissions (one privilege per operation and table), and every visitor runs as a mapped Dataverse user: one per contact and site, one per site for anonymous visitors, with `systemmanagedusertype` 1 and the security roles of the visitor's web roles. A table permission grants only while the mapped user holds that privilege through the security role of one of the permission's web roles, so removing the privilege from the role in Dataverse revokes the grant; the records a grant reaches are those its scope selects. Dataverse column security profiles assigned to the mapped user (or to the site's anonymous user) apply to every read (Liquid, lists, forms, search, the portal Web API) and to every portal write, and the Web API column permissions are not evaluated. Every portal write (the Web API, forms, list and subgrid actions, notes and server logic's Dataverse connector) runs as the mapped user called by the site's application user, so `createdby`/`modifiedby` name the mapped user. Server logic's `InvokeCustomApi` runs as the mapped user. A table permission without a web role grants nothing in the enhanced model; a wildcard (`*`) table permission expands to every mapped table when the roles are derived.

The mapped security roles are platform-managed: they mirror the current web roles (the role of a removed web role is deleted), and a table-permission change rewrites a role from the permissions. A change made to a mapped role in Dataverse holds until that rewrite; a rewrite that replaces such a change records `PORTAL_AUTHORIZATION_ROLE_RESYNCED` once. When mapping a visitor fails (`PORTAL_AUTHORIZATION_SYNC_FAILED`), that visitor is denied everything until a mapping succeeds. Any other `enhancedauthorization` value runs the standard model, with the label "Unknown (n)" and the warning `PORTAL_AUTHORIZATION_STATE_UNKNOWN`.

Table permission scopes map to privilege depths as follows: Global to Global, Account to Local, Contact and Self to Basic, and Parent to the parent's depth. A site whose migration is in progress or has failed runs the enhanced model. Microsoft does not document either choice, so treat them as local defaults.

## Column security on portal reads

Every portal read answers secured columns the same way: forms and advanced form steps, lists and subgrids, portal search, Liquid `fetchxml` and `entities`, and the portal Web API, including `$expand` and `fetchXml` reads. Portal reads mask secured columns with the same column security and masking rules as a Dataverse Web API read by the reading principal: in the standard authorization model the site's application user, in the enhanced model the visitor's mapped Dataverse user. A secured column that principal cannot read is empty (FetchXML results omit it), and a readable secured column with a masking rule shows its masked value, because a portal read never asks for unmasked data; a column security profile's Read unmasked setting does not change a portal read. Reads made outside a portal request, such as the Dataverse Web API or server-side store reads, are unchanged. Column security resolves a table's masking rule, profile grants and metadata by the table's logical name even when the stored mapping does not carry `logicalName` (project-declared tables), so masking rules apply on every read that goes through it.

A portal read that filters, orders, groups, aggregates or asks distinct rows over a secured column the reading principal reads masked is refused with the Dataverse error `0x80041155` (filtering on masked attributes), as a Dataverse Web API read without unmasked data is. This applies to the portal Web API (`$filter`, `$orderby`, `$apply`, `$expand` options and `fetchXml`), Liquid `fetchxml`, lists and search. The portal Web API answers it as 400 `9004010D` with the Dataverse code in `innererror` when `Webapi/error/innererror` is on. A column security profile's Read unmasked setting does not lift the refusal, because a portal read never asks for unmasked data. A secured column the principal cannot read is evaluated as empty and is not refused. Notes and attachment listings read their annotation rows through the same masking. The SharePoint document listing returns only file and folder names, sizes, types and dates.

Imported many-to-many associations check the source Update/Append grant and the target AppendTo grant. Their metadata-declared intersect rows do not require a separate Create/Delete grant for an association operation. Direct intersect-table writes and manually configured edge mappings retain their own CRUD checks. Export bootstrap preserves explicit Append and AppendTo flags, including false values.

`observed.webApiSelfNnPermissionErrors: { x_relationship: "native-classic" }` qualifies the captured portal denial envelope for specific imported self-referencing N:N relationships. A missing endpoint Append or AppendTo grant returns the witnessed `90040106`/AppendTo message for those schemas. The profile requires site evidence; SDK errors, other relationships and unqualified sites retain their independent error contracts.

## Formula columns

Formula columns (SourceType 3) are computed on every read by Mirage's own Power Fx engine (`lib/power-fx.mjs`), so `$filter`, `$orderby`, `$apply` and FetchXML see the computed value. The formula reads the row's columns by name or through `ThisRecord`, follows lookups to the related row (`x_parentid.x_rate`), and reads other formula columns of the row, at most 10 deep. A decimal result keeps the column's precision (default 2). A formula that answers an error value (for example a division by zero) reads null and reports `FORMULA_ERROR` with its error kind once per column. Decimal, currency and whole-number arithmetic is exact; float values are doubles. As natively, the platform computes formula columns, so a formula over a secured column shows its result to callers who cannot read that column, and a `$filter` on the formula column filters by that result (formula columns cannot be secured). Mirage reports `FORMULA_COLUMN_OVER_SECURED_COLUMN` (warning, naming the formula column and the secured columns it reads) when the organization starts, so administrators can secure what they need. A trusted pack's `formulaColumns` function or `powerFx` adapter still takes precedence. Writing a formula column answers 400. See [Dataverse contract modules](dataverse-contract-modules.md#formula-columns).

Source imports read an inline `FormulaDefinition` or the column's referenced `FormulaDefinitionFileName` YAML document. References resolve within the owning entity's `Formulas` directory or the packaged solution's root `Formulas` directory. Unsupported paths, malformed documents and missing formulas remain diagnostic; YAML changes invalidate the source cache and update the running formula.

## Portal Web API file and image columns

The portal `/_api` serves file and image columns: `PUT` or `PATCH /_api/<set>(<id>)/<column>` with the bytes as the body and the file name in `x-ms-file-name` (header, or the query parameter for names outside ASCII) uploads, `GET /_api/<set>(<id>)/<column>/$value` answers the bytes as `application/octet-stream` with `Content-Disposition: attachment` (the file name, RFC 5987), `X-Content-Type-Options: nosniff`, and the stored type, name and size in the `mimetype`, `x-ms-file-name` and `x-ms-file-size` headers; a stored file is never served as its own type on the portal origin (`/api/data` keeps its documented headers) (image bytes default to the thumbnail; `size=full` requests a full image when its column stores one), and `DELETE /_api/<set>(<id>)/<column>` clears the column. The column must be listed in `Webapi/<table>/fields` (its column permission applies), and the visitor needs the table permission Read on the row to download and Write to upload or delete (403 otherwise, nothing stored). The bytes then go through the organization's file column entry, as on `/api/data`: the column's `MaxSizeInKB`, image checks, storage routing, 404 for an empty file column and 204 for an empty image. An upload without a file name keeps the stored file's name, else `<column>.bin`. A file name with `/`, `\`, NUL, or `.`/`..` alone answers 400 before anything is stored. One request carries the whole file (no `Range` or chunked transfer, a request is bounded at 128 MB).

Image values in entity, collection, FetchXML, navigation and expanded JSON responses resolve to stored base64 data, including write representations. Hydration preserves the portal reader's field-security mask; binary downloads cannot bypass a masked storage identifier. The raw route's default thumbnail contract follows [Power Pages image columns](https://learn.microsoft.com/en-us/power-pages/configure/image-column) and [Dataverse image data](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/image-column-data).

## Input and rendering contracts

Native date controls use exported date/time formats, column behavior and the browser timezone. Their hidden round-trip values contain seven fractional digits; `UserLocal` values carry UTC `Z`. Native hidden lookup values require both a record identity and its entity name. Malformed or incomplete references become empty values, including clearing a previously selected lookup on edit. Standalone code-component pages receive the platform WebForms wrapper, preserving the browser's handling of authored nested forms.

Configured native-form association with the current portal contact is a server-owned stamp. It does not require the visitor's source Append or Contact AppendTo grants. The internal exception is consumed by the root form create before plugins and deep inserts; it cannot authorize another lookup, a changed plugin target, an ordinary Web API binding, a missing target or a denied row Create. Other on-save lookup metadata retains ordinary relationship permission checks.

A terminal native multistep POST redirects to the same page with `msg=success` and its final `stepid`. The GET renders success only for the same owner's completed form and final committed step history; start-new sessions also require their exact session ID. A hidden completed form confirms its write without reading or exposing row fields, while a visible form retains ordinary Read checks. Reloading that success URL does not repeat the write. A query alone cannot manufacture success, and ordinary reload/resume access rules still apply when the success marker is absent. Transport-neutral JSON submissions retain their message outcome.

Column metadata controls numeric coercion, ranges, choice membership, string limits, email normalization and date validation. Integer, choice and floating-point columns accept supported numeric strings; decimal and money JSON values require numbers. User-local datetime values use ISO timestamps in API responses. Native forms retain invalid submitted text, report all server validation messages, and reject the entire write. Custom format and range validators do not silently turn invalid input into null.

Strings remain data through create, update, property reads, read-only forms and lists, including HTML, XML, JSON, quotes, Unicode, entities and line breaks. Search follows Dataverse literal and SQL LIKE rules: OData scalar strings use single quotes; percent, underscore and bracket expressions retain their pattern semantics. A literal opening bracket uses `[[]`; a closing bracket outside a class is literal.

Portal-specific error text, anti-forgery behavior and reference errors require evidence-backed `observed` settings: `webApiCdsErrorMessage`, `webApiAntiForgery`, `webApiReferenceErrors` and `webApiInvalidDate`. API response headers can be specified through `observed.headers.webApi`. These settings alter the response contract while preserving permission checks, origin confinement and rejected-write atomicity. Deployment-specific plugin behavior belongs in explicitly registered external data packs and handlers.

`observed.webApiCdsErrorCode: "cdscode"` adds the native platform code as `error.cdscode` for CDS failures even when inner errors are disabled. The default `"innererror"` retains the existing optional inner-error code. This site observation requires evidence; it does not enable error details or alter non-CDS permission/query errors.

An observed `webApiGlobalMetadataVersion` preserves the frozen organization's opaque numeric version string in API responses. Without that evidence, Mirage derives a synthetic version from local mappings. Recapture this observation after the site's metadata changes. Frozen row `versionnumber` values supply entity ETags independently.

`observed.webApiLookupFields: "explicit-wire"` reproduces sites whose column list must explicitly include `_lookup_value` for OData selection, filtering and ordering. A logical lookup remains usable in FetchXML and permitted navigation bindings; listing a wire read property alone does not authorize writes. Imported eligible system-view lookup columns continue to enable their metadata-derived read properties. The default `"logical-aliases"` retains existing lookup alias derivation. The setting requires `observed.evidence`.

`observed.webApiErrorDetails: odata-wrapper` additionally formats supported JSON-reader failures from the submitted value and imported Edm column type. It preserves the stable OData exception and nested conversion cause while omitting generated CLR stacks. The default `diagnostic` mode and non-Web-API errors keep their existing diagnostics. Inner errors still require the source setting; IEEE754-compatible Decimal strings and unobserved JSON grammar retain diagnostics rather than assuming a hosted parser contract.

An explicitly registered trusted pack can supply evidenced reader-specific error suffixes under `observed.webApiErrorStacks: response-template`. This is captured response emulation, separate from original CLR execution. It requires immutable source and fresh-variation hashes and preserves exact CRLF bytes. Defaults, unsupported branches, SDK/flow errors and write behavior remain unchanged.

Project parity runners should retain field-by-field requests, status, stored values after both accepted and rejected writes, rendered values, search results and cleanup outcomes. Keep reference cookies, tokens and opaque native hidden-field values out of evidence. Record generated identifiers and timestamps without treating independently generated values as literal mismatches; declare any comparison normalization and retain raw results.

Forms post back to the page by default, with an optional local JSON transport. Mirage does not reproduce opaque ASP.NET view-state or event-validation blobs. See [forms and lists](forms-lists-parity.md) for transport, validation and persistence behavior. Compare saved values and rendered results separately from transport details.

### Observed portal culture-parsed dates

`observed.webApiDateParsing: month-first` (with `evidence`) accepts `M/D/YYYY`,
`MM/DD/YYYY`, English full/abbreviated month names and two-digit years, optionally
followed by a 24-hour time or AM/PM, at the portal Web API write boundary for instant
columns. Two-digit years use a 2049 cutoff; an evidenced `webApiTwoDigitYearMax` can
override it when the site's culture/calendar differs. Calendar/clock components and
the supported date range remain validated. Day-first and impossible dates remain errors.
Direct datastore/SDK writes, query literals and native form parsing keep their contracts.
The observation selects a bounded English month-first parser; it does not implement every
.NET culture or infer one from the browser locale.

Behavior and display format are independent. UserLocal and TimeZoneIndependent columns
return UTC instants even with `Format: DateOnly`; the latter changes their formatted
annotation only. True DateOnly columns use the Edm.Date reader: ISO calendar dates
(including unpadded month/day) are accepted, whereas slash dates, timestamps, surrounding
whitespace and impossible dates are rejected before persistence. Fractions truncate to
the platform's stored second precision without rounding into the next second.

These rules cover Web API input only. They do not implement every .NET culture, the native date picker or form submission, full error text, or Liquid and query time-zone handling.

Solution XML's `Format: date` and `DateOnly` both select date-only presentation;
explicit UserLocal/TimeZoneIndependent behavior still controls instant storage. Failed
month-first conversions retain the submitted literal in the default diagnostic. The
evidenced `webApiInvalidDate: crm-minimum` profile distinguishes a failed conversion
(minimum .NET date) from a successfully parsed date below Dataverse's 1753 minimum.

UserLocal formatted annotations can use project-owned
`settings.formattedValueTimeZone: { evidence, rules }`, where `rules` contains the
Dataverse `timezonerule` bias, transition and effective-date fields. This explicitly
configured profile supports daylight saving and historical rule changes; the request
formatter compiles it once and caches transition boundaries by year. Without it,
`timeZoneOffsetMinutes` remains the fixed-offset setting. TimeZoneIndependent annotations
and true DateOnly values never apply the UserLocal offset. The profile applies to formatted
Web API annotations only; it does not infer or change browser controls or query calendars.
Rule fields follow Microsoft's [timezonerule reference](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/timezonerule?view=dataverse-latest)
and [Windows transition/bias definition](https://learn.microsoft.com/en-us/windows/win32/api/timezoneapi/ns-timezoneapi-dynamic_time_zone_information).

## Compare compiled portal grants

`comparePermissionModels(before, after)` from `paqvilo/mirage/fixtures` compares
two full `buildPermissionModel` results. Load each local source revision with its
own selected metadata, settings and observed profile before compiling it. The
admin permission tree alone is insufficient: it omits resolved relationship
descriptors and some role identities used by the comparison.

```js
import { comparePermissionModels } from 'paqvilo/mirage/fixtures';

const report = comparePermissionModels(beforeModel, afterModel);
if (report.status !== 'unchanged') {
  // The external project decides whether these changes satisfy its policy.
  console.log(report.summary, report.changes, report.diagnostics);
}
```

The versioned JSON report has `domain: 'compiled-portal-table-grants'`, a
`status`, counts by classification, changed grant cells and diagnostics. A cell
is an exact role ID, logical table and operation. Evidence lists contributing
permission IDs, source paths and resolved predicates; display names, record
values and unrelated input properties are omitted. Inputs are never changed.

Comparison ignores ordering, display-label changes, source-file moves and
equivalent splits of the same grants. Parent paths are compared structurally,
including their read requirement and inherited role association. A global grant
covers the same cell's scoped grants. Adding a predicate to a union cannot
reduce that union; removing it cannot expand it. These provable inclusion
directions are reported as `wider` or `narrower`. Independent directions produce
`mixed`. This describes potential grant coverage; no row is read, so the report
does not assert that a newly reachable record actually exists.

Different contact/account/parent predicates are not ranked by a guessed scope
ordering. They produce `indeterminate` unless exact predicate inclusion or a
global grant proves the direction. Missing/ambiguous roles, unknown scopes,
unresolved relationships, disabled compilation errors, cycles and observed
orphan profiles also prevent qualification. Source-mode, association-policy,
default-role, membership and persona/account changes are explicit diagnostics:
the same declared grant can reach different people under those changes.

This is a configuration comparison, not another authorization evaluator. It
does not determine live/deployed access, execute queries, combine page access
rules or Web API enabled-column policy, or reproduce enhanced authorization's
additional Dataverse role checks. Use the existing runtime APIs and project
acceptance fixtures for those layers. A report with `status: 'indeterminate'`
must not be treated as a successful no-widening assertion.

Inputs must be complete compiled models with known source mode, permission,
role, membership, persona and diagnostic arrays and a settings object. The
helper bounds models to 10,000 permissions, arrays/grant cells to 100,000 entries
and parent paths to 64 levels. Both models share a 1,000,000-unit work budget,
precharged for array sorting and nested role lists before expanding grants;
repeated references do not bypass it. Invalid shapes or excess bounds fail explicitly.
Projects own requirements such as which roles may access which tables.
