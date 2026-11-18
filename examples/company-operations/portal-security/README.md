# Company Operations portal security

Website roles, table permissions and their deployment tooling for the Company Operations example, plus the tools that
qualify them on a real, isolated Power Pages site.

## What is generated

`blueprint.mjs` generates thirteen explicitly assigned web roles (the twelve business roles and `CO Test Runner`) and
253 relationship-based table permissions from the schema and fixture catalogue. `blueprint.json` is the portable
component registry; all identifiers are deterministic. Because component GUIDs are globally unique, deploy the registry
to only one site per Dataverse environment.

How the graph grants access:

- Each business root is Contact-scoped on its role-specific principal lookup; Parent permissions carry the root's role.
  Scoped Access-to-Account/Employment/Equipment/Directory projections give multi-organization access without the Contact
  home-account shortcut. The IT workforce tree has eleven permission nodes.
- Power Pages combines privileges across roles: HR in A plus IT in B permits terms in A and asset writes in B, with no
  scope multiplication.
- Shared Contact has only the recorder's Self leaf; company directory leaves do not lead to other employments. HR terms,
  finance and protected plug-in evidence have independent rights. Grants and scope projections cannot be edited through
  these permissions.
- Delete is limited to the signed-in Contact's disposable probe and a Delete-only equipment leaf under their own TestRun
  (the plug-in additionally requires canary tagging, Stock state, no current assignment and consistent location
  ownership). Ordinary equipment has no Delete through business roles.
- There are no Global currency or vendor permissions. `reference-projections.mjs` adds two native N:N relationships to
  Core and derives reference associations from in-scope finance and HR-term records. Six roles get scoped
  currency/vendor Read leaves; only HR and Procurement get reference Append To. The guarded equipment path also needs
  scoped Room Read/Append To, which the IT, Company/Branch manager and CTO location grants provide.

`CO Test Runner` permissions (no Global scope, no business writes). A missing Append or Append To flag makes the
recorder's lookup binding fail with `90040106` (observed live):

| Permission (scope)                                        | Rights                                         |
| --------------------------------------------------------- | ---------------------------------------------- |
| Own Contact (Self)                                        | Read, Append, Append To                        |
| Own test runs (Contact)                                   | Create, Read, Write, Append, Append To         |
| Results and operations of own runs (Parent)               | Create, Read, Write, Append, Append To         |
| Plug-in events and chain nodes of own operations (Parent) | Read                                           |
| Own CRUD probes (Contact)                                 | Create, Read, Write, Delete, Append, Append To |
| Canary equipment of own runs (Parent)                     | Delete                                         |

Binding a disposable equipment canary also needs Read, Append and Append To on its Account and Room, which the IT
workforce and location grants provide.

`model-audit.mjs` (a module, run by `test/portal-security.test.mjs`) compares the intended scope contract with
independently authored fixture assertions. It is an offline model and does not prove runtime authorization.

## Deploy

Run from the toolkit checkout, after `npm install` in `examples/company-operations`, against an isolated site you are
authorized to change. The plan reads the live environment; `--apply` writes to it.

```powershell
node examples/company-operations/portal-security/deploy.mjs --site <website-guid> --catalogue examples/company-operations/data/stress-catalogue.json --connection .paqvilo/dataverse/provisioning.connection.json
node examples/company-operations/portal-security/deploy.mjs --site <website-guid> --connection .paqvilo/dataverse/provisioning.connection.json --catalogue examples/company-operations/data/stress-catalogue.json --apply
node --test examples/company-operations/test/portal-security.test.mjs
```

- `--catalogue FILE` and a canonical `--site` GUID are required: use the catalogue you loaded with `data:apply` (the
  stress catalogue by default) for both plan and apply. The connection defaults to
  `.paqvilo/dataverse/provisioning.connection.json` in the toolkit checkout, whatever the working directory; paths you
  pass resolve from the working directory. Its organization GUID is required and verified before site inspection.
  `--help` reads no catalogue, connection or blueprint. The other tools on this page use the same connection default.
- Without `--apply` the script performs remote reads and saves a local plan and before-snapshot under the example's
  ignored `.paqvilo/portal-security/`; it makes no Dataverse writes. It prints the roles (13), permissions (253),
  fixture persona assignments, `changes` and `activeOrphans`; with zero changes, `--apply` writes nothing and only
  verifies. The selected catalogue is compiled in memory and
  deployment never rewrites the committed `portal-security/blueprint.json`. Apply creates or reconciles only the
  registered CO components and adds fixture Contact-to-role links, verifies native content and Contact associations,
  and requires zero remaining changes. Journals and before/after snapshots stay in that ignored evidence directory.
  Uncertain writes are not retried; rerun the plan to reconcile GUIDs first.
- The site must use the enhanced data model with traditional authorization (`datamodelversion=2.0`,
  `enhancedauthorization=0`). Web roles and permissions are native `powerpagecomponent` types 11 and 18; role links are
  read from the component JSON (`adx_entitypermission_webrole`) because the virtual permission-to-role N:N read can come
  back empty. Contact assignments use `powerpagecomponent_mspp_webrole_contact`.
- Apply refuses a site with any active Parent-scope permission whose native parent is missing or inactive, anywhere on
  the site, and any active Global permission on a business table, Account or Contact held by the default Authenticated
  or Anonymous role: either would contaminate the scoped graph. The plan records both without refusing.

**Never deactivate only a parent permission.** With a parent inactive and its descendants still active, the surviving
child's parent condition degrades to a non-null lookup: both Liquid and the Web API returned fixture records of the
descendant tables across organization boundaries and agreed with each other while both failed the oracle (observed
live; Mirage replays it only through an evidenced `tablePermissionOrphans: "unrestricted"` site observation). Revoke
access through grant principals, projections or role membership, and deactivate a complete subtree when removing its
parent.

## Deep-chain variant

With both the workforce and equipment-service routes active, the IT persona's Checklist, Inspection and Finding reads
exceed the 15-link FetchXML limit (`0x8004430d` from the Web API, a query error in Liquid; observed live). That is the
baseline's expected outcome. To test the eleven-node workforce path itself, `deep-variant.mjs` temporarily disables all
six secondary IT service nodes (Request, Order, Task, Checklist, Inspection, Finding) on the live site. Both commands
write; run them only against an isolated site you are authorized to change:

```powershell
node examples/company-operations/portal-security/deep-variant.mjs --site <website-guid> --connection .paqvilo/dataverse/provisioning.connection.json --timeout-seconds 600 --apply
node examples/company-operations/portal-security/deep-variant.mjs --site <website-guid> --connection .paqvilo/dataverse/provisioning.connection.json --restore-journal <ignored-lease-journal> --apply
```

- `--apply` is required, `--timeout-seconds` is 10 to 1800 (default 600), and the journal goes to `--out` (default
  `examples/company-operations/.paqvilo/portal-security/deep-variant/`); `--out` and `--restore-journal` must be under
  an ignored `.paqvilo`.
- The variant changes expected unassigned-equipment visibility; evaluate expectations against the graph returned by
  `configureDeepVariant(blueprint)`, never the baseline graph.
- It journals the before-state, disables leaf-to-root and restores root-to-leaf with ETags. These are sequential writes,
  not a transaction; restoration runs in `finally`, on the release file, on timeout and on handled signals. After a
  forced kill, `--restore-journal` validates the organization, site and the archived content of all six nodes before
  restoring; drift refuses writes.
- Refresh the site's configuration cache after activation, run the variant cases, create the printed release file,
  confirm the journal says `restored`, and refresh the cache again. Do not overlap the lease with other writes to these
  components.

## Package the portal solution

```powershell
node examples/company-operations/portal-security/package.mjs --site <website-guid> --connection .paqvilo/dataverse/provisioning.connection.json --apply --export
```

`package.mjs` creates and reconciles `PaqviloCompanyOperationsPortal` after the schema, support and plug-in solutions;
the `PaqviloCompanyOperations` publisher must already exist. Without `--apply` it saves a read-only plan; `--apply`
creates the solution and adds missing members on the live environment, and `--export` (only with `--apply`) exports and
unpacks into the example's ignored `.paqvilo/portal-security/`. The plan prints the number of site components and how
many are not yet members (`added`); its journal goes to `.paqvilo/portal-security/portal-solution/`. It discovers the
environment's solution component types, adds the site, its languages and every site component, and verifies a single
site membership. Because it adds every component, the site's original sample grants, deactivated before deployment,
travel with it, so exported default roles keep the isolation. Contact-role memberships are data, recreated from the
catalogue.

## Role variants and a real tester

`role-variant.mjs` switches the `P-STRESS` persona between 0, 1, 2, 4, 8 and 12 business roles, keeping
`CO Test Runner` and unrelated assignments, after checking the Contact's seed person code. Without `--apply` it saves a
read-only plan; `--apply` changes the live role links:

```powershell
node examples/company-operations/portal-security/role-variant.mjs --role-count 2 --connection .paqvilo/dataverse/provisioning.connection.json --apply
node examples/company-operations/portal-security/role-variant.mjs --role-count 12 --connection .paqvilo/dataverse/provisioning.connection.json --apply
```

Restore twelve roles afterwards. A successful Dataverse assignment does not mean the portal session uses the new roles:
sign in again or refresh the security cache and check the Liquid role snapshot before reading a query-budget result.

For a real signed-in tester, `bind-tester.mjs` binds an existing Contact to an IT appointment, prepares twelve-role
stress data, controls role counts and resets. It builds the private catalogue overlay for that Contact with
`tester-overlay.mjs` and saves it as `overlay.json` beside its journal in the evidence directory (default
`examples/company-operations/.paqvilo/portal-security/tester-<first 8 characters of the Contact GUID>/`):

```powershell
node examples/company-operations/portal-security/bind-tester.mjs --contact <contact-guid> --site <website-guid> --mode baseline --connection .paqvilo/dataverse/provisioning.connection.json --apply
node examples/company-operations/portal-security/bind-tester.mjs --contact <contact-guid> --site <website-guid> --mode stress --connection .paqvilo/dataverse/provisioning.connection.json --apply
node examples/company-operations/portal-security/bind-tester.mjs --contact <contact-guid> --site <website-guid> --mode roles --role-count 12 --connection .paqvilo/dataverse/provisioning.connection.json --apply
node examples/company-operations/portal-security/bind-tester.mjs --contact <contact-guid> --site <website-guid> --mode reset --connection .paqvilo/dataverse/provisioning.connection.json --apply
```

- Without `--apply` these are plans that read the live environment and write only local evidence. `--out` sets an
  evidence directory under an ignored `.paqvilo`, `--catalogue` a merged catalogue and `--overlay` an existing overlay
  whose actor matches `--contact`. `--role-count` is used only with `--mode roles`. For a Contact that is already
  bound, pass the overlay saved at binding time: an overlay rebuilt from the catalogue is refused when any stored
  private value differs from it.
- The tool never creates or edits the Contact and preserves unrelated web-role links. Rows are preflighted before the
  first write; before-state and ETags are journalled. Existing drift or extra projection targets cause refusal.
- Reset conditionally revokes managed grants, removes only authored projection targets, verifies null principals and
  empty projections, and restores IT plus Test Runner without deleting history. Reopening revoked grants needs
  `--allow-managed-reset`.
- Set the saved overlay as `overlayFile` and the resolved IDs as `resolvedIds` in the
  [harness deploy configuration](../portal-harness/README.md#prepare-and-deploy) to regenerate query filters and persona
  oracles. Real IDs and histories stay under ignored `.paqvilo/`.

## Offline planning and diagnostics

Run from the toolkit checkout; these make no native requests and write only under an ignored `.paqvilo`:

```powershell
node examples/company-operations/portal-security/qualification-plan.mjs --manifest examples/company-operations/.paqvilo/portal-harness/generated/manifest.json
```

- `qualification-plan.mjs` plans the role qualification campaign (12 business roles, 4,096 role masks) from the harness
  manifest; `--manifest` is required and must be the manifest that was deployed (the harness compiler and deployer both
  write it to `.paqvilo/portal-harness/generated/manifest.json`), not the Dataverse schema manifest. `--witnesses` maps
  the five native witness names to frozen snapshots under `.paqvilo`; missing ones are listed. `--out` defaults to
  `examples/company-operations/.paqvilo/portal-security/qualification-<timestamp>.json`.
- `odata-permission-diagnostic.mjs <private-job.json>` replays a frozen native OData permission capture, and
  `permission-order-plan.mjs <private-job.json>` plans permission-order probes from private captures. Both need private
  captures; their job's `output` must be under an ignored `.paqvilo`.

## Native configuration campaign

These are library functions in `qualification-campaign.mjs`, `odata-admission-cohorts.mjs` and
`qualification-native-adapters.mjs`, called from a private project script; there is no command for them. The run
changes live permissions, memberships and fixtures, so it needs an isolated environment you are authorized to change.

`configurationCampaignDomain({ schema, catalogue })` builds 2,251 permission configurations (2,117 from the
configuration grammar, six roleless-ancestor cases and 128 Equipment lifecycle graphs), a separate denominator from the
role-subset read campaign. `odataAdmissionCohorts` adds a 14-configuration, 34-cell OData admission domain. Generating
either qualifies nothing; only native cells compared with Mirage replay do.

`runNativeConfigurationCampaign` runs one to 32 configurations per batch under a reversible component, membership and
Contact Account lease. It needs the public Dataverse client, the source blueprint, schema and catalogue, resolved
baseline references, organization, site and controller Contact IDs, an ignored `.paqvilo` directory,
`allowNativeConfigurationMutation: true`, `baseRoleCampaignFreezeActive: false`, and these adapters (missing ones are
an error):

| Adapter                       | Must                                                                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `assertExclusiveNativeWriter` | Confirm the sole writer owns this organization, site and actor, and the base-role campaign is released.                                 |
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

Each read cell needs two independent cache-controlled native observations that agree on source hashes, memberships,
rows, HTTP outcomes and backend bytes before it is compared with replay. Incomplete, differing or ambiguous cells stay
gaps. After a power cut, run `recoverNativeConfigurationCampaign({ directory, domainHash, client, adapters,
organisationId })`: it restores pending leases, cleans fixtures, checks readbacks and clears both caches before
releasing the writer lock.

## References

[Table permission scopes and child roles](https://learn.microsoft.com/en-us/power-pages/security/table-permissions),
[web roles](https://learn.microsoft.com/en-us/power-pages/security/create-web-roles),
[enhanced data model](https://learn.microsoft.com/en-us/power-pages/admin/enhanced-data-model),
[native site components](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/powerpagecomponent?view=dataverse-latest),
[solution component types](https://learn.microsoft.com/en-us/power-pages/configure/power-platform-cli-solution-management),
[FetchXML join limit](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/fetchxml/join-tables),
[multi-level Web API issue](https://learn.microsoft.com/en-us/power-pages/configure/web-api-overview).
