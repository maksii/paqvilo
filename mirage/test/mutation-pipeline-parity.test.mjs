// One organization mutation pipeline: the same invented write through the Dataverse Web API, the SDK IOrganizationService
// (the service a CLR plug-in's SDK calls reach), the flow Dataverse connector, the portal /_api and the portal form writes
// stores the same row, refuses a calculated-column value and a duplicate alternate key with the same error, and reads back
// the same projection. Invented schema only.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSimulator } from "../server.mjs";
import { localOrganizationService } from "../lib/local-organization-service.mjs";
import { DATAVERSE_CONNECTOR, createConnectorRuntime } from "../lib/connector-runtime.mjs";
import { portalRecordWrites } from "../lib/form-service.mjs";
import { dispatchSdkCall } from "../lib/plugin-clr.mjs";

const CLIENT = "77777777-7777-4777-8777-777777777777";
const CONTACT = "77777777-7777-4777-8777-000000000011";
const calculated = (formulaDefinition) => ({ dataverseType: "decimal", columnMetadata: { sourceType: 1, formulaDefinition } });
const state = () => ({
  version: 1,
  mappings: {
    contact: { entitySet: "contacts", idColumn: "contactid", nameColumn: "fullname", fields: { fullname: { dataverseType: "nvarchar" } } },
    x_item: {
      logicalName: "x_item", entitySet: "x_items", idColumn: "x_itemid", nameColumn: "x_name",
      alternateKeys: [{ name: "x_code_key", attributes: ["x_code"] }],
      dataverseMetadata: { IsAuditEnabled: true },
      relationships: { x_item_lines: { schemaName: "x_item_x_line", entity: "x_line", from: "x_itemid", to: "x_itemid", many: true } },
      fields: {
        x_name: { dataverseType: "nvarchar" }, x_code: { dataverseType: "nvarchar" }, x_amount: { dataverseType: "decimal" },
        x_total: calculated('<Multiply><Field Name="x_amount"/><Constant Value="2"/></Multiply>'),
        statecode: { dataverseType: "state", options: [{ value: 0, label: "Active" }, { value: 1, label: "Inactive" }] },
        statuscode: { dataverseType: "status", statuses: [{ value: 1, label: "Active", state: 0 }, { value: 2, label: "Inactive", state: 1 }] },
      },
    },
    x_line: {
      logicalName: "x_line", entitySet: "x_lines", idColumn: "x_lineid", nameColumn: "x_name",
      fields: { x_name: { dataverseType: "nvarchar" }, x_itemid: { dataverseType: "lookup", targets: ["x_item"] } },
      relationships: { x_itemid: { schemaName: "x_item_x_line", entity: "x_item", from: "x_itemid", to: "x_itemid", many: false, partner: "x_item_lines" } },
    },
  },
  tables: { contact: [{ contactid: CONTACT, fullname: "Invented Contact", statecode: 0 }], x_item: [], x_line: [] },
  permissions: [],
  settings: { permissionMode: "permissive" },
  simulator: { mode: "local", pageMode: "local", identityScope: "configured", identity: { id: CONTACT, roles: [] }, live: { allowWrites: false }, endpoints: [] },
});

async function organization(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mutation-pipeline-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "website.yml"), "adx_websiteid: site\nadx_name: Invented pipeline\n");
  await fs.writeFile(path.join(directory, "sitesetting.yml"), [
    "- adx_name: Webapi/x_item/enabled\n  adx_value: 'true'",
    "- adx_name: Webapi/x_item/fields\n  adx_value: 'x_name,x_code,x_amount,x_total,statecode,statuscode,x_item_lines'",
    "- adx_name: Webapi/error/innererror\n  adx_value: 'true'",
  ].join("\n"));
  const sim = await createSimulator({ sourceDir: directory, stateFile: path.join(directory, "state.json"), initial: state(), port: 0, watch: false,
    dataverse: { enabled: true, tls: false, tds: { enabled: false } } });
  t.after(() => sim.close());
  const registered = await fetch(sim.url + "/_sim/api/dataverse/applications", { method: "POST",
    headers: { "content-type": "application/json", "x-sim-csrf": sim.state().csrf },
    body: JSON.stringify({ appId: CLIENT, displayName: "Invented client", roles: ["System Administrator"] }) });
  assert.equal(registered.status, 201, await registered.clone().text());
  const { secret } = await registered.json();
  const token = (await (await fetch(sim.dataverse.authority + "/oauth2/v2.0/token", { method: "POST",
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: CLIENT, client_secret: secret, scope: sim.dataverse.origin + "/.default" }) })).json()).access_token;
  const webApi = async (method, suffix, body) => {
    const response = await fetch(sim.dataverse.origin + "/api/data/v9.2" + suffix, { method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json", prefer: "return=representation" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const portal = async (method, suffix, body) => {
    const response = await fetch(sim.url + "/_api" + suffix, { method,
      headers: { __RequestVerificationToken: sim.state().csrf, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  // The SDK backend profile acts as the Web API's application user, so the actor columns match too.
  const appUser = sim.store.tableRows("systemuser").find((row) => String(row.applicationid ?? "").toLowerCase() === CLIENT);
  assert.ok(appUser, "the registered application user");
  const profile = { userId: appUser.systemuserid, evidence: "invented parity test", grants: [{ entity: "x_item", operations: ["create", "read", "update", "delete", "associate", "disassociate"] },
    { entity: "x_line", operations: ["create", "read", "update", "associate", "disassociate"] }] };
  const diagnostics = [];
  const sdk = localOrganizationService(sim.store, profile, undefined, { diagnostic: (note) => diagnostics.push(note) });
  const connectors = createConnectorRuntime({ store: sim.store, diagnostic: (note) => diagnostics.push(note) });
  const connector = (operationId, parameters) => connectors.invoke({ connectorId: DATAVERSE_CONNECTOR, operationId, parameters, context: { principal: profile } });
  const formWrites = (fn) => sim.store.transact(() => fn(portalRecordWrites(sim.store, { portalRequest: true })), { incremental: true });
  const stored = (name) => sim.store.tableRows("x_item").find((row) => row.x_name === name);
  // The SDK bridge a CLR plug-in's IOrganizationService calls reach (typed SDK values, no .NET needed).
  const clr = (method, ...args) => dispatchSdkCall({ store: sim.store, profile, message: { method, userId: profile.userId, arguments: args }, diagnostic: (note) => diagnostics.push(note) });
  return { sim, webApi, portal, sdk, clr, connector, formWrites, stored, appUser, diagnostics };
}

// The stored row without its id, its timestamps, its actor and owner columns and its row-version value.
const ACTOR = new Set(["x_itemid", "createdon", "modifiedon", "createdby", "modifiedby", "createdonbehalfby", "modifiedonbehalfby",
  "ownerid", "owninguser", "owningteam", "owningbusinessunit", "versionnumber", "x_name", "x_code"]);
const comparable = (row) => Object.fromEntries(Object.entries(row).filter(([key]) => !ACTOR.has(key)).sort(([a], [b]) => a.localeCompare(b)));
const errorOf = async (fn) => {
  try { await fn(); } catch (error) { return { status: error.status, innerCode: error.details?.innerCode, message: error.message }; }
  assert.fail("the write was accepted");
};

test("one invented create stores the same row through the Web API, the SDK, the CLR bridge, the connector, the portal /_api and the portal form", async (t) => {
  const { webApi, portal, sdk, clr, connector, formWrites, stored, appUser } = await organization(t);
  assert.equal((await webApi("POST", "/x_items", { x_name: "web", x_code: "W", x_amount: 3 })).status, 201);
  sdk.create("x_item", { x_name: "sdk", x_code: "S", x_amount: 3 });
  clr("Create", { $type: "Entity", logicalName: "x_item", attributes: { x_name: "clr", x_code: "C", x_amount: { $type: "Decimal", value: "3" } } });
  assert.equal((await connector("CreateRecord", { entityName: "x_item", "item/x_name": "flow", "item/x_code": "F", "item/x_amount": 3 })).statusCode, 201);
  const posted = await portal("POST", "/x_items", { x_name: "portal", x_code: "P", x_amount: 3 });
  assert.equal(posted.status, 204, JSON.stringify(posted.body));
  await formWrites((writes) => writes.create("x_item", { x_name: "form", x_code: "M", x_amount: 3 }, { id: CONTACT }));
  const rows = ["web", "sdk", "clr", "flow", "portal", "form"].map(stored);
  for (const row of rows) {
    assert.ok(row, "every surface stored its row");
    assert.deepEqual(comparable(row), comparable(rows[0]), `${row.x_name} stores the Web API row`);
    assert.equal(row.statecode, 0);
    assert.equal(row.statuscode, 1);
    assert.equal(typeof row.versionnumber, "number", `${row.x_name} carries the organization row version`);
    assert.ok(row.createdby?.id && row.modifiedby?.id, `${row.x_name} carries audit columns`);
  }
  // The SDK and connector writes act as the profile's systemuser, as the Web API acts as its caller.
  for (const row of rows.slice(0, 4)) assert.equal(String(row.createdby.id).toLowerCase(), String(appUser.systemuserid).toLowerCase());
  assert.ok(new Set(rows.map((row) => row.versionnumber)).size === rows.length, "each write takes the next row version");
});

test("a calculated-column value and a duplicate alternate key answer the same error on every surface", async (t) => {
  const { webApi, portal, sdk, clr, connector, formWrites } = await organization(t);
  const web = await webApi("POST", "/x_items", { x_name: "calc", x_total: 5 });
  assert.equal(web.status, 400);
  assert.equal(web.body.error.code, "0x80048d19");
  const refusals = [
    await errorOf(() => sdk.create("x_item", { x_name: "calc", x_total: 5 })),
    await errorOf(() => clr("Create", { $type: "Entity", logicalName: "x_item", attributes: { x_name: "calc", x_total: { $type: "Decimal", value: "5" } } })),
    await errorOf(() => connector("CreateRecord", { entityName: "x_item", "item/x_name": "calc", "item/x_total": 5 })),
    await errorOf(() => formWrites((writes) => writes.create("x_item", { x_name: "calc", x_total: 5 }, { id: CONTACT }))),
  ];
  for (const refusal of refusals) assert.deepEqual(refusal, { status: 400, innerCode: "0x80048d19", message: web.body.error.message });
  const portalCalc = await portal("POST", "/x_items", { x_name: "calc", x_total: 5 });
  assert.equal(portalCalc.status, 400);
  // The portal wraps a Dataverse error in its CDS envelope (9004010D) with the organization's code and message inside.
  assert.deepEqual(portalCalc.body.error.innererror, { code: "0x80048d19", message: web.body.error.message });

  assert.equal((await webApi("POST", "/x_items", { x_name: "first", x_code: "DUP" })).status, 201);
  const duplicate = await webApi("POST", "/x_items", { x_name: "again", x_code: "DUP" });
  assert.equal(duplicate.status, 412);
  assert.equal(duplicate.body.error.code, "0x80060892");
  const duplicates = [
    await errorOf(() => sdk.create("x_item", { x_name: "again", x_code: "DUP" })),
    await errorOf(() => clr("Create", { $type: "Entity", logicalName: "x_item", attributes: { x_name: "again", x_code: "DUP" } })),
    await errorOf(() => connector("CreateRecord", { entityName: "x_item", "item/x_name": "again", "item/x_code": "DUP" })),
    await errorOf(() => formWrites((writes) => writes.create("x_item", { x_name: "again", x_code: "DUP" }, { id: CONTACT }))),
  ];
  for (const refusal of duplicates) assert.deepEqual(refusal, { status: 412, innerCode: "0x80060892", message: duplicate.body.error.message });
  const portalDuplicate = await portal("POST", "/x_items", { x_name: "again", x_code: "DUP" });
  assert.equal(portalDuplicate.status, 412);
  assert.deepEqual(portalDuplicate.body.error.innererror, { code: "0x80060892", message: duplicate.body.error.message });
});

test("an update and a delete run the pipeline on every write surface", async (t) => {
  const { webApi, sdk, connector, formWrites, stored, sim } = await organization(t);
  const created = (await webApi("POST", "/x_items", { x_name: "row", x_code: "R", x_amount: 1 })).body.x_itemid;
  const before = stored("row").versionnumber;
  sdk.update("x_item", created, { x_amount: 2 });
  const afterSdk = stored("row");
  assert.ok(afterSdk.versionnumber > before, "an SDK update takes the next row version");
  assert.deepEqual(await errorOf(() => sdk.update("x_item", created, { x_total: 1 })), { status: 400, innerCode: "0x80048d19", message: "The attribute 'x_total' of entity 'x_item' is a calculated field and cannot be set." });
  await connector("UpdateRecord", { entityName: "x_item", recordId: created, "item/x_amount": 4 });
  assert.ok(stored("row").versionnumber > afterSdk.versionnumber, "a connector update takes the next row version");
  await formWrites((writes) => writes.update("x_item", created, { x_amount: 5 }, { id: CONTACT }));
  assert.equal(Number(stored("row").x_amount), 5);
  await connector("DeleteRecord", { entityName: "x_item", recordId: created });
  assert.equal(stored("row"), undefined);
  assert.equal(sim.store.tableRows("x_item").length, 0);
});

test("the read projection is the same through the Web API, the SDK, the connector and the portal /_api", async (t) => {
  const { webApi, portal, sdk, clr, connector } = await organization(t);
  const id = (await webApi("POST", "/x_items", { x_name: "read", x_code: "RD", x_amount: 4 })).body.x_itemid;
  const web = await webApi("GET", `/x_items(${id})?$select=x_name,x_total`);
  assert.equal(Number(web.body.x_total), 8);
  assert.equal(Number(sdk.get("x_item", id).x_total), 8, "SDK Retrieve projects the calculated value");
  assert.equal(clr("Retrieve", "x_item", { $type: "Guid", value: id }, { allColumns: true }).attributes.x_total?.value, "8", "CLR bridge Retrieve");
  assert.equal(Number(sdk.query("x_item", { $select: "x_name,x_total", $filter: "x_code eq 'RD'" }).value[0].x_total), 8, "SDK RetrieveMultiple");
  assert.equal(Number((await connector("GetItem", { entityName: "x_item", recordId: id })).body.x_total), 8, "connector GetItem");
  const read = await portal("GET", `/x_items(${id})?$select=x_name,x_total`);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.equal(Number(read.body.x_total), 8, "portal /_api");
});

// Associate and disassociate (a 1:N collection navigation) run the same pipeline on the Web API $ref, the SDK, the flow
// connector and the portal /_api $ref: the relationship write, and the record hooks (here the audit hook's Associate 33 and
// Disassociate 34 rows) once per association.
test("associate and disassociate run the record hooks on the Web API, the SDK, the connector and the portal /_api", async (t) => {
  const { sim, webApi, portal, sdk, connector } = await organization(t);
  await sim.store.transact(() => { for (const row of sim.store.state.tables.organization ?? []) row.isauditenabled = true; });
  const origin = sim.dataverse.origin + "/api/data/v9.2";
  const pair = async (name) => {
    const item = (await webApi("POST", "/x_items", { x_name: name, x_code: name })).body.x_itemid;
    const line = (await webApi("POST", "/x_lines", { x_name: name })).body.x_lineid;
    return { item, line };
  };
  const lineItem = (line) => { const value = sim.store.tableRows("x_line").find((row) => row.x_lineid === line)?.x_itemid; return value?.id ?? value ?? null; };
  const actions = (item) => sim.store.tableRows("audit").filter((row) => String(row.objectid?.id ?? row.objectid).toLowerCase() === item && row.action >= 33).map((row) => row.action).sort();
  const reference = (line) => ({ $type: "EntityReferenceCollection", values: [{ $type: "EntityReference", logicalName: "x_line", id: line }] });
  const relationship = { $type: "Relationship", schemaName: "x_item_x_line" };
  const surfaces = {
    web: async ({ item, line }) => {
      assert.equal((await webApi("POST", `/x_items(${item})/x_item_lines/$ref`, { "@odata.id": `${origin}/x_lines(${line})` })).status, 204);
      assert.equal(lineItem(line), item);
      assert.equal((await webApi("DELETE", `/x_items(${item})/x_item_lines(${line})/$ref`)).status, 204);
    },
    // The SDK service and the connector run inside the caller's store transaction here, as a CLR plug-in's SDK calls run
    // inside the write that triggered it: the asynchronous audit hook's remainder joins that transaction (outside one it
    // finishes after the synchronous call, local-organization-service.mjs SDK_DEFERRED_EFFECT).
    sdk: async ({ item, line }) => {
      await sim.store.transact(() => sdk.associate("x_item", item, relationship, reference(line), true));
      assert.equal(lineItem(line), item);
      await sim.store.transact(() => sdk.associate("x_item", item, relationship, reference(line), false));
    },
    flow: async ({ item, line }) => {
      const related = `${origin}/x_lines(${line})`;
      const inWrite = (fn) => sim.store.transact(fn);
      assert.equal((await inWrite(() => connector("AssociateEntities", { entityName: "x_item", recordId: item, associationEntityRelationship: "x_item_x_line", "@odata.id": related }))).statusCode, 204);
      assert.equal(lineItem(line), item);
      assert.equal((await inWrite(() => connector("DisassociateEntities", { entityName: "x_item", recordId: item, associationEntityRelationship: "x_item_x_line", $id: related }))).statusCode, 204);
    },
    portal: async ({ item, line }) => {
      const posted = await portal("POST", `/x_items(${item})/x_item_lines/$ref`, { "@odata.id": `${sim.url}/_api/x_lines(${line})` });
      assert.equal(posted.status, 204, JSON.stringify(posted.body));
      assert.equal(lineItem(line), item);
      const removed = await portal("DELETE", `/x_items(${item})/x_item_lines(${line})/$ref`);
      assert.equal(removed.status, 204, JSON.stringify(removed.body));
    },
  };
  for (const [name, run] of Object.entries(surfaces)) {
    const ids = await pair(name);
    await run(ids);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(lineItem(ids.line), null, `${name} disassociated`);
    assert.deepEqual(actions(ids.item), [33, 34], `${name} ran the association record hooks`);
  }
});

test("Merge writes the target and the subordinate through the pipeline (actor and row version stamps)", async (t) => {
  const { webApi, sim, appUser } = await organization(t);
  const SUBORDINATE = "77777777-7777-4777-8777-000000000012";
  await sim.store.transact(() => { sim.store.state.tables.contact.push({ contactid: SUBORDINATE, fullname: "Invented Duplicate", statecode: 0 }); });
  const typed = (id) => ({ "@odata.type": "Microsoft.Dynamics.CRM.contact", contactid: id });
  const merged = await webApi("POST", "/Merge", { Target: typed(CONTACT), Subordinate: typed(SUBORDINATE), PerformParentingChecks: false });
  assert.equal(merged.status, 204, JSON.stringify(merged.body));
  const row = (id) => sim.store.tableRows("contact").find((item) => item.contactid === id);
  for (const id of [CONTACT, SUBORDINATE]) {
    assert.equal(typeof row(id).versionnumber, "number", "the merge write takes an organization row version");
    assert.equal(String(row(id).modifiedby?.id).toLowerCase(), String(appUser.systemuserid).toLowerCase(), "modifiedby names the caller");
  }
  assert.equal(row(SUBORDINATE).statecode, 1);
});
