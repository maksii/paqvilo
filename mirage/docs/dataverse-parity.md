# Dataverse simulation

Mirage supports FetchXML, portal Web API and list OData contracts over local state. Queries use imported mappings, relationship metadata, column types and permission scopes. Results support platform-shaped choice/lookup values, paging, counts, expansion and error envelopes. Unsupported constructs and unresolved mappings fail with diagnostics rather than silently querying unrelated tables.

Local identities come from request sessions. Exported table permissions, web roles and parent/contact/account/self relationships control queries and writes when enforcement is enabled. Page access and table access are separate concerns. Metadata/scaffold discovery does not grant a persona permission to business rows.

The local store simulates create/update/delete, validation, bindings, declared backend rules and atomic state-file writes. [Dataverse plugin registrations](dataverse-plugins.md) are imported from selected Solutions; supported write/read stages can execute an explicitly trusted original CLR assembly, project model or mock, or be disabled. Unconfigured steps report skipped business logic. Top-level PreValidation SDK writes and asynchronous SDK requests commit independently; nested PreValidation and stages20/40 join their caller transaction. [Operations](operations.md) inventories exports and runs supported basic imported request or Dataverse row-trigger flows with separate backend profiles. Completed connector writes survive a later failed action. Unsupported connectors/settings require explicit local choices. These local execution contracts do not establish native business-source or security-query parity. New states contain no business records from references.

An exported unsupported server-logic endpoint answers HTTP 501 with the camelCase fields `requestId`, `success`, `serverLogicName`, `data` and `error`. This local fallback is an explicit unsupported result, not a successful execution or a claim about a deployment's wire format.

Use `webapi-inventory`, `bootstrap-report` and `portal-matrix` to find source calls, unresolved table identities and schema gaps. Use a project-owned parity plan for read-only comparisons against an authorized reference browser. Local correctness and live parity are reported separately.

## Permission queries and recording

Portal FetchXML reads now compile effective root-table grants into outer relationship joins and an OR permission filter before RetrieveMultiple observers execute. The compiler retains separate relationship paths, shares equivalent paths, traverses imported N:N intersections, and applies the configured Dataverse link-entity budget to the expanded query. The returned `xml` is the query used for local execution. `permissionQuery` reports authored/generated join counts, diagnostics and `qualification: "modeled"`. That label describes a local compiler; it does not assert that its XML bytes equal every hosted Power Pages rewrite. Microsoft's [Liquid FetchXML documentation](https://learn.microsoft.com/en-us/power-pages/configure/liquid/template-tags#xml-attribute) describes the resultant query exposed by Liquid; backend plugin captures must be compared independently.

The portal Web API validates enabled fields, column permissions and authored linked-table access before executing FetchXML. Generated permission links inspect relationship rows without exposing their columns. Default execution retains authored-table row checks. A correct root GUID set does not establish joined-column or query parity.

An evidence-backed `observed.tablePermissionQueryPipeline: "native-classic"` selects the captured lane admission contract. Liquid executes its compiled root query against backend relationship rows, including authored joins; a denied root returns an empty result and normalized authored XML without a Dataverse invocation. Web API reads check authored table grants and expanded query budgets before invoking plugins. Liquid encounters execution budgets after PreOperation, so its failed read can still have recorded incoming queries. This observation reproduces the selected site's classic authorization behavior, including joined columns that its Liquid query exposes. Omitted or `"row-filtered"` keeps the default row checks. The setting requires `observed.evidence`.

In that observed Web API profile, authored linked tables receive their own existential permission paths: the first relationship uses `link-type="any"`, later relationships use inner joins, and the terminal principal condition is applied inside the linked table's filter. Paths are compiled from the selected source grants. Only metadata-verified structural N:N intersections bypass independent table admission; an authored `intersect="true"` flag alone grants no access. Microsoft's [FetchXML filter documentation](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/fetchxml/filter-rows) defines the existential operator; the platform's particular permission rewrite requires independent native plugin evidence for each qualified configuration.

`observed.fetchPreOperationSerialization` can map exact logical tables to `"compact"` when captures show a platform serialization change between PreValidation and PreOperation. Stage 10 retains the initial expanded bytes; later stages receive compact XML. In the native Liquid profile, `xml` retains the exposed Liquid query and `executedXml` identifies the backend query. Neither field substitutes for a plugin capture. The mapping requires evidence and does not infer behavior for other tables.

`observed.liquidFetchExecution: "lazy-query-drop"` models deferred FetchXML results. The tag creates a source permission preview; reading `xml` alone does not execute RetrieveMultiple. The first `results` access executes once and caches its result or failure. A failed result can therefore remain observable on repeated access while the initial expanded XML stays readable. `liquidFetchErrorMessage: "target-invocation"` selects the captured invocation-wrapper message; simulator infrastructure failures still propagate. Both choices require evidence and remain opt-in until the site's execution timing and failure display have independent native witnesses. The default eager provider contract remains available.

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
Omitting the setting or selecting `read-only` preserves the previous Read-only
Liquid provider behavior.

`observed.tablePermissionGrantOrder` records an otherwise unexported ordering of permission alternatives as `{ normalizedGraphHash, tables: { logicalTable: [[permissionGuid], ...] } }`. The SHA256 binds the complete normalized permission graph, including names, activation, roles, operations and relationships. Each group contains source grants with the same qualified ordering position. Selected grants follow these groups; their paths and principal predicates still come from source permissions. A changed graph or a selected grant missing from the mapping fails qualification rather than silently using stale ordering. The configuration requires evidence. A repeated all-role capture establishes its witnessed order; it does not establish that every role subset retains that order. Each native comparison must independently verify its subset.

Portal query serialization supplies `mapping="logical"` and a default of `distinct="true"`, including aggregate queries, placing order elements before filters and permission filters before links. Generated XML uses CRLF and two-space indentation. A distinct query requires an explicit primary-key attribute when its caller needs the identity. Explicit `distinct="false"` is preserved and reported as unqualified by these captures. For distinct nonaggregate queries, compiler-owned principal paths can be pruned during local evaluation to avoid Cartesian intermediate rows; the recorded XML and Dataverse join budget stay unchanged. Observer changes to principal predicates or additional conditions on generated ancestors disable that optimization. Structural link changes require a separate mutation adapter and fail explicitly.

An inactive exported parent normally disables its child chain. A site's `observed.tablePermissionOrphans: "unrestricted"`, with `observed.evidence`, can replay the captured inactive-parent case: a surviving child with explicit roles and a resolved many-to-one parent lookup uses that lookup's non-null condition. This choice emits a diagnostic and leaves missing parents, unresolved relationships, reverse/N:N parent traversals, cycles and children without explicit roles closed. It is local reproduction of a captured defect, and must not be treated as a recommended permission configuration. Omitted or `"closed"` retains the default.

Supported scalar portal OData reads can pass through a local query-to-FetchXML adapter for observation. The separate evidence-backed `observed.odataPermissionQueryPipeline: "native-classic"` constructs the bounded captured compact FetchExpression contract from the authored scalar OData AST and source permissions. It preserves the observed authored boolean writer order, independently ordered permission alternatives, uppercase braced identity GUIDs and scoped any/inner joins. Its ordering uses `odataPermissionGrantOrder`, independently qualified from the Liquid ordering. The captured same-table Parent anchor requires `odataSameTableParentAnchor: "shared-root"`. These values require evidence. Compiler-owned `anyallalias` annotations carry exact filter-position sidecars; they do not relax authored FetchXML grammar. Initial default Web API pages execute this query through the actual RetrieveMultiple pipeline; unsupported conversion contracts fail explicitly. Native conversion for further navigation, continuation, admission failures, authored-link-dependent permission deduplication, Custom Access filters, enhanced authorization and additional graph combinations requires its own qualification. Source support and local tests must not turn those cases into reported native passes. [Permission access types](https://learn.microsoft.com/en-us/power-pages/security/table-permissions) and [Web API capabilities](https://learn.microsoft.com/en-us/power-pages/configure/web-api-overview) depend on the deployed platform version as well as the exported graph.

## Input and rendering contracts

Native date controls use exported date/time formats, column behavior and the browser timezone. Their hidden round-trip values contain seven fractional digits; `UserLocal` values carry UTC `Z`. Native hidden lookup values require both a record identity and its entity name. Malformed or incomplete references become empty values, including clearing a previously selected lookup on edit. Standalone code-component pages receive the platform WebForms wrapper, preserving the browser's handling of authored nested forms.

Column metadata controls numeric coercion, ranges, choice membership, string limits, email normalization and date validation. Integer, choice and floating-point columns accept supported numeric strings; decimal and money JSON values require numbers. User-local datetime values use ISO timestamps in API responses. Native forms retain invalid submitted text, report all server validation messages, and reject the entire write. Custom format and range validators do not silently turn invalid input into null.

Strings remain data through create, update, property reads, read-only forms and lists. Synthetic loopback regressions cover HTML, inert event-handler probes, XML, JSON, quotes, Unicode, entities and line breaks. Search follows Dataverse literal and SQL LIKE rules: OData scalar strings use single quotes; percent, underscore and bracket expressions retain their pattern semantics. A literal opening bracket uses `[[]`; a closing bracket outside a class is literal.

Portal-specific error text, anti-forgery behavior and reference errors require evidence-backed `observed` settings: `webApiCdsErrorMessage`, `webApiAntiForgery`, `webApiReferenceErrors` and `webApiInvalidDate`. API response headers can be specified through `observed.headers.webApi`. These settings alter the response contract while preserving permission checks, origin confinement and rejected-write atomicity. Deployment-specific plugin behavior belongs in explicitly registered external data packs and handlers.

`observed.webApiCdsErrorCode: "cdscode"` adds the native platform code as `error.cdscode` for CDS failures even when inner errors are disabled. The default `"innererror"` retains the existing optional inner-error code. This site observation requires evidence; it does not enable error details or alter non-CDS permission/query errors.

An observed `webApiGlobalMetadataVersion` preserves the frozen organization's opaque numeric version string in API responses. Without that evidence, Mirage derives a synthetic version from local mappings. Recapture this observation after native metadata changes; the synthetic value cannot establish native wire equality. Frozen row `versionnumber` values supply entity ETags independently.

`observed.webApiLookupFields: "explicit-wire"` reproduces sites whose column list must explicitly include `_lookup_value` for OData selection, filtering and ordering. A logical lookup remains usable in FetchXML and permitted navigation bindings; listing a wire read property alone does not authorize writes. Imported eligible system-view lookup columns continue to enable their metadata-derived read properties. The default `"logical-aliases"` retains existing lookup alias derivation. Qualify this setting with actual before/after source settings and native admission captures; it requires `observed.evidence`.

`observed.webApiErrorDetails: odata-wrapper` additionally formats supported JSON-reader failures from the submitted value and imported Edm column type. It preserves the stable OData exception and nested conversion cause while omitting generated CLR stacks. The default `diagnostic` mode and non-Web-API errors keep their existing diagnostics. Inner errors still require the source setting; IEEE754-compatible Decimal strings and unobserved JSON grammar retain diagnostics rather than assuming a hosted parser contract.

An explicitly registered trusted pack can supply evidenced reader-specific error suffixes under `observed.webApiErrorStacks: response-template`. This is captured response emulation, separate from original CLR execution. It requires immutable source and fresh-variation hashes and preserves exact CRLF bytes. Defaults, unsupported branches, SDK/flow errors and write behavior remain unchanged. Full hosted JSON envelope/member order/serialization/body equality must be checked independently against current native observations; suffix invariance alone does not establish that parity.

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

These rules cover a bounded Web API input contract. They do not establish every .NET culture, native datepicker/form submission, full error text or Liquid/query timezone semantics. Compare those separately for your site.

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
