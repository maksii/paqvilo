import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  importSolutionData,
  applySolutionData,
} from "../lib/solution-data.mjs";
import { DataStore } from "../lib/data.mjs";
test("Source-declared state/status defaults make a newly created record visible in authored active-record queries", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pp-state-default-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, "Entity.xml");
  await fs.writeFile(
    source,
    '<Entity><Name>package</Name><EntityInfo><entity Name="package"><EntitySetName>packages</EntitySetName><attributes><attribute><LogicalName>packageid</LogicalName><Type>primarykey</Type></attribute><attribute><LogicalName>statecode</LogicalName><Type>state</Type><optionset><states><state value="0" defaultstatus="10" invariantname="Active"/><state value="1" defaultstatus="20" invariantname="Inactive"/></states></optionset></attribute></attributes></entity></EntityInfo></Entity>',
  );
  const metadata = await importSolutionData([source]);
  assert.deepEqual(metadata.mappings.package.recordDefaults, {
    statecode: 0,
    statuscode: 10,
  });
  const state = applySolutionData(
      {
        mappings: {},
        tables: {},
        permissions: [
          {
            entity: "package",
            roles: ["Member"],
            operations: ["read", "create", "update"],
            scope: "global",
          },
        ],
        plugins: [],
        settings: { permissionMode: "enforce" },
      },
      metadata,
    ),
    store = await new DataStore({ state }).init(),
    identity = { roles: ["Member"] };
  const created = await store.create(
    "package",
    { name: "Native visible size" },
    identity,
  );
  assert.equal(created.statecode, 0);
  assert.equal(created.statuscode, 10);
  assert.equal(
    store.fetchXml(
      '<fetch><entity name="package"><filter><condition attribute="statecode" operator="eq" value="0"/></filter></entity></fetch>',
      identity,
    ).entities.length,
    1,
  );
  const inactive = await store.create("package", { statecode: 1 }, identity);
  assert.equal(inactive.statuscode, 20);
  const explicit = await store.create(
    "package",
    { statecode: 1, statuscode: 123 },
    identity,
  );
  assert.equal(explicit.statecode, 1);
  assert.equal(explicit.statuscode, 123);
  const deactivated = await store.update(
    "package",
    created.packageid,
    { statecode: 1 },
    identity,
  );
  assert.equal(deactivated.statuscode, 20);
  const selected = await store.update(
    "package",
    created.packageid,
    { statecode: 0, statuscode: 123 },
    identity,
  );
  assert.equal(selected.statuscode, 123);
  const unknown = new DataStore({
    state: {
      mappings: { custom: { idColumn: "customid" } },
      tables: { custom: [] },
      settings: { permissionMode: "permissive" },
    },
  });
  assert.equal(
    Object.hasOwn(await unknown.create("custom", {}), "statecode"),
    false,
  );
});
test("Authored recently-added queries include only the previous specified hours, including offset dates", async (t) => {
  const now = Date.parse("2026-10-07T15:00:00Z");
  t.mock.method(Date, "now", () => now);
  const store = await new DataStore({
    state: {
      mappings: { package: { idColumn: "packageid" } },
      tables: {
        package: [
          { packageid: "recent", createdon: "2026-10-07T14:30:00Z" },
          { packageid: "boundary", createdon: "2026-10-07T16:00:00+02:00" },
          { packageid: "old", createdon: "2026-10-07T13:59:59Z" },
          { packageid: "future", createdon: "2026-10-07T15:00:01Z" },
          { packageid: "invalid", createdon: "not-a-date" },
          { packageid: "null", createdon: null },
        ],
      },
      settings: { permissionMode: "permissive" },
    },
  }).init();
  const xml = (value) =>
    `<fetch><entity name="package"><attribute name="packageid"/><filter><condition attribute="createdon" operator="last-x-hours" value="${value}"/></filter></entity></fetch>`;
  // The filter decides membership; unordered FetchXML results have no defined order.
  assert.deepEqual(
    store.fetchXml(xml("1")).entities.map((row) => row.packageid).sort(),
    ["boundary", "recent"],
  );
  for (const value of ["0", "-1", "bad", "1.5", "99999999999999999999"])
    assert.throws(() => store.fetchXml(xml(value)), /positive integer/);
});
