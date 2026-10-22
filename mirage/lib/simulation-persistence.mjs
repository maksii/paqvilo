import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DataError } from './data-error.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { isElastic } from './dataverse-elastic.mjs';
import { guidKey } from './dataverse-values.mjs';
import { packDirectory } from './preset-registry.mjs';
import { validatePackDataFiles } from './pack-data-files.mjs';
import { simulationSettings, simulationReport } from './simulation-settings.mjs';
import { jsonChunks } from './state-stream.mjs';
import { readStateFile } from './state-storage.mjs';
import { INTERNAL_TABLES } from './dataverse-organization.mjs';
import { WEBAPI_UNSUPPORTED_TABLES, POWER_PAGES_TABLES } from './webapi-policy.mjs';
import { publishTransactionalFiles, recoverTransactionalFiles } from './transactional-files.mjs';

// Platform infrastructure belongs to the private runtime, independently of the
// business dataset. These are platform contracts, never project table prefixes.
const runtimeTables = new Set([
  'organization', 'businessunit', 'systemuser', 'role', 'privilege', 'team',
  'systemuserroles', 'teamroles', 'teammembership', 'roleprivileges',
  'principalobjectaccess', 'principalobjectattributeaccess', 'systemuserbusinessunitentitymap',
  'fieldsecurityprofile', 'fieldpermission', 'systemuserprofiles', 'teamprofiles',
  'transactioncurrency', 'usersettings', 'audit', 'plugintracelog',
  'asyncoperation', 'backgroundoperation', 'bulkdeleteoperation', 'bulkdeletefailure',
  // Process run history (a classic workflow run's log and a real-time failure's session), as asyncoperation.
  'workflowlog', 'processsession',
  // Process definitions and their activation rows: Solution-seeded control plane (activation, deactivation), never pack DATA.
  'workflow',
  // Plug-in registrations, service endpoints, Dataverse Functions and masking rules: Solution-seeded control plane at every
  // level, never pack DATA (a preset that carries them replaces the runtime rows; organization-presets keeps the seeded ones).
  'sdkmessageprocessingstep', 'sdkmessageprocessingstepimage', 'plugintype', 'pluginassembly', 'serviceendpoint',
  'fxexpression', 'maskingrule', 'attributemaskingrule',
  // Deployment-profile state: a profile switch rewrites environment variable values and connection references.
  'environmentvariabledefinition', 'environmentvariablevalue', 'connectionreference',
  'importjob', 'import', 'importfile', 'importlog', 'importmap',
  'solution', 'solutioncomponent', 'publisher', 'dependency', 'dependencynode',
  'solutionhistory', 'solutionhistorydata', 'solutioncomponentconfiguration',
  ...INTERNAL_TABLES,
  // Power Pages configuration (Learn's configuration tables, both data models): the export seeds it and a deployment
  // profile switch rewrites it (enhanced authorization, site settings); site state, never business DATA.
  ...WEBAPI_UNSUPPORTED_TABLES, ...POWER_PAGES_TABLES.values(),
]);
const metadataKeys = Object.freeze([
  'globalOptionSets', 'customColumns', 'metadataLog', 'solutionComponents',
  'managedLayers', 'componentOrigin', 'solutionPayloads', 'solutionComponentSettings',
]);
// These platform rows define public operation signatures rather than business
// records. Keep their policy and durable source with normalized schema.
const schemaTables = Object.freeze(['customapi', 'customapirequestparameter', 'customapiresponseproperty']);
const fail = (message, code = 'InvalidPackData', status = 400) => Object.assign(new DataError(message, status, code), { persistenceFailure: true });
const hash = value => {
  const output = createHash('sha256');
  for (const chunk of jsonChunks(value)) output.update(chunk);
  return output.digest('hex');
};
const bytesHash = value => createHash('sha256').update(value).digest('hex');
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const at = (root, keys) => keys.reduce((value, key) => value && Object.hasOwn(value, key) ? value[key] : undefined, root);
function put(root, keys, value) {
  if (!keys.length) return value;
  const parent = at(root, keys.slice(0, -1));
  if (!plain(parent)) throw fail('The declared JSON data location no longer exists.');
  Object.defineProperty(parent, keys.at(-1), { value, enumerable: true, writable: true, configurable: true });
  return root;
}
const schemaOf = state => ({ mappings: state.mappings ?? {}, ...Object.fromEntries(metadataKeys.map(key => [key, state.dataverse?.[key] ?? null])),
  schemaRecords: Object.fromEntries(schemaTables.map(table => [table, state.tables?.[table] ?? []])),
});
const rowHashes = state => new Map(Object.entries(state.tables ?? {}).map(([table, rows]) => [table, hash(rows)]));
// The table hashes after a transaction that names its written tables (DataStore passes the row
// transaction's touched tables): unchanged tables keep their baseline hash instead of being rehashed.
const dirtyRowHashes = (state, baseline, dirty) => {
  const tables = state.tables ?? {}, rows = new Map(baseline);
  for (const table of baseline.keys()) if (!Object.hasOwn(tables, table)) rows.delete(table);
  for (const table of Object.keys(tables)) if (!baseline.has(table) || dirty.has(table)) rows.set(table, hash(tables[table]));
  return rows;
};
const rowIdentity = (row, mapping, idColumn = mapping?.idColumn) => JSON.stringify([
  guidKey(row[idColumn]) ?? String(row[idColumn]).toLowerCase(), ...(isElastic(mapping) ? [row.partitionid ?? null] : []),
]);
const inside = (root, file) => { const relative = path.relative(root, file); return relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative); };

/** Explicit storage adapter used by DataStore before any surface is composed.
 * Its schema policy becomes active once source and platform bootstrap finishes.
 * Direct pack writes and the ignored runtime checkpoint share one transaction. */
export async function createSimulationPersistence({ settings, packs = [], stateFile, io = fs } = {}) {
  settings = simulationSettings(settings);
  if (!settings) return null;
  const memory = settings.level === 'dry-run';
  if (!memory && !stateFile) throw fail('Simulation and deep simulation require a private stateFile for transaction recovery.');
  const descriptors = [], owners = new Map();
  let newTablesOwner, schemaOwner;
  for (const pack of packs) {
    const declared = validatePackDataFiles(pack.dataFiles, `Data pack ${pack.id}.dataFiles`);
    if (!declared.length) continue;
    const directory = packDirectory(pack);
    if (!directory) throw fail(`Data pack ${pack.id} has no explicit module directory for its data files.`);
    const root = await io.realpath(directory);
    for (const definition of declared) {
      const candidate = path.resolve(root, definition.file);
      if (!inside(root, candidate)) throw fail(`Data pack ${pack.id} declares a file outside its directory.`);
      const file = await io.realpath(candidate);
      if (!inside(root, file) || !(await io.stat(file)).isFile()) throw fail(`Data pack ${pack.id} must own a regular JSON data file inside its directory.`);
      if (descriptors.some(entry => entry.file === file)) throw fail('Each pack data file must have exactly one descriptor.');
      const entry = { ...definition, packId: pack.id, root, candidate, file };
      descriptors.push(entry);
      for (const [table, owner] of Object.entries(entry.tables)) {
        if (owners.has(table)) throw fail(`Table ${table} has more than one pack data owner.`);
        owners.set(table, { ...owner, entry });
      }
      if (entry.newTablesPath) {
        if (newTablesOwner) throw fail('Only one pack data file may own new tables.');
        newTablesOwner = entry;
      }
      if (entry.schemaPath) {
        if (schemaOwner) throw fail('Only one pack data file may own normalized schema.');
        schemaOwner = entry;
      }
    }
  }
  const runtimeFile = stateFile ? path.resolve(stateFile) : null;
  if (runtimeFile && descriptors.some(entry => entry.file === runtimeFile)) throw fail('Pack data and private runtime state must be different files.');
  const journalFile = runtimeFile && `${runtimeFile}.pack-transaction.json`;
  const allFiles = [...descriptors.map(entry => entry.file), ...(runtimeFile ? [runtimeFile] : [])];
  let active = false, blocked = null, schemaHash, baselineRows = new Map(), initialRows = new Map(), runtimeDigest = null, reportCache;
  const sourcePublications = new AsyncLocalStorage();
  const initialRecords = new Map();
  const authoritativeSchemaRecords = new Set();
  const verifyFiles = async () => {
    for (const entry of descriptors) {
      if (await io.realpath(entry.candidate) !== entry.file || !inside(entry.root, await io.realpath(entry.file)))
        throw fail(`Pack data path changed: ${entry.candidate}.`, 'PackDataConflict', 409);
      if (bytesHash(await io.readFile(entry.file)) !== entry.digest)
        throw fail(`Pack DATA changed outside this runtime: ${entry.file}. Restart from the updated data.`, 'PackDataConflict', 409);
    }
  };
  const capture = (state, rows = rowHashes(state), schema = hash(schemaOf(state))) => { schemaHash = schema; baselineRows = rows; reportCache = null; };
  const ownerFor = table => owners.get(table) ?? (newTablesOwner && !runtimeTables.has(table) && !schemaTables.includes(table) && !initialRows.has(table) ? { entry: newTablesOwner, path: [...newTablesOwner.newTablesPath, table], idColumn: null } : null);
  const validateRows = (table, rows, owner, state) => {
    if (!Array.isArray(rows)) throw fail(`Pack data for ${table} must be an array.`);
    const idColumn = owner.idColumn ?? state.mappings?.[table]?.idColumn;
    if (!idColumn || owner.idColumn && state.mappings?.[table] && state.mappings[table].idColumn !== owner.idColumn)
      throw fail(`Pack data for ${table} disagrees with its primary key metadata.`);
    const ids = new Set();
    for (const row of rows) {
      const id = row?.[idColumn];
      if (!plain(row) || typeof id !== 'string' || !id.trim()) throw fail(`Pack data for ${table} has a missing primary key.`);
      const identity = rowIdentity(row, state.mappings?.[table], idColumn);
      if (ids.has(identity)) throw fail(`Pack data for ${table} has a duplicate record identity.`);
      ids.add(identity);
    }
  };
  return {
    schemaRecordsAuthoritative: table => authoritativeSchemaRecords.has(table),
    /** Whether a pack DATA file persists this table (simulation/deep): dataverse-storage-routing keeps its small bodies inline. */
    packOwned: table => !memory && Boolean(ownerFor(table)),
    recordCapabilities(table) {
      const schemaTable = schemaTables.includes(table);
      const writable = !blocked && (schemaTable ? settings.level === 'deep' && Boolean(schemaOwner) : memory || owners.has(table) || runtimeTables.has(table));
      return { create: writable, update: writable, delete: writable,
        ...(writable ? {} : { reason: blocked ?? (schemaTable ? 'Operation definitions require deep simulation and a declared schemaPath.' : 'Declare an existing pack DATA location for this table, or use dry run.') }) };
    },
    async load(initial) {
      let state = initial;
      if (!memory) {
        await io.mkdir(path.dirname(runtimeFile), { recursive: true });
        await recoverTransactionalFiles({ journalFile, files: allFiles, io });
        try { state = await readStateFile(runtimeFile); runtimeDigest = bytesHash(await io.readFile(runtimeFile)); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      state = structuredClone(state);
      for (const entry of descriptors) {
        const raw = await io.readFile(entry.file);
        try { entry.document = JSON.parse(raw.toString('utf8')); }
        catch { throw fail(`Pack DATA file is not valid JSON: ${entry.file}.`); }
        entry.digest = bytesHash(raw);
        if (entry.schemaPath) {
          const schema = at(entry.document, entry.schemaPath);
          if (!plain(schema)) throw fail(`The schema location in ${entry.file} must already exist as an object.`);
          if (schema.mappings !== undefined) {
            if (!plain(schema.mappings)) throw fail('Pack schema mappings must be an object.');
            Object.assign(state.mappings ??= {}, structuredClone(schema.mappings));
          }
          for (const key of metadataKeys) if (schema[key] != null) (state.dataverse ??= {})[key] = structuredClone(schema[key]);
          if (schema.schemaRecords !== undefined) {
            if (!plain(schema.schemaRecords)) throw fail('Pack schemaRecords must be an object.');
            for (const table of schemaTables) if (schema.schemaRecords[table] !== undefined) {
              if (!Array.isArray(schema.schemaRecords[table]) || schema.schemaRecords[table].some(row => !plain(row))) throw fail(`Pack schemaRecords.${table} must be a record array.`);
              (state.tables ??= {})[table] = structuredClone(schema.schemaRecords[table]);
              authoritativeSchemaRecords.add(table);
            }
          }
        }
      }
      state.tables ??= {};
      for (const entry of descriptors) {
        if (entry.newTablesPath) {
          const tables = at(entry.document, entry.newTablesPath);
          if (!plain(tables)) throw fail(`The new tables location in ${entry.file} must already exist as an object.`);
          for (const [table, rows] of Object.entries(tables)) {
            if (!/^[a-z][a-z0-9_]*$/i.test(table) || ['constructor', 'prototype', '__proto__'].includes(table) || owners.has(table) || runtimeTables.has(table)) throw fail(`Invalid or conflicting new table owner ${table}.`);
            const owner = { entry, path: [...entry.newTablesPath, table], idColumn: state.mappings?.[table]?.idColumn };
            validateRows(table, rows, owner, state); owners.set(table, owner);
            state.tables[table] = structuredClone(rows);
          }
        }
        for (const [table, owner] of Object.entries(entry.tables)) {
          const rows = at(entry.document, owner.path);
          validateRows(table, rows, owner, state);
          state.tables[table] = structuredClone(rows);
        }
      }
      return state;
    },
    activate(state) {
      if (active) return;
      active = true; capture(state); initialRows = new Map(baselineRows);
      for (const [table, rows] of Object.entries(state.tables ?? {})) {
        const idColumn = state.mappings?.[table]?.idColumn;
        const mapping = { idColumn, tableType: state.mappings?.[table]?.tableType };
        initialRecords.set(table, { idColumn, mapping, rows: new Map(rows.map(row => [rowIdentity(row, mapping), hash(row)])) });
      }
    },
    async bootstrap(fn, stateOf) {
      if (sourcePublications.getStore()?.active) return fn();
      const publication = { active: true };
      return sourcePublications.run(publication, async () => {
        try {
          const result = await fn();
          if (stateOf) capture(stateOf());
          return result;
        } finally { publication.active = false; }
      });
    },
    async save(state, { tables } = {}) {
      if (blocked) throw fail(blocked, 'PersistenceRecoveryRequired', 500);
      const sourcePublication = sourcePublications.getStore()?.active === true;
      const currentSchema = hash(schemaOf(state)), schemaChanged = active && !sourcePublication && currentSchema !== schemaHash;
      if (schemaChanged && settings.level !== 'deep') throw fail('Schema changes require deep simulation. Record edits are allowed in the current level.', 'SimulationSchemaDisabled', 403);
      if (schemaChanged && !schemaOwner) throw fail('Deep simulation requires an explicitly declared schemaPath in an existing pack DATA file.', 'SimulationSchemaTargetRequired', 409);
      if (memory) { reportCache = null; return; }
      // ponytail: the schema hash above stays whole-state (schema changes are refused below deep simulation even in
      // dry run, and sections have no row journal); only row hashing is limited to the transaction's tables.
      const rows = tables instanceof Set && active && !sourcePublication ? dirtyRowHashes(state, baselineRows, tables) : rowHashes(state);
      const changed = active && !sourcePublication ? [...new Set([...baselineRows.keys(), ...rows.keys()])].filter(table => rows.get(table) !== baselineRows.get(table)) : [];
      for (const table of changed) if (!ownerFor(table) && !runtimeTables.has(table) && !(schemaOwner && schemaTables.includes(table)))
        throw fail(`Table ${table} has no declared writable pack DATA file. Declare its owner or use dry run.`, 'SimulationDataTargetRequired', 409);
      const documents = new Map();
      const documentOf = entry => { if (!documents.has(entry)) documents.set(entry, structuredClone(entry.document)); return documents.get(entry); };
      for (const table of changed) {
        const owner = ownerFor(table);
        if (!owner) continue;
        if (!state.mappings?.[table] && newTablesOwner === owner.entry && owner.path.length === newTablesOwner.newTablesPath.length + 1) {
          delete at(documentOf(owner.entry), newTablesOwner.newTablesPath)[table];
          continue;
        }
        const value = state.tables?.[table] ?? [];
        validateRows(table, value, owner, state);
        const document = documentOf(owner.entry);
        // A newly declared dynamic table adds a property to its existing object.
        documents.set(owner.entry, put(document, owner.path, structuredClone(value)));
      }
      if (schemaChanged) {
        const document = documentOf(schemaOwner), original = at(document, schemaOwner.schemaPath);
        documents.set(schemaOwner, put(document, schemaOwner.schemaPath, { ...original, ...structuredClone(schemaOf(state)) }));
      }
      const entries = [...documents].map(([entry, value]) => ({ file: entry.file, value, expectedDigest: entry.digest, existingOnly: true }));
      entries.push({ file: runtimeFile, value: state, expectedDigest: runtimeDigest });
      try {
        const published = await publishTransactionalFiles({ entries, journalFile, io, verify: verifyFiles, allowedFiles: allFiles });
        for (const result of published) {
          if (result.file === runtimeFile) runtimeDigest = result.digest;
          else { const entry = descriptors.find(item => item.file === result.file); entry.digest = result.digest; entry.document = documents.get(entry); }
        }
        capture(state, rows, currentSchema);
        if (schemaChanged) for (const table of schemaTables) authoritativeSchemaRecords.add(table);
        for (const table of changed) { const owner = ownerFor(table); if (owner && !owners.has(table)) owners.set(table, { ...owner, idColumn: state.mappings[table].idColumn }); }
      } catch (error) { if (error.code === 'PersistenceRecoveryRequired') { blocked = error.message; reportCache = null; } throw error; }
    },
    report(state) {
      if (reportCache) return structuredClone(reportCache);
      const current = rowHashes(state);
      const dirtyTables = [...new Set([...initialRows.keys(), ...current.keys()])].filter(table => initialRows.get(table) !== current.get(table));
      const dirtyRecords = dirtyTables.reduce((total, table) => {
        const before = initialRecords.get(table), idColumn = state.mappings?.[table]?.idColumn ?? before?.idColumn;
        const mapping = state.mappings?.[table] ?? before?.mapping;
        const after = new Map((state.tables?.[table] ?? []).map(row => [rowIdentity(row, mapping, idColumn), hash(row)]));
        return total + [...new Set([...(before?.rows.keys() ?? []), ...after.keys()])].filter(id => before?.rows.get(id) !== after.get(id)).length;
      }, 0);
      reportCache = { ...simulationReport(settings), schemaChanges: settings.level === 'deep' && Boolean(schemaOwner),
        controlPlanePersistence: memory ? 'memory' : 'private-local-state',
        ready: !blocked, ...(blocked ? { reason: blocked } : {}),
        targets: descriptors.map(entry => ({ packId: entry.packId, file: entry.file, tables: [...owners].filter(([, owner]) => owner.entry === entry).map(([table]) => table), newTables: Boolean(entry.newTablesPath), schema: Boolean(entry.schemaPath) })),
        dirtyRecords, dirtyTables,
      };
      return structuredClone(reportCache);
    },
  };
}
