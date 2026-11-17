# Company Operations example: permission harness

Design of the single-page permission harness for the [Company Operations model](company-operations-demo.md), with
backend evidence from the [plug-in observations](dataverse-plugin-observation.md). Commands, deployment and replay tools
are in the [harness guide](../../examples/company-operations/portal-harness/README.md).

The page compares Liquid and portal Web API results for the signed-in Contact, optionally runs prepared CRUD, and saves
observations in Dataverse. Run it only against an explicitly authorized fixture environment. A completed run is not a
permission pass: only the independent scenario oracle decides. The **Persistent history and disposable probe schema**
section is parsed by `prepare-schema.mjs`; keep its heading and table rows exact.

## Platform facts and parity contract

- Liquid FetchXML exposes `results.entities` and `xml`, the permission-rewritten query actually sent to Dataverse. It is
  captured separately from the authored query and is not a response document
  ([Liquid FetchXML](https://learn.microsoft.com/en-us/power-pages/configure/liquid/template-tags)).
- The portal Web API accepts FetchXML through `/_api/<entity-set>?fetchXml=<encoded>`
  ([read operations](https://learn.microsoft.com/en-us/power-pages/configure/read-operations)). The strict lane sends the
  same logical FetchXML as Liquid; OData forms are additional variants, never replacements.
- The Web API exposes no equivalent of Liquid's rewritten XML, so its diagnostics record `effectiveFetchXml=null` and
  `effectiveXmlAvailability="not-exposed"`. Plug-in `PluginReceivedQuery` artifacts are labelled separately; they are
  neither an API field, nor Liquid XML, nor SQL. Never feed Liquid's rewritten query into the API lane.
- The portal API is a subset of the Dataverse API. Bulk CRUD is a bounded queue of individual requests; no `$batch`,
  CreateMultiple, custom actions or direct environment credentials.
- Exact comparison means equal canonical rows, row identities, ID sets and counts for the same query, user, dataset and
  phase. Raw envelopes, status text, formatted labels, ETags, generated aliases and permission XML may differ and are
  recorded, not hidden. Web API field exposure and column permissions can produce genuine differences from Liquid; those
  cases are classified separately ([Web API settings](https://learn.microsoft.com/en-us/power-pages/configure/web-api-overview)).

## Page, routes and components

Visible route `/permission-lab/`; internal data route `/permission-lab/liquid/`, absent from navigation. Both require an
authenticated Contact with the explicitly assigned `CO Test Runner` role, which carries no business grants: business
visibility comes only from the twelve roles and scoped access rows.

| Component                  | Name / purpose                                                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Web page and page template | `CO Permission Lab`, `/permission-lab/`, inside the site header and footer.                                                                            |
| Web template               | `CO Permission Lab Shell`: current Contact and roles, controls, result containers, inline script and query manifest. No business results are inserted. |
| Web page and page template | `CO Permission Lab Liquid Data`, `/permission-lab/liquid/`, without the site header and footer.                                                        |
| Web template               | `CO Permission Lab Liquid Dispatcher`, MIME `application/xml`: checks the runner, suite version and allowlisted case, then includes the case partial.  |
| Case web templates         | `CO Query R01` to `CO Query R36`, generated from the same plans as the API lane.                                                                       |
| Website configuration      | Page access rules, the permission blueprint, recorder permissions and explicit `Webapi/<table>/enabled` and `/fields` settings.                        |

A page template without the site header and footer lets a web template control the whole response and MIME type, which
gives a clean machine-readable endpoint
([web templates](https://learn.microsoft.com/en-us/power-pages/configure/web-templates)). Liquid transport is a typed
XML envelope built with documented `xml_escape`, not an assumed JSON serializer; the browser parses it with DOMParser
and both lanes share one renderer and normalizer. Displayed XML and record content are escaped text, never `innerHTML`.

The API lane's business data comes only from `/_api` calls, never from the Liquid result or a privileged backend. Liquid
supplies the identity bootstrap and its own read lane and performs no business writes.

## Liquid response contract

One case per endpoint request, so a bad query does not destroy the suite. The dispatcher accepts only `suiteVersion`,
`caseId`, `page`, a paging continuation and `operationId`; it loads that operation through the Contact's own
permissions and validates its run, owner, lane, page and markers before executing. Actor and roles come from `user`,
never from parameters. There is no free-form FetchXML or OData editor.

```liquid
{% fetchxml visibility_query %}{{ authored_xml }}{% endfetchxml %}
<co-test-response version="1">
  <summary case-id="R09" operation-id="{{ operation_id | xml_escape }}" record-count="{{ visibility_query.results.entities.size }}"></summary>
  <records>{% for record in visibility_query.results.entities %}<record>...</record>{% endfor %}</records>
  <diagnostics>
    <authored-fetchxml>{{ authored_xml | xml_escape }}</authored-fetchxml>
    <effective-fetchxml>{{ visibility_query.xml | xml_escape }}</effective-fetchxml>
  </diagnostics>
</co-test-response>
```

Scalars are `<field name type null>` elements typed from the manifest; a missing element is never an empty string.
`user.roles` gives website role names (not GUIDs); scoped business grants are a separate snapshot. Use explicit closing
tags inside Liquid FetchXML. Local-only extensions such as `permission_granted` are not a Microsoft contract.

## Web API contract

Use exported entity-set and navigation names (for example `pqvd_employmenttermrecords`) and explicit
`Webapi/<table>/fields` lists generated from each case's selected, filtered, ordered and written fields; never `*`.
Access-role principals, identity-provider columns and schema administration fields stay out of write lists. Read-only
and grant tables may be API-enabled for negative C/U/D probes: enabling a table grants nothing, and a field-configuration
denial is not a table-permission denial. Website configuration tables are never exposed.

Requests use `shell.getTokenDeferred()` and the `__RequestVerificationToken` header; tokens, cookies and authorization
headers are never persisted. A successful POST returns the new GUID in the `entityid` header; without it the commit is
recorded as unknown ([write operations](https://learn.microsoft.com/en-us/power-pages/configure/write-update-delete-operations)).

Preflight checks session identity, support-table API configuration, history Create/Read/Update, field exposure,
manifest version, fixture aliases and role mappings. It never tests business writes to decide whether to skip them.
Missing reference privileges (Currency, Vendor) are recorded as a configuration defect; never add Global access.

## Thirty-six paired read cases

R01–R21 cover every business and reference table, selecting the primary GUID only in GUID order with page size 50.
R22–R36 add joins, collisions, aggregates, paging and typed fields. Expected results come from the scenario oracle,
never from either engine.

| ID  | Query name / root table                                     | Required comparison                                                                                                                                                                                        |
| --- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R01 | Visible organisations / `account`                           | Complete visible Account IDs, including intentional profile-leaf visibility; no implicit ancestors.                                                                                                        |
| R02 | Contact identity leaves / `contact`                         | Own Contact enabled by recorder support, plus any separately configured business leaf; no shared-person workforce bridge.                                                                                  |
| R03 | Organisation directory / `pqvd_orgcontact`                  | Company versus department directory scope under combined roles.                                                                                                                                            |
| R04 | Departments / `pqvd_department`                             | Branch, department and multi-branch grant sets.                                                                                                                                                            |
| R05 | Engagements / `pqvd_employment`                             | Concurrent own employments and HR/IT/team scope unions.                                                                                                                                                    |
| R06 | Private terms / `pqvd_employmentterms`                      | HR-only terms IDs; other roles disclose no terms records.                                                                                                                                                  |
| R07 | Sites / `pqvd_site`                                         | Scoped physical sites.                                                                                                                                                                                     |
| R08 | Buildings / `pqvd_building`                                 | Scoped descendants of permitted sites.                                                                                                                                                                     |
| R09 | Equipment / `pqvd_equipment`                                | Own custody, branch scope and read-wide/write-narrow fixtures.                                                                                                                                             |
| R10 | Rooms / `pqvd_room`                                         | Location scope does not become all-equipment Write.                                                                                                                                                        |
| R11 | Equipment finance / `pqvd_equipmentfinance`                 | Cost-record scope separately from equipment visibility.                                                                                                                                                    |
| R12 | Assignment history / `pqvd_assignment`                      | Current/returned assignments for eligible engagements/organisations.                                                                                                                                       |
| R13 | Service requests / `pqvd_servicerequest`                    | Requester/assignment/equipment paths, including stock requests.                                                                                                                                            |
| R14 | Work orders / `pqvd_workorder`                              | Request-dependent scope.                                                                                                                                                                                   |
| R15 | Work tasks / `pqvd_worktask`                                | Deep descendants and team scopes.                                                                                                                                                                          |
| R16 | Checklist / `pqvd_checklistitem`                            | Task-dependent scope.                                                                                                                                                                                      |
| R17 | Inspection attempts / `pqvd_inspection`                     | Repeated verification attempts.                                                                                                                                                                            |
| R18 | Findings / `pqvd_finding`                                   | Eleven-level deepest endpoints.                                                                                                                                                                            |
| R19 | Effective access records / `pqvd_accesspermission`          | Visible effective grant IDs; generic-grantee root must not multiply role scope.                                                                                                                            |
| R20 | Role catalogue / `pqvd_accessrole`                          | Backend-only catalogue remains undisclosed unless an explicit scoped leaf is installed; no Global grant.                                                                                                   |
| R21 | Observable currency references / `pqvd_currencyreference`   | Only configured scoped custom references; preserve the immutable system-Currency mapping. No Global reference access.                                                                                      |
| R22 | Same-root and sibling filters / `pqvd_equipment`            | Apply the same A-RIV/A-HILL/B-LAKE fixture filters; scope cannot be supplied by the caller.                                                                                                                |
| R23 | Known permitted GUID / `pqvd_equipment`                     | One row or oracle-specified absence; exact primary-key filter.                                                                                                                                             |
| R24 | Known outside-scope GUID / `pqvd_equipment`                 | No data disclosure; absence of data is compared alongside original outcome/status.                                                                                                                         |
| R25 | Company–membership–engagement join / `pqvd_orgcontact`      | Explicit linked engagement GUID alias; canonical tuple identity, not root-only deduplication.                                                                                                              |
| R26 | Access-to-Account N:N join / `pqvd_accesspermission`        | Grant/Account GUID tuples and distinct variants; inspect emitted permission XML.                                                                                                                           |
| R27 | Deep Finding through workforce / `pqvd_finding`             | Minimal Finding query evaluated through the declared eleven-node permission tree; full provenance blueprint and authorised endpoint IDs. A fully explicit reverse-chain join is a separate stress variant. |
| R28 | Foreign deep Finding / `pqvd_finding`                       | Same deep shape against the other company's canary ID; no endpoint disclosure.                                                                                                                             |
| R29 | Secondary equipment-to-service path / `pqvd_servicerequest` | Same relevant service IDs reached by the secondary path; differences in scope remain explicit.                                                                                                             |
| R30 | Equipment-finance inner/outer joins / `pqvd_equipment`      | Equipment/finance GUID tuples, outer-null preservation and no private-cost disclosure to denied roles.                                                                                                     |
| R31 | Equipment counts by Account / `pqvd_equipment`              | FetchXML group-by lookup plus distinct equipment count, aliases declared; match group keys and numeric totals.                                                                                             |
| R32 | Employment counts by engagement kind / `pqvd_employment`    | Group-by choice counts reflect simultaneous employments and scope.                                                                                                                                         |
| R33 | Multi-page directory / `pqvd_orgcontact`                    | Page size 5, complete stitched rows and page evidence; detect duplicates/omissions.                                                                                                                        |
| R34 | Distinct directory names / `pqvd_orgcontact`                | Distinct name-only selection ordered by name; rows need scalar identity, not fabricated GUIDs.                                                                                                             |
| R35 | Valid empty filter / `pqvd_equipment`                       | Known nonmatching synthetic value produces success with zero rows, separate from denied/error outcomes.                                                                                                    |
| R36 | Typed data and escaping / `pqvd_employmentterms`            | Explicit employment join for DateOnly/kind plus salary/day-rate/currency/contract reference; typed normalization and strings containing quotes, ampersands and Unicode.                                    |

Each case is complete static FetchXML generated from the metadata registry. Joined tuples order by the relevant alias
GUIDs; aggregates and distinct scalars use their group or selected keys and keep `ids=[]` rather than invented GUIDs.
Inner, outer and distinct variants are separate observations.

R01, R03, R05, R09, R12, R23, R24 and R33 also have OData variants. A native single-record R24 can return a different
status from a FetchXML collection filtered to the same ID; both are recorded. FetchXML joins are never translated
recursively to `$expand`, and an OData failure never falls back silently.

**Join budget.** Dataverse documents a default limit of fifteen link entities per FetchXML query, which Microsoft
support can raise per organization ([join limits](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/fetchxml/join-tables)).
Record the budget as scenario provenance and the authored, Liquid-exposed and plug-in stage join counts. A link or URL
error is distinct from denied data, and a query can be rejected before any plug-in runs.

**Deep variant.** The baseline IT persona has both the workforce and equipment-service routes, so permission expansion
pushes its deep reads over the default budget from Checklist onwards (`0x8004430d`). That is an expected outcome, not a
defect to work around. The single-route variant deactivates the six-node secondary subtree, leaves the eleven-node path
intact and restores it afterwards; it changes stock-service eligibility, so every run records it, and it is restored
before collision and stress tests.

**Never deactivate only a parent permission.** With a parent inactive and its descendants active, both lanes can return
every fixture row of the descendant tables and agree with each other while both fail the oracle. Deployment rejects
active children beneath inactive parents.

**Long URLs.** Portals can reject long encoded query strings before Dataverse sees them. Non-aggregate, non-distinct
queries whose encoded FetchXML exceeds 3,500 characters are split into disjoint root-GUID sets, identically in both
lanes, each fragment with its own operation; merges keep duplicate multiplicity. S01 uses compact filters so URL
rejection cannot hide the link-limit boundary.

## Normalization and verdicts

GUIDs are lowercase without braces; choices are integer values (labels are diagnostics); lookups are table plus GUID;
DateOnly is `YYYY-MM-DD`; timestamps are UTC instants; decimals and money are invariant strings at metadata precision.
Null, missing and empty string stay distinct. Labels, JSON property order, ETags and timings are not data. The canonical
payload includes selected fields, row keys and duplicate multiplicities, not just IDs: a joined query can have more rows
than unique IDs.

Verdicts: equal, different IDs, fields, counts, duplicates or order (where order is asserted), different outcome,
incomplete, unsupported, or identity/dataset drift. A result both lanes share can still fail the oracle. When Liquid
returns empty and the API denies the table, both outcomes are kept and strict parity is not reported. A network, parse
or query error never becomes an empty array; a sign-in redirect is session loss.

Authored-query hashes agree after removing only the reserved marker guard; physical hashes, submitted, Liquid and plug-in
artifacts are kept raw. XML diagnostics do not prove which role granted a row.

## Operation correlation

Each physical Liquid or API request, page and attempt first creates its own `pqvd_testoperation` under the run, reads
back the server-stamped marker values and persists the authored intent before sending anything. A pair key links the two
lanes; results link through `pqvd_testresult.pqvd_operationid`. Every business read carries the null-preserving root
primary-name guard from the plug-in design (`name != CO-UTC:<time>` and `name != CO-OP:<GUID>`, or null). The reserved
values are absent from the synthetic dataset; the guard is not inert on arbitrary live data.

Plug-in captures in `TransactionalLab` mode are transaction-bound and can roll back with a failed request; only the
external collector can make them durable. A frontend-only run can still compare the two lanes, labelled as such, but
missing backend evidence makes three-front coverage incomplete.

Prepared own-probe PATCHes trigger plug-in profiles through `pqvd_activeoperationid`, `pqvd_triggernonce`,
`pqvd_pluginscenario` and `pqvd_hopbudget`; these controls expand no business permission.

## Paging and caching

Default page size 50, at most 20 pages per case; R33 uses five rows per page. Continuation follows FetchXML paging
metadata or same-origin `nextLink` only; completion is never concluded from the first page, and hitting the bound with
more records remaining is incomplete. Advertised totals are reported separately from returned rows.

There is no snapshot spanning the two lanes: nothing else may modify the fixture during a run, and a change of identity,
role snapshot or fixture mid-run stops writes and marks drift. Unique markers and `cache: no-store` avoid browser reuse
but do not guarantee bypassing portal caches; the harness never clears the whole portal cache automatically
([server-side caching](https://learn.microsoft.com/en-us/power-pages/admin/clear-server-side-cache)). Each request
records status, MIME type, duration, original error and a classified cause; a 400/403/404 alone does not identify the
permission layer.

## Bulk CRUD

The CRUD matrix covers the 21 read roots and all four operations. GET runs in both lanes; POST, PATCH and DELETE use only
the Web API. A role without a privilege still gets a valid prepared negative request; nothing is granted to make a
control pass. The catalogue's `crudFixtures` declare per table the valid payloads, allowed bindings, isolated same-scope
and foreign canary targets, expected outcomes and dependencies; a missing payload or dependency is Blocked coverage,
never a pass.

Writes run one at a time in dependency order, each saved before it is sent. Updates change only declared display
fields; protected projection and lifecycle fields have their own denial tests. Business Delete is expected to be denied
for every business role; successful Delete is covered by the runner's own probes and by guarded `CO-CANARY-` Stock
equipment under the run's own Delete-only leaf. Uncertain Create or Delete is never retried blindly; residual canaries
are recorded and cleanup marked incomplete. When the actor cannot read a foreign target, a rejection does not prove the
target is unchanged: that check needs a separately authorized fixture read, never extra visibility for the actor.

CRUD runs only for a prepared synthetic environment when the operator selects it; never on page load. Positive Creates
that need maintained roots, projections or invariants are Blocked until those services exist.

## Persistent history and disposable probe schema

`PaqviloPermissionTestSupport` depends on Core and holds three organisation-owned tables outside the read cases, so
saving a result never changes their counts. All Time columns are UserLocal; attempts, pages and parts start at 1.

| Table / entity set                     | Columns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Keys and relationships                                                                                                                                                                       |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pqvd_testrun` / `pqvd_testruns`       | `pqvd_name` Text(160)!, `pqvd_runkey` Text(40)!, `pqvd_runnercontactid` L(contact)!, `pqvd_suiteversion` Text(40)!, `pqvd_manifesthash` Text(64)!, `pqvd_datasetversion` Text(80)!, `pqvd_sourcehash` Text(64), `pqvd_environment` Text(80)!, `pqvd_portalversion` Text(40), `pqvd_startedat` Time!, `pqvd_finishedat` Time, `pqvd_runstate` Choice!, `pqvd_rolesnapshot` Multiline(65536)!, `pqvd_grantsnapshot` Multiline(65536), `pqvd_summaryjson` Multiline(65536), `pqvd_baselinerunid` L(pqvd_testrun)                                                                                                                       | `pqvd_ak_testrun_key` on run key. `pqvd_contact_testruns`: Contact -> run via runner lookup. `pqvd_testrun_baselines`: run -> run via baseline lookup.                                       |
| `pqvd_testresult` / `pqvd_testresults` | `pqvd_name` Text(160)!, `pqvd_runid` L(pqvd_testrun)!, `pqvd_observationkey` Text(64)!, `pqvd_caseid` Text(64)!, `pqvd_variant` Text(40)!, `pqvd_engine` Choice!, `pqvd_phase` Choice!, `pqvd_operation` Choice!, `pqvd_artifactkind` Choice!, `pqvd_attempt` Integer!, `pqvd_pagenumber` Integer!, `pqvd_partnumber` Integer!, `pqvd_partcount` Integer!, `pqvd_httpstatus` Integer, `pqvd_verdict` Choice!, `pqvd_recordcount` Integer, `pqvd_durationms` Integer, `pqvd_capturetime` Time!, `pqvd_contenttype` Text(80)!, `pqvd_payloadtext` Multiline(262144)!, `pqvd_payloadhash` Text(64)!, `pqvd_actorfingerprint` Text(64)! | `pqvd_ak_testresult_part` on run, observation key, artifact kind, part number. `pqvd_testrun_results`: run -> result via run lookup. Required key components only; payload is never indexed. |
| `pqvd_crudprobe` / `pqvd_crudprobes`   | `pqvd_name` Text(160)!, `pqvd_token` Text(80)!, `pqvd_ownercontactid` L(contact)!, `pqvd_runid` L(pqvd_testrun)!, `pqvd_value` Text(160), `pqvd_counter` Integer, `pqvd_equipmentid` L(pqvd_equipment)                                                                                                                                                                                                                                                                                                                                                                                                                              | `pqvd_ak_crudprobe_token` on token. `pqvd_contact_crudprobes`: Contact -> probe. `pqvd_testrun_crudprobes`: run -> probe. Disposable positive-control data, not history.                     |

New 1:N relationships use Restrict Delete and NoCascade otherwise. The optional Source5 `pqvd_equipment_crudprobes`
lookup is absent from the committed manifest and uses RemoveLink Delete. Ordinary users never delete runs or results;
probes can be deleted individually.

Global choices, values from 183270000 upwards:

| Choice              | Ordered labels                                                                                           |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| `pqvd_runstate`     | Running, Completed, Interrupted, Failed, Incomplete                                                      |
| `pqvd_engine`       | Liquid, WebAPI, Comparator, Recorder                                                                     |
| `pqvd_phase`        | Baseline, CRUD, Verification, Comparison, Cleanup                                                        |
| `pqvd_operation`    | Read, Create, Update, Delete, Bind, Identity, Compare, Diagnostic                                        |
| `pqvd_artifactkind` | Summary, AuthoredXml, EffectiveXml, Request, RawResponse, CanonicalResult, Comparison, Identity, Cleanup |
| `pqvd_verdict`      | Pass, Fail, Incomplete, Unsupported, NotApplicable                                                       |

An observation key is the SHA-256 of the stable case/variant/phase/operation/target/attempt/page tuple, distinct from
the content hash. Client artifacts are stored as a versioned JSON envelope (`application/vnd.paqvilo.artifact+json`)
holding UTF-8 base64, the original content type, byte length and SHA-256, because the portal can rewrite raw HTTP
context URIs that arrive as plain text. The envelope is chunked at Unicode-safe boundaries into parts of at most
128,000 UTF-16 code units, each with its own checksum in `pqvd_payloadhash`; reassembly verifies every part and the full
artifact. An artifact counts as persisted only when all parts are acknowledged. Exceeding the run's transport budget
(default 20 MiB) is incomplete coverage, never silent truncation
([text limits](https://learn.microsoft.com/en-us/power-apps/maker/data-platform/types-of-fields)).

PluginEvidence adds operation, event and node tables, and BehaviorPlugins adds the result-to-operation lookup and the
probe trigger columns; the base support solution stays importable without them.

## History permissions and integrity

`CO Test Runner` rights are listed in the [portal security guide](../../examples/company-operations/portal-security/README.md);
none are Global and none write business data. Own-Contact Self Read deliberately adds the recorder's Contact to R02.
Binding guards reject moving an observation or probe between runs or actors.

Client-written history is a regression record, not tamper-proof audit: a user who can write their history can alter it,
and hashes detect corruption, not dishonest authorship. The collector supplies separately protected server events but
does not attest client roles or Contact claims. Comparison covers one Contact's own runs; cross-person comparison needs a
separately authorized backend export, never a company-level parent or Global Read.

Persistence retries check the unique run/observation/artifact/part key before resending an uncertain POST (client
idempotency, not portal upsert). Save failures leave a visible unsaved queue and export; results are not stored in
`localStorage`. Resume retries missing artifact work under the existing operation or a read under a new operation, and
never repeats uncertain mutations.

## History comparison

A new run is compared with a selected prior run by suite version, case, variant, phase and scenario, requiring by default
the same Contact, dataset version, normalizer and role/grant fingerprint; role-change comparisons show configuration
deltas instead of regressions. Durations, timestamps, generated canary and operation GUIDs are excluded from semantic
equality but kept as diagnostics. Missing XML is not an empty XML document.

## Source5 binding cohort

Run after the Source4 lease is restored, with `allowOwnedEquipmentLookupTests` enabled only for this cohort. Equipment
Append rebinds a Stock canary to a second Room in the same Building and Account; Equipment AppendTo binds an owned CRUD
probe to the equipment through the optional lookup. The SDK-created intent uses case `PORTAL-EQUIPMENT-APPEND` with
variant `TARGET:<equipment GUID>;ROOM:<Room GUID>`, or `PORTAL-EQUIPMENT-APPENDTO` with
`TARGET:<Probe GUID>;EQUIPMENT:<Equipment GUID>`; direct equipment CRUD keeps `PORTAL-EQUIPMENT-CRUD` and
`TARGET:<equipment GUID>`. Counterparts come from actual owned fixture bindings, never from client-writable fields.
Missing source rights, target rights, fields, invariants and server context stay distinct outcomes.

## Separate query-admission qualification

Authored-query admission, permission expansion, Dataverse execution and wire transport are separate phases. The
documented join limit is fifteen, but the documentation does not establish that every XML `link-entity` counts the same
in every platform version, so a captured final query with eighteen links can contradict a raw-link count without
establishing a replacement rule.

`portal-harness/query-budget-probes.mjs` declares a 172-cell discriminator domain needing 344 independent repeated
native observations: 31 authored controls (`any`, `not any`, `all`, `not all`, siblings, descendants, nested
quantifiers and the 15/16 boundary) through Liquid and the Web API under the original scoped graph and a temporary,
reversible Global Read-only root control, plus 48 API cells varying join count, harmless XML whitespace and equivalent
URI encodings. A further eight scalar OData transport cells need sixteen repeated observations. These domains and the
original OData cases are separate denominators, and none is qualified by generation or a local pass.

Record raw URI characters and bytes, decoded authored size and the incoming SDK XML size when present; encoded sizes
are estimates, not evidence of a downstream URI. HTTP 414, HTTP 400 admission and HTTP 500 authored-query failures stay
distinct even on adjacent join counts; do not infer a universal URI limit from one FetchXML sequence. Every cell needs
unchanged schema, graph, memberships, fixtures, site settings and registrations, both cache-clear receipts, a nonempty
SDK-observed positive control on the same root, lane and profile, the exact authored input and native outcome, and two
stable native repeats. Simulator settings that change admission or budget accounting stay explicit observed profiles
until these controls establish the site's contract.
