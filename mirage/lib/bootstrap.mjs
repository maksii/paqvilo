import { portalField as field } from "./importer.mjs";
import { bootstrapPresetLibrary } from "./presets.mjs";
import { pluralizeEntitySetName, standardTable } from "./solution-standard.mjs";

/**
 * Export metadata supplies permissions; table identities come from imported solution
 * layers (`metadata` = importSolutionData result) when available, otherwise from the
 * documented Dataverse catalogue or the entity-set pluralization fallback (inferred).
 */
export function initialState(portal, { origin, packs, metadata } = {}) {
  const mappings = {};
  const tables = {};
  const permissions = [];
  const importDiagnostics = [];
  const roles = new Map(
    portal.records
      .filter((r) => r.kind === "webrole")
      .map((r) => [r.id, r.name]),
  );
  const missing = new Set();
  const ensure = (entity) => {
    if (!entity || !/^[a-z][a-z0-9_]*$/i.test(entity)) return;
    entity = entity.toLowerCase();
    if (!mappings[entity]) {
      const imported = metadata?.mappings?.[entity];
      if (imported) {
        const { fieldMetadata: _fields, schemaComplete: _complete, ...mapping } = imported;
        mappings[entity] = structuredClone(mapping);
      } else {
        const standard = standardTable(entity);
        mappings[entity] = {
          entitySet: standard?.entitySet ?? pluralizeEntitySetName(entity),
          entitySetSource: standard ? "dataverse-reference" : "pluralized",
          idColumn: standard?.primaryIdAttribute ?? `${entity}id`,
          idColumnSource: standard ? "dataverse-reference" : "convention",
          ...(standard?.primaryNameAttribute ? { nameColumn: standard.primaryNameAttribute } : {}),
          relationships: {},
          inferred: true,
        };
        if (metadata?.mappings) missing.add(entity);
      }
    }
    tables[entity] ??= [];
  };
  for (const record of portal.records.filter(
    (r) =>
      r.kind === "tablepermission" && Number(field(r, "statecode", 0)) !== 1,
  )) {
    const entity = field(record, "entitylogicalname");
    ensure(entity);
    if (!entity || !/^[a-z][a-z0-9_]*$/i.test(entity)) {
      importDiagnostics.push({
        code: "PERMISSION_ENTITY_UNRESOLVED",
        id: record.id,
        message:
          "Exported table permission has no valid entity logical name and cannot be activated.",
      });
      continue;
    }
    const scope = {
      756150000: "global",
      756150001: "contact",
      756150002: "account",
      756150003: "parent",
      756150004: "self",
    }[field(record, "scope")];
    const relationshipName = field(
      record,
      "contactrelationship",
      field(record, "accountrelationship", field(record, "parentrelationship")),
    );
    const exportedRoles = field(record, "entitypermission_webrole", []) || [];
    const roleIds = Array.isArray(exportedRoles)
      ? exportedRoles
      : [exportedRoles];
    const resolvedRoles = roleIds
      .map((value) =>
        typeof value === "object"
          ? (value.id ?? value.adx_webroleid ?? value.mspp_webroleid)
          : value,
      )
      .filter(Boolean)
      .map(
        (id) => roles.get(String(id).replace(/[{}]/g, "").toLowerCase()) || id,
      );
    const unresolved =
      !scope ||
      ["contact", "account", "parent"].includes(scope) ||
      !resolvedRoles.length;
    const disabledReason = !scope
      ? "The exported permission scope is unknown."
      : ["contact", "account", "parent"].includes(scope)
        ? "The export contains a relationship schema name but does not contain its Dataverse from/to column mapping. Configure field or relationship before enabling."
        : !resolvedRoles.length
          ? "No associated web role was exported; granting all users would broaden access."
          : null;
    const permission = {
      id: record.id || field(record, "entitypermissionid"),
      name: field(record, "entityname", record.name),
      entity,
      roles: resolvedRoles,
      operations: [
        ["read", "read"],
        ["create", "create"],
        ["write", "update"],
        ["delete", "delete"],
      ]
        .filter(
          ([source]) =>
            field(record, source, false) === true ||
            field(record, source, false) === 1,
        )
        .map(([, operation]) => operation),
      scope: scope || "unresolved",
      enabled: !unresolved,
      relationshipName,
      parentPermissionId: field(record, "parententitypermission"),
      imported: true,
      ...(disabledReason ? { disabledReason } : {}),
    };
    permissions.push(permission);
    if (unresolved)
      importDiagnostics.push({
        code: "PERMISSION_MAPPING_REQUIRED",
        id: permission.id,
        entity,
        message: disabledReason,
      });
  }
  for (const template of new Set(Object.values(portal.templates)))
    for (const match of template.source.matchAll(
      /<(?:entity|link-entity)\b[^>]*\bname\s*=\s*["']([\w]+)["']/gi,
    ))
      ensure(match[1]);
  for (const form of [...portal.forms, ...portal.lists])
    ensure(form.entityName);
  for (const [name, value] of Object.entries(portal.settings ?? {})) {
    const table = /^Webapi\/([a-z][a-z0-9_]*)\/enabled$/i.exec(name)?.[1];
    if (table && String(value).toLowerCase() === "true") ensure(table);
  }
  for (const entity of [...missing].sort())
    importDiagnostics.push({
      code: "TABLE_METADATA_MISSING",
      entity,
      entitySet: mappings[entity].entitySet,
      message:
        "The portal references this table, but no selected solution layer defines it; its entity set and primary key use the documented Dataverse catalogue or the pluralization fallback.",
    });
  const anonymous = portal.records
    .filter(
      (r) => r.kind === "webrole" && field(r, "anonymoususersrole", false),
    )
    .map((r) => r.name);
  const state = {
    version: 1,
    mappings,
    tables,
    permissions,
    plugins: [],
    presets: {},
    settings: { permissionMode: "enforce" },
    simulator: {
      mode: "local",
      pageMode: "local",
      identity: { id: null, name: "Anonymous", roles: anonymous },
      live: { origin: origin || null, allowWrites: false },
      endpoints: [],
      componentSchemas: {},
      externalAssets: false,
      externalFrameOrigins: [],
      importDiagnostics,
    },
  };
  // Generic empty tables plus every matching data-pack preset (lazy bodies
  // layered over the imported mappings/tables); see lib/presets.mjs.
  state.presets = bootstrapPresetLibrary({
    portal,
    metadata,
    mappings,
    tables,
    ...(packs ? { packs } : {}),
  });
  return state;
}
