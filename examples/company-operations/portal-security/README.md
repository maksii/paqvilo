# Company Operations portal security

Web roles and table permissions for the Company Operations example, the tools that deploy them to one isolated Power
Pages site, and the tools that vary them for qualification. The permission design is in the
[data model](../../../docs/design/company-operations-demo.md#counted-permission-paths).

Every command except the offline planners writes to a live Dataverse environment and website. Run them only against
an isolated site you are authorized to change. All take `--connection <file>` (default
`.paqvilo/dataverse/provisioning.connection.json`, relative to the current directory), verify the saved organisation
before any request, and keep journals and before/after snapshots under the project's ignored
`.paqvilo/portal-security/`. Run them from the toolkit checkout.

## What is generated

`blueprint.mjs` builds 13 web roles (the twelve business roles plus `CO Test Runner`, none anonymous or
authenticated-default) and 253 table permissions from the schema and catalogue; `blueprint.json` is the committed result
from the stress catalogue. All identifiers are deterministic, and component GUIDs are globally unique, so deploy the
registry to only one site per Dataverse environment.

- Each business role has its own Contact-scoped root on its role principal lookup and its own Parent trees beneath it
  (`<ROLE>-<PATH>-<TABLE>` keys). Scoped Access-to-Account, Employment, Equipment and Directory projections give
  multi-organisation access without the Contact home-account shortcut.
- Power Pages adds privileges across roles: HR in A plus IT in B permits terms in A and asset writes in B, with no scope
  multiplication, because no root uses the generic grantee lookup.
- Shared Contact has only the recorder's Self leaf. HR terms, finance and plug-in evidence have independent trees. Grants
  and scope projections are never editable through these permissions.
- No business role has Delete. The only Delete grants are the recorder's own disposable probes and a Delete-only
  equipment leaf under the runner's own TestRun (the plug-in also requires a `CO-CANARY-` tag, Stock state, no current
  assignment and consistent location ownership).
- There are no Global permissions. `reference-projections.mjs` adds the `pqvd_access_currencies` and
  `pqvd_access_referenceaccounts` N:N relationships to Core; six roles (Company manager, Branch manager, HR, Procurement,
  Auditor, CTO) get scoped currency and vendor Read leaves, and only HR and Procurement get reference Append To. The
  guarded equipment path also needs scoped Room Read and Append To, which the IT, Company/Branch manager and CTO location
  trees provide.

`CO Test Runner` binding rights (each missing flag makes binding fail with `90040106`):

| Permission                               | Rights                                         |
| ---------------------------------------- | ---------------------------------------------- |
| Own Contact (Self)                       | Read, Append, Append To                        |
| Own runs, their results and operations   | Create, Read, Write, Append, Append To         |
| Own probes                               | Create, Read, Write, Delete, Append, Append To |
| Events and chain nodes of own operations | Read                                           |
| Canary equipment of own runs             | Delete                                         |

`model-audit.mjs` (`auditScenarioOracles`, `evaluateConfiguredGraph`) checks the intended scope contract against the
independently authored scenario assertions. It is an offline model, not runtime authorization.

## Deploy

```powershell
node examples/company-operations/portal-security/deploy.mjs --site <website-guid> --catalogue examples/company-operations/data/stress-catalogue.json
node examples/company-operations/portal-security/deploy.mjs --site <website-guid> --catalogue examples/company-operations/data/stress-catalogue.json --apply
```

- Every run rebuilds and rewrites `blueprint.json` from `--catalogue` (default `data/catalogue.json`, which drops the
  stress persona's assignments), so always pass the stress catalogue.
- Without `--apply` it reads the site and saves a plan. Apply creates or reconciles only the registered CO components,
  adds the fixture Contact-to-role links, verifies native content and associations, and requires zero remaining changes.
  Uncertain writes are not retried; rerun the plan to reconcile GUIDs first.
- The site must use the enhanced data model with traditional authorization (`datamodelversion=2.0`,
  `enhancedauthorization=0`). Roles and permissions are `powerpagecomponent` types 11 and 18. Role links are read from
  the component JSON (`adx_entitypermission_webrole`) because the virtual permission-to-role N:N read can return empty.
  Contact assignments use `powerpagecomponent_mspp_webrole_contact`.
- Apply refuses a site that has any active Parent permission whose parent is missing or inactive, or any effective
  Anonymous or default-Authenticated Global business grant: either contaminates the scoped graph. `--variant` is
  refused outright.

**Never deactivate only a parent permission.** With a parent inactive and its children active, Liquid and the Web API
both returned every targeted fixture record across organisation boundaries. Revoke access through grant principals,
projections or role membership, and deactivate a whole subtree when removing its parent.

## Deep-chain variant

With both the workforce and equipment-service routes active, the IT persona's Checklist, Inspection and Finding reads
exceed the 15-link FetchXML limit after permission expansion (`0x8004430d` from the Web API, a query error in Liquid).
That is the expected baseline outcome. To test the eleven-node workforce path alone, `deep-variant.mjs` temporarily
disables the six secondary IT equipment-service nodes (Request, Order, Task, Checklist, Inspection, Finding):

```powershell
node examples/company-operations/portal-security/deep-variant.mjs --site <website-guid> --timeout-seconds 600 --apply
node examples/company-operations/portal-security/deep-variant.mjs --site <website-guid> --restore-journal <journal-under-.paqvilo> --apply
```

- `--apply` is mandatory; `--timeout-seconds` is 10 to 1800 (default 600); `--out` must stay under `.paqvilo/`.
- It journals the before-state, disables leaf-to-root and restores root-to-leaf with ETags. These are sequential writes,
  not a transaction. Restoration runs on exit, on the printed release file, on timeout and on handled signals. After a
  forced kill, `--restore-journal` checks the organisation and the archived content of all six nodes first; drift
  refuses the write.
- Refresh the site configuration cache after activation, run the variant cases, create the release file, confirm the
  journal says `restored`, and refresh the cache again. Do not write to these components while the lease is held.
- The variant changes unassigned-equipment visibility: use `configureDeepVariant`'s oracle, not the baseline one.

## Package the portal solution

```powershell
node examples/company-operations/portal-security/package.mjs --site <website-guid> --apply --export
```

Creates and reconciles `PaqviloCompanyOperationsPortal` after the schema, support and plug-in solutions. It discovers
the environment's solution component types, adds the site, its languages and configuration components, checks that the
site belongs to one solution only, and exports and unpacks into `.paqvilo/portal-security/portal-solution/`. It
includes the site's original inactive sample grants so exported default roles keep the isolation. Contact-role
memberships are data, recreated from the catalogue.

## Role variants and a real tester

`role-variant.mjs` switches the `P-STRESS` persona between 0, 1, 2, 4, 8 and 12 business roles, keeping
`CO Test Runner` and unrelated assignments, after checking the Contact's seeded person code:

```powershell
node examples/company-operations/portal-security/role-variant.mjs --role-count 2 --apply
node examples/company-operations/portal-security/role-variant.mjs --role-count 12 --apply
```

Restore twelve roles afterwards. A changed Dataverse assignment does not mean the portal session uses it: sign in again
or refresh the security cache and check the Liquid role snapshot before reading a query-budget result.

For a real signed-in tester, `bind-tester.mjs` binds an existing Contact to an IT appointment (overlay built by
`tester-overlay.mjs`), prepares twelve-role stress data, sets role counts and resets:

```powershell
node examples/company-operations/portal-security/bind-tester.mjs --contact <contact-guid> --site <website-guid> --mode baseline --apply
node examples/company-operations/portal-security/bind-tester.mjs --contact <contact-guid> --site <website-guid> --mode stress --apply
node examples/company-operations/portal-security/bind-tester.mjs --contact <contact-guid> --site <website-guid> --mode roles --role-count 12 --apply
node examples/company-operations/portal-security/bind-tester.mjs --contact <contact-guid> --site <website-guid> --mode reset --apply
```

- Without `--apply` these are read-only plans. `--out` sets the evidence directory (must be under `.paqvilo/`),
  `--catalogue` a merged catalogue (default stress) and `--overlay` an existing private overlay for the same Contact.
- It never creates or edits the Contact and keeps unrelated web-role links. Rows are preflighted before the first write
  and the before-state and ETags are journalled; existing drift or extra projection targets cause refusal.
- Reset conditionally revokes managed grants, removes only authored projection targets, verifies null principals and
  empty projections, and restores IT plus Test Runner without deleting history. Reopening revoked grants in `baseline`
  or `stress` mode needs `--allow-managed-reset`.
- Pass the overlay and resolved IDs to the harness compiler to regenerate query filters and persona oracles.

## Native configuration campaign

`configurationCampaignDomain({ schema, catalogue })` (in `qualification-campaign.mjs`) names 2,251 permission
configurations: 2,117 from the configuration grammar, six roleless-ancestor cases and 128 Equipment lifecycle graphs,
a denominator separate from the role-subset read campaign. `odataAdmissionCohorts` adds a 14-configuration, 34-cell
OData admission domain. Generating a domain qualifies nothing; only native cells compared with Mirage replay do.

`runNativeConfigurationCampaign` mutates the live site: it runs 1 to 32 configurations per call (`maxConfigurations`)
under a reversible component, membership and Contact Account lease. It requires `allowNativeConfigurationMutation: true`,
`baseRoleCampaignFreezeActive: false`, a `directory` under `.paqvilo/`, the Dataverse client, domain, blueprint, schema,
catalogue, resolved IDs, organisation, site and actor Contact IDs, and all ten adapters:

| Adapter                       | Must                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| `assertExclusiveNativeWriter` | Confirm the sole writer owns this organisation, site and actor, and the base-role campaign is released. |
| `provisionFixtures`           | Create the planned disposable records with journals and exact readbacks, without disabling any guard.   |
| `verifyFixtures`              | Return the bindings, fixture snapshot hash, actor and Account GUIDs.                                    |
| `prepareCell`                 | Reset the operation target and its lookup targets before reading source state.                          |
| `readSourceWitnesses`         | Return the five native hashes `sealConfigurationWitnesses` needs, read fresh before each cell.          |
| `clearPortalCaches`           | Run both `clearConfig` and `clearCache` and return both receipts.                                       |
| `collectNativeCell`           | Run the Liquid/Web API read or portal CRUD and keep pages, HTTP bytes, identity, witnesses and history. |
| `replayNativeCell`            | Run the same operation in Mirage with the frozen graph, data and original DLL.                          |
| `recoverFixtures`             | Reconcile journalled pending writes without repeating uncertain mutations.                              |
| `cleanupFixtures`             | Restore all regions and return `{ verified: true, allRegionsRestored: true, snapshotSha256 }`.          |

`createNativeConfigurationAdapters` (in `qualification-native-adapters.mjs`) implements the rest over the Dataverse
client and the native browser bridge; you supply only `assertExclusiveNativeWriter`, `clearPortalCaches`,
`liquidEndpointForConfiguration` and `replayNativeCell`.

A read cell counts only when two independent cache-controlled native observations agree on source hashes, memberships,
rows, HTTP outcomes and backend bytes and then match replay; anything else stays a gap. After a crash, run
`recoverNativeConfigurationCampaign({ directory, domainHash, client, adapters, organisationId })`: it restores pending
leases, cleans fixtures, checks readbacks and clears both caches before releasing `writer.lock`.

## Offline planners

These read local files only:

| Command                                                                                                 | Output                                                                            |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `qualification-plan.mjs --manifest <deployed-harness-manifest> [--witnesses <map.json>] [--out <file>]` | Plan-only role-mask and scope-hierarchy domain, listing missing native witnesses. |
| `permission-order-plan.mjs <private-job.json>`                                                          | Permission-order probe from a frozen native snapshot.                             |
| `odata-permission-diagnostic.mjs <private-job.json>`                                                    | OData permission-filter diagnostic from a frozen native snapshot.                 |

Run them with `node examples/company-operations/portal-security/<script>`. Outputs, witness files and jobs must stay
under `.paqvilo/`.

## References

[Table permission scopes and child roles](https://learn.microsoft.com/en-us/power-pages/security/table-permissions),
[web roles](https://learn.microsoft.com/en-us/power-pages/security/create-web-roles),
[enhanced data model](https://learn.microsoft.com/en-us/power-pages/admin/enhanced-data-model),
[native site components](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/powerpagecomponent?view=dataverse-latest),
[solution component types](https://learn.microsoft.com/en-us/power-pages/configure/power-platform-cli-solution-management),
[FetchXML join limit](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/fetchxml/join-tables),
[multi-level Web API issue](https://learn.microsoft.com/en-us/power-pages/configure/web-api-overview).
