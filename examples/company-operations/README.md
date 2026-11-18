# Company Operations regression project

A separate, synthetic project that provisions an invented organization and workforce model into a Dataverse
environment, deploys a deep Power Pages permission graph and a single-page permission harness on top of it, and records
what Liquid, the portal Web API and Dataverse plug-ins actually do. Mirage parity work replays those recordings. Nothing
here enters `lense/` or `mirage/`; reusable provisioning is [`paqvilo dataverse`](../../docs/dataverse-provisioning.md).

| Part                                                       | Owns                                                                                                      |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [Data model](../../docs/design/company-operations-demo.md) | Tables, roles, permission paths and integrity rules; `prepare-schema.mjs` generates the manifest from it. |
| [`dataverse/manifest.json`](dataverse/manifest.json)       | Generated schema: 28 tables (25 custom), 26 choices, 73 relationships, 29 keys in five solutions.         |
| [`data/`](data/catalogue.json)                             | Invented fixtures, personas, scenarios and backend query checks.                                          |
| `forms/`                                                   | Named administration/portable forms, public views and Lookup/Quick Find adjustments.                      |
| [`portal-security/`](portal-security/README.md)            | Web roles, table permissions, role variants and tester binding.                                           |
| [`portal-harness/`](portal-harness/README.md)              | The `/permission-lab/` page, its deployment and Mirage replay tools.                                      |
| [`plugins/`](plugins/README.md)                            | Plug-in laboratory: observers, guards, collector and SDK probes.                                          |

Environment identities, connections, native exports, deployment journals, tester bindings and observations stay under
the ignored `.paqvilo/` directory. A specification, generated file or passing offline check says nothing about a
deployed environment.

## Offline: prepare and check

Run from this directory. Apart from `npm install` and the restore in `sdk:build`, which can contact the npm registry and
NuGet, these commands make no network requests.

```sh
npm install
npm run schema:prepare   # regenerates dataverse/manifest.json from the design documents
npm run data:prepare     # regenerates data/catalogue.json
npm run stress:prepare   # regenerates data/stress-catalogue.json (base plus stress persona)
npm run sdk:build        # locked restore and Release build of plugins/SdkProbes (needs the .NET SDK global.json pins)
npm test
npm run test:browser     # harness page against invented loopback data
npm run data:plan        # offline fixture inventory of the stress catalogue
```

A diff after any `prepare` script means the committed file no longer matches its sources; `npm test` fails on it.

| Catalogue                    | Records | N:N links | Personas | Scenarios | Backend query checks |
| ---------------------------- | ------- | --------- | -------- | --------- | -------------------- |
| `data/catalogue.json`        | 822     | 338       | 24       | 28        | 44                   |
| `data/stress-catalogue.json` | 844     | 479       | 25       | 29        | 44                   |

The stress catalogue adds the `P-STRESS` persona (all twelve scoped roles) and is the default for every `data:*` script
and for environment comparison. Link counts include every target of every association group, so a base-only
comparison is wrong once the stress data is loaded. Seed run and operation rows are deliberately incomplete
placeholders; observations exist only after execution.

The optional Source5 cohort adds the `pqvd_equipment_crudprobes` lookup and widens `pqvd_testoperation.pqvd_variant`
to 128 characters. It refuses to overwrite the committed manifest:

```sh
npm run schema:prepare -- --cohort source5 --out .paqvilo/source5-schema.json
```

## Live: install into an authorized environment

These commands read or change the Dataverse environment named by the connection file; those not marked read-only write
to it. Run them only against an isolated environment you are authorized to change; create the connection with
`paqvilo dataverse register` (see [provisioning](../../docs/dataverse-provisioning.md)) and never commit it or the
journals.

```sh
CONN=/absolute/path/to/private.connection.json
npx paqvilo dataverse plan    --manifest dataverse/manifest.json --connection $CONN   # read-only
npx paqvilo dataverse apply   --manifest dataverse/manifest.json --connection $CONN
npx paqvilo dataverse publish --manifest dataverse/manifest.json --connection $CONN
npx paqvilo dataverse keys    --manifest dataverse/manifest.json --connection $CONN   # read-only; repeat until every key is Active
npm run data:apply   -- --connection $CONN
npm run data:compare -- --connection $CONN --out .paqvilo/dataverse/compare.json   # read-only
npm run data:query   -- --connection $CONN --out .paqvilo/dataverse/queries.json    # read-only
npm run forms:audit  -- --connection $CONN   # read-only plan
npm run forms:apply  -- --connection $CONN
```

- `apply` refuses before writing when an existing component differs from the manifest; the remote `plan` lists such
  components under `drift` with the differing properties. When only display labels or descriptions differ (`labelsOnly`
  in the saved plan), `apply --update-labels` changes just those and verifies them by readback; publish afterwards.
  `publish` publishes only the declared tables and choices.
- `data:apply` is additive: it creates missing rows and links, checks active keys, navigation properties, deferred
  lookup cycles and exact N:N sets, and stops on drift. It never deletes. `data:compare` exits 2 when any controlled
  field or link differs; it checks the catalogue's records except the existing currencies it only references.
- Load the catalogue before activating the `PaqviloBehaviorPlugins` steps. `OperationIntentGuard` stamps new operation
  markers, so the incomplete seed operation must exist before that guard is active. Do not relax a guard to load
  placeholders.
- Seed runs store the manifest hash, so any change to `dataverse/manifest.json` makes `data:compare` report
  `pqvd_manifesthash` on every seed run. `npm run data:reconcile-seed -- --connection $CONN` writes the current hash
  to untouched seed placeholders using ETags (it has no plan mode and skips runs that already match); it refuses
  executed runs and observed results or events.
- Company roots have a null root lookup (Dataverse rejects a Company-to-itself root link as a hierarchy loop);
  descendants point at their Company; Vendors have no organizational root.
- `forms:apply` also adds each declared form and view to its solution and publishes the declared tables; `forms:audit`
  lists the same membership additions (`membershipAdd`, and `membership` in the audit journal) without writing them.
- If the target rejects Quick Find FetchXML updates, `npm run forms:import-quickfind -- --connection $CONN` changes only
  the declared views inside an exported solution, imports it asynchronously, publishes and verifies the readback. Resume
  an interrupted import with `--resume <journal>`.

Solution order is `PaqviloCompanyOperationsCore`, then `PaqviloCompanyOperationsForms` and
`PaqviloPermissionTestSupport`, then `PaqviloPluginEvidence`, then `PaqviloBehaviorPlugins`; the Company Operations
Portal solution (built by `portal-security/package.mjs`) carries the website. Segmented native exports need the tables
to exist already, so they are update packages, not first-install packages.

Then, in order: [portal security](portal-security/README.md) (roles and permissions), the
[portal harness](portal-harness/README.md) (the test page) and the [plug-in laboratory](plugins/README.md).

## Limits

- Backend application access does not prove what a portal Contact sees. Only the harness, signed in as the intended
  Contact, measures that, and an empty result, matching lanes or a query-limit error is not proof of correct
  authorization.
- Structural scope and lifecycle changes stay blocked: no projection reconciler is installed, so only the declared
  scalar edits and disposable-equipment CRUD are mutable. Never widen a role to make a test pass.
- Durable capture, managed identity, Key Vault and the flow-only secret need external Azure resources this project does
  not deploy; the source contracts do not imply they exist.
