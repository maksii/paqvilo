// Simulated Dataverse auditing: seeding, enablement, audit actions, impersonation, the
// history functions and their privileges. Invented schema and GUIDs only.
import test from "node:test";
import assert from "node:assert/strict";
import { DataStore, emptyState } from "../lib/data.mjs";
import { install } from "../lib/dataverse-audit.mjs";

const ORG = "6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f";
const USER = "aaaaaaaa-0000-4000-8000-000000000001";
const CALLER = "aaaaaaaa-0000-4000-8000-000000000002";
const CLOCK = Date.UTC(2026, 9, 19, 9, 0, 0);
const IDENTITY = { admin: true, id: USER, systemUserId: USER };
const READ = ["prvReadRecordAuditHistory", "prvReadAuditSummary"];
const ATTRIBUTE = "#Microsoft.Dynamics.CRM.AttributeAuditDetail";
const RELATIONSHIP = "#Microsoft.Dynamics.CRM.RelationshipAuditDetail";
const text = { dataverseType: "nvarchar" };
const lookup = { dataverseType: "lookup" };
const int = { dataverseType: "int" };
const allowed = (...names) => ({ systemuserid: USER, organizationid: ORG, grants: new Map(names.map((n) => [n, 4])) });

function fixtureState({ org = true, table = true } = {}) {
  const state = emptyState();
  state.mappings.widget = {
    logicalName: "widget", entitySet: "widgets", idColumn: "widgetid", nameColumn: "name",
    dataverseMetadata: { IsAuditEnabled: { Value: table } },
    relationships: { widget_tags: { entity: "tag", from: "widgetid", to: "tagid", many: true } },
    // Field order is the column order: name 1, code 2, statecode 3, ownerid 4.
    fields: { name: text, code: { ...text, IsAuditEnabled: { Value: false } }, statecode: int, ownerid: lookup },
  };
  state.tables.widget = [];
  state.tables.organization = [{ organizationid: ORG, name: "Test Org", isauditenabled: org }];
  return state;
}

function apiFor(store, grants) {
  const ops = [], hooks = {};
  return {
    store, ops, hooks, schema: { tables: [] }, clock: () => CLOCK, change: (fn) => fn(),
    registry: { register: (op) => ops.push(op) },
    recordHooks: { add: (name, fn) => (hooks[name] = fn) },
    principals: { privileges: (user) => user.grants },
    grants,
  };
}

async function setup(options = {}, grants = allowed(...READ, "prvDeleteRecordChangeHistory")) {
  const store = new DataStore({ state: fixtureState(options) });
  const api = apiFor(store, grants);
  install(api);
  return api;
}

const op = (api, name) => api.ops.find((o) => o.name === name);
const auditRows = (api) => api.store.state.tables.audit ?? [];
const widgetId = (api) => api.store.state.tables.widget.at(-1).widgetid;
const flush = (api) => api.store.flushCommittedEvents();
const history = (api, id, params = {}) => op(api, "RetrieveRecordChangeHistory").handle({
  user: allowed(...READ), params: { Target: { "@odata.id": `widgets(${id})` }, ...params },
});

test("seeds the read-only audit mapping once and keeps an existing mapping", async () => {
  const api = await setup();
  const mapping = api.store.state.mappings.audit;
  assert.deepEqual([mapping.entitySet, mapping.idColumn, mapping.userConfigured, mapping.dataverseOnly], ["audits", "auditid", true, true]);
  const store = new DataStore({ state: fixtureState() });
  store.state.mappings.audit = { logicalName: "audit", entitySet: "custom", dataverseOnly: true, fields: {} };
  install(apiFor(store, allowed()));
  assert.equal(store.state.mappings.audit.entitySet, "custom");
});

test("audit rows need organization, table and column flags", async () => {
  const cases = [
    ["organization off", { org: false }, { name: "B" }, 0],
    ["table off", { table: false }, { name: "B" }, 0],
    ["organization and table on", {}, { name: "B" }, 2],
    ["unaudited column only", {}, { code: "y" }, 1],
  ];
  for (const [name, options, change, expected] of cases) {
    const api = await setup(options);
    await api.store.create("widget", { name: "A", code: "x" }, IDENTITY);
    await api.store.update("widget", widgetId(api), change, IDENTITY);
    await flush(api);
    assert.equal(auditRows(api).length, expected, name);
  }
});

test("create, update, assign, set state and delete audit with their operation and action", async () => {
  const api = await setup();
  await api.store.create("widget", { name: "A", statecode: 0 }, IDENTITY);
  await flush(api);
  const id = widgetId(api);
  await api.store.update("widget", id, { name: "B" }, IDENTITY);
  await api.store.update("widget", id, { ownerid: { id: CALLER, logical_name: "systemuser", name: "" } }, IDENTITY);
  await api.store.update("widget", id, { statecode: 1 }, IDENTITY);
  await flush(api);
  await api.store.remove("widget", id, IDENTITY);
  await flush(api);
  const pairs = auditRows(api).map((r) => [r.operation, r.action, r.attributemask]);
  assert.deepEqual(pairs, [[1, 1, "1,3"], [2, 2, "1"], [2, 13, "4"], [2, 41, "3"], [3, 3, null]]);
});

test("impersonated writes record the calling user, direct writes do not", async () => {
  const api = await setup();
  await api.store.create("widget", { name: "A" }, { ...IDENTITY, dataverse: { callerId: CALLER } });
  await api.store.create("widget", { name: "B" }, { ...IDENTITY, dataverse: { callerId: USER } });
  await flush(api);
  const [impersonated, direct] = auditRows(api);
  assert.equal(impersonated.userid.id, USER);
  assert.equal(impersonated.callinguserid.id, CALLER);
  assert.equal(direct.callinguserid, null);
});

test("N:N associate and disassociate audit through the afterWrite hook", async () => {
  const api = await setup();
  const widget = api.store.state.mappings.widget;
  api.hooks.afterWrite({ identity: IDENTITY }, widget, { operation: "associate", id: "w1", relationship: "widget_tags" });
  api.hooks.afterWrite({ identity: IDENTITY }, widget, { operation: "disassociate", id: "w1", relationship: "widget_tags" });
  assert.deepEqual(auditRows(api).map((r) => r.action), [33, 34]);
  const page = await history(api, "w1");
  assert.equal(page.body.AuditDetailCollection.AuditDetails[0]["@odata.type"], RELATIONSHIP);
});

test("the audit table refuses writes with 405", async () => {
  const api = await setup();
  const mapping = api.store.state.mappings.audit;
  for (const method of ["POST", "PATCH", "DELETE"]) {
    assert.throws(() => api.hooks.beforeWrite({ method }, mapping, { operation: "update" }), (error) =>
      error.status === 405 && error.message === `The requested resource does not support http method '${method}'.` && error.details.innerCode === "");
  }
});

test("record change history pages with a paging cookie and newest rows first", async () => {
  const api = await setup();
  await api.store.create("widget", { name: "v0" }, IDENTITY);
  await flush(api);
  const id = widgetId(api);
  for (const name of ["v1", "v2", "v3"]) await api.store.update("widget", id, { name }, IDENTITY);
  await flush(api);
  const first = await history(api, id, { PagingInfo: { Count: 2 } });
  const page1 = first.body.AuditDetailCollection;
  assert.deepEqual([page1.MoreRecords, page1.TotalRecordCount, page1.AuditDetails.length], [true, 4, 2]);
  assert.equal(page1.AuditDetails[0].NewValue.name, "v3");
  assert.equal(page1.AuditDetails[0]["@odata.type"], ATTRIBUTE);
  const second = await history(api, id, { PagingInfo: { Count: 2, PagingCookie: page1.PagingCookie } });
  const page2 = second.body.AuditDetailCollection;
  assert.deepEqual([page2.MoreRecords, page2.AuditDetails.length], [false, 2]);
  assert.equal(page2.AuditDetails[1].NewValue.name, "v0");
});

test("attribute change history and audit details return only the matching column", async () => {
  const api = await setup();
  await api.store.create("widget", { name: "A", statecode: 0 }, IDENTITY);
  await flush(api);
  const id = widgetId(api);
  await api.store.update("widget", id, { statecode: 1 }, IDENTITY);
  await api.store.update("widget", id, { name: "B" }, IDENTITY);
  await flush(api);
  const statecode = await op(api, "RetrieveAttributeChangeHistory").handle({
    user: allowed(...READ), params: { Target: { "@odata.id": `widgets(${id})` }, AttributeLogicalName: "statecode" },
  });
  const details = statecode.body.AuditDetailCollection.AuditDetails;
  assert.deepEqual(details.map((d) => [d["@odata.type"], d.NewValue.statecode]), [[ATTRIBUTE, 1], [ATTRIBUTE, 0]]);
  const latest = auditRows(api).find((r) => r.action === 2 && r.attributemask === "1");
  const bound = await op(api, "RetrieveAuditDetails").handle({ user: allowed(...READ), target: { row: latest } });
  assert.deepEqual([bound.body.AuditDetail.NewValue.name, bound.body.AuditDetail.OldValue.name], ["B", "A"]);
});

test("history functions need both read privileges", async () => {
  const api = await setup();
  await api.store.create("widget", { name: "A" }, IDENTITY);
  await flush(api);
  const id = widgetId(api);
  for (const grants of [allowed(), allowed("prvReadRecordAuditHistory")]) {
    await assert.rejects(
      op(api, "RetrieveRecordChangeHistory").handle({ user: grants, params: { Target: { "@odata.id": `widgets(${id})` } } }),
      (error) => error.status === 403 && error.details.innerCode === "0x80040220" && /prvReadAuditSummary|prvReadRecordAuditHistory/.test(error.message),
    );
  }
});

test("delete record change history removes only that record's rows and needs its privilege", async () => {
  const api = await setup();
  await api.store.create("widget", { name: "A" }, IDENTITY);
  await api.store.create("widget", { name: "B" }, IDENTITY);
  await flush(api);
  const [first, second] = api.store.state.tables.widget;
  const deleteOp = op(api, "DeleteRecordChangeHistory");
  await assert.rejects(
    deleteOp.handle({ user: allowed(...READ), body: { Target: { "@odata.id": `widgets(${first.widgetid})` } } }),
    (error) => error.status === 403,
  );
  const result = await deleteOp.handle({
    user: allowed("prvDeleteRecordChangeHistory"), body: JSON.stringify({ Target: { "@odata.id": `widgets(${first.widgetid})` } }),
  });
  assert.deepEqual(result, { status: 200, body: { DeletedEntriesCount: 1 } });
  assert.deepEqual(auditRows(api).map((r) => r.objectid.id), [second.widgetid]);
});
