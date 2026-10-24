// Exact JSON request bodies: decimal, money and Int64 literals a double cannot hold keep their digits on the direct
// Web API path and in JSON and multipart $batch (Edm.Decimal fixed precision, Edm.Int64).
import test from "node:test";
import assert from "node:assert/strict";
import { isExactNumeric } from "../lib/exact-numeric.mjs";
import { readFixture } from "./read-projection-fixture.mjs";

const mappings = { x_item: { logicalName: "x_item", entitySet: "x_items", idColumn: "x_itemid", nameColumn: "x_name", fields: {
  x_name: { dataverseType: "nvarchar" }, x_dec: { dataverseType: "decimal", precision: 10 }, x_big: { dataverseType: "bigint" },
  x_money: { dataverseType: "money", precision: 4 } } } };
const exact = (value) => (isExactNumeric(value) ? value.value : String(value));
const stored = (f, name) => f.store.state.tables.x_item.find((row) => row.x_name === name);

test("POST decimal with 18 significant digits stores and returns them exactly", async (t) => {
  const f = await readFixture(t, { mappings, tables: { x_item: [] } });
  const response = await f.request("POST", "/x_items?$select=x_dec", '{"x_name":"d","x_dec":12345678.1234567891}');
  const text = await response.text();
  assert.equal(response.status, 201, text);
  assert.match(text, /"x_dec":12345678\.1234567891[,}]/);
  assert.equal(exact(stored(f, "d").x_dec), "12345678.1234567891");
});

test("POST money 922337203685477.5807 round-trips exactly", async (t) => {
  const f = await readFixture(t, { mappings, tables: { x_item: [] } });
  // The currency stamp (base amount) is a separate module; without a base currency it only reports a diagnostic.
  await f.store.transact(() => { f.store.state.tables.transactioncurrency = []; });
  const response = await f.request("POST", "/x_items?$select=x_money", '{"x_name":"m","x_money":922337203685477.5807}');
  const text = await response.text();
  assert.equal(response.status, 201, text);
  assert.match(text, /"x_money":922337203685477\.5807[,}]/);
  assert.equal(exact(stored(f, "m").x_money), "922337203685477.5807");
});

test("POST bigint 9223372036854775807 as a JSON number is accepted", async (t) => {
  const f = await readFixture(t, { mappings, tables: { x_item: [] } });
  const response = await f.request("POST", "/x_items?$select=x_big", '{"x_name":"b","x_big":9223372036854775807}');
  const text = await response.text();
  assert.equal(response.status, 201, text);
  assert.match(text, /"x_big":9223372036854775807[,}]/);
  assert.equal(exact(stored(f, "b").x_big), "9223372036854775807");
  const small = await f.request("POST", "/x_items?$select=x_big", '{"x_name":"s","x_big":9007199254740993}');
  assert.equal(small.status, 201, await small.text());
  assert.equal(exact(stored(f, "s").x_big), "9007199254740993");
});

test("bigint out of range echoes the literal the client sent", async (t) => {
  const f = await readFixture(t, { mappings, tables: { x_item: [] } });
  const response = await f.request("POST", "/x_items", '{"x_name":"o","x_big":9223372036854775808}');
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.match(body.error.message, /Cannot convert the literal '9223372036854775808' to the expected type 'Edm\.Int64'/);
});

test("JSON $batch and multipart $batch keep exact decimals", async (t) => {
  const f = await readFixture(t, { mappings, tables: { x_item: [] } });
  const batch = '{"requests":[{"id":"1","method":"POST","url":"/api/data/v9.2/x_items","headers":{"content-type":"application/json"},"body":{"x_name":"jb","x_dec":12345678.1234567891}}]}';
  const json = await f.request("POST", "/$batch", batch, { "content-type": "application/json" });
  assert.equal(json.status, 200, await json.text());
  assert.equal(exact(stored(f, "jb").x_dec), "12345678.1234567891");
  const multipart = ["--b1", "Content-Type: application/http", "Content-Transfer-Encoding: binary", "", "POST /api/data/v9.2/x_items HTTP/1.1",
    "Content-Type: application/json", "", '{"x_name":"mb","x_dec":12345678.1234567891}', "--b1--", ""].join("\r\n");
  const mp = await f.request("POST", "/$batch", multipart, { "content-type": "multipart/mixed; boundary=b1" });
  assert.equal(mp.status, 200, await mp.text());
  assert.equal(exact(stored(f, "mb").x_dec), "12345678.1234567891");
  // A batch part answer serializes exact values as numbers, never as the internal marker.
  const read = await f.request("POST", "/$batch", JSON.stringify({ requests: [{ id: "r", method: "GET", url: `/api/data/v9.2/x_items(${stored(f, "jb").x_itemid})?$select=x_dec` }] }), { "content-type": "application/json" });
  const text = await read.text();
  assert.match(text, /"x_dec":12345678\.1234567891/);
  assert.doesNotMatch(text, /DataverseNumeric/);
});

test("malformed JSON still answers the OData payload error and the marker object is refused", async (t) => {
  const f = await readFixture(t, { mappings, tables: { x_item: [] } });
  const bad = await f.request("POST", "/x_items", '{"x_name":');
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error.message, /Error identified in Payload provided by the user/);
  const marker = await f.request("POST", "/x_items", '{"x_name":"x","x_dec":{"$type":"DataverseNumeric","numericType":"Decimal","value":"1"}}');
  assert.equal(marker.status, 400);
});
