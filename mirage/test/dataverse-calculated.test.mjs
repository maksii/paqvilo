// Calculated columns (lib/dataverse-calculated.mjs): computed on read from the FormulaDefinition subset, one parent hop,
// unsupported formulas read null with one diagnostic, writes refused, pack override wins. Invented x_ schema only.
import test from "node:test";
import assert from "node:assert/strict";
import { EXTENSION, parseCalculatedFormula, validateCalculatedColumns } from "../lib/dataverse-calculated.mjs";
import { contractModuleFixture } from "./contract-module-fixture.mjs";

const PARENT = "11111111-1111-4111-8111-111111111111";
const ITEM = "22222222-2222-4222-8222-222222222222";
const calc = (formulaDefinition, dataverseType = "decimal") => ({ dataverseType, columnMetadata: { sourceType: 1, formulaDefinition } });

const FORMULAS = {
  // amount * quantity + parent rate
  x_total: '<Formula><Add><Multiply><Field Name="x_amount"/><Field Name="x_quantity"/></Multiply><Field Name="x_parentid.x_rate"/></Add></Formula>',
  x_label: '<Concat><Field Name="x_name"/><Constant Value=" / " Type="string"/><Field Name="x_parentid.x_name"/></Concat>',
  x_band: '<If><GreaterThan><Field Name="x_amount"/><Constant Value="100"/></GreaterThan><Constant Value="high" Type="string"/><Constant Value="low" Type="string"/></If>',
  x_due: '<AddDays><Field Name="x_start"/><Constant Value="10"/></AddDays>',
  x_span: '<DiffInDays><Field Name="x_start"/><Field Name="x_end"/></DiffInDays>',
  // A designer-style workflow XAML node: outside the subset.
  x_native: '<Activity><mxswa:ActivityReference AssemblyQualifiedName="Invented.EvaluateExpression"/></Activity>',
};

const mappings = {
  x_parent: {
    logicalName: "x_parent", entitySet: "x_parents", idColumn: "x_parentid", nameColumn: "x_name",
    fields: { x_name: { dataverseType: "nvarchar" }, x_rate: { dataverseType: "decimal" } },
  },
  x_item: {
    logicalName: "x_item", entitySet: "x_items", idColumn: "x_itemid", nameColumn: "x_name",
    relationships: { x_parentid: { entity: "x_parent", from: "x_parentid", to: "x_parentid", many: false } },
    fields: {
      x_name: { dataverseType: "nvarchar" }, x_amount: { dataverseType: "decimal" }, x_quantity: { dataverseType: "int" },
      x_start: { dataverseType: "datetime" }, x_end: { dataverseType: "datetime" }, x_parentid: { dataverseType: "lookup", targets: ["x_parent"] },
      x_total: calc(FORMULAS.x_total), x_label: calc(FORMULAS.x_label, "nvarchar"), x_band: calc(FORMULAS.x_band, "nvarchar"),
      x_due: calc(FORMULAS.x_due, "datetime"), x_span: calc(FORMULAS.x_span, "int"), x_native: calc(FORMULAS.x_native),
    },
  },
};
const tables = {
  x_parent: [{ x_parentid: PARENT, x_name: "Invented parent", x_rate: 5, statecode: 0, statuscode: 1 }],
  x_item: [{
    x_itemid: ITEM, x_name: "Invented item", x_amount: 150, x_quantity: 2, x_start: "2026-01-30T00:00:00.000Z", x_end: "2026-02-04T12:00:00.000Z",
    x_parentid: { id: PARENT, logical_name: "x_parent", name: "Invented parent" }, x_total: 999, statecode: 0, statuscode: 1,
  }],
};

async function setup(t, options = {}) {
  const diagnostics = [];
  const fixture = await contractModuleFixture(t, { mappings, tables, extension: EXTENSION, options: { diagnostic: (entry) => diagnostics.push(entry), ...options } });
  return { ...fixture, diagnostics };
}

test("supported formulas compute on read, including the one-hop parent field", async (t) => {
  const { request, json, diagnostics } = await setup(t);
  const row = await json(await request("GET", `/x_items(${ITEM})?$select=x_total,x_label,x_band,x_due,x_span`), 200);
  assert.equal(row.x_total, 305); // 150 * 2 + 5, never the stored 999
  assert.equal(row.x_label, "Invented item / Invented parent");
  assert.equal(row.x_band, "high");
  assert.equal(row.x_due, "2026-02-09T00:00:00Z"); // the Web API date form (computed before formatting, as every column)
  assert.equal(row.x_span, 5);
  assert.deepEqual(diagnostics, []);
});

test("an unsupported formula reads null and reports CALCULATED_UNSUPPORTED once per column", async (t) => {
  const { request, json, diagnostics } = await setup(t);
  for (let index = 0; index < 2; index += 1) {
    const row = await json(await request("GET", `/x_items(${ITEM})?$select=x_native`), 200);
    assert.equal(row.x_native, null);
  }
  await json(await request("GET", "/x_items?$select=x_native"), 200);
  const reported = diagnostics.filter((entry) => entry.code === "CALCULATED_UNSUPPORTED");
  assert.equal(reported.length, 1);
  assert.equal(reported[0].table, "x_item");
  assert.equal(reported[0].column, "x_native");
});

test("a write to a calculated column is refused and nothing is stored", async (t) => {
  const { request, json, store } = await setup(t);
  const created = await request("POST", "/x_items", { x_name: "Refused", x_total: 1 });
  const body = await json(created, 400);
  assert.equal(body.error.code, "0x80048d19");
  assert.match(body.error.message, /x_total/);
  assert.equal(store.state.tables.x_item.some((row) => row.x_name === "Refused"), false);
  const updated = await json(await request("PATCH", `/x_items(${ITEM})`, { x_band: "low" }), 400);
  assert.equal(updated.error.code, "0x80048d19");
});

test("a pack calculatedColumns function wins over the evaluator", async (t) => {
  const { request, json, diagnostics } = await setup(t, {
    calculatedColumns: {
      "x_item.x_total": (row, ctx) => row.x_amount + ctx.related("x_parentid").x_rate * 100,
      "x_item.x_native": () => 42,
    },
  });
  const row = await json(await request("GET", `/x_items(${ITEM})?$select=x_total,x_native`), 200);
  assert.equal(row.x_total, 650);
  assert.equal(row.x_native, 42);
  assert.deepEqual(diagnostics, []);
});

test("validateCalculatedColumns, the parser and describe", () => {
  assert.throws(() => validateCalculatedColumns({ total: () => 1 }), /<table>\.<column>/);
  assert.throws(() => validateCalculatedColumns({ "x_item.x_total": async () => 1 }), /synchronous/);
  assert.equal(typeof validateCalculatedColumns({ "X_Item.X_Total": () => 1 })["x_item.x_total"], "function");
  assert.match(parseCalculatedFormula("").unsupported, /no FormulaDefinition/);
  assert.match(parseCalculatedFormula('<Field Name="a.b.c"/>').unsupported, /one-hop/);
  assert.equal(parseCalculatedFormula('<Divide><Constant Value="1"/><Constant Value="0"/></Divide>').ast.kind, "divide");
  const record = EXTENSION.describe();
  assert.equal(record.level, "contract");
  assert.deepEqual(record.requires, ["metadata:FormulaDefinition"]);
  assert.ok(record.operations.includes("If") && record.operations.includes("AddDays"));
});

test("describe(api) is behaviour only when the pack overrides cover every calculated column", async (t) => {
  const partial = await setup(t, { calculatedColumns: { "x_item.x_total": () => 1 } });
  assert.equal(partial.api.calculatedColumns.describe().level, "contract");
  const all = Object.fromEntries(Object.keys(FORMULAS).map((column) => [`x_item.${column}`, () => 1]));
  const covered = await setup(t, { calculatedColumns: all });
  assert.equal(covered.api.calculatedColumns.describe().level, "behaviour");
});

test("a pack override that mutates ctx.related leaves the stored parent unchanged", async (t) => {
  const { request, json, store } = await setup(t, {
    calculatedColumns: {
      "x_item.x_total": (row, ctx) => {
        const parent = ctx.related("x_parentid");
        parent.x_rate = 1000;
        return parent.x_rate;
      },
    },
  });
  const row = await json(await request("GET", `/x_items(${ITEM})?$select=x_total`), 200);
  assert.equal(row.x_total, 1000);
  assert.equal(store.state.tables.x_parent[0].x_rate, 5);
});

test("a 10,000-deep formula reads null with CALCULATED_UNSUPPORTED, never 500", async (t) => {
  const deep = `${"<Add>".repeat(10000)}<Constant Value="1"/><Constant Value="2"/>${"</Add>".repeat(10000)}`;
  assert.match(parseCalculatedFormula(deep).unsupported, /deeper than 64/);
  const nested = structuredClone(mappings);
  nested.x_item.fields.x_native = calc(deep);
  const diagnostics = [];
  const { request, json } = await contractModuleFixture(t, { mappings: nested, tables, extension: EXTENSION, options: { diagnostic: (entry) => diagnostics.push(entry) } });
  const row = await json(await request("GET", `/x_items(${ITEM})?$select=x_native`), 200);
  assert.equal(row.x_native, null);
  assert.match(diagnostics.find((entry) => entry.column === "x_native").message, /deeper than 64/);
});
