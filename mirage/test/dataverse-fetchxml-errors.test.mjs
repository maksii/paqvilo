// FetchXML errors on the Dataverse Web API path (?fetchXml=): malformed XML, a missing entity name,
// an unknown condition operator and a column the metadata lacks answer the native codes and text.
// The portal's FetchXML keeps its own rules.
import test from "node:test";
import assert from "node:assert/strict";
import { DataStore, emptyState } from "../lib/data.mjs";
import { ensureSecurityModel, createPrincipals } from "../lib/dataverse-security.mjs";
import { createRecordHandlers } from "../lib/dataverse-records.mjs";
import { parseDataverseRoute, parsePrefer } from "../lib/dataverse-odata.mjs";
import { createChangeLog } from "../lib/dataverse-changes.mjs";

const ORIGIN = "http://127.0.0.1:5555";
const VERSION = "v9.2";
const ORG = "6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f";
const ADMIN_OID = "aaaaaaaa-0000-4000-8000-000000000001";
const WIDGET = "00000000-0000-4000-8000-000000000101";
const SETTINGS = {
  organizationId: ORG,
  tenantId: "tenant-test",
  uniqueName: "testorg",
  friendlyName: "Test Org",
  version: "9.2.25041.00000",
  users: [{ objectId: ADMIN_OID, upn: "admin@example.test", displayName: "Admin", roles: ["System Administrator"] }],
};
const text = { dataverseType: "nvarchar" };

// complete: the table's metadata is the whole schema (an absent column is unknown); otherwise it is incomplete
// and an absent column with no stored row is only unverified.
function fixtureState(complete) {
  const state = emptyState();
  state.mappings.contoso_widget = {
    logicalName: "contoso_widget", entitySet: "contoso_widgets", idColumn: "contoso_widgetid", nameColumn: "contoso_name",
    ...(complete ? { schemaComplete: true } : {}),
    fields: { contoso_name: text, contoso_price: { dataverseType: "money" } },
    relationships: {},
  };
  state.tables.contoso_widget = [{ contoso_widgetid: WIDGET, contoso_name: "Alpha", contoso_price: 3 }];
  return state;
}

async function setup(complete) {
  const store = new DataStore({ state: fixtureState(complete) });
  await ensureSecurityModel(store, SETTINGS);
  const principals = createPrincipals(store, SETTINGS);
  const changes = createChangeLog(store);
  const handlers = createRecordHandlers({ store, change: (fn) => fn(), principals, metadataFields: () => undefined, changes });
  const admin = principals.byObjectId(ADMIN_OID);
  // identity.dataverse marks the Dataverse caller, as lib/dataverse-api.mjs builds it.
  const send = (path) => {
    const url = new URL(path, ORIGIN);
    return handlers.handle({
      method: "GET",
      route: parseDataverseRoute(url.pathname),
      url,
      origin: ORIGIN,
      version: VERSION,
      prefer: parsePrefer(undefined),
      headers: {},
      user: admin,
      caller: admin,
      identity: { admin: true, id: admin.systemuserid, systemUserId: admin.systemuserid, dataverse: {} },
      requestId: "test",
    });
  };
  return { store, send };
}

async function failure(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to fail");
}

const fetchPath = (xml) => `/api/data/${VERSION}/contoso_widgets?fetchXml=${encodeURIComponent(xml)}`;

const QUERY_ERRORS = [
  ["malformed FetchXML answers Invalid XML before any entity is read", "<fetch><entity", "Invalid XML.", "0x80040201"],
  ["FetchXML without an entity answers the missing entity name", "<fetch/>", "Entity Name was not specified in FetchXml String.", "0x80041102"],
  [
    "an unknown condition operator answers the native operator code and text",
    '<fetch><entity name="contoso_widget"><filter><condition attribute="contoso_name" operator="nonexistent" value="x"/></filter></entity></fetch>',
    "Unknown Condition Operator: nonexistent",
    "0x80041120",
  ],
];
for (const [name, xml, message, innerCode] of QUERY_ERRORS) {
  test(name, async () => {
    const t = await setup(true);
    const error = await failure(t.send(fetchPath(xml)));
    assert.deepEqual([error.status, error.message, error.details.innerCode], [400, message, innerCode]);
  });
}

for (const complete of [true, false]) {
  test(`a column the metadata lacks is rejected in attribute, condition and order (complete metadata: ${complete})`, async () => {
    const t = await setup(complete);
    const expected = "'contoso_widget' entity doesn't contain attribute with Name = 'contoso_nosuch' and NameMapping = 'Logical' (look up attribute by name is case-sensitive).";
    const queries = {
      attribute: '<fetch><entity name="contoso_widget"><attribute name="contoso_nosuch"/></entity></fetch>',
      condition: '<fetch><entity name="contoso_widget"><filter><condition attribute="contoso_nosuch" operator="eq" value="x"/></filter></entity></fetch>',
      order: '<fetch><entity name="contoso_widget"><attribute name="contoso_name"/><order attribute="contoso_nosuch"/></entity></fetch>',
    };
    for (const [use, xml] of Object.entries(queries)) {
      const error = await failure(t.send(fetchPath(xml)));
      assert.equal(error.status, 400, use);
      assert.equal(error.message, expected, use);
      assert.equal(error.details.innerCode, "0x80041103", use);
    }
  });
}

test("known columns, the id column and system audit columns still run on the Dataverse path", async () => {
  const t = await setup(true);
  const res = await t.send(fetchPath('<fetch><entity name="contoso_widget"><attribute name="contoso_name"/><attribute name="createdon"/><order attribute="contoso_price"/></entity></fetch>'));
  assert.equal(res.status, 200);
  assert.equal(res.body.value.length, 1);
  assert.equal(res.body.value[0].contoso_name, "Alpha");
});

test("the portal FetchXML keeps its own operator message and ignores an unverified column", async () => {
  const store = new DataStore({ state: fixtureState(false) });
  const identity = { admin: true };
  const xml = '<fetch><entity name="contoso_widget"><attribute name="contoso_name"/><attribute name="contoso_nosuch"/></entity></fetch>';
  const result = store.fetchXml(xml, identity, {});
  assert.equal(result.entities.length, 1);
  assert.deepEqual(result.diagnostics.map((d) => d.code), ["FETCHXML_COLUMN_UNVERIFIED"]);
  const bad = await failure(Promise.resolve().then(() =>
    store.fetchXml('<fetch><entity name="contoso_widget"><filter><condition attribute="contoso_name" operator="nonexistent" value="x"/></filter></entity></fetch>', identity, {}),
  ));
  assert.equal(bad.message, "Unsupported FetchXML operator nonexistent");
  assert.equal(bad.code, "UnsupportedQuery");
});
