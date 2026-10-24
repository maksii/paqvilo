// UpsertEnvironmentVariable accepts the Secret type (100000005) with a Key Vault reference, as a Solution import already does,
// and still refuses a type outside the allow-list. The setup mirrors dataverse-org-messages.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { DataStore, emptyState } from "../lib/data.mjs";
import { seed as seedStandard } from "../lib/dataverse-standard.mjs";
import { ensureSecurityModel, createPrincipals } from "../lib/dataverse-security.mjs";
import { createOperationRegistry } from "../lib/dataverse-operations.mjs";
import { createRecordHandlers } from "../lib/dataverse-records.mjs";
import { createChangeLog } from "../lib/dataverse-changes.mjs";
import { runAtomic } from "../lib/dataverse-api.mjs";
import { install } from "../lib/dataverse-org-messages.mjs";

const ORIGIN = "http://127.0.0.1:5555";
const ORG = "6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f";
const ADMIN_OID = "aaaaaaaa-0000-4000-8000-000000000001";
const CLOCK = Date.parse("2026-10-20T09:00:00Z");
const SETTINGS = {
  organizationId: ORG,
  tenantId: "tenant-test",
  uniqueName: "testorg",
  friendlyName: "Test Org",
  version: "9.2.25041.00000",
  users: [{ objectId: ADMIN_OID, upn: "admin@example.test", displayName: "Admin", roles: ["System Administrator"] }],
};
const REFERENCE = "/subscriptions/77777777-7777-4777-8777-777777777777/resourceGroups/invented/providers/Microsoft.KeyVault/vaults/invented/secrets/x-secret";

async function setup() {
  const store = new DataStore({ state: emptyState() });
  await store.transact(() => seedStandard(store));
  await ensureSecurityModel(store, SETTINGS);
  const principals = createPrincipals(store, SETTINGS);
  const changes = createChangeLog(store);
  const records = createRecordHandlers({ store, change: (fn) => fn(), principals, metadataFields: () => undefined, changes });
  const api = {
    store, change: (fn) => fn(), registry: createOperationRegistry(), principals, metadata: null, metadataFields: () => undefined,
    records, changes, settings: SETTINGS, clock: () => CLOCK, log: () => {},
  };
  api.runAtomic = (fn) => runAtomic(api, fn);
  install(api);
  return { store, api, admin: principals.byObjectId(ADMIN_OID) };
}

// Calls the registered action the way the router does: the body for an action, with the caller as the administrator.
async function upsert(t, body) {
  const op = t.api.registry.find({ name: "UpsertEnvironmentVariable", kind: "action", binding: "unbound" });
  assert.ok(op, "UpsertEnvironmentVariable is registered");
  return op.handle({
    user: t.admin, caller: null, target: null, params: undefined, body, identity: { admin: true },
    origin: ORIGIN, version: "v9.2", url: new URL(`${ORIGIN}/api/data/v9.2/UpsertEnvironmentVariable`),
  });
}

test("UpsertEnvironmentVariable accepts the Secret type and stores the Key Vault reference as the value", async () => {
  const t = await setup();
  const response = await upsert(t, { SchemaName: "x_Secret", Type: 100000005, SecretStore: 0, Value: REFERENCE });
  assert.equal(response.status, 204);
  const definition = t.store.state.tables.environmentvariabledefinition.find((row) => row.schemaname === "x_Secret");
  assert.equal(definition.type, 100000005);
  assert.equal(definition.secretstore, 0);
  const values = t.store.state.tables.environmentvariablevalue.filter((row) => row.schemaname === "x_Secret");
  assert.deepEqual(values.map((row) => row.value), [REFERENCE]);
});

test("UpsertEnvironmentVariable still refuses a type outside the allow-list", async () => {
  const t = await setup();
  await assert.rejects(upsert(t, { SchemaName: "x_Other", Type: 100000006, Value: "x" }), (e) => e.status === 400 && e.details?.innerCode === "0x80040203");
  assert.equal(t.store.state.tables.environmentvariabledefinition.some((row) => row.schemaname === "x_Other"), false);
});
