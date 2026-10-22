// Value-based paging cursor: the paging cookie carries the order-column values and the primary key of the page's last
// row, so forward paging skips nothing when the cursor row is deleted or updated out of the filter between pages
// (Learn page-results, "Ordering and paging"). Invented schema and GUIDs only.
import test from "node:test";
import assert from "node:assert/strict";
import { keysetPage } from "../lib/data.mjs";
import { decodeSkipToken } from "../lib/dataverse-odata.mjs";
import { readFixture } from "./read-projection-fixture.mjs";

const id = (n) => `77777777-7777-4777-8777-${String(n).padStart(12, "0")}`;
const mappings = { x_item: { logicalName: "x_item", entitySet: "x_items", idColumn: "x_itemid", nameColumn: "x_name",
  fields: { x_name: { dataverseType: "nvarchar" }, x_rank: { dataverseType: "int" }, x_group: { dataverseType: "int" } } } };
const rows = Array.from({ length: 6 }, (_, i) => ({ x_itemid: id(i + 1), x_name: `n${i + 1}`, x_rank: i + 1, x_group: i % 2, statecode: 0, statuscode: 1 }));
const relative = (link) => link.replace(/^.*\/api\/data\/v9\.2/, "");

async function pager(t) {
  const f = await readFixture(t, { mappings, tables: { x_item: rows } });
  const page = async (url) => f.json(await f.request("GET", url, undefined, { prefer: "odata.maxpagesize=2" }), 200);
  return { f, page };
}

for (const [label, order, expected] of [
  ["default", "", ["n1", "n2", "n3", "n4"]],
  ["asc", "&$orderby=x_rank asc", ["n1", "n2", "n3", "n4"]],
  ["desc", "&$orderby=x_name desc", ["n6", "n5", "n4", "n3"]],
]) {
  test(`deleting the cursor row between pages skips nothing (${label})`, async (t) => {
    const { f, page } = await pager(t);
    const first = await page(`/x_items?$select=x_name${order}`);
    assert.equal((await f.request("DELETE", `/x_items(${first.value.at(-1).x_itemid})`)).status, 204);
    const second = await page(relative(first["@odata.nextLink"]));
    assert.deepEqual([...first.value, ...second.value].map((row) => row.x_name), expected);
  });
}

test("updating the cursor row out of the filter between pages skips nothing", async (t) => {
  const { f, page } = await pager(t);
  const first = await page("/x_items?$select=x_name&$orderby=x_rank asc&$filter=x_rank lt 100");
  assert.equal((await f.request("PATCH", `/x_items(${first.value.at(-1).x_itemid})`, { x_rank: 500 })).status, 200);
  const second = await page(relative(first["@odata.nextLink"]));
  assert.deepEqual(second.value.map((row) => row.x_name), ["n3", "n4"]);
});

test("cookie carries the order-column values for multi-column $orderby", async (t) => {
  const { page } = await pager(t);
  const first = await page("/x_items?$select=x_name&$orderby=x_group desc,x_rank asc");
  const token = decodeURIComponent(first["@odata.nextLink"].split("$skiptoken=")[1]);
  const cookie = decodeSkipToken(token);
  assert.deepEqual(cookie.orderValues, { x_group: "1", x_rank: "4" });
  assert.equal(cookie.lastId, id(4));
  const second = await page(relative(first["@odata.nextLink"]));
  assert.deepEqual([...first.value, ...second.value].map((row) => row.x_name), ["n2", "n4", "n6", "n1"]);
});

test("keysetPage resumes after saved values when the cursor row is gone", () => {
  const data = [5, 3, 9, 1, 7].map((rank, i) => ({ id: id(i), rank }));
  const options = { mapping: { idColumn: "id" }, valueOf: (row, path) => row[path[0]], definition: () => ({ dataverseType: "int" }) };
  const page = keysetPage(data, [{ path: ["rank"], descending: false }], options, { id: id(99), values: { rank: "3" } }, 2);
  assert.deepEqual(page.rows.map((row) => row.rank), [5, 7]);
  assert.equal(page.before, 2);
});

test("FetchXML paging cookie survives cursor-row delete", async (t) => {
  const { f } = await pager(t);
  const fetch = (cookie, pageNumber) => `<fetch count="2" page="${pageNumber}"${cookie ? ` paging-cookie="${cookie.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")}"` : ""}><entity name="x_item"><attribute name="x_name"/><order attribute="x_rank"/></entity></fetch>`;
  const read = async (xml) => f.json(await f.request("GET", `/x_items?fetchXml=${encodeURIComponent(xml)}`, undefined, { prefer: 'odata.include-annotations="*"' }), 200);
  const first = await read(fetch(null, 1));
  const wrapper = first["@Microsoft.Dynamics.CRM.fetchxmlpagingcookie"];
  const cookie = decodeURIComponent(decodeURIComponent(/pagingcookie="([^"]*)"/.exec(wrapper)[1]));
  assert.equal((await f.request("DELETE", `/x_items(${first.value.at(-1).x_itemid})`)).status, 204);
  const second = await read(fetch(cookie, 2));
  assert.deepEqual([...first.value, ...second.value].map((row) => row.x_name), ["n1", "n2", "n3", "n4"]);
});

// A null order value travels as the empty marker the OData skip token uses and resumes nulls first ascending: every row is
// paged once, with and without the page-1 cursor row deleted (Learn page-results).
test("FetchXML paging cookie with a null order value pages every row once", async (t) => {
  const nullable = [null, 2, null, 1, null, 3].map((x_rank, i) => ({ x_itemid: id(i + 1), x_name: "abcdef"[i], x_rank, statecode: 0, statuscode: 1 }));
  for (const removeCursor of [false, true]) {
    const f = await readFixture(t, { mappings, tables: { x_item: structuredClone(nullable) } });
    const escape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const xml = (cookie, n) => `<fetch count="2" page="${n}"${cookie ? ` paging-cookie="${escape(cookie)}"` : ""}><entity name="x_item"><attribute name="x_name"/><order attribute="x_rank"/></entity></fetch>`;
    const read = async (text) => f.json(await f.request("GET", `/x_items?fetchXml=${encodeURIComponent(text)}`, undefined, { prefer: 'odata.include-annotations="*"' }), 200);
    let page = await read(xml(null, 1));
    const seen = page.value.map((row) => row.x_name);
    if (removeCursor) assert.equal((await f.request("DELETE", `/x_items(${page.value.at(-1).x_itemid})`)).status, 204);
    for (let n = 2; page["@Microsoft.Dynamics.CRM.morerecords"] && n < 6; n++) {
      const cookie = decodeURIComponent(decodeURIComponent(/pagingcookie="([^"]*)"/.exec(page["@Microsoft.Dynamics.CRM.fetchxmlpagingcookie"])[1]));
      page = await read(xml(cookie, n));
      seen.push(...page.value.map((row) => row.x_name));
    }
    // Nulls first ascending (a, c, e), then 1, 2, 3 (d, b, f).
    assert.deepEqual(seen, ["a", "c", "e", "d", "b", "f"], removeCursor ? "cursor row deleted" : "control");
  }
});
