// One collation equality key: OData groupby, FetchXML distinct/groupby/countcolumn distinct and TDS DISTINCT, GROUP BY
// and = fold case and accents under the default CI_AI collation, as $filter equality already does; an _AS collation
// keeps accented variants apart.
import test from "node:test";
import assert from "node:assert/strict";
import { equalityKey } from "../lib/dataverse-values.mjs";
import { exactNumeric } from "../lib/exact-numeric.mjs";
import { executeBatch } from "../lib/dataverse-tds-sql-eval.mjs";
import { readFixture } from "./read-projection-fixture.mjs";

const id = (n) => `77777777-7777-4777-8777-${String(n).padStart(12, "0")}`;
const mappings = { x_item: { logicalName: "x_item", entitySet: "x_items", idColumn: "x_itemid", nameColumn: "x_name",
  fields: { x_name: { dataverseType: "nvarchar" }, x_city: { dataverseType: "nvarchar" } } } };
const cities = ["Zurich", "zurich", "Zürich", "ZURICH"];
const tables = { x_item: cities.map((city, i) => ({ x_itemid: id(i + 1), x_name: `n${i}`, x_city: city, statecode: 0, statuscode: 1 })) };
const fx = (xml) => `/x_items?fetchXml=${encodeURIComponent(xml)}`;

test("equalityKey folds text per collation and canonicalises numbers and ids", () => {
  assert.equal(equalityKey("Zürich"), equalityKey("ZURICH"));
  assert.notEqual(equalityKey("Zürich", "CI_AS"), equalityKey("Zurich", "CI_AS"));
  assert.equal(equalityKey("Zürich", "CI_AS"), equalityKey("zürich", "CI_AS"));
  assert.equal(equalityKey(1), equalityKey(exactNumeric("1.000", "Decimal")));
  assert.equal(equalityKey({ id: "{77777777-7777-4777-8777-000000000001}" }), equalityKey(id(1).toUpperCase()));
  assert.equal(equalityKey(null), equalityKey(""));
});

test("OData groupby folds case and accents under CI_AI", async (t) => {
  const f = await readFixture(t, { mappings, tables });
  const grouped = await f.json(await f.request("GET", "/x_items?$apply=groupby((x_city),aggregate($count as n))"), 200);
  assert.deepEqual(grouped.value.map((row) => [row.x_city, row.n]), [["Zurich", 4]]);
});

test("FetchXML distinct and groupby fold under CI_AI", async (t) => {
  const f = await readFixture(t, { mappings, tables });
  const distinct = await f.json(await f.request("GET", fx('<fetch distinct="true"><entity name="x_item"><attribute name="x_city"/><order attribute="x_city"/></entity></fetch>')), 200);
  assert.equal(distinct.value.length, 1);
  const grouped = await f.json(await f.request("GET", fx('<fetch aggregate="true"><entity name="x_item"><attribute name="x_city" groupby="true" alias="c"/><attribute name="x_itemid" aggregate="count" alias="n"/></entity></fetch>')), 200);
  assert.deepEqual(grouped.value.map((row) => row.n), [4]);
});

test("countcolumn distinct counts folded values", async (t) => {
  const f = await readFixture(t, { mappings, tables });
  const counted = await f.json(await f.request("GET", fx('<fetch aggregate="true"><entity name="x_item"><attribute name="x_city" aggregate="countcolumn" distinct="true" alias="d"/></entity></fetch>')), 200);
  assert.deepEqual(counted.value.map((row) => row.d), [1]);
});

test("an _AS collation keeps accented variants apart", async (t) => {
  const f = await readFixture(t, { mappings, tables, settings: { collation: "CI_AS" } });
  const grouped = await f.json(await f.request("GET", "/x_items?$apply=groupby((x_city),aggregate($count as n))"), 200);
  assert.deepEqual(grouped.value.map((row) => row.n).sort(), [1, 3]);
  const counted = await f.json(await f.request("GET", fx('<fetch aggregate="true"><entity name="x_item"><attribute name="x_city" aggregate="countcolumn" distinct="true" alias="d"/></entity></fetch>')), 200);
  assert.deepEqual(counted.value.map((row) => row.d), [2]);
});

test("TDS SELECT DISTINCT, GROUP BY and = fold accents under CI_AI", async () => {
  const catalog = { tables: new Map([["x_item", { logicalName: "x_item", columns: [
    { name: "x_itemid", sqlType: "uniqueidentifier", nullable: false }, { name: "x_city", sqlType: "nvarchar", length: 100, nullable: true }] }]]) };
  const scan = async () => tables.x_item.map((row) => ({ x_itemid: row.x_itemid, x_city: row.x_city }));
  const run = (sql, collation) => executeBatch(sql, { catalog, scan, now: new Date("2026-06-15T12:00:00Z"), ...(collation ? { collation } : {}) });
  assert.equal((await run("SELECT DISTINCT x_city FROM x_item")).resultSets[0].rows.length, 1);
  assert.deepEqual((await run("SELECT COUNT(*) AS n FROM x_item GROUP BY x_city")).resultSets[0].rows, [[4]]);
  assert.equal((await run("SELECT x_itemid FROM x_item WHERE x_city = 'zurich'")).resultSets[0].rows.length, 4);
  assert.equal((await run("SELECT DISTINCT x_city FROM x_item", "CI_AS")).resultSets[0].rows.length, 2);
});
