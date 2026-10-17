# Company Operations regression project

This separate example owns a synthetic organisation/workforce model, deep permission tests and a plugin laboratory. Start with the [data model](../../docs/design/company-operations-demo.md), [permission harness](../../docs/design/power-pages-permission-test-harness.md) and [plugin design](../../docs/design/dataverse-plugin-observation.md). Reusable provisioning belongs to [`paqvilo/dataverse`](../../docs/dataverse-provisioning.md).

The model has 28 tables: 25 custom tables plus Account, Contact and Transaction Currency. Twelve combinable roles exercise organisation membership, overlapping engagements and an eleven-table permission path. CurrencyReference provides an observable custom reference table; money fields still use the system Transaction Currency table. The [metadata manifest](dataverse/manifest.json) is the authoritative schema inventory.

Environment identities, credentials, native exports, deployments, actual tester bindings and observations stay under ignored `.paqvilo/`. Offline checks use invented fixtures and make no live requests. A specification, generated package or passing offline check does not establish a deployed environment's behavior.

## Prepare and check locally

Run from this directory:

```sh
npm install
npm run schema:prepare
npm run data:prepare
npm run stress:prepare
npm test
npm run test:browser
npm run data:plan
```

`schema:prepare` reproduces the reviewed Source4 manifest. The optional Source5 lookup cohort adds a relationship and extends the operation variant field; generate it separately with `npm run schema:prepare -- --cohort source5 --out .paqvilo/source5-schema.json`. Source5 refuses to overwrite the committed manifest. Review and qualify its complete schema, data, registration and guard cohort before provisioning it or replacing tracked fixtures.

The [base catalogue](data/catalogue.json) has 822 fixture/reference records, 338 association links and 24 personas. The [merged stress catalogue](data/stress-catalogue.json) adds overlapping role/engagement cases and is the default comparison baseline: 844 records, 479 links, 25 personas, 29 scenarios and 44 backend retrieval checks. Association counts include every target in each association group. Base-only exact association comparison is insufficient after loading the extension. Seed run/operation rows are incomplete placeholders; observations are created only by execution.

## Install in an authorized environment

Select the target environment and website explicitly. Use a private Dataverse connection file; never commit credentials or deployment receipts. Initial installation creates metadata with `paqvilo dataverse apply --manifest dataverse/manifest.json --connection FILE`, publishes it, waits for active keys and loads the merged catalogue before activating Behavior plugin steps. OperationIntentGuard stamps new operation markers, so create the incomplete seed operation before activating that guard. Do not relax guards to reproduce placeholder values.

```sh
npm run data:apply -- --connection /absolute/path/to/private.connection.json
npm run data:compare -- --connection /absolute/path/to/private.connection.json --out .paqvilo/dataverse/compare.json
npm run data:query -- --connection /absolute/path/to/private.connection.json --out .paqvilo/dataverse/queries.json
```

Loading is additive. It validates active keys, resolved navigation properties, deferred lookup cycles and exact N:N associations; drift stops loading. `data/reconcile-seed-headers.mjs` can update schema hashes on untouched incomplete seed placeholders using ETags. It refuses executed runs and observed results/events. Company roots have null root lookups; descendants identify their Company, while Vendors have no organisational root. Dataverse rejects a Company-to-itself root association.

The metadata/code solution order is Core, Forms and TestSupport, PluginEvidence, then BehaviorPlugins. A separate Company Operations Portal solution carries the selected website. Segmented native exports require existing tables and are not standalone first-install packages. Reconcile project forms/views after table-root scoping and audit exported dependencies. See [provisioning](../../docs/dataverse-provisioning.md) for bootstrap and export commands.

The form compiler supplies named administration/portable forms, public views and Lookup/Quick Find adjustments. Standard Account/Contact forms and system views remain intact. Run `forms:audit` or `forms:apply` with `--connection FILE`. If the target rejects Quick Find FetchXML record updates, `forms:import-quickfind` changes only the declared views in a native solution export, imports asynchronously, publishes and verifies readback. Resume interrupted imports with `--resume JOURNAL`. Preserve the private before/after receipts.

## Qualify permissions and behavior

The [security tools](portal-security/README.md) provision website-bound roles and scoped permissions, reject active children beneath inactive parents and audit Global contamination. Role variants preserve unrelated assignments and the recorder role. Use the intended signed-in browser and private persona bindings; backend application access does not prove a portal Contact's visibility.

The [portal harness](portal-harness/README.md) compares independent Liquid and Web API queries, guarded mutations and stored history. Its visibility oracle comes from the intended permission graph and stays separate from observed results. Inspect exact record IDs, scope assertions, query expansion and errors. An empty result, matching lanes or a query-limit rejection alone is insufficient evidence of correct authorization. Qualify each target's role combinations and deep paths independently.

Keep structural scope and lifecycle mutations protected until the required projection reconciler is installed and qualified. Scalar edits and disposable-equipment CRUD also require their declared permissions and guards. Never widen a role to make a test pass. Retain configuration changes, incomplete runs and cleanup residuals, then restore the original assignments and inspect native readback.

The [plugin laboratory](plugins/README.md) records query and typed context/image/chain evidence with immutable operation markers. Its live SDK, portal and offline checks have separate receipts. Transactional evidence may roll back with a failed request. Durable Azure capture, managed-identity federation, Key Vault and the secret-verification flow require external provisioning and qualification; source contracts do not imply those services are deployed.

Artifacts use reversible UTF-8 base64 transport, full byte lengths/hashes and per-part checksums. The runner rejects overlapping runs and enforces a configurable client transport budget. Combined client/server quotas and durable rollback capture require the external collector. Preserve older integrity failures and raw evidence rather than rewriting them as successful observations.
