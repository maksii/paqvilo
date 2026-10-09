import { createHash } from "node:crypto";
import {
  reconcilePermissionDiagnostics,
  compactBuiltinPresets,
} from "./data.mjs";
import {
  scanSolutionSources,
  buildSolutionSchema,
  tableFields,
  readSolutionZip,
} from "./solution-schema.mjs";
import { pluralizeEntitySetName, standardTable } from "./solution-standard.mjs";
import { resolveScopedRelationship } from "./permissions.mjs";

export { readSolutionZip };

const id = (value) =>
  String(value ?? "")
    .replace(/[{}]/g, "")
    .toLowerCase();
const SCOPED = ["contact", "account", "parent"];
const ENV_DEFINITION = "environmentvariabledefinition";
const ENV_VALUE = "environmentvariablevalue";

/** Deterministic identifier for source records that are exported without one. */
export function sourceRecordId(kind, key) {
  const hex = createHash("sha256").update(`${kind}\0${String(key).toLowerCase()}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function mappingFor(schema, name) {
  const table = schema.tables[name];
  const mapping = {
    entitySet: table.entitySet,
    entitySetSource: table.entitySetSource,
    idColumn: table.primaryIdAttribute,
    idColumnSource: table.primaryIdSource,
    relationships: {},
    entitySetInferred: table.entitySetSource === "pluralized",
    idColumnInferred: table.primaryIdSource === "convention",
    metadataSources: [...table.sources],
    schemaComplete: table.schemaComplete,
  };
  mapping.inferred = mapping.entitySetInferred || mapping.idColumnInferred;
  if (table.primaryNameAttribute) {
    mapping.nameColumn = table.primaryNameAttribute;
    mapping.nameColumnSource = table.primaryNameSource;
  }
  if (table.isIntersect) mapping.intersect = true;
  // Alternate keys (Web API key addressing and uniqueness) with the defining file.
  const keys = Object.values(table.keys ?? {});
  if (keys.length)
    mapping.alternateKeys = keys.map((key) => ({
      name: key.name,
      ...(key.schemaName ? { schemaName: key.schemaName } : {}),
      attributes: [...key.attributes],
      source: key.source,
    }));
  const state = table.attributes.statecode;
  const states = state?.type === "state" ? (state.optionSet?.states ?? []) : [];
  const valid = states.filter((s) => Number.isInteger(s.value) && Number.isInteger(s.defaultStatus));
  if (valid.length) {
    mapping.stateStatusDefaults = Object.fromEntries(valid.map((s) => [s.value, s.defaultStatus]));
    const active = valid.find((s) => s.value === 0);
    if (active) mapping.recordDefaults = { statecode: 0, statuscode: active.defaultStatus };
  }
  return mapping;
}

/**
 * Import table identities, columns and relationships from ordered solution layers.
 * Later layers replace the columns and table properties they export; omitted
 * properties keep earlier values. Unpacked directories, XML files and solution
 * ZIPs are supported; nothing is written outside an optional parse cache.
 */
export async function importSolutionData(roots = [], { entities, cacheFile, cache, order = "explicit", lcid = 1033, scan, schema } = {}) {
  if (typeof roots === "string") roots = [roots];
  scan ??= await scanSolutionSources(roots, { cacheFile, cache, order });
  schema ??= buildSolutionSchema(scan, { lcid });

  const mappings = {};
  for (const name of Object.keys(schema.tables).sort()) mappings[name] = mappingFor(schema, name);
  const relationships = {};
  for (const [key, rel] of Object.entries(schema.relationships)) {
    if (rel.type === "one-to-many") {
      relationships[key] = {
        schemaName: rel.schemaName,
        type: "one-to-many",
        referencingEntity: rel.referencingEntity,
        referencedEntity: rel.referencedEntity,
        referencingAttribute: rel.referencingAttribute,
        referencedAttribute: rel.referencedAttribute,
        referencingNavigation: rel.referencingNavigation,
        referencedNavigation: rel.referencedNavigation,
        // The Solution's cascade configuration ({ assign, delete, archive, reparent, share,
        // unshare, rollupView }, CascadeType names as exported), on the relationship and on
        // both navigation sides; absent when the source states none (standard fallbacks).
        ...(rel.cascade ? { cascade: { ...rel.cascade } } : {}),
        source: rel.source,
        ...(rel.sources?.length > 1 ? { sources: rel.sources } : {}),
        ...(rel.standardFallback ? { standardFallback: true } : {}),
      };
      const child = mappings[rel.referencingEntity],
        parent = mappings[rel.referencedEntity];
      child.relationships[rel.referencingNavigation] = {
        entity: rel.referencedEntity,
        from: rel.referencingAttribute,
        to: rel.referencedAttribute,
        many: false,
        schemaName: rel.schemaName,
        type: "many-to-one",
        partner: rel.referencedNavigation,
        ...(rel.cascade ? { cascade: { ...rel.cascade } } : {}),
      };
      parent.relationships[rel.referencedNavigation] = {
        entity: rel.referencingEntity,
        from: rel.referencedAttribute,
        to: rel.referencingAttribute,
        many: true,
        schemaName: rel.schemaName,
        type: "one-to-many",
        partner: rel.referencingNavigation,
        ...(rel.cascade ? { cascade: { ...rel.cascade } } : {}),
      };
    } else {
      relationships[key] = {
        schemaName: rel.schemaName,
        type: "many-to-many",
        intersectEntity: rel.intersectEntity,
        entity1: rel.entity1,
        entity2: rel.entity2,
        attribute1: rel.attribute1,
        attribute2: rel.attribute2,
        navigation1: rel.navigation1,
        navigation2: rel.navigation2,
        source: rel.source,
        ...(rel.sources?.length > 1 ? { sources: rel.sources } : {}),
        ...(rel.intersectAttributesInferred ? { intersectAttributesInferred: true } : {}),
      };
      const first = mappings[rel.entity1],
        second = mappings[rel.entity2];
      first.relationships[rel.navigation1] = {
        entity: rel.entity2,
        from: first.idColumn,
        to: second.idColumn,
        many: true,
        intersect: { entity: rel.intersectEntity, from: rel.attribute1, to: rel.attribute2 },
        schemaName: rel.schemaName,
        type: "many-to-many",
        partner: rel.navigation2,
      };
      if (first !== second || rel.navigation1 !== rel.navigation2)
        second.relationships[rel.navigation2] = {
          entity: rel.entity1,
          from: second.idColumn,
          to: first.idColumn,
          many: true,
          intersect: { entity: rel.intersectEntity, from: rel.attribute2, to: rel.attribute1 },
          schemaName: rel.schemaName,
          type: "many-to-many",
          partner: rel.navigation1,
        };
    }
  }
  const wanted = entities ? new Set(entities.map((e) => String(e).toLowerCase())) : null;
  const filtered = wanted
    ? Object.fromEntries(Object.entries(mappings).filter(([name]) => wanted.has(name)))
    : mappings;
  const environmentVariables = schema.environmentVariables;
  const values = Object.values(filtered);
  return {
    roots: scan.inputs.filter((input) => input.type !== "missing" && input.type !== "unsupported").map((input) => input.input),
    layers: schema.layers,
    order: scan.order,
    fingerprint: schema.fingerprint,
    mappings: filtered,
    relationships,
    environmentVariables,
    diagnostics: schema.diagnostics,
    schema,
    stats: {
      files: scan.layers.reduce((sum, layer) => sum + layer.documents.length, 0),
      layers: scan.layers.length,
      entities: values.length,
      relationships: Object.keys(relationships).length,
      standardRelationships: schema.standardRelationships,
      exactEntitySets: values.filter((m) => !m.entitySetInferred).length,
      exactPrimaryIds: values.filter((m) => !m.idColumnInferred).length,
      completeTables: values.filter((m) => m.schemaComplete).length,
      environmentVariables: environmentVariables.length,
      cache: scan.cache?.stats,
    },
  };
}

/** Rows that solution layers contribute to bootstrapped tables (environment variables). */
export function solutionSeedRows(metadata, { environmentVariables: overrides = {} } = {}) {
  const definitions = [],
    values = [];
  const local = new Map(Object.entries(overrides ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
  for (const variable of metadata.environmentVariables ?? []) {
    const definitionId = sourceRecordId(ENV_DEFINITION, variable.schemaName);
    definitions.push(
      Object.fromEntries(
        Object.entries({
          environmentvariabledefinitionid: definitionId,
          schemaname: variable.schemaName,
          displayname: variable.displayName,
          description: variable.description,
          type: variable.type,
          defaultvalue: variable.defaultValue,
          isrequired: variable.isRequired,
          secretstore: variable.secretStore,
          valueschema: variable.valueSchema,
          statecode: 0,
          statuscode: 1,
        }).filter(([, value]) => value !== undefined),
      ),
    );
    const localValue = local.get(variable.schemaName.toLowerCase());
    if (localValue !== undefined || variable.value !== undefined)
      values.push({
        environmentvariablevalueid: variable.valueId ?? sourceRecordId(ENV_VALUE, variable.schemaName),
        environmentvariabledefinitionid: definitionId,
        schemaname: variable.schemaName,
        value: String(localValue ?? variable.value),
        statecode: 0,
        statuscode: 1,
      });
  }
  return definitions.length ? { [ENV_DEFINITION]: definitions, [ENV_VALUE]: values } : {};
}

const fieldsWithoutProvenance = (schema, name) => tableFields(schema, name, { provenance: false });

/**
 * Merge imported metadata into a state. Imported (non user-configured) mappings are
 * replaced by the current layers; user-configured mappings are kept. Source-derived
 * rows (environment variables) are upserted and previously seeded rows that left
 * the source are removed; other rows are never touched. `webApiTables` selects the
 * tables whose complete column metadata is stored on the mapping (`fieldMetadata`
 * and `schemaComplete`) for Web API attribute validation.
 */
export function applySolutionData(state, metadata, { webApiTables, environmentVariables, presetLibrary } = {}) {
  const result = structuredClone({
    ...state,
    presets: compactBuiltinPresets(state.presets ?? {}, presetLibrary),
  });
  result.mappings ??= {};
  result.tables ??= {};
  result.simulator ??= {};
  const previous = result.simulator.solutionData ?? {};
  const importDiagnostics = [];
  const imported = (mapping) =>
    mapping && mapping.userConfigured !== true && (mapping.inferred === true || Array.isArray(mapping.metadataSources));
  for (const [name, mapping] of Object.entries(metadata.mappings)) {
    const existing = result.mappings[name];
    if (!existing || imported(existing)) {
      const { fieldMetadata: _f, schemaComplete: _c, ...rest } = mapping;
      result.mappings[name] = structuredClone(rest);
    }
    result.tables[name] ??= [];
  }
  // Previously imported mappings that the selected layers no longer define.
  for (const [name, mapping] of Object.entries(result.mappings))
    if (!metadata.mappings[name] && mapping.userConfigured !== true && mapping.metadataSources?.length) {
      result.mappings[name] = {
        entitySet: standardTable(name)?.entitySet ?? pluralizeEntitySetName(name),
        entitySetSource: standardTable(name) ? "dataverse-reference" : "pluralized",
        idColumn: standardTable(name)?.primaryIdAttribute ?? name + "id",
        idColumnSource: standardTable(name) ? "dataverse-reference" : "convention",
        relationships: {},
        inferred: true,
        entitySetInferred: !standardTable(name),
        idColumnInferred: !standardTable(name),
      };
      importDiagnostics.push({
        code: "SOLUTION_MAPPING_REMOVED",
        entity: name,
        message: "The selected solution layers no longer define this table; its imported mapping was reset.",
      });
    }
  // Complete column metadata for Web API tables (B's 400 InvalidAttribute rule).
  const schema = metadata.schema;
  const apiTables = webApiTables ? new Set([...webApiTables].map((name) => String(name).toLowerCase())) : null;
  for (const [name, mapping] of Object.entries(result.mappings)) {
    if (mapping.userConfigured === true) continue;
    const table = schema?.tables[name];
    const ours = imported(mapping) || mapping.fieldMetadataSource === "solution" || mapping.fieldMetadata === undefined;
    if (apiTables?.has(name) && table && ours) {
      mapping.fieldMetadata = fieldsWithoutProvenance(schema, name);
      mapping.schemaComplete = table.schemaComplete === true;
      mapping.fieldMetadataSource = "solution";
    } else if (mapping.fieldMetadataSource === "solution") {
      delete mapping.fieldMetadata;
      delete mapping.schemaComplete;
      delete mapping.fieldMetadataSource;
    }
  }
  // Source-derived rows: upsert by primary key and remove rows that left the source.
  const seeds = solutionSeedRows(metadata, { environmentVariables });
  const seeded = {};
  for (const [entity, rows] of Object.entries(seeds)) {
    const key = result.mappings[entity]?.idColumn ?? entity + "id";
    const table = (result.tables[entity] ??= []);
    const before = new Set((previous.seededRows?.[entity] ?? []).map(id));
    const current = new Set(rows.map((row) => id(row[key])));
    for (let index = table.length - 1; index >= 0; index--) {
      const rowId = id(table[index]?.[key]);
      if (before.has(rowId) && !current.has(rowId)) table.splice(index, 1);
    }
    for (const row of rows) {
      const index = table.findIndex((existing) => id(existing?.[key]) === id(row[key]));
      if (index >= 0) table[index] = { ...table[index], ...row };
      else table.push(row);
    }
    seeded[entity] = [...current];
  }
  for (const [entity, ids] of Object.entries(previous.seededRows ?? {}))
    if (!seeds[entity] && result.tables[entity]) {
      const key = result.mappings[entity]?.idColumn ?? entity + "id";
      const stale = new Set(ids.map(id));
      result.tables[entity] = result.tables[entity].filter((row) => !stale.has(id(row?.[key])));
    }
  // Imported table permissions in configured mode: resolve scopes from relationships.
  const permissions = result.permissions ?? [];
  const byId = new Map(permissions.map((p) => [id(p.id), p]));
  const resolved = new Set();
  for (const p of permissions)
    if (p.imported && p.userConfigured !== true && SCOPED.includes(p.scope) && p.metadataSource) {
      p.enabled = false;
      p.disabledReason = "The currently selected solution metadata must resolve this permission relationship.";
      delete p.field;
      delete p.relationship;
      delete p.identityRelationship;
      delete p.metadataSource;
      if (p.inheritedRoles) {
        p.roles = [];
        delete p.inheritedRoles;
      }
    }
  for (let pass = 0; pass < permissions.length + 1; pass++) {
    let changed = false;
    for (const permission of permissions) {
      if (!permission.imported || permission.userConfigured === true || !SCOPED.includes(permission.scope)) continue;
      const rel = metadata.relationships[String(permission.relationshipName ?? "").toLowerCase()];
      if (!rel) continue;
      const parent = permission.scope === "parent" ? byId.get(id(permission.parentPermissionId)) : null;
      if (permission.scope === "parent" && (!parent || parent.enabled === false)) continue;
      const target = parent?.entity ?? (permission.scope === "account" ? "account" : "contact");
      const resolution = resolveScopedRelationship(rel, permission, target, result.mappings);
      if (!resolution) continue;
      if (permission.scope === "parent") {
        permission.relationship = resolution.descriptor;
        if (!permission.roles?.length) {
          permission.roles = structuredClone(parent.roles ?? []);
          permission.inheritedRoles = true;
        }
      } else if (resolution.field) permission.field = resolution.field;
      else permission.identityRelationship = resolution.descriptor;
      if (!permission.roles?.length) continue;
      if (permission.enabled === false) {
        permission.enabled = true;
        delete permission.disabledReason;
        resolved.add(permission.id);
        changed = true;
      }
      permission.metadataSource = rel.source;
    }
    if (!changed) break;
  }
  for (const p of permissions)
    if (p.imported && p.enabled === false && p.userConfigured !== true && SCOPED.includes(p.scope)) {
      const rel = metadata.relationships[String(p.relationshipName ?? "").toLowerCase()];
      const parent = byId.get(id(p.parentPermissionId));
      if (!rel)
        p.disabledReason = p.relationshipName
          ? `No selected solution layer or documented Dataverse relationship defines '${p.relationshipName}'.`
          : "The exported permission has no relationship name for its scope.";
      else if (p.scope === "parent" && !parent)
        p.disabledReason = "The referenced parent permission is inactive or was not exported into this portal; Power Pages does not apply children of an ineffective parent.";
      else if (p.scope === "parent" && parent.enabled === false)
        p.disabledReason = "The referenced parent permission is disabled or unresolved.";
      else if (!p.roles?.length)
        p.disabledReason = "No web roles are associated with this root permission; Power Pages requires at least one web role for a table permission to take effect.";
      else
        p.disabledReason = `Relationship '${rel.schemaName}' does not connect '${p.entity}' to the required ${p.scope === "parent" ? "parent permission table" : p.scope} table.`;
    }
  result.simulator.solutionData = {
    roots: metadata.roots,
    stats: metadata.stats,
    fingerprint: metadata.fingerprint,
    ...(Object.keys(seeded).length ? { seededRows: seeded } : {}),
  };
  // Solution diagnostics describe the current layers only; earlier imports are replaced.
  result.simulator.importDiagnostics = [
    ...(result.simulator.importDiagnostics ?? []).filter((d) => !resolved.has(d.id) && !String(d.code ?? "").startsWith("SOLUTION_")),
    ...importDiagnostics,
    ...metadata.diagnostics,
  ];
  for (const preset of Object.values(result.presets ?? {})) {
    if (preset.mappings)
      for (const [name, mapping] of Object.entries(metadata.mappings))
        if (preset.mappings[name]?.userConfigured !== true) {
          const { fieldMetadata: _f, schemaComplete: _c, ...rest } = mapping;
          preset.mappings[name] = {
            ...preset.mappings[name],
            ...structuredClone(rest),
            relationships: {
              ...preset.mappings[name]?.relationships,
              ...structuredClone(rest.relationships),
            },
          };
        }
  }
  return reconcilePermissionDiagnostics(result);
}
