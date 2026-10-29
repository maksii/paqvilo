// Generic offline data generation for Mirage state files. A data pack
// supplies rows through `pack.dataset({ profile, seed, counts })`; this module
// merges them additively (by primary key) into an explicit local state file
// through the runtime's lock, digest and atomic-replace protocol. It never
// contacts a portal or PAC.
import fs from 'node:fs/promises';
import path from 'node:path';
import { DataStore } from './data.mjs';
import { assertOfflineState } from './offline-state.mjs';
import { discoverPacks, presetLibrary } from './preset-registry.mjs';
import { resolvePreset } from './presets.mjs';
import { fieldIndexFromMappings, formatViolations, schemaViolations } from './schema-validation.mjs';
import { validatePersonaCatalog, mergePersonaCatalogs } from './persona-catalog.mjs';
import { membershipsForRoles } from './permissions.mjs';
import { assertDatasetAlternateKeys } from './alternate-key-values.mjs';
import { guidKey } from './dataverse-values.mjs';
import { cloneStateData } from './state-clone.mjs';
import { pagedRecordsOf, readRecordValues } from './record-tables.mjs';
import { compactRecordGraph } from './record-compaction.mjs';

const clone = cloneStateData;
const own = (value, key) => (value != null && Object.hasOwn(value, key) ? value[key] : undefined);
const idColumnOf = (state, table) => own(state.mappings, table)?.idColumn ?? `${table}id`;
const rowKey = (value) => guidKey(value) ?? String(value).toLowerCase();
// `missing` stands in for an absent key value (the scaffold counts such existing rows as '').
function* rowKeys(rows, column, missing) {
  for (const row of readRecordValues(rows)) yield rowKey(own(row, column) ?? missing);
}
const object = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const validName = (value) =>
  typeof value === 'string' && /^[\w.-]+$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);

function validateDatasetBody(value, label) {
  if (!object(value)) throw new Error(`${label} must be a dataset object`);
  for (const section of ['mappings', 'tables'])
    if (value[section] !== undefined && !object(value[section]))
      throw new Error(`${label}.${section} must be an object`);
  for (const [table, mapping] of Object.entries(value.mappings ?? {})) {
    if (!validName(table) || !object(mapping))
      throw new Error(`${label}.mappings must contain valid table names and mapping objects`);
    for (const field of ['idColumn', 'entitySet'])
      if (mapping[field] !== undefined && !validName(mapping[field]))
        throw new Error(`${label}.mappings.${table}.${field} must be a valid name`);
  }
  for (const [table, rows] of Object.entries(value.tables ?? {})) {
    if (!validName(table) || !Array.isArray(rows))
      throw new Error(`${label}.tables must contain valid table names and row arrays`);
    for (const row of readRecordValues(rows))
      if (!object(row)) throw new Error(`${label}.tables.${table} rows must be objects`);
  }
  if (value.permissions !== undefined) {
    if (!Array.isArray(value.permissions))
      throw new Error(`${label}.permissions must be an array of permission objects`);
    for (const permission of value.permissions)
      if (!object(permission)) throw new Error(`${label}.permissions must be an array of permission objects`);
  }
}

/** Merge mappings: generated definitions under existing (explicit edits win). */
function mergeMappings(target, mappings = {}) {
  for (const [table, mapping] of Object.entries(mappings)) {
    const existing = own(target, table);
    if (!existing) target[table] = clone(mapping);
    else if (existing.userConfigured !== true)
      target[table] = {
        ...clone(mapping),
        ...clone(existing),
        relationships: { ...clone(mapping.relationships ?? {}), ...clone(existing.relationships ?? {}) },
      };
  }
}

/** Additive row merge by primary key; existing rows (and local edits) are kept. */
function mergeRows(state, tables = {}, report) {
  for (const [table, rows] of Object.entries(tables)) {
    const idColumn = idColumnOf(state, table);
    const target = own(state.tables, table) ?? (state.tables[table] = []);
    const seen = new Set(rowKeys(target, idColumn));
    const entry = own(report, table) ?? (report[table] = { added: 0, alreadyPresent: 0 });
    for (const row of readRecordValues(rows)) {
      const id = own(row, idColumn);
      if (id == null) throw new Error(`Cannot merge ${table} row without ${idColumn}`);
      if (seen.has(rowKey(id))) {
        entry.alreadyPresent++;
        continue;
      }
      target.push(clone(row));
      seen.add(rowKey(id));
      entry.added++;
    }
  }
}

/** Every `{ id, logical_name }` lookup in the listed tables resolves to a row. */
export function findDanglingLookups(state, tables = Object.keys(state.tables ?? {})) {
  const indexes = new Map();
  const has = (table, id) => {
    const rows = own(state.tables, table) ?? [],
      column = idColumnOf(state, table),
      paged = pagedRecordsOf(rows);
    // The persistent key tree covers all-string tables. A miss still checks the
    // legacy GUID-whitespace coercion before declaring a lookup unresolved.
    if (paged?.primaryPositions(column, rowKey(id))?.length) return true;
    if (!indexes.has(table)) indexes.set(table, new Set(rowKeys(rows, column)));
    return indexes.get(table).has(rowKey(id));
  };
  const dangling = [];
  for (const table of tables)
    for (const row of readRecordValues(own(state.tables, table) ?? []))
      for (const [field, value] of Object.entries(row))
        if (
          value &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          value.logical_name &&
          value.id != null &&
          !has(String(value.logical_name).toLowerCase(), value.id)
        )
          dangling.push({
            table,
            id: own(row, idColumnOf(state, table)),
            field,
            target: value.logical_name,
            value: value.id,
          });
  return dangling;
}

/**
 * Merge a pack dataset fragment (and its base preset, when named) into a copy
 * of `state`. Returns { state, report }.
 */
function mergeDatasetState(
  state,
  fragment,
  { basePreset, packId, materializePersonaMemberships = false, portal } = {},
  copy = clone,
) {
  if (!state || typeof state !== 'object' || Array.isArray(state))
    throw new Error('state must be a Mirage state object');
  if (!object(state.mappings) || !Array.isArray(state.permissions))
    throw new Error(
      'state must contain mappings and an explicit permissions array (start the Mirage once to bootstrap it)',
    );
  validateDatasetBody(state, 'State');
  validateDatasetBody(fragment, 'Dataset');
  if (basePreset !== undefined && basePreset !== null) validateDatasetBody(basePreset, 'Base preset');
  if (typeof materializePersonaMemberships !== 'boolean')
    throw new Error('materializePersonaMemberships must be a boolean');
  const result = copy(state);
  result.tables ??= {};
  const report = { base: {}, generated: {} };
  if (basePreset) {
    mergeMappings(result.mappings, basePreset.mappings);
    mergeRows(result, basePreset.tables, report.base);
  }
  mergeMappings(result.mappings, fragment.mappings);
  mergeRows(result, fragment.tables, report.generated);
  assertDatasetAlternateKeys(
    result.mappings,
    result.tables,
    new Set([
      ...Object.keys(basePreset?.tables ?? {}),
      ...Object.keys(fragment.tables ?? {}),
      ...Object.keys(basePreset?.mappings ?? {}),
      ...Object.keys(fragment.mappings ?? {}),
    ]),
    result.settings?.collation,
  );
  let catalog = result.personaCatalog;
  if (basePreset?.personaCatalog !== undefined)
    catalog = mergePersonaCatalogs(
      catalog,
      validatePersonaCatalog(basePreset.personaCatalog, `Preset ${basePreset.id ?? basePreset.name ?? 'base'}`),
    );
  if (fragment.personaCatalog !== undefined)
    catalog = mergePersonaCatalogs(
      catalog,
      validatePersonaCatalog(fragment.personaCatalog, `Dataset ${packId ?? 'pack'}`),
    );
  if (catalog !== undefined) result.personaCatalog = validatePersonaCatalog(catalog, 'Merged state');
  const permissionIds = new Set(result.permissions.map((permission) => permission.id));
  let addedPermissions = 0;
  for (const permission of [...(basePreset?.permissions ?? []), ...(fragment.permissions ?? [])])
    if (permission.id && !permissionIds.has(permission.id)) {
      result.permissions.push(clone(permission));
      permissionIds.add(permission.id);
      addedPermissions++;
    }
  result.provenance = {
    ...(result.provenance ?? {}),
    dataPacks: { ...(result.provenance?.dataPacks ?? {}), [packId ?? 'pack']: clone(fragment.provenance ?? {}) },
  };
  const dangling = findDanglingLookups(result, Object.keys(fragment.tables ?? {}));
  if (dangling.length)
    throw new Error(
      `Generated data has ${dangling.length} unresolved lookup(s): ${JSON.stringify(dangling.slice(0, 5))}`,
    );
  // Generated rows of schema-complete tables must match the bootstrapped
  // field list and option sets (mapping.fieldMetadata of Web API tables).
  const violations = schemaViolations(fragment.tables ?? {}, fieldIndexFromMappings(result.mappings), {
    idColumn: (table) => idColumnOf(result, table),
  });
  if (violations.length)
    throw new Error(
      `Generated data does not match the bootstrapped schema:\n${formatViolations(violations).join('\n')}`,
    );
  let addedMemberships = 0;
  if (materializePersonaMemberships) {
    if (!portal || !Array.isArray(portal.records))
      throw new Error('Persona memberships require the selected imported portal export.');
    const descriptors = fragment.personaRoles ?? [];
    if (!Array.isArray(descriptors))
      throw new Error('Dataset personaRoles must be an array of { contactId, roles } descriptors.');
    const normalizeId = (value) =>
      guidKey(value) ??
      String(value ?? '')
        .replace(/[{}]/g, '')
        .toLowerCase();
    const contactIdColumn = idColumnOf(result, 'contact');
    const contacts = new Map((result.tables.contact ?? []).map((row) => [normalizeId(row[contactIdColumn]), row]));
    const generatedContacts = new Set(
      [...(basePreset?.tables?.contact ?? []), ...(fragment.tables?.contact ?? [])].map((row) =>
        normalizeId(row[contactIdColumn]),
      ),
    );
    for (const descriptor of descriptors) {
      if (
        !descriptor ||
        typeof descriptor !== 'object' ||
        Array.isArray(descriptor) ||
        typeof (descriptor.contactId ?? descriptor.id) !== 'string' ||
        !(descriptor.contactId ?? descriptor.id).trim() ||
        !Array.isArray(descriptor.roles) ||
        descriptor.roles.some((name) => typeof name !== 'string' || !name.trim())
      )
        throw new Error('Dataset personaRoles must contain explicit contactId and role-name arrays.');
      const contact = contacts.get(normalizeId(descriptor.contactId ?? descriptor.id));
      if (!contact || Number(contact.statecode?.value ?? contact.statecode ?? 0) !== 0)
        throw new Error('Persona membership contact is missing or inactive in the merged local data.');
      if (!generatedContacts.has(normalizeId(descriptor.contactId ?? descriptor.id)))
        throw new Error('Persona membership contact must be supplied by this dataset or its base preset.');
    }
    // Resolve every role before adding any assignments. Catalogue metadata and
    // a base preset never implicitly create memberships during additive merge.
    const assignments = membershipsForRoles(portal, descriptors);
    if (assignments.length) {
      result.simulator ??= {};
      const memberships = (result.simulator.contactRoles ??= []);
      const seen = new Set(memberships.map((entry) => `${normalizeId(entry.contactId)}:${normalizeId(entry.roleId)}`));
      for (const assignment of assignments) {
        const key = `${assignment.contactId}:${assignment.roleId}`;
        if (seen.has(key)) continue;
        memberships.push(assignment);
        seen.add(key);
        addedMemberships++;
      }
    }
  }
  return { state: result, report: { ...report, addedPermissions, addedMemberships, schemaViolations: 0 } };
}

export function mergeDataset(state, fragment, options) {
  return mergeDatasetState(state, fragment, options);
}

async function withOfflineResources(run) {
  const closers = [];
  let failure,
    result,
    failed = false;
  try {
    result = await run((resource, close = () => resource.closeRecordStorage()) => {
      closers.push(close);
      return resource;
    });
  } catch (error) {
    failed = true;
    failure = error;
  }
  const errors = [];
  for (const close of closers)
    try {
      close();
    } catch (error) {
      errors.push(error);
    }
  if (errors.length)
    throw new AggregateError(failed ? [failure, ...errors] : errors, 'Offline data resources failed to close', {
      cause: failure,
    });
  if (failed) throw failure;
  return result;
}

async function writeOfflineState(ownResource, source, outputPath, state) {
  let output = state;
  if (source && outputPath !== source.file) {
    const copied = await compactRecordGraph(state, outputPath + '.records', { stateOwner: outputPath });
    if (copied) {
      ownResource(copied, () => copied.session.close());
      output = copied.state;
    }
  }
  const destination =
    source?.file === outputPath ? source : await ownResource(new DataStore({ file: outputPath, state: output })).init();
  await destination.replaceState(output, {
    expectedDigest: destination.snapshotDigest(),
    cloneInput: false,
    returnSnapshot: false,
  });
}

const parseCount = (value, option) => {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(String(value))) throw new Error(`--${option} must be a nonnegative integer`);
  const count = Number(value);
  if (!Number.isSafeInteger(count)) throw new Error(`--${option} is too large`);
  return count;
};

const parseCounts = (entries = []) => {
  const counts = {};
  for (const entry of entries) {
    const match = /^([A-Za-z][A-Za-z0-9_]*)=(.+)$/.exec(entry);
    if (!match || ['__proto__', 'constructor', 'prototype'].includes(match[1]))
      throw new Error('--count must be NAME=N with a valid generator-defined name');
    if (Object.hasOwn(counts, match[1])) throw new Error(`Duplicate --count ${match[1]}`);
    counts[match[1]] = parseCount(match[2], `count ${match[1]}`);
  }
  return counts;
};

/** Validate data actions without resolving sources or opening state. */
export function validateDataCommand(subcommands, args) {
  if (subcommands.length !== 1)
    throw new Error(
      'Data commands require exactly one action: generate or scaffold; unexpected positional arguments are not accepted.',
    );
  const [action] = subcommands;
  if (action === 'scaffold')
    for (const name of ['pack', 'pack-module', 'count', 'materialize-persona-memberships'])
      if (args[name] !== undefined) throw new Error(`--${name} is supported only by data generate`);
  if (action === 'generate' && args.rows !== undefined)
    throw new Error('--rows is supported only by data scaffold; use --count NAME=N for pack-defined generation counts');
  if (action !== 'generate' && action !== 'scaffold')
    throw new Error(
      'Usage: node mirage/cli.mjs data generate --pack ID --profile NAME --state FILE [--out FILE] [--seed S]\n' +
        '       node mirage/cli.mjs data scaffold --source PORTAL_DIR --profile smoke|dev --state FILE [--solution-root DIR ...] [--rows N] [--out FILE] [--seed S]',
    );
  if (action === 'scaffold') parseCount(args.rows, 'rows');
  else parseCounts(args.count);
  return action;
}

/** CLI adapter: `node mirage/cli.mjs data generate --pack ID ...` (parsed args). */
export async function runDataCommand(subcommands, args) {
  const action = validateDataCommand(subcommands, args);
  if (action === 'scaffold')
    return scaffoldDataCommand({
      profile: args.profile ?? 'smoke',
      state: args.state,
      out: args.out,
      seed: args.seed,
      source: args.source,
      solutionRoots: args['solution-root'] ?? [],
      rowsPerTable: parseCount(args.rows, 'rows'),
      resolution: args.resolution,
      dataModel: args.dataModel ?? args['data-model'],
    });
  let project;
  if (args.project) {
    const { loadProjectConfig } = await import('./project-config.mjs');
    project = await loadProjectConfig(args.project);
  }
  const counts = parseCounts(args.count);
  return generateDataCommand({
    pack: args.pack,
    profile: args.profile ?? 'deep',
    state: args.state,
    out: args.out,
    seed: args.seed,
    counts,
    project,
    materializePersonaMemberships: args['materialize-persona-memberships'] ?? false,
    source: args.source,
    dataModel: args.dataModel ?? args['data-model'],
    packModules: (args['pack-module'] ?? []).map((module) => ({ module: path.resolve(module) })),
  });
}

/**
 * `data generate`: load the pack, generate the profile, merge into --state and
 * write --out (default: --state, in place) with lock/digest/atomic replace.
 */
async function generateDataCommand({
  pack: packId,
  profile = 'deep',
  state: statePath,
  out,
  seed,
  counts = {},
  project,
  packModules = [],
  materializePersonaMemberships = false,
  source: portalSource,
  dataModel,
} = {}) {
  return withOfflineResources(async (ownResource) => {
    if (!packId) throw new Error('--pack is required');
    if (!statePath) throw new Error('--state is required');
    const inputPath = path.resolve(statePath);
    const outputPath = path.resolve(out ?? statePath);
    const packs = await discoverPacks({ project, explicit: packModules });
    const pack = packs.find((candidate) => candidate.id === packId);
    if (!pack)
      throw new Error(`Unknown data pack '${packId}'. Available: ${packs.map((p) => p.id).join(', ') || 'none'}`);
    if (typeof pack.dataset !== 'function') throw new Error(`Data pack '${packId}' does not provide dataset()`);
    if (pack.profiles && !Object.hasOwn(pack.profiles, profile))
      throw new Error(`Data pack '${packId}' has no profile '${profile}' (${Object.keys(pack.profiles).join(', ')})`);
    await assertOfflineState(outputPath);
    if (outputPath !== inputPath) await assertOfflineState(inputPath);
    const started = performance.now();
    const source = await ownResource(new DataStore({ file: inputPath })).init();
    // The command owns this input. The merge makes one private copy, sharing
    // immutable record pages instead of materializing complete row arrays.
    const input = source.state;
    const fragment = await pack.dataset({ profile, seed, counts });
    validateDatasetBody(fragment, 'Dataset');
    const library = presetLibrary({ packs: [pack] });
    const basePreset = fragment.base ? resolvePreset(input, fragment.base, library, source.recordContext()) : null;
    if (fragment.base && !basePreset) throw new Error(`Base preset '${fragment.base}' is unavailable`);
    if (materializePersonaMemberships && !portalSource)
      throw new Error('Persona memberships require the selected portal source (--source, --site or --project).');
    const portal = materializePersonaMemberships
      ? await (await import('./importer.mjs')).importPortal(path.resolve(portalSource), { dataModel })
      : undefined;
    const { state: output, report } = mergeDatasetState(
      input,
      fragment,
      {
        basePreset,
        packId,
        materializePersonaMemberships,
        portal,
      },
      (value) => cloneStateData(value, { forkTables: true }),
    );
    const generatedMs = performance.now() - started;
    // Re-check immediately before writing; the store applies its own lock and
    // digest checks (docs/state-write-integrity.md).
    await assertOfflineState(outputPath);
    await writeOfflineState(ownResource, source, outputPath, output);
    return {
      written: outputPath,
      pack: packId,
      profile,
      seed: fragment.provenance?.seed ?? seed ?? null,
      base: fragment.base ?? null,
      rows: Object.fromEntries(
        Object.entries(report.generated).filter(([, entry]) => entry.added || entry.alreadyPresent),
      ),
      baseRowsAdded: Object.values(report.base).reduce((sum, entry) => sum + entry.added, 0),
      addedPermissions: report.addedPermissions,
      addedMemberships: report.addedMemberships,
      measures: fragment.provenance?.measures ?? null,
      elapsedMs: Math.round(performance.now() - started),
      generationMs: Math.round(generatedMs),
    };
  });
}

/**
 * `data scaffold`: generate the schema-driven scaffold (lib/scaffold-data.mjs)
 * for the portal at --source and merge it additively by primary key into
 * --state (bootstrapped from the portal and its solution metadata when the
 * file does not exist yet), writing --out with lock/digest/atomic replace.
 */
export async function scaffoldDataCommand({
  profile = 'smoke',
  state: statePath,
  out,
  seed,
  source,
  solutionRoots = [],
  rowsPerTable,
  resolution,
  dataModel,
} = {}) {
  return withOfflineResources(async (ownResource) => {
    if (!statePath) throw new Error('--state is required');
    if (!source) throw new Error('A portal source is required (--site/--env, --project or --source)');
    const [
      { importPortal },
      { importSolutionData, applySolutionData },
      { discoverSolutionRoots },
      { scaffoldData },
      { initialState },
    ] = await Promise.all([
      import('./importer.mjs'),
      import('./solution-data.mjs'),
      import('./solution-roots.mjs'),
      import('./scaffold-data.mjs'),
      import('./bootstrap.mjs'),
    ]);
    const inputPath = path.resolve(statePath);
    const outputPath = path.resolve(out ?? statePath);
    await assertOfflineState(outputPath);
    if (outputPath !== inputPath) await assertOfflineState(inputPath);
    const started = performance.now();
    const sourceDir = path.resolve(source);
    const portal = await importPortal(sourceDir, { dataModel });
    const roots = solutionRoots.length
      ? solutionRoots.map((root) => path.resolve(root))
      : await discoverSolutionRoots(sourceDir);
    const metadata = await importSolutionData(roots);
    const scaffold = scaffoldData({
      portal,
      schema: metadata.schema,
      profile,
      ...(seed ? { seed } : {}),
      ...(rowsPerTable !== undefined ? { rowsPerTable } : {}),
    });
    let input, sourceStore;
    let bootstrapped = false;
    try {
      await fs.access(inputPath);
      sourceStore = await ownResource(new DataStore({ file: inputPath })).init();
      input = sourceStore.snapshot(undefined, { forkTables: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      input = applySolutionData(initialState(portal, { metadata }), metadata);
      bootstrapped = true;
    }
    // Both bootstrap and snapshot produced a private graph owned by this command.
    const output = input;
    output.tables ??= {};
    output.mappings ??= {};
    output.permissions ??= [];
    output.simulator ??= {};
    const rows = {};
    for (const [table, generated] of Object.entries(scaffold.tables)) {
      if (!own(output.mappings, table) && own(metadata.mappings, table)) {
        const { fieldMetadata: _fields, schemaComplete: _complete, ...mapping } = own(metadata.mappings, table);
        output.mappings[table] = cloneStateData(mapping);
      } else if (!own(output.mappings, table))
        // Tables the solution layers do not define (such as the web role
        // membership intersect) get the conventional mapping of their rows.
        output.mappings[table] = {
          entitySet: `${table}s`,
          idColumn: own(scaffold.idColumns, table),
          relationships: {},
          inferred: true,
        };
      const key = own(output.mappings, table)?.idColumn ?? own(scaffold.idColumns, table);
      const existing = own(output.tables, table) ?? (output.tables[table] = []);
      // An existing row without the key never hides a generated row without it.
      const ids = new Set(rowKeys(existing, key, ''));
      let added = 0;
      for (const row of generated)
        if (!ids.has(rowKey(own(row, key)))) {
          existing.push(cloneStateData(row));
          added++;
        }
      rows[table] = { added, alreadyPresent: generated.length - added };
    }
    const memberships = (output.simulator.contactRoles ??= []);
    const seen = new Set(memberships.map((entry) => `${rowKey(entry.contactId)}:${rowKey(entry.roleId)}`));
    let addedMemberships = 0;
    for (const entry of scaffold.contactRoles) {
      const key = `${rowKey(entry.contactId)}:${rowKey(entry.roleId)}`;
      if (seen.has(key)) continue;
      memberships.push(cloneStateData(entry));
      seen.add(key);
      addedMemberships++;
    }
    output.provenance = { ...(output.provenance ?? {}), scaffold: { ...scaffold.report, source: sourceDir } };
    await assertOfflineState(outputPath);
    await writeOfflineState(ownResource, sourceStore, outputPath, output);
    return {
      written: outputPath,
      bootstrapped,
      profile,
      report: scaffold.report,
      rows,
      addedMemberships,
      source: sourceDir,
      solutionRoots: roots,
      resolution: resolution ?? { kind: 'source', solutionRoots: solutionRoots.length ? 'explicit' : 'discovered' },
      elapsedMs: Math.round(performance.now() - started),
    };
  });
}
