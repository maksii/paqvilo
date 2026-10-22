// Business process flows (lib/dataverse-bpf.mjs): category-4 inventory, instance rows through createInstance, the existing BPF
// messages and the SetProcess 501 with its pack override. Invented x_ schema and GUIDs only; loopback fixture.
import test from "node:test";
import assert from "node:assert/strict";
import { EXTENSION, createInstance } from "../lib/dataverse-bpf.mjs";
import { addonHandlers } from "../lib/dataverse-addon-common.mjs";
import { contractModuleFixture } from "./contract-module-fixture.mjs";

const FLOW_OK = "88888888-8888-4888-8888-888888888801";
const FLOW_BAD = "88888888-8888-4888-8888-888888888802";
const STAGE_ONE = "88888888-8888-4888-8888-888888888811";
const STAGE_TWO = "88888888-8888-4888-8888-888888888812";
const ORDER = "88888888-8888-4888-8888-888888888821";

const ORDER_MAPPING = {
  logicalName: "x_order", entitySet: "x_orders", idColumn: "x_orderid", nameColumn: "x_name",
  fields: { x_name: { dataverseType: "nvarchar" } },
};
const INSTANCE_MAPPING = {
  x_orderflow: {
    logicalName: "x_orderflow", entitySet: "x_orderflows", idColumn: "x_orderflowid",
    fields: { x_orderflowid: { dataverseType: "uniqueidentifier" }, processid: { dataverseType: "uniqueidentifier" } },
  },
};
const MAPPINGS = { x_order: ORDER_MAPPING };
const TABLES = {
  x_order: [{ x_orderid: ORDER, x_name: "Invented order" }],
  workflow: [
    // A parseable flow: the stages come from clientdata JSON; the second stage names no entity, so it takes the primary entity.
    {
      workflowid: FLOW_OK, name: "Invented order flow", category: 4, type: 1, statecode: 1, statuscode: 2, primaryentity: "x_order", uniquename: "x_orderflow",
      clientdata: JSON.stringify({ stages: [{ stageid: STAGE_ONE, stagename: "Qualify", entityname: "x_order" }, { stageid: STAGE_TWO, stagename: "Close" }] }),
    },
    // An unparsed flow: its XAML stage names no id, so there is no simple stage list.
    {
      workflowid: FLOW_BAD, name: "Invented unparsed flow", category: 4, type: 1, statecode: 1, statuscode: 2, primaryentity: "x_order", uniquename: "x_badflow",
      xaml: '<Stages><stage stagename="Only a name"/></Stages>',
    },
    // A classic workflow (category 0) is not a flow.
    { workflowid: "88888888-8888-4888-8888-888888888803", name: "Invented classic", category: 0, type: 1, statecode: 1, primaryentity: "x_order" },
  ],
};

// The fixture returns the HTTP handle; the internal api that the module installs on is captured here, through a wrapper of install.
async function setup(t, { mappings = MAPPINGS, options = {} } = {}) {
  const diagnostics = [];
  const captured = {};
  const extension = { ...EXTENSION, install: (api, opts) => { captured.api = api; return EXTENSION.install(api, opts); } };
  const { store, request, json } = await contractModuleFixture(t, {
    mappings, tables: TABLES, extension,
    options: { diagnostic: (entry) => diagnostics.push(entry), ...options },
  });
  return { api: captured.api, store, request, json, diagnostics };
}

test("the inventory lists category-4 flows with their stages and reports the unparsed flow once", async (t) => {
  const { api, diagnostics } = await setup(t);
  const flows = api.businessProcessFlows.list();
  assert.deepEqual(flows.map((flow) => flow.workflowid), [FLOW_OK, FLOW_BAD]);
  assert.deepEqual(flows[0], {
    workflowid: FLOW_OK, name: "Invented order flow", uniquename: "x_orderflow", primaryentity: "x_order",
    stages: [{ id: STAGE_ONE, name: "Qualify", entity: "x_order" }, { id: STAGE_TWO, name: "Close", entity: "x_order" }],
  });
  assert.deepEqual(flows[1].stages, []);
  assert.deepEqual(api.businessProcessFlows.for("x_order").map((flow) => flow.workflowid), [FLOW_OK, FLOW_BAD]);
  assert.deepEqual(api.businessProcessFlows.for("x_other"), []);
  api.businessProcessFlows.list();
  const unparsed = api.businessProcessFlows.diagnostics().filter((entry) => entry.code === "BPF_DEFINITION_UNPARSED");
  assert.equal(unparsed.length, 1);
  assert.equal(unparsed[0].workflowId, FLOW_BAD);
  assert.equal(diagnostics.filter((entry) => entry.code === "BPF_DEFINITION_UNPARSED").length, 1);
});

test("createInstance writes the instance at the first stage when the instance table exists, and the existing message lists it", async (t) => {
  const { api, store, request, json } = await setup(t, { mappings: { ...MAPPINGS, ...INSTANCE_MAPPING } });
  const first = await createInstance(api, FLOW_OK, ORDER);
  const second = await createInstance(api, FLOW_OK, ORDER);
  assert.notEqual(first.x_orderflowid, second.x_orderflowid);
  const rows = store.state.tables.x_orderflow;
  assert.equal(rows.length, 2);
  // The instance runs the record pipeline: it carries the audit stamps (SYSTEM, since a flow starts it) and the version.
  const { createdon, modifiedon, createdby, modifiedby, createdonbehalfby, modifiedonbehalfby, ownerid, owninguser, owningteam, owningbusinessunit, versionnumber, statecode, statuscode, ...stored } = rows[0];
  assert.equal(typeof createdon, "string", "the pipeline stamps the row");
  assert.equal(modifiedon, createdon);
  assert.equal(createdby?.name, "SYSTEM");
  assert.deepEqual(stored, {
    x_orderflowid: first.x_orderflowid, businessprocessflowinstanceid: first.x_orderflowid, processid: FLOW_OK,
    activestageid: STAGE_ONE, traversedpath: STAGE_ONE, bpf_x_orderid: ORDER,
  });
  const listed = await json(await request("GET", `/RetrieveProcessInstances(EntityId=${ORDER},EntityLogicalName='x_order')`), 200);
  assert.deepEqual(listed.value.map((row) => row.x_orderflowid).sort(), [first.x_orderflowid, second.x_orderflowid].sort());
  assert.equal(listed.value[0].processstageid, STAGE_ONE);
});

test("createInstance without the instance table reports BPF_INSTANCE_TABLE_MISSING once and creates nothing", async (t) => {
  const { api, store, diagnostics } = await setup(t);
  assert.equal(await createInstance(api, FLOW_OK, ORDER), null);
  assert.equal(await createInstance(api, FLOW_OK, ORDER), null);
  assert.equal(store.state.tables.x_orderflow, undefined);
  assert.equal(diagnostics.filter((entry) => entry.code === "BPF_INSTANCE_TABLE_MISSING").length, 1);
});

test("createInstance refuses an unparsed, inactive or unknown flow with its diagnostic and creates nothing", async (t) => {
  const { api, store, diagnostics } = await setup(t, { mappings: { ...MAPPINGS, ...INSTANCE_MAPPING } });
  assert.equal(await createInstance(api, FLOW_BAD, ORDER), null);
  store.state.tables.workflow.find((row) => row.workflowid === FLOW_OK).statecode = 0;
  assert.equal(await createInstance(api, FLOW_OK, ORDER), null);
  assert.equal(await createInstance(api, "88888888-8888-4888-8888-888888888899", ORDER), null);
  assert.equal(store.state.tables.x_orderflow, undefined);
  for (const code of ["BPF_DEFINITION_UNPARSED", "BPF_DEFINITION_NOT_ACTIVE", "BPF_DEFINITION_MISSING"]) {
    assert.equal(diagnostics.filter((entry) => entry.code === code).length, 1, code);
  }
  await assert.rejects(createInstance(api, FLOW_OK, "not-a-guid"), /GUID/);
});

test("SetProcess, which no BPF module here registers, answers 501 0x80040216; a pack dataverseMessages handler replaces it", async (t) => {
  const { api, request, json } = await setup(t);
  const response = await request("POST", "/SetProcess", {});
  assert.equal(response.status, 501);
  assert.match(await response.text(), /0x80040216/);
  api.addonHandlers = addonHandlers([{ id: "invented-pack", dataverseMessages: { SetProcess: async () => ({ Replaced: true }) } }]);
  const replaced = await json(await request("POST", "/SetProcess", {}), 200);
  assert.equal(replaced.Replaced, true);
});

test("describe is contract with the two operations and their levels; the module registers no message", async (t) => {
  const { api } = await setup(t);
  const record = EXTENSION.describe();
  assert.equal(record.level, "contract");
  assert.deepEqual(record.operations, ["BusinessProcessFlowInventory", "BusinessProcessFlowInstance"]);
  assert.deepEqual(record.operationLevels, { BusinessProcessFlowInventory: "inventory", BusinessProcessFlowInstance: "contract" });
  assert.deepEqual(record.requires, ["workflow:category=4"]);
  assert.equal(api.registry.has("BusinessProcessFlowInventory"), false);
});

test("createInstance awaited inside an open store transaction joins it and rolls back when the outer write throws", async (t) => {
  const { api, store } = await setup(t, { mappings: { ...MAPPINGS, ...INSTANCE_MAPPING } });
  let created = null;
  await assert.rejects(store.transact(async () => {
    created = await createInstance(api, FLOW_OK, ORDER);
    assert.equal(store.state.tables.x_orderflow.length, 1, "the row is visible inside the transaction");
    throw new Error("Invented outer failure");
  }), /Invented outer failure/);
  assert.equal(created.processid, FLOW_OK);
  assert.equal(store.state.tables.x_orderflow?.length ?? 0, 0);
});

test("a stage XAML nested deeper than 64 elements is unparsed, not a stack overflow", async (t) => {
  const deep = `${"<Step>".repeat(10000)}<stage stageid="${STAGE_ONE}" stagename="Deep"/>${"</Step>".repeat(10000)}`;
  const { api, diagnostics } = await setup(t);
  api.store.state.tables.workflow.find((row) => row.workflowid === FLOW_BAD).xaml = deep;
  assert.deepEqual(api.businessProcessFlows.list().find((flow) => flow.workflowid === FLOW_BAD).stages, []);
  assert.equal(diagnostics.filter((entry) => entry.code === "BPF_DEFINITION_UNPARSED" && entry.workflowId === FLOW_BAD).length, 1);
});
