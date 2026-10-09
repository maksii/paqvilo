import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { commitMigration } from "../lib/migration-commit.mjs";

test("state CAS conflict after asset copy restores the exact manifest and preserves concurrent state", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pp-migration-cas-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateFile = path.join(root, "current", "state.json");
  const baselineStateFile = path.join(root, "baseline", "state.json");
  const currentManifestFile = path.join(root, "current", "assets", "manifest.json");
  const baselineAssets = path.join(root, "baseline", "assets");
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  await fs.mkdir(path.dirname(currentManifestFile), { recursive: true });
  await fs.mkdir(path.dirname(baselineStateFile), { recursive: true });
  await fs.mkdir(path.join(baselineAssets, "sha256"), { recursive: true });
  const current = {
    version: 1, mappings: {}, tables: {}, permissions: [], plugins: [],
    presets: {}, settings: {}, simulator: {},
  };
  const originalBytes = Buffer.from(JSON.stringify(current, null, 2));
  await fs.writeFile(stateFile, originalBytes);
  await fs.writeFile(baselineStateFile, "{}");
  const originalManifestBytes = Buffer.from(JSON.stringify({
    version: 1,
    assets: [{ origin: "https://example.test", path: "/custom.js", sha256: "old" }],
  }, null, 2));
  await fs.writeFile(currentManifestFile, originalManifestBytes);
  await fs.writeFile(path.join(baselineAssets, "manifest.json"), JSON.stringify({
    version: 1,
    assets: [{ origin: "https://example.test", path: "/baseline.js", sha256: "base" }],
  }));
  await fs.writeFile(path.join(baselineAssets, "sha256", "base.js"), "baseline bytes");

  const concurrentState = { ...current, settings: { concurrentEdit: true } };
  await assert.rejects(commitMigration({
    stateFile,
    originalBytes,
    currentState: current,
    nextState: { ...current, settings: { migration: true } },
    baselineStateFile,
    beforeReplace: async () => fs.writeFile(stateFile, JSON.stringify(concurrentState)),
  }), (error) => error.status === 409 && error.code === "StateConflict");

  assert.deepEqual(JSON.parse(await fs.readFile(stateFile, "utf8")), concurrentState);
  assert.deepEqual(await fs.readFile(currentManifestFile), originalManifestBytes);
  assert.equal(await fs.readFile(path.join(root, "current", "assets", "sha256", "base.js"), "utf8"), "baseline bytes");
  const backups = (await fs.readdir(root + "/current")).filter((name) => name.startsWith("state.json.before-migration-"));
  assert.equal(backups.length, 1);
  assert.deepEqual(await fs.readFile(path.join(root, "current", backups[0])), originalBytes);
  assert.deepEqual((await fs.readdir(path.dirname(currentManifestFile))).filter((name) => /migration\.tmp|rollback\.tmp/.test(name)), []);
});
