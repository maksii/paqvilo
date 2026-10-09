import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DataStore } from "./data.mjs";
import { assertOfflineState } from "./offline-state.mjs";
import { mergeAssetManifests } from "./state-migration.mjs";

/** Apply a prepared fixture migration with runtime exclusion, exact-byte freshness and state CAS. */
export async function commitMigration({
  stateFile,
  originalBytes,
  currentState,
  nextState,
  baselineStateFile,
  beforeReplace,
}) {
  stateFile = path.resolve(stateFile);
  baselineStateFile = path.resolve(baselineStateFile);
  await assertOfflineState(stateFile);
  const initialBytes = await fs.readFile(stateFile);
  if (!initialBytes.equals(originalBytes))
    throw new Error("State changed during preparation; migration refused.");

  const store = await new DataStore({ file: stateFile, state: currentState }).init();
  const backup = `${stateFile}.before-migration-${Date.now()}-${randomUUID()}.json`;
  await fs.writeFile(backup, originalBytes, { flag: "wx" });
  const manifestFile = path.join(path.dirname(stateFile), "assets", "manifest.json");
  const baselineManifestFile = path.join(path.dirname(baselineStateFile), "assets", "manifest.json");
  let currentManifest = null,
    originalManifestBytes = null,
    assetManifestBackup;
  try {
    originalManifestBytes = await fs.readFile(manifestFile);
    currentManifest = JSON.parse(originalManifestBytes);
    assetManifestBackup = `${manifestFile}.before-migration-${Date.now()}-${randomUUID()}.json`;
    await fs.writeFile(assetManifestBackup, originalManifestBytes, { flag: "wx" });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const baselineManifest = JSON.parse(await fs.readFile(baselineManifestFile, "utf8"));
  const manifest = mergeAssetManifests(currentManifest, baselineManifest);
  const manifestTemporary = `${manifestFile}.${randomUUID()}.migration.tmp`;
  try {
    await fs.cp(
      path.join(path.dirname(baselineStateFile), "assets"),
      path.dirname(manifestFile),
      { recursive: true, force: true },
    );
    await fs.writeFile(manifestTemporary, JSON.stringify(manifest, null, 2), { flag: "wx" });
    await fs.rename(manifestTemporary, manifestFile);

    await assertOfflineState(stateFile);
    const latestBytes = await fs.readFile(stateFile);
    if (!latestBytes.equals(originalBytes))
      throw new Error("State changed during preparation; migration refused.");
    if (beforeReplace) await beforeReplace();
    await store.replaceState(nextState, {
      expectedSnapshot: JSON.stringify(store.snapshot()),
    });
    return {
      backup,
      assetManifestBackup,
      assetEntriesPreserved: manifest.assets.length - baselineManifest.assets.length,
    };
  } catch (cause) {
    await fs.rm(manifestTemporary, { force: true });
    try {
      if (originalManifestBytes) {
        const rollback = `${manifestFile}.${randomUUID()}.rollback.tmp`;
        await fs.writeFile(rollback, originalManifestBytes, { flag: "wx" });
        await fs.rename(rollback, manifestFile);
      } else await fs.rm(manifestFile, { force: true });
    } catch (rollbackError) {
      throw new Error(`${cause.message}; asset manifest rollback failed: ${rollbackError.message}`, { cause });
    }
    throw cause;
  }
}
