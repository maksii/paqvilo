import { copyPlainGraph as copyPlain, cloneStateData } from './state-clone.mjs';
import { pagedRecordsOf, rawRecordOf } from './record-tables.mjs';
import { isOrganizationTable, uuidV5 } from './dataverse-security.mjs';
const copyPlainGraph = (value) =>
  pagedRecordsOf(value)?.fork() ?? (rawRecordOf(value) ? cloneStateData(value) : copyPlain(value));

const own = (object, key) => Object.hasOwn(object ?? {}, key);
const key = (value) =>
  String(value?.id ?? value ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();

function preserveOwnedOrganizationSections(previous, preset, next) {
  for (const [name, mapping] of Object.entries(previous.mappings ?? {})) {
    const ownsRows =
      isOrganizationTable(name) ||
      mapping.dataverseOnly === true ||
      mapping.standardTable === true ||
      mapping.modelDrivenSource === true;
    const ownsSchema =
      ownsRows || mapping.metadataSources?.length || mapping.dataverseMetadata?.createdByMetadataApi === true;
    if (ownsSchema && !own(preset.mappings, name)) next.mappings[name] = copyPlainGraph(mapping);
    if (ownsRows && !own(preset.tables, name) && own(previous.tables, name))
      next.tables[name] = copyPlainGraph(previous.tables[name]);
  }
}

function mergeSeededOrganizationTable(previous, next, name, ids) {
  const idColumn = (next.mappings[name] ?? previous.mappings?.[name])?.idColumn ?? `${name}id`;
  const seeded = new Set(ids.map(key)),
    byId = new Map((next.tables[name] ?? []).map((row) => [key(row[idColumn]), row]));
  const merged = (previous.tables?.[name] ?? []).flatMap((row) => {
    const id = key(row[idColumn]);
    if (byId.has(id)) {
      const replaced = byId.get(id);
      byId.delete(id);
      return [replaced];
    }
    return seeded.has(id) ? [copyPlainGraph(row)] : [];
  });
  next.tables[name] = [...merged, ...byId.values()];
}

function preserveSeededOrganizationRows(previous, preset, next) {
  const seededByTable = {};
  for (const [entry, ids] of Object.entries(previous.dataverse?.sourceSeeded ?? {}))
    if (Array.isArray(ids)) {
      const table = entry.replace(/^plugin:/, '');
      seededByTable[table] ??= [];
      seededByTable[table].push(...ids);
    }
  for (const [name, ids] of Object.entries(seededByTable))
    if (own(preset.tables, name) && ids.length) mergeSeededOrganizationTable(previous, next, name, ids);
}

function retainOrganizationRow(next, table, idColumn, row) {
  const rows = (next.tables[table] ??= []);
  if (!rows.some((existing) => key(existing[idColumn]) === key(row[idColumn]))) rows.push(copyPlainGraph(row));
}

function preserveSystemOrganizationRows(previous, next) {
  for (const organization of previous.tables?.organization ?? []) {
    const org = key(organization.organizationid);
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(org)) continue;
    const systemId = uuidV5(org, 'systemuser:SYSTEM');
    const system = previous.tables?.systemuser?.find((row) => key(row.systemuserid) === systemId);
    if (!system) continue;
    retainOrganizationRow(next, 'systemuser', 'systemuserid', system);
    const adminRoleId = uuidV5(org, 'role:System Administrator');
    const role = previous.tables?.role?.find((row) => key(row.roleid) === adminRoleId);
    if (!role) continue;
    retainOrganizationRow(next, 'role', 'roleid', role);
    for (const link of previous.tables?.systemuserroles ?? [])
      if (key(link.systemuserid) === systemId && key(link.roleid) === adminRoleId)
        retainOrganizationRow(next, 'systemuserroles', 'systemuserroleid', link);
  }
}

/** Data presets own only their explicit organization sections. The core table
 * catalogue and bootstrap flags identify platform/source rows; no project names are inferred here.
 * Explicit preset entries retain their existing replacement semantics. */
export function preserveOrganizationPresetSections(previous, preset, next) {
  next.mappings ??= {};
  next.tables ??= {};
  preserveOwnedOrganizationSections(previous, preset, next);
  // Rows the Solution sources seeded (previous.dataverse.sourceSeeded) stay when a preset replaces their table, as the next
  // source refresh re-seeds them: the preset's rows win by id and keep their place; the Solution's other rows keep theirs.
  // The plug-in seeder records its ids under `plugin:<table>` (dataverse-plugin-registration.mjs); both keys name the table.
  preserveSeededOrganizationRows(previous, preset, next);
  // SYSTEM is the runtime's internal record-pipeline principal, not a persona.
  // A preset may replace staff rows and revoke their grants, but cannot remove the
  // already-seeded internal identity needed by standard portal writes and hooks.
  preserveSystemOrganizationRows(previous, next);
  return next;
}
