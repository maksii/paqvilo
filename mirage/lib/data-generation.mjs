// Generic offline data generation for Mirage state files. A data pack
// supplies rows through `pack.dataset({ profile, seed, counts })`; this module
// merges them additively (by primary key) into an explicit local state file
// through the runtime's lock, digest and atomic-replace protocol. It never
// contacts a portal or PAC.
import fs from "node:fs/promises";
import path from "node:path";
import { DataStore } from "./data.mjs";
import { assertOfflineState } from "./offline-state.mjs";
import { discoverPacks, presetLibrary } from "./preset-registry.mjs";
import { resolvePreset } from "./presets.mjs";
import { fieldIndexFromMappings, formatViolations, schemaViolations } from "./schema-validation.mjs";

const clone = (value) => structuredClone(value);
const idColumnOf = (state, table) => state.mappings?.[table]?.idColumn ?? `${table}id`;

/** Merge mappings: generated definitions under existing (explicit edits win). */
function mergeMappings(target, mappings = {}) {
  for (const [table, mapping] of Object.entries(mappings)) {
    const existing = target[table];
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
    const target = (state.tables[table] ??= []);
    const seen = new Set(target.map((row) => String(row[idColumn]).toLowerCase()));
    const entry = (report[table] ??= { added: 0, alreadyPresent: 0 });
    for (const row of rows) {
      const id = row[idColumn];
      if (id == null) throw new Error(`Cannot merge ${table} row without ${idColumn}`);
      if (seen.has(String(id).toLowerCase())) {
        entry.alreadyPresent++;
        continue;
      }
      target.push(clone(row));
      seen.add(String(id).toLowerCase());
      entry.added++;
    }
  }
}

/** Every `{ id, logical_name }` lookup in the listed tables resolves to a row. */
export function findDanglingLookups(state, tables = Object.keys(state.tables ?? {})) {
  const indexes = new Map();
  const has = (table, id) => {
    if (!indexes.has(table))
      indexes.set(table, new Set((state.tables?.[table] ?? []).map((row) => String(row[idColumnOf(state, table)]).toLowerCase())));
    return indexes.get(table).has(String(id).toLowerCase());
  };
  const dangling = [];
  for (const table of tables)
    for (const row of state.tables?.[table] ?? [])
      for (const [field, value] of Object.entries(row))
        if (value && typeof value === "object" && !Array.isArray(value) && value.logical_name && value.id != null && !has(String(value.logical_name).toLowerCase(), value.id))
          dangling.push({ table, id: row[idColumnOf(state, table)], field, target: value.logical_name, value: value.id });
  return dangling;
}

/**
 * Merge a pack dataset fragment (and its base preset, when named) into a copy
 * of `state`. Returns { state, report }.
 */
export function mergeDataset(state, fragment, { basePreset, packId } = {}) {
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("state must be a Mirage state object");
  if (!state.mappings || !Array.isArray(state.permissions))
    throw new Error("state must contain mappings and an explicit permissions array (start the Mirage once to bootstrap it)");
  const result = clone(state);
  result.tables ??= {};
  const report = { base: {}, generated: {} };
  if (basePreset) {
    mergeMappings(result.mappings, basePreset.mappings);
    mergeRows(result, basePreset.tables, report.base);
  }
  mergeMappings(result.mappings, fragment.mappings);
  mergeRows(result, fragment.tables, report.generated);
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
    dataPacks: { ...(result.provenance?.dataPacks ?? {}), [packId ?? "pack"]: clone(fragment.provenance ?? {}) },
  };
  const dangling = findDanglingLookups(result, Object.keys(fragment.tables ?? {}));
  if (dangling.length)
    throw new Error(`Generated data has ${dangling.length} unresolved lookup(s): ${JSON.stringify(dangling.slice(0, 5))}`);
  // Generated rows of schema-complete tables must match the bootstrapped
  // field list and option sets (mapping.fieldMetadata of Web API tables).
  const violations = schemaViolations(fragment.tables ?? {}, fieldIndexFromMappings(result.mappings), {
    idColumn: (table) => result.mappings[table]?.idColumn ?? `${table}id`,
  });
  if (violations.length)
    throw new Error(`Generated data does not match the bootstrapped schema:\n${formatViolations(violations).join("\n")}`);
  return { state: result, report: { ...report, addedPermissions, schemaViolations: 0 } };
}

const parseCount = (value, option) => {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(String(value))) throw new Error(`--${option} must be a nonnegative integer`);
  const count = Number(value);
  if (!Number.isSafeInteger(count)) throw new Error(`--${option} is too large`);
  return count;
};

/** CLI adapter: `node mirage/cli.mjs data generate --pack ID ...` (parsed args). */
export async function runDataCommand(subcommands, args) {
  const [action] = subcommands;
  if (action === "scaffold")
    return scaffoldDataCommand({
      profile: args.profile ?? "smoke",
      state: args.state,
      out: args.out,
      seed: args.seed,
      source: args.source,
      solutionRoots: args["solution-root"] ?? [],
      rowsPerTable: parseCount(args.rows, "rows"),
      resolution: args.resolution,
    });
  if (action !== "generate")
    throw new Error(
      "Usage: node mirage/cli.mjs data generate --pack ID --profile NAME --state FILE [--out FILE] [--seed S]\n" +
        "       node mirage/cli.mjs data scaffold --source PORTAL_DIR --profile smoke|dev --state FILE [--solution-root DIR ...] [--rows N] [--out FILE] [--seed S]",
    );
  let project;
  if (args.project) {
    const { loadProjectConfig } = await import("./project-config.mjs");
    project = await loadProjectConfig(args.project);
  }
  const counts = {};
  for (const entry of args.count ?? []) {
    const match = /^([A-Za-z][A-Za-z0-9_]*)=(.+)$/.exec(entry);
    if (!match || ['__proto__', 'constructor', 'prototype'].includes(match[1])) throw new Error('--count must be NAME=N with a valid generator-defined name');
    if (Object.hasOwn(counts, match[1])) throw new Error(`Duplicate --count ${match[1]}`);
    counts[match[1]] = parseCount(match[2], `count ${match[1]}`);
  }
  return generateDataCommand({
    pack: args.pack,
    profile: args.profile ?? "deep",
    state: args.state,
    out: args.out,
    seed: args.seed,
    counts,
    project,
    packModules: (args["pack-module"] ?? []).map((module) => ({ module: path.resolve(module) })),
  });
}

/**
 * `data generate`: load the pack, generate the profile, merge into --state and
 * write --out (default: --state, in place) with lock/digest/atomic replace.
 */
export async function generateDataCommand({ pack: packId, profile = "deep", state: statePath, out, seed, counts = {}, project, packModules = [] } = {}) {
  if (!packId) throw new Error("--pack is required");
  if (!statePath) throw new Error("--state is required");
  const inputPath = path.resolve(statePath);
  const outputPath = path.resolve(out ?? statePath);
  const packs = await discoverPacks({ project, explicit: packModules });
  const pack = packs.find((candidate) => candidate.id === packId);
  if (!pack) throw new Error(`Unknown data pack '${packId}'. Available: ${packs.map((p) => p.id).join(", ") || "none"}`);
  if (typeof pack.dataset !== "function") throw new Error(`Data pack '${packId}' does not provide dataset()`);
  if (pack.profiles && !Object.hasOwn(pack.profiles, profile))
    throw new Error(`Data pack '${packId}' has no profile '${profile}' (${Object.keys(pack.profiles).join(", ")})`);
  await assertOfflineState(outputPath);
  if (outputPath !== inputPath) await assertOfflineState(inputPath);
  const started = performance.now();
  const source = await new DataStore({ file: inputPath }).init();
  const input = source.snapshot();
  const fragment = await pack.dataset({ profile, seed, counts });
  const library = presetLibrary({ packs: [pack] });
  const basePreset = fragment.base ? resolvePreset(input, fragment.base, library) : null;
  if (fragment.base && !basePreset) throw new Error(`Base preset '${fragment.base}' is unavailable`);
  const { state: output, report } = mergeDataset(input, fragment, { basePreset, packId });
  const generatedMs = performance.now() - started;
  // Re-check immediately before writing; the store applies its own lock and
  // digest checks (docs/state-write-integrity.md).
  await assertOfflineState(outputPath);
  const destination = outputPath === inputPath ? source : await new DataStore({ file: outputPath, state: output }).init();
  await destination.replaceState(output, { expectedSnapshot: JSON.stringify(destination.snapshot()) });
  return {
    written: outputPath,
    pack: packId,
    profile,
    seed: fragment.provenance?.seed ?? seed ?? null,
    base: fragment.base ?? null,
    rows: Object.fromEntries(Object.entries(report.generated).filter(([, entry]) => entry.added || entry.alreadyPresent)),
    baseRowsAdded: Object.values(report.base).reduce((sum, entry) => sum + entry.added, 0),
    addedPermissions: report.addedPermissions,
    measures: fragment.provenance?.measures ?? null,
    elapsedMs: Math.round(performance.now() - started),
    generationMs: Math.round(generatedMs),
  };
}

/**
 * `data scaffold`: generate the schema-driven scaffold (lib/scaffold-data.mjs)
 * for the portal at --source and merge it additively by primary key into
 * --state (bootstrapped from the portal and its solution metadata when the
 * file does not exist yet), writing --out with lock/digest/atomic replace.
 */
export async function scaffoldDataCommand({ profile = "smoke", state: statePath, out, seed, source, solutionRoots = [], rowsPerTable, resolution } = {}) {
  if (!statePath) throw new Error("--state is required");
  if (!source) throw new Error("A portal source is required (--site/--env, --project or --source)");
  const [{ importPortal }, { importSolutionData, applySolutionData }, { discoverSolutionRoots }, { scaffoldData }, { initialState }] = await Promise.all([
    import("./importer.mjs"),
    import("./solution-data.mjs"),
    import("./solution-roots.mjs"),
    import("./scaffold-data.mjs"),
    import("./bootstrap.mjs"),
  ]);
  const inputPath = path.resolve(statePath);
  const outputPath = path.resolve(out ?? statePath);
  await assertOfflineState(outputPath);
  if (outputPath !== inputPath) await assertOfflineState(inputPath);
  const started = performance.now();
  const sourceDir = path.resolve(source);
  const portal = await importPortal(sourceDir);
  const roots = solutionRoots.length ? solutionRoots.map((root) => path.resolve(root)) : await discoverSolutionRoots(sourceDir);
  const metadata = await importSolutionData(roots);
  const scaffold = scaffoldData({ portal, schema: metadata.schema, profile, ...(seed ? { seed } : {}), ...(rowsPerTable ? { rowsPerTable } : {}) });
  let input;
  let bootstrapped = false;
  try {
    await fs.access(inputPath);
    input = (await new DataStore({ file: inputPath }).init()).snapshot();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    input = applySolutionData(initialState(portal, { metadata }), metadata);
    bootstrapped = true;
  }
  const output = structuredClone(input);
  output.tables ??= {};
  output.mappings ??= {};
  output.permissions ??= [];
  output.simulator ??= {};
  const rows = {};
  for (const [table, generated] of Object.entries(scaffold.tables)) {
    if (!output.mappings[table] && metadata.mappings[table]) {
      const { fieldMetadata: _fields, schemaComplete: _complete, ...mapping } = metadata.mappings[table];
      output.mappings[table] = structuredClone(mapping);
    } else if (!output.mappings[table])
      // Tables the solution layers do not define (such as the web role
      // membership intersect) get the conventional mapping of their rows.
      output.mappings[table] = { entitySet: `${table}s`, idColumn: scaffold.idColumns[table], relationships: {}, inferred: true };
    const key = output.mappings[table]?.idColumn ?? scaffold.idColumns[table];
    const existing = (output.tables[table] ??= []);
    const ids = new Set(existing.map((row) => String(row[key] ?? "").toLowerCase()));
    let added = 0;
    for (const row of generated)
      if (!ids.has(String(row[key]).toLowerCase())) {
        existing.push(structuredClone(row));
        added++;
      }
    rows[table] = { added, alreadyPresent: generated.length - added };
  }
  const memberships = (output.simulator.contactRoles ??= []);
  const seen = new Set(memberships.map((entry) => `${String(entry.contactId).toLowerCase()}:${String(entry.roleId).toLowerCase()}`));
  let addedMemberships = 0;
  for (const entry of scaffold.contactRoles) {
    const key = `${entry.contactId.toLowerCase()}:${String(entry.roleId).toLowerCase()}`;
    if (seen.has(key)) continue;
    memberships.push(structuredClone(entry));
    seen.add(key);
    addedMemberships++;
  }
  output.provenance = { ...(output.provenance ?? {}), scaffold: { ...scaffold.report, source: sourceDir } };
  await assertOfflineState(outputPath);
  const destination = outputPath === inputPath && !bootstrapped
    ? await new DataStore({ file: inputPath }).init()
    : await new DataStore({ file: outputPath, state: output }).init();
  await destination.replaceState(output, { expectedSnapshot: JSON.stringify(destination.snapshot()) });
  return {
    written: outputPath,
    bootstrapped,
    profile,
    report: scaffold.report,
    rows,
    addedMemberships,
    source: sourceDir,
    solutionRoots: roots,
    resolution: resolution ?? { kind: "source", solutionRoots: solutionRoots.length ? "explicit" : "discovered" },
    elapsedMs: Math.round(performance.now() - started),
  };
}
