# Company Operations portal security

Website roles, table permissions and their deployment tooling for the Company Operations example, plus the tools that
qualify them on a real, isolated Power Pages site.

## What is generated

`blueprint.mjs` generates thirteen explicitly assigned web roles (the twelve business roles and `CO Test Runner`) and 253
relationship-based table permissions from the schema and fixture catalogue. `blueprint.json` is the portable component
registry; all identifiers are deterministic. Because component GUIDs are globally unique, deploy the registry to only one
site per Dataverse environment.

How the graph grants access:

- Each business root is Contact-scoped on its role-specific principal lookup; Parent permissions carry the root's role.
  Scoped Access-to-Account/Employment/Equipment/Directory projections give multi-organisation access without the Contact
  home-account shortcut. The IT workforce tree has eleven permission nodes.
- Power Pages combines privileges across roles: HR in A plus IT in B permits terms in A and asset writes in B, with no
  scope multiplication.
- Shared Contact has only the recorder's Self leaf; company directory leaves do not lead to other employments. HR terms,
  finance and protected plug-in evidence have independent rights. Grants and scope projections cannot be edited through
  these permissions.
- Delete is limited to the signed-in Contact's disposable probe and a Delete-only equipment leaf under their own TestRun
  (the plug-in additionally requires canary tagging, Stock state, no current assignment and consistent location
  ownership). Ordinary equipment has no Delete through business roles.
- There are no Global currency or vendor permissions. `reference-projections.mjs` adds two native N:N relationships to Core
  and derives reference associations from in-scope finance and HR-term records. Six roles get scoped currency/vendor Read
  leaves; only HR and Procurement get reference Append To. The guarded equipment path also needs scoped Room Read/Append
  To, which the IT, Company/Branch manager and CTO location grants provide.

Binding rights the recorder needs (each missing flag makes binding fail with `90040106`):

| Permission                                         | Rights                                         |
| -------------------------------------------------- | ---------------------------------------------- |
| Own Contact (Self)                                 | Read, Append, Append To                        |
| Own runs' Results                                  | Create, Read, Write, Append, Append To         |
| Own Probes                                         | Create, Read, Write, Delete, Append, Append To |
| Disposable equipment targets (IT Account and Room) | Read, Append, Append To                        |

`model-audit.mjs` compares the intended scope contract with independently authored fixture assertions. It is an offline
model and does not prove runtime authorization.

## Deploy

Run from the toolkit checkout against an isolated site:

```powershell
node examples/company-operations/portal-security/deploy.mjs --site <website-guid> --connection .paqvilo/dataverse/provisioning.connection.json
node examples/company-operations/portal-security/deploy.mjs --site <website-guid> --connection .paqvilo/dataverse/provisioning.connection.json --catalogue examples/company-operations/data/stress-catalogue.json --apply
node --test examples/company-operations/test/portal-security.test.mjs
```

- Without `--apply` the script reads configuration and saves a plan; it writes nothing. Apply creates or reconciles only the
  registered CO components and adds fixture Contact-to-role links, verifies native content and Contact associations, and
  requires zero remaining changes. The journal and before/after snapshots stay in ignored `.paqvilo/portal-security/`.
  Uncertain writes are not retried; rerun the plan to reconcile GUIDs first.
- The site must use the enhanced data model with traditional authorization (`datamodelversion=2.0`,
  `enhancedauthorization=0`). Web roles and permissions are native `powerpagecomponent` types 11 and 18; role links are read
  from the component JSON (`adx_entitypermission_webrole`) because the virtual permission-to-role N:N read can come back
  empty. Contact assignments use `powerpagecomponent_mspp_webrole_contact`.
- Apply refuses a site with active Parent permissions whose native parent is missing or inactive, anywhere on the site, and
  any effective default-Authenticated or Anonymous Global business grant: either would contaminate the scoped graph.

**Never deactivate only a parent permission.** With a parent inactive and its children active, both Liquid and the Web API
returned every targeted fixture record across organisation boundaries. Revoke access through grant principals, projections
or role membership, and deactivate a complete subtree when removing its parent.

## Deep-chain variant

With both the workforce and equipment-service routes active, the IT persona's Checklist, Inspection and Finding reads exceed
the 15-link FetchXML limit (`0x8004430d` from the Web API, a query error in Liquid). That is the baseline's expected
outcome. To test the eleven-node workforce path itself, `deep-variant.mjs` temporarily disables all six secondary IT service
nodes (Request, Order, Task, Checklist, Inspection, Finding):

```powershell
node examples/company-operations/portal-security/deep-variant.mjs --site <website-guid> --connection .paqvilo/dataverse/provisioning.connection.json --timeout-seconds 600 --apply
node examples/company-operations/portal-security/deep-variant.mjs --site <website-guid> --connection .paqvilo/dataverse/provisioning.connection.json --restore-journal <ignored-lease-journal> --apply
```

- The variant changes expected unassigned-equipment visibility; use `configureDeepVariant`'s oracle, never the baseline one.
- It journals the before-state, disables leaf-to-root and restores root-to-leaf with ETags. These are sequential writes, not
  a transaction; restoration runs in `finally`, on the release file, on timeout and on handled signals. After a forced kill,
  `--restore-journal` validates the organisation and the archived content of all six nodes before restoring; drift refuses
  writes.
- Refresh the site's configuration cache after activation, run the variant cases, create the printed release file, confirm
  the journal says `restored`, and refresh the cache again. Do not overlap the lease with other writes to these components.

## Package the portal solution

```powershell
node examples/company-operations/portal-security/package.mjs --site <website-guid> --connection .paqvilo/dataverse/provisioning.connection.json --apply --export
```

`package.mjs` creates and reconciles `PaqviloCompanyOperationsPortal` after the schema, support and plug-in solutions. It
discovers the environment's solution component types, adds the site, its languages and configuration components, verifies a
single site membership and exports/unpacks into ignored evidence. It includes the site's original (inactive) sample grants
so exported default roles keep the isolation. Contact-role memberships are data, recreated from the catalogue.

## Role variants and a real tester

`role-variant.mjs` switches the `P-STRESS` persona between 0, 1, 2, 4, 8 and 12 business roles, keeping `CO Test Runner` and
unrelated assignments, after checking the Contact's seed person code:

```powershell
node examples/company-operations/portal-security/role-variant.mjs --role-count 2 --connection .paqvilo/dataverse/provisioning.connection.json --apply
node examples/company-operations/portal-security/role-variant.mjs --role-count 12 --connection .paqvilo/dataverse/provisioning.connection.json --apply
```

Restore twelve roles afterwards. A successful Dataverse assignment does not mean the portal session uses the new roles:
sign in again or refresh the security cache and check the Liquid role snapshot before reading a query-budget result.

For a real signed-in tester, `tester-overlay.mjs` builds a private catalogue overlay from a Contact GUID, and
`bind-tester.mjs` binds that Contact to an IT appointment, prepares twelve-role stress data, controls role counts and resets:

```powershell
node examples/company-operations/portal-security/bind-tester.mjs --contact <contact-guid> --site <website-guid> --mode baseline --connection .paqvilo/dataverse/provisioning.connection.json --apply
node examples/company-operations/portal-security/bind-tester.mjs --contact <contact-guid> --site <website-guid> --mode stress --connection .paqvilo/dataverse/provisioning.connection.json --apply
node examples/company-operations/portal-security/bind-tester.mjs --contact <contact-guid> --site <website-guid> --mode roles --role-count 12 --connection .paqvilo/dataverse/provisioning.connection.json --apply
node examples/company-operations/portal-security/bind-tester.mjs --contact <contact-guid> --site <website-guid> --mode reset --connection .paqvilo/dataverse/provisioning.connection.json --apply
```

- Without `--apply` these are read-only plans. `--out` sets an ignored evidence directory, `--catalogue` a merged catalogue
  and `--overlay` an existing overlay whose actor matches the command.
- The tool never creates or edits the Contact and preserves unrelated web-role links. Rows are preflighted before the first
  write; before-state and ETags are journalled. Existing drift or extra projection targets cause refusal.
- Reset conditionally revokes managed grants, removes only authored projection targets, verifies null principals and empty
  projections, and restores IT plus Test Runner without deleting history. Reopening revoked grants needs
  `--allow-managed-reset`.
- Pass the overlay and resolved IDs to the page compiler to regenerate query filters and persona oracles. Real IDs and
  histories stay under ignored `.paqvilo/`.

## Native configuration campaign

`configurationCampaignDomain({ schema, catalogue })` builds 2,251 permission configurations (2,117 from the configuration
grammar, six roleless-ancestor cases and 128 Equipment lifecycle graphs), a separate denominator from the role-subset read
campaign. `odataAdmissionCohorts` adds a 14-configuration, 34-cell OData admission domain. Generating either qualifies
nothing; only native cells compared with Mirage replay do.

`runNativeConfigurationCampaign` runs one to 32 configurations per batch under a reversible component, membership and
Contact Account lease. It needs the public Dataverse client, the source blueprint, schema and catalogue, resolved baseline
references, organisation, site and controller Contact IDs, an ignored `.paqvilo` directory,
`allowNativeConfigurationMutation: true`, `baseRoleCampaignFreezeActive: false`, and these adapters (missing ones are an
error):

| Adapter                       | Must                                                                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `assertExclusiveNativeWriter` | Confirm the sole writer owns this organisation, site and actor, and the base-role campaign is released.                                 |
| `provisionFixtures`           | Create planned disposable records with the trusted SDK identity, write-ahead journals and exact readbacks, without disabling any guard. |
| `verifyFixtures`              | Return the bindings, fixture snapshot hash, actor and Account GUIDs.                                                                    |
| `prepareCell`                 | Reset the operation target and its lookup targets before reading source state.                                                          |
| `readSourceWitnesses`         | Return the five native hashes `sealConfigurationWitnesses` needs, read fresh before each cell.                                          |
| `clearPortalCaches`           | Run both `clearConfig` and `clearCache` and return both receipts.                                                                       |
| `collectNativeCell`           | Run the Liquid/Web API read or portal CRUD and keep every page, HTTP bytes, identity, witnesses, plug-in parts and history.             |
| `replayNativeCell`            | Run the same operation locally with the frozen graph, data and original DLL, returning actual local output.                             |
| `recoverFixtures`             | Reconcile journalled pending writes without blindly repeating uncertain mutations.                                                      |
| `cleanupFixtures`             | Restore all regions and return `{ verified: true, allRegionsRestored: true, snapshotSha256 }` from readbacks.                           |

`createNativeConfigurationAdapters` provides concrete implementations over the Dataverse client and the native-browser
bridge; supply only the sole-writer assertion, cache control, leased Liquid endpoint and replay bootstrap callbacks.
Credentials stay outside source.

Each read cell needs two independent cache-controlled native observations that agree on source hashes, memberships, rows,
HTTP outcomes and backend bytes before it is compared with replay. Incomplete, differing or ambiguous cells stay gaps.
After a power cut, run `recoverNativeConfigurationCampaign({ directory, domainHash, client, adapters, organisationId })`: it
restores pending leases, cleans fixtures, checks readbacks and clears both caches before releasing the writer lock.

## References

[Table permission scopes and child roles](https://learn.microsoft.com/en-us/power-pages/security/table-permissions),
[web roles](https://learn.microsoft.com/en-us/power-pages/security/create-web-roles),
[enhanced data model](https://learn.microsoft.com/en-us/power-pages/admin/enhanced-data-model),
[native site components](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/powerpagecomponent?view=dataverse-latest),
[solution component types](https://learn.microsoft.com/en-us/power-pages/configure/power-platform-cli-solution-management),
[FetchXML join limit](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/fetchxml/join-tables),
[multi-level Web API issue](https://learn.microsoft.com/en-us/power-pages/configure/web-api-overview).
