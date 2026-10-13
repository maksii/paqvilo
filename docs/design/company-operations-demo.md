# Company Operations Solution Implementation Specification

Revision 4, 13 October 2026. Dataverse structure specification, with implemented project sources and qualification described in the [project guide](../../examples/company-operations/README.md). This specification supersedes the previous workspace proposal and its role explorer.

Build an organisation, workforce, equipment and maintenance schema with simultaneous memberships/engagements, twelve combinable roles, and a permission relationship path eleven tables deep. Include Dataverse forms and saved views for later portal use. The permission blueprint is a structural contract: tables alone do not activate Power Pages permissions.

The [Power Pages Permission Test Harness Specification](power-pages-permission-test-harness.md), revision 3, covers paired Liquid/Web API queries, CRUD probes and Contact-scoped run history. The [Dataverse Query and Plugin Behaviour Specification](dataverse-plugin-observation.md), revision 2, adds incoming-query capture, nested SDK pipelines, configuration/cloud tests and server evidence. Together these are the three implementation documents; their infrastructure does not change the eighteen-table business model or its no-general-Delete policy.

## Deliverables and scope

Own this example in a separate project, provisionally `examples/company-operations/`, with its own package and checks. Deliver unpacked solutions `PaqviloCompanyOperationsCore` for tables/relationships/choices/keys and `PaqviloCompanyOperationsForms` for forms/views, the latter depending on Core. Use publisher prefix `pqvd`, option value prefix `18327`, version `1.0.0.0` and language `1033`. Include invented seed data, a stable component ID registry, relationship inventory and machine-readable permission blueprint in the project.

The [Dataverse provisioning toolkit](../dataverse-provisioning.md) supplies an npm API/CLI, a [project-owned schema manifest](../../examples/company-operations/dataverse/manifest.json) and a [merged fixture catalogue](../../examples/company-operations/data/stress-catalogue.json). Create metadata in Dataverse through the API, then export/unpack the server-generated solutions. The manifest covers tables, columns, relationships, choices and keys; separate project modules own forms/views, website security/pages and plugins. The data toolkit supports additive loading, comparison and paged backend retrievals. Do not hand-author table XML as a substitute for server creation/export.

This document owns Dataverse business metadata and forms/views. The companion documents own the website and recording runtime. Form settings and seeded data do not enforce backend invariants: deployed protective guards permit qualified scalar and disposable-equipment mutations, while structural scope/lifecycle changes require the full projection reconciler before enabling them. Invocation of these specifications alone does not grant access to an arbitrary environment; use the task's authorised target.

Keep the existing account demo intact. Its global account grants, including anonymous Read, must not be copied. Business fixtures and acceptance scenarios belong to the new example; no domain-specific code enters `lense/` or `mirage/`.

## Cross-document schema and implementation contract

The first increment above is structure-only. Later increments explicitly own the portal, plugins and flow in documents 2 and 3. Initialise every declared table/column/relationship/key through the Dataverse API manifest before importing these segmented exports. Update import order is Core -> Forms and TestSupport -> PluginEvidence -> BehaviorPlugins, with no reverse dependency from Core. Segmented native exports require their tables to exist and are not standalone first-install packages. A fresh environment uses the toolkit's API bootstrap; a separate full-table initial snapshot would need explicit Include All packaging and its own dependency audit. [Microsoft's initial-table segmentation limitation](https://learn.microsoft.com/en-us/power-platform/alm/segmented-solutions-alm). The complete set has 21 business tables (18 custom plus Account/Contact/Currency), three custom support tables and three custom evidence tables: **27 tables, 24 custom**. Existing platform metadata/configuration tables are dependencies outside that count.

| Addition | Owner / implementation reference |
| --- | --- |
| `pqvd_testrun`, `pqvd_testresult`, `pqvd_crudprobe` | `PaqviloPermissionTestSupport`; all columns, keys, six choices, forms/views and Contact-scoped permissions in document 2. |
| `pqvd_testoperation`, `pqvd_pluginevent`, `pqvd_chainnode` | `PaqviloPluginEvidence`; complete schema, three choices, forms/views and evidence relationships in document 3. ChainNode is user/team-owned to test Assign; business ownership stays as specified below. |
| Result-to-operation lookup and probe operation/nonce/scenario/budget columns | Extensions owned by `PaqviloBehaviorPlugins`, added after PluginEvidence; exact columns/relationships in document 3. |
| Observer, pipeline/context plugins, guards, secret-verification flow and configuration definitions | `PaqviloBehaviorPlugins`; registration/stage/image/configuration contract in document 3. Business invariant/projection enforcement remains a required readiness prerequisite for mutable business scenarios. |

Do not reuse business inspection `pqvd_finding` for technical observations. An operation's primary GUID joins caller intent, Liquid/API artifacts and server-owned event parts. One pair ID connects two distinct Liquid/API operation IDs. Actor/role snapshots belong to the run; backend system-user identities are recorded separately and never treated as portal Contacts.

No marker columns are added to business tables. Query capture uses existing root primary-name columns: `account.name`, `contact.fullname`, `transactioncurrency.currencyname`, and custom `pqvd_name`. Fixture validation reserves `CO-UTC:` and `CO-OP:` name prefixes and includes null-name query-adapter fixtures where metadata permits. The null-preserving two-condition guard, logical/physical hashes and unique lane/page/attempt IDs are defined in document 3. These markers correlate requests; they confer no access.

Every deep permission and multi-role collision fixture below must be available to both portal lanes and backend observers. Query-budget stress and plugin-depth stress are separate manifests: the default fifteen FetchXML-link constraint is not the SDK default execution-depth limit. Never weaken scoped business permissions or raise a platform limit to make either suite pass.

## Official permission model and design consequences

| Platform rule | Consequence for this specification |
| --- | --- |
| Portal identities are Contacts; web roles provide cumulative access | One person may combine roles. There is no invented deny precedence or ban on conflicting responsibilities. [Power Pages security](https://learn.microsoft.com/en-us/power-pages/security/power-pages-security). |
| Contact access follows a relationship to the signed-in Contact; Account access uses their associated account | Multi-organisation membership needs explicit rows/relationships, not one `parentcustomerid`. [Access scopes](https://learn.microsoft.com/en-us/power-pages/security/table-permissions). |
| Child permissions name a relationship and inherit parent roles | Separate capability trees. A custom Role column is not automatically an authorization filter. [Parent and child permissions](https://learn.microsoft.com/en-us/power-pages/security/table-permissions). |
| Polymorphic lookups are unsupported in parent/child permissions | Every deep-chain lookup is single-target; standard customer lookup is not a chain anchor. [Relationship limitation](https://learn.microsoft.com/en-us/power-pages/security/table-permissions). |
| Web API column permissions do not protect every data surface; enhanced authorization uses a different mechanism | Private HR and finance are separate tables; forms/views are not security boundaries. [Column permissions](https://learn.microsoft.com/en-us/power-pages/security/column-permissions). |
| Multi-level scoped 1:N/N:N permissions have a documented GET query issue; FetchXML is the documented workaround | Preserve the graph and qualify later against the target site/version; never add Global Read as a workaround. [Known issues](https://learn.microsoft.com/en-us/power-pages/configure/web-api-overview). |

Baseline authorization is traditional relationship-based permissions, with no preview Custom Access dependency. There are zero Global roots for business, directory, grant or role-catalogue tables. Power Pages web roles remain distinct from backend Dataverse security roles. [Portal identity and backend connectivity](https://learn.microsoft.com/en-us/power-pages/admin/connectivity).

Documentation validates these semantics, not execution/performance of this exact eleven-table graph. The cited documentation does not establish a guaranteed maximum depth. The project guide records actual target-site qualification, including the safe single-route variant and baseline join-limit findings; consumers must independently qualify their installations.

## Organisation membership and employment

Account represents Company, Subsidiary, Region, Branch, Operating unit or Vendor. Organisational Accounts share a root Company; Vendors sit outside the organisation trees. Branches are not Dataverse business units. Company roots have no parent and a null root lookup; their canonical root identity is their own Account GUID. Descendants store that Company GUID in `pqvd_rootaccountid`. Vendors have no canonical organisational root. The connected Dataverse platform rejects a Company-to-itself root association as a parental hierarchy loop; do not attempt to populate that self-link.

Contact is a shared person. `pqvd_orgcontact` represents that person in one organisational Account with their work contact details there. Several memberships and concurrent engagements are supported, including permanent employment in A and external contracting in B, or several engagements within one organisation. There is no one-active-engagement-per-person rule and no global cross-company FTE-total constraint.

Roles are independent from engagement kind. A contractor can also be HR, IT, organisation administrator and CTO. Ending one engagement revokes its sponsored grants, not unrelated appointments or employment in other organisations.

```text
Company/branch Account
  -> Organisation contact membership -> shared Contact (identity leaf)
    -> Employment / contract
      -> Assignment -> Service request -> Work order -> Work task
        -> Checklist item -> Inspection attempt -> Finding

Account -> Site -> Building -> Room -> Equipment -> Equipment finance
Account -> Department -> Employment -> Private employment terms
```

Do not use `Account -> shared Contact -> all employments` as an operational permission route. Access to a Contact through A could then expose its B engagements. Company-to-contact-to-workforce permissions traverse organisation-specific membership. A shared-Contact display grant, if ever required, is a Read-only leaf with no children.

## Metadata conventions

Create eighteen standard organisation-owned custom tables, not activities, virtual or elastic tables. Each has GUID key `<logicalname>id`, `pqvd_name` Text(160), standard created/modified timestamps and Active/Inactive state/status columns. Enable auditing for supported custom business columns. Do not change standard Account/Contact ownership or security roles.

Inventory notation: `!` = Business Required plus mandatory seed/import validation; otherwise nullable. `S` = system-maintained, not ordinary user input. `L(table)` = single-target lookup. `Date` = DateOnly behaviour; `Time` = UserLocal date/time. Decimal workload has precision 2, range 0..1; weekly hours precision 2, range 0..168; money is nonnegative with currency precision. Counts/minutes are nonnegative integers; sequence/attempt start at 1; floor and measured values may be signed. Multiline text is plain text.

All custom column names in the inventory are full logical names. Standard currency fields are platform-created. Reproducible codes/numbers and GUIDs come from the seed registry, not generated autonumbers. Entity sets are explicitly listed and must be preserved in exported metadata. All alternate-key components are required for rows using that key, with no secured key columns, fewer than ten keys per table, at most sixteen columns and 900 bytes per key. Wait for Active indexes before data import. Null key values do not enforce uniqueness. [Key constraints](https://learn.microsoft.com/en-us/power-apps/maker/data-platform/define-alternate-keys-reference-records), [index lifecycle](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/define-alternate-keys-entity).

## Tables columns and keys

The inventory contains eighteen custom tables plus Account, Contact and Transaction Currency, twenty-one tables total. Custom tables also include the common columns above.

| Table / entity set | Additional columns | Alternate key definitions |
| --- | --- | --- |
| `account` / `accounts` | Standard `name`, `accountnumber`, `parentaccountid`; `pqvd_orgkind` Choice!, `pqvd_rootaccountid` L(account) S | `pqvd_ak_account_number`: account number, required for demo records. Root lookup required for descendants; null for Company/Vendor. Company canonical root = its own ID. |
| `contact` / `contacts` | Standard first/last/full name, email/telephone, `parentcustomerid`; `pqvd_personcode` Text(40)! | `pqvd_ak_contact_personcode`: person code. Customer lookup is optional default/home context, not a membership/security anchor. |
| `transactioncurrency` / `transactioncurrencies` | Standard ID, name, ISO code, precision, exchange rate | Standard dependency only; reuse metadata, seed USD/EUR with deterministic test rates. |
| `pqvd_accessrole` / `pqvd_accessroles` | `pqvd_code` Text(24)!, `pqvd_description` Text(1000), `pqvd_principalcolumn` Text(80)! | `pqvd_ak_accessrole_code`: code. Twelve business role records; not Dataverse/website security-role records. |
| `pqvd_accesspermission` / `pqvd_accesspermissions` | `pqvd_number` Text(40)!, `pqvd_granteecontactid` L(contact)!, `pqvd_scopeaccountid` L(account)!, `pqvd_roleid` L(pqvd_accessrole)!, `pqvd_scopekind` Choice!, `pqvd_scopekey` Text(40)! S, `pqvd_includedescendants` Boolean!, `pqvd_departmentid` L(pqvd_department), `pqvd_employmentid` L(pqvd_employment), `pqvd_validfrom` Time!, `pqvd_validuntil` Time, `pqvd_accessstate` Choice!, `pqvd_reason` Text(1000); twelve principal columns below, all S | `pqvd_ak_accesspermission_number`: number. `pqvd_ak_accesspermission_scope`: grantee, scope Account, role, scope key. Scope key is ORG-SELF, ORG-TREE, DEPT-<32 hex GUID> or ENG-<32 hex GUID>, never null. |
| `pqvd_orgcontact` / `pqvd_orgcontacts` | `pqvd_code` Text(40)!, `pqvd_accountid` L(account)!, `pqvd_contactid` L(contact)!, `pqvd_displayname` Text(160)!, `pqvd_workemail` Text(254), `pqvd_workphone` Text(40), `pqvd_membershipstate` Choice! | `pqvd_ak_orgcontact_code`: code. `pqvd_ak_orgcontact_member`: Account + Contact. No salary, personal address or identity-provider fields. |
| `pqvd_department` / `pqvd_departments` | `pqvd_code` Text(40)!, `pqvd_accountid` L(account)!, `pqvd_managerorgcontactid` L(pqvd_orgcontact), `pqvd_description` Text(1000) | `pqvd_ak_department_code`: Account + code. Manager is a membership in the same Account. |
| `pqvd_employment` / `pqvd_employments` | `pqvd_number` Text(40)!, `pqvd_orgcontactid` L(pqvd_orgcontact)!, `pqvd_departmentid` L(pqvd_department)!, `pqvd_manageremploymentid` L(pqvd_employment), `pqvd_engagementkind` Choice!, `pqvd_ftefraction` Decimal!, `pqvd_startdate` Date!, `pqvd_enddate` Date, `pqvd_jobtitle` Text(100)!, `pqvd_supplieraccountid` L(account), `pqvd_employmentstate` Choice! | `pqvd_ak_employment_number`: number. Organisation/person derive from membership; no redundant writable Account/Contact lookup. |
| `pqvd_employmentterms` / `pqvd_employmenttermrecords` | `pqvd_employmentid` L(pqvd_employment)!, `pqvd_annualsalary` Money, `pqvd_dayrate` Money, standard `transactioncurrencyid` L(transactioncurrency)!, `pqvd_weeklyhours` Decimal, `pqvd_noticeperioddays` Integer, `pqvd_contractreference` Text(80)! | `pqvd_ak_employmentterms_employment`: employment. Unique required lookup enforces optional 0:1 dependent, not a native 1:1 relationship. |
| `pqvd_site` / `pqvd_sites` | `pqvd_code` Text(40)!, `pqvd_accountid` L(account)!, `pqvd_address` Text(500), `pqvd_sitekind` Choice! | `pqvd_ak_site_code`: Account + code. |
| `pqvd_building` / `pqvd_buildings` | `pqvd_code` Text(40)!, `pqvd_siteid` L(pqvd_site)!, `pqvd_floors` Integer | `pqvd_ak_building_code`: site + code. |
| `pqvd_room` / `pqvd_rooms` | `pqvd_code` Text(40)!, `pqvd_buildingid` L(pqvd_building)!, `pqvd_floor` Integer, `pqvd_capacity` Integer, `pqvd_roomkind` Choice! | `pqvd_ak_room_code`: building + code. Floor can be negative, capacity cannot. |
| `pqvd_equipment` / `pqvd_equipments` | `pqvd_assettag` Text(40)!, `pqvd_serialnumber` Text(100), `pqvd_accountid` L(account)!, `pqvd_roomid` L(pqvd_room), `pqvd_equipmentkind` Choice!, `pqvd_manufacturer` Text(100), `pqvd_model` Text(100), `pqvd_condition` Choice!, `pqvd_equipmentstate` Choice!, `pqvd_currentassignmentid` L(pqvd_assignment) S, `pqvd_purchasedate` Date, `pqvd_warrantyend` Date | `pqvd_ak_equipment_tag`: tag. Serial deliberately not unique. Owning organisation and physical placement are different relationships. |
| `pqvd_equipmentfinance` / `pqvd_equipmentfinances` | `pqvd_equipmentid` L(pqvd_equipment)!, `pqvd_purchasecost` Money!, `pqvd_replacementvalue` Money, standard `transactioncurrencyid` L(transactioncurrency)!, `pqvd_supplieraccountid` L(account), `pqvd_invoicereference` Text(80), `pqvd_costcentre` Text(40) | `pqvd_ak_equipmentfinance_equipment`: equipment. Costs never enter shared equipment views. |
| `pqvd_assignment` / `pqvd_assignments` | `pqvd_number` Text(40)!, `pqvd_equipmentid` L(pqvd_equipment)!, `pqvd_employmentid` L(pqvd_employment)!, `pqvd_issuedat` Time, `pqvd_returnedat` Time, `pqvd_issuerorgcontactid` L(pqvd_orgcontact), `pqvd_issuecondition` Choice, `pqvd_returncondition` Choice, `pqvd_assignmentstate` Choice! | `pqvd_ak_assignment_number`: number. Payload-bearing history association; one Issued assignment per asset needs execution-time validation. |
| `pqvd_servicerequest` / `pqvd_servicerequests` | `pqvd_number` Text(40)!, `pqvd_equipmentid` L(pqvd_equipment)!, `pqvd_assignmentid` L(pqvd_assignment), `pqvd_requesterorgcontactid` L(pqvd_orgcontact)!, `pqvd_requestkind` Choice!, `pqvd_priority` Choice!, `pqvd_description` Multiline(4000)!, `pqvd_reportedat` Time!, `pqvd_workstate` Choice! | `pqvd_ak_servicerequest_number`: number. Assignment optional for stock maintenance, present in the mandatory deep fixture. |
| `pqvd_workorder` / `pqvd_workorders` | `pqvd_number` Text(40)!, `pqvd_requestid` L(pqvd_servicerequest)!, `pqvd_responsibleorgcontactid` L(pqvd_orgcontact), `pqvd_duedate` Date, `pqvd_workstate` Choice! | `pqvd_ak_workorder_number`: number. |
| `pqvd_worktask` / `pqvd_worktasks` | `pqvd_workorderid` L(pqvd_workorder)!, `pqvd_sequence` Integer!, `pqvd_assigneeorgcontactid` L(pqvd_orgcontact), `pqvd_estimatedminutes` Integer, `pqvd_actualminutes` Integer, `pqvd_workstate` Choice! | `pqvd_ak_worktask_sequence`: order + sequence. |
| `pqvd_checklistitem` / `pqvd_checklistitems` | `pqvd_taskid` L(pqvd_worktask)!, `pqvd_sequence` Integer!, `pqvd_instruction` Text(1000)!, `pqvd_checkresult` Choice! | `pqvd_ak_checklistitem_sequence`: task + sequence. |
| `pqvd_inspection` / `pqvd_inspections` | `pqvd_checklistitemid` L(pqvd_checklistitem)!, `pqvd_attempt` Integer!, `pqvd_inspectororgcontactid` L(pqvd_orgcontact)!, `pqvd_inspectedat` Time!, `pqvd_checkresult` Choice!, `pqvd_measuredvalue` Decimal(4), `pqvd_measurementunit` Text(24) | `pqvd_ak_inspection_attempt`: checklist item + attempt. Supports repeated verification attempts. |
| `pqvd_finding` / `pqvd_findings` | `pqvd_inspectionid` L(pqvd_inspection)!, `pqvd_sequence` Integer!, `pqvd_severity` Choice!, `pqvd_description` Multiline(4000)!, `pqvd_workstate` Choice! | `pqvd_ak_finding_sequence`: inspection + sequence. Defects/remedial findings from inspections. |

## Choices and twelve roles

Create these seventeen global choices. Ordered labels in each row map to values 183270000, 183270001, etc.; values may repeat across different choice definitions. Preserve mappings in the registry.

| Choice | Ordered labels |
| --- | --- |
| `pqvd_orgkind` | Company, Subsidiary, Region, Branch, Operating unit, Vendor |
| `pqvd_scopekind` | Organisation, Department, Engagement |
| `pqvd_accessstate` | Pending, Active, Suspended, Expired, Revoked |
| `pqvd_membershipstate` | Pending, Active, Suspended, Ended |
| `pqvd_engagementkind` | Permanent employee, Fixed-term employee, External contractor |
| `pqvd_employmentstate` | Draft, Active, Suspended, Ended |
| `pqvd_sitekind` | Office, Workshop, Warehouse |
| `pqvd_roomkind` | Office, Meeting room, Workshop, Storage |
| `pqvd_equipmentkind` | Laptop, Phone, Network, Production equipment, Vehicle, Safety equipment |
| `pqvd_condition` | New, Good, Worn, Damaged |
| `pqvd_equipmentstate` | Stock, Assigned, In repair, Retired |
| `pqvd_assignmentstate` | Planned, Issued, Returned, Cancelled |
| `pqvd_requestkind` | Fault, Inspection, Replacement |
| `pqvd_priority` | Low, Normal, High, Critical |
| `pqvd_workstate` | New, Planned, In progress, Blocked, Completed, Cancelled |
| `pqvd_checkresult` | Not run, Pass, Fail, Not applicable |
| `pqvd_severity` | Advisory, Minor, Major, Critical |

Choice columns with the same logical name bind to the corresponding global choice. The exceptions are `pqvd_issuecondition` and `pqvd_returncondition`, which both bind to `pqvd_condition`. Standard state/status choices retain their platform definitions; do not replace them with custom work/access states. Set `pqvd_includedescendants` default false, membership/access state default Pending, employment state Draft, assignment state Planned, equipment state Stock, work state New and check result Not run. Leave role principals null by default. Other choices must be supplied explicitly rather than inheriting a meaningful authorization default.

Seed these role records. Every principal is a nullable Contact lookup on Access permission, with relationship `pqvd_contact_access_<lowercase role code>`.

| Code | Name | Principal column | Typical scope |
| --- | --- | --- | --- |
| `COMPANYMANAGER` | Company manager | `pqvd_companymanagerprincipalid` | Company/subsidiary subtree |
| `BRANCHMANAGER` | Branch manager | `pqvd_branchmanagerprincipalid` | Branch subtree |
| `TEAMLEADER` | Team leader | `pqvd_teamleaderprincipalid` | Department |
| `EMPLOYEE` | Employee | `pqvd_employeeprincipalid` | Selected permanent/fixed-term engagement |
| `CONTRACTOR` | External contractor | `pqvd_contractorprincipalid` | Selected external-contract engagement |
| `HR` | HR officer | `pqvd_hrprincipalid` | Organisation/subtree |
| `IT` | IT asset administrator | `pqvd_itprincipalid` | Organisation/subtree |
| `FACILITIES` | Facilities coordinator | `pqvd_facilitiesprincipalid` | Branch/subtree |
| `PROCUREMENT` | Procurement officer | `pqvd_procurementprincipalid` | Organisation/subtree |
| `AUDITOR` | Operations auditor | `pqvd_auditorprincipalid` | Organisation/subtree |
| `ORGADMIN` | Organisation administrator | `pqvd_orgadminprincipalid` | Organisation/subtree |
| `CTO` | CTO | `pqvd_ctoprincipalid` | Company/subsidiary subtree |

OrgAdmin administers operational structure/directory, not the environment, website or unrestricted grant provisioning. CTO has technical operational scope, not private payroll.

## Access permission projections

An Access permission row is one grantee/role/scope with optional sponsoring employment. Active/effective rows have exactly one role principal equal to the grantee; all other principals are null. Pending/inactive/suspended/expired/revoked rows have all principals null. Seed materialisation evaluates dates against the fixed clock below; an Active saved-view filter is not authorization.

Future HR root permission: Contact scope via `pqvd_contact_access_hr`, HR web role. IT root: Contact scope via `pqvd_contact_access_it`, IT web role. A contact with both web roles reaches only HR rows in the HR tree and IT rows in the IT tree. A generic Contact root using `pqvd_granteecontactid` would match both roles' rows and cause scope multiplication; do not use it for operational descendants. Any future own-grant-metadata root is an isolated Read-only leaf.

Create these five native N:N relationships. Intersect entity name equals relationship schema name. Intersect columns are the participants' primary IDs. There are no payload columns or intersect-table forms.

| Relationship | Participants | Intersect columns |
| --- | --- | --- |
| `pqvd_access_accounts` | `pqvd_accesspermission` ↔ `account` | `pqvd_accesspermissionid`, `accountid` |
| `pqvd_access_orgcontacts` | `pqvd_accesspermission` ↔ `pqvd_orgcontact` | `pqvd_accesspermissionid`, `pqvd_orgcontactid` |
| `pqvd_access_departments` | `pqvd_accesspermission` ↔ `pqvd_department` | `pqvd_accesspermissionid`, `pqvd_departmentid` |
| `pqvd_access_employments` | `pqvd_accesspermission` ↔ `pqvd_employment` | `pqvd_accesspermissionid`, `pqvd_employmentid` |
| `pqvd_access_equipments` | `pqvd_accesspermission` ↔ `pqvd_equipment` | `pqvd_accesspermissionid`, `pqvd_equipmentid` |

Native intersections carry associations; Access rows carry dates/roles/reasons. [Dataverse N:N modelling](https://learn.microsoft.com/en-us/power-apps/maker/data-platform/create-edit-nn-relationships-portal).

Materialisation rules:

- Organisation grants associate the anchor Account plus descendants only when includedescendants=true. Never add ancestors, siblings or another root Company. Links provide no universal children; each role's tree supplies only its allowed privileges.
- Department grants associate the selected department and its active employments directly. This avoids a membership-to-all-engagements bridge when one person works in several departments. Necessary Account/membership profile access is a separate leaf.
- Employee/Contractor grants associate the selected engagement and membership. Equipment projection includes only Issued assignments for that engagement; other jobs require other grants.
- Employee directory membership links cover active memberships below that engagement's root Company. Contractor links cover active memberships represented by engagements in its department. Directory membership leaves have no Employment children. Safe Account profiles are also leaves.
- Non-Active grants have no intersections. Revocation/expiry clears principals and links; business-row dates/state alone do not revoke access. This increment seeds correct projections; automated reconciliation is future work.

Future consumers also associate each Contact with website web roles matching effective grants. Website roles alone give no organisational scope; the business role catalogue alone does not install website roles. Grant/principal/scope association writes remain provisioner-only.

## Single target relationships and cascade settings

The referenced table is on the left; the referencing table holds the lookup. The lookup name is the proposed single-valued navigation name. Preserve actual exported names and ID columns in the relationship inventory. Never infer field/navigation names from labels.

| Relationship schema | Referenced table | Referencing table | Lookup |
| --- | --- | --- | --- |
| `pqvd_account_root` | `account` | `account` | `pqvd_rootaccountid` |
| `pqvd_contact_access_grantee` | `contact` | `pqvd_accesspermission` | `pqvd_granteecontactid` |
| `pqvd_account_access_scope` | `account` | `pqvd_accesspermission` | `pqvd_scopeaccountid` |
| `pqvd_accessrole_access` | `pqvd_accessrole` | `pqvd_accesspermission` | `pqvd_roleid` |
| `pqvd_department_access` | `pqvd_department` | `pqvd_accesspermission` | `pqvd_departmentid` |
| `pqvd_employment_access` | `pqvd_employment` | `pqvd_accesspermission` | `pqvd_employmentid` |
| `pqvd_account_orgcontacts` | `account` | `pqvd_orgcontact` | `pqvd_accountid` |
| `pqvd_contact_orgcontacts` | `contact` | `pqvd_orgcontact` | `pqvd_contactid` |
| `pqvd_account_departments` | `account` | `pqvd_department` | `pqvd_accountid` |
| `pqvd_orgcontact_manageddepartments` | `pqvd_orgcontact` | `pqvd_department` | `pqvd_managerorgcontactid` |
| `pqvd_orgcontact_employments` | `pqvd_orgcontact` | `pqvd_employment` | `pqvd_orgcontactid` |
| `pqvd_department_employments` | `pqvd_department` | `pqvd_employment` | `pqvd_departmentid` |
| `pqvd_employment_reports` | `pqvd_employment` | `pqvd_employment` | `pqvd_manageremploymentid` |
| `pqvd_account_suppliedemployments` | `account` | `pqvd_employment` | `pqvd_supplieraccountid` |
| `pqvd_employment_terms` | `pqvd_employment` | `pqvd_employmentterms` | `pqvd_employmentid` |
| `pqvd_account_sites` | `account` | `pqvd_site` | `pqvd_accountid` |
| `pqvd_site_buildings` | `pqvd_site` | `pqvd_building` | `pqvd_siteid` |
| `pqvd_building_rooms` | `pqvd_building` | `pqvd_room` | `pqvd_buildingid` |
| `pqvd_account_equipments` | `account` | `pqvd_equipment` | `pqvd_accountid` |
| `pqvd_room_equipments` | `pqvd_room` | `pqvd_equipment` | `pqvd_roomid` |
| `pqvd_assignment_currentequipment` | `pqvd_assignment` | `pqvd_equipment` | `pqvd_currentassignmentid` |
| `pqvd_equipment_finance` | `pqvd_equipment` | `pqvd_equipmentfinance` | `pqvd_equipmentid` |
| `pqvd_account_equipmentvendors` | `account` | `pqvd_equipmentfinance` | `pqvd_supplieraccountid` |
| `pqvd_equipment_assignments` | `pqvd_equipment` | `pqvd_assignment` | `pqvd_equipmentid` |
| `pqvd_employment_assignments` | `pqvd_employment` | `pqvd_assignment` | `pqvd_employmentid` |
| `pqvd_orgcontact_issuedassignments` | `pqvd_orgcontact` | `pqvd_assignment` | `pqvd_issuerorgcontactid` |
| `pqvd_assignment_requests` | `pqvd_assignment` | `pqvd_servicerequest` | `pqvd_assignmentid` |
| `pqvd_equipment_requests` | `pqvd_equipment` | `pqvd_servicerequest` | `pqvd_equipmentid` |
| `pqvd_orgcontact_requests` | `pqvd_orgcontact` | `pqvd_servicerequest` | `pqvd_requesterorgcontactid` |
| `pqvd_request_workorders` | `pqvd_servicerequest` | `pqvd_workorder` | `pqvd_requestid` |
| `pqvd_orgcontact_responsibleorders` | `pqvd_orgcontact` | `pqvd_workorder` | `pqvd_responsibleorgcontactid` |
| `pqvd_workorder_tasks` | `pqvd_workorder` | `pqvd_worktask` | `pqvd_workorderid` |
| `pqvd_orgcontact_assignedtasks` | `pqvd_orgcontact` | `pqvd_worktask` | `pqvd_assigneeorgcontactid` |
| `pqvd_task_checklistitems` | `pqvd_worktask` | `pqvd_checklistitem` | `pqvd_taskid` |
| `pqvd_checklistitem_inspections` | `pqvd_checklistitem` | `pqvd_inspection` | `pqvd_checklistitemid` |
| `pqvd_orgcontact_inspections` | `pqvd_orgcontact` | `pqvd_inspection` | `pqvd_inspectororgcontactid` |
| `pqvd_inspection_findings` | `pqvd_inspection` | `pqvd_finding` | `pqvd_inspectionid` |

Additionally create twelve Contact principal relationships from the role catalogue. Reuse standard `account_parent_account` for organisation parents; make it the intended hierarchical Account relationship where supported. Only one self-referential relationship per table is designated hierarchical. Root-account and employment-manager relationships are not hierarchical. [Hierarchy limitation](https://learn.microsoft.com/en-us/power-apps/maker/data-platform/define-query-hierarchical-data).

New 1:N relationships: Assign/Share/Unshare/Reparent = NoCascade; Delete = Restrict. Merge = NoCascade for custom parents, Cascade for Account/Contact parents: the connected Dataverse platform enforced that merge behaviour, now explicitly declared in the manifest. Optional links also use Restrict for history retention. Currency relationships are platform-generated. Native N:N cleanup deletes links, not participants. Preserve standard Account parent cascade settings and inventory them; changes to those settings require separate review. Cascade behaviour does not grant portal scope. Cross-root Account/Contact merge needs separate invariant enforcement before any future merge workflow. [Relationship behaviour](https://learn.microsoft.com/en-us/power-apps/maker/data-platform/create-edit-entity-relationships).

## Counted permission paths

The signed-in Contact is an anchor, not an extra counted permission level. Mandatory IT workforce path:

| Level | Table | Scope and relationship | Parent |
| --- | --- | --- | --- |
| 1 | `pqvd_accesspermission` | Contact, `pqvd_contact_access_it` | None |
| 2 | `account` | Parent, `pqvd_access_accounts` N:N | IT level 1 |
| 3 | `pqvd_orgcontact` | Parent, `pqvd_account_orgcontacts` | IT level 2 |
| 4 | `pqvd_employment` | Parent, `pqvd_orgcontact_employments` | IT level 3 |
| 5 | `pqvd_assignment` | Parent, `pqvd_employment_assignments` | IT level 4 |
| 6 | `pqvd_servicerequest` | Parent, `pqvd_assignment_requests` | IT level 5 |
| 7 | `pqvd_workorder` | Parent, `pqvd_request_workorders` | IT level 6 |
| 8 | `pqvd_worktask` | Parent, `pqvd_workorder_tasks` | IT level 7 |
| 9 | `pqvd_checklistitem` | Parent, `pqvd_task_checklistitems` | IT level 8 |
| 10 | `pqvd_inspection` | Parent, `pqvd_checklistitem_inspections` | IT level 9 |
| 11 | `pqvd_finding` | Parent, `pqvd_inspection_findings` | IT level 10 |

Eleven nodes and ten Parent edges exceed eight under either counting convention. Retain this path and populated fixtures even when IT has a shorter equipment route. Inspections record repeated verification; findings record real defects, not meaningless depth padding.

Employee/Contractor path: Access -> Employment via `pqvd_access_employments` -> Assignment -> Request -> Order -> Task -> Checklist -> Inspection -> Finding. Nine nodes/eight Parent edges. Directory/profile grants are separate leaves without workforce children.

Clone permission trees per role, not per person/org. Stable node IDs are `<ROLE>-<PATH>-<TABLESTEM>`, e.g. `IT-WORKFORCE-ACCESSPERMISSION` to `IT-WORKFORCE-FINDING`. Every child has one explicit parent and the root's web role. Shared table rows may be reached by several independent trees; do not reuse an aggregated Account Read grant as another role's parent.

Secondary routes, only for roles permitted below: Account -> Equipment -> Requests -> service descendants; Account -> Site -> Building -> Room; Account -> Department -> Employment; Employment -> Terms; Equipment -> Finance; and Access -> projected Equipment. Equipment-assignment history can be read through Equipment or Employment according to the role. Account/membership profiles and any canonical Contact display are leaf grants.

## Role privileges and collisions

R=Read, C=Create, U=Write/Update. No general Delete. Access roots are Read-only. Association rights are explicit, not blanket. Row privileges are additive; absence of U in one role is not a deny against another. This matrix supplies no field-level approval rules.

| Role | Organisation / departments | Directory memberships | Employment | Private terms | Equipment / assignment | Finance | Locations | Service chain |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| COMPANYMANAGER | RCU subtree | RCU subtree | R | — | RCU / RCU | R | RCU | RCU |
| BRANCHMANAGER | RU anchor, RCU units/departments | RCU subtree | R | — | RCU / RCU | R | RCU | RCU |
| TEAMLEADER | R profile leaf / selected department | R team leaf | R projected team engagements | — | R team / R team | — | — | RCU team work |
| EMPLOYEE | R own/root profiles | R company directory leaf | R selected own engagement | — | R current / R own history | — | — | R engagement history/current equipment; C request |
| CONTRACTOR | R own profile | R department directory leaf | R selected own engagement | — | R current / R own history | — | — | R engagement history/current equipment; C request |
| HR | R | RCU | RCU | RCU | R / R | — | — | — |
| IT | R | R | R operational | — | RCU / RCU | — | R | RCU |
| FACILITIES | R | R | — | — | R / — | — | RCU | RCU equipment route |
| PROCUREMENT | R profile leaf | — | — | — | RC / — | RCU | — | — |
| AUDITOR | R | R | R operational | — | R / R | R | R | R |
| ORGADMIN | RCU | RCU | R operational | — | R / R | — | RCU | R |
| CTO | R | R | R operational | — | RCU / RCU | R | R | RCU |

Every cell is bounded by its own role grant. Branch manager + Employee is valid: company directory Read broadens intentionally while branch equipment Write stays narrow. HR + IT in the same org gives both permissions; HR in A + IT in B gives terms access only A and equipment Write only B. OrgAdmin/CTO do not implicitly give HR access. Own-contract editing can be permitted by HR; separation-of-duties approval is future business logic, not a fabricated table-permission denial.

For ordinary lookup binding require allowed C/U plus referencing-record Append and target-record Append To, with Read for target selection. Rights may legitimately come from different roles if scopes cover both records. Native N:N association has its own privilege checks; scope projections are provisioner-only. New records need validated parent/scope assignment and subsequent projection maintenance; C alone does not automatically give future Read. [Dataverse access rights](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/security-access-rights).

## Dataverse forms

Create new named main forms using normal platform controls, no scripts/PCF/iframes/custom actions. Do not replace standard forms. Every custom table has one Administration form; terms/finance names below are their Administration forms. Portable forms are minimal reusable Dataverse forms, not Power Pages Basic Forms. Locked controls are presentation, not security. [Form metadata](https://learn.microsoft.com/en-us/power-apps/maker/model-driven-apps/form-designer-overview).

| Table | Required form names and sections / related subgrids |
| --- | --- |
| `account` | `CO Organisation Administration`: identity/kind/parent/root; contacts/departments/equipment/sites. `CO Organisation Profile`: name/number/kind only, no parent/root display. |
| `contact` | `CO Person Administration`: person code and business identity; memberships. No portable shared-Contact form. |
| `pqvd_accessrole` | `CO Access Role Administration`: code/name/description/principal mapping. |
| `pqvd_accesspermission` | `CO Access Permission Administration`: grantee/role/scope/sponsor/dates/state; read-only principals/scope key; five association subgrids. |
| `pqvd_orgcontact` | `CO Organisation Contact Administration`: identity/state/work profile; engagements. `CO Organisation Contact Profile`: display name/work email/phone/state only. |
| `pqvd_department` | `CO Department Administration`: Account/code/manager/description; engagements. `CO Department Profile`: name/code/description. |
| `pqvd_employment` | `CO Employment Administration`: membership/department/manager/kind/workload/dates/state; assignments. `CO Employment Summary`: number/kind/title/workload/dates/state; no terms subgrid. |
| `pqvd_employmentterms` | `CO Private Employment Terms`: employment/contract/currency/salary/rate/hours/notice, backend restricted. |
| `pqvd_site` | `CO Site Administration`: Account/code/address/kind; buildings. `CO Site Summary`: code/address/kind. |
| `pqvd_building` | `CO Building Administration`: site/code/floors; rooms. |
| `pqvd_room` | `CO Room Administration`: building/code/floor/capacity/kind; equipment. |
| `pqvd_equipment` | `CO Equipment Administration`: organisation/location/tag/serial/type/model/state/condition/warranty; assignments/requests. `CO Equipment Summary`: tag/name/type/model/state/condition/warranty; no costs/ancestry/current-assignment display. |
| `pqvd_equipmentfinance` | `CO Equipment Finance`: equipment/currency/values/supplier/invoice/cost centre, backend restricted. |
| `pqvd_assignment` | `CO Assignment Administration`: equipment/employment/issue/return/actor/conditions/state; requests. `CO Assignment Summary`: number/dates/conditions/state. |
| `pqvd_servicerequest` | `CO Service Request Administration`: equipment/assignment/requester/description/category/priority/time/state; orders. `CO Service Request Summary`: number/name/description/category/priority/time/state. |
| `pqvd_workorder` | `CO Work Order Administration`: request/responsible/due/state; tasks. |
| `pqvd_worktask` | `CO Work Task Administration`: order/sequence/assignee/estimate/actual/state; checklist. |
| `pqvd_checklistitem` | `CO Checklist Item Administration`: task/sequence/instruction/result; inspections. |
| `pqvd_inspection` | `CO Inspection Administration`: checklist/attempt/inspector/time/result/value/unit; findings. |
| `pqvd_finding` | `CO Finding Administration`: inspection/sequence/severity/description/state. |

No currency form. Administration subgrids use the named backend public views below and relationship context; portable forms omit all security/private fields and relationship subgrids not explicitly listed. Backend form access is governed by backend roles, not by the custom business role catalogue.

## Dataverse views

Create public SavedQuery views, not personal views. Each has explicit FetchXML attributes, matching LayoutXML, primary GUID row ID, stable component GUID and deterministic sort. QueryType: Public 0, Lookup 64, Quick Find 4. Custom tables have one generated system Lookup/Quick Find view to adjust, not multiple system Lookup views. Standard Account/Contact system views remain intact; named public lookup candidates below are consumer-selectable. [Saved views and view types](https://learn.microsoft.com/en-us/power-apps/developer/model-driven-apps/customize-entity-views).

Each custom table additionally has `CO <display name> All`, displaying primary name, business code/number or sequence, state and required parent lookup for backend use; use the restricted All views specified for terms/finance instead of duplicating them. Sort by code/number/sequence then GUID. One default public view per custom table: Active/Open where listed, restricted All for terms/finance, Checklist Items/Inspection Results/Open Findings for those tables.

| Table | Required named public views | Columns besides primary GUID; filter and sort |
| --- | --- | --- |
| `account` | `CO Active Organisations`, `CO Organisation Profiles`, `CO Organisation Lookup Candidates`, `CO Vendors` | name/number/kind; Active non-Vendor for first three, Vendor for last; number/GUID. Profiles omit parent/root. |
| `contact` | `CO Person Lookup Candidates`, `CO People Administration` | person code/full name; Active candidates, all administration; code/GUID. No private or joined membership fields. |
| `pqvd_accessrole` | `CO Active Access Roles` | code/name; Active; code/GUID. Backend only. |
| `pqvd_accesspermission` | `CO Active Access Permissions`, `CO Suspended Access Permissions`, `CO Access Permission Diagnostics` | number/role/scope/kind/state/dates; Active, Suspended/Expired/Revoked, all respectively; number/GUID. Diagnostics include principals only in backend layout. |
| `pqvd_orgcontact` | `CO Active Organisation Contacts`, `CO Directory Contacts` | code/display name/work email/phone/state; Active membership; display name/code/GUID. Directory excludes canonical Contact lookup and Employment data. |
| `pqvd_department` | `CO Active Departments`, `CO Department Summaries` | code/name/description; Active; code/GUID. Summaries omit manager. |
| `pqvd_employment` | `CO Active Engagements`, `CO Ended Engagements`, `CO Engagement Summaries` | number/title/kind/FTE/dates/state; Active, Ended, all respectively; number/GUID. No terms or joined Contact fields. |
| `pqvd_employmentterms` | `CO Private Employment Terms All` | name/employment/contract/salary/rate/currency; all; name/GUID, backend restricted. |
| `pqvd_site` | `CO Active Sites`, `CO Site Summaries` | code/name/kind/address; Active; code/GUID. |
| `pqvd_building` | `CO Active Buildings` | code/name/floors; Active; code/GUID. |
| `pqvd_room` | `CO Active Rooms` | code/name/floor/capacity/kind; Active; code/GUID. |
| `pqvd_equipment` | `CO Available Equipment`, `CO Assigned Equipment`, `CO Retired Equipment`, `CO Equipment Summaries` | tag/name/type/manufacturer/model/condition/state/warranty; Stock, Assigned, Retired, all respectively; tag/GUID. No finance or custody join. |
| `pqvd_equipmentfinance` | `CO Equipment Finance All` | name/equipment/cost/replacement/currency/invoice/cost centre; all; name/GUID, backend restricted. |
| `pqvd_assignment` | `CO Open Assignments`, `CO Assignment History`, `CO Assignment Summaries` | number/issue/return/conditions/state; Issued, all, all respectively; issue descending, number/GUID. No canonical Contact join. |
| `pqvd_servicerequest` | `CO Open Service Requests`, `CO Service Request Summaries` | number/name/category/priority/time/state; exclude Completed/Cancelled for Open, all summaries; priority descending, number/GUID. |
| `pqvd_workorder` | `CO Open Work Orders` | number/name/due/state; exclude Completed/Cancelled; due/number/GUID. |
| `pqvd_worktask` | `CO Open Work Tasks` | sequence/name/estimate/actual/state; exclude Completed/Cancelled; sequence/GUID. |
| `pqvd_checklistitem` | `CO Checklist Items` | sequence/name/instruction/result; all; sequence/GUID. |
| `pqvd_inspection` | `CO Inspection Results` | attempt/time/result/value/unit; all; attempt/GUID. |
| `pqvd_finding` | `CO Open Findings`, `CO Finding History` | sequence/severity/description/state; exclude Completed/Cancelled or all; sequence/GUID. |

No currency view. Lookup adjustments for each custom table show name and business code/number or sequence, apply Active state where appropriate and use default-view safe sorting. Quick Find searches name/code/number, or name only for sequence tables; never salary, principal columns or secrets. Portable summary/directory views select primary-table fields only, with no all-columns selection or unrestricted Contact/Account joins.

Operational Active/Available/Assigned/Open views require standard Active state as well as the listed business-state filter. History/All/Diagnostics views deliberately include inactive rows. For Lookup and Quick Find on private terms/finance, expose name and contract reference or invoice reference only; do not add monetary values or searches. When a public default view lacks a code/number (terms/finance) or uses attempt (inspection), use name or attempt respectively before the GUID. Suggested grid widths are 220 for primary name, 140 for code/number/date and 120 for choices/numbers, with descriptions 300; FetchXML and LayoutXML must agree on every displayed field.

Consuming queries/subgrid relationships apply company/department/engagement context. Views are not authorization filters. Do not use Dataverse `eq-userid` on Contact lookups to implement portal self-access: those identities differ. Lookup names may be displayed without related-row access, so portable profiles omit hidden ancestry. [Lookup display behaviour](https://learn.microsoft.com/en-us/power-apps/maker/data-platform/create-edit-1n-relationships-portal). No Web API site settings or column-exposure views are created now.

## Integrity rules for seed checks and future backend enforcement

1. Organisation trees/reporting chains are acyclic. Organisational parents have the same root; Vendors cannot become ancestors. Root/projection columns are maintained by privileged processes.
2. Employment department belongs to the membership's Account; manager engagement belongs to the same root. Concurrent employment within/across orgs is valid. One membership per Account/Contact does not limit employment count.
3. Fixed-term employees require an end date; external contracts require a Vendor supplier and end date. End is not before start. Terms use salary for employees, day rate for contractors, with currency/contract reference. Minimum required fields are seed/backend validations, not merely Business Required flags. [Required-column enforcement boundary](https://learn.microsoft.com/en-us/power-apps/developer/model-driven-apps/troubleshoot-forms).
4. Organisation scope has no department selector. Department scope requires matching department. Engagement scope requires matching employment belonging to the grantee. For Organisation/Department scope an optional employment can sponsor the grant; it does not redefine its scope. includedescendants is false for Department/Engagement. Scope keys/selectors must agree.
5. Active principals are exclusive and match role/grantee/clock/state. All non-effective grants clear principals and intersections. Scope edits revoke old projections first. A grant can remain independent of an ended engagement when it has no employment sponsor.
6. Asset room lies inside its owning Account/subtree. Issued assignment belongs to active employment inside that owning Account/subtree. Cross-company custody/transfer is not a silent fixture shortcut. Current-assignment projection equals the sole Issued assignment; nullable-date keys cannot implement that invariant. Mutable execution requires transaction/concurrency control.
7. Request assignment, when present, references its equipment. Requester/issuer/responsible/assignee/inspector memberships belong to the service chain's root. Every task/check/inspection/finding has its specified parent; no writable redundant Account/Contact scope shortcuts.
8. Employee service history linked to their engagement remains readable after return; current-equipment projection is removed. No private HR notes or costs are stored on that shared history chain. Currency/base-value/owner/created-by metadata remain platform semantics; business custody is not ownerid.

## Fixtures and independent collision expectations

Seed three Companies: Arcwell Group, Northstar Group, Kestrel Studio. Arcwell has Services and Manufacturing subsidiaries; Services has Riverton/Hillview branches, Manufacturing Eastbank. Northstar has Services/Lakeside. Each branch has one operating unit. Kestrel is a small company with no subsidiaries. Add two Vendors: sixteen Accounts total, comprising three Companies, three subsidiaries, four branches, four units and two Vendors.

Seed two departments per branch plus one at Kestrel, twenty-four Contacts with at least thirty active engagements plus ended examples, forty-eight assets including stock/retired records, Issued/Returned history and two complete eleven-node chains under different roots. At least twelve directory members in one scope exercise paging. Use versioned seed/stable GUIDs/fixed clock `2026-10-12T09:00:00Z`, no Date.now-dependent expectations.

The prepared catalogue keeps that main inventory and adds thirty-six disposable A/B canary records for later CRUD tests. The base contains 820 records/references, 305 N:N links, 24 personas, 28 permission scenarios and 43 backend query checks. The merged stress catalogue contains 842 records/references, 434 links, 25 personas and 29 scenarios and is the environment comparison baseline. Five complete deep paths exceed the two-path minimum. Existing currency identities/rates are reused rather than changing shared environment rates; resolved IDs and observations remain ignored local evidence. Seed run/operation rows are explicitly incomplete placeholders and never represent observed portal/plugin execution. The backend query runner validates data under the application identity; the permission scenarios still require website-bound permissions and the signed-in Contact.

Seed/import order is currency and role catalogue; Account/Contact identities; Account parent/root links; organisation memberships/departments; engagements/terms; locations/equipment; assignment history; request/order/task/check/inspection/finding records; then current-assignment, manager and access-principal/scope projections. Use a two-pass loader for deferred reporting and equipment/current-assignment cycles; Company roots keep a null root lookup. A projection is never populated before its validated target exists. Deterministic GUID allocation belongs to the registry; imports match declared business keys rather than display names.

Manifest aliases include A-RIV, A-HILL, A-EAST, B-LAKE, C-STUDIO, assets EQ-A-RIV/EQ-A-HILL/EQ-B-LAKE and terms TERM-A/TERM-B. Expected outcomes below are independent oracles, not evaluator-generated output.

| Scenario ID | Same person's engagements/grants | Allowed outcome | Denial or collision explanation |
| --- | --- | --- | --- |
| `multi-org-worker` | Permanent A-RIV + contractor B-LAKE, corresponding engagement grants | Own two engagements/history, A company directory and B department directory | Other B departments, HR terms/finance denied. Home account A does not remove B access. |
| `hr-a-it-b` | HR A-RIV, IT B-LAKE | U TERM-A, U EQ-B-LAKE, R assignments in both | U EQ-A-RIV and R/U TERM-B denied; globally held web roles cannot multiply scopes. |
| `hr-it-same-org` | HR + IT A-RIV | U terms and assets there | HR's R-only asset grant does not deny IT U; no A-HILL/B access. |
| `small-company-many-hats` | Contractor engagement C-STUDIO plus HR/IT/ORGADMIN/CTO there | Union of all these roles in C | No cross-company rights or implicit System Administrator. HR may permit own terms U; approval restriction is not inferred. |
| `read-wide-write-narrow` | Auditor Arcwell subtree, IT only A-RIV | R assets A-RIV/A-HILL/A-EAST, U A-RIV | U A-HILL/A-EAST denied; broad Account Read is not IT's parent. |
| `two-branch-manager` | Branch manager A-RIV + A-HILL | R/U operational records in both and their units | No A-EAST, root Company profile or B without another grant. |
| `subsidiary-manager` | Company manager at Arcwell Services | Services/A-RIV/A-HILL/units | Manufacturing/A-EAST/Northstar denied; no implicit ancestor access. |
| `branch-manager-employee` | Branch manager + Employee A-RIV | Branch writes, company-directory Read | Directory broadening is intentional; operational Write stays narrow. Combination valid. |
| `team-and-it` | Team leader one A-RIV department, IT A-HILL | Team workforce/service A-RIV and IT A-HILL | No other A-RIV department via the same person's additional engagement. |
| `shared-contact-bridge` | Person in A-RIV and B-LAKE; viewer HR A-RIV only | A membership/employment/terms | A profile/shared person cannot grant B engagements/grants/terms. |
| `multi-grant-one-target` | Auditor/CTO/IT paths overlap on EQ-A-RIV | One row, several grant provenance entries | No duplicate rows/inflated counts or Write acquired by merging unrelated roots. |
| `role-without-scope` | Mapped web role, no corresponding effective access row | No operational access through that role | No default Authenticated/Anonymous business grants. |
| `expired-one-org` | Ended A-sponsored grants, Active B engagement/grants | B remains; A history retained backend | A projections cleared; Contact/B roles not globally revoked. |
| `deep-allow-deny` | IT A-RIV; deepest chains A-RIV/B-LAKE | Intended A Finding entitlement via all eleven nodes; qualify the single-route variant separately | B Finding must not disclose. The baseline dual-route graph may fail the platform join limit before either allowed/denied result is evaluated. |
| `append-union` | One role supplies C/U/Append, another scoped Append To | Valid binding when all record/privilege checks pass | Read alone insufficient, cross-company target denied, grant links provisioner-only. |
| `revoked-parent-tree` | Inactive parent permission in later consumer fixture | Independent active trees still contribute | Its own descendants ineffective even if child permission records Active. Business row state is not permission-record state. |

At least one persona for each single role plus these combination scenarios. The same Contact can appear in reset scenario variants. Role conflicts are cases to explain, not reasons to discard assignments.

## Implementation acceptance and review result

The implementation agent starts with solution metadata; no portal is needed. Include components explicitly in their intended solutions and preserve sibling fields/identities in any existing source. Deliver:

1. Eighteen custom tables, specified standard extensions, seventeen choices, twelve role records, all keys, listed 1:N edges plus twelve principals, and five N:N relationships. Registry includes logical/schema names, GUIDs, entity sets, navigation/intersect columns, solution ownership and language.
2. All forms/public views above, custom Lookup/Quick Find adjustments and stable IDs. Standard Account/Contact default forms/views remain intact. Portable forms/views exclude private/security/hidden-ancestor fields.
3. Invented fixtures with collision expectations and complete deep paths, correctly projected principals/scopes. Structural validation checks keys/choices/lookups/root consistency/revocation/role exclusivity; do not label it a live permission test.
4. Machine-readable permission blueprint: node ID, table, scope, relationship, parent ID, role code and individual Read/Create/Write/Delete/Append/AppendTo flags. Role codes map to the future consumer's actual web-role IDs. Contact/Parent relationship metadata and parent node references must resolve before emitting a permission record; merely putting a role code into a description is insufficient. The blueprint contains directory/profile leaves, separate role trees and the eleven-node workforce path, with no website ID or automatically installed site components.
5. Offline graph/metadata checks: all referenced fields exist; no required fixture lookup dangles; key components are non-null/unique; choice values valid; organisation and permission graphs acyclic; relationship ancestry stays role-specific; mandatory path counts eleven nodes/ten Parent edges; form/view fields and subgrids resolve. Cycles in the business relationship graph, such as equipment/current-assignment, are intentional and are not permission-tree cycles.
6. Solution pack/schema check and dependency report where local tooling supports them. Environment import validation is separately authorised; archive creation is not an import pass. Run project checks in its own package. A reusable runtime change, if needed later, requires regression tests and toolkit `npm run validate`.

The design review corrected the earlier one-active-engagement rule, role-combination ban, insufficient counted depth, generic role-field authorization assumption, shared Contact bridge, missing form/view inventory and UI/PCF scope. The project guide separates implemented target-site observations from model expectations and external dependencies. Future consumers must test role-root relationship selection, collisions/provenance, N:N traversal, deep GET/FetchXML behaviour, associations and revocation on their site/version.
