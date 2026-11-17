# Company Operations example: data model

Design of the synthetic [Company Operations example](../../examples/company-operations/README.md): an invented
organisation and workforce model with simultaneous memberships, twelve combinable roles and deep permission paths. The
[permission harness](power-pages-permission-test-harness.md) and [plug-in observations](dataverse-plugin-observation.md)
build on it. These are model contracts, not proof of any environment's installed state.

`examples/company-operations/prepare-schema.mjs` generates `dataverse/manifest.json` by parsing four sections of this
document (**Tables columns and keys**, **Choices and twelve roles**, **Access permission projections**, **Single target
relationships and cascade settings**) plus the schema sections of the two companion documents. Keep those headings and
table rows exact; any edit to them must regenerate the committed manifest (`npm run schema:prepare`), and the project's
schema test fails when the two disagree.

## Solutions

| Solution                         | Contents                                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `PaqviloCompanyOperationsCore`   | 19 custom business/reference tables, Account/Contact/Transaction Currency extensions, 17 choices, keys and relationships. |
| `PaqviloCompanyOperationsForms`  | Named forms and views (depends on Core).                                                                                  |
| `PaqviloPermissionTestSupport`   | Run, result and probe tables (harness design).                                                                            |
| `PaqviloPluginEvidence`          | Operation, event and chain-node tables (plug-in design).                                                                  |
| `PaqviloBehaviorPlugins`         | Plug-in assemblies and steps, plus the result/probe/equipment extension columns.                                          |
| `PaqviloCompanyOperationsPortal` | The website and its configuration (built by `portal-security/package.mjs`).                                               |

Publisher prefix `pqvd`, option value prefix `18327`, version `1.0.0.0`, language `1033`. In total: **28 tables, 25
custom**. Create metadata through the [Dataverse provisioning API](../dataverse-provisioning.md) and export the
server-generated solutions; never hand-author table XML instead. Segmented native exports need their tables to exist,
so they are update packages, not first-install packages
([segmentation limits](https://learn.microsoft.com/en-us/power-platform/alm/segmented-solutions-alm)).

Keep the plain account demo intact and never copy its global account grants (including anonymous Read). Do not reuse
business `pqvd_finding` for technical observations. No marker columns are added to business tables: query correlation
uses the existing primary-name columns (`account.name`, `contact.fullname`, `transactioncurrency.currencyname`,
`pqvd_name`) with the reserved `CO-UTC:` and `CO-OP:` prefixes defined in the plug-in design. Markers correlate
requests; they confer no access.

## Official permission model and design consequences

| Platform rule                                                                                                     | Consequence for this model                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Portal identities are Contacts; web roles provide cumulative access                                               | One person may combine roles. No invented deny precedence or ban on conflicting responsibilities. [Power Pages security](https://learn.microsoft.com/en-us/power-pages/security/power-pages-security). |
| Contact access follows a relationship to the signed-in Contact; Account access uses their associated account      | Multi-organisation membership needs explicit rows and relationships, not one `parentcustomerid`. [Access scopes](https://learn.microsoft.com/en-us/power-pages/security/table-permissions).            |
| Child permissions name a relationship and inherit parent roles                                                    | Separate capability trees per role. A custom Role column is not an authorization filter. [Parent and child permissions](https://learn.microsoft.com/en-us/power-pages/security/table-permissions).     |
| Polymorphic lookups are unsupported in parent/child permissions                                                   | Every deep-chain lookup is single-target; the standard customer lookup is never a chain anchor.                                                                                                        |
| Web API column permissions do not protect every data surface                                                      | Private HR terms and finance are separate tables; forms and views are not security boundaries. [Column permissions](https://learn.microsoft.com/en-us/power-pages/security/column-permissions).        |
| Multi-level scoped 1:N/N:N permissions have a documented Web API GET issue; FetchXML is the documented workaround | Keep the graph and qualify it per site and version; never add Global Read as a workaround. [Known issues](https://learn.microsoft.com/en-us/power-pages/configure/web-api-overview).                   |

Authorization is traditional relationship-based table permissions, with no preview Custom Access dependency, and zero
Global roots for business, directory, grant or role-catalogue tables. Web roles are distinct from backend Dataverse
security roles. Microsoft documents no maximum permission depth and nothing about the performance of an eleven-table
graph, so each target site is qualified by the harness.

## Organisation membership and employment

Account represents Company, Subsidiary, Region, Branch, Operating unit or Vendor. Organisational Accounts share a root
Company; Vendors sit outside the trees. Branches are not Dataverse business units. Company roots have no parent and a
null `pqvd_rootaccountid` (Dataverse rejects a Company-to-itself root link as a hierarchy loop); descendants store their
Company's GUID; Vendors have no organisational root.

Contact is a shared person. `pqvd_orgcontact` is that person's membership in one organisational Account, with work
contact details there. A person may have several memberships and concurrent engagements (for example permanent in A and
contracting in B); there is no one-active-engagement rule and no cross-company FTE total. Roles are independent of
engagement kind, and ending one engagement revokes only the grants it sponsors.

```text
Company/branch Account
  -> Organisation contact membership -> shared Contact (identity leaf)
    -> Employment / contract
      -> Assignment -> Service request -> Work order -> Work task
        -> Checklist item -> Inspection attempt -> Finding

Account -> Site -> Building -> Room -> Equipment -> Equipment finance
Account -> Department -> Employment -> Private employment terms
```

Never route operational permissions `Account -> shared Contact -> all employments`: access to a Contact through A would
expose its B engagements. Workforce permissions traverse the organisation-specific membership; a shared-Contact display
grant, if ever needed, is a Read-only leaf.

## Metadata conventions

Nineteen organisation-owned custom business/reference tables (not activity, virtual or elastic), each with GUID key
`<logicalname>id`, primary name `pqvd_name` Text(160), standard timestamps and Active/Inactive state. Standard
Account/Contact ownership and security roles are unchanged; ChainNode is user/team-owned to test Assign.

Inventory notation: `!` = Business Required plus mandatory seed validation, otherwise nullable. `S` = system-maintained.
`L(table)` = single-target lookup. `Date` = DateOnly; `Time` = UserLocal date/time. Workload is a decimal 0..1, weekly
hours 0..168, money nonnegative; counts and minutes are nonnegative; sequence and attempt start at 1; floor and measured
values may be signed. Codes, numbers and GUIDs come from the seed registry, not autonumbers. Alternate keys have no
secured columns; wait for Active indexes before importing data; null key values do not enforce uniqueness
([key constraints](https://learn.microsoft.com/en-us/power-apps/maker/data-platform/define-alternate-keys-reference-records)).

## Tables columns and keys

| Table / entity set                                    | Additional columns                                                                                                                                                                                                                                                                                                                                                                                                                                         | Alternate key definitions                                                                                                                                                                                                       |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `account` / `accounts`                                | Standard `name`, `accountnumber`, `parentaccountid`; `pqvd_orgkind` Choice!, `pqvd_rootaccountid` L(account) S                                                                                                                                                                                                                                                                                                                                             | `pqvd_ak_account_number`: account number, required for demo records. Root lookup required for descendants; null for Company/Vendor. Company canonical root = its own ID.                                                        |
| `contact` / `contacts`                                | Standard first/last/full name, email/telephone, `parentcustomerid`; `pqvd_personcode` Text(40)!                                                                                                                                                                                                                                                                                                                                                            | `pqvd_ak_contact_personcode`: person code. Customer lookup is optional default/home context, not a membership/security anchor.                                                                                                  |
| `transactioncurrency` / `transactioncurrencies`       | Standard ID, name, ISO code, precision, exchange rate                                                                                                                                                                                                                                                                                                                                                                                                      | System Money dependency; reuse existing currencies and rates. Direct native observer registration/execution is not assumed.                                                                                                     |
| `pqvd_currencyreference` / `pqvd_currencyreferences`  | `pqvd_code` Text(3)!, `pqvd_symbol` Text(10), `pqvd_precision` Integer(0..4), `pqvd_systemcurrencyid` L(transactioncurrency)!                                                                                                                                                                                                                                                                                                                              | `pqvd_ak_currencyreference_code`: ISO code; `pqvd_ak_currencyreference_currency`: required system-currency lookup. Enforces at most one reference per system currency; a required lookup is N:1, not a native 1:1 relationship. |
| `pqvd_accessrole` / `pqvd_accessroles`                | `pqvd_code` Text(24)!, `pqvd_description` Text(1000), `pqvd_principalcolumn` Text(80)!                                                                                                                                                                                                                                                                                                                                                                     | `pqvd_ak_accessrole_code`: code. Twelve business role records; not Dataverse/website security-role records.                                                                                                                     |
| `pqvd_accesspermission` / `pqvd_accesspermissions`    | `pqvd_number` Text(40)!, `pqvd_granteecontactid` L(contact)!, `pqvd_scopeaccountid` L(account)!, `pqvd_roleid` L(pqvd_accessrole)!, `pqvd_scopekind` Choice!, `pqvd_scopekey` Text(40)! S, `pqvd_includedescendants` Boolean!, `pqvd_departmentid` L(pqvd_department), `pqvd_employmentid` L(pqvd_employment), `pqvd_validfrom` Time!, `pqvd_validuntil` Time, `pqvd_accessstate` Choice!, `pqvd_reason` Text(1000); twelve principal columns below, all S | `pqvd_ak_accesspermission_number`: number. `pqvd_ak_accesspermission_scope`: grantee, scope Account, role, scope key. Scope key is ORG-SELF, ORG-TREE, DEPT-<32 hex GUID> or ENG-<32 hex GUID>, never null.                     |
| `pqvd_orgcontact` / `pqvd_orgcontacts`                | `pqvd_code` Text(40)!, `pqvd_accountid` L(account)!, `pqvd_contactid` L(contact)!, `pqvd_displayname` Text(160)!, `pqvd_workemail` Text(254), `pqvd_workphone` Text(40), `pqvd_membershipstate` Choice!                                                                                                                                                                                                                                                    | `pqvd_ak_orgcontact_code`: code. `pqvd_ak_orgcontact_member`: Account + Contact. No salary, personal address or identity-provider fields.                                                                                       |
| `pqvd_department` / `pqvd_departments`                | `pqvd_code` Text(40)!, `pqvd_accountid` L(account)!, `pqvd_managerorgcontactid` L(pqvd_orgcontact), `pqvd_description` Text(1000)                                                                                                                                                                                                                                                                                                                          | `pqvd_ak_department_code`: Account + code. Manager is a membership in the same Account.                                                                                                                                         |
| `pqvd_employment` / `pqvd_employments`                | `pqvd_number` Text(40)!, `pqvd_orgcontactid` L(pqvd_orgcontact)!, `pqvd_departmentid` L(pqvd_department)!, `pqvd_manageremploymentid` L(pqvd_employment), `pqvd_engagementkind` Choice!, `pqvd_ftefraction` Decimal!, `pqvd_startdate` Date!, `pqvd_enddate` Date, `pqvd_jobtitle` Text(100)!, `pqvd_supplieraccountid` L(account), `pqvd_employmentstate` Choice!                                                                                         | `pqvd_ak_employment_number`: number. Organisation/person derive from membership; no redundant writable Account/Contact lookup.                                                                                                  |
| `pqvd_employmentterms` / `pqvd_employmenttermrecords` | `pqvd_employmentid` L(pqvd_employment)!, `pqvd_annualsalary` Money, `pqvd_dayrate` Money, standard `transactioncurrencyid` L(transactioncurrency)!, `pqvd_weeklyhours` Decimal, `pqvd_noticeperioddays` Integer, `pqvd_contractreference` Text(80)!                                                                                                                                                                                                        | `pqvd_ak_employmentterms_employment`: employment. Unique required lookup enforces optional 0:1 dependent, not a native 1:1 relationship.                                                                                        |
| `pqvd_site` / `pqvd_sites`                            | `pqvd_code` Text(40)!, `pqvd_accountid` L(account)!, `pqvd_address` Text(500), `pqvd_sitekind` Choice!                                                                                                                                                                                                                                                                                                                                                     | `pqvd_ak_site_code`: Account + code.                                                                                                                                                                                            |
| `pqvd_building` / `pqvd_buildings`                    | `pqvd_code` Text(40)!, `pqvd_siteid` L(pqvd_site)!, `pqvd_floors` Integer                                                                                                                                                                                                                                                                                                                                                                                  | `pqvd_ak_building_code`: site + code.                                                                                                                                                                                           |
| `pqvd_room` / `pqvd_rooms`                            | `pqvd_code` Text(40)!, `pqvd_buildingid` L(pqvd_building)!, `pqvd_floor` Integer, `pqvd_capacity` Integer, `pqvd_roomkind` Choice!                                                                                                                                                                                                                                                                                                                         | `pqvd_ak_room_code`: building + code. Floor can be negative, capacity cannot.                                                                                                                                                   |
| `pqvd_equipment` / `pqvd_equipments`                  | `pqvd_assettag` Text(40)!, `pqvd_serialnumber` Text(100), `pqvd_accountid` L(account)!, `pqvd_roomid` L(pqvd_room), `pqvd_equipmentkind` Choice!, `pqvd_manufacturer` Text(100), `pqvd_model` Text(100), `pqvd_condition` Choice!, `pqvd_equipmentstate` Choice!, `pqvd_currentassignmentid` L(pqvd_assignment) S, `pqvd_purchasedate` Date, `pqvd_warrantyend` Date                                                                                       | `pqvd_ak_equipment_tag`: tag. Serial deliberately not unique. Owning organisation and physical placement are different relationships.                                                                                           |
| `pqvd_equipmentfinance` / `pqvd_equipmentfinances`    | `pqvd_equipmentid` L(pqvd_equipment)!, `pqvd_purchasecost` Money!, `pqvd_replacementvalue` Money, standard `transactioncurrencyid` L(transactioncurrency)!, `pqvd_supplieraccountid` L(account), `pqvd_invoicereference` Text(80), `pqvd_costcentre` Text(40)                                                                                                                                                                                              | `pqvd_ak_equipmentfinance_equipment`: equipment. Costs never enter shared equipment views.                                                                                                                                      |
| `pqvd_assignment` / `pqvd_assignments`                | `pqvd_number` Text(40)!, `pqvd_equipmentid` L(pqvd_equipment)!, `pqvd_employmentid` L(pqvd_employment)!, `pqvd_issuedat` Time, `pqvd_returnedat` Time, `pqvd_issuerorgcontactid` L(pqvd_orgcontact), `pqvd_issuecondition` Choice, `pqvd_returncondition` Choice, `pqvd_assignmentstate` Choice!                                                                                                                                                           | `pqvd_ak_assignment_number`: number. Payload-bearing history association; one Issued assignment per asset needs execution-time validation.                                                                                      |
| `pqvd_servicerequest` / `pqvd_servicerequests`        | `pqvd_number` Text(40)!, `pqvd_equipmentid` L(pqvd_equipment)!, `pqvd_assignmentid` L(pqvd_assignment), `pqvd_requesterorgcontactid` L(pqvd_orgcontact)!, `pqvd_requestkind` Choice!, `pqvd_priority` Choice!, `pqvd_description` Multiline(4000)!, `pqvd_reportedat` Time!, `pqvd_workstate` Choice!                                                                                                                                                      | `pqvd_ak_servicerequest_number`: number. Assignment optional for stock maintenance, present in the mandatory deep fixture.                                                                                                      |
| `pqvd_workorder` / `pqvd_workorders`                  | `pqvd_number` Text(40)!, `pqvd_requestid` L(pqvd_servicerequest)!, `pqvd_responsibleorgcontactid` L(pqvd_orgcontact), `pqvd_duedate` Date, `pqvd_workstate` Choice!                                                                                                                                                                                                                                                                                        | `pqvd_ak_workorder_number`: number.                                                                                                                                                                                             |
| `pqvd_worktask` / `pqvd_worktasks`                    | `pqvd_workorderid` L(pqvd_workorder)!, `pqvd_sequence` Integer!, `pqvd_assigneeorgcontactid` L(pqvd_orgcontact), `pqvd_estimatedminutes` Integer, `pqvd_actualminutes` Integer, `pqvd_workstate` Choice!                                                                                                                                                                                                                                                   | `pqvd_ak_worktask_sequence`: order + sequence.                                                                                                                                                                                  |
| `pqvd_checklistitem` / `pqvd_checklistitems`          | `pqvd_taskid` L(pqvd_worktask)!, `pqvd_sequence` Integer!, `pqvd_instruction` Text(1000)!, `pqvd_checkresult` Choice!                                                                                                                                                                                                                                                                                                                                      | `pqvd_ak_checklistitem_sequence`: task + sequence.                                                                                                                                                                              |
| `pqvd_inspection` / `pqvd_inspections`                | `pqvd_checklistitemid` L(pqvd_checklistitem)!, `pqvd_attempt` Integer!, `pqvd_inspectororgcontactid` L(pqvd_orgcontact)!, `pqvd_inspectedat` Time!, `pqvd_checkresult` Choice!, `pqvd_measuredvalue` Decimal(4), `pqvd_measurementunit` Text(24)                                                                                                                                                                                                           | `pqvd_ak_inspection_attempt`: checklist item + attempt. Supports repeated verification attempts.                                                                                                                                |
| `pqvd_finding` / `pqvd_findings`                      | `pqvd_inspectionid` L(pqvd_inspection)!, `pqvd_sequence` Integer!, `pqvd_severity` Choice!, `pqvd_description` Multiline(4000)!, `pqvd_workstate` Choice!                                                                                                                                                                                                                                                                                                  | `pqvd_ak_finding_sequence`: inspection + sequence. Defects/remedial findings from inspections.                                                                                                                                  |

## Choices and twelve roles

Ordered labels map to values 183270000, 183270001 and so on within each choice.

| Choice                 | Ordered labels                                                          |
| ---------------------- | ----------------------------------------------------------------------- |
| `pqvd_orgkind`         | Company, Subsidiary, Region, Branch, Operating unit, Vendor             |
| `pqvd_scopekind`       | Organisation, Department, Engagement                                    |
| `pqvd_accessstate`     | Pending, Active, Suspended, Expired, Revoked                            |
| `pqvd_membershipstate` | Pending, Active, Suspended, Ended                                       |
| `pqvd_engagementkind`  | Permanent employee, Fixed-term employee, External contractor            |
| `pqvd_employmentstate` | Draft, Active, Suspended, Ended                                         |
| `pqvd_sitekind`        | Office, Workshop, Warehouse                                             |
| `pqvd_roomkind`        | Office, Meeting room, Workshop, Storage                                 |
| `pqvd_equipmentkind`   | Laptop, Phone, Network, Production equipment, Vehicle, Safety equipment |
| `pqvd_condition`       | New, Good, Worn, Damaged                                                |
| `pqvd_equipmentstate`  | Stock, Assigned, In repair, Retired                                     |
| `pqvd_assignmentstate` | Planned, Issued, Returned, Cancelled                                    |
| `pqvd_requestkind`     | Fault, Inspection, Replacement                                          |
| `pqvd_priority`        | Low, Normal, High, Critical                                             |
| `pqvd_workstate`       | New, Planned, In progress, Blocked, Completed, Cancelled                |
| `pqvd_checkresult`     | Not run, Pass, Fail, Not applicable                                     |
| `pqvd_severity`        | Advisory, Minor, Major, Critical                                        |

`pqvd_issuecondition` and `pqvd_returncondition` bind to `pqvd_condition`; every other choice column binds to the
choice of the same name. Defaults: includedescendants false, membership and access state Pending, employment state
Draft, assignment state Planned, equipment state Stock, work state New, check result Not run. Other choices have no
default, so no authorization-relevant value is ever implied.

Each role principal is a nullable Contact lookup on Access permission with relationship
`pqvd_contact_access_<lowercase code>`:

| Code             | Name                       | Principal column                 | Typical scope                            |
| ---------------- | -------------------------- | -------------------------------- | ---------------------------------------- |
| `COMPANYMANAGER` | Company manager            | `pqvd_companymanagerprincipalid` | Company/subsidiary subtree               |
| `BRANCHMANAGER`  | Branch manager             | `pqvd_branchmanagerprincipalid`  | Branch subtree                           |
| `TEAMLEADER`     | Team leader                | `pqvd_teamleaderprincipalid`     | Department                               |
| `EMPLOYEE`       | Employee                   | `pqvd_employeeprincipalid`       | Selected permanent/fixed-term engagement |
| `CONTRACTOR`     | External contractor        | `pqvd_contractorprincipalid`     | Selected external-contract engagement    |
| `HR`             | HR officer                 | `pqvd_hrprincipalid`             | Organisation/subtree                     |
| `IT`             | IT asset administrator     | `pqvd_itprincipalid`             | Organisation/subtree                     |
| `FACILITIES`     | Facilities coordinator     | `pqvd_facilitiesprincipalid`     | Branch/subtree                           |
| `PROCUREMENT`    | Procurement officer        | `pqvd_procurementprincipalid`    | Organisation/subtree                     |
| `AUDITOR`        | Operations auditor         | `pqvd_auditorprincipalid`        | Organisation/subtree                     |
| `ORGADMIN`       | Organisation administrator | `pqvd_orgadminprincipalid`       | Organisation/subtree                     |
| `CTO`            | CTO                        | `pqvd_ctoprincipalid`            | Company/subsidiary subtree               |

OrgAdmin administers operational structure and the directory, not the environment, website or grant provisioning. CTO
has technical scope, not payroll.

## Access permission projections

An Access permission row is one grantee, role and scope, optionally sponsored by an employment. An Active, effective row
has exactly one role principal set (to the grantee); every other state has all principals null. A saved-view filter is
not authorization.

Each role's root is Contact-scoped on its own principal relationship (for example `pqvd_contact_access_it`). A generic
root on `pqvd_granteecontactid` would match every role's rows and multiply scopes, so it is never used for operational
descendants.

| Relationship                     | Participants                                        | Intersect columns                                     |
| -------------------------------- | --------------------------------------------------- | ----------------------------------------------------- |
| `pqvd_access_accounts`           | `pqvd_accesspermission` ↔ `account`                 | `pqvd_accesspermissionid`, `accountid`                |
| `pqvd_access_orgcontacts`        | `pqvd_accesspermission` ↔ `pqvd_orgcontact`         | `pqvd_accesspermissionid`, `pqvd_orgcontactid`        |
| `pqvd_access_departments`        | `pqvd_accesspermission` ↔ `pqvd_department`         | `pqvd_accesspermissionid`, `pqvd_departmentid`        |
| `pqvd_access_employments`        | `pqvd_accesspermission` ↔ `pqvd_employment`         | `pqvd_accesspermissionid`, `pqvd_employmentid`        |
| `pqvd_access_currencyreferences` | `pqvd_accesspermission` -> `pqvd_currencyreference` | `pqvd_accesspermissionid`, `pqvd_currencyreferenceid` |
| `pqvd_access_equipments`         | `pqvd_accesspermission` ↔ `pqvd_equipment`          | `pqvd_accesspermissionid`, `pqvd_equipmentid`         |

`portal-security/reference-projections.mjs` adds `pqvd_access_currencies` (to `transactioncurrency`) and
`pqvd_access_referenceaccounts` (to Vendor accounts) for the scoped reference leaves. Intersect entity names equal the
relationship names, with no payload columns.

- Organisation grants link the anchor Account and, only with includedescendants, its descendants; never ancestors,
  siblings or another Company.
- Department grants link the department and its active employments directly, avoiding a membership-to-all-engagements
  bridge for people in several departments.
- Employee/Contractor grants link the selected engagement and membership; their equipment projection holds only Issued
  assignments for that engagement. Directory membership links (Employee: the root Company; Contractor: its department)
  have no Employment children.
- Non-Active grants have no intersections. Revocation or expiry clears principals and links; business-row state alone
  revokes nothing. Seed data materialises the projections; no reconciler is installed, so association writes stay
  provisioner-only.

## Single target relationships and cascade settings

The referenced table holds the primary key; the referencing table holds the lookup.

| Relationship schema                   | Referenced table      | Referencing table        | Lookup                         |
| ------------------------------------- | --------------------- | ------------------------ | ------------------------------ |
| `pqvd_account_root`                   | `account`             | `account`                | `pqvd_rootaccountid`           |
| `pqvd_contact_access_grantee`         | `contact`             | `pqvd_accesspermission`  | `pqvd_granteecontactid`        |
| `pqvd_account_access_scope`           | `account`             | `pqvd_accesspermission`  | `pqvd_scopeaccountid`          |
| `pqvd_accessrole_access`              | `pqvd_accessrole`     | `pqvd_accesspermission`  | `pqvd_roleid`                  |
| `pqvd_department_access`              | `pqvd_department`     | `pqvd_accesspermission`  | `pqvd_departmentid`            |
| `pqvd_employment_access`              | `pqvd_employment`     | `pqvd_accesspermission`  | `pqvd_employmentid`            |
| `pqvd_account_orgcontacts`            | `account`             | `pqvd_orgcontact`        | `pqvd_accountid`               |
| `pqvd_contact_orgcontacts`            | `contact`             | `pqvd_orgcontact`        | `pqvd_contactid`               |
| `pqvd_account_departments`            | `account`             | `pqvd_department`        | `pqvd_accountid`               |
| `pqvd_orgcontact_manageddepartments`  | `pqvd_orgcontact`     | `pqvd_department`        | `pqvd_managerorgcontactid`     |
| `pqvd_orgcontact_employments`         | `pqvd_orgcontact`     | `pqvd_employment`        | `pqvd_orgcontactid`            |
| `pqvd_department_employments`         | `pqvd_department`     | `pqvd_employment`        | `pqvd_departmentid`            |
| `pqvd_employment_reports`             | `pqvd_employment`     | `pqvd_employment`        | `pqvd_manageremploymentid`     |
| `pqvd_account_suppliedemployments`    | `account`             | `pqvd_employment`        | `pqvd_supplieraccountid`       |
| `pqvd_employment_terms`               | `pqvd_employment`     | `pqvd_employmentterms`   | `pqvd_employmentid`            |
| `pqvd_account_sites`                  | `account`             | `pqvd_site`              | `pqvd_accountid`               |
| `pqvd_site_buildings`                 | `pqvd_site`           | `pqvd_building`          | `pqvd_siteid`                  |
| `pqvd_building_rooms`                 | `pqvd_building`       | `pqvd_room`              | `pqvd_buildingid`              |
| `pqvd_transactioncurrency_references` | `transactioncurrency` | `pqvd_currencyreference` | `pqvd_systemcurrencyid`        |
| `pqvd_account_equipments`             | `account`             | `pqvd_equipment`         | `pqvd_accountid`               |
| `pqvd_room_equipments`                | `pqvd_room`           | `pqvd_equipment`         | `pqvd_roomid`                  |
| `pqvd_assignment_currentequipment`    | `pqvd_assignment`     | `pqvd_equipment`         | `pqvd_currentassignmentid`     |
| `pqvd_equipment_finance`              | `pqvd_equipment`      | `pqvd_equipmentfinance`  | `pqvd_equipmentid`             |
| `pqvd_account_equipmentvendors`       | `account`             | `pqvd_equipmentfinance`  | `pqvd_supplieraccountid`       |
| `pqvd_equipment_assignments`          | `pqvd_equipment`      | `pqvd_assignment`        | `pqvd_equipmentid`             |
| `pqvd_employment_assignments`         | `pqvd_employment`     | `pqvd_assignment`        | `pqvd_employmentid`            |
| `pqvd_orgcontact_issuedassignments`   | `pqvd_orgcontact`     | `pqvd_assignment`        | `pqvd_issuerorgcontactid`      |
| `pqvd_assignment_requests`            | `pqvd_assignment`     | `pqvd_servicerequest`    | `pqvd_assignmentid`            |
| `pqvd_equipment_requests`             | `pqvd_equipment`      | `pqvd_servicerequest`    | `pqvd_equipmentid`             |
| `pqvd_orgcontact_requests`            | `pqvd_orgcontact`     | `pqvd_servicerequest`    | `pqvd_requesterorgcontactid`   |
| `pqvd_request_workorders`             | `pqvd_servicerequest` | `pqvd_workorder`         | `pqvd_requestid`               |
| `pqvd_orgcontact_responsibleorders`   | `pqvd_orgcontact`     | `pqvd_workorder`         | `pqvd_responsibleorgcontactid` |
| `pqvd_workorder_tasks`                | `pqvd_workorder`      | `pqvd_worktask`          | `pqvd_workorderid`             |
| `pqvd_orgcontact_assignedtasks`       | `pqvd_orgcontact`     | `pqvd_worktask`          | `pqvd_assigneeorgcontactid`    |
| `pqvd_task_checklistitems`            | `pqvd_worktask`       | `pqvd_checklistitem`     | `pqvd_taskid`                  |
| `pqvd_checklistitem_inspections`      | `pqvd_checklistitem`  | `pqvd_inspection`        | `pqvd_checklistitemid`         |
| `pqvd_orgcontact_inspections`         | `pqvd_orgcontact`     | `pqvd_inspection`        | `pqvd_inspectororgcontactid`   |
| `pqvd_inspection_findings`            | `pqvd_inspection`     | `pqvd_finding`           | `pqvd_inspectionid`            |

Plus the twelve Contact principal relationships from the role table. Organisation parents reuse the standard
`account_parent_account`; root-account and employment-manager relationships are not hierarchical.

New 1:N relationships use NoCascade for Assign, Share, Unshare and Reparent, and Restrict for Delete, including optional
links, so history is retained. Merge is NoCascade for custom parents and Cascade for Account/Contact parents, because
Dataverse enforces that. Standard Account parent cascades are unchanged. Cascade behaviour grants no portal scope.

## Observable currency reference contract

`pqvd_currencyreference` is immutable reference data mapped one-to-one (by alternate keys, not a native 1:1) to the
reused system currencies; it never mirrors or changes exchange rates. It gives the plug-in observer and the harness a
custom currency table to observe (R21), since direct observation of system Currency is not assumed; system-Currency
gaps stay explicit. Money fields keep the standard
`transactioncurrencyid` lookup. Six roles (Company manager, Branch manager, HR, Procurement, Auditor, CTO) get
Read-only reference leaves through `pqvd_access_currencyreferences` and separate system-currency Read leaves through
`pqvd_access_currencies`; only HR and Procurement get Append To for money bindings. Portal Create, Update and Delete and
projection writes are rejected. No reference table has Global visibility.

## Counted permission paths

The signed-in Contact is the anchor, not a counted level. Mandatory IT workforce path:

| Level | Table                   | Scope and relationship                   | Parent      |
| ----- | ----------------------- | ---------------------------------------- | ----------- |
| 1     | `pqvd_accesspermission` | Contact, `pqvd_contact_access_it`        | None        |
| 2     | `account`               | Parent, `pqvd_access_accounts` N:N       | IT level 1  |
| 3     | `pqvd_orgcontact`       | Parent, `pqvd_account_orgcontacts`       | IT level 2  |
| 4     | `pqvd_employment`       | Parent, `pqvd_orgcontact_employments`    | IT level 3  |
| 5     | `pqvd_assignment`       | Parent, `pqvd_employment_assignments`    | IT level 4  |
| 6     | `pqvd_servicerequest`   | Parent, `pqvd_assignment_requests`       | IT level 5  |
| 7     | `pqvd_workorder`        | Parent, `pqvd_request_workorders`        | IT level 6  |
| 8     | `pqvd_worktask`         | Parent, `pqvd_workorder_tasks`           | IT level 7  |
| 9     | `pqvd_checklistitem`    | Parent, `pqvd_task_checklistitems`       | IT level 8  |
| 10    | `pqvd_inspection`       | Parent, `pqvd_checklistitem_inspections` | IT level 9  |
| 11    | `pqvd_finding`          | Parent, `pqvd_inspection_findings`       | IT level 10 |

Eleven nodes and ten Parent edges exceed eight under either counting convention. The path is kept even though IT also
has a shorter equipment route; inspections and findings are real records, not depth padding.

Employee/Contractor path: Access -> Employment (`pqvd_access_employments`) -> Assignment -> Request -> Order -> Task ->
Checklist -> Inspection -> Finding, nine nodes. Directory and profile grants are separate leaves without workforce
children.

Trees are cloned per role, never per person or organisation, with node keys `<ROLE>-<PATH>-<TABLE>` (for example
`IT-WORKFORCE-ACCESSPERMISSION` to `IT-WORKFORCE-FINDING`). Every child has one parent and its root's web role. Several
trees may reach the same rows; one role's aggregated Account Read is never another role's parent. Secondary routes
(only for roles granted them): Account -> Equipment -> Requests -> service descendants; Account -> Site -> Building ->
Room; Account -> Department -> Employment; Employment -> Terms; Equipment -> Finance; Access -> projected Equipment.

## Role privileges and collisions

R = Read, C = Create, U = Write. No business role has Delete; Access roots are Read-only; association rights are
explicit. Privileges are additive: a missing U in one role never denies another. `portal-security/blueprint.json` holds
the exact per-node flags.

| Role           | Organisation / departments           | Directory memberships       | Employment                   | Private terms | Equipment / assignment    | Finance | Locations | Service chain                                     |
| -------------- | ------------------------------------ | --------------------------- | ---------------------------- | ------------- | ------------------------- | ------- | --------- | ------------------------------------------------- |
| COMPANYMANAGER | RCU subtree                          | RCU subtree                 | R                            | —             | RCU / RCU                 | R       | RCU       | RCU                                               |
| BRANCHMANAGER  | RU anchor, RCU units/departments     | RCU subtree                 | R                            | —             | RCU / RCU                 | R       | RCU       | RCU                                               |
| TEAMLEADER     | R profile leaf / selected department | R team leaf                 | R projected team engagements | —             | R team / R team           | —       | —         | RCU team work                                     |
| EMPLOYEE       | R own/root profiles                  | R company directory leaf    | R selected own engagement    | —             | R current / R own history | —       | —         | R engagement history/current equipment; C request |
| CONTRACTOR     | R own profile                        | R department directory leaf | R selected own engagement    | —             | R current / R own history | —       | —         | R engagement history/current equipment; C request |
| HR             | R                                    | RCU                         | RCU                          | RCU           | R / R                     | —       | —         | —                                                 |
| IT             | R                                    | R                           | R operational                | —             | RCU / RCU                 | —       | R         | RCU                                               |
| FACILITIES     | R                                    | R                           | —                            | —             | R / —                     | —       | RCU       | RCU equipment route                               |
| PROCUREMENT    | R profile leaf                       | —                           | —                            | —             | RC / —                    | RCU     | —         | —                                                 |
| AUDITOR        | R                                    | R                           | R operational                | —             | R / R                     | R       | R         | R                                                 |
| ORGADMIN       | RCU                                  | RCU                         | R operational                | —             | R / R                     | —       | RCU       | R                                                 |
| CTO            | R                                    | R                           | R operational                | —             | RCU / RCU                 | R       | R         | RCU                                               |

Every cell is bounded by its own grant's scope. Branch manager plus Employee broadens directory Read while keeping branch
equipment Write narrow. HR in A plus IT in B gives terms only in A and equipment Write only in B. OrgAdmin and CTO give
no HR access. Separation-of-duties approval is business logic outside this model, not a fabricated permission denial.

Lookup binding needs C or U on the source, Append on the referencing record and Append To plus Read on the target; the
rights may come from different roles when both scopes cover the records. Creating a record does not by itself give
future Read: the new row needs a valid parent and projection maintenance.
([Dataverse access rights](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/security-access-rights)).

## Forms and views

`forms/catalogue.mjs` generates the named forms, public views and Lookup/Quick Find adjustments; `npm run forms:apply`
installs them. The rules it follows:

- New named main forms with platform controls only (no scripts, PCF, iframes or custom actions); standard Account and
  Contact forms and system views stay intact. Each custom table has an Administration form; portable profile/summary
  forms and views select primary-table fields only, omitting private, security and hidden-ancestor fields.
- Public views have explicit FetchXML attributes matching LayoutXML, deterministic sort ending with the GUID, and
  operational filters that also require Active state. Private terms and finance views and searches expose names and
  references only, never amounts; Quick Find never searches salary, principals or secrets.
- Views are not authorization. Never use `eq-userid` on Contact lookups for portal self-access: portal Contacts and
  Dataverse users are different identities. Lookup names display without related-row access, so portable profiles omit
  ancestry. Web API site settings belong to the harness, not this model.

## Integrity rules for seed checks and backend enforcement

1. Organisation trees and reporting chains are acyclic; organisational parents share the root; Vendors are never
   ancestors.
2. An employment's department belongs to its membership's Account; a manager engagement is in the same root. One
   membership per Account and Contact does not limit employment count.
3. Fixed-term employees need an end date; external contracts need a Vendor supplier and an end date; end is not before
   start. Terms use salary for employees and a day rate for contractors.
4. Organisation scope has no department selector; Department scope needs a matching department; Engagement scope needs
   an employment of the grantee; includedescendants is false for Department and Engagement scope.
5. Active principals are exclusive and match role, grantee, clock and state; scope edits revoke old projections first.
6. An asset's room lies inside its owning Account subtree; an Issued assignment belongs to an active employment there;
   the current-assignment projection equals the sole Issued assignment (nullable-date keys cannot enforce this).
7. A request's assignment references its equipment; requester, issuer, responsible, assignee and inspector memberships
   belong to the service chain's root.
8. Employee service history stays readable after return while the current-equipment projection is removed; business
   custody is never `ownerid`.

## Fixtures

Three invented Companies (Arcwell Group with Services and Manufacturing subsidiaries, Northstar Group, Kestrel Studio),
branches with one operating unit each, two Vendors, departments, Contacts with concurrent engagements, equipment with
Issued and Returned history, and five complete deep chains under different roots. The fixed clock is
`2026-10-12T09:00:00Z`; GUIDs are deterministic. Existing currency identities and rates are reused. Counts are in the
[project guide](../../examples/company-operations/README.md).

Each catalogue `scenarios` entry is an independently authored oracle: a persona, target IDs, the privilege and whether
it is allowed, with the reason. Sixteen cover role combinations (`multi-org-worker`, `hr-a-it-b`, `hr-it-same-org`,
`small-company-many-hats`, `read-wide-write-narrow`, `two-branch-manager`, `subsidiary-manager`,
`branch-manager-employee`, `team-and-it`, `shared-contact-bridge`, `multi-grant-one-target`, `role-without-scope`,
`expired-one-org`, `deep-allow-deny`, `append-union`, `revoked-parent-tree`) and twelve cover single roles; the stress
catalogue adds one. Role conflicts are cases to explain, never reasons to drop an assignment.

Load order: currencies and role catalogue; Account and Contact identities; Account parent and root links; memberships and
departments; engagements and terms; locations and equipment; assignment history; the service chain; then
current-assignment, manager and principal/scope projections. A two-pass loader handles the deferred reporting and
equipment/current-assignment cycles; imports match declared business keys, never display names.

## Source5 cohort

Source5 is an optional, separately qualified schema revision: the support solution adds a nullable
`pqvd_crudprobe.pqvd_equipmentid` through `pqvd_equipment_crudprobes` (Delete RemoveLink, everything else NoCascade),
and `pqvd_testoperation.pqvd_variant` grows from 40 to 128 characters because `TARGET:<GUID>` alone needs 43. It adds
no table or permission and keeps all 253 permission node IDs. The default `prepare-schema.mjs` run reproduces Source4;
Source5 needs `--cohort source5 --out <separate file>` and its own provisioning and recordings. The harness and plug-in
designs define its fixtures and guards.
