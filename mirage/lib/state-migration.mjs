import { cloneStateData } from './state-clone.mjs';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { compactBuiltinPresets } from './data.mjs';

/** Keep separately captured assets; the current baseline wins only the same origin/path. */
export function mergeAssetManifests(current, baseline) {
  const entries = new Map();
  for (const manifest of [current, baseline]) {
    if (manifest == null) continue;
    if (manifest.version !== 1 || !Array.isArray(manifest.assets)) throw new Error('Invalid migration asset manifest.');
    for (const entry of manifest.assets) {
      if (typeof entry.origin !== 'string' || typeof entry.path !== 'string')
        throw new Error('Migration asset entry requires origin and path.');
      entries.set(entry.origin + '\0' + entry.path, cloneStateData(entry));
    }
  }
  return { version: 1, assets: [...entries.values()] };
}

function updateMigratedRow(row, fresh, prior, counters, preservedFields) {
  let changed = false;
  for (const [field, value] of Object.entries(fresh)) {
    if (isDeepStrictEqual(row[field], value)) continue;
    if (
      (prior && isDeepStrictEqual(row[field], prior[field])) ||
      (!Object.hasOwn(row, field) && !Object.hasOwn(prior ?? {}, field))
    ) {
      row[field] = cloneStateData(value);
      changed = true;
    } else {
      counters.preservedEdits++;
      preservedFields[field] = (preservedFields[field] ?? 0) + 1;
    }
  }
  if (changed) counters.updated++;
}

function mergeEntityRows(entity, newRows, currentRows, key, oldRows, counters, preservedFields) {
  const rows = new Map(currentRows.map((row) => [String(row[key] ?? '').toLowerCase(), row]));
  const identifier = (row) => String(row[key] ?? '').toLowerCase();
  for (const fresh of newRows) {
    const id = identifier(fresh);
    if (!id) throw new Error('Migration row lacks primary key: ' + entity);
    const prior = oldRows.get(id),
      row = rows.get(id);
    if (!row) {
      if (prior) {
        counters.preservedDeletions++;
        continue;
      }
      currentRows.push(cloneStateData(fresh));
      rows.set(id, currentRows.at(-1));
      counters.inserted++;
      continue;
    }
    updateMigratedRow(row, fresh, prior, counters, preservedFields);
  }
  return currentRows;
}

function migrateEntity(current, result, latest, legacy, entity, newRows, report) {
  const mapping = current.mappings?.[entity] ?? latest.mappings?.[entity] ?? {};
  const key = mapping.idColumn ?? entity + 'id';
  const identifier = (row) => String(row[key] ?? '').toLowerCase();
  const oldRows = new Map((legacy?.tables?.[entity] ?? []).map((row) => [identifier(row), row]));
  const currentRows = (result.tables[entity] ??= []);
  const preservedFields = {};
  const counters = { inserted: 0, updated: 0, preservedEdits: 0, preservedDeletions: 0 };
  mergeEntityRows(entity, newRows, currentRows, key, oldRows, counters, preservedFields);
  result.tables[entity] = currentRows;
  report.tables.push({
    entity,
    before: current.tables?.[entity]?.length ?? 0,
    after: currentRows.length,
    ...counters,
    preservedFields,
  });
}

function mergeMappings(result, latest) {
  for (const [entity, mapping] of Object.entries(latest.mappings ?? {})) {
    result.mappings[entity] ??= cloneStateData(mapping);
    // An edited mapping may retain its original inference provenance.
    if (
      result.mappings[entity].inferred === true &&
      result.mappings[entity].userConfigured !== true &&
      result.mappings[entity].entitySetInferred !== false &&
      result.mappings[entity].entitySet === entity + 's' &&
      mapping.entitySet !== entity + 's'
    )
      result.mappings[entity].entitySet = mapping.entitySet;
    // New source-declared relationships enable related query traversal; existing
    // author-configured relationship definitions remain authoritative.
    if (mapping.relationships) {
      result.mappings[entity].relationships ??= {};
      for (const [name, relationship] of Object.entries(mapping.relationships))
        result.mappings[entity].relationships[name] ??= cloneStateData(relationship);
    }
  }
}

function mergePlugins(current, result, latest, legacy, report) {
  const oldPlugins = new Map((legacy?.plugins ?? []).map((plugin) => [plugin.id, plugin]));
  const plugins = new Map((result.plugins ?? []).map((plugin) => [plugin.id, plugin]));
  for (const fresh of latest.plugins ?? []) {
    const saved = plugins.get(fresh.id);
    if (!saved || isDeepStrictEqual(saved, oldPlugins.get(fresh.id))) plugins.set(fresh.id, cloneStateData(fresh));
    else report.preservedCustomPlugins.push(fresh.id);
  }
  result.plugins = [...plugins.values()];
  const fingerprint = (plugin) =>
    plugin == null ? null : createHash('sha256').update(JSON.stringify(plugin)).digest('hex');
  report.plugins = (latest.plugins ?? []).map((fresh) => ({
    id: fresh.id,
    beforeSha256: fingerprint((current.plugins ?? []).find((plugin) => plugin.id === fresh.id)),
    afterSha256: fingerprint(plugins.get(fresh.id)),
    canonicalSha256: fingerprint(fresh),
    currentCanonical: isDeepStrictEqual(plugins.get(fresh.id), fresh),
  }));
}

function mergePermissions(current, result, latest, legacy, report) {
  if (current.simulator?.permissionSource === 'exported') return;
  const previousRules = new Map((legacy?.permissions ?? []).map((rule) => [rule.id, rule]));
  const rules = new Map((result.permissions ?? []).map((rule) => [rule.id, rule]));
  for (const fresh of latest.permissions ?? []) {
    const saved = rules.get(fresh.id);
    if (!saved || isDeepStrictEqual(saved, previousRules.get(fresh.id))) rules.set(fresh.id, cloneStateData(fresh));
    else report.preservedCustomPermissions.push(fresh.id);
  }
  result.permissions = [...rules.values()];
}

function validManagedControls(managedControls) {
  return (
    typeof managedControls === 'object' &&
    !Array.isArray(managedControls) &&
    !Object.entries(managedControls).some(
      ([name, definition]) =>
        !/^[A-Za-z][\w.]*$/.test(name) ||
        !definition ||
        typeof definition !== 'object' ||
        Array.isArray(definition) ||
        !definition.manifest ||
        typeof definition.manifest !== 'object' ||
        ['stylesheets', 'scripts'].some((key) => definition[key] != null && !Array.isArray(definition[key])),
    )
  );
}

function applyShellProfile(result, shellProfile) {
  if (!shellProfile) return;
  result.simulator ??= {};
  const configuredControls = result.simulator.shellProfile?.managedControls;
  result.simulator.shellProfile = {
    ...result.simulator.shellProfile,
    ...cloneStateData(shellProfile),
  };
  if (configuredControls != null) result.simulator.shellProfile.managedControls = configuredControls;
}

function applyManagedControls(result, managedControls) {
  if (managedControls == null) return;
  if (!validManagedControls(managedControls)) throw new Error('Invalid managed control migration baseline.');
  result.simulator ??= {};
  if (result.simulator.managedControls == null && result.simulator.shellProfile?.managedControls == null)
    result.simulator.managedControls = cloneStateData(managedControls);
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
  const result = cloneStateData({
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
  for (const [entity, newRows] of Object.entries(latest.tables ?? {}))
    migrateEntity(current, result, latest, legacy, entity, newRows, report);
  mergeMappings(result, latest);
  mergePlugins(current, result, latest, legacy, report);
  mergePermissions(current, result, latest, legacy, report);
  applyShellProfile(result, shellProfile);
  applyManagedControls(result, managedControls);
  return { state: result, report };
}
