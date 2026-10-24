// Dataverse $filter operand typing and unsupported query functions. Operands whose EDM types can never match
// fail 400 0x80060888 from the column metadata, before any row is read; functions and $search the simulator does
// not run answer 501 0x8006088a. The portal and flow readers keep the default, lenient parser.
import test from "node:test";
import assert from "node:assert/strict";
import { DataStore, emptyState } from "../lib/data.mjs";
import { createPrincipals, ensureSecurityModel } from "../lib/dataverse-security.mjs";
import { dataverseError, parseDataverseRoute, parsePrefer } from "../lib/dataverse-odata.mjs";
import { createRecordHandlers } from "../lib/dataverse-records.mjs";
import { createChangeLog } from "../lib/dataverse-changes.mjs";
import { parseODataExpression } from "../lib/odata-query.mjs";

const ORIGIN = "http://127.0.0.1:5555";
const VERSION = "v9.2";
const ORG = "6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f";
const ADMIN_OID = "aaaaaaaa-0000-4000-8000-000000000001";
const PARENT = "11111111-2222-4333-8444-555555555555";
const SETTINGS = {
  organizationId: ORG,
  tenantId: "tenant-test",
  uniqueName: "testorg",
  friendlyName: "Test Org",
  version: "9.2.25041.00000",
  users: [{ objectId: ADMIN_OID, upn: "admin@example.test", displayName: "Admin", roles: ["System Administrator"] }],
};
const SET = `/api/data/${VERSION}/contoso_widgets`;

const column = (dataverseType) => ({ dataverseType });

function fixtureState() {
  const state = emptyState();
  state.mappings.contoso_widget = {
    logicalName: "contoso_widget", entitySet: "contoso_widgets", idColumn: "contoso_widgetid", nameColumn: "contoso_name",
    fields: {
      contoso_name: column("nvarchar"),
      contoso_count: column("int"),
      contoso_big: column("bigint"),
      contoso_price: column("money"),
      contoso_ratio: column("decimal"),
      contoso_flag: column("bit"),
      contoso_when: column("datetime"),
      contoso_day: { dataverseType: "datetime", dateTimeBehavior: "DateOnly" },
      contoso_formatday: { dataverseType: "datetime", format: "DateOnly" },
      contoso_status: column("picklist"),
      contoso_parentid: column("lookup"),
    },
  };
  state.tables.contoso_widget = [];
  return state;
}

async function setup() {
  const store = new DataStore({ state: fixtureState() });
  await ensureSecurityModel(store, SETTINGS);
  const principals = createPrincipals(store, SETTINGS);
  const changes = createChangeLog(store);
  const handlers = createRecordHandlers({ store, change: (fn) => fn(), principals, metadataFields: () => undefined, changes });
  const admin = principals.byObjectId(ADMIN_OID);
  const send = (method, path, { body } = {}) => {
    const url = new URL(path, ORIGIN);
    return handlers.handle({
      method,
      route: parseDataverseRoute(url.pathname),
      url,
      origin: ORIGIN,
      version: VERSION,
      prefer: parsePrefer(undefined),
      headers: {},
      body,
      user: admin,
      caller: admin,
      identity: { admin: true, id: admin.systemuserid, systemUserId: admin.systemuserid },
      requestId: "test",
    });
  };
  return { send };
}

async function failure(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to fail");
}

const query = (t, filter) => t.send("GET", `${SET}?$filter=${filter}`);

test("EDM-incompatible comparisons fail 0x80060888 with the native operand types, empty table or not", async () => {
  const t = await setup();
  const cases = [
    ["contoso_when eq 'bad-date'", "Edm.DateTimeOffset", "Edm.String", "Equal"],
    ["contoso_flag eq 1", "Edm.Boolean", "Edm.Int32", "Equal"],
    ["contoso_count eq '1'", "Edm.Int32", "Edm.String", "Equal"],
    ["contoso_count gt '1'", "Edm.Int32", "Edm.String", "GreaterThan"],
    ["contoso_name ne 5", "Edm.String", "Edm.Int32", "NotEqual"],
    ["contoso_status le 'x'", "Edm.Int32", "Edm.String", "LessThanOrEqual"],
    ["contoso_price ge true", "Edm.Decimal", "Edm.Boolean", "GreaterThanOrEqual"],
    ["'1' eq contoso_count", "Edm.String", "Edm.Int32", "Equal"],
    ["contoso_count lt contoso_name", "Edm.Int32", "Edm.String", "LessThan"],
  ];
  const expectFailures = async () => {
    for (const [filter, left, right, kind] of cases) {
      const error = await failure(query(t, encodeURIComponent(filter)));
      assert.equal(error.status, 400, filter);
      assert.equal(error.details.innerCode, "0x80060888", filter);
      assert.equal(error.message, `A binary operator with incompatible types was detected. Found operand types '${left}' and '${right}' for operator kind '${kind}'.`, filter);
    }
  };
  await expectFailures();
  await t.send("POST", SET, { body: { contoso_name: "Alpha", contoso_count: 1, contoso_flag: true } });
  await expectFailures();
});

test("compatible comparisons stay accepted, including numeric widening, GUID, null and date literals", async () => {
  const t = await setup();
  await t.send("POST", SET, { body: { contoso_name: "Alpha", contoso_count: 1, contoso_flag: true } });
  const accepted = [
    "contoso_count eq 1",
    "contoso_count eq 1.5",
    "contoso_big eq 3000000000",
    "contoso_price eq 2.5M",
    "contoso_ratio gt 0.5",
    "contoso_status eq 1",
    "contoso_flag eq true",
    "contoso_name eq 'Alpha'",
    "contoso_name eq null",
    "contoso_when eq 2020-01-01T00:00:00Z",
    `_contoso_parentid_value eq ${PARENT}`,
  ];
  for (const filter of accepted) {
    const res = await query(t, encodeURIComponent(filter));
    assert.equal(res.status, 200, filter);
  }
});

test("DateOnly columns, by behaviour or by format, type as Edm.Date: text operands fail, date literals are accepted", async () => {
  const t = await setup();
  await t.send("POST", SET, { body: { contoso_name: "Alpha", contoso_count: 1, contoso_flag: true } });
  for (const column of ["contoso_day", "contoso_formatday"]) {
    const error = await failure(query(t, encodeURIComponent(`${column} eq 'text'`)));
    assert.equal(error.status, 400, column);
    assert.equal(error.details.innerCode, "0x80060888", column);
    assert.equal(error.message, "A binary operator with incompatible types was detected. Found operand types 'Edm.Date' and 'Edm.String' for operator kind 'Equal'.", column);
    for (const filter of [`${column} eq 2024-01-31`, `${column} eq 2024-01-31T00:00:00Z`]) {
      assert.equal((await query(t, encodeURIComponent(filter))).status, 200, filter);
    }
  }
  // A plain datetime column keeps Edm.DateTimeOffset, so a date-only literal stays compatible with it.
  assert.equal((await query(t, encodeURIComponent("contoso_when eq 2024-01-31"))).status, 200);
});

test("tolower, length and $search answer 501 0x8006088a with the native message", async () => {
  const t = await setup();
  const cases = [
    [`${SET}?$filter=${encodeURIComponent("tolower(contoso_name) eq 'x'")}`, 'The "tolower" function isn\'t supported.'],
    [`${SET}?$filter=${encodeURIComponent("length(contoso_name) gt 0")}`, 'The "length" function isn\'t supported.'],
    [`${SET}?$search=probe&$filter=${encodeURIComponent("contoso_name eq 'x'")}`, 'The "$search" query parameter isn\'t supported.'],
  ];
  for (const [path, message] of cases) {
    const error = await failure(t.send("GET", path));
    assert.equal(error.status, 501, path);
    const wire = dataverseError(error, { requestId: "test", origin: ORIGIN });
    assert.equal(wire.status, 501, path);
    assert.equal(wire.body.error.code, "0x8006088a", path);
    assert.equal(wire.body.error.message, message, path);
  }
});

test("the default parser is unchanged: strict typing and function errors apply only when strictEdm is requested", () => {
  assert.doesNotThrow(() => parseODataExpression("contoso_count eq '1'", { dialect: "dataverse" }));
  assert.doesNotThrow(() => parseODataExpression("tolower(contoso_name) eq 'x'", { dialect: "extended" }));
  assert.throws(
    () => parseODataExpression("tolower(contoso_name) eq 'x'", { dialect: "dataverse" }),
    { status: 400, code: "UnsupportedQuery" },
  );
  assert.throws(
    () => parseODataExpression("contoso_count eq '1'", { dialect: "dataverse", strictEdm: true, columnDefinition: () => column("int") }),
    { status: 400, code: "InvalidQuery", details: { innerCode: "0x80060888" } },
  );
});
