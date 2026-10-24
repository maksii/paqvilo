// Column security on every read route: a caller without read permission on a secured column never receives its value
// (by default the API returns no data for a secured column). CUST is a System Customizer without a field security profile.
import test from "node:test";
import assert from "node:assert/strict";
import { CUST, readFixture } from "./read-projection-fixture.mjs";

const ITEM = "77777777-7777-4777-8777-000000000001", CHILD = "77777777-7777-4777-8777-000000000002";
const SECRET = "TOP-SECRET-123";
const mappings = {
  x_item: { logicalName: "x_item", entitySet: "x_items", idColumn: "x_itemid", nameColumn: "x_name",
    relationships: { x_item_children: { entity: "x_child", from: "x_itemid", to: "x_itemid", many: true } },
    fields: { x_name: { dataverseType: "nvarchar" }, x_secret: { dataverseType: "nvarchar", columnMetadata: { isSecured: true } } } },
  x_child: { logicalName: "x_child", entitySet: "x_children", idColumn: "x_childid", nameColumn: "x_name",
    relationships: { x_itemid: { entity: "x_item", from: "x_itemid", to: "x_itemid", many: false } },
    fields: { x_name: { dataverseType: "nvarchar" }, x_itemid: { dataverseType: "lookup" } } },
};
const tables = {
  x_item: [{ x_itemid: ITEM, x_name: "Invented", x_secret: SECRET, statecode: 0, statuscode: 1 }],
  x_child: [{ x_childid: CHILD, x_name: "Child", x_itemid: { id: ITEM, logical_name: "x_item" }, statecode: 0, statuscode: 1 }],
};

test("property route returns null for a secured column without read permission", async (t) => {
  const f = await readFixture(t, { mappings, tables });
  const response = await f.request("GET", `/x_items(${ITEM})/x_secret`, undefined, {}, CUST);
  assert.equal(response.status, 204);
  assert.doesNotMatch(await response.text(), /TOP-SECRET/);
  // The administrator still reads it.
  assert.equal((await f.json(await f.request("GET", `/x_items(${ITEM})/x_secret`), 200)).value, SECRET);
});

test("$value route answers 204 for a secured column without read permission", async (t) => {
  const f = await readFixture(t, { mappings, tables });
  const response = await f.request("GET", `/x_items(${ITEM})/x_secret/$value`, undefined, {}, CUST);
  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
});

test("every read route masks a secured column", async (t) => {
  const f = await readFixture(t, { mappings, tables });
  const fx = (xml) => `/x_items?fetchXml=${encodeURIComponent(xml)}`;
  const routes = [
    `/x_items(${ITEM})?$select=x_secret`,
    "/x_items?$select=x_secret",
    `/x_items(${ITEM})/x_secret`,
    `/x_items(${ITEM})/x_secret/$value`,
    `/x_children(${CHILD})/x_itemid?$select=x_secret`,
    "/x_children?$expand=x_itemid($select=x_secret)",
    "/x_items?$expand=x_item_children($select=x_name)&$select=x_secret",
    fx('<fetch><entity name="x_item"><attribute name="x_secret"/></entity></fetch>'),
    fx('<fetch><entity name="x_child"><attribute name="x_name"/><link-entity name="x_item" from="x_itemid" to="x_itemid" alias="p"><attribute name="x_secret"/></link-entity></entity></fetch>').replace("/x_items?", "/x_children?"),
    "/x_items?$apply=groupby((x_secret))",
  ];
  for (const route of routes) {
    const response = await f.request("GET", route, undefined, {}, CUST);
    const text = await response.text();
    assert.ok(response.status < 300 || response.status === 403, `${route}: ${response.status} ${text}`);
    assert.doesNotMatch(text, /TOP-SECRET/, route);
  }
  const tracked = await f.request("GET", "/x_items?$select=x_secret", undefined, { prefer: "odata.track-changes" }, CUST);
  assert.doesNotMatch(await tracked.text(), /TOP-SECRET/, "change tracking");
});
