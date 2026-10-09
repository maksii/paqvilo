import test from "node:test";
import assert from "node:assert/strict";
import { DataStore } from "../lib/data.mjs";

test("projected snapshots are detached, current and omit unrelated data", async () => {
  const store = await new DataStore({
    state: {
      mappings: {
        contact: { idColumn: "contactid", entitySet: "contacts" },
        account: { idColumn: "accountid", entitySet: "accounts" },
      },
      tables: {
        contact: [{ contactid: "c1", fullname: "Before" }],
        account: [{ accountid: "a1", name: "Other" }],
      },
      simulator: {
        identity: { id: "c1", roles: ["Member"] },
        contactRoles: [{ contactId: "c1", roleId: "role" }],
      },
      presets: { large: { tables: { account: [{ accountid: "unused" }] } } },
      settings: { permissionMode: "permissive" },
    },
  }).init();
  const projection = {
    sections: ["simulator"],
    tables: ["contact"],
    mappings: ["contact"],
  };
  const first = store.snapshot(projection);
  assert.deepEqual(Object.keys(first).sort(), [
    "mappings",
    "simulator",
    "tables",
  ]);
  assert.deepEqual(Object.keys(first.tables), ["contact"]);
  assert.deepEqual(Object.keys(first.mappings), ["contact"]);
  first.tables.contact[0].fullname = "Injected";
  first.simulator.identity.roles.push("Administrator");
  assert.equal(store.snapshot(projection).tables.contact[0].fullname, "Before");
  assert.deepEqual(store.snapshot(projection).simulator.identity.roles, [
    "Member",
  ]);
  await store.update("contact", "c1", { fullname: "After" });
  assert.equal(store.snapshot(projection).tables.contact[0].fullname, "After");
  await assert.rejects(
    store.transact(() => {
      store.state.tables.contact[0].fullname = "Rolled back";
      throw new Error("rollback");
    }),
    /rollback/,
  );
  assert.equal(store.snapshot(projection).tables.contact[0].fullname, "After");
  assert.ok(store.snapshot().presets.large);
  assert.throws(() => store.snapshot({ unknown: [] }), /projection/);
  assert.throws(() => store.snapshot({ sections: ["__proto__"] }));
});
