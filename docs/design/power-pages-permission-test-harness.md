# Power Pages Permission Test Harness Specification

Revision 4, 13 October 2026. Implementation companion to [Company Operations Solution Implementation Specification](company-operations-demo.md) and [Dataverse Query and Plugin Behaviour Specification](dataverse-plugin-observation.md). The first document defines business paths; this one defines the single-page runner and three support tables; the third defines incoming-query/pipeline capture and three evidence tables. Implemented sources, commands and qualification limits are in the [project guide](../../examples/company-operations/README.md). Execute only against the task's authorised target.

Provide one visible page with one Run action that reads through Liquid and the portals Web API, compares results, optionally executes a planned CRUD sequence, and records every observation in Dataverse. Use plain text, JSON and expandable diagnostics. No dashboard design, PCF, native business forms or decorative UI is required.

## Currency reference and system dependency

R21 and its Liquid/Web API replicas directly query `pqvd_currencyreference` with the same source-bound fixture IDs, projection and markers on `pqvd_name`. The six existing reference-role trees reach this custom table via dedicated `pqvd_access_currencyreferences` N:N projections. CurrencyReference is Read-only in the portal; prepared C/U/D requests are valid negative tests, not skipped controls. Optional explicit `transactioncurrency` joins are separate query variants and require the existing scoped system-Currency Read grants. Money create/lookup binding still uses the real system `transactioncurrencyid`, never the custom reference GUID. Preserve historical system-root captures and their unobservable backend status separately from the new query-manifest/source hashes. See document 1 for schema/keys/forms and document 3 for the observer/guard cohort.

## Platform facts and parity contract

Liquid FetchXML exposes `queryVariable.results.entities` for records and `queryVariable.xml` for the resultant query used against Dataverse, including how permissions were applied. Capture that XML separately from the authored query; it is not a response document containing the records. Use explicit closing tags inside Liquid FetchXML. [Liquid FetchXML attributes](https://learn.microsoft.com/en-us/power-pages/configure/liquid/template-tags).

The portals Web API supports FetchXML through the `fetchXml` query parameter. The strict paired lane sends the same logical authored FetchXML to `/_api/<entity-set>?fetchXml=<encoded XML>`, with distinct semantically inert correlation literals per physical lane/page/attempt as specified below. Both lanes must have the same logical query hash; physical hashes differ. Supported OData equivalents are additional variants, not replacements for the strict lane. [Portals read operations](https://learn.microsoft.com/en-us/power-pages/configure/read-operations).

The Web API does not document a response field equivalent to Liquid's permission-rewritten XML. Its response diagnostics therefore keep `effectiveFetchXml=null` and `effectiveXmlAvailability="not-exposed"`. Backend plugins supply separately labelled stage-specific `PluginReceivedQuery` artifacts through the operation/event records in document 3. They are not an API response field, not Liquid XML and not physical SQL. Never label submitted XML as executed permission-rewritten XML or feed Liquid's rewritten query into the API lane.

Exact comparison means equal complete canonical rows, row identities, ID sets and counts for the same query, user, dataset and phase. Raw envelopes, transport status, formatted labels, ETags, generated aliases and permission XML need not be byte-identical. Record them without hiding the differences. Web API field exposure and column permissions can create genuine differences from Liquid; those cases are separately classified. [Web API field/column security](https://learn.microsoft.com/en-us/power-pages/configure/web-api-overview), [column-permission boundary](https://learn.microsoft.com/en-us/power-pages/security/column-permissions).

The portals API is a subset of the Dataverse API. Implement bulk CRUD as a bounded queue of individual POST/GET/PATCH/DELETE requests and association probes. Do not depend on Dataverse `$batch`, CreateMultiple, custom actions/functions or direct environment API credentials. Their availability is not established by the cited portal documentation. [Portal API scope](https://learn.microsoft.com/en-us/power-pages/configure/web-api-overview).

## One visible page and shared result structure

Visible route: `/permission-lab/`. Internal data route: `/permission-lab/liquid/`, absent from navigation. Both require an authenticated, explicitly assigned `CO Test Runner` web role. That support role gives no business-table grants. Business visibility still comes from the twelve roles and scoped access records in the first specification.

Use one shell, one shared result renderer and these controls only:

- Suite/scenario selector from the versioned manifest; current Contact and server-observed role names displayed read-only.
- `Run reads` and `Run reads and prepared CRUD`; a single selection starts both engines without navigating elsewhere. Reads are the default.
- Stop button; selected previous run for comparison; export of the currently captured JSON if history saving fails.
- One row per case: case name, Liquid count/IDs, Web API count/IDs, comparison verdict and persistence state. The same JSON layout appears in both lanes. Details expand below that row.

Every detail block presents, in order: confirmation JSON; authored query; Liquid effective query when available; plugin-received Query snapshots by stage/type; raw response/status; field/ID differences; CRUD/context/image/chain steps; and saved observation identifiers/persistence errors. Escape all displayed XML/text. Do not render returned record content as executable markup or put raw XML into `innerHTML`.

The API lane's business data must come only from `/_api` calls, never from the Liquid result, browser preset data or a privileged backend shortcut. Liquid supplies the identity bootstrap and its own read lane; it performs no business writes. Recording both lanes via Web API is expected and is separate from business-query coverage.

## Portal components to create

Own these components in the Company Operations portal project, using discovered export paths/IDs. They are a second increment after the solution structure. Proposed names are stable component names, not assumptions about an existing site's record GUIDs.

| Component | Name / purpose |
| --- | --- |
| Web page and page template | `CO Permission Lab`, route `/permission-lab/`; simple HTML shell and the test JS asset. Default site header may be omitted. |
| Web template | `CO Permission Lab Shell`; renders current Contact/roles, controls and empty result containers; no business query results inserted into the API lane. |
| Web page and page template | `CO Permission Lab Liquid Data`, route `/permission-lab/liquid/`; web-template type, Use Website Header and Footer false. |
| Web template | `CO Permission Lab Liquid Dispatcher`; MIME `application/xml`; checks signed-in user, suite version and allowlisted case ID, then invokes the selected case partial. |
| Case web templates | `CO Query R01` through `CO Query R36`; generated from the same query manifest as the API plans. Each emits summary, typed rows, authored XML, resultant XML and paging metadata. |
| Shared web-template partials | `CO Lab Context`, `CO Lab XML Envelope`, `CO Lab Typed Row`; no arbitrary include names or user-provided raw query execution. |
| Web files | `co-permission-lab.js`, `co-permission-lab.css`, generated `co-query-manifest.json`; static local assets, restrained layout. |
| Website configuration | `CO Test Runner` role; page access rules for shell/data route; instantiated business permission blueprint; recorder/probe permissions below; explicit Web API table/field settings. |

A web template can control the full response and MIME type when its page template omits site header/footer. This permits a clean machine-readable Liquid endpoint. [Web-template response configuration](https://learn.microsoft.com/en-us/power-pages/configure/web-templates).

Use a typed XML envelope for the Liquid transport and JSON for the visible confirmation and saved canonical objects. This uses documented XML escaping instead of assuming a Shopify `jsonify` or undocumented serializer exists on the target site. The browser parses the XML with DOMParser, reads textContent and produces JSON with JSON.stringify. The API lane parses its JSON and uses the same renderer/normalizer. [Liquid escaping filters](https://learn.microsoft.com/en-us/power-pages/configure/liquid/liquid-filters).

## Liquid response contract

Execute one case per endpoint request so a bad query does not destroy the whole suite. One click orchestrates all thirty-six cases; this is still one visible test page. The dispatcher accepts only `suiteVersion`, `caseId`, `page`, an opaque paging continuation and `operationId`. It retrieves that operation through the current Contact's permissions and validates its immutable run/case/lane/table/attempt/markers before execution. Actor/roles come from `user`, not request parameters. Scenario GUID parameters are selected from the fixed synthetic manifest and validated; filter text is XML-escaped. No free-form FetchXML/OData editor.

The logical FetchXML source is generated once per case. It is used independently by Liquid and the API manifest, including attributes, aliases, filters and deterministic ordering. Add the document 3 root marker guard after validating the operation; `operation_marker_utc` and `operation_marker_id` below are validated row values, never raw query-string values. Do not derive the API query from a returned Liquid result. Example contract sketch:

```liquid
{% capture authored_xml %}
<fetch count="50" page="1" returntotalrecordcount="true">
  <entity name="pqvd_equipment">
    <attribute name="pqvd_equipmentid"></attribute>
    <order attribute="pqvd_equipmentid" descending="false"></order>
    <filter type="or">
      <condition attribute="pqvd_name" operator="null"></condition>
      <filter type="and">
        <condition attribute="pqvd_name" operator="ne" value="{{ operation_marker_utc | xml_escape }}"></condition>
        <condition attribute="pqvd_name" operator="ne" value="{{ operation_marker_id | xml_escape }}"></condition>
      </filter>
    </filter>
  </entity>
</fetch>
{% endcapture %}
{% fetchxml visibility_query %}{{ authored_xml }}{% endfetchxml %}
<co-test-response version="1">
  <summary case-id="R09" operation-id="{{ operation_id | xml_escape }}" record-count="{{ visibility_query.results.entities.size }}"></summary>
  <records>
    {% for record in visibility_query.results.entities %}
    <record><id>{{ record.pqvd_equipmentid | xml_escape }}</id></record>
    {% endfor %}
  </records>
  <diagnostics>
    <authored-fetchxml>{{ authored_xml | xml_escape }}</authored-fetchxml>
    <effective-fetchxml>{{ visibility_query.xml | xml_escape }}</effective-fetchxml>
  </diagnostics>
</co-test-response>
```

The actual partial adds Contact GUID, `user.roles`, server render time, suite/case/source hashes, typed selected fields, more-records/cookie/count metadata and correlation ID. `user.roles` supplies the actual website role names as an array; scoped business-role grants are a different snapshot. Store names without assuming they are website role GUIDs. [User role object](https://learn.microsoft.com/en-us/power-pages/configure/liquid/liquid-objects).

Use `<field name="..." type="..." null="true|false">` for scalar/alias values. GUIDs, choices, decimal/money values and dates have declared types from the manifest. Preserve a null indicator; a missing XML element is not silently an empty string. Aliased joins and aggregates have explicit field adapters. The resultant XML is escaped as text and reconstructed exactly once; no repeated HTML/XML decoding.

Do not use local-only `permission_granted`, `global_permission_granted` or similar provider extensions as a Microsoft contract. Record any such local diagnostics separately as implementation-specific. Liquid empty results alone do not prove that a table/row was denied rather than simply absent.

## Web API contract and readiness

FetchXML request shape:

```javascript
const url = `/_api/${casePlan.entitySet}?fetchXml=${encodeURIComponent(authoredXml)}`;
// Use the same authenticated portal session and obtain the CSRF token in memory.
const response = await portalRequest({ method: 'GET', url });
```

Use exported entity-set and navigation names, including `pqvd_employmenttermrecords`. Configure `Webapi/<logical-table>/enabled=true` and comma-separated explicit field lists generated from selected/query/write fields. No `*`. Include keys, filter/order/lookup/alias source fields needed by each case; validate field exposure independently of table permissions. Keep access-role principal fields, identity-provider columns and schema/security administration fields outside ordinary write lists.

Read-only/grant tables may still be API-enabled for explicit negative C/U/D probes, with a small field list; enabling a table is not granting rights. A protected-field probe excluded by field configuration is a configuration-denial result, not evidence of a table-permission denial. Do not expose website configuration tables through `/_api`.

Use `shell.getTokenDeferred()` and the `__RequestVerificationToken` header according to the documented portal request pattern, validate the login session, and never persist tokens/cookies/authorization headers. A POST may return its new GUID in the `entityid` header; do not require a JSON body for successful writes. An empty successful response is distinct from an empty read result. [Portal write patterns](https://learn.microsoft.com/en-us/power-pages/configure/write-update-delete-operations).

Preflight checks session identity, support-table API configuration, history Create/Read/Update, explicit field availability, manifest/source version, known fixture aliases and role-to-web-role mappings. It does not test business writes to decide whether they should be skipped. Reference Currency/Vendor targets needed by permitted money/supplier creates must have separately qualified scoped Read/Append To leaf permissions. Do not add Global reference-table access to make CRUD setup succeed. Missing reference privileges are a recorded dependency/configuration defect; the first document's table-level C alone does not prove all bindings succeed.

## Thirty-six paired read cases

R01–R21 cover every table in the first inventory. Baseline selection is the primary GUID only, with deterministic GUID order and page size 50; use explicit filters for optional named variants. These cases test row visibility with minimal payload. R22–R36 add joins, collisions, aggregates, paging and typed-field comparisons. Expected results come from the independent scenario oracle in the first document, not one engine's output.

| ID | Query name / root table | Required comparison |
| --- | --- | --- |
| R01 | Visible organisations / `account` | Complete visible Account IDs, including intentional profile-leaf visibility; no implicit ancestors. |
| R02 | Contact identity leaves / `contact` | Own Contact enabled by recorder support, plus any separately configured business leaf; no shared-person workforce bridge. |
| R03 | Organisation directory / `pqvd_orgcontact` | Company versus department directory scope under combined roles. |
| R04 | Departments / `pqvd_department` | Branch, department and multi-branch grant sets. |
| R05 | Engagements / `pqvd_employment` | Concurrent own employments and HR/IT/team scope unions. |
| R06 | Private terms / `pqvd_employmentterms` | HR-only terms IDs; other roles disclose no terms records. |
| R07 | Sites / `pqvd_site` | Scoped physical sites. |
| R08 | Buildings / `pqvd_building` | Scoped descendants of permitted sites. |
| R09 | Equipment / `pqvd_equipment` | Own custody, branch scope and read-wide/write-narrow fixtures. |
| R10 | Rooms / `pqvd_room` | Location scope does not become all-equipment Write. |
| R11 | Equipment finance / `pqvd_equipmentfinance` | Cost-record scope separately from equipment visibility. |
| R12 | Assignment history / `pqvd_assignment` | Current/returned assignments for eligible engagements/organisations. |
| R13 | Service requests / `pqvd_servicerequest` | Requester/assignment/equipment paths, including stock requests. |
| R14 | Work orders / `pqvd_workorder` | Request-dependent scope. |
| R15 | Work tasks / `pqvd_worktask` | Deep descendants and team scopes. |
| R16 | Checklist / `pqvd_checklistitem` | Task-dependent scope. |
| R17 | Inspection attempts / `pqvd_inspection` | Repeated verification attempts. |
| R18 | Findings / `pqvd_finding` | Eleven-level deepest endpoints. |
| R19 | Effective access records / `pqvd_accesspermission` | Visible effective grant IDs; generic-grantee root must not multiply role scope. |
| R20 | Role catalogue / `pqvd_accessrole` | Backend-only catalogue remains undisclosed unless an explicit scoped leaf is installed; no Global grant. |
| R21 | Observable currency references / `pqvd_currencyreference` | Only configured scoped custom references; preserve the immutable system-Currency mapping. No Global reference access. |
| R22 | Same-root and sibling filters / `pqvd_equipment` | Apply the same A-RIV/A-HILL/B-LAKE fixture filters; scope cannot be supplied by the caller. |
| R23 | Known permitted GUID / `pqvd_equipment` | One row or oracle-specified absence; exact primary-key filter. |
| R24 | Known outside-scope GUID / `pqvd_equipment` | No data disclosure; absence of data is compared alongside original outcome/status. |
| R25 | Company–membership–engagement join / `pqvd_orgcontact` | Explicit linked engagement GUID alias; canonical tuple identity, not root-only deduplication. |
| R26 | Access-to-Account N:N join / `pqvd_accesspermission` | Grant/Account GUID tuples and distinct variants; inspect emitted permission XML. |
| R27 | Deep Finding through workforce / `pqvd_finding` | Minimal Finding query evaluated through the declared eleven-node permission tree; full provenance blueprint and authorised endpoint IDs. A fully explicit reverse-chain join is a separate stress variant. |
| R28 | Foreign deep Finding / `pqvd_finding` | Same deep shape against the other company's canary ID; no endpoint disclosure. |
| R29 | Secondary equipment-to-service path / `pqvd_servicerequest` | Same relevant service IDs reached by the secondary path; differences in scope remain explicit. |
| R30 | Equipment-finance inner/outer joins / `pqvd_equipment` | Equipment/finance GUID tuples, outer-null preservation and no private-cost disclosure to denied roles. |
| R31 | Equipment counts by Account / `pqvd_equipment` | FetchXML group-by lookup plus distinct equipment count, aliases declared; match group keys and numeric totals. |
| R32 | Employment counts by engagement kind / `pqvd_employment` | Group-by choice counts reflect simultaneous employments and scope. |
| R33 | Multi-page directory / `pqvd_orgcontact` | Page size 5, complete stitched rows and page evidence; detect duplicates/omissions. |
| R34 | Distinct directory names / `pqvd_orgcontact` | Distinct name-only selection ordered by name; rows need scalar identity, not fabricated GUIDs. |
| R35 | Valid empty filter / `pqvd_equipment` | Known nonmatching synthetic value produces success with zero rows, separate from denied/error outcomes. |
| R36 | Typed data and escaping / `pqvd_employmentterms` | Explicit employment join for DateOnly/kind plus salary/day-rate/currency/contract reference; typed normalization and strings containing quotes, ampersands and Unicode. |

Generate complete static FetchXML for each case/variant, including exact attribute/alias lists and link from/to columns from the metadata registry. Primary GUID ordering is used for ordinary rows; joined tuples add relevant alias GUID ordering; aggregates/distinct scalars use their group/selected keys. Cases with no entity IDs use scalar/group row keys and retain `ids=[]` rather than inventing GUIDs. Inner/outer/distinct variants remain separately identified observations.

Additional OData variants are required for R01, R03, R05, R09, R12, R23, R24 and R33, using documented select/filter/order/count/related-record operations where supported. The native single-record R24 can return a different status from a FetchXML collection filtered to the same ID; record both. Do not recursively translate all FetchXML joins/aggregations to `$expand` or silently fall back after an OData failure. Unsupported/query failures are visible results. API-only column-denial/association probes are labelled API-only, not paired Liquid passes.

Dataverse documents a default fifteen-link-entity limit per FetchXML query; Microsoft support can raise the organization-wide QueryLinkEntityLimit. Record the configured or observed budget as scenario provenance, and test its last-success/first-failure boundary separately from the default 15/16 control. A 16-join query is invalid only under the default budget. [Support-managed increases](https://support.microsoft.com/en-au/topic/timeline-does-not-render-and-shows-records-could-not-be-loaded-4ce9200a-1afe-3ef4-ac11-a74b91f4f40c). Record authored, Liquid exposed and plugin stage10/20-early/20-late join counts where available. Avoid duplicating the whole permission chain in every basic deep read. Optional S01 QueryBudget in document 3 varies authored joins and role/permission paths independently, including the 15/16 boundary. A link/URL constraint error is distinct from denied data; a query may be rejected before plugin invocation. Measure encoded URL length; do not assume Dataverse `$batch` is a portal workaround. [FetchXML join limits](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/fetchxml/join-tables).

The baseline IT persona has both workforce and equipment-service routes. Live XML expanded WorkOrder/Task/Checklist/Inspection/Finding to 12/14/16/18/20 links; Checklist onwards fails with 0x8004430d. Preserve those baseline failures. A separately journaled single-route variant temporarily deactivates all six nodes of the secondary equipment-service subtree, leaves the eleven-node workforce path intact, then restores and verifies original content/activation with ETags. Disable leaf-to-root and restore root-to-leaf; sequential changes are not an atomic transaction. It changes stock-service eligibility and must be identified in every run; restore it before collision/stress tests.

The earlier parent-only fault variant is unsafe: with IT-EQUIPMENT-SERVICEREQUEST inactive and its descendants still active, the observed Liquid/API queries returned all 62 Checklist and all 122 Inspection fixture IDs, against independently expected 9 and 17. Both lanes were equal and both failed the scope oracle. Preserve exact queries, native configuration snapshots, backend captures and restoration receipts as a negative regression case; equality does not establish authorization correctness. Normal deployment must reject active permission children beneath inactive parents. Do not use this fault state as an ordinary deep-read qualifier or leave it active.

This website also rejects encoded query strings above its observed approximately 4096-character request limit before Dataverse. Partition oversized nonaggregate, nonDistinct fixture queries by disjoint root-primary GUID sets, identically in both lanes; give every fragment/page its own stamped operation. Retain duplicate multiplicity when merging fragments. Aggregate/Distinct cases remain intact unless their authored merge semantics are explicitly implemented and verified. S01 uses compact filters so URL rejection does not hide the Dataverse link-limit boundary.

## Confirmation JSON and normalization

Both lane renderers produce this shape; GUIDs below are example invented values, not expected fixture IDs:

```json
{
  "caseId": "R09",
  "pairId": "33333333-3333-4333-8333-333333333333",
  "operationId": "44444444-4444-4444-8444-444444444444",
  "logicalQueryHash": "sha256-of-query-without-reserved-markers",
  "physicalQueryHash": "sha256-of-actual-submitted-query",
  "backendCaptureState": "pending",
  "testName": "Equipment visibility",
  "engine": "liquid",
  "variant": "fetchxml",
  "phase": "baseline",
  "outcome": "success",
  "httpStatus": 200,
  "returnedCount": 2,
  "uniqueIdCount": 2,
  "ids": [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222"
  ],
  "complete": true,
  "pages": 1,
  "canonicalHash": "sha256-of-canonical-payload",
  "expectedMatch": true,
  "pairVerdict": "equal",
  "saved": true
}
```

The UI abbreviates long ID arrays with an expandable full JSON block; saved data and comparison never discard rows. Canonical payload includes selected fields, row keys and duplicate multiplicities, not just the ID array. A joined query may have more rows than unique IDs. Aggregate totals are not returned-row count.

Normalize GUIDs to lowercase without braces; choices to integer values, with labels as separate diagnostics; lookups to logical table and GUID; DateOnly to YYYY-MM-DD; timestamps to equivalent UTC instants; decimal/money values to invariant strings using metadata precision. Null, missing and empty string remain distinct unless a documented adapter explicitly maps an omitted FetchXML attribute to null. Do not compare localized formatted labels, JSON property order, ETags or timings as data parity. Sort canonical object keys and query-appropriate row keys before SHA-256.

Canonical comparisons classify: equal, different-IDs, different-fields, different-counts, different-duplicates, different-order where order is asserted, different-outcome, incomplete, unsupported or identity/dataset-drift. A common incorrect result is still a failure against the independent oracle. When Liquid returns an empty collection and API denies a table, preserve both outcomes; an explicit qualified no-disclosure oracle may accept their security behaviour, but do not report strict response parity. Never turn a network/parse/query error into a successful empty array.

Compare XML separately: logical authored-query hashes must agree after removing only the recognized reserved root marker guard under the versioned rule in document 3. Preserve distinct physical hashes and exact submitted/Liquid/plugin artifacts. Compare Liquid XML and received Query snapshots across stages/runs independently. Normalization may ignore formatting/volatile generated alias labels only under a versioned rule and keeps raw originals. XML diagnostics do not prove which role granted a row; expected blueprint provenance and observed data remain separate fields.

## Operation correlation and backend capture

The full three-front runner depends on PluginEvidence and BehaviorPlugins from document 3. Each physical Liquid/API lane, page and attempt first creates `pqvd_testoperation` under the own run. Its returned primary GUID is the operation ID; its immutable server-stamped marker time/values are read back before query construction. A shared pair key identifies the logical counterparts. Persist actual authored intent before sending the request; link each result artifact through `pqvd_testresult.pqvd_operationid`.

Every business FetchXML read includes the null-preserving root primary-name guard from document 3: name != `CO-UTC:<server operation time>` and name != `CO-OP:<operation GUID>`, with an OR-null arm. Account uses name, Contact fullname, Currency currencyname and custom business tables pqvd_name. Both reserved values are absent from the checked synthetic dataset; this is not a generally inert filter on arbitrary live data. Apply the same logical guard in QueryExpression/OData variants. Do not duplicate it on linked entities or alter existing OR precedence. Preserve original/physical query and compare the logical hash with recognized markers removed.

Backend observers capture received Query at declared stages without modifying results. They send durable events to the external collector before acknowledgment; a worker attaches them to the same operation. The header is the technical finding linking client and server evidence, with full payloads in separately owned parts. Plugin captures remain distinct from Liquid's `variable.xml` and Web API response diagnostics. Server event rows are read-only to the runner and do not reuse business `pqvd_finding`.

Wait up to 30 seconds for expected backend artifacts, recording collector-accepted versus Dataverse-persisted status. Capture errors, missing stages, cache/no invocation, rejected-before-pipeline queries and pending worker persistence are visible. Complete data parity with absent required backend evidence yields incomplete three-front coverage. A declared frontend-only mode can still compare the two lanes, labelled explicitly; it cannot satisfy final full-suite acceptance. Query/context evidence can survive rollback only when independently durably captured; an in-transaction logging write is insufficient.

Prepared own-probe PATCHes can trigger P01..P14 from document 3 through `pqvd_activeoperationid`, a changed `pqvd_triggernonce`, allowlisted `pqvd_pluginscenario` and bounded `pqvd_hopbudget`. Add those profiles and S01 QueryBudget to the same selector/page. These controls do not expand business permissions. SDK external/bulk runs are separately identified; no direct portal custom-action/function support is assumed. Depth, rollback and Azure/flow profiles require explicit selection and readiness flags.

## Paging consistency and failure handling

Default page size 50, maximum 20 pages/1,000 rows per case. R33 uses five rows per page. FetchXML count/page and provider paging metadata drive continuation; follow only same-origin continuations for the intended entity set. Native API paging may use nextLink; FetchXML may return cookie/more-record annotations. Qualify exact metadata shape on the target site and retain raw per-page responses. If no usable cookie is available, bounded page-number paging is allowed only where supported; never conclude completion just from the first page.

TotalRecordCount/count annotations can be limited or unavailable. Report returned rows, advertised total and total-limit flags separately. If a bound is reached while more records remain, mark incomplete and do not declare equal complete datasets. Preserve page cookies for synthetic data only and never treat a request token as a paging cookie.

Run both baseline lanes before CRUD. Paired requests are interleaved per case with bounded read concurrency 2; the data fixture must not be modified concurrently by another run. There is no transactional snapshot spanning Liquid/API. Record dataset version and mutation phase; if identity, role snapshot or fixture changes mid-run, stop writes and mark drift. Do not claim a pinned deployed commit from a local source hash.

Unique operation IDs/query marker literals and browser `cache:no-store` avoid browser response reuse and may change query-cache keys; they do not guarantee bypassing portal caches. Record marker-induced cache conditions. Portal data/configuration caches can affect freshness; portal writes invalidate relevant caches, while external changes may take time. Use bounded verification retries (up to 5 attempts over 10 seconds), each with a distinct operation ID, and classify stale/uncertain separately if convergence does not occur. Never automatically clear the whole portal cache. [Server-side caching](https://learn.microsoft.com/en-us/power-pages/admin/clear-server-side-cache).

Each request records HTTP status, MIME type, duration, original error code/body and a classified cause: table/row permission, field exposure, column permission, association, validation/relationship, conflict, configuration, transport, parse or unknown. A 400/403/404 alone is not enough to identify the permission layer. Capture sign-in redirects/HTML login responses as session loss, not empty data. Stop affects new work; aborting a write leaves its commit status unknown until verified.

## Bulk CRUD plan across all business tables

The paired read/CRUD root matrix includes twenty-one business/reference roots, using CurrencyReference as R21. The real system Currency remains a separately inventoried Money dependency and optional explicit linked-table probe. The CRUD matrix includes these twenty-one roots and all four operations. GET is tested in both lanes; POST/PATCH/DELETE use only the portal Web API. A role lacking a privilege still gets a valid prepared negative request. Read-only reference/grant tables remain negative C/U/D cases; no privilege is granted merely to make a control pass.

Prepare `crud-fixtures.json` from the same metadata registry and scenario oracle. Per table it declares valid required-field payloads, allowed parent/currency/vendor/navigation bindings, isolated existing canary GUIDs for Update/Delete, outside-scope canaries, expected privilege/association outcomes and required dependencies. A missing valid payload/dependency is blocked coverage, not a permission pass. Business-rule/uniqueness/Restrict failures are recorded separately from permission denials.

Use preseeded canary records, not returned baseline IDs selected opportunistically. Each table gets an isolated same-scope target and foreign target where meaningful, including safe prepared branch/membership/engagement chains. New keys use the run token and fit the declared lengths. Updates change only `pqvd_name` or standard Account/Contact display fields chosen in the manifest; protected projection/lifecycle fields have separate explicit denial tests. Core record GUIDs, role principals, grant links and standard currencies are never silently rewritten.

CRUD execution per table/target:

1. Save planned request and target classification before sending it.
2. POST with valid fields/bindings; record outcome and new GUID; independently GET when permitted. A readable target and table C do not prove Append/Append To.
3. PATCH the dedicated existing canary; GET through both engines to confirm change or oracle-required nonchange. Test same-scope, outside-scope and read-wide/write-narrow targets.
4. DELETE a dedicated canary; preserve status/body and verify absence or nonchange where visibility permits. All twelve business roles currently have no general Delete, so their expected business Delete outcome is denial. Delete targets have no inbound dependants when the goal is a privilege test; Restrict failures are a separate case.
5. Run paired post-mutation reads only after the previous phase is recorded. Restore mutable values when permitted, record cleanup and residual IDs, and never use elevated browser credentials as an invisible fallback.

Use a write queue with concurrency 1 and explicit dependency order. Bulk is many recorded operations, not an atomic changeset. A failed parent Create blocks dependent writes with the dependency recorded. Retry reads/persistence safely; never blindly retry an uncertain Create/Delete. The run's unique business keys help locate an uncertain created canary before a deliberate retry. Source Append and target Append To tests include split-role grants and outside-scope binds; scope-association writes are explicit negative cases.

No-Delete business roles can leave newly created canaries. Preserve the residual manifest and mark cleanup incomplete; project fixture reset or an explicitly authorised backend cleanup removes them later. BehaviorPlugins adds optional immutable Equipment.pqvd_canaryrunid and pqvd_testrun_canaryequipments. A Delete-only Parent leaf beneath the runner's own Run permits cleanup of that run's guarded CO-CANARY unassigned Stock equipment. Create still requires the business role's own scope, Append and target Append To. Existing equipment has no canary Run and remains outside this deletion path. The disposable probe below provides further successful C/R/U/D controls without changing the business role matrix.

CRUD is enabled only for a prepared synthetic test environment and a selected mutation manifest; it is never triggered on page load. Selecting the prepared CRUD mode and Run is the operator action for that concrete plan. This document itself does not authorise running it against a live reference or real data.

The structure-only first increment does not provide mutable projection/validation automation. Positive Create cases that require maintained Account roots, access intersections or business invariants need those declared dependencies installed before execution; otherwise they are Blocked, not permission failures. When the acting persona cannot read a foreign target, a rejection does not itself prove that the target remained unchanged. Record verification as unobservable and obtain that assertion through a separately authorised fixture-state check; never grant the acting persona extra visibility to verify the negative test.

## Persistent history and disposable probe schema

Add a separate support solution `PaqviloPermissionTestSupport`, depending on Company Operations Core, using `pqvd` and stable IDs. Its three custom organisation-owned tables have standard GUID/name/audit/state fields. Keep history outside the thirty-six business-read cases so saving a result does not alter their counts. Enable auditing; standard createdon/modifiedon are server timestamps, whereas captured/render/client timestamps have their labelled origins.

| Table / entity set | Columns | Keys and relationships |
| --- | --- | --- |
| `pqvd_testrun` / `pqvd_testruns` | `pqvd_name` Text(160)!, `pqvd_runkey` Text(40)!, `pqvd_runnercontactid` L(contact)!, `pqvd_suiteversion` Text(40)!, `pqvd_manifesthash` Text(64)!, `pqvd_datasetversion` Text(80)!, `pqvd_sourcehash` Text(64), `pqvd_environment` Text(80)!, `pqvd_portalversion` Text(40), `pqvd_startedat` Time!, `pqvd_finishedat` Time, `pqvd_runstate` Choice!, `pqvd_rolesnapshot` Multiline(65536)!, `pqvd_grantsnapshot` Multiline(65536), `pqvd_summaryjson` Multiline(65536), `pqvd_baselinerunid` L(pqvd_testrun) | `pqvd_ak_testrun_key` on run key. `pqvd_contact_testruns`: Contact -> run via runner lookup. `pqvd_testrun_baselines`: run -> run via baseline lookup. |
| `pqvd_testresult` / `pqvd_testresults` | `pqvd_name` Text(160)!, `pqvd_runid` L(pqvd_testrun)!, `pqvd_observationkey` Text(64)!, `pqvd_caseid` Text(64)!, `pqvd_variant` Text(40)!, `pqvd_engine` Choice!, `pqvd_phase` Choice!, `pqvd_operation` Choice!, `pqvd_artifactkind` Choice!, `pqvd_attempt` Integer!, `pqvd_pagenumber` Integer!, `pqvd_partnumber` Integer!, `pqvd_partcount` Integer!, `pqvd_httpstatus` Integer, `pqvd_verdict` Choice!, `pqvd_recordcount` Integer, `pqvd_durationms` Integer, `pqvd_capturetime` Time!, `pqvd_contenttype` Text(80)!, `pqvd_payloadtext` Multiline(262144)!, `pqvd_payloadhash` Text(64)!, `pqvd_actorfingerprint` Text(64)! | `pqvd_ak_testresult_part` on run, observation key, artifact kind, part number. `pqvd_testrun_results`: run -> result via run lookup. Required key components only; payload is never indexed. |
| `pqvd_crudprobe` / `pqvd_crudprobes` | `pqvd_name` Text(160)!, `pqvd_token` Text(80)!, `pqvd_ownercontactid` L(contact)!, `pqvd_runid` L(pqvd_testrun)!, `pqvd_value` Text(160), `pqvd_counter` Integer, `pqvd_equipmentid` L(pqvd_equipment) | `pqvd_ak_crudprobe_token` on token. `pqvd_contact_crudprobes`: Contact -> probe. `pqvd_testrun_crudprobes`: run -> probe. Disposable positive-control data, not history. |

All Time columns use UserLocal date/time. Attempts/pages/parts start at 1, duration/count are nonnegative. New 1:N relations use Restrict Delete and Cascade None for Assign/Share/Unshare/Reparent/Merge. The optional `pqvd_equipment_crudprobes` lookup uses RemoveLink Delete, with Assign/Share/Unshare/Reparent/Merge set to NoCascade; deleting a disposable Equipment canary clears the optional probe link. All other lookup Delete policies remain Restrict. The run/result history is not deleted by ordinary users. Probes can be deleted individually before privileged history retention cleanup.

Create global choices with ordered values 183270000 upwards for each independent set:

| Choice | Ordered labels |
| --- | --- |
| `pqvd_runstate` | Running, Completed, Interrupted, Failed, Incomplete |
| `pqvd_engine` | Liquid, WebAPI, Comparator, Recorder |
| `pqvd_phase` | Baseline, CRUD, Verification, Comparison, Cleanup |
| `pqvd_operation` | Read, Create, Update, Delete, Bind, Identity, Compare, Diagnostic |
| `pqvd_artifactkind` | Summary, AuthoredXml, EffectiveXml, Request, RawResponse, CanonicalResult, Comparison, Identity, Cleanup |
| `pqvd_verdict` | Pass, Fail, Incomplete, Unsupported, NotApplicable |

One run contains both engines. Observations identify case/variant/phase/operation/target/attempt/page; observation key is SHA-256 of that stable tuple, distinct from content hash. Artifacts store summary JSON, authored XML, effective Liquid XML, raw response, canonical JSON, CRUD request/result, cleanup or comparison JSON. XML has content type application/xml; JSON application/json; error/plain bodies retain their type.

Encode client artifact transport as a versioned JSON envelope containing UTF-8 base64, original content type, original byte length and SHA-256 of the decoded full artifact. This preserves raw HTTP context URIs: the qualified portal rewrote embedded portal/API URLs in plain incoming text. Chunk the envelope into at most 128,000 UTF-16 code units per part, at Unicode-safe boundaries, below the declared field maximum. Store `application/vnd.paqvilo.artifact+json` as the part content type and the checksum of each stored part in `pqvd_payloadhash`; part count is identical across an artifact's parts. Reassemble in sequence, verify every part checksum, decode UTF-8 strictly and verify original full byte length/hash before comparison. Legacy plain artifacts remain readable with their existing exact checks; do not rewrite history or normalize away drift. An artifact is persisted only when all parts are acknowledged. No silent truncation of XML or result arrays; exceeding the configured run storage bound (default 20 MiB of UTF-8 artifacts, combined client/server in full mode), including transport overhead, is incomplete coverage. Multiline Text supports larger content than ordinary text, but remains bounded. [Dataverse text limits](https://learn.microsoft.com/en-us/power-apps/maker/data-platform/types-of-fields).

TransactionalLab enforces the client transport budget before artifact-part writes and records its configured/used bytes. Full-mode combined client/server quota and late-event reconciliation require the external collector; client accounting alone must not claim enforcement over server captures.

PluginEvidence adds operation/event/node tables without changing these three base tables' ownership. BehaviorPlugins subsequently adds the result-to-operation lookup and four probe trigger columns; their exact schema and relationship names are defined only in document 3. Add an operation subgrid to the run form and operation lookup/trigger controls to `CO Test Result Administration`/`CO CRUD Probe Administration` in that extension solution. The base support solution must remain importable without PluginEvidence.

## History permissions identity and integrity

`CO Test Runner` support role gets these dedicated grants, no Global grants and no business write privileges:

| Permission | Scope / relationship | Privileges |
| --- | --- | --- |
| Own recorder Contact | Self on Contact, with explicit minimal fields | R and Append To for binding own run/probe; no Contact C/U/D. This deliberately adds own-Contact Read to R02. |
| Own test runs | Contact via `pqvd_contact_testruns` | C/R/U/Append/Append To; no D. |
| Results of own runs | Parent via `pqvd_testrun_results` | C/R/U/Append; no D; inherits recorder role. |
| Own disposable probes | Contact via `pqvd_contact_crudprobes` | C/R/U/D/Append; no cross-contact rights. |
| Operations of own runs | Parent via `pqvd_testrun_operations` | C/R/U/Append/Append To; no D. Guard enforces immutable identity and server-owned fields. |
| Events of own operations | Parent via `pqvd_testoperation_events` | R only; no portal event writes. |
| Nodes of own operations | Parent via `pqvd_testoperation_chainnodes` | R only; SDK fixture writes are a separate identity/surface. |

Only bind the runner/probe owner to the signed-in Contact; Self Append To prevents ordinary association to someone else's identity. Result attachment requires permitted run Append To. Future backend checks must also reject moving an observation/probe between runs/actors or editing protected ownership, regardless of UI controls. Probe/run ownership consistency must be qualified with direct association probes; no hidden assumption of ownership enforcement from the field label.

History stores role names rendered from `user.roles`, current Contact, observed scoped grant IDs and versions, capture times and all engine artifacts. Capture identity/roles at run start/end and from each Liquid response; a changed fingerprint marks drift. Grant snapshot is labelled observed/partial if its API read is incomplete; expected fixture grants are separately labelled expected, not observed.

Client-written history is a regression record, not tamper-proof audit attestation. A user who can write their own history can alter their submitted JSON/XML; hashes detect corruption and support diffs, not dishonest authorship. Document 3's collector supplies separately protected, append-only server event evidence and guarded server-owned header fields. It does not cryptographically attest client roles/Contact claims. Preserve standard Dataverse audit timestamps; do not call the role snapshot server-attested merely because the browser obtained it from Liquid. A query marker is correlation, not authentication.

Ordinary history comparison covers the same signed-in Contact's prior runs, including different role configurations. Cross-person comparison requires an explicitly authorised backend export or separately scoped reviewer design; never expose all run results through a company-level parent or Global Read. A mixed-org run can contain records from more than one company and cannot safely be shared just because one company manager can see its author.

## Run orchestration and saving

1. Read shell/endpoint identity context and verify the selected synthetic manifest. Obtain portal CSRF token in memory. Check recorder/probe support separately from business access.
2. Create a Running run with current Contact, role/grant snapshots, hashes, environment/version and clock origins. Confirm its returned GUID/readback. If this fails, block mutations; optional in-memory reads are clearly unsaved.
3. For each read pair/page/attempt, create separate operation stubs, read back IDs/immutable markers and persist authored intents. Call the Liquid endpoint and independently call Web API with their physical queries. Save each lane's artifacts with its operation lookup, then compare complete canonical results with each other and the oracle. Poll/read backend events under that operation and save comparison as its own artifact. Continue after a recorded case failure.
4. When selected, save the CRUD plan, create a distinct operation record for each request, perform the bounded sequence, persist every request/outcome and run post-write paired verification. Prepared probe PATCHes additionally trigger selected plugin profiles and collect context/images/lineage. Recorder/probe operations are support-only, not business successes. Ordinary business CRUD outcomes are client artifacts; pipeline matrix evidence is captured on the explicitly registered Probe/ChainNode test messages.
5. Save cleanup/residual IDs and backend persistence checkpoints, refresh ending identity, persist final summary and run state, then re-read the saved summary. Completed means every planned observation is accounted for and required client/server artifacts are saved; failing tests can still be in a completed run. Incomplete means missing/uncertain evidence or blocked dependencies.

Persistence retries use the unique run/observation/artifact/part keys: check an existing key before resending an uncertain POST. This is client idempotency, not an assumption of portal alternate-key upsert support. Acknowledged result parts are never counted twice. Save failures leave a visible unsaved queue and export; they do not turn a successful read into a saved result. Don't store queues containing synthetic/private results in browser localStorage by default.

Stop/session expiry leaves a partial run with the last saved checkpoint. Resume can retry missing artifact work under its existing operation or retry a read with a new operation ID for the same Contact/manifest/dataset. It does not repeat uncertain mutations automatically. Each physical request attempt retains its stable operation ID, actual returned GUID or unknown-commit state; retries never overwrite earlier captures.

## History comparison and support forms/views

Compare a new run with the selected prior run by suite version, case/variant/phase and scenario. Default requires the same Contact, dataset version, field/normalizer schema and role/grant fingerprint. Explicit role-change comparisons show configuration deltas instead of reporting every expected access change as a regression. Dataset changes are labelled separately.

For each case show added/removed IDs, changed selected fields, duplicate/count/order changes, status/error-class changes, lost/gained CRUD privileges, logical authored-query change, Liquid XML change and backend stage/query/context/image/chain differences. Exclude duration/timestamps/generated canary and operation GUIDs from stable semantic equality, but retain raw values as diagnostics. Generated mutation records compare by stable manifest alias/operation token, with actual GUIDs recorded. XML absence is not an empty XML document. Backend alias/volatile-field normalization is versioned; it never removes permission filters or joins.

Create `CO Test Run Administration` (identity/configuration/summary and result subgrid), `CO Test Result Administration` (metadata and payload text), and `CO CRUD Probe Administration`. Views: `CO Test Runs Recent` sorted createdon descending/ID; `CO Test Runs Incomplete` by runstate; `CO Results By Case` sorted case/engine/phase/page/part; `CO Failed Test Results` by verdict; `CO Outstanding CRUD Probes` by token. Adjust custom-table Lookup/Quick Find to name/run key/case/token only. No search indexes over payloads, no portal Basic Forms and no public all-runs view.

## Implementation acceptance checks

Deliver the page/data endpoint/assets and source-generated query/CRUD manifests, the three-table support solution, website-bound permission records for the declared consumer site, and project-owned tests. Do not run a private/live acceptance plan without separate authorisation.

- Every business table has a paired read and a declared C/R/U/D outcome; all thirty-six cases use independent queries/results. The two lanes share presentation and comparison only.
- XML fixtures verify authored XML versus `variable.xml`, explicit FetchXML closing tags, escaped quotes/ampersands/Unicode, missing/null values and absence of fake Web API effective XML.
- Positive/denied/empty/error/incomplete/session-loss outcomes stay distinct. Both-wrong parity fails the oracle. Aggregates/join tuples/paging preserve their own row identities and multiplicities.
- Run the sixteen multi-org/role scenarios from the first document, with the full eleven-node path and short alternative paths. Verify HR-A/IT-B, wide Read/narrow Write, shared Contact isolation and no Global grants.
- CRUD requests use valid isolated fixtures and record association/validation/configuration failures separately. Business Delete denials and successful own-probe Delete are both covered. Outside-scope/other-contact writes cannot modify state.
- Recorder isolation tests prohibit reading/updating another Contact's runs/results/probes and moving ownership. Save failure, duplicate retry, interruption, chunk reconstruction, storage bounds and unknown mutation commit are tested.
- Re-open a saved run and reproduce its paired diffs, role/configuration snapshots, Liquid XML and CRUD results without rerunning the business queries. All artifacts have complete hashes/parts and request tokens are absent.
- Full-suite acceptance additionally verifies distinct paired/page/retry operation IDs, null-preserving query markers, immutable/server-owned fields, complete durable backend captures, S01 query-budget evidence and selected plugin context/chain profiles from document 3. Collector absence cannot be reported as a full three-front pass.
- Verify supported feature/paging/column/caching behaviour on the actual target site and record its version. Local Mirage success is separate evidence, not proof of live parity. Runtime changes require meaningful regressions and `npm run validate`; business tests stay in the project.

Ready for implementation of the minimal harness. The first model's no-general-Delete policy remains intact, API unsupported capabilities are not assumed, and the one-page flow captures both result lanes, query diagnostics, CRUD outcomes and durable history together.

Source5 binding qualification adds two disposable cohorts, after the source4 lease is restored. Equipment Append rebinds a Stock canary to a second Room in the same Building and Account; its canary Run and current assignment stay unchanged. Equipment AppendTo uses an owned CRUD Probe as the cooperating child and the optional equipment lookup. The existing Test Runner probe grant supplies child Write/Append rights; the Equipment leaf supplies the tested AppendTo right. Both actual target GUIDs, logical lookup/navigation, Run, actor and original child-root context are sealed before capture. Portal requests perform a real change to a second target and restore the original binding using conditional trusted maintenance. Missing source rights, target rights, fields, business invariants and server-side context remain distinct outcomes.

Source5 is an **undeployed** upgrade of the Source4 Variant column from40 to128 characters: even `TARGET:<GUID>` needs43. The immutable SDK-created intent for Append uses case `PORTAL-EQUIPMENT-APPEND` and variant `TARGET:<equipment GUID>;ROOM:<desired Room GUID>`; AppendTo uses `PORTAL-EQUIPMENT-APPENDTO` and `TARGET:<Probe GUID>;EQUIPMENT:<desired Equipment GUID>`. Direct Equipment CRUD retains `PORTAL-EQUIPMENT-CRUD` and `TARGET:<equipment GUID>`. Counterparts come from actual owned fixture bindings, never mutable authored-query/client-summary fields. Keep `allowOwnedEquipmentLookupTests` false by default; enable it only in the isolated Source5 qualification cohort after the metadata/image upgrade. Preserve the historical Source4 schema/manifests/recordings, and use `prepare-schema.mjs --out` for a separate Source5 plan. These source plans confer no native permission coverage.

## Separate query-admission qualification

Keep authored-query admission, permission expansion, Dataverse execution and wire transport as separate phases. The [documented FetchXML join limit](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/fetchxml/join-tables) is fifteen; the documentation also describes subquery link types, but does not establish that every XML `link-entity` is counted identically in every platform version. A captured final query with eighteen XML links can therefore contradict a simulator's raw-link count without establishing a universal replacement rule.

The project module `portal-harness/query-budget-probes.mjs` declares a separate 172-cell discriminator domain requiring 344 independently repeated native observations. Its 31 authored controls cover `any`, `not any`, `all`, `not all`, ordinary siblings and descendants, nested quantifiers, and the fifteen/sixteen boundary. Each runs through Liquid and Web API under two independently frozen graphs: the original scoped source and an isolated temporary Global **Read-only** root control. This temporary graph is a reversible qualification lease, not an additional grant on the business lattice. Self-primary-key joins bind an actual nonempty native fixture partition and avoid invented relationship metadata. The single-quantifier positive controls verify row semantics before a limit observation receives credit.

Forty-eight further API cells vary authored join count, harmless XML whitespace and equivalent percent-space/form-space URI encoding independently. An additional eight scalar OData transport cells use a separately witnessed positive root and harmless filter whitespace, requiring sixteen independent repeated observations. Preserve these eight cells, the 172-cell budget domain, the original authored OData cases and the corrected metadata-bound OData cases as separate denominators. None is qualified by materialization or a local-only pass.

Record raw URI characters/UTF-8 bytes, decoded authored XML/filter size, and actual incoming SDK XML size when present. Percent-encoded and double-encoded incoming XML sizes are diagnostic estimates of possible downstream representations; they are not evidence of an actual downstream URI. A missing SDK callback supplies no received-XML length. HTTP 414, HTTP 400 CDS admission and HTTP 500 authored-query failures must remain distinct even when they occur on adjacent join counts. In particular, do not infer a universal external URI limit from one FetchXML sequence while a longer scalar request reaches CDS admission.

Every cell requires unchanged schema, raw graph, memberships, actor fields, fixture rows/versions, site settings/source and observer registrations; both cache-clear receipts; a nonempty SDK-observed positive control on the same root/lane/profile; exact authored input and native HTTP outcome; original checksummed query artifacts or a separately qualified no-backend receipt; and two independent stable native repeats. The [documented multi-level table-permission OData issue](https://learn.microsoft.com/en-us/power-pages/configure/web-api-overview) chooses discriminator cohorts rather than proving an admission predicate. Direct scopes, one-level/reverse/N:N parents, deep 1:N paths, same-table wrappers and Global/scoped unions need their own source-bound native evidence. Simulator settings that change admission or budget accounting remain explicit observed profiles until these controls establish the relevant site/version contract.
