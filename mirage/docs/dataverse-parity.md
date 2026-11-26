# Dataverse queries and portal permissions

How Mirage answers FetchXML, the portal Web API (`/_api/`), Liquid and list OData over local state, and how portal table
permissions shape those queries. The organization's own Web API, SOAP and TDS endpoints are in [Dataverse
API](dataverse-api.md); plug-ins in [plug-ins](dataverse-plugins.md).

Queries use imported mappings, relationship metadata, column types and permission scopes, and answer platform-shaped
choice and lookup values, paging, counts, expansion and error envelopes. Unsupported constructs and unresolved mappings
fail with diagnostics instead of querying unrelated tables. In FetchXML, `count` is the page length, capped at the
page-size limit of 5,000 by default. `returntotalrecordcount="true"` reports the matching total independently of the
page, capped at 5,000 with `total_record_count_limit_exceeded` true beyond it.
FetchXML queries that cannot produce a paging cookie, such as the local linked-column sort path, page over at most
50,000 rows, following the [Dataverse simple-paging limit](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/fetchxml/page-results#simple-paging).
Mirage ends the series at that boundary. The total count and cookie-capable query paths retain their own limits.

Power Pages Liquid `{% fetchxml %}` accepts `count="0"` and uses the default page size. The executed XML retains the
authored zero. Other FetchXML endpoints use their own count validation. The default local Liquid profile supplies a
total for ordinary paging when `returntotalrecordcount` is omitted. The `native-classic` permission profile returns
`-1` for that omission on admitted Liquid queries.

Local identities come from request sessions. Exported table permissions, web roles and parent, contact, account and self
relationships control queries and writes when enforcement is on. Page access and table access are separate; metadata
discovery never grants a persona access to business rows. Use `webapi-inventory`, `bootstrap-report` and `portal-matrix`
to find source calls, unresolved table identities and schema gaps.

No recorded parity case covers the portal behaviour on this page: the defaults are local models of Microsoft's
documentation, and each `observed.*` setting below reproduces a behaviour captured on one site and needs
`observed.evidence`. Confirm an observed setting on your own site before you select it.

## One write pipeline

Every organization write runs one pipeline: Web API and SOAP writes through the records layer, and SDK calls from CLR
plug-ins, flow Dataverse actions, portal `/_api` and form writes, activity messages and note, attachment and SharePoint
rows through its internal entries. They share state defaults, record hooks, audit and version columns and alternate-key
errors (`0x80048d19` for a calculated-column value, `0x80060892` for a duplicate alternate key). `Merge` and the
`CalculateRollupField` store write (which keeps `modifiedon`) use it too. The portal keeps its own table permissions and
value rules and wraps an organization error in its CDS envelope (`9004010D`) with the organization's code and message as
`innererror`.

A few internal writers write system-owned rows directly, because no user-facing rule applies to them:
`dataverse-duplicates.mjs` (publishing duplicate rules), `dataverse-addon-d365.mjs` (`asyncoperation` cancel) and
`dataverse-predefined.mjs` (`appnotification` rows of `SendAppNotification`). Their user-table writes (goal rollup, bulk
e-mail drafts, business process flow instances, `GenerateSocialProfile`) use the pipeline.

## Navigation binding

An `@odata.bind` names a navigation property, case-sensitively. A name no relationship declares (a column name, another
casing) answers 400 `0x80048d19` "An undeclared property … which only has property annotations in the payload …" on
every surface and stores nothing; the portal `/_api` answers it in its generic 400 `9004010A` envelope. The system
lookups every table carries (`ownerid`, `owninguser`, `owningteam`, `owningbusinessunit`, `createdby`, `modifiedby`,
`createdonbehalfby`, `modifiedonbehalfby`, `transactioncurrencyid`) also bind on their column name. A role-less
multi-table relationship gets the documented `<lookup>_<table>` navigation name (`objectid_<table>` for notes,
`regardingobjectid_<table>` for document locations); a single-table custom lookup keeps its schema name.

## Token failures

A portal Web API write without the anti-forgery token answers 401 `90040107`; a wrong token answers 403 `90040107` with
the message "The anti-forgery cookie token and form field token do not match." With `observed.webApiAntiForgery:
decryption-401` both answer 401 and the message starts with `Request validation failed : `; a wrong token then reports
that the anti-forgery token could not be decrypted. Reads need no token, and a stale token or bearer header does not
change a read. `MissingPortalSessionCookie` (401 `90040109`) is mapped but no local path raises it.
`Webapi/<table>/disableodatafilter` changes neither rows nor errors.

## Fiscal calendar

The fiscal FetchXML operators, the matching Web API query functions and fiscal-period and fiscal-year groupings read
`FiscalCalendarStart` and `FiscalPeriodType` from settings, else the organization row. Period types 2000 to 2004 split
the year into 1, 2, 4 or 12 periods, or 28-day periods; a fiscal year is numbered by the calendar year it starts in, and
bounds are half-open. The period model follows SQL 4 CDS (MIT, see `licenses/sql4cds.txt`) with these deliberate
differences:

- A date on a period's first day belongs to that period.
- This, last and next fiscal year follow the fiscal year that contains today.
- Period boundaries count from the fiscal year's start date, so a start on the 29th to 31st does not drift, and moving
  by periods steps across years by period index.
- A period number outside the year (period 5 of a quarterly year) matches nothing, as Learn documents.
- `in-fiscal-period` is evaluated per value.
- The last days of a 28-day-period year stay in period 13; a 29 February start falls on 28 February in other years.

## Platform changes

Source bootstrap reports Power Pages platform changes as portal diagnostics (bootstrap report, inspect and the panel);
persona resolution reports the last row:

| Code                                | Meaning                                                                                                                                                              |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ENHANCED_AUTHORIZATION`            | The site runs the [enhanced authorization](#enhanced-authorization) model; requirement `portal:enhanced-authorization` is satisfied at `behaviour`.                  |
| `LIST_ODATA_FEED_REMOVED`           | Lists with their OData feed enabled; the message cites Microsoft's announced removal of list OData feeds.                                                            |
| `TABLE_PERMISSIONS_ALWAYS_ENFORCED` | Lists, basic forms and advanced form steps with Enable Table Permissions off. Mirage enforces table permissions on every form and list regardless of that setting.   |
| `MODERN_LIST_LOCAL_MARKUP`          | A modern list include (`isModern: 'true'`) is served by the local adapter through the classic grid engine, with local markup.                                        |
| `MODERN_LIST_RENDERED_CLASSIC`      | A modern include names a map, calendar or code component list; it renders classic. A `portal:modern-list` requirement at `contract`, so `--strict` preflight blocks. |
| `MODERN_LIST_FEATURES_UNSERVED`     | A served modern list configures other action types; those actions are absent locally.                                                                                |
| `CMS_CONTENT_EDITOR_REMOVED`        | Pages and web templates whose Liquid uses `{% editable %}` or an `.editable` check, once each: the portal content editor is removed. Rendering is unchanged.         |
| `PERSONA_ACCOUNT_ROLES_NOT_APPLIED` | Web roles of a persona's parent account are reported, not applied: current Power Pages behaviour for them is not documented.                                         |

See [capabilities and preflight](capabilities-and-preflight.md#report-shape). An exported server-logic endpoint that
Mirage does not support answers 501 with the camelCase fields `requestId`, `success` (false), `serverLogicName`, `data`
and `error`.

## SQL LIKE

The read-only SQL evaluator's `LIKE` folds literal characters and character sets under the configured `CI_AI` or `CI_AS`
collation. `ESCAPE` takes one character; a pattern ending in an unmatched escape never matches; null operands keep SQL
unknown semantics ([LIKE](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/like-transact-sql), [Dataverse
collations](https://learn.microsoft.com/en-us/power-platform/admin/language-collations)). This is not full linguistic
collation parity.

## Access-team membership

`AddUserToRecordTeam` reuses the system-managed access team for a record/template while it has members. Removing its
final member deletes the team and its record share in the same local transaction; adding a member afterward creates a
fresh team identity from the runtime's ID source. Other members, independent user shares and manually managed teams keep
their existing access. This follows the lifecycle in Microsoft's [Access Teams
whitepaper](https://www.microsoft.com/en-us/download/details.aspx?id=41190).

`RemoveUserFromRecordTeam` returns 204 with no body; it does not return the `AccessTeamId` declared by Microsoft's
[action
contract](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/removeuserfromrecordteam?view=dataverse-latest).

## Choosing a read-only reference

Organization-user results (an SDK, the [Dataverse
CLI](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/cli/) or the [Web API
recorder](dataverse-api.md#record-and-compare-web-api-responses)) say nothing about Power Pages portal-session
authorization, query rewriting or portal errors: the [portal Web
API](https://learn.microsoft.com/en-us/power-pages/configure/web-api-overview) applies its own table and field settings,
permissions and session rules. Keep separate portal-persona captures for those claims. A CLI's JSON output does not
preserve raw OData, status, headers, annotations or continuation; qualify it against a signed-in browser capture before
using it as evidence. The Dataverse CLI is not a Paqvilo dependency. Keep identities, record ids, query values and
evidence in the owning project.

## Permission queries and recording

Portal FetchXML reads (Liquid `{% fetchxml %}` and the portal Web API `fetchXml` option) compile the root table's
effective grants into outer relationship joins and an OR permission filter before RetrieveMultiple observers execute.
The compiler retains separate relationship paths, shares equivalent paths, traverses imported N:N intersections, and
applies the configured Dataverse link-entity budget to the expanded query. The returned `xml` is the query used for
local execution. `permissionQuery` reports authored/generated join counts, diagnostics and `qualification: "modeled"`:
the XML comes from the local compiler and need not equal the hosted Power Pages rewrite byte for byte. Microsoft's
[Liquid FetchXML
documentation](https://learn.microsoft.com/en-us/power-pages/configure/liquid/template-tags#xml-attribute) describes the
resultant query exposed by Liquid.

### Default query shape

Liquid query serialization supplies `mapping="logical"` and a default of `distinct="true"`, including aggregate queries,
placing order elements before filters and permission filters before links. Generated XML uses CRLF and two-space
indentation.

A scoped read (any grant other than Global) supplies DISTINCT when the query omits it, in Liquid and the Web API, so
overlapping permission paths add no duplicate rows and no identifier repeats across Web API pages. An explicit
`distinct="false"` is kept and reports `PERMISSION_QUERY_DISTINCT_FALSE_UNQUALIFIED`. A Web API read under a Global
grant keeps the authored value, and omission there means false, so an authored join can return the root row once per
joined row. A distinct query returns the primary key only when it selects it explicitly; select it when the caller needs
the identity. Unqualified compiler callers retain explicit DISTINCT. For distinct nonaggregate queries, compiler-owned
principal paths can be pruned during local evaluation to avoid Cartesian intermediate rows; the recorded XML and
Dataverse join budget stay unchanged. Observer changes to principal predicates or additional conditions on generated
ancestors disable that optimization. Structural link changes require a separate mutation adapter and fail explicitly.

The portal Web API validates enabled fields, column permissions and authored linked-table access before executing
FetchXML. Generated permission links inspect relationship rows without exposing their columns. Default execution retains
authored-table row checks. An inactive exported parent permission disables its child chain.

### Join budgets

Backend retrieval and FetchXmlToQueryExpression controls distinguish two budgets: 15 ordinary joins and 27 ordinary
joins plus existential filter links. A filter's `any`, `not any`, `all` or `not all` root does not consume an ordinary
join; its ordinary descendants do. Every node remains in the query and combined count. Thus some 17-node trees succeed
while a sixteenth ordinary join or twenty-eighth combined node fails with CDS `0x8004430d`. The platform settings
`QueryLinkEntityLimit` and the simulator experiment `FetchLinkAndFilterLimit` configure those separate limits
([configuration experiments](configuration-experiments.md)). The default error text is the documented generic message
"Number of link entities in query exceeded maximum limit."; `observed.fetchLinkBudgetError: "reported-counts"` selects
the backend's count-specific text (`Number of link entity: 16 exceed limit 15. isReport=False.`) on every path that
checks the budget: portal Web API queries (including an authored query that exceeds the budget on its own, which is
refused before permission expansion), Liquid `fetchxml` and plug-in query conversion. In the
[native-classic profile](#native-classic-profile) the portal Web API refuses an authored query that exceeds the budget on
its own with the generic 500 `9004010A` ("An unexpected error occurred while processing the request", no `innererror`)
in either mode; a query that only the permission joins push over the budget keeps the 400 `9004010D` with the selected
text in `innererror`.

`paqvilo mirage query-inventory --portal <dir> [--json]` counts the literal `{% fetchxml %}` blocks in exported web
templates (root tables, the most link-entities and the deepest nesting per block, and the unresolved or dynamic blocks
it cannot count) so you can see how close authored queries are to these budgets before permission joins are added.

### Observed query settings

Each setting below changes local behaviour only when it is set under the site's `observed` block, and every one requires
`observed.evidence`; the configuration is refused without it or with a value outside the listed ones. The first value is
the default; a setting with a single value is off when omitted. Each reproduces a behaviour captured on one site:
confirm it on your own site before you select it.

| Setting                          | Values                                                                                    | Local effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Evidence to collect                                                                                                                                                                                                                                        |
| -------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tablePermissionQueryPipeline`   | `row-filtered`, `native-classic`                                                          | The captured lane admission contract ([native-classic profile](#native-classic-profile)): Web API reads check authored linked-table grants (403 `90040120` for an unreadable one) and expanded budgets before plug-ins; Liquid executes its compiled root query against backend relationship rows, authored joins included, and a denied root returns an empty result and normalized authored XML without a Dataverse invocation.                                                                                                       | The site's classic authorization behaviour, including joined columns its Liquid query exposes.                                                                                                                                                             |
| `webApiUpdatePermissionQuery`    | `native-classic`                                                                          | A portal Web API Update builds its complete source-derived Update permission query before checking the addressed row. Above the Dataverse join budget it answers 500 `9004010A` before any record hook or write, also for a foreign row that would otherwise answer 403 `90040102`; an admitted query uses the ordinary row permissions. The compiler counts the actual Update grant paths; it does not select outcomes by table name. Independent of the read profile; no effect on SDK writes, Create or Delete.                      | That the 500 comes from permission admission and not from a business plug-in.                                                                                                                                                                              |
| `webApiMutationPermissionText`   | `table`                                                                                   | Update and Delete denials read "You don’t have permission to update contact table." (Unicode apostrophe, table terminology) instead of "You don't have permission to update contact entity."; codes and permission decisions are unchanged.                                                                                                                                                                                                                                                                                             | The site's Update/Delete denial text.                                                                                                                                                                                                                      |
| `webApiFetchXmlLinkTypes`        | `dataverse`, `portal-classic`                                                             | Portal Web API FetchXML turns authored `exists`, `in` and `matchfirstrowusingcrossapply` links into ordinary inner-join results (one row per joined row) and rejects `not any`, `all` and `not all` filter links with 400 `9004010D`, inner `0x8004111c` "Invalid link type in a FetchXML filter." The conversion runs before permission expansion; never rewrites compiler-generated permission subqueries, Liquid or SDK queries. With `dataverse` the documented Dataverse link semantics apply.                                     | Queries on the site whose duplicate rows show the difference.                                                                                                                                                                                              |
| `liquidFetchXmlLinkTypes`        | `dataverse`, `portal-classic`                                                             | The same implicit-inner fallback for those three authored Liquid link types, keeping their projections and link-budget cost. Authored filter links using `not any`, `all` or `not all` also lose `link-type`; they stay visible in the rewritten XML and fail during backend execution, after PreOperation, unlike the Web API's earlier rejection. Deferred XML preview uses the same authoring conversion, DISTINCT rule and alias allocation as execution. Compiler-owned permission subqueries and SDK/backend reads are unchanged. | As above, through Liquid.                                                                                                                                                                                                                                  |
| `webApiFetchXmlTransport`        | `{encoding: "double-rfc3986", maxHeaderXmlBytes, maxUrlXmlBytes, maxConstructedXmlBytes}` | Applies only with `tablePermissionQueryPipeline: "native-classic"`. Measures the double-escaped size of the complete permission-expanded portal Web API FetchXML: above `maxConstructedXmlBytes` the generic 500 `9004010A`; above `maxUrlXmlBytes` CDS 414; above `maxHeaderXmlBytes` CDS 400; the 414 and 400 carry the HTTP.sys error page as inner message. Precedes backend admission and observers and never removes links. Liquid and SDK reads keep their own execution contracts.                                              | Each limit measured on the site just below and just above its boundary: effective byte budgets after the deployment's fixed backend URI/header overhead, ordered integers from 1 to 4,000,000. No token or header values or per-table outcomes are inputs. |
| `fetchAllWithoutFilter`          | `modeled`, `sql-error`                                                                    | An `all` link with no own filter fails with the witnessed backend `0x80044150` execution failure (the portal Web API answers its generic 500). Filtered quantifiers keep their documented semantics.                                                                                                                                                                                                                                                                                                                                    | The witnessed backend failure.                                                                                                                                                                                                                             |
| `fetchLinkBudgetError`           | `documented`, `reported-counts`                                                           | The budget error text ([join budgets](#join-budgets)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | The backend's error text.                                                                                                                                                                                                                                  |
| `fetchPreOperationSerialization` | `{ <logical table>: "compact" }`, at most 100 tables                                      | Stage 10 (PreValidation) observers receive the initial expanded bytes; later stages receive compact XML. In the native Liquid profile `xml` keeps the exposed Liquid query and `executedXml` names the backend query. Nothing is inferred for other tables.                                                                                                                                                                                                                                                                             | Captures showing the serialization change between PreValidation and PreOperation; neither field substitutes for a plug-in capture.                                                                                                                         |
| `liquidFetchExecution`           | `eager`, `lazy-query-drop`                                                                | Deferred FetchXML results: the tag creates a source permission preview, reading `xml` alone does not execute RetrieveMultiple, and the first `results` access executes once and caches its result or failure, so a failure stays observable on repeated access while the expanded XML stays readable.                                                                                                                                                                                                                                   | The site's execution timing and failure display.                                                                                                                                                                                                           |
| `liquidFetchTop`                 | `drop-valid`                                                                              | A valid authored `top` is removed from local `{% fetchxml %}` before permission compilation. The XML preview and execution apply the remaining paging attributes. Malformed and out-of-range `top` still fail validation.                                                                                                                                                                                                                                                                                                               | Two native Liquid queries that combine a positive `top` with zero and omitted `count`, showing the returned rows and `result.xml`.                                                                                                                         |
| `liquidFetchErrorMessage`        | `diagnostic`, `target-invocation`                                                         | A failed deferred result reports "Exception has been thrown by the target of an invocation."; simulator infrastructure failures still propagate. Takes effect with `lazy-query-drop`.                                                                                                                                                                                                                                                                                                                                                   | As above.                                                                                                                                                                                                                                                  |
| `liquidFetchRights`              | `read-only`, `native-classic`                                                             | The Liquid `right` attribute ([Liquid rights](#liquid-rights)); `read-only` ignores it. `native-classic` requires `tablePermissionQueryPipeline: "native-classic"`.                                                                                                                                                                                                                                                                                                                                                                     | The site's Liquid `right` behaviour; Create can expose a broader authored read than Read.                                                                                                                                                                  |
| `tablePermissionGrantOrder`      | `{ normalizedGraphHash, tables: { <logical table>: [[permissionGuid], ...] } }`           | Orders permission alternatives the export does not order ([grant order](#grant-order)).                                                                                                                                                                                                                                                                                                                                                                                                                                                 | An order captured for the current permission graph; an order captured with all roles is not guaranteed to hold for every subset of roles.                                                                                                                  |
| `tablePermissionOrphans`         | `closed`, `unrestricted`                                                                  | Replays the captured inactive-parent defect ([inactive parents](#inactive-parents)).                                                                                                                                                                                                                                                                                                                                                                                                                                                    | The site's inactive-parent case. It reproduces a platform defect seen on one site; do not use it as a permission design.                                                                                                                                   |
| `odataPermissionQueryPipeline`   | `modeled`, `native-classic`                                                               | The captured compact FetchExpression for scalar portal OData reads ([OData permission queries](#odata-permission-queries)).                                                                                                                                                                                                                                                                                                                                                                                                             | Captured OData backend queries.                                                                                                                                                                                                                            |
| `odataPermissionGrantOrder`      | Same shape as `tablePermissionGrantOrder`                                                 | Orders the OData profile's permission alternatives, separately from the Liquid ordering.                                                                                                                                                                                                                                                                                                                                                                                                                                                | As for `tablePermissionGrantOrder`.                                                                                                                                                                                                                        |
| `odataSameTableParentAnchor`     | `shared-root`                                                                             | The captured same-table Parent anchor of the OData profile.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Captured OData backend queries.                                                                                                                                                                                                                            |

#### Native-classic profile

In the `tablePermissionQueryPipeline: "native-classic"` profile, Web API reads check authored table grants and expanded
query budgets before invoking plug-ins. Liquid encounters execution budgets after PreOperation, so its failed read can
still have recorded incoming queries. The profile reproduces the selected site's classic authorization behaviour,
including joined columns that its Liquid query exposes.

Authored linked tables in Web API queries receive their own existential permission paths: the first relationship uses
`link-type="any"`, later relationships use inner joins, and the terminal principal condition is applied inside the
linked table's filter. Paths are compiled from the selected source grants. Only metadata-verified structural N:N
intersections bypass independent table admission; an authored `intersect="true"` flag alone grants no access.
Microsoft's [FetchXML filter
documentation](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/fetchxml/filter-rows) defines the
existential operator.

The profile compiles scoped Liquid and Web API FetchXML with `distinct="true"`, including when the author supplied
`false`. This removes repeated projected tuples from overlapping permission paths; selected linked columns remain part
of the tuple. Aggregate input rows still include permission-join multiplicity: a root collection and `count` need not
have the same cardinality. Permission paths and their link-budget cost remain intact. A Global root grant retains
authored DISTINCT, with omission meaning false for Web API queries. SDK/backend reads retain their separate authored
query contract. The default profile already supplies DISTINCT when it is omitted, so selecting native-classic is not
necessary merely for that; it changes additional authorization and admission behaviour.

The profile reserves explicitly aliased authored occurrences of each table when allocating generated permission aliases,
including an authored link with a different alias. An unaliased authored link does not advance that permission-alias
counter.

Backend subquery joins validate unsupported projections/orders with `0x80041121`. Cross-apply selects a qualifying
candidate after evaluating its unprojected descendants.

#### Liquid rights

`liquidFetchRights: "native-classic"` requires `tablePermissionQueryPipeline: "native-classic"`; without it the
runtime does not start and `mirage preflight` exits 2 with the same configuration error
(`observed.liquidFetchRights native-classic requires tablePermissionQueryPipeline native-classic; set both or
neither`). With both, Read/default and an invalid right use Read grants; Write uses Update grants, and
Delete/Append/AppendTo use their respective grants. Valid names are case-insensitive; `append_to` is an invalid spelling
and uses Read. Create checks a selected Create grant and executes the normalized authored query without scoped
permission joins or an added DISTINCT default. Preview flags and execution use the same selected operation. A denied
right reports `permission_granted` false and produces an empty collection without a backend invocation. Web API and SDK
reads remain bound to their own operations.

#### Grant order

`tablePermissionGrantOrder` records an otherwise unexported ordering of permission alternatives. Each group contains
source grants with the same qualified ordering position. Both root grants and permission alternatives inside authored
linked tables follow their table's groups; their full paths and principal predicates still come from source permissions.
`normalizedGraphHash` is a SHA256 over the complete normalized permission graph, including names, activation, roles,
operations and relationships: `permissionOrderGraphFingerprint(permissions)` from
`paqvilo/mirage/lib/permission-query.mjs` computes it from the runtime's permissions (`GET /_sim/api/permissions`). A
changed graph, a selected grant missing from the mapping, or a table with several scoped grants and no Global grant that
the mapping does not list fails with `PermissionGrantOrderUnqualified` (501; the portal Web API answers 501
`NotImplemented`) rather than silently using stale ordering.

#### Inactive parents

With `tablePermissionOrphans: "unrestricted"`, a surviving child of an inactive exported parent, with explicit roles and
a resolved many-to-one parent lookup, uses that lookup's non-null condition and the runtime records
`PERMISSION_OBSERVED_ORPHAN_UNRESTRICTED`. Missing parents, unresolved relationships, reverse/N:N parent traversals,
cycles and children without explicit roles stay closed.

#### OData permission queries

Supported scalar portal OData reads can pass through a local query-to-FetchXML adapter for observation. The
`odataPermissionQueryPipeline: "native-classic"` profile constructs the bounded captured compact FetchExpression
contract from the authored scalar OData AST and source permissions. It preserves the observed authored boolean writer
order, independently ordered permission alternatives (`odataPermissionGrantOrder`), uppercase braced identity GUIDs and
scoped any/inner joins; the captured same-table Parent anchor requires `odataSameTableParentAnchor: "shared-root"`.
Compiler-owned `anyallalias` annotations carry exact filter-position sidecars; they do not relax authored FetchXML
grammar. Initial default Web API pages execute this query through the actual RetrieveMultiple pipeline; unsupported
conversion contracts fail explicitly.

Cross-table lookup Parent paths preserve the captured nullable guards: two lookups produce three links, including a `not
any` null guard and the terminal nested `any` traversal. Source-derived navigation binding failures precede
RetrieveMultiple admission: an N:N lambda beneath a lookup produces CDS `0x80040216` (400), while excessive generated
scalar lookup depth produces `0x8006088a` (501). Binding visits OR alternatives in their independently qualified writer
order, checking scalar null guards before the collection lambda within each path. Reversing alternatives can change the
first error from 400 to 501. No links are removed to meet the query budget. The profile does not model further
navigation, continuation, permission deduplication that depends on authored links, Custom Access filters, enhanced
authorization or other graph combinations. [Permission access
types](https://learn.microsoft.com/en-us/power-pages/security/table-permissions) and [Web API
capabilities](https://learn.microsoft.com/en-us/power-pages/configure/web-api-overview) depend on the deployed platform
version as well as the exported graph.

## Enhanced authorization

A site record whose `enhancedauthorization` is 1 (Migration in progress), 2 (Migration Failed) or 3 (Enabled) runs the
enhanced authorization model locally ([unify Power Pages security with
Dataverse](https://learn.microsoft.com/en-us/power-pages/security/unify-pages-security-with-dataverse)); 0 or no value
runs the standard model. Each start records `PORTAL_AUTHORIZATION_MODEL` (info) naming the state and the model, and a
denied request's `TABLE_PERMISSION_DENIED` diagnostic names the model.

In the enhanced model every web role maps to a Dataverse security role whose privileges are derived from the role's
table permissions (one privilege per operation and table), and every visitor runs as a mapped Dataverse user: one per
contact and site, one per site for anonymous visitors, with `systemmanagedusertype` 1 and the security roles of the
visitor's web roles. A table permission grants only while the mapped user holds that privilege through the security role
of one of the permission's web roles, so removing the privilege from the role in Dataverse revokes the grant; the
records a grant reaches are those its scope selects. Dataverse column security profiles assigned to the mapped user (or
to the site's anonymous user) apply to every read (Liquid, lists, forms, search, the portal Web API) and to every portal
write, and the Web API column permissions are not evaluated. Every portal write (the Web API, forms, list and subgrid
actions, notes and server logic's Dataverse connector) runs as the mapped user called by the site's application user, so
`createdby`/`modifiedby` name the mapped user. Server logic's `InvokeCustomApi` runs as the mapped user. A table
permission without a web role grants nothing in the enhanced model; a wildcard (`*`) table permission expands to every
mapped table when the roles are derived.

The mapped security roles are platform-managed: they mirror the current web roles (the role of a removed web role is
deleted), and a table-permission change rewrites a role from the permissions. A change made to a mapped role in
Dataverse holds until that rewrite; a rewrite that replaces such a change records `PORTAL_AUTHORIZATION_ROLE_RESYNCED`
once. When mapping a visitor fails (`PORTAL_AUTHORIZATION_SYNC_FAILED`), that visitor is denied everything until a
mapping succeeds. Any other `enhancedauthorization` value runs the standard model, with the label "Unknown (n)" and the
warning `PORTAL_AUTHORIZATION_STATE_UNKNOWN`.

Table permission scopes map to privilege depths as follows: Global to Global, Account to Local, Contact and Self to
Basic, and Parent to the parent's depth. A site whose migration is in progress or has failed runs the enhanced model.
Microsoft does not document either choice, so treat them as local defaults.

## Column security on portal reads

Every portal read answers secured columns the same way: forms and advanced form steps, lists and subgrids, portal
search, Liquid `fetchxml` and `entities`, and the portal Web API, including `$expand` and `fetchXml` reads. Portal reads
mask secured columns with the same column security and masking rules as a Dataverse Web API read by the reading
principal: in the standard authorization model the site's application user, in the enhanced model the visitor's mapped
Dataverse user. A secured column that principal cannot read is empty (FetchXML results omit it), and a readable secured
column with a masking rule shows its masked value, because a portal read never asks for unmasked data; a column security
profile's Read unmasked setting does not change a portal read. Reads made outside a portal request, such as the
Dataverse Web API or server-side store reads, are unchanged. Column security resolves a table's masking rule, profile
grants and metadata by the table's logical name even when the stored mapping does not carry `logicalName`
(project-declared tables), so masking rules apply on every read that goes through it.

A portal read that filters, orders, groups, aggregates or asks distinct rows over a secured column the reading principal
reads masked is refused with the Dataverse error `0x80041155` (filtering on masked attributes), the refusal Mirage's
Dataverse Web API gives a read without unmasked data. This applies to the portal Web API (`$filter`, `$orderby`,
`$apply`, `$expand` options and `fetchXml`), Liquid `fetchxml`, lists and search. The portal Web API answers it as 400
`9004010D` with the Dataverse code in `innererror` when `Webapi/error/innererror` is on. A column security profile's
Read unmasked setting does not lift the refusal, because a portal read never asks for unmasked data. A secured column
the principal cannot read is evaluated as empty and is not refused. Notes and attachment listings read their annotation
rows through the same masking. The SharePoint document listing returns only file and folder names, sizes, types and
dates.

Portal associations follow the table permission definitions (Learn `mspp_entitypermission`: Append attaches another
record to the specified record, Append To appends the specified record to another record). A lookup bind on create or
update, a single- or collection-valued `$ref` and a many-to-many `$ref` need Append To on the table of the request (the
row holding the lookup, or the URL row of a `$ref`) and Append on the related table; the related table needs no Web API
settings and no Read. Either missing grant is 403 `90040106` "You don’t have permission to associate or disassociate
table <related> to <request table>". A collection-valued `$ref` then needs Write on its URL row (403 `90040103` "You
don’t have permission to create records for <table> table."), and a `$ref` navigation must be a listed Web API field
(403 `90040101`, checked after the permissions). Native, captured 2026-11-23 through a site's `/_api` (Paqvilo
developer workbench `feedback-251-252-parity`, Q3–Q8). Grants imported from a portal export enforce these checks
unless the state sets `settings.associationPermissions: "compatibility"`. Metadata-declared intersect rows do not
require a separate Create/Delete grant for an association operation. Direct intersect-table writes and manually
configured edge mappings retain their own CRUD checks. Export bootstrap preserves explicit Append and AppendTo flags,
including false values.

`observed.webApiSelfNnPermissionErrors: { x_relationship: "native-classic" }` qualifies the captured portal denial
envelope for specific imported self-referencing N:N relationships: a missing endpoint Append or AppendTo grant returns
the witnessed `90040106` message with the `EntityPermissionAppendToIsMissingDuringAssociationChange` inner error type
for those schemas. The profile requires site evidence; other relationships and unqualified sites answer `90040106` with
the generic inner error, and SDK errors keep their independent contract.

## Portal Web API file and image columns

The portal `/_api` serves file and image columns:

- `PUT` or `PATCH /_api/<set>(<id>)/<column>` uploads the request body, with the file name in the `x-ms-file-name`
  header or, for a name outside ASCII, the `x-ms-file-name` query parameter; it answers 204. An upload without a file
  name keeps the stored file's name, else `<column>.bin`. A file name with `/`, `\`, NUL, or `.`/`..` alone answers 400
  `9004010D` (inner `0x80040203`, "The file name must not contain a path.") before anything is stored.
- `GET /_api/<set>(<id>)/<column>/$value` answers 200 with the bytes as `application/octet-stream`,
  `Content-Disposition: attachment` with the file name (RFC 5987), `X-Content-Type-Options: nosniff`, and the stored
  type, name and size in the `mimetype`, `x-ms-file-name` (percent-encoded) and `x-ms-file-size` headers. A stored file
  is never served as its own type on the portal origin; `/api/data` keeps its documented headers. Image bytes default to
  the thumbnail; `size=full` requests the full image when its column stores one, else answers 204. Mirage also allows
  a single `Range: bytes=start-end` download with status 206 and `Content-Range`. Clients can pass the returned ETag
  in `If-Match` when requesting another range to avoid combining bytes from two file versions.
- `DELETE /_api/<set>(<id>)/<column>` clears the column and answers 204.

The column must be listed in `Webapi/<table>/fields` (403 `90040101` otherwise; its column permission applies), and the
visitor needs the table permission Read on the row to download and Write to upload or delete (403 `90040102` otherwise,
nothing stored). The bytes then go through the organization's file column entry, as on `/api/data`: the column's
`MaxSizeInKB` (from the project mapping, a metadata POST or PUT, or the Solution export; an image without one is
limited to 10,240 KB), image checks, storage routing, 404 for an empty file column and 204 for an empty image. A file
over the limit, bytes that are not an image, and an 11 MB PNG on an image column without a limit each answer 400
`9004010D`. Upload transfers carry the whole file in one request and are bounded at 128 MiB. Portal upload
continuations require separate hosted evidence.

Image values in entity, collection, FetchXML, navigation and expanded JSON responses resolve to stored base64 data,
including write representations. Hydration preserves the portal reader's field-security mask; binary downloads cannot
bypass a masked storage identifier. The raw route's default thumbnail contract follows [Power Pages image
columns](https://learn.microsoft.com/en-us/power-pages/configure/image-column) and [Dataverse image
data](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/image-column-data).

For a valid PNG uploaded to a portal image-column route, Mirage removes the `eXIf` metadata chunk while preserving the
rest of the full image bytes. Portal PNG thumbnails use centered square cropping, with a 144 pixel edge for larger
images and the shorter side for smaller images. Projection and range downloads use the same thumbnail. The local codec
returns the original bytes for interlaced images, unsupported formats, and inputs beyond its pixel or dimension limits.
Portal JPEG uploads remove Exif APP1 before the first scan and preserve the other encoded bytes.

Portal JPEG reads get a thumbnail by the same rule and the same center crop as PNG, so both formats pick the same source
pixels. The bounded local codec (`lib/portal-jpeg-codec.mjs`) decodes baseline and extended sequential Huffman JPEG
(SOF0/SOF1, 8-bit, grayscale or YCbCr/RGB, any integral sampling, restart intervals, 8- or 16-bit quantization tables)
up to 8192 pixels a side and 8M pixels, and encodes the thumbnail as baseline JFIF at quality 90 (4:2:0 for colour, one
component for grayscale). Progressive, lossless, arithmetic-coded, 12-bit and CMYK JPEGs, malformed or truncated files
and larger images keep their original bytes. A portal JPEG upload with Exif orientation 2–8 is re-encoded upright,
reusing its quantization tables and chroma subsampling, before Exif is removed; orientation 1 or no Exif keeps the bytes.
`size=full` and organization reads return the stored bytes. The thumbnail geometry follows Microsoft Learn; the
thumbnail encoding, quality and orientation handling are a local model until hosted thumbnail bytes are captured.

Portal GIF and BMP reads get a thumbnail by the same rule and the same center crop as PNG and JPEG
(`lib/portal-image-formats.mjs`). Microsoft Learn's [Types of columns](https://learn.microsoft.com/power-apps/maker/data-platform/types-of-fields#image-columns)
says uploaded images are converted to .jpg and an animated GIF keeps only its first frame, so these thumbnails are
baseline JFIF at quality 90, with transparent pixels composited on white. The GIF decoder reads GIF87a and GIF89a:
global and local color tables, the graphic control transparency index, interlaced rows and LZW codes up to 12 bits,
including a deferred clear. It draws the first frame on a transparent logical screen; parts of the frame outside the
screen are cut off, and indices past the color table stay transparent. The BMP decoder reads BITMAPINFOHEADER and its
V2 to V5 extensions: 1-, 4- and 8-bit color tables, 16-bit 5-5-5 and BI_BITFIELDS (for example 5-6-5), 24-bit, and
32-bit BI_RGB, BI_BITFIELDS and BI_ALPHABITFIELDS, bottom-up or top-down, plus BI_RLE8 and BI_RLE4. As Chromium decodes
them, 32-bit BI_RGB with a 40-byte header is opaque, an alpha mask applies as it stands, and pixels that runs skip or
that use an index past the color table are black. OS/2 headers, embedded JPEG or PNG, other compressions, top-down RLE,
malformed or truncated files, and images over 8192 pixels a side or 8M pixels keep their original bytes, as does an
image that already is its own thumbnail. `size=full` and organization reads return the stored bytes. The geometry and
the .jpg output follow Microsoft Learn. The quality, the white background, the BMP alpha and RLE details, and keeping
the bytes of an image that is already square at its thumbnail size are a local model until hosted thumbnail bytes are
captured; a ranged thumbnail read still names the stored `mimetype`.

## Input and rendering contracts

Native date controls use exported date/time formats, column behaviour and the browser timezone. Their hidden round-trip
values contain seven fractional digits; `UserLocal` values carry UTC `Z`. Native hidden lookup values require both a
record identity and its entity name. Malformed or incomplete references become empty values, including clearing a
previously selected lookup on edit. Standalone code-component pages receive the platform WebForms wrapper, preserving
the browser's handling of authored nested forms.

Configured native-form association with the current portal contact is a server-owned stamp. It does not require the
visitor's source Append To or Contact Append grants. The internal exception is consumed by the root form create before
plug-ins and deep inserts; it cannot authorize another lookup, an ordinary Web API binding, a missing target or a denied
row Create. A lookup a plug-in sets or changes is not a visitor binding and is not checked (native Create and Update). Other on-save lookup metadata retains ordinary relationship permission checks.

A terminal native multistep POST redirects to the same page with `msg=success` and its final `stepid`. The GET renders
success only for the same owner's completed form and final committed step history; start-new sessions also require their
exact session ID. A hidden completed form confirms its write without reading or exposing row fields, while a visible
form retains ordinary Read checks. Reloading that success URL does not repeat the write. A query alone cannot
manufacture success, and ordinary reload/resume access rules still apply when the success marker is absent.
Transport-neutral JSON submissions retain their message outcome.

Column metadata controls numeric coercion, ranges, choice membership, string limits, email normalization and date
validation. Integer, choice and floating-point columns accept supported numeric strings; decimal and money JSON values
require numbers. User-local datetime values use ISO timestamps in API responses. Native forms retain invalid submitted
text, report all server validation messages, and reject the entire write. Custom format and range validators do not
silently turn invalid input into null.

Strings remain data through create, update, property reads, read-only forms and lists, including HTML, XML, JSON,
quotes, Unicode, entities and line breaks. Search follows Dataverse literal and SQL LIKE rules: OData scalar strings use
single quotes; percent, underscore and bracket expressions retain their pattern semantics. A literal opening bracket
uses `[[]`; a closing bracket outside a class is literal.

A server-side failure on the portal Web API keeps its status: 501 answers code `NotImplemented` with the local reason
(a `POST /_api/cloudflow/...` with no simulator endpoint: "Cloud flow triggers are not run locally; configure a
simulator endpoint for <path> to answer this request."), any other 5xx answers `9004010A` "An unexpected error
occurred while processing the request" (for one, an `all` link without a filter under
`fetchAllWithoutFilter: "sql-error"`), and a local state conflict answers 409 `StateConflict` with the local reason (a
write while another writer holds the state file's lock). A JSON body over 8 MiB and a file upload over 128 MB both
answer 413 `0x8004418a` "Request message length is too large.".

The portal Web API runs `$apply` (`groupby`, `aggregate` and `filter` transformations). `savedQuery` and `userQuery` are
not portal Web API options: either one answers 400 `9004010A`, whatever its id.

A portal Web API collection answers at most 5,000 rows per response, with an absolute `@odata.nextLink` carrying
`$skiptoken` when more rows follow; `$skip` answers 400 (follow the link instead). `Prefer: odata.maxpagesize=N` pages
only a query that has `$top`, as on Power Pages: without `$top` the preference is ignored and the response is the one
the query gets without it, while the Dataverse Web API pages without `$top`. With `$top`, a response holds at most N
rows and its next link keeps the query, `$top` included. `$top` bounds the whole result, so the last page stops at it;
the live captures cover the first page and its link, and the later pages follow OData. A next link is signed for its
query, the visitor and the local data: a changed query, a different visitor or a committed change answers 400
(restart the query). No `Preference-Applied` header is sent.

For tables exported as custom activities, a nonempty list of solely inherited `activitypointer` columns is refused
as a wildcard by default. This applies after combining the explicit site setting and the imported system view and to
an OData `$select`. Include a column defined directly on the custom activity table. The existing evidence-backed
wildcard exemption represents a site observation. Set `observed.webApiWildcardExpiresAt` to the observed ISO UTC
expiration instant to enforce the response change on the Mirage clock. Exemptions without a timestamp retain the
legacy site observation.

Portal-specific error text, anti-forgery behaviour and reference errors require evidence-backed `observed` settings
(default first):

- `webApiCdsErrorMessage`: the outer message of a `9004010D` CDS error, `CDS error occurred.` or `Common Data Service
error occurred.`.
- `webApiAntiForgery`: `cookie-mismatch-403` or `decryption-401` (see [token failures](#token-failures)).
- `webApiReferenceErrors`: `dataverse` answers a bind to another origin with 400 `9004010D` and a missing target with
  400 `9004010D` (`0x80040217`); `unexpected` answers the first with 500 `9004010A` and the second with 404 `9004010D`,
  both without `innererror`.
- `webApiInvalidDate`: `invalid-format` or `crm-minimum` (see [culture-parsed
  dates](#observed-portal-culture-parsed-dates)).

API response headers can be specified through `observed.headers.webApi`. These settings alter the response contract
while preserving permission checks, origin confinement and rejected-write atomicity. Deployment-specific plug-in
behaviour belongs in explicitly registered external data packs and handlers.

`observed.webApiCdsErrorCode: "cdscode"` adds the native platform code as `error.cdscode` for CDS failures even when
inner errors are disabled. The default `"innererror"` retains the existing optional inner-error code. This site
observation requires evidence; it does not enable error details or alter non-CDS permission/query errors.

An observed `webApiGlobalMetadataVersion` preserves the frozen organization's opaque numeric version string in API
responses. Without that evidence, Mirage derives a synthetic version from local mappings. Recapture this observation
after the site's metadata changes. Frozen row `versionnumber` values supply entity ETags independently.

`observed.webApiLookupFields: "explicit-wire"` reproduces sites whose column list must explicitly include
`_lookup_value` for OData selection, filtering and ordering. A logical lookup remains usable in FetchXML and permitted
navigation bindings; listing a wire read property alone does not authorize writes. Imported eligible system-view lookup
columns continue to enable their metadata-derived read properties. The default `"logical-aliases"` retains existing
lookup alias derivation. The setting requires `observed.evidence`.

`observed.webApiErrorDetails: odata-wrapper` additionally formats supported JSON-reader failures from the submitted
value and imported Edm column type. It preserves the stable OData exception and nested conversion cause while omitting
generated CLR stacks. The default `diagnostic` mode and non-Web-API errors keep their existing diagnostics. Inner errors
still require the source setting; IEEE754-compatible Decimal strings and unobserved JSON grammar retain diagnostics
rather than assuming a hosted parser contract.

An explicitly registered trusted pack can supply evidenced reader-specific error suffixes (its `webApiErrorTemplates`;
see [captured error templates](data-packs.md#captured-error-templates)) under `observed.webApiErrorStacks:
response-template`. The suffix is appended to the `odata-wrapper` inner message of a `POST` or `PATCH` whose method and
reader descriptor a template covers, so it also needs `observed.webApiErrorDetails: odata-wrapper` and
`Webapi/error/innererror`. This is captured response emulation, separate from original CLR execution. It requires
immutable source and fresh-variation hashes and preserves exact CRLF bytes. Defaults, unsupported branches, SDK/flow
errors and write behaviour remain unchanged.

Forms post back to the page by default, with an optional local JSON transport. Mirage does not reproduce opaque ASP.NET
view-state or event-validation blobs. See [forms and lists](forms-lists-parity.md) for transport, validation and
persistence behaviour. Compare saved values and rendered results separately from transport details.

### Observed portal culture-parsed dates

By default the portal Web API accepts ISO date-times only; `7/7/2025` answers 400 `9004010D` with `innererror` code
`0x80040239` ("The date-time format for 7/7/2025 is invalid, or value is outside the supported range.").

`observed.webApiDateParsing: month-first` (with `evidence`) accepts `M/D/YYYY`, `MM/DD/YYYY`, English full or
abbreviated month names (`July 7, 2025`, `Jul 7 2025 3:04 pm`) and two-digit years, optionally followed by a 24-hour
time or AM/PM, at the portal Web API write boundary for instant columns. Two-digit years use a 2049 cutoff (`49` is
2049, `50` is 1950); an evidenced `webApiTwoDigitYearMax` (99 to 9999, only with month-first) moves it when the site's
culture or calendar differs. Calendar and clock components and the supported date range remain validated: day-first and
impossible dates (`2/30/2025`) remain errors. Direct datastore and SDK writes, query literals and native form parsing
keep their contracts. The observation selects a bounded English month-first parser; it does not implement every .NET
culture or infer one from the browser locale.

Failed conversions keep the submitted literal in the default message. The evidenced `webApiInvalidDate: crm-minimum`
profile instead answers "DateTime is less than minumum value supported by CrmDateTime. Actual value: …" (spelled as
captured) with the minimum .NET date (`01/01/0001 00:00:00`) for a failed conversion and the parsed value for a date
below Dataverse's 1753 minimum.

Behaviour and display format are independent. UserLocal and TimeZoneIndependent columns return UTC instants even with
`Format: DateOnly`; the latter changes their formatted annotation only. Solution XML's `Format: date` and `DateOnly`
both select date-only presentation, while explicit UserLocal or TimeZoneIndependent behaviour still controls instant
storage. True DateOnly columns use the Edm.Date reader: ISO calendar dates (including unpadded month and day) are
accepted, whereas slash dates, timestamps, surrounding whitespace and impossible dates are rejected before persistence.
Fractions truncate to the platform's stored second precision without rounding into the next second.

These rules cover Web API input only. They do not implement the native date picker or form submission, full error text,
or Liquid and query time-zone handling.

UserLocal formatted annotations can use project-owned `settings.formattedValueTimeZone: { evidence, rules }`, where
`rules` contains the Dataverse `timezonerule` bias, transition and effective-date fields. This explicitly configured
profile supports daylight saving and historical rule changes; the request formatter compiles it once and caches
transition boundaries by year. Without it, `timeZoneOffsetMinutes` remains the fixed-offset setting. TimeZoneIndependent
annotations and true DateOnly values never apply the UserLocal offset. The profile applies to formatted Web API
annotations only; it does not infer or change browser controls or query calendars. Rule fields follow Microsoft's
[timezonerule
reference](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/timezonerule?view=dataverse-latest)
and [Windows transition/bias
definition](https://learn.microsoft.com/en-us/windows/win32/api/timezoneapi/ns-timezoneapi-dynamic_time_zone_information).

## Compare compiled portal grants

`comparePermissionModels(before, after)` from `paqvilo/mirage/fixtures` compares two full `buildPermissionModel`
results. Load each local source revision with its own selected metadata, settings and observed profile before compiling
it. The admin permission tree alone is insufficient: it omits resolved relationship descriptors and some role identities
used by the comparison.

```js
import { comparePermissionModels } from 'paqvilo/mirage/fixtures';

const report = comparePermissionModels(beforeModel, afterModel);
if (report.status !== 'unchanged') {
  // The external project decides whether these changes satisfy its policy.
  console.log(report.summary, report.changes, report.diagnostics);
}
```

The versioned JSON report has `domain: 'compiled-portal-table-grants'`, a `status`, counts by classification, changed
grant cells and diagnostics. A cell is an exact role ID, logical table and operation. Evidence lists contributing
permission IDs, source paths and resolved predicates; display names, record values and unrelated input properties are
omitted. Inputs are never changed.

Comparison ignores ordering, display-label changes, source-file moves and equivalent splits of the same grants. Parent
paths are compared structurally, including their read requirement and inherited role association. A global grant covers
the same cell's scoped grants. Adding a predicate to a union cannot reduce that union; removing it cannot expand it.
These provable inclusion directions are reported as `wider` or `narrower`. Independent directions produce `mixed`. This
describes potential grant coverage; no row is read, so the report does not assert that a newly reachable record actually
exists.

Different contact/account/parent predicates are not ranked by a guessed scope ordering. They produce `indeterminate`
unless exact predicate inclusion or a global grant proves the direction. Missing/ambiguous roles, unknown scopes,
unresolved relationships, disabled compilation errors, cycles and observed orphan profiles also prevent qualification.
Source-mode, association-policy, default-role, membership and persona/account changes are explicit diagnostics: the same
declared grant can reach different people under those changes.

This is a configuration comparison, not another authorization evaluator. It does not determine live/deployed access,
execute queries, combine page access rules or Web API enabled-column policy, or reproduce enhanced authorization's
additional Dataverse role checks. Use the existing runtime APIs and project acceptance fixtures for those layers. A
report with `status: 'indeterminate'` must not be treated as a successful no-widening assertion.

Inputs must be complete compiled models with known source mode, permission, role, membership, persona and diagnostic
arrays and a settings object. The helper bounds models to 10,000 permissions, arrays/grant cells to 100,000 entries and
parent paths to 64 levels. Both models share a 1,000,000-unit work budget, precharged for array sorting and nested role
lists before expanding grants; repeated references do not bypass it. Invalid shapes or excess bounds fail explicitly.
Projects own requirements such as which roles may access which tables.
