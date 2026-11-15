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

const hasRuleId = (rule) => rule.id != null;

/** Rules match by id when they have one, otherwise by equal content. */
function isSameRule(rule, fresh) {
  return hasRuleId(fresh) ? rule.id === fresh.id : isDeepStrictEqual(rule, fresh);
}

/**
 * Rules with an id merge by id, keeping the saved position. Saved rules without an id stay where they are,
 * and a fresh rule without an id is appended only when no equal rule is present, so repeats add nothing.
 */
function mergeRules(savedRules, latestRules, previousRules, preserved) {
  const previousById = new Map(previousRules.filter(hasRuleId).map((rule) => [rule.id, rule]));
  const rulesById = new Map(savedRules.filter(hasRuleId).map((rule) => [rule.id, rule]));
  for (const fresh of latestRules.filter(hasRuleId)) {
    const saved = rulesById.get(fresh.id);
    if (!saved || isDeepStrictEqual(saved, previousById.get(fresh.id))) rulesById.set(fresh.id, cloneStateData(fresh));
    else preserved.push(fresh.id);
  }
  const merged = [];
  for (const rule of savedRules) {
    if (!hasRuleId(rule)) merged.push(rule);
    else if (rulesById.has(rule.id)) {
      merged.push(rulesById.get(rule.id));
      rulesById.delete(rule.id);
    }
  }
  merged.push(...rulesById.values());
  for (const fresh of latestRules.filter((rule) => !hasRuleId(rule)))
    if (!merged.some((rule) => isDeepStrictEqual(rule, fresh))) merged.push(cloneStateData(fresh));
  return merged;
}

function mergePlugins(current, result, latest, legacy, report) {
  result.plugins = mergeRules(
    result.plugins ?? [],
    latest.plugins ?? [],
    legacy?.plugins ?? [],
    report.preservedCustomPlugins,
  );
  const fingerprint = (plugin) =>
    plugin == null ? null : createHash('sha256').update(JSON.stringify(plugin)).digest('hex');
  const findRule = (rules, fresh) => (rules ?? []).find((rule) => isSameRule(rule, fresh));
  report.plugins = (latest.plugins ?? []).map((fresh) => ({
    id: fresh.id,
    beforeSha256: fingerprint(findRule(current.plugins, fresh)),
    afterSha256: fingerprint(findRule(result.plugins, fresh)),
    canonicalSha256: fingerprint(fresh),
    currentCanonical: isDeepStrictEqual(findRule(result.plugins, fresh), fresh),
  }));
}

function mergePermissions(current, result, latest, legacy, report) {
  if (current.simulator?.permissionSource === 'exported') return;
  result.permissions = mergeRules(
    result.permissions ?? [],
    latest.permissions ?? [],
    legacy?.permissions ?? [],
    report.preservedCustomPermissions,
  );
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

const UPGRADE_SUFFIX = '_upgrade';
const lowerText = (value) => String(value ?? '').toLowerCase();

/**
 * A holding solution of a staged upgrade is named <base>_Upgrade, and the dataverse state records it against its base's id
 * (state.dataverse.holdingSolutions). The name is read once, for a state without state.dataverse.holdingMarkersMigrated: it
 * records each such solution whose base is present, and a solution with no base is left alone. The flag is then set, so a
 * later solution with the holding name is never taken for a holding solution.
 */
export function markStagedUpgrades(state) {
  if (state.dataverse?.holdingMarkersMigrated) return state;
  const solutions = state.tables?.solution ?? [];
  for (const holding of solutions) {
    const name = lowerText(holding.uniquename);
    if (!name.endsWith(UPGRADE_SUFFIX) || Object.hasOwn(state.dataverse?.holdingSolutions ?? {}, holding.solutionid))
      continue;
    const baseName = name.slice(0, -UPGRADE_SUFFIX.length);
    const base = solutions.find((s) => s.parentsolutionid == null && lowerText(s.uniquename) === baseName);
    if (!base) continue;
    state.dataverse ??= {};
    state.dataverse.holdingSolutions ??= {};
    state.dataverse.holdingSolutions[holding.solutionid] = base.solutionid;
  }
  state.dataverse ??= {};
  state.dataverse.holdingMarkersMigrated = true;
  return state;
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
