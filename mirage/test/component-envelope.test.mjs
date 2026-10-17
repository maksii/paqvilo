import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { importPortal } from "../lib/importer.mjs";
import { buildSiteTables } from "../lib/site-tables.mjs";

test("enhanced lifecycle status and redirect content remain separate, including unknown components", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pp-component-envelope-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const escape = value => String(value).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const cases = [
    { id: "active", type: 2, state: 0, status: "<statuscode>1</statuscode>", content: { partialurl: "/", isroot: true }, expected: 1 },
    { id: "inactive", type: 9, state: 1, status: "<statuscode>2</statuscode>", content: { value: "inactive value" }, expected: 2 },
    { id: "redirect", type: 30, state: 0, status: "<statuscode>1</statuscode>", content: { inboundurl: "old", webpageid: "active", statuscode: 301 }, expected: 1 },
    { id: "unknown", type: 999, state: 0, status: "<statuscode>7</statuscode>", content: { nested: { enabled: false, nullable: null, values: [1, "1"] }, custom: "A&B" }, expected: 7 },
    { id: "legacy", type: 9, state: 1, status: "", content: { value: "legacy value" }, expected: 2 },
    { id: "null", type: 999, state: 0, status: "<statuscode />", content: {}, expected: null },
  ];
  for (const row of cases) {
    const folder = path.join(directory, "powerpagecomponents", row.id);
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, "powerpagecomponent.xml"), `<powerpagecomponent powerpagecomponentid="${row.id}"><content>${escape(JSON.stringify(row.content))}</content><name>${row.id}</name><powerpagecomponenttype>${row.type}</powerpagecomponenttype><statecode>${row.state}</statecode>${row.status}</powerpagecomponent>`);
  }
  const portal = await importPortal(directory);
  const rows = buildSiteTables(portal, { tables: {}, mappings: {} }).tables.powerpagecomponent.rows;
  for (const example of cases) {
    const record = portal.records.find(row => row.id === example.id);
    assert.equal(record.statecode, example.state);
    if (example.status) assert.deepEqual(record._componentEnvelope, { statuscode: example.expected });
    else assert.equal(Object.hasOwn(record, "_componentEnvelope"), false, "older exports retain absence");
    const row = rows.find(row => row.powerpagecomponentid === example.id);
    assert.equal(row.statuscode, example.expected);
    assert.deepEqual(JSON.parse(row.content), example.content, "outer status and internal envelope never enter source content");
  }
  assert.equal(portal.records.find(row => row.id === "redirect").statuscode, 301);
  assert.equal(portal.redirects.find(row => row.inboundUrl === "old").statusCode, 301);
});

test("enhanced YAML without a component envelope retains lifecycle fallback and source JSON", () => {
  const content = { adx_description: "Invented role", nullable: null };
  const portal = { format: "enhanced", records: [{ kind: "webrole", id: "role", name: "Owned", powerpagecomponenttype: 11, statecode: 1, ...content }] };
  const row = buildSiteTables(portal, { tables: {}, mappings: {} }).tables.powerpagecomponent.rows[0];
  assert.equal(row.statuscode, 2);
  assert.deepEqual(JSON.parse(row.content), content);
});
