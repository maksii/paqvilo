// Native error answers for bulk actions and If-Match / If-None-Match on PATCH: the status, the Dataverse code and the
// message the platform answers, with no write before the error.
import test from "node:test";
import assert from "node:assert/strict";
import { DataStore, emptyState } from "../lib/data.mjs";
import { ensureSecurityModel, createPrincipals } from "../lib/dataverse-security.mjs";
import { dataverseError, parseDataverseRoute, parsePrefer } from "../lib/dataverse-odata.mjs";
import { createRecordHandlers } from "../lib/dataverse-records.mjs";
import { createChangeLog } from "../lib/dataverse-changes.mjs";

const ORIGIN = "http://127.0.0.1:5556";
const VERSION = "v9.2";
const ORG = "6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f";
const ADMIN_OID = "aaaaaaaa-0000-4000-8000-000000000001";
const MISSING = "00000000-0000-4000-8000-0000000000ff";
const SETTINGS = {
  organizationId: ORG,
  tenantId: "tenant-test",
  uniqueName: "testorg",
  friendlyName: "Test Org",
  version: "9.2.25041.00000",
  users: [{ objectId: ADMIN_OID, upn: "admin@example.test", displayName: "Admin", roles: ["System Administrator"] }],
};
const text = { dataverseType: "nvarchar" };

function fixtureState() {
  const state = emptyState();
  state.mappings.widget = {
    logicalName: "widget", entitySet: "widgets", idColumn: "widgetid", nameColumn: "name",
    fields: { name: text, code: text },
  };
  state.tables.widget = [];
  return state;
}

async function setup() {
  const store = new DataStore({ state: fixtureState() });
  await ensureSecurityModel(store, SETTINGS);
  const principals = createPrincipals(store, SETTINGS);
  const handlers = createRecordHandlers({ store, change: (fn) => fn(), principals, metadataFields: () => undefined, changes: createChangeLog(store) });
  const admin = principals.byObjectId(ADMIN_OID);
  const send = (method, path, { body, headers = {} } = {}) => {
    const url = new URL(path, ORIGIN);
    return handlers.handle({
      method,
      route: parseDataverseRoute(url.pathname),
      url,
      origin: ORIGIN,
      version: VERSION,
      prefer: parsePrefer(undefined),
      headers,
      body,
      user: admin,
      caller: admin,
      identity: { admin: true, id: admin.systemuserid, systemUserId: admin.systemuserid },
      requestId: "test",
    });
  };
  return { store, send, admin };
}

// The wire answer: the same envelope the router sends for a thrown error.
async function wire(promise) {
  try {
    const res = await promise;
    assert.fail(`expected an error, got ${res.status}`);
  } catch (error) {
    if (error?.code === "ERR_ASSERTION") throw error;
    const envelope = dataverseError(error, { prefer: parsePrefer(undefined), requestId: "test", origin: ORIGIN, tenantId: "tenant-test" });
    return { status: envelope.status, code: envelope.body.error.code, message: envelope.body.error.message };
  }
}

const createMultiple = `/api/data/${VERSION}/widgets/Microsoft.Dynamics.CRM.CreateMultiple`;

test("CreateMultiple with an empty Targets array answers 400 0x80040216 and writes nothing", async () => {
  const t = await setup();
  assert.deepEqual(await wire(t.send("POST", createMultiple, { body: { Targets: [] } })), {
    status: 400,
    code: "0x80040216",
    message: "Custom state is not set for entity type crmbaseentity.",
  });
  assert.equal(t.store.state.tables.widget.length, 0);
});

test("CreateMultiple with a target typed as another table answers 400 0x80040800 before any row is written", async () => {
  const t = await setup();
  const error = await wire(t.send("POST", createMultiple, {
    body: {
      Targets: [
        { "@odata.type": "Microsoft.Dynamics.CRM.widget", name: "valid" },
        { "@odata.type": "Microsoft.Dynamics.CRM.gadget", name: "wrong table" },
      ],
    },
  }));
  assert.deepEqual(error, {
    status: 400,
    code: "0x80040800",
    message: "The 'CreateMultiple' method does not support entities of type 'none'. MessageProcessorCache returned MessageProcessor.Empty. ",
  });
  assert.equal(t.store.state.tables.widget.length, 0);
});

test("CreateMultiple accepts targets typed as its own table, with or without the # prefix", async () => {
  const t = await setup();
  const res = await t.send("POST", createMultiple, {
    body: { Targets: [{ "@odata.type": "#Microsoft.Dynamics.CRM.widget", name: "a" }, { "@odata.type": "Microsoft.Dynamics.CRM.widget", name: "b" }] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.Ids.length, 2);
});

// Only CreateMultiple was observed natively; UpdateMultiple and UpsertMultiple are assumed to take the same refusals, with
// their own message name in the 0x80040800 text.
for (const name of ["UpdateMultiple", "UpsertMultiple"]) {
  const action = `/api/data/${VERSION}/widgets/Microsoft.Dynamics.CRM.${name}`;
  const id = "00000000-0000-4000-8000-0000000000aa";

  test(`${name} with an empty Targets array answers 400 0x80040216 and writes nothing`, async () => {
    const t = await setup();
    assert.deepEqual(await wire(t.send("POST", action, { body: { Targets: [] } })), {
      status: 400,
      code: "0x80040216",
      message: "Custom state is not set for entity type crmbaseentity.",
    });
  });

  test(`${name} with a target typed as another table answers 400 0x80040800 before any row is written`, async () => {
    const t = await setup();
    const created = await t.send("POST", `/api/data/${VERSION}/widgets`, { body: { name: "Before" } });
    const row = /\(([^()]+)\)$/.exec(created.headers["OData-EntityId"])[1];
    const error = await wire(t.send("POST", action, {
      body: {
        Targets: [
          { "@odata.type": "Microsoft.Dynamics.CRM.widget", widgetid: row, name: "After" },
          { "@odata.type": "Microsoft.Dynamics.CRM.gadget", widgetid: id, name: "wrong table" },
        ],
      },
    }));
    assert.deepEqual(error, {
      status: 400,
      code: "0x80040800",
      message: `The '${name}' method does not support entities of type 'none'. MessageProcessorCache returned MessageProcessor.Empty. `,
    });
    assert.equal(t.store.state.tables.widget.length, 1);
    assert.equal(t.store.state.tables.widget[0].name, "Before");
  });
}

test("PATCH with If-None-Match: * on an existing row answers 412 0x80040237 with the native message", async () => {
  const t = await setup();
  const created = await t.send("POST", `/api/data/${VERSION}/widgets`, { body: { name: "Old" } });
  const id = /\(([^()]+)\)$/.exec(created.headers["OData-EntityId"])[1];
  const error = await wire(t.send("PATCH", `/api/data/${VERSION}/widgets(${id})`, { body: { name: "New" }, headers: { "if-none-match": "*" } }));
  assert.deepEqual(error, { status: 412, code: "0x80040237", message: "A record with matching key values already exists." });
  assert.equal(t.store.state.tables.widget[0].name, "Old");
});

test("PATCH with If-Match: * on a missing row answers 404 0x80040217 worded for the table, and creates nothing", async () => {
  const t = await setup();
  const error = await wire(t.send("PATCH", `/api/data/${VERSION}/widgets(${MISSING})`, { body: { name: "x" }, headers: { "if-match": "*" } }));
  assert.deepEqual(error, { status: 404, code: "0x80040217", message: `Entity 'widget' With Id = ${MISSING} Does Not Exist` });
  assert.equal(t.store.state.tables.widget.length, 0);
});
