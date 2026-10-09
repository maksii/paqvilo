import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DataError, DataStore } from "../lib/data.mjs";

const state = () => ({
  mappings: { item: { idColumn: "itemid", entitySet: "items" } },
  tables: { item: [{ itemid: "seed", name: "seed" }] },
  settings: { permissionMode: "permissive" },
});
const conflict = (error) =>
  error instanceof DataError && error.status === 409 && error.code === "StateConflict";

test("two DataStores on one file preserve the first write and roll back a stale writer", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "pp-state-cas-"));
  const file = join(root, "state.json");
  try {
    await fs.writeFile(file, JSON.stringify(state()));
    const first = await new DataStore({ file }).init();
    const stale = await new DataStore({ file }).init();
    await first.create("item", { itemid: "first", name: "first" });
    const staleBefore = stale.snapshot();
    await assert.rejects(
      stale.create("item", { itemid: "second", name: "second" }),
      conflict,
    );
    assert.deepEqual(stale.snapshot(), staleBefore);
    const persisted = JSON.parse(await fs.readFile(file, "utf8"));
    assert.deepEqual(
      persisted.tables.item.map((row) => row.itemid),
      ["seed", "first"],
    );
    assert.deepEqual(await fs.readdir(root), ["state.json"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a held sibling lock blocks writes and a later retry succeeds cleanly", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "pp-state-lock-"));
  const file = join(root, "state.json"), lock = `${file}.lock`;
  try {
    await fs.writeFile(file, JSON.stringify(state()));
    const store = await new DataStore({ file }).init();
    await fs.writeFile(lock, "other-process:lock-token\n", { flag: "wx" });
    const before = store.snapshot();
    await assert.rejects(
      store.create("item", { itemid: "blocked" }),
      conflict,
    );
    assert.deepEqual(store.snapshot(), before);
    assert.deepEqual((await fs.readdir(root)).sort(), ["state.json", "state.json.lock"]);
    await fs.unlink(lock);
    await store.create("item", { itemid: "retry" });
    assert.deepEqual((await fs.readdir(root)).sort(), ["state.json"]);
    assert.equal(JSON.parse(await fs.readFile(file, "utf8")).tables.item.at(-1).itemid, "retry");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("external state edits are detected and never overwritten", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "pp-state-external-"));
  const file = join(root, "state.json");
  try {
    await fs.writeFile(file, JSON.stringify(state()));
    const store = await new DataStore({ file }).init();
    const before = store.snapshot();
    const external = state();
    external.tables.item.push({ itemid: "external", name: "external" });
    await fs.writeFile(file, JSON.stringify(external));
    await assert.rejects(
      store.create("item", { itemid: "local" }),
      conflict,
    );
    assert.deepEqual(store.snapshot(), before);
    assert.deepEqual(
      JSON.parse(await fs.readFile(file, "utf8")).tables.item.map((row) => row.itemid),
      ["seed", "external"],
    );
    assert.deepEqual(await fs.readdir(root), ["state.json"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
