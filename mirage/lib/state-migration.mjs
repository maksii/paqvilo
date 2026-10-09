import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { compactBuiltinPresets } from "./data.mjs";

/** Keep separately captured assets; the current baseline wins only the same origin/path. */
export function mergeAssetManifests(current, baseline) {
  const entries = new Map();
  for (const manifest of [current, baseline]) {
    if (manifest == null) continue;
    if (manifest.version !== 1 || !Array.isArray(manifest.assets))
      throw Error("Invalid migration asset manifest.");
    for (const entry of manifest.assets) {
      if (typeof entry.origin !== "string" || typeof entry.path !== "string")
        throw Error("Migration asset entry requires origin and path.");
      entries.set(entry.origin + "\0" + entry.path, structuredClone(entry));
    }
  }
  return { version: 1, assets: [...entries.values()] };
}

/** Three-way fixture refresh: authored local edits/deletions win over generated defaults. */
export function migrateScenarioState(
  current,
  {
    latest,
    // The stored copy of the preset being refreshed (latest.id) unless supplied.
    legacy = latest?.id ? current.presets?.[latest.id] : undefined,
    shellProfile,
    managedControls,
    presetLibrary,
  } = {},
) {
  const result = structuredClone({
      ...current,
      presets: compactBuiltinPresets(current.presets ?? {}, presetLibrary),
    }),
    report = {
      tables: [],
      preservedCustomPlugins: [],
      preservedCustomPermissions: [],
      settingsPreserved: true,
    };
  result.tables ??= {};
  result.mappings ??= {};
  for (const [entity, newRows] of Object.entries(latest.tables ?? {})) {
    const mapping =
        current.mappings?.[entity] ?? latest.mappings?.[entity] ?? {},
      key = mapping.idColumn ?? entity + "id";
    const identifier = (row) => String(row[key] ?? "").toLowerCase();
    const oldRows = new Map(
      (legacy?.tables?.[entity] ?? []).map((row) => [identifier(row), row]),
    );
    const currentRows = (result.tables[entity] ??= []),
      rows = new Map(currentRows.map((row) => [identifier(row), row]));
    const preservedFields = {};
    let inserted = 0,
      updated = 0,
      preservedEdits = 0,
      preservedDeletions = 0;
    for (const fresh of newRows) {
      const id = identifier(fresh);
      if (!id) throw Error("Migration row lacks primary key: " + entity);
      const prior = oldRows.get(id),
        row = rows.get(id);
      if (!row) {
        if (prior) {
          preservedDeletions++;
          continue;
        }
        currentRows.push(structuredClone(fresh));
        rows.set(id, currentRows.at(-1));
        inserted++;
        continue;
      }
      let changed = false;
      for (const [field, value] of Object.entries(fresh)) {
        if (isDeepStrictEqual(row[field], value)) continue;
        if (
          (prior && isDeepStrictEqual(row[field], prior[field])) ||
          (!Object.hasOwn(row, field) && !Object.hasOwn(prior ?? {}, field))
        ) {
          row[field] = structuredClone(value);
          changed = true;
        } else {
          preservedEdits++;
          preservedFields[field] = (preservedFields[field] ?? 0) + 1;
        }
      }
      if (changed) updated++;
    }
    result.tables[entity] = currentRows;
    report.tables.push({
      entity,
      before: current.tables?.[entity]?.length ?? 0,
      after: currentRows.length,
      inserted,
      updated,
      preservedEdits,
      preservedDeletions,
      preservedFields,
    });
  }
  for (const [entity, mapping] of Object.entries(latest.mappings ?? {})) {
    result.mappings[entity] ??= structuredClone(mapping);
    if (
      result.mappings[entity].inferred === true &&
      result.mappings[entity].entitySet === entity + "s" &&
      mapping.entitySet !== entity + "s"
    ) result.mappings[entity].entitySet = mapping.entitySet;
    // New source-declared relationships enable related query traversal; existing
    // author-configured relationship definitions remain authoritative.
    if (mapping.relationships) {
      result.mappings[entity].relationships ??= {};
      for (const [name, relationship] of Object.entries(mapping.relationships))
        result.mappings[entity].relationships[name] ??=
          structuredClone(relationship);
    }
  }
  const oldPlugins = new Map(
      (legacy?.plugins ?? []).map((plugin) => [plugin.id, plugin]),
    ),
    plugins = new Map(
      (result.plugins ?? []).map((plugin) => [plugin.id, plugin]),
    );
  for (const fresh of latest.plugins ?? []) {
    const saved = plugins.get(fresh.id);
    if (!saved || isDeepStrictEqual(saved, oldPlugins.get(fresh.id)))
      plugins.set(fresh.id, structuredClone(fresh));
    else report.preservedCustomPlugins.push(fresh.id);
  }
  result.plugins = [...plugins.values()];
  const fingerprint = (plugin) =>
    plugin == null
      ? null
      : createHash("sha256").update(JSON.stringify(plugin)).digest("hex");
  report.plugins = (latest.plugins ?? []).map((fresh) => ({
    id: fresh.id,
    beforeSha256: fingerprint(
      (current.plugins ?? []).find((plugin) => plugin.id === fresh.id),
    ),
    afterSha256: fingerprint(plugins.get(fresh.id)),
    canonicalSha256: fingerprint(fresh),
    currentCanonical: isDeepStrictEqual(plugins.get(fresh.id), fresh),
  }));
  // Native exported trees are compiled from the portal and must never acquire
  // configured scenario grants during a fixture refresh.
  if (current.simulator?.permissionSource !== "exported") {
    const previousRules = new Map(
      (legacy?.permissions ?? []).map((rule) => [rule.id, rule]),
    );
    const rules = new Map(
      (result.permissions ?? []).map((rule) => [rule.id, rule]),
    );
    for (const fresh of latest.permissions ?? []) {
      const saved = rules.get(fresh.id);
      if (!saved || isDeepStrictEqual(saved, previousRules.get(fresh.id)))
        rules.set(fresh.id, structuredClone(fresh));
      else report.preservedCustomPermissions.push(fresh.id);
    }
    result.permissions = [...rules.values()];
  }
  if (shellProfile) {
    result.simulator ??= {};
    const configuredControls = result.simulator.shellProfile?.managedControls;
    result.simulator.shellProfile = {
      ...result.simulator.shellProfile,
      ...structuredClone(shellProfile),
    };
    if (configuredControls != null)
      result.simulator.shellProfile.managedControls = configuredControls;
  }
  if (managedControls != null) {
    if (
      typeof managedControls !== "object" ||
      Array.isArray(managedControls) ||
      Object.entries(managedControls).some(
        ([name, definition]) =>
          !/^[A-Za-z][\w.]*$/.test(name) ||
          !definition ||
          typeof definition !== "object" ||
          Array.isArray(definition) ||
          !definition.manifest ||
          typeof definition.manifest !== "object" ||
          ["stylesheets", "scripts"].some(
            (key) => definition[key] != null && !Array.isArray(definition[key]),
          ),
      )
    )
      throw Error("Invalid managed control migration baseline.");
    result.simulator ??= {};
    if (
      result.simulator.managedControls == null &&
      result.simulator.shellProfile?.managedControls == null
    )
      result.simulator.managedControls = structuredClone(managedControls);
  }
  return { state: result, report };
}
