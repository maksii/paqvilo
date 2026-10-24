// Dataverse TDS catalog: exposed columns per store table and Web API row projection.
import test from "node:test";
import assert from "node:assert/strict";
import { DataStore, emptyState } from "../lib/data.mjs";
import { buildCatalog, informationSchema, projectRow } from "../lib/dataverse-tds-catalog.mjs";
import { FORMATTED, LOOKUP_LOGICAL } from "../lib/webapi-format.mjs";

const lookup = { dataverseType: "lookup" };

function store() {
  const state = emptyState();
  state.mappings.widget = {
    logicalName: "widget", entitySet: "widgets", idColumn: "widgetid", nameColumn: "name",
    fields: {
      name: { dataverseType: "nvarchar", maxLength: 200 },
      notes: { dataverseType: "memo" },
      price: { dataverseType: "money" },
      createdon: { dataverseType: "datetime" },
      active: { dataverseType: "bit" },
      statuscode: { dataverseType: "picklist", options: [{ value: 1, label: "Active", state: 0 }] },
      ownerid: { dataverseType: "owner" },
      owninguser: lookup,
      attachment: { dataverseType: "file" },
      tags: { dataverseType: "multiselectpicklist" },
    },
  };
  // Virtual tables are outside the SQL endpoint.
  state.mappings.sensor = { logicalName: "sensor", entitySet: "sensors", idColumn: "sensorid", isVirtual: true, fields: { reading: { dataverseType: "int" } } };
  return new DataStore({ state });
}

test("catalog exposes lookups, choices, money and datetime, and skips file, multi-select and virtual tables", () => {
  const catalog = buildCatalog({ store: store() });
  assert.equal(catalog.tables.has("sensor"), false);
  const widget = catalog.tables.get("widget");
  assert.equal(widget.entitySet, "widgets");
  const cols = Object.fromEntries(widget.columns.map((c) => [c.name, c]));

  assert.equal(cols.widgetid.nullable, false);
  assert.equal(cols.ownerid.sqlType, "uniqueidentifier");
  assert.deepEqual(cols.ownerid.source, { kind: "attribute", attribute: "_ownerid_value" });
  assert.equal(cols.owneridname.source.kind, "lookupName");
  assert.equal(cols.owneridtype.source.kind, "lookupType");
  assert.equal(cols.owninguser.sqlType, "uniqueidentifier");
  assert.equal(cols.owningusername.source.kind, "lookupName");
  assert.equal(cols.owningusertype, undefined, "non-polymorphic lookups have no type column");

  assert.equal(cols.statuscode.sqlType, "int");
  assert.equal(cols.statuscodename.source.kind, "choiceName");
  assert.deepEqual([cols.price.sqlType, cols.price.precision, cols.price.scale], ["money", 19, 4]);
  assert.equal(cols.createdon.sqlType, "datetime");
  assert.equal(cols.active.sqlType, "bit");
  assert.equal(cols.name.length, 200);
  assert.equal(cols.notes.length, -1, "memo is nvarchar(max)");

  assert.equal(cols.attachment, undefined, "file columns are excluded");
  assert.equal(cols.tags, undefined, "multi-select choices are excluded");
});

test("projectRow maps formatted lookup, choice and money values to SQL column names", () => {
  const widget = buildCatalog({ store: store() }).tables.get("widget");
  const formatted = {
    widgetid: "w1",
    price: "12.5000",
    createdon: "2026-10-19T08:00:00Z",
    statuscode: 1,
    [`statuscode${FORMATTED}`]: "Active",
    _ownerid_value: "u1",
    [`_ownerid_value${FORMATTED}`]: "Admin",
    [`_ownerid_value${LOOKUP_LOGICAL}`]: "systemuser",
    _owninguser_value: null,
  };
  const row = projectRow(widget, { widgetid: "w1", ownerid: "u1" }, formatted);
  assert.equal(row.widgetid, "w1");
  assert.equal(row.ownerid, "u1");
  assert.equal(row.owneridname, "Admin");
  assert.equal(row.owneridtype, "systemuser");
  assert.equal(row.statuscode, 1);
  assert.equal(row.statuscodename, "Active");
  assert.equal(row.price, "12.5000");
  assert.equal(row.owninguser, null);
  assert.equal(row.owningusername, null);
  // A plain column the formatted row omits falls back to the store row.
  assert.equal(projectRow(widget, { name: "Gear" }, {}).name, "Gear");
});

test("INFORMATION_SCHEMA is refused with a DataError", () => {
  const catalog = buildCatalog({ store: store() });
  assert.throws(() => informationSchema(catalog), { name: "DataError", code: "NotSupported" });
});

test('catalog excludes private storage mappings that have no routable entity set', () => {
  const data = store();
  data.state.mappings.x_private = { logicalName: 'x_private', idColumn: 'x_privateid', fields: { payload: { dataverseType: 'nvarchar' } } };
  data.state.mappings.x_empty = { logicalName: 'x_empty', entitySet: '', idColumn: 'x_emptyid', fields: {} };
  const catalog = buildCatalog({ store: data });
  assert.deepEqual([...catalog.tables.keys()], ['widget']);
});
