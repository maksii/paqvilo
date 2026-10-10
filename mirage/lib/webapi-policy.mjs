import { parseFetchXml, DataError } from "./data.mjs";
import { portalField } from "./importer.mjs";
import { planFetch } from "./fetchxml-engine.mjs";
import { fieldKind } from "./dataverse-values.mjs";
import {
  applyPaths,
  expressionPaths,
  parseApply,
  parseExpand,
  parseODataExpression,
  parseOrderBy,
} from "./odata-query.mjs";

const denied = (message, code = "WebApiFieldNotEnabled", status = 403, details) => {
  throw new DataError(message, status, code, details);
};
// Power Pages Web API error text (web-api-http-requests-handle-errors):
// 90040101 AttributePermissionIsMissing and 9004010C ResourceDoesNotExists.
const notEnabled = (column, table, code = "WebApiFieldNotEnabled") =>
  denied(`Attribute ${column} in table ${table} is not enabled for Web Api.`, code, 403, {
    attribute: column,
    table,
  });

/**
 * Configuration tables the portals Web API never serves, whatever the site
 * settings say (web-api-overview: "Unsupported configuration tables").
 */
export const WEBAPI_UNSUPPORTED_TABLES = new Set([
  "adx_contentaccesslevel", "adx_contentsnippet", "adx_entityform", "adx_entityformmetadata",
  "adx_entitylist", "adx_entitypermission", "adx_entitypermission_webrole", "adx_externalidentity",
  "adx_pagealert", "adx_pagenotification", "adx_pagetag", "adx_pagetag_webpage", "adx_pagetemplate",
  "adx_portallanguage", "adx_publishingstate", "adx_publishingstatetransitionrule",
  "adx_publishingstatetransitionrule_webrole", "adx_redirect", "adx_setting", "adx_shortcut",
  "adx_sitemarker", "adx_sitesetting", "adx_urlhistory", "adx_webfile", "adx_webfilelog",
  "adx_webform", "adx_webformmetadata", "adx_webformsession", "adx_webformstep", "adx_weblink",
  "adx_weblinkset", "adx_webnotificationentity", "adx_webnotificationurl", "adx_webpage",
  "adx_webpage_tag", "adx_webpageaccesscontrolrule", "adx_webpageaccesscontrolrule_webrole",
  "adx_webpagehistory", "adx_webpagelog", "adx_webrole_systemuser", "adx_website",
  "adx_website_list", "adx_website_sponsor", "adx_websiteaccess", "adx_websiteaccess_webrole",
  "adx_websitebinding", "adx_websitelanguage", "adx_webtemplate",
]);

/**
 * Power Pages tables that exist in every Dataverse environment, by entity set name
 * (Learn, "Enhanced data model": the system tables "present in all Dataverse
 * environments" and the virtual tables of the Power Pages Management app, "installed by
 * default on all instances of Microsoft Dataverse"). Entity set names are the logical
 * names with "s" (mspp_websiteaccesses), as the Dataverse table reference lists them.
 * A request for one that the local data doesn't hold answers like any table that isn't
 * enabled (observed live: /_api/mspp_webpages, 404 9004010C, segment mspp_webpage).
 */
export const POWER_PAGES_TABLES = new Map(
  [
    "powerpagesite", "powerpagecomponent", "powerpagesitelanguage",
    "mspp_website", "mspp_websitelanguage", "mspp_columnpermission", "mspp_columnpermissionprofile",
    "mspp_contentsnippet", "mspp_entityform", "mspp_entityformmetadata", "mspp_entitylist",
    "mspp_entitypermission", "mspp_pagetemplate", "mspp_pollplacement", "mspp_publishingstate",
    "mspp_publishingstatetransitionrule", "mspp_redirect", "mspp_shortcut", "mspp_sitemarker",
    "mspp_sitesetting", "mspp_webfile", "mspp_webform", "mspp_webformmetadata", "mspp_webformstep",
    "mspp_weblink", "mspp_weblinkset", "mspp_webpage", "mspp_webpageaccesscontrolrule", "mspp_webrole",
    "mspp_websiteaccess", "mspp_webtemplate",
  ].map((logical) => [logical === "mspp_websiteaccess" ? "mspp_websiteaccesses" : `${logical}s`, logical]),
);

/** Site settings apply only to the public Web API, independently of table grants. */
export function webApiPolicy(portal, store, entity) {
  const mapping = store.resolveMapping(entity),
    prefix = `Webapi/${mapping.logicalName}/`,
    settings = portal.settings ?? {};
  if (
    WEBAPI_UNSUPPORTED_TABLES.has(mapping.logicalName) ||
    String(settings[prefix + "enabled"] ?? "false").toLowerCase() !== "true"
  )
    denied(
      `Resource not found for the segment '${mapping.entitySet}'.`,
      "WebApiTableNotEnabled",
      404,
      { segment: mapping.entitySet, table: mapping.logicalName },
    );
  const fields = new Set(
    String(settings[prefix + "fields"] ?? "")
      .split(",")
      .map((field) => field.trim())
      .filter(Boolean),
  );
  if (
    String(settings[prefix + "UseFieldsFromView"] ?? "false").toLowerCase() ===
    "true"
  ) {
    const views = (portal.webApiViews ?? []).filter(
      (view) =>
        view.entity === mapping.logicalName &&
        view.name === "Power Pages Web API Columns",
    );
    if (views.length !== 1 || !views[0].fields?.length)
      denied(
        `Web API system-view columns for ${mapping.logicalName} are missing or ambiguous.`,
        "WebApiColumnsViewUnresolved",
      );
    for (const field of views[0].fields)
      if (field.name && !field.name.includes(".")) {
        fields.add(field.name);
        if (
          ["lookup", "customer", "owner"].includes(
            portal.webApiEntities?.[mapping.logicalName]?.fields?.[field.name]
              ?.dataverseType,
          )
        )
          fields.add(`_${field.name}_value`);
      }
  }
  // An enabled table without a column list allows no columns: every column a
  // request names fails with 90040101 (the primary key stays readable).
  // The `*` value is unsupported on every hosted site from 14 September 2026 unless an
  // admin exemption applies (troubleshoot: migrate-web-api-wildcard), so requests for
  // such a table fail by default. A site with an observed, evidenced exemption
  // (observed.webApiWildcard "exempt") keeps exposing every column.
  if (fields.has("*") && portal.observed?.webApiWildcard !== "exempt")
    denied(
      `Webapi/${mapping.logicalName}/fields uses the deprecated wildcard value (*); requests for this table fail until explicit columns are configured.`,
      "WebApiWildcardDeprecated",
      403,
      { table: mapping.logicalName },
    );
  const writeFields = new Set(fields);
  // Dataverse exposes enabled lookup columns as _<logical-name>_value on reads.
  // Resolve from imported field/relationship metadata instead of allowing arbitrary aliases.
  for (const field of fields)
    if (
      ["lookup", "customer", "owner"].includes(
        portal.webApiEntities?.[mapping.logicalName]?.fields?.[field]
          ?.dataverseType,
      ) ||
      Object.values(mapping.relationships ?? {}).some(
        (relationship) =>
          relationship.from === field && relationship.many !== true,
      )
    )
      fields.add(`_${field}_value`);
  // Exported settings can name the OData lookup alias. Its proven logical
  // column remains the same read/expand permission, never an arbitrary alias.
  for (const field of fields) {
    const match = /^_(.+)_value$/.exec(field);
    if (
      match &&
      (["lookup", "customer", "owner"].includes(
        portal.webApiEntities?.[mapping.logicalName]?.fields?.[match[1]]
          ?.dataverseType,
      ) ||
        Object.values(mapping.relationships ?? {}).some(
          (relationship) =>
            relationship.from === match[1] && relationship.many !== true,
        ))
    )
      fields.add(match[1]);
  }
  const identity =
      portal.webApiIdentity ?? store.snapshot().simulator?.identity ?? {},
    roleIds = new Set(
      (identity.roleIds ?? []).map((value) =>
        String(value).replace(/[{}]/g, "").toLowerCase(),
      ),
    );
  if (identity.roleSource !== "memberships")
    for (const role of portal.records ?? [])
      if (role.kind === "webrole" && (identity.roles ?? []).includes(role.name))
        roleIds.add(role.id);
  const roleValues = (value) => (Array.isArray(value) ? value : [value]);
  const profiles = (portal.records ?? []).filter(
    (record) =>
      Number(portalField(record, "statecode", 0)) !== 1 &&
      portalField(record, "tablename") === mapping.logicalName &&
      roleValues(
        portalField(record, "columnpermissionprofile_webrole", []),
      ).some((value) =>
        roleIds.has(
          String(value?.id ?? value)
            .replace(/[{}]/g, "")
            .toLowerCase(),
        ),
      ),
  );
  const operationValue = {
      create: 746610000,
      read: 746610001,
      update: 746610002,
    },
    values = (value) =>
      Array.isArray(value)
        ? value.map(Number)
        : String(value ?? "")
            .split(",")
            .filter(Boolean)
            .map(Number);
  const columnAllowed = (name, operation) => {
    if (!profiles.length || (name === mapping.idColumn && operation === "read"))
      return true;
    const physical =
      mapping.relationships?.[name]?.from ??
      (/^_.*_value$/.test(name) ? name.slice(1, -6) : name);
    return profiles.some((profile) => {
      const permissions = (portal.records ?? []).filter(
        (record) =>
          Number(portalField(record, "statecode", 0)) !== 1 &&
          String(portalField(record, "columnpermissionprofileid"))
            .replace(/[{}]/g, "")
            .toLowerCase() === profile.id &&
          portalField(record, "columnname") === physical,
      );
      if (permissions.length)
        return permissions.some((record) =>
          values(portalField(record, "permissions")).includes(
            operationValue[operation],
          ),
        );
      // Optional empty All Column Permissions retains table-level operations for
      // unspecified columns; explicit child columns remain independently restricted.
      // MicrosoftDocs July 2026 examples document this default (see README evidence).
      const defaults = values(portalField(profile, "allcolumnpermissions"));
      return (
        defaults.length === 0 || defaults.includes(operationValue[operation])
      );
    });
  };
  const enabled = (name, configured) =>
    configured.has("*") ||
    configured.has(name) ||
    Boolean(
      mapping.relationships?.[name]?.from &&
      configured.has(mapping.relationships[name].from),
    );
  const reserved = (name) => {
    const logical = String(name).replace(/@odata\.bind$/, "");
    const physical =
      mapping.relationships?.[logical]?.from ??
      (/^_.*_value$/.test(logical) ? logical.slice(1, -6) : logical);
    return /^__sim/i.test(logical) || /^__sim/i.test(physical);
  };
  const allowed = (name) =>
    !reserved(name) &&
    (name === mapping.idColumn || enabled(name, fields)) &&
    columnAllowed(name, "read");
  // Power Pages answers 400 InvalidAttribute (90040100) for a column the table
  // doesn't have and 403 AttributePermissionIsMissing (90040101) for a real but
  // disallowed column. A column is known from field metadata, relationships,
  // the configured allow-list or (unless the mapping declares schemaComplete)
  // any locally stored row; an identifier none of them know is not a column.
  const metadataFields = [
    mapping.fields,
    mapping.fieldMetadata,
    portal.webApiEntities?.[mapping.logicalName]?.fields,
  ].filter((value) => value && typeof value === "object");
  const hasField = (name) =>
    metadataFields.some(
      (definitions) =>
        Object.hasOwn(definitions, name) ||
        Object.keys(definitions).some((key) => key.toLowerCase() === name.toLowerCase()),
    );
  let dataColumns = null;
  const storedColumn = (name) => {
    if (!dataColumns) {
      dataColumns = new Set();
      for (const row of store.tableRows?.(mapping.logicalName) ?? store.state?.tables?.[mapping.logicalName] ?? [])
        for (const key of Object.keys(row)) dataColumns.add(key);
    }
    return dataColumns.has(name);
  };
  const assertExists = (name, { write = false } = {}) => {
    const column = String(name).replace(/@odata\.bind$/, "");
    const physical = relation(column)?.from ?? (/^_.*_value$/.test(column) ? column.slice(1, -6) : column);
    let known =
      column === mapping.idColumn ||
      hasField(column) ||
      hasField(physical) ||
      Boolean(relation(column)) ||
      Object.values(mapping.relationships ?? {}).some((item) => item.from === physical);
    if (!known && mapping.schemaComplete !== true) {
      // A wildcard allow-list can't prove that a written column is absent:
      // the first row written to an empty table introduces its columns.
      if (write && fields.has("*")) return;
      known =
        fields.has(column) ||
        fields.has(physical) ||
        fields.has(`_${physical}_value`) ||
        writeFields.has(physical) ||
        writeFields.has(`_${physical}_value`) ||
        storedColumn(column) ||
        storedColumn(physical);
    }
    if (!known)
      throw new DataError(
        `Attribute ${column} cannot be found for table ${mapping.logicalName}.`,
        400,
        "InvalidAttribute",
        { attribute: column, table: mapping.logicalName },
      );
  };
  const assert = (name) => {
    if (reserved(name))
      denied(
        "Private simulator columns are not available through the public Web API.",
        "WebApiPrivateField",
        403,
        { attribute: name, table: mapping.logicalName },
      );
    assertExists(name);
    if (!allowed(name)) notEnabled(name, mapping.logicalName);
  };
  const relation = (name) => mapping.relationships?.[name];
  // A path segment before "/" must be a navigation property; the platform answers
  // a path through a lookup column (for example x_listid/x_listextid) with 400 9004010A.
  const notNavigation = (name) =>
    new DataError(`${name} is not a navigation property of ${mapping.logicalName}.`, 400, "MissingRelationship", {
      attribute: name,
      table: mapping.logicalName,
    });
  const path = (name) => {
    const [first, ...rest] = Array.isArray(name) ? name : String(name).split("/");
    if (rest.length) {
      const rel = relation(first);
      if (!rel) throw notNavigation(first);
      assert(first);
      return webApiPolicy(portal, store, rel.entity).assertPath(rest);
    }
    assert(first);
  };
  // Lookup columns are read through _<name>_value; selecting the logical name
  // (or a navigation property) is a malformed query on the platform (400 9004010A).
  const definitionOf = (name) => {
    for (const definitions of metadataFields) {
      const key = Object.hasOwn(definitions, name)
        ? name
        : Object.keys(definitions).find((item) => item.toLowerCase() === name.toLowerCase());
      if (key !== undefined) return definitions[key];
    }
    return undefined;
  };
  const lookupColumn = (name) =>
    name !== mapping.idColumn &&
    !/^_.+_value$/.test(name) &&
    (Boolean(relation(name)) ||
      fieldKind(definitionOf(name)) === "lookup" ||
      Object.values(mapping.relationships ?? {}).some((item) => item.many === false && item.from === name));
  // Every column a query reads must be enabled, including navigation paths,
  // lambda bodies, Dataverse query function PropertyName values and $apply.
  const query = (params, inheritedAliases) => {
    const aliases =
      inheritedAliases ??
      Object.fromEntries([...params.entries()].filter(([key]) => key.startsWith("@")));
    for (const field of (params.get("$select") ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)) {
      if (!reserved(field) && lookupColumn(field))
        throw new DataError(`Select _${field}_value instead of the lookup or navigation property ${field}.`, 400, "InvalidAttribute", {
          attribute: field,
          table: mapping.logicalName,
        });
      path(field);
    }
    for (const spec of parseOrderBy(params.get("$orderby"), { dialect: "dataverse" }))
      path(spec.path);
    const filter = params.get("$filter");
    if (filter)
      for (const segments of expressionPaths(
        parseODataExpression(filter, { dialect: "dataverse", aliases }),
      ))
        path(segments);
    const apply = params.get("$apply");
    if (apply)
      for (const segments of applyPaths(parseApply(apply, { dialect: "dataverse", aliases })))
        path(segments);
    for (const spec of parseExpand(params.get("$expand"))) expand(spec, aliases);
  };
  const expand = (spec, aliases) => {
    const rel = relation(spec.navigation);
    if (!rel) throw notNavigation(spec.navigation);
    // A single-valued navigation reads the lookup column, which must be listed.
    // A collection-valued one has no column on this table: the related table's
    // settings govern it (Example expands powerpagecomponent_mspp_webrole_contact
    // without listing it on contact).
    if (rel.many === false) assert(spec.navigation);
    else if (reserved(spec.navigation))
      denied("Private simulator columns are not available through the public Web API.", "WebApiPrivateField", 403, {
        attribute: spec.navigation,
        table: mapping.logicalName,
      });
    const nested = new URLSearchParams();
    for (const key of ["select", "filter", "orderby", "top"])
      if (spec[key] != null) nested.set(`$${key}`, spec[key]);
    const target = webApiPolicy(portal, store, rel.entity);
    target.assertQuery(nested, aliases);
    for (const child of spec.expand ?? []) target.assertExpand(child, aliases);
  };
  // @odata.bind names a single-valued navigation property exactly: navigation names are
  // case-sensitive (webapi/web-api-navigation-properties) and a lookup's logical name is not
  // one (troubleshoot web-api-client-errors, 0x80048d19 for parentcustomerid@odata.bind;
  // Microsoft's Power Pages samples: "Web API binds are case-sensitive, so binding to
  // sample_contact@odata.bind fails"). A column, or a navigation property in another case,
  // is rejected before any column check, like the malformed OData the portal answers with
  // 9004010A; a name the table doesn't have stays InvalidAttribute (90040100, assertExists).
  const assertBindNavigation = (navigation) => {
    if (relation(navigation)) return;
    const lower = navigation.toLowerCase();
    const candidates = Object.entries(mapping.relationships ?? {})
      .filter(([key, item]) => item.many === false && (key.toLowerCase() === lower || String(item.from ?? "").toLowerCase() === lower))
      .map(([key]) => key);
    if (!candidates.length && !hasField(navigation)) return;
    throw new DataError(
      `${navigation}@odata.bind doesn't name a navigation property of ${mapping.logicalName}; navigation property names are case-sensitive${candidates.length ? ` (did you mean ${candidates.join(" or ")}?)` : ""}.`,
      400,
      "UndeclaredNavigationProperty",
      { attribute: navigation, table: mapping.logicalName, phase: "payload" },
    );
  };
  const write = (body, operation = "update") => {
    for (const [name, value] of Object.entries(body)) {
      const column = name.replace(/@odata\.bind$/, "");
      if (reserved(column))
        denied(
          "Private simulator columns cannot be written through the public Web API.",
          "WebApiPrivateField",
        );
      if (name.endsWith("@odata.bind")) assertBindNavigation(column);
      assertExists(column, { write: true });
      if (!enabled(column, writeFields)) notEnabled(column, mapping.logicalName);
      if (!columnAllowed(column, operation))
        denied(
          `Column permission denies ${operation} on ${mapping.logicalName}.${column}.`,
          "WebApiColumnPermissionDenied",
          403,
          { attribute: column, table: mapping.logicalName, operation },
        );
      const rel = relation(column);
      if (
        rel &&
        !name.endsWith("@odata.bind") &&
        value &&
        typeof value === "object"
      ) {
        const target = webApiPolicy(portal, store, rel.entity);
        for (const row of Array.isArray(value) ? value : [value])
          target.assertWrite(row, operation);
      }
    }
  };
  // Dataverse ignores values invalid for this operation; portal field and
  // column permissions still apply before those immutable values are omitted.
  // https://learn.microsoft.com/power-apps/developer/data-platform/entity-attribute-metadata
  const prepareWrite = (body, operation = "update") => {
    write(body, operation);
    const definitions =
      portal.webApiEntities?.[mapping.logicalName]?.fields ??
      mapping.fields ??
      mapping.fieldMetadata ??
      {};
    const result = {};
    for (const [name, value] of Object.entries(body)) {
      const column = name.replace(/@odata\.bind$/, "");
      const rel = relation(column);
      const physical =
        rel?.from ??
        (/^_.*_value$/.test(column) ? column.slice(1, -6) : column);
      const definition =
        definitions[physical] ??
        definitions[
          Object.keys(definitions).find(
            (key) => key.toLowerCase() === physical.toLowerCase(),
          )
        ];
      if (
        rel?.many !== true &&
        (operation === "create"
          ? definition?.validForCreate
          : definition?.validForUpdate) === false
      )
        continue;
      result[name] =
        rel &&
        !name.endsWith("@odata.bind") &&
        value &&
        typeof value === "object"
          ? Array.isArray(value)
            ? value.map((row) =>
                webApiPolicy(portal, store, rel.entity).prepareWrite(
                  row,
                  operation,
                ),
              )
            : webApiPolicy(portal, store, rel.entity).prepareWrite(
                value,
                operation,
              )
          : value;
    }
    return result;
  };
  const project = (row) => {
    if (Array.isArray(row)) return row.map(project);
    if (!row || typeof row !== "object") return row;
    const result = {};
    for (const [name, value] of Object.entries(row)) {
      // Control information (@odata.etag and similar) is not a column.
      if (name.startsWith("@")) {
        result[name] = value;
        continue;
      }
      const column = name.split("@")[0];
      const rel = relation(column);
      // An expanded collection-valued navigation is projected by its own table.
      if (rel && rel.many !== false && name === column && value && typeof value === "object" && !reserved(column)) {
        result[name] = webApiPolicy(portal, store, rel.entity).project(value);
        continue;
      }
      if (!allowed(column)) continue;
      result[name] =
        rel && value && typeof value === "object"
          ? webApiPolicy(portal, store, rel.entity).project(value)
          : value;
    }
    return result;
  };
  return {
    mapping,
    fields: [...fields],
    allowed,
    assert,
    assertPath: path,
    assertQuery: query,
    assertExpand: expand,
    assertWrite: write,
    prepareWrite,
    project,
  };
}

/** Validate every FetchXML table/column and project aliased output explicitly. */
export function webApiFetchPolicy(portal, store, xml, rootEntity) {
  const root = parseFetchXml(xml),
    // Aliases follow the evaluator: explicit alias, else {name}{N} where N is
    // the link's position among all link-entity elements in document order.
    plan = planFetch(root, { profile: "webapi" }),
    aliases = new Map(),
    attributeAliases = new Set(),
    nodePolicies = new Map(),
    rootMapping = store.resolveMapping(rootEntity);
  const nodePolicy = (node, parent) => {
    const links = node.children.filter((child) => child.name === "link-entity");
    const relationship =
      node.name === "link-entity" &&
      parent &&
      !node.children.some((child) =>
        ["attribute", "all-attributes"].includes(child.name),
      )
        ? Object.values(
            store.resolveMapping(parent.attrs.name).relationships ?? {},
          ).find(
            (rel) =>
              rel.intersect?.entity === node.attrs.name &&
              rel.intersect.from === node.attrs.from &&
              rel.from === node.attrs.to &&
              links.every(
                (link) =>
                  link.attrs.name === rel.entity &&
                  link.attrs.from === rel.to &&
                  link.attrs.to === rel.intersect.to,
              ),
          )
        : null;
    if (relationship) {
      const columns = new Set([
        relationship.intersect.from,
        relationship.intersect.to,
      ]);
      const mapping = store.resolveMapping(node.attrs.name);
      columns.add(mapping.idColumn);
      return {
        mapping,
        allowed: () => false,
        assert: (name) => {
          if (!columns.has(name))
            notEnabled(name, node.attrs.name);
        },
      };
    }
    return webApiPolicy(portal, store, node.attrs.name);
  };
  function collect(node, parent) {
    if (["entity", "link-entity"].includes(node.name)) {
      const policy = nodePolicy(node, parent);
      nodePolicies.set(node, policy);
      if (node.name === "link-entity") aliases.set(plan.aliasOf.get(node), policy);
      else aliases.set(null, policy);
      parent = node;
    }
    for (const child of node.children ?? []) collect(child, parent);
  }
  collect(root);
  const policyFor = (entityname, fallback) => {
    if (entityname == null) return fallback;
    const link = plan.byAlias.get(entityname) ?? plan.byName.get(entityname);
    const policy = link ? aliases.get(plan.aliasOf.get(link)) : entityname === rootMapping.logicalName ? aliases.get(null) : null;
    // Dataverse QueryBuilderAlias_Does_Not_Exist: a malformed query (400).
    if (!policy)
      throw new DataError(
        "The specified alias for the given entity in the condition does not exist.",
        400,
        "InvalidFetchXml",
        { innerCode: "0x8004110a", alias: entityname },
      );
    return policy;
  };
  const assertCondition = (node, owner) => {
    const policy = policyFor(node.attrs.entityname, owner);
    policy.assert(node.attrs.attribute);
    if (node.name === "condition" && node.attrs.valueof) {
      const [other, column] = node.attrs.valueof.includes(".")
        ? node.attrs.valueof.split(".", 2)
        : [node.attrs.entityname, node.attrs.valueof];
      policyFor(other, owner).assert(column);
    }
  };
  function walk(node, parent) {
    if (["entity", "link-entity"].includes(node.name)) {
      const policy = nodePolicies.get(node);
      if (!parent && policy.mapping.logicalName !== rootMapping.logicalName)
        // A malformed request for Dataverse (400), not a column denial.
        throw new DataError(
          "The entity name in the FetchXML query doesn't match the entity set of the request.",
          400,
          "WebApiFetchEntityMismatch",
          { innerCode: "0x80040203" },
        );
      if (node.attrs.from) policy.assert(node.attrs.from);
      if (node.attrs.to && parent) parent.assert(node.attrs.to);
      for (const child of node.children) {
        if (child.name === "attribute") {
          policy.assert(child.attrs.name);
          if (child.attrs.alias) attributeAliases.add(child.attrs.alias);
        }
        if (["condition", "order"].includes(child.name) && child.attrs.attribute)
          assertCondition(child, policy);
        walk(child, policy);
      }
    } else {
      for (const child of node.children ?? []) {
        if (["condition", "order"].includes(child.name) && child.attrs.attribute)
          assertCondition(child, parent);
        walk(child, parent);
      }
    }
  }
  walk(root, null);
  const policy = webApiPolicy(portal, store, rootEntity);
  return (row) => {
    const out = policy.project(row);
    for (const [name, value] of Object.entries(row)) {
      const clean = name.split("@")[0],
        dot = clean.indexOf(".");
      if (
        dot > 0 &&
        aliases.get(clean.slice(0, dot))?.allowed(clean.slice(dot + 1))
      )
        out[name] = value;
      else if (dot < 0 && attributeAliases.has(clean)) out[name] = value;
    }
    return out;
  };
}
