// Business rules (lib/dataverse-business-rules.mjs): server-scope rules of workflow category 2 evaluated inside the write.
// Set value / default / error / required on create and update, client-only rules as diagnostics, pack override, rollback.
// Invented x_ schema and GUIDs only.
import test from "node:test";
import assert from "node:assert/strict";
import { EXTENSION, businessRulesFor, parseBusinessRule, validateBusinessRules } from "../lib/dataverse-business-rules.mjs";
import { contractModuleFixture } from "./contract-module-fixture.mjs";

const ORDER = "33333333-3333-4333-8333-333333333333";
const RULE_SET = "44444444-4444-4444-8444-444444444401";
const RULE_DEFAULT = "44444444-4444-4444-8444-444444444402";
const RULE_ERROR = "44444444-4444-4444-8444-444444444403";
const RULE_REQUIRED = "44444444-4444-4444-8444-444444444404";
const RULE_CLIENT = "44444444-4444-4444-8444-444444444405";
const RULE_FORM = "44444444-4444-4444-8444-444444444406";

const rule = (workflowid, name, xaml, extra = {}) => ({
  workflowid, name, category: 2, type: 1, statecode: 1, statuscode: 2, primaryentity: "x_order", processtriggerscope: 2, xaml, ...extra,
});
const RULES = [
  // Priority 1 when the amount is over 1000, else 3.
  rule(RULE_SET, "Invented priority", '<Activity><ConditionBranchStep><Condition Attribute="x_amount" Operator="gt" Value="1000"/>'
    + '<Then><SetAttributeValueStep Attribute="x_priority" Value="1"/></Then><Else><SetAttributeValueStep Attribute="x_priority" Value="3"/></Else>'
    + '</ConditionBranchStep></Activity>'),
  rule(RULE_DEFAULT, "Invented channel default", '<Activity><SetDefaultValueStep Attribute="x_channel" Value="&quot;web&quot;"/></Activity>'),
  rule(RULE_ERROR, "Invented negative amount", '<Activity><ConditionBranchStep><Condition Attribute="x_amount" Operator="lt" Value="0"/>'
    + '<Then><SetMessageStep Attribute="x_amount" Message="The amount cannot be negative."/></Then></ConditionBranchStep></Activity>'),
  rule(RULE_REQUIRED, "Invented reference required", '<Activity><ConditionBranchStep><Condition Attribute="x_amount" Operator="ge" Value="5000"/>'
    + '<Then><SetFieldRequiredLevelStep Attribute="x_reference" RequiredLevel="required"/></Then></ConditionBranchStep></Activity>'),
  rule(RULE_CLIENT, "Invented lock", '<Activity><SetDisplayModeStep Attribute="x_amount" IsReadOnly="true"/><SetVisibilityStep Attribute="x_reference" Visible="false"/></Activity>'),
  // Form scope: client only, never evaluated by the server.
  rule(RULE_FORM, "Invented form rule", '<Activity><SetMessageStep Message="form only"/></Activity>', { processtriggerscope: 1 }),
];

const mappings = {
  x_order: {
    logicalName: "x_order", entitySet: "x_orders", idColumn: "x_orderid", nameColumn: "x_name",
    fields: {
      x_name: { dataverseType: "nvarchar" }, x_amount: { dataverseType: "int" }, x_priority: { dataverseType: "int" },
      x_channel: { dataverseType: "nvarchar" }, x_reference: { dataverseType: "nvarchar" },
    },
  },
};
const tables = {
  x_order: [{ x_orderid: ORDER, x_name: "Invented order", x_amount: 10, x_priority: 3, x_channel: "phone", x_reference: null, statecode: 0, statuscode: 1 }],
  workflow: RULES,
};

async function setup(t, options = {}) {
  const diagnostics = [];
  const fixture = await contractModuleFixture(t, { mappings, tables, extension: EXTENSION, options: { diagnostic: (entry) => diagnostics.push(entry), ...options } });
  const rowNamed = (name) => fixture.store.state.tables.x_order.find((row) => row.x_name === name) ?? null;
  return { ...fixture, diagnostics, rowNamed };
}

test("set value and set default apply on create; the default does not overwrite a given value", async (t) => {
  const { request, json } = await setup(t);
  const big = await json(await request("POST", "/x_orders", { x_name: "Big", x_amount: 2000 }), 201);
  assert.equal(big.x_priority, 1);
  assert.equal(big.x_channel, "web");
  const small = await json(await request("POST", "/x_orders", { x_name: "Small", x_amount: 5, x_channel: "store" }), 201);
  assert.equal(small.x_priority, 3);
  assert.equal(small.x_channel, "store");
});

test("set value applies on update against the merged row; set default does not run on update", async (t) => {
  const { request, json, store } = await setup(t);
  await json(await request("PATCH", `/x_orders(${ORDER})`, { x_amount: 1500, x_channel: null }), 200);
  const row = store.state.tables.x_order.find((item) => item.x_orderid === ORDER);
  assert.equal(row.x_priority, 1);
  assert.equal(row.x_channel, null);
});

test("show error message fails the create with 400 and rolls it back", async (t) => {
  const { request, json, rowNamed } = await setup(t);
  const body = await json(await request("POST", "/x_orders", { x_name: "Negative", x_amount: -1 }), 400);
  assert.equal(body.error.message, "The amount cannot be negative.");
  assert.equal(body.error.code, "0x80040265");
  assert.equal(rowNamed("Negative"), null);
});

test("show error message fails the update and leaves the row unchanged", async (t) => {
  const { request, json, store } = await setup(t);
  await json(await request("PATCH", `/x_orders(${ORDER})`, { x_amount: -5, x_name: "Changed" }), 400);
  const row = store.state.tables.x_order.find((item) => item.x_orderid === ORDER);
  assert.equal(row.x_amount, 10);
  assert.equal(row.x_name, "Invented order");
});

test("set required fails a write that leaves the column empty, on create and on update", async (t) => {
  const { request, json, rowNamed, store } = await setup(t);
  const created = await json(await request("POST", "/x_orders", { x_name: "Large", x_amount: 6000 }), 400);
  assert.match(created.error.message, /x_reference/);
  assert.equal(rowNamed("Large"), null);
  await json(await request("POST", "/x_orders", { x_name: "Large with reference", x_amount: 6000, x_reference: "R-1" }), 201);
  await json(await request("PATCH", `/x_orders(${ORDER})`, { x_amount: 7000 }), 400);
  assert.equal(store.state.tables.x_order.find((item) => item.x_orderid === ORDER).x_amount, 10);
});

test("client-only and form-scope rules have no server behaviour; client-only reports one diagnostic", async (t) => {
  const { request, json, diagnostics } = await setup(t);
  await json(await request("POST", "/x_orders", { x_name: "One", x_amount: 1 }), 201);
  await json(await request("POST", "/x_orders", { x_name: "Two", x_amount: 2 }), 201);
  const client = diagnostics.filter((entry) => entry.code === "BUSINESS_RULE_CLIENT_ONLY");
  assert.equal(client.length, 1);
  assert.equal(client[0].workflowId, RULE_CLIENT);
  assert.deepEqual(client[0].actions, ["setdisplaymodestep", "setvisibilitystep"]);
  assert.equal(diagnostics.some((entry) => entry.workflowId === RULE_FORM), false);
});

test("a pack businessRules handler wins over the parsed rule", async (t) => {
  const seen = [];
  const { request, json, rowNamed } = await setup(t, {
    businessRules: {
      [RULE_SET]: (ctx) => { seen.push(ctx); return { target: { x_priority: 9 } }; },
      [RULE_ERROR]: (ctx) => (ctx.target.x_name === "Blocked" ? { error: "Blocked by the pack." } : {}),
    },
  });
  const created = await json(await request("POST", "/x_orders", { x_name: "Packed", x_amount: 2000 }), 201);
  assert.equal(created.x_priority, 9);
  assert.equal(seen[0].operation, "create");
  assert.equal(seen[0].table, "x_order");
  const blocked = await json(await request("POST", "/x_orders", { x_name: "Blocked", x_amount: -1 }), 400);
  assert.equal(blocked.error.message, "Blocked by the pack.");
  assert.equal(rowNamed("Blocked"), null);
});

test("businessRulesFor, the parser, validateBusinessRules and describe", () => {
  const store = { tableRows: () => RULES };
  const parsed = businessRulesFor(store, "x_order");
  assert.equal(parsed.length, 6);
  assert.equal(parsed.find((item) => item.workflowId === RULE_FORM).scope, "form");
  assert.equal(parsed.find((item) => item.workflowId === RULE_SET).steps[0].kind, "condition");
  assert.match(parseBusinessRule('<Activity><mxswa:ActivityReference/></Activity>').unsupported, /not supported/);
  assert.throws(() => validateBusinessRules({ "not-a-guid": () => ({}) }), /GUID/);
  assert.throws(() => validateBusinessRules({ [RULE_SET]: async () => ({}) }), /synchronous/);
  const record = EXTENSION.describe();
  assert.equal(record.level, "contract");
  assert.deepEqual(record.requires, ["workflow:category=2"]);
  assert.ok(record.operations.includes("ShowErrorMessage"));
});

test("describe(api) is behaviour only when the pack overrides cover every entity-scope rule", async (t) => {
  const partial = await setup(t, { businessRules: { [RULE_SET]: () => ({}) } });
  assert.equal(partial.api.businessRules.describe().level, "contract");
  const entityRules = RULES.filter((item) => item.processtriggerscope === 2).map((item) => [item.workflowid, () => ({})]);
  const covered = await setup(t, { businessRules: Object.fromEntries(entityRules) });
  assert.equal(covered.api.businessRules.describe().level, "behaviour");
});

test("the parse cache keeps one entry per rule however often its XAML changes", () => {
  const row = rule(RULE_SET, "Invented changing rule", "");
  const store = { tableRows: () => [row] };
  const parsed = new Map();
  for (let index = 0; index < 100; index += 1) {
    row.xaml = `<Activity><SetAttributeValueStep Attribute="x_priority" Value="${index}"/></Activity>`;
    assert.equal(businessRulesFor(store, "x_order", parsed)[0].steps[0].value, index);
  }
  assert.equal(parsed.size, 1);
});

test("a committed workflow change reaches the next write: the per-revision rule index is not stale", async (t) => {
  const { request, json, api, store } = await setup(t);
  assert.equal((await json(await request("POST", "/x_orders", { x_name: "Before", x_amount: 2000 }), 201)).x_priority, 1);
  // The rule now sets priority 7 unconditionally; the store-level transaction commits and advances the revision.
  await store.transact(() => { store.state.tables.workflow.find((item) => item.workflowid === RULE_SET).xaml = '<Activity><SetAttributeValueStep Attribute="x_priority" Value="7"/></Activity>'; });
  assert.equal((await json(await request("POST", "/x_orders", { x_name: "After", x_amount: 2000 }), 201)).x_priority, 7);
  assert.equal(api.businessRulesFor("x_order").length, 6);
});

test("a pack override that mutates ctx.rule does not change the cached rule", async (t) => {
  const { request, json, api } = await setup(t, {
    businessRules: { [RULE_DEFAULT]: (ctx) => { ctx.rule.steps.length = 0; ctx.rule.name = "Mutated"; return {}; } },
  });
  await json(await request("POST", "/x_orders", { x_name: "Mutating", x_amount: 1 }), 201);
  const cached = api.businessRulesFor("x_order").find((item) => item.workflowId === RULE_DEFAULT);
  assert.equal(cached.name, "Invented channel default");
  assert.equal(cached.steps.length, 1);
});

test("a 10,000-deep condition nest reports BUSINESS_RULE_UNSUPPORTED, never 500", async (t) => {
  const deep = `<Activity>${'<ConditionBranchStep><Condition Attribute="x_amount" Operator="gt" Value="0"/><Then>'.repeat(10000)}`
    + `<SetAttributeValueStep Attribute="x_priority" Value="1"/>${"</Then></ConditionBranchStep>".repeat(10000)}</Activity>`;
  assert.match(parseBusinessRule(deep).unsupported, /deeper than 64/);
  const diagnostics = [];
  const { request, json } = await contractModuleFixture(t, {
    mappings, tables: { ...tables, workflow: [rule(RULE_SET, "Invented deep rule", deep)] }, extension: EXTENSION,
    options: { diagnostic: (entry) => diagnostics.push(entry) },
  });
  await json(await request("POST", "/x_orders", { x_name: "Deep", x_amount: 5 }), 201);
  assert.match(diagnostics.find((entry) => entry.code === "BUSINESS_RULE_UNSUPPORTED").message, /deeper than 64/);
});
