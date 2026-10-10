import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { DataError } from "./data.mjs";
import { normalizePortalPath, portalField } from "./importer.mjs";
import { siteSetting } from "./redirects.mjs";
import { contextualViewFetchXml, renderQuickForm } from "./platform.mjs";
import { handleImplicitGrant } from "./auth-token.mjs";
import { handleODataFeed } from "./odata-feeds.mjs";
import { platformBundleFor, localAspNetScript } from "./platform-manifest.mjs";
import {
  subgridSettings,
  subgridActionApplies,
  subgridActionUrl,
  deletePortalSubgridRecord,
} from "./subgrid-actions.mjs";

/*
 * Local equivalents of the native Power Pages grid, lookup, subgrid, notes and
 * annotation services. Contracts follow live reference-portal observations (see
 * docs/forms-lists-parity.md): POST bodies use camelCase, responses PascalCase,
 * the anti-forgery header is __RequestVerificationToken and the opaque
 * Base64SecureConfiguration is issued by the server and verified here.
 */

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const canonical = (value) =>
  String(value ?? "")
    .replace(/[{}]/g, "")
    .toLowerCase();
const fail = (message, status = 400, code = "InvalidRequest") => {
  throw new DataError(message, status, code);
};
const scalar = (value) =>
  value && typeof value === "object" ? (value.id ?? value.value) : value;
const safeName = (value) => /^[a-z_][a-z0-9_]*$/i.test(String(value ?? ""));
const xmlEscape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[
        c
      ],
  );
const xmlDecode = (value) =>
  String(value ?? "").replace(
    /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
    (_, entity) =>
      entity[0] === "#"
        ? String.fromCodePoint(
            entity[1].toLowerCase() === "x"
              ? parseInt(entity.slice(2), 16)
              : Number(entity.slice(1)),
          )
        : { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[
            entity.toLowerCase()
          ],
  );

/** Localised PAC values are either plain text or [{LCID, Value}] JSON. */
export function localizedText(value, fallback = "", lcid = 1033) {
  if (value == null || value === "") return fallback;
  if (Array.isArray(value))
    return (
      (value.find((v) => Number(v?.LCID) === Number(lcid)) ?? value[0])
        ?.Value || fallback
    );
  if (typeof value === "string" && /^\s*\[\s*\{/.test(value)) {
    try {
      return localizedText(JSON.parse(value), fallback, lcid);
    } catch {
      return value;
    }
  }
  return typeof value === "string" ? value : fallback;
}

// ---------------------------------------------------------------------------
// Minimal FetchXML tree (parse, edit and serialize without guessing by regex).

export function parseFetchTree(source) {
  if (/<!DOCTYPE|<!ENTITY/i.test(source))
    fail("FetchXML declarations are not supported", 400, "UnsupportedQuery");
  const root = { name: "#document", attrs: {}, children: [], text: "" };
  const stack = [root];
  for (const token of String(source).match(
    /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<[^>]+>|[^<]+/g,
  ) ?? []) {
    if (token.startsWith("<!--") || token.startsWith("<?")) continue;
    if (token.startsWith("</")) {
      const name = token.slice(2, -1).trim();
      if (stack.length === 1 || stack.pop().name !== name)
        fail("Malformed FetchXML closing element", 400, "UnsupportedQuery");
      continue;
    }
    if (token.startsWith("<")) {
      const match = /^<([\w:.-]+)([\s\S]*?)(\/?)\s*>$/.exec(token);
      if (!match) fail("Malformed FetchXML element", 400, "UnsupportedQuery");
      const attrs = {};
      for (const attr of match[2].matchAll(/([\w:.-]+)\s*=\s*(["'])([\s\S]*?)\2/g))
        attrs[attr[1]] = xmlDecode(attr[3]);
      const node = { name: match[1], attrs, children: [], text: "" };
      stack.at(-1).children.push(node);
      if (!match[3]) stack.push(node);
    } else stack.at(-1).text += xmlDecode(token);
  }
  if (stack.length !== 1 || root.children.length !== 1)
    fail("One complete FetchXML root is required", 400, "UnsupportedQuery");
  return root.children[0];
}

export function serializeFetchTree(node) {
  const attrs = Object.entries(node.attrs)
    .filter(([, value]) => value != null)
    .map(([key, value]) => ` ${key}="${xmlEscape(value)}"`)
    .join("");
  const text = node.text?.trim() ? xmlEscape(node.text.trim()) : "";
  const inner = text + node.children.map(serializeFetchTree).join("");
  return inner
    ? `<${node.name}${attrs}>${inner}</${node.name}>`
    : `<${node.name}${attrs}/>`;
}

const childNodes = (node, name) =>
  (node?.children ?? []).filter((child) => child.name === name);
const rootEntity = (fetch) => {
  const entity = childNodes(fetch, "entity")[0];
  if (!entity) fail("FetchXML requires one entity", 400, "UnsupportedQuery");
  return entity;
};
const linkAliases = (node, out = new Map()) => {
  for (const link of childNodes(node, "link-entity")) {
    if (link.attrs.alias) out.set(link.attrs.alias, link);
    linkAliases(link, out);
  }
  return out;
};

// ---------------------------------------------------------------------------
// Opaque configuration. Native Power Pages protects the serialized view
// configuration with its machine key; locally an HMAC with a process key binds
// the identifiers that the server re-resolves from the selected sources.

const CONFIGURATION_KEY = randomBytes(32);
export function protectConfiguration(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", CONFIGURATION_KEY)
    .update(body)
    .digest("base64url");
  return Buffer.from(`${body}.${mac}`).toString("base64");
}
export function unprotectConfiguration(token) {
  if (typeof token !== "string" || !token || token.length > 16384)
    fail("Invalid_Request", 403, "Invalid_Request");
  let text;
  try {
    text = Buffer.from(token, "base64").toString("utf8");
  } catch {
    fail("Invalid_Request", 403, "Invalid_Request");
  }
  const [body, mac] = text.split(".");
  if (!body || !mac) fail("Invalid_Request", 403, "Invalid_Request");
  const expected = createHmac("sha256", CONFIGURATION_KEY)
    .update(body)
    .digest();
  let supplied;
  try {
    supplied = Buffer.from(mac, "base64url");
  } catch {
    fail("Invalid_Request", 403, "Invalid_Request");
  }
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  )
    fail("Invalid_Request", 403, "Invalid_Request");
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    fail("Invalid_Request", 403, "Invalid_Request");
  }
}

// ---------------------------------------------------------------------------
// Metadata resolution shared by server rendering and the data services.

const ACTION_TYPES = {
  "CrmEntityFormView-DetailsAction": 1,
  "CrmEntityFormView-EditAction": 2,
  "CrmEntityFormView-CreateAction": 3,
  "CrmEntityFormView-DeleteAction": 4,
  "CrmEntityFormView-AssociateAction": 5,
  "CrmEntityFormView-DisassociateAction": 6,
  "CrmEntityFormView-WorkflowAction": 7,
  "CrmEntityFormView-DownloadAction": 8,
  DeactivateAction: 17,
  ActivateAction: 18,
  "CrmEntityFormView-CreateRelatedRecordAction": 29,
};
export const ACTION_TYPE = Object.freeze({
  Details: 1,
  Edit: 2,
  Insert: 3,
  Delete: 4,
  Associate: 5,
  Disassociate: 6,
  Workflow: 7,
  Download: 8,
  Deactivate: 17,
  Activate: 18,
  CreateRelatedRecord: 29,
});

export function settingsJson(value, label = "settings") {
  if (value == null || value === "") return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    fail(`Grid ${label} JSON is malformed`, 501, "GRID_SETTINGS_INVALID");
  }
}

function solutionView(metadata, viewId, entity) {
  const id = canonical(viewId);
  if (!id) return null;
  return (
    (metadata?.views ?? []).find(
      (view) => view.id === id && (!entity || view.entity === canonical(entity)),
    ) ?? null
  );
}

function entityFields(metadata, entity) {
  return metadata?.entities?.[canonical(entity)]?.fields ?? {};
}

function viewOrders(fetch) {
  const entity = rootEntity(fetch);
  const parts = [];
  const visit = (node, alias) => {
    for (const order of childNodes(node, "order"))
      if (order.attrs.attribute)
        parts.push(
          `${alias ? alias + "." : ""}${order.attrs.attribute} ${order.attrs.descending === "true" ? "DESC" : "ASC"}`,
        );
    for (const link of childNodes(node, "link-entity"))
      visit(link, link.attrs.alias);
  };
  visit(entity, null);
  return parts.join(",");
}

/** Column metadata for a layout cell, including linked-table aliases. */
function columnMetadata(metadata, entity, fetch, name) {
  const [alias, attribute] = name.includes(".") ? name.split(".") : [null, name];
  const linked = alias ? linkAliases(rootEntity(fetch)).get(alias) : null;
  const table = linked?.attrs.name ?? entity;
  const field = entityFields(metadata, table)[canonical(attribute)];
  return { table, attribute, field };
}

const ATTRIBUTE_TYPES = {
  nvarchar: 14,
  string: 14,
  memo: 7,
  ntext: 7,
  int: 5,
  integer: 5,
  bigint: 18,
  decimal: 3,
  float: 4,
  double: 4,
  money: 8,
  bit: 0,
  boolean: 0,
  datetime: 2,
  lookup: 6,
  customer: 1,
  owner: 9,
  picklist: 11,
  state: 12,
  status: 13,
  uniqueidentifier: 15,
  primarykey: 15,
  multiselectpicklist: 16,
};

function compactAttributeMetadata(entity, attribute, field, primaryName) {
  const dataverseType = String(field?.dataverseType ?? "nvarchar").toLowerCase();
  return {
    LogicalName: attribute,
    EntityLogicalName: entity,
    AttributeType: ATTRIBUTE_TYPES[dataverseType] ?? 14,
    AttributeTypeName: { Value: `${dataverseType[0]?.toUpperCase() ?? "S"}${dataverseType.slice(1)}Type` },
    IsPrimaryName: attribute === primaryName,
    IsPrimaryId: dataverseType === "primarykey",
    Format: /email/i.test(field?.format ?? "") ? 0 : null,
    DisplayName: {
      UserLocalizedLabel: { Label: field?.label ?? attribute, LanguageCode: 1033 },
    },
  };
}

function overrideFor(settings, name) {
  return (settings?.ColumnOverrides ?? []).find(
    (column) => (column.AttributeLogicalName ?? column.Name) === name,
  );
}

/** Build the native ViewLayout objects stored in data-view-layouts. */
export function buildLayout({
  view,
  entity,
  idColumn,
  primaryName,
  metadata,
  settings = {},
  configuration,
  secure,
  selectColumn = false,
  actionColumn = false,
}) {
  const fetch = parseFetchTree(view.fetchXml);
  const columns = [];
  if (selectColumn)
    columns.push({
      LogicalName: "col-select",
      Name: "<span class='fa fa-check' aria-hidden='true'></span> <span class='sr-only'>Select</span>",
      Metadata: null,
      Width: 20,
      SortDisabled: true,
      Type: 1,
    });
  for (const cell of view.fields ?? []) {
    if (!cell?.name) continue;
    const override = overrideFor(settings, cell.name);
    const { table, attribute, field } = columnMetadata(
      metadata,
      entity,
      fetch,
      cell.name,
    );
    const width = Number(override?.Width) || Number(cell.width) || 100;
    columns.push({
      LogicalName: cell.name,
      Name: localizedText(override?.DisplayName, field?.label ?? cell.label ?? attribute),
      Metadata: compactAttributeMetadata(table, attribute, field, primaryName),
      Width: width,
      SortDisabled: /^(multiselectpicklist|memo|ntext)$/i.test(
        field?.dataverseType ?? "",
      ),
      Type: 0,
    });
  }
  if (actionColumn)
    columns.push({
      LogicalName: "col-action",
      Name: localizedText(
        settings.ActionColumnHeaderText,
        "<span class='sr-only'>Actions</span>",
      ),
      Metadata: null,
      Width: 20,
      SortDisabled: true,
      Type: 2,
    });
  const total = columns.reduce((sum, column) => sum + column.Width, 0) || 1;
  for (const column of columns)
    column.WidthAsPercent = (column.Width / total) * 100;
  return {
    Configuration: configuration,
    Base64SecureConfiguration: protectConfiguration(secure),
    ViewName: view.name ?? "",
    Columns: columns,
    ColumnsTotalWidth: total,
    SortExpression: viewOrders(fetch),
    Id: view.id,
    EntityName: entity,
    PrimaryKeyName: idColumn,
  };
}

/** Native action link objects (subset of the managed ViewActionLink contract). */
export function actionLinks(settings, { portal, requestUrl, website }) {
  const actions = [];
  for (const [position, list] of [
    ["view", settings?.ViewActions ?? []],
    ["item", settings?.ItemActions ?? []],
  ]) {
    for (const action of list) {
      const type = ACTION_TYPES[action?.Type];
      if (!type) continue;
      const target =
        action.TargetType == null || action.TargetType === ""
          ? action.EntityFormId
            ? 0
            : action.RedirectWebpageId
              ? 1
              : action.RedirectUrl
                ? 2
                : 0
          : Number(action.TargetType);
      let url = null;
      if ((type === 1 || type === 2 || type === 3) && target !== 0) {
        try {
          url = subgridActionUrl(
            { ...action, EntityFormId: target === 0 ? action.EntityFormId : "" },
            { portal, requestUrl },
          );
        } catch {
          url = null;
        }
      }
      const defaults = {
        1: "<span class='fa fa-info-circle' aria-hidden='true'></span> View details",
        2: "<span class='fa fa-edit' aria-hidden='true'></span> Edit",
        3: "Create",
        4: "<span class='fa fa-trash-o' aria-hidden='true'></span> Delete",
        5: "Associate",
        6: "Disassociate",
        7: "Run workflow",
        8: "Download",
        17: "Deactivate",
        18: "Activate",
        29: "Create",
      };
      const label = localizedText(
        action.ButtonLabel ?? action.Label,
        defaults[type],
      );
      actions.push({
        position,
        source: action,
        Type: type,
        Label: label,
        Tooltip: localizedText(action.ButtonTooltip, ""),
        Enabled: true,
        Target: target,
        EntityForm:
          target === 0 && action.EntityFormId
            ? { Id: canonical(action.EntityFormId), LogicalName: "adx_entityform" }
            : null,
        WebPage: action.RedirectWebpageId
          ? { Id: canonical(action.RedirectWebpageId), LogicalName: "adx_webpage" }
          : null,
        URL: url ? { PathWithQueryString: url, Path: url.split("?")[0] } : null,
        QueryStringIdParameterName:
          action.RecordIdQueryStringParameterName || "id",
        ShowModal: Number(action.ShowModal) || 0,
        Confirmation: localizedText(action.Confirmation, ""),
        SuccessMessage: localizedText(action.SuccessMessage, ""),
        OnComplete: Number(action.OnComplete) || 0,
        RedirectUrl: action.RedirectUrl || null,
        ActionIndex: Number(action.ActionIndex) || 0,
        ButtonCssClass: action.ButtonCssClass ?? null,
        FilterCriteria: action.FilterCriteria || null,
        FilterCriteriaId: action.FilterCriteria
          ? createHmac("sha256", CONFIGURATION_KEY)
              .update(String(action.FilterCriteria))
              .digest("hex")
              .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5")
          : "00000000-0000-0000-0000-000000000000",
        ViewId: action.ViewId ? canonical(action.ViewId) : null,
        WebsiteId: website,
      });
    }
  }
  return actions.sort((a, b) => a.ActionIndex - b.ActionIndex);
}

function mappingFor(store, entity) {
  try {
    return store.resolveMapping(entity);
  } catch {
    return { logicalName: entity, idColumn: `${entity}id`, relationships: {} };
  }
}

function primaryNameColumn(store, metadata, entity) {
  const mapping = mappingFor(store, entity);
  if (mapping.nameColumn) return mapping.nameColumn;
  const fields = entityFields(metadata, entity);
  // The metadata primary name, Dataverse's <prefix>_name convention of the
  // table's publisher prefix, then name/fullname.
  const flagged = Object.entries(fields).find(([, definition]) => definition?.isPrimaryName)?.[0];
  const prefix = /^([a-z][a-z0-9]*)_/i.exec(String(entity ?? ""))?.[1];
  return (
    flagged ??
    (prefix && fields[`${prefix}_name`] ? `${prefix}_name` : null) ??
    (fields.name ? "name" : fields.fullname ? "fullname" : null)
  );
}

function listViews(list, metadata) {
  const configured = settingsJson(
    portalField(list.metadata ?? {}, "views", ""),
    "views",
  );
  const ids = (configured.Views ?? [])
    .map((view) => ({
      id: canonical(view.ViewId),
      displayName: localizedText(view.DisplayName, ""),
    }))
    .filter((view) => view.id);
  const fallback = canonical(portalField(list.metadata ?? {}, "view", ""));
  if (!ids.length && fallback) ids.push({ id: fallback, displayName: "" });
  return ids
    .map((entry) => {
      const view = solutionView(metadata, entry.id, list.entityName);
      return view
        ? { ...view, displayName: entry.displayName || view.name }
        : null;
    })
    .filter(Boolean);
}

/** A local view for a list whose savedquery is absent: primary key and primary name. */
function approximateListView(list, metadata, store) {
  const entity = canonical(list.entityName);
  if (!entity) return null;
  let mapping;
  try {
    mapping = mappingFor(store, entity);
  } catch {
    return null;
  }
  const idColumn = mapping.idColumn ?? `${entity}id`;
  const name = primaryNameColumn(store, metadata, entity);
  const columns = [idColumn, name].filter((column, index, all) => column && safeName(column) && all.indexOf(column) === index);
  return {
    id: canonical(portalField(list.metadata ?? {}, "view", "") || list.id),
    entity,
    name: list.name,
    displayName: list.name,
    fetchXml: `<fetch><entity name="${xmlEscape(entity)}">${columns.map((column) => `<attribute name="${xmlEscape(column)}"/>`).join("")}${name && safeName(name) ? `<order attribute="${xmlEscape(name)}"/>` : ""}</entity></fetch>`,
    fields: name && name !== idColumn ? [{ name, label: metadata?.entities?.[entity]?.fields?.[name]?.label ?? name }] : [],
    approximated: true,
  };
}

/** Resolve a list by id/name with its selected solution views and settings. */
/** An explicit (admin or imported) component schema as a list view. */
function schemaView(schema, list, store) {
  const entity = canonical(schema.entity ?? list.entityName);
  const mapping = mappingFor(store, entity);
  let fetchXml = typeof schema.fetchXml === "string" ? schema.fetchXml : "";
  try {
    rootEntity(parseFetchTree(fetchXml));
  } catch {
    const columns = [...new Set([mapping.idColumn, ...(schema.fields ?? []).map((field) => field.name)].filter((name) => safeName(name)))];
    fetchXml = `<fetch><entity name="${xmlEscape(entity)}">${columns.map((name) => `<attribute name="${xmlEscape(name)}"/>`).join("")}</entity></fetch>`;
  }
  return {
    id: canonical(schema.viewId ?? list.id),
    entity,
    name: schema.title ?? list.name,
    fetchXml,
    fields: (schema.fields ?? []).map((field) => ({ name: field.name, width: field.width, label: field.label })),
  };
}

export function listModel({ portal, metadata, store, list, schemas = {} }) {
  const explicit = schemas[list.id] ?? schemas[list.name];
  // Imported savedquery schemas describe the default view (adx_view); the list's
  // adx_views may add more. A manual schema intentionally defines the only view.
  let views = explicit && explicit.source !== "unpacked-savedquery" ? [] : listViews(list, metadata);
  if (!views.length && explicit?.entity) views = [schemaView(explicit, list, store)];
  // The list's savedquery is absent from the configured solutions: approximate its view
  // with the table's primary key and primary name column (reported by the renderer).
  let approximated = false;
  if (!views.length) {
    const approximation = approximateListView(list, metadata, store);
    if (approximation) {
      views = [approximation];
      approximated = true;
    }
  }
  if (!views.length)
    fail(
      `List ${list.name} has no view in the selected solution sources`,
      501,
      "SYSTEMVIEW_UNRESOLVED",
    );
  const mapping = mappingFor(store, list.entityName);
  const m = list.metadata ?? {};
  return {
    kind: "list",
    list,
    approximated,
    entity: canonical(list.entityName),
    idColumn: mapping.idColumn,
    primaryName: primaryNameColumn(store, metadata, list.entityName),
    views,
    settings: settingsJson(portalField(m, "settings", ""), "settings"),
    pageSize: Number(portalField(m, "pagesize", 10)) || 10,
    search: {
      enabled: portalField(m, "searchenabled", false) === true,
      placeholder: localizedText(portalField(m, "searchplaceholdertext", ""), "Search"),
      tooltip: localizedText(
        portalField(m, "searchtooltiptext", ""),
        "To search on partial text, use the asterisk (*) wildcard character.",
      ),
    },
    filter: {
      enabled: portalField(m, "filter_enabled", false) === true,
      vertical: Number(portalField(m, "filter_orientation", 756150000)) === 756150001,
      definition: portalField(m, "filter_definition", "") || "",
      applyLabel: localizedText(portalField(m, "filter_applybuttonlabel", ""), "Apply"),
    },
    userFilters: {
      portalUser: portalField(m, "filterportaluser", null),
      account: portalField(m, "filteraccount", null),
      website: portalField(m, "filterwebsite", null),
    },
    detailsPage: canonical(portalField(m, "webpagefordetailsview", "")),
    createPage: canonical(portalField(m, "webpageforcreate", "")),
    idParameter: portalField(m, "idquerystringparametername", "id") || "id",
    detailsLabel: localizedText(portalField(m, "detailsbuttonlabel", ""), "View details"),
    createLabel: localizedText(portalField(m, "createbuttonlabel", ""), "Create"),
    emptyText: localizedText(portalField(m, "emptylisttext", ""), ""),
  };
}

function formDefinition(portal, kind, formId) {
  return (kind === "webform" ? portal.advancedForms : portal.forms)?.find(
    (form) => canonical(form.id) === canonical(formId),
  );
}

function formSchema(schemas, definition, stepId) {
  let schema = schemas[definition.id] ?? schemas[definition.name];
  if (!schema) fail("Native form layout is unresolved", 501, "FormSchemaRequired");
  if (schema.steps) {
    schema = schema.steps.find(
      (step) => canonical(step.stepId) === canonical(stepId ?? schema.initialStepId),
    );
    if (!schema) fail("Native form step is unresolved", 400, "InvalidFormStep");
  }
  return schema;
}

export const formCells = (schema) =>
  schema?.layout?.flatMap((tab) =>
    tab.columns.flatMap((column) =>
      column.sections.flatMap((section) => section.rows.flat()),
    ),
  ) ?? [];

/** Resolve a form subgrid from its secure identifiers. */
export function subgridModel({ portal, schemas, metadata, store, kind, formId, stepId, gridId }) {
  const definition = formDefinition(portal, kind, formId);
  if (!definition) fail("Native grid form is not exported", 404, "FormNotFound");
  const schema = formSchema(schemas, definition, stepId);
  const cell = formCells(schema).find(
    (candidate) => candidate.type === "subgrid" && candidate.id === gridId,
  );
  if (!cell) fail("Grid is not bound to the exported form", 403, "SubgridNotBound");
  const parentMapping = mappingFor(store, schema.entity);
  const relationshipEntry =
    Object.entries(parentMapping.relationships ?? {}).find(
      ([name, relation]) =>
        name === cell.relationship || relation.schemaName === cell.relationship,
    ) ?? null;
  const settings = subgridSettings(portal, definition, schema, gridId);
  const mapping = mappingFor(store, cell.entity);
  const view = cell.fetchXml
    ? {
        id: canonical(cell.viewId),
        entity: cell.entity,
        name: solutionView(metadata, cell.viewId, cell.entity)?.name ?? cell.label ?? cell.id,
        fetchXml: cell.fetchXml,
        fields: cell.fields?.map((field) => ({ name: field.name, width: field.width, label: field.label })) ?? [],
      }
    : null;
  if (!view)
    fail(`Subgrid ${gridId} view is absent in the selected solution sources`, 501, "SYSTEMVIEW_UNRESOLVED");
  return {
    kind: "subgrid",
    definition,
    schema,
    cell,
    relationship: relationshipEntry?.[1] ?? null,
    navigation: relationshipEntry?.[0] ?? null,
    entity: canonical(cell.entity),
    idColumn: mapping.idColumn,
    primaryName: primaryNameColumn(store, metadata, cell.entity),
    views: [view],
    settings,
    pageSize:
      Number(settings?.PageSize ?? cell.recordsPerPage ?? 0) ||
      Number(portalField(portal.settings ?? {}, "Grid/PageSize", 0)) ||
      10,
    search: { enabled: false },
  };
}

/** Resolve the lookup views for one form field (one layout per target table). */
export function lookupModel({ portal, schemas, metadata, store, kind, formId, stepId, field: fieldName }) {
  const definition = formDefinition(portal, kind, formId);
  if (!definition) fail("Native lookup form is not exported", 404, "FormNotFound");
  const schema = formSchema(schemas, definition, stepId);
  const field = (schema.fields ?? []).find((candidate) => candidate.name === fieldName);
  if (!field || field.type !== "lookup")
    fail("Lookup field is not bound to the exported form", 403, "LookupNotBound");
  const mapping = mappingFor(store, schema.entity);
  const targets =
    field.lookupTargets ??
    [
      ...new Set(
        Object.values(mapping.relationships ?? {})
          .filter((relation) => relation.many === false && relation.from === field.name)
          .map((relation) => relation.entity),
      ),
    ];
  const views = targets.map((target) => {
    const targetMapping = mappingFor(store, target);
    const name = primaryNameColumn(store, metadata, target) ?? targetMapping.idColumn;
    if (field.lookupView?.entity === canonical(target))
      return { ...field.lookupView, name: solutionView(metadata, field.lookupView.id)?.name ?? "Lookup View" };
    // A lookup without an imported default view still exposes the target's
    // primary name, sorted ascending, as the minimum native lookup projection.
    return {
      id: `lookup-${target}`,
      entity: target,
      name: `${target} lookup`,
      fetchXml: `<fetch><entity name="${xmlEscape(target)}"><attribute name="${xmlEscape(targetMapping.idColumn)}"/><attribute name="${xmlEscape(name)}"/><order attribute="${xmlEscape(name)}"/></entity></fetch>`,
      fields: [{ name, width: 300 }],
      synthesized: true,
    };
  });
  if (!views.length)
    fail(`Lookup ${fieldName} target is absent in the selected metadata`, 501, "LOOKUP_TARGET_UNRESOLVED");
  return {
    kind: "lookup",
    definition,
    schema,
    field,
    entity: canonical(views[0].entity),
    targets: targets.map(canonical),
    views,
    settings: {},
    pageSize:
      Number(portal.settings?.["Portal/Lookup/Modal/Grid/PageSize"]) || 10,
    search: { enabled: true, placeholder: "Search", tooltip: "To search on partial text, use the asterisk (*) wildcard character." },
  };
}

/** Associate dialog of a subgrid: the AssociateAction view in multiple-selection mode. */
export function associateModel(context) {
  const grid = subgridModel(context);
  const action = (grid.settings?.ViewActions ?? []).find(
    (candidate) => candidate.Type === "CrmEntityFormView-AssociateAction",
  );
  if (!action) fail("Subgrid has no associate action", 403, "AssociateNotEnabled");
  const view = solutionView(context.metadata, action.ViewId, grid.entity) ?? {
    ...grid.views[0],
  };
  return { ...grid, kind: "associate", views: [view], action };
}

// ---------------------------------------------------------------------------
// Query construction.

function conditionNode(attrs, values) {
  return {
    name: "condition",
    attrs,
    children: (values ?? []).map((value) => ({
      name: "value",
      attrs: {},
      children: [],
      text: String(value),
    })),
    text: "",
  };
}
const filterNode = (type, children) => ({
  name: "filter",
  attrs: { type },
  children,
  text: "",
});

/** Parse "attr ASC, alias.attr DESC" accepting only known view columns. */
export function parseSortExpression(expression, allowed) {
  const parts = [];
  for (const part of String(expression ?? "").split(",")) {
    const match = /^\s*([a-z_][\w]*(?:\.[a-z_][\w]*)?)\s*(asc|desc)?\s*$/i.exec(part);
    if (!match) continue;
    if (allowed && !allowed.has(match[1])) continue;
    parts.push({ attribute: match[1], descending: /desc/i.test(match[2] ?? "") });
  }
  return parts;
}

function applySort(fetch, sort) {
  if (!sort.length) return;
  const entity = rootEntity(fetch);
  const strip = (node) => {
    node.children = node.children.filter((child) => child.name !== "order");
    for (const link of childNodes(node, "link-entity")) strip(link);
  };
  strip(entity);
  const aliases = linkAliases(entity);
  for (const part of sort) {
    const [alias, attribute] = part.attribute.includes(".")
      ? part.attribute.split(".")
      : [null, part.attribute];
    const target = alias ? aliases.get(alias) : entity;
    if (!target) continue;
    target.children.push({
      name: "order",
      attrs: { attribute, descending: part.descending ? "true" : "false" },
      children: [],
      text: "",
    });
  }
}

/** Native quick search: begins-with on the view's text columns ("*" is a wildcard). */
function applySearch(fetch, search, columns, metadata, entity) {
  const query = String(search ?? "").trim().slice(0, 3999);
  if (!query) return;
  const pattern = `${query.replace(/\*/g, "%")}%`;
  const conditions = [];
  for (const column of columns) {
    if (column.Type !== 0) continue;
    const { field } = columnMetadata(metadata, entity, fetch, column.LogicalName);
    const type = String(field?.dataverseType ?? "").toLowerCase();
    if (type && !/^(nvarchar|string|memo|ntext)$/.test(type)) continue;
    if (!type && column.LogicalName.includes(".")) continue;
    const [alias, attribute] = column.LogicalName.includes(".")
      ? column.LogicalName.split(".")
      : [null, column.LogicalName];
    conditions.push(
      conditionNode({
        attribute,
        operator: "like",
        value: pattern,
        ...(alias ? { entityname: alias } : {}),
      }),
    );
  }
  if (!conditions.length) return;
  rootEntity(fetch).children.push(filterNode("or", conditions));
}

/** Metadata filter definition (adx_filter_definition) applied from the serialized "mf" query. */
export function metaFilterGroups(definition) {
  const parsed = settingsJson(definition || "{}", "filter definition");
  const entity = parsed.entity ?? {};
  const groups = [];
  for (const filter of entity.filters ?? [])
    groups.push({ kind: "filter", node: filter });
  for (const link of entity.links ?? [])
    groups.push({ kind: "link", node: link });
  return groups
    .map(({ kind, node }) => ({
      kind,
      node,
      id: String(node["adx.id"] ?? ""),
      label: node["adx.uiname"] ?? node["adx.attribute"] ?? "",
      order: Number(node["adx.uiorder"] ?? 0),
      type: node["adx.filtertype"] ?? "",
      selectionMode: node["adx.uiselectionmode"] ?? (node["adx.filtertype"] === "textfilter" ? "Text" : "Multiple"),
    }))
    .sort((a, b) => a.order - b.order);
}

function applyMetaFilter(fetch, metaFilter, definition) {
  if (!metaFilter || !definition) return;
  const params = new URLSearchParams(String(metaFilter));
  const entity = rootEntity(fetch);
  for (const group of metaFilterGroups(definition)) {
    const selected = params.getAll(group.id).map((value) => value.trim()).filter(Boolean);
    if (!selected.length) continue;
    if (group.type === "textfilter") {
      const attribute = group.node["adx.attribute"];
      if (!safeName(attribute)) continue;
      entity.children.push(
        filterNode(
          "or",
          selected.map((text) =>
            conditionNode({ attribute, operator: "like", value: `%${text.replace(/\*/g, "%")}%` }),
          ),
        ),
      );
      continue;
    }
    if (group.kind === "link") {
      const node = group.node;
      if (!safeName(node.name) || !safeName(node.from) || !safeName(node.to)) continue;
      const condition = node.filters?.[0]?.conditions?.[0] ?? {};
      const attribute = condition.attribute ?? node.from;
      const ids = selected.filter((value) => GUID.test(value));
      if (!ids.length || !safeName(attribute)) continue;
      entity.children.push({
        name: "link-entity",
        attrs: { name: node.name, from: node.from, to: node.to, "link-type": "inner", alias: `mf_${group.id}` },
        children: [filterNode("or", ids.map((id) => conditionNode({ attribute, operator: "eq", value: id })))],
        text: "",
      });
      continue;
    }
    // Attribute filter set / range / dynamic picklist: options are indexed
    // conditions inside the definition; each selected option index applies its condition.
    const conditions = [];
    for (const value of selected) {
      if (group.type === "dynamicpicklistset") {
        const attribute = group.node["adx.attribute"] ?? group.node.conditions?.[0]?.attribute;
        if (safeName(attribute)) conditions.push(conditionNode({ attribute, operator: "eq", value }));
        continue;
      }
      const option = (group.node.conditions ?? group.node.filters ?? []).find(
        (candidate) => String(candidate["adx.id"]) === value,
      );
      const parts = option?.conditions ?? (option ? [option] : []);
      const nodes = parts
        .filter((part) => safeName(part.attribute) && /^[a-z-]+$/.test(part.operator ?? "eq"))
        .map((part) => conditionNode({ attribute: part.attribute, operator: part.operator ?? "eq", ...(part.value != null ? { value: String(part.value) } : {}) }));
      if (nodes.length) conditions.push(nodes.length === 1 ? nodes[0] : filterNode("and", nodes));
    }
    if (conditions.length) entity.children.push(filterNode("or", conditions));
  }
}

function applyUserFilters(fetch, model, request, identity, website) {
  if (model.kind !== "list") return;
  const entity = rootEntity(fetch);
  const contactId = identity?.contactId ?? identity?.id;
  const accountId = identity?.accountId;
  const { portalUser, account, website: websiteAttribute } = model.userFilters;
  let filter = request.filter === "account" || request.filter === "user" ? request.filter : null;
  if (!filter) filter = portalUser ? "user" : account ? "account" : null;
  if (filter === "user" && portalUser && safeName(portalUser))
    entity.children.push(
      filterNode("and", [conditionNode({ attribute: portalUser, operator: "eq", value: contactId ?? "00000000-0000-0000-0000-000000000000" })]),
    );
  if (filter === "account" && account && safeName(account))
    entity.children.push(
      filterNode("and", [conditionNode({ attribute: account, operator: "eq", value: accountId ?? "00000000-0000-0000-0000-000000000000" })]),
    );
  if (websiteAttribute && safeName(websiteAttribute) && website)
    entity.children.push(
      filterNode("and", [conditionNode({ attribute: websiteAttribute, operator: "eq", value: website })]),
    );
}

function applyRelationship(fetch, model, parentId, store) {
  if (model.kind !== "subgrid" && model.kind !== "associate") return;
  const relation = model.relationship;
  if (!relation || !relation.many)
    fail(`Subgrid ${model.cell.id} requires exported relationship ${model.cell.relationship}`, 501, "SUBGRID_RELATIONSHIP_REQUIRED");
  if (model.kind === "associate") return;
  const entity = rootEntity(fetch);
  if (!relation.intersect) {
    entity.children.push(
      filterNode("and", [conditionNode({ attribute: relation.to, operator: "eq", value: parentId })]),
    );
    return;
  }
  // N:N: structural intersect link from the child's perspective.
  const childMapping = mappingFor(store, model.entity);
  const reverse = Object.values(childMapping.relationships ?? {}).find(
    (candidate) =>
      candidate.intersect?.entity === relation.intersect.entity &&
      candidate.entity === canonical(model.schema.entity),
  );
  if (!reverse)
    fail(`Subgrid ${model.cell.id} intersection is unresolved`, 501, "SUBGRID_RELATIONSHIP_REQUIRED");
  entity.children.push({
    name: "link-entity",
    attrs: {
      name: relation.intersect.entity,
      from: reverse.intersect.from,
      to: reverse.from,
      "link-type": "inner",
      intersect: "true",
    },
    children: [
      filterNode("and", [conditionNode({ attribute: reverse.intersect.to, operator: "eq", value: parentId })]),
    ],
    text: "",
  });
}

// ---------------------------------------------------------------------------
// Record shaping (EntityRecord contract).

const NET_TYPES = {
  nvarchar: "System.String",
  string: "System.String",
  memo: "System.String",
  ntext: "System.String",
  int: "System.Int32",
  integer: "System.Int32",
  bigint: "System.Int64",
  decimal: "System.Decimal",
  float: "System.Double",
  double: "System.Double",
  money: "Microsoft.Xrm.Sdk.Money",
  bit: "System.Boolean",
  boolean: "System.Boolean",
  datetime: "System.DateTime",
  lookup: "Microsoft.Xrm.Sdk.EntityReference",
  customer: "Microsoft.Xrm.Sdk.EntityReference",
  owner: "Microsoft.Xrm.Sdk.EntityReference",
  picklist: "Microsoft.Xrm.Sdk.OptionSetValue",
  state: "Microsoft.Xrm.Sdk.OptionSetValue",
  status: "Microsoft.Xrm.Sdk.OptionSetValue",
  multiselectpicklist: "Microsoft.Xrm.Sdk.OptionSetValueCollection",
  uniqueidentifier: "System.Guid",
  primarykey: "System.Guid",
};

const pad = (value, length = 2) => String(value).padStart(length, "0");
/** .NET custom date format subset used by portal DateTime/* site settings. */
export function formatDotNetDate(date, format) {
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const hours = date.getUTCHours();
  const tokens = {
    yyyy: String(date.getUTCFullYear()),
    yy: pad(date.getUTCFullYear() % 100),
    MMMM: months[date.getUTCMonth()],
    MMM: months[date.getUTCMonth()].slice(0, 3),
    MM: pad(date.getUTCMonth() + 1),
    M: String(date.getUTCMonth() + 1),
    dddd: days[date.getUTCDay()],
    ddd: days[date.getUTCDay()].slice(0, 3),
    dd: pad(date.getUTCDate()),
    d: String(date.getUTCDate()),
    HH: pad(hours),
    H: String(hours),
    hh: pad(hours % 12 || 12),
    h: String(hours % 12 || 12),
    mm: pad(date.getUTCMinutes()),
    m: String(date.getUTCMinutes()),
    ss: pad(date.getUTCSeconds()),
    s: String(date.getUTCSeconds()),
    tt: hours < 12 ? "AM" : "PM",
  };
  return String(format).replace(
    /'[^']*'|yyyy|yy|MMMM|MMM|MM|M|dddd|ddd|dd|d|HH|H|hh|h|mm|m|ss|s|tt/g,
    (token) => (token.startsWith("'") ? token.slice(1, -1) : tokens[token]),
  );
}

function attributeEntry(name, value, { field, settings, entity, primaryName, timezoneOffset = 0 }) {
  const dataverseType = String(field?.dataverseType ?? "").toLowerCase();
  let type = NET_TYPES[dataverseType];
  const inner = scalar(value);
  if (!type) {
    if (value && typeof value === "object" && "logical_name" in value) type = NET_TYPES.lookup;
    else if (value && typeof value === "object" && "label" in value) type = NET_TYPES.picklist;
    else if (typeof value === "boolean") type = "System.Boolean";
    else if (typeof value === "number") type = Number.isInteger(value) ? "System.Int32" : "System.Decimal";
    else if (typeof value === "string" && GUID.test(value)) type = "System.Guid";
    else type = "System.String";
  }
  const entry = {
    Name: name,
    Type: type,
    Value: inner,
    FormattedValue: inner == null ? "" : String(inner),
    DateTimeFormat: "DateAndTime",
    DisplayValue: inner == null ? "" : String(inner),
    AttributeMetadata: compactAttributeMetadata(entity, name.split(".").at(-1), field, primaryName),
  };
  if (type === NET_TYPES.lookup) {
    const id = canonical(value?.id ?? value);
    entry.Value = id ? { Id: id, LogicalName: value?.logical_name ?? field?.lookupTargets?.[0] ?? null, Name: value?.name ?? null, KeyAttributes: [], RowVersion: null, ExtensionData: null } : null;
    entry.FormattedValue = entry.DisplayValue = value?.name ?? "";
  } else if (type === NET_TYPES.picklist) {
    const number = inner == null || inner === "" ? null : Number(inner);
    const option = (field?.options ?? []).find((candidate) => Number(candidate.value) === number);
    entry.Value = number == null ? null : { Value: number, ExtensionData: null };
    entry.FormattedValue = entry.DisplayValue = value?.label ?? option?.label ?? (number == null ? "" : String(number));
  } else if (type === NET_TYPES.multiselectpicklist) {
    const values = (Array.isArray(value) ? value : String(inner ?? "").split(","))
      .map((item) => Number(scalar(item)))
      .filter(Number.isFinite);
    entry.Value = values.map((number) => ({ Value: number, ExtensionData: null }));
    entry.FormattedValue = entry.DisplayValue = values
      .map((number) => (field?.options ?? []).find((option) => Number(option.value) === number)?.label ?? String(number))
      .join("; ");
  } else if (type === "Microsoft.Xrm.Sdk.Money") {
    const number = inner == null || inner === "" ? null : Number(inner);
    entry.Value = number == null ? null : { Value: number, ExtensionData: null };
    entry.FormattedValue = entry.DisplayValue = number == null ? "" : number.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  } else if (type === "System.Boolean") {
    const bool = inner === true || inner === 1 || /^(true|1)$/i.test(String(inner ?? ""));
    entry.Value = inner == null ? null : bool;
    const option = (field?.options ?? []).find((candidate) => Number(candidate.value) === (bool ? 1 : 0));
    entry.FormattedValue = entry.DisplayValue = inner == null ? "" : option?.label ?? (bool ? "Yes" : "No");
  } else if (type === "System.DateTime") {
    const date = inner == null || inner === "" ? null : new Date(inner);
    const dateOnly = /dateonly/i.test(field?.behavior ?? field?.format ?? "") || field?.type === "date";
    if (date && !Number.isNaN(date.getTime())) {
      entry.Value = `/Date(${date.getTime()})/`;
      entry.DateTimeFormat = dateOnly ? "DateOnly" : "DateAndTime";
      const local = dateOnly ? date : new Date(date.getTime() - Number(timezoneOffset || 0) * 60000);
      const format = dateOnly
        ? settings?.["DateTime/DateFormat"] || "dd/MM/yyyy"
        : settings?.["DateTime/DateTimeFormat"] || `${settings?.["DateTime/DateFormat"] || "dd/MM/yyyy"} ${settings?.["DateTime/TimeFormat"] || "HH:mm"}`;
      entry.FormattedValue = formatDotNetDate(local, format);
      entry.DisplayValue = dateOnly ? date.toISOString().slice(0, 10) : date.toISOString().replace(/\.\d{3}Z$/, "Z");
    } else {
      entry.Value = null;
      entry.FormattedValue = entry.DisplayValue = "";
    }
  } else if (type === "System.Decimal" || type === "System.Double") {
    const number = inner == null || inner === "" ? null : Number(inner);
    entry.Value = number;
    const precision = Number(field?.precision ?? 2);
    entry.FormattedValue = entry.DisplayValue = number == null ? "" : number.toLocaleString("en-US", { minimumFractionDigits: precision, maximumFractionDigits: precision });
  } else if (type === "System.Int32" || type === "System.Int64") {
    const number = inner == null || inner === "" ? null : Number(inner);
    entry.Value = number;
    entry.FormattedValue = entry.DisplayValue = number == null ? "" : number.toLocaleString("en-US");
  } else if (type === "System.Guid") {
    entry.Value = inner == null ? null : canonical(inner);
    entry.FormattedValue = entry.DisplayValue = entry.Value ?? "";
  }
  return entry;
}

function permissionsFor(context, entity, row) {
  const { store, identity, config } = context;
  if (config?.mode === "live" || typeof store.allowed !== "function")
    return { CanRead: true, CanWrite: false, CanDelete: false, CanAppend: false, CanAppendTo: false };
  // The view row carries only its columns; scoped grants (parent, contact, account)
  // are evaluated on the stored record, as the platform does.
  let record = row;
  try {
    const id = row?.[mappingFor(store, entity).idColumn];
    record = (id != null && typeof store.get === "function" ? store.get(entity, id, identity) : null) ?? row;
  } catch {
    record = row;
  }
  const allowed = (operation) => {
    try {
      return store.allowed(entity, operation, record, identity);
    } catch {
      return false;
    }
  };
  return {
    CanRead: allowed("read"),
    CanWrite: allowed("update"),
    CanDelete: allowed("delete"),
    CanAppend: allowed("append"),
    CanAppendTo: allowed("appendTo"),
  };
}

export function gridRecord(row, model, layout, context) {
  const fields = entityFields(context.metadata, model.entity);
  const fetch = (model.viewTree ??= parseFetchTree(model.view.fetchXml));
  const id = canonical(row[model.idColumn]);
  const attributes = [];
  const seen = new Set();
  const push = (name, value) => {
    if (seen.has(name) || value === undefined) return;
    seen.add(name);
    const { table, field } = columnMetadata(context.metadata, model.entity, fetch, name);
    attributes.push(
      attributeEntry(name, value, {
        field,
        settings: context.portal.settings,
        entity: table,
        primaryName: model.primaryName,
        timezoneOffset: context.timezoneOffset,
      }),
    );
  };
  for (const column of layout.Columns) if (column.Type === 0) push(column.LogicalName, row[column.LogicalName] ?? null);
  for (const [key, value] of Object.entries(row)) {
    if (key.includes("@") || key.startsWith("__") || /^_.*_value$/.test(key)) continue;
    if (!key.includes(".") && !fields[key] && key !== model.idColumn && !/^(statecode|statuscode)$/.test(key)) continue;
    push(key, value);
  }
  push(model.idColumn, id);
  const state = scalar(row.statecode);
  const status = scalar(row.statuscode);
  return {
    Id: id,
    EntityName: model.entity,
    Attributes: attributes,
    ...permissionsFor(context, model.entity, row),
    StateCode: state == null ? 0 : Number(state),
    StatusCode: status == null ? 0 : Number(status),
  };
}

/** Execute one native grid data request. */
/** Whether the persona has any read grant for a table (native AccessDenied result). */
export function readDenied(context, entity) {
  const { store, identity } = context;
  if (context.config?.mode === "live" || typeof store?.rules !== "function" || identity?.admin) return false;
  let permissive = false;
  try {
    permissive = store.snapshot({ sections: ["settings"] })?.settings?.permissionMode === "permissive";
  } catch {
    permissive = false;
  }
  return !permissive && !store.rules(entity, "read", identity).length;
}

/**
 * Run one view query with the native grid semantics (relationship, user and
 * metadata filters, quick search, sort, 1-based pages, 5,000 count cap).
 */
export async function executeGridQuery(model, request, context) {
  const view =
    model.views.find((candidate) => canonical(candidate.id) === canonical(context.secure?.view ?? request.viewId)) ??
    model.views[0];
  model = { ...model, view };
  const layout = buildLayout({
    view,
    entity: model.entity,
    idColumn: model.idColumn,
    primaryName: model.primaryName,
    metadata: context.metadata,
    settings: model.settings,
    configuration: {},
    secure: context.secure ?? { t: "query" },
  });
  if (readDenied(context, model.entity)) return { model, view, layout, accessDenied: true, rows: [] };
  const { store, identity, readProvider } = context;
  const fetch = parseFetchTree(
    contextualViewFetchXml(view.fetchXml, { user: identity, website: context.portal.website }),
  );
  applyRelationship(fetch, model, context.secure?.parent, store);
  applyUserFilters(fetch, model, request, identity, context.portal.website?.id);
  if (model.search?.enabled !== false) applySearch(fetch, request.search, layout.Columns, context.metadata, model.entity);
  if (model.kind === "list" && model.filter?.enabled)
    applyMetaFilter(fetch, request.metaFilter, model.filter.definition);
  const allowedSort = new Set(layout.Columns.filter((column) => column.Type === 0 && !column.SortDisabled).map((column) => column.LogicalName));
  applySort(fetch, parseSortExpression(request.sortExpression, allowedSort));
  const pageSize = Math.min(Math.max(Number(model.pageSize) || 10, 1), 250);
  const requestedSize = Number(request.pageSize);
  const effectiveSize = requestedSize > 0 && requestedSize <= (request.allowLargePages ? 5000 : 50) ? requestedSize : pageSize;
  const page = Math.max(1, Math.floor(Number(request.page) || 1));
  delete fetch.attrs.top;
  fetch.attrs.count = String(effectiveSize);
  fetch.attrs.page = String(page);
  fetch.attrs.returntotalrecordcount = "true";
  delete fetch.attrs["paging-cookie"];
  const result = await readProvider.fetchXml(serializeFetchTree(fetch), identity);
  const rows = result.entities ?? result.value ?? [];
  const total = Number(result.total_record_count);
  const itemCount = Number.isFinite(total) && total >= 0 ? Math.min(total, 5000) : -1;
  return {
    model,
    view,
    layout,
    rows,
    itemCount,
    moreRecords: Boolean(result.more_records) || itemCount > page * effectiveSize,
    page,
    pageSize: effectiveSize,
  };
}

export async function gridData(model, request, context) {
  const query = await executeGridQuery(model, request, context);
  if (query.accessDenied) return { AccessDenied: true };
  const { layout, rows, itemCount, page } = query;
  const effectiveSize = query.pageSize;
  const { identity, readProvider } = context;
  model = query.model;
  const result = { more_records: query.moreRecords };
  const records = rows.map((row) => gridRecord(row, model, layout, context));
  const disabled = [];
  // A download writes record values only; item actions are not evaluated per record.
  const itemActions = request.download ? [] : actionLinks(model.settings, { portal: context.portal, requestUrl: context.origin, website: context.portal.website?.id });
  for (const action of itemActions)
    if (action.position === "item" && action.FilterCriteria)
      for (const record of records)
        if (
          !(await subgridActionApplies(action.source, {
            entity: model.entity,
            idColumn: model.idColumn,
            recordId: record.Id,
            readProvider,
            identity,
            context: { website: context.portal.website },
          }))
        )
          disabled.push({ EntityId: record.Id, LinkUniqueId: action.FilterCriteriaId });
  return {
    MoreRecords: Boolean(result.more_records) || (itemCount > page * effectiveSize),
    Records: records,
    ItemCount: itemCount,
    PageCount: itemCount > 0 ? Math.ceil(itemCount / effectiveSize) : 0,
    PageNumber: page,
    PageSize: effectiveSize,
    NextPagePagingCookie: null,
    ViewConfiguration: null,
    CompleteViewLayout: null,
    CreateActionMetadata: { Disabled: false, DisabledMessage: null },
    DisabledItemActionLinks: disabled,
  };
}

// ---------------------------------------------------------------------------
// Request handling.

const SERVICE = /^\/_services\/([a-z-]+(?:\.json)?)\/([0-9a-f-]{36}|[\w-]+)\/?$/i;
const STATIC = new Map([
  ["/__sim-static/native/entity-grid-compat.js", new URL("./entity-grid-compat.js", import.meta.url)],
  ["/__sim-static/native/webforms-compat.js", new URL("./webforms-compat.js", import.meta.url)],
  ["/__sim-static/native/platform-app-compat.js", new URL("./platform-app-compat.js", import.meta.url)],
  ["/__sim-static/native/jquery-blockui-compat.js", new URL("./jquery-blockui-compat.js", import.meta.url)],
  ["/__sim-static/native/platform-chrome.css", new URL("./platform-chrome.css", import.meta.url)],
]);
const JAVASCRIPT = "application/javascript; charset=utf-8";
const staticType = (path) => (path.endsWith(".css") ? "text/css; charset=utf-8" : JAVASCRIPT);

// A transparent 1x1 PNG for the offline notification bar icons (platform CDN images).
const PNG_PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
/**
 * Native platform paths (lib/platform-manifest.mjs) served from local equivalents when
 * neither an exported web file nor a captured platform asset provides them. Keys are
 * lower case: the platform matches these paths case-insensitively.
 */
const NATIVE_EQUIVALENTS = new Map([
  ["/js/jquery.blockui.js", { file: new URL("./jquery-blockui-compat.js", import.meta.url), type: JAVASCRIPT }],
  ["/xrm-adx/js/webform.js", { file: new URL("./xrm-webform-compat.js", import.meta.url), type: JAVASCRIPT }],
  ["/xrm-adx/js/radcaptcha.js", { file: new URL("./radcaptcha-compat.js", import.meta.url), type: JAVASCRIPT }],
  ["/xrm-adx/js/crmentityformview.js", { file: new URL("./crmentityformview-compat.js", import.meta.url), type: JAVASCRIPT }],
  ["/xrm-adx/js/crmentityformview-datetime.js", { file: new URL("./crmentityformview-datetime-compat.js", import.meta.url), type: JAVASCRIPT }],
  ["/resource/powerappsportal/img/web.png", { body: PNG_PIXEL, type: "image/png" }],
  ["/resource/powerappsportal/img/close.png", { body: PNG_PIXEL, type: "image/png" }],
  ["/css/images/web.png", { body: PNG_PIXEL, type: "image/png" }],
  ["/css/images/close.png", { body: PNG_PIXEL, type: "image/png" }],
]);
// Platform strings that local scripts read (values from the reference-portal en-US ResourceManager).
const RESOURCE_STRINGS = {
  Home_DefaultText: "Home",
  Search_DefaultText: "Search",
  Close_DefaultText: "Close",
  Entity_Form_Label: "Basic Form",
  Web_Form_Label: "Advanced form",
  Entity_List_Label: "List",
  Form_Label: "form",
  Modal_Dialog: "Dialog",
  Default_Grid_Empty_Message: "There are no records to display.",
  Default_Error_Permission: "You don't have permission to perform this operation.",
  Lookup_SingleSelection_Text: "Choose one record and click Select to continue",
  Pagination_Next_Page: "Next page",
  Pagination_Previous_Page: "Previous page",
  Length_ErrorText: "You’ve reached the maximum characters allowed in this field.",
  Click_Stay_To_Save_Your_Changes: "Your changes haven't been saved. Would you like to stay on the page to save your changes?",
};
const RESOURCE_MANAGER = /^\/_portal\/([^/]+)\/Resources\/ResourceManager\/?$/i;

/** Serve a native platform path from its local equivalent unless the export or the asset cache owns it. */
async function serveNativeEquivalent(req, res, url, context, websiteId) {
  const key = (() => {
    try {
      return decodeURIComponent(url.pathname).toLowerCase();
    } catch {
      return url.pathname.toLowerCase();
    }
  })();
  const manager = RESOURCE_MANAGER.exec(url.pathname);
  const bundle = platformBundleFor(url.pathname) ?? localAspNetScript(url);
  const platformBootstrap = key === "/css/bootstrap.min.css";
  const equivalent =
    NATIVE_EQUIVALENTS.get(key) ??
    (manager && canonical(manager[1]) === websiteId ? { body: Buffer.from(`window.ResourceManager = ${JSON.stringify(RESOURCE_STRINGS, null, 1)};\n`), type: "text/javascript; charset=utf-8" } : null) ??
    (bundle ? { bundle, type: bundle.kind === "stylesheet" ? "text/css; charset=utf-8" : JAVASCRIPT } : null) ??
    (platformBootstrap ? { body: Buffer.alloc(0), type: "text/css; charset=utf-8", placeholder: { id: "platform-bootstrap", reason: "The platform's default Bootstrap 3 stylesheet is not available without a shell capture; the site has no bootstrap.min.css content style." } } : null);
  if (!equivalent || !["GET", "HEAD"].includes(req.method)) return false;
  const exported = (context.portal?.webFiles ?? []).some((file) => normalizePortalPath(file.url) === normalizePortalPath(url.pathname));
  if (exported) return false;
  if (context.cache && equivalent.bundle?.capture !== false) {
    const cached = await context.cache.get(url.pathname + url.search, { origin: context.live?.origin }).catch(() => null);
    if (cached) return false;
  }
  const body = equivalent.bundle ? await bundleEquivalent(equivalent.bundle) : (equivalent.body ?? (await fs.readFile(fileURLToPath(equivalent.file))));
  const placeholder = equivalent.placeholder ?? (equivalent.bundle && !equivalent.bundle.local.length ? equivalent.bundle : null);
  if (placeholder) reportPlaceholder(context, placeholder, url.pathname);
  res.writeHead(200, { "content-type": equivalent.type, "cache-control": "no-cache", "x-sim-resource-provider": placeholder ? "local-platform-placeholder" : "local-platform-equivalent" });
  res.end(req.method === "HEAD" ? undefined : body);
  return true;
}

// Local equivalents of the platform bundles (lib/platform-manifest.mjs PLATFORM_BUNDLES):
// the named sources concatenated in order. Library files keep their own licence headers.
const BUNDLE_SOURCES = {
  jquery: createRequire(import.meta.url).resolve("jquery/dist/jquery.min.js"),
  moment: createRequire(import.meta.url).resolve("moment/min/moment.min.js"),
};
// default-<lcid>.moment bundle: the site language's moment locale (moment ships "en").
const MOMENT_LOCALE = "(function(){var m=window.moment;if(m&&typeof m.locale==='function'){m.locale((document.documentElement.getAttribute('lang')||'en').toLowerCase());}})();";
const bundleBodies = new Map();
async function bundleEquivalent(bundle) {
  if (!bundleBodies.has(bundle.id))
    bundleBodies.set(
      bundle.id,
      (async () => {
        const parts = [];
        // Source map comments would point at files that are not served.
        for (const source of bundle.local)
          parts.push(`/* Local equivalent part: ${source} */\n${(await bundleSource(source)).replace(/^\/\/# sourceMappingURL=.*$/gm, "")}`);
        return Buffer.from(parts.join(bundle.kind === "stylesheet" ? "\n" : "\n;\n"));
      })(),
    );
  return bundleBodies.get(bundle.id);
}
// A source is a library, a file of lib/, one "// @part <name>" section of a file
// ("file#name"), or "provided:<file>" for a resource whose surface another part provides.
async function bundleSource(source) {
  if (source === "moment-locale") return MOMENT_LOCALE;
  if (source.startsWith("provided:")) return `/* Provided by ${source.slice("provided:".length)}. */`;
  const [file, part] = source.split("#");
  const text = String(await fs.readFile(BUNDLE_SOURCES[file] ?? new URL(`./${file}`, import.meta.url)));
  if (!part) return text;
  const sections = text.split(/^\/\/ @part (\w+)$/m);
  const index = sections.indexOf(part, 1);
  if (index < 0 || index % 2 === 0) throw new Error(`${file} has no part ${part}`);
  return sections[index + 1];
}
// One diagnostic per runtime and platform resource without a local equivalent.
const reported = new WeakMap();
function reportPlaceholder(context, placeholder, pathname) {
  const record = context.recordDiagnostic;
  if (typeof record !== "function") return;
  const seen = reported.get(record) ?? new Set();
  reported.set(record, seen);
  if (seen.has(placeholder.id)) return;
  seen.add(placeholder.id);
  record({
    code: "PLATFORM_BUNDLE_PLACEHOLDER",
    severity: "info",
    path: pathname,
    bundle: placeholder.id,
    message: `${placeholder.reason} No captured copy exists, so an empty local placeholder is served at the platform path.`,
  });
}

async function readJson(req, limit = 4 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) fail("Request body is too large", 413, "RequestTooLarge");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("Request body must be a JSON object");
    return value;
  } catch (error) {
    if (error instanceof DataError) throw error;
    fail("Request body must be valid JSON");
  }
}

function sendJson(res, status, value, headers = {}) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": body.length,
    ...headers,
  });
  res.end(body);
}
function sendError(res, error) {
  const status = error.status ?? error.statusCode ?? 500;
  const message = error.message || "Error completing request.";
  // Native grid services return the reason phrase; JSON bodies carry
  // {Message, InnerError} so the native client can display the cause.
  sendJson(res, status, { Message: message, InnerError: { Message: message, Code: error.code ?? "Error" } });
}

function verifyToken(req, csrf) {
  const header = req.headers.__requestverificationtoken;
  if (header !== csrf) fail("The anti-forgery token is missing or invalid.", 403, "MissingPortalRequestVerificationToken");
}

function modelFor(secure, context) {
  const base = {
    portal: context.portal,
    schemas: context.schemas,
    metadata: context.metadata,
    store: context.store,
  };
  if (secure.t === "list") {
    const list = context.portal.lists.find((candidate) => canonical(candidate.id) === canonical(secure.list));
    if (!list) fail("List is not exported", 404, "ListNotFound");
    return listModel({ ...base, list, schemas: context.schemas });
  }
  if (secure.t === "subgrid")
    return subgridModel({ ...base, kind: secure.kind, formId: secure.form, stepId: secure.step, gridId: secure.grid });
  if (secure.t === "associate")
    return associateModel({ ...base, kind: secure.kind, formId: secure.form, stepId: secure.step, gridId: secure.grid });
  if (secure.t === "lookup") {
    const model = lookupModel({ ...base, kind: secure.kind, formId: secure.form, stepId: secure.step, field: secure.field });
    const view = model.views.find((candidate) => canonical(candidate.id) === canonical(secure.view)) ?? model.views[0];
    return { ...model, entity: canonical(view.entity), idColumn: mappingFor(context.store, view.entity).idColumn, primaryName: primaryNameColumn(context.store, context.metadata, view.entity), views: [view] };
  }
  fail("Invalid_Request", 403, "Invalid_Request");
}

async function writeOperation(context, operation, entity, id, values) {
  if (context.config?.mode !== "live") {
    if (operation === "delete") return context.store.remove(entity, id, context.identity);
    return context.store.update(entity, id, values, context.identity);
  }
  const mapping = context.liveMapping(entity);
  const response = await context.live.request(
    `/_api/${mapping.entitySet}(${encodeURIComponent(id)})`,
    operation === "delete"
      ? { method: "DELETE" }
      : { method: "PATCH", body: Buffer.from(JSON.stringify(values)), contentType: "application/json" },
  );
  if (response.status >= 400) fail(`Live ${operation} returned HTTP ${response.status}.`, response.status, "LIVE_BRIDGE");
}

async function associationOperation(context, associate, entity, id, navigation, targetEntity, targetId) {
  if (context.config?.mode !== "live")
    return associate
      ? context.store.associate(entity, id, navigation, targetId, context.identity)
      : context.store.disassociate(entity, id, navigation, targetId, context.identity);
  const mapping = context.liveMapping(entity),
    target = context.liveMapping(targetEntity);
  const base = `/_api/${mapping.entitySet}(${encodeURIComponent(id)})/${navigation}/$ref`;
  const response = associate
    ? await context.live.request(base, {
        method: "POST",
        body: Buffer.from(JSON.stringify({ "@odata.id": `${context.origin}/_api/${target.entitySet}(${targetId})` })),
        contentType: "application/json",
      })
    : await context.live.request(`/_api/${mapping.entitySet}(${encodeURIComponent(id)})/${navigation}(${encodeURIComponent(targetId)})/$ref`, { method: "DELETE" });
  if (response.status >= 400) fail(`Live association returned HTTP ${response.status}.`, response.status, "LIVE_BRIDGE");
}

function defaultStatus(metadata, entity, state) {
  const statusField = entityFields(metadata, entity).statuscode;
  return (statusField?.statuses ?? statusField?.options ?? []).find((option) => Number(option.state) === state)?.value ?? (state === 0 ? 1 : 2);
}

/** Notes (annotations) visible on portal forms: *WEB* prefix, private notes only for their author. */
export function portalNotes(rows, identity) {
  const contact = canonical(identity?.contactId ?? identity?.id);
  return rows.filter((row) => {
    const text = String(row.notetext ?? "");
    const subject = String(row.subject ?? "");
    const isPrivate = subject.includes("*PRIVATE*");
    return (text.startsWith("*WEB*") && !isPrivate) || (isPrivate && contact && subject.toLowerCase().includes(`[contact:${contact}]`));
  });
}

async function annotationRows(context, entity, id) {
  const mapping = mappingFor(context.store, "annotation");
  const xml = `<fetch><entity name="annotation"><all-attributes/><filter type="and"><condition attribute="objectid" operator="eq" value="${xmlEscape(id)}"/></filter><order attribute="createdon" descending="true"/></entity></fetch>`;
  const result = await context.readProvider.fetchXml(xml, context.identity);
  return (result.entities ?? result.value ?? []).filter(
    (row) => !row.objecttypecode || canonical(scalar(row.objecttypecode)) === canonical(entity) || canonical(row.objectid?.logical_name) === canonical(entity),
  ).map((row) => ({ ...row, [mapping.idColumn]: row[mapping.idColumn] }));
}

const fileSizeDisplay = (bytes) =>
  bytes >= 1048576 ? `${(bytes / 1048576).toFixed(2)} MB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(2)} KB` : `${bytes} B`;

async function handleNotes(action, req, res, context) {
  if (action === "entity-notes") {
    const body = await readJson(req);
    const regarding = body.regarding ?? {};
    if (!safeName(regarding.LogicalName) || !GUID.test(String(regarding.Id ?? ""))) fail("Notes require a regarding record");
    if (!(await context.readProvider.get(regarding.LogicalName, regarding.Id, context.identity)))
      fail("The regarding record was not found", 404, "NotFound");
    const pageSize = Math.min(Math.max(Number(body.pageSize) || 10, 1), 50);
    const page = Math.max(1, Number(body.page) || 1);
    const rows = portalNotes(await annotationRows(context, regarding.LogicalName, regarding.Id), context.identity);
    const contact = canonical(context.identity?.contactId ?? context.identity?.id);
    const records = rows.slice((page - 1) * pageSize, page * pageSize).map((row) => {
      const id = canonical(row.annotationid);
      const size = Number(row.filesize) || (row.documentbody ? Buffer.from(String(row.documentbody), "base64").length : 0);
      const mine = Boolean(contact) && String(row.subject ?? "").toLowerCase().includes(`[contact:${contact}]`);
      const text = String(row.notetext ?? "").replace(/^\*WEB\*/, "");
      return {
        Id: id,
        EntityName: "annotation",
        Attributes: [],
        CanRead: true,
        CanWrite: mine,
        CanDelete: mine,
        CanAppend: false,
        CanAppendTo: false,
        StateCode: 0,
        StatusCode: 0,
        AttachmentUrl: row.filename ? `/_entity/annotation/${id}/${context.portal.website?.id ?? ""}` : null,
        AttachmentContentType: row.mimetype ?? null,
        AttachmentFileName: row.filename ?? null,
        AttachmentIsImage: /^image\/(jpeg|gif|png)$/i.test(row.mimetype ?? ""),
        AttachmentSize: size,
        AttachmentSizeDisplay: fileSizeDisplay(size),
        CreatedOn: row.createdon ?? null,
        CreatedOnDisplay: row.createdon ? new Date(row.createdon).toISOString().replace(/\.\d{3}Z$/, "Z") : null,
        HasAttachment: Boolean(row.filename),
        Subject: row.subject ?? "",
        Text: text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]).replace(/\n/g, "<br />"),
        UnformattedText: text,
        IsPostedByCurrentUser: mine,
        PostedByName: /by (.*?) \[contact:/i.exec(row.subject ?? "")?.[1] ?? "",
        DisplayToolbar: mine,
        IsPrivate: String(row.subject ?? "").includes("*PRIVATE*"),
      };
    });
    return sendJson(res, 200, {
      Records: records,
      ItemCount: rows.length,
      PageCount: Math.ceil(rows.length / pageSize),
      PageNumber: page,
      PageSize: pageSize,
      MoreRecords: rows.length > page * pageSize,
      CreateActionMetadata: { Disabled: false, DisabledMessage: null },
      DisabledItemActionLinks: [],
    });
  }
  // Add, update and delete use JSON locally; the native form posts multipart
  // fields with the same names (text, isPrivate, file as base64 here).
  const body = await readJson(req, 64 * 1024 * 1024);
  const contact = canonical(context.identity?.contactId ?? context.identity?.id);
  if (!contact) fail("Notes require a signed-in contact", 401, "SignInRequired");
  if (action === "entity-form-addnote") {
    const entity = body.regardingEntityLogicalName;
    const id = body.regardingEntityId;
    if (!safeName(entity) || !GUID.test(String(id ?? ""))) fail("Notes require a regarding record");
    const text = String(body.text ?? "").trim();
    if (!text) fail("Note is a required field.", 417, "NoteRequired");
    const fullname = context.identity?.fullname ?? context.identity?.name ?? "";
    const parentMapping = mappingFor(context.store, entity);
    const regarding = await context.readProvider.get(entity, id, context.identity);
    if (!regarding) fail("The regarding record was not found", 404, "NotFound");
    // The regarding lookup (objectid) is polymorphic, like the platform's EntityReference:
    // bind through the navigation property the solutions declare for this table, else set
    // the lookup to the regarding record.
    const navigation = Object.entries(mappingFor(context.store, "annotation").relationships ?? {}).find(
      ([, rel]) => rel.many !== true && canonical(rel.from) === "objectid" && canonical(rel.entity) === canonical(parentMapping.logicalName),
    )?.[0];
    const values = {
      notetext: `*WEB*${text}`,
      subject: `Note created on ${new Date().toUTCString()} by ${fullname} [contact:${contact}]${body.isPrivate ? " *PRIVATE*" : ""}`,
      objecttypecode: parentMapping.logicalName,
      ...(navigation
        ? { [`${navigation}@odata.bind`]: `/${parentMapping.entitySet}(${id})` }
        : { objectid: { id: canonical(id), logical_name: parentMapping.logicalName, name: String(regarding[parentMapping.nameColumn] ?? "") } }),
    };
    if (body.file?.name) {
      values.filename = String(body.file.name).slice(0, 255);
      values.mimetype = String(body.file.type || "application/octet-stream").slice(0, 255);
      values.documentbody = String(body.file.content ?? "");
      values.filesize = Buffer.from(values.documentbody, "base64").length;
    }
    const created = await context.change(() => context.store.create("annotation", values, context.identity));
    return sendJson(res, 201, { Id: canonical(created.annotationid) });
  }
  const id = String(body.id ?? "");
  if (!GUID.test(id)) fail("A note identifier is required");
  const note = await context.readProvider.get("annotation", id, context.identity);
  if (!note) fail("The note was not found", 404, "NotFound");
  if (!String(note.subject ?? "").toLowerCase().includes(`[contact:${contact}]`))
    fail("Only the author can change this note.", 403, "NoteAuthorRequired");
  if (action === "entity-form-updatenote") {
    const text = String(body.text ?? "").trim();
    if (!text) fail("Note is a required field.", 417, "NoteRequired");
    const values = { notetext: `*WEB*${text}` };
    if (body.file?.name) {
      values.filename = String(body.file.name).slice(0, 255);
      values.mimetype = String(body.file.type || "application/octet-stream").slice(0, 255);
      values.documentbody = String(body.file.content ?? "");
      values.filesize = Buffer.from(values.documentbody, "base64").length;
    }
    await context.change(() => context.store.update("annotation", id, values, context.identity));
    return sendJson(res, 200, { Id: canonical(id) });
  }
  await context.change(() => context.store.remove("annotation", id, context.identity));
  return sendJson(res, 200, { Id: canonical(id) });
}

async function handleAnnotation(req, res, id, context) {
  if (!["GET", "HEAD"].includes(req.method)) fail("Annotation downloads require GET or HEAD.", 405);
  let note = null;
  try {
    note = GUID.test(id) ? await context.readProvider.get("annotation", id, context.identity) : null;
  } catch (error) {
    if (![403, 404].includes(error.status)) throw error;
  }
  if (!note) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    return res.end(req.method === "HEAD" ? undefined : "Not Found");
  }
  const bytes = Buffer.from(String(note.documentbody ?? ""), "base64");
  if (!bytes.length) {
    res.writeHead(204, { "cache-control": "private" });
    return res.end();
  }
  const type = note.mimetype || "application/octet-stream";
  const inline = /^image\/(gif|jpeg|png|tiff|bmp|x-icon)$/i.test(type);
  const name = encodeURIComponent(note.filename || "attachment").replace(/%20/g, "+");
  res.writeHead(200, {
    "content-type": type,
    "content-length": bytes.length,
    "content-disposition": `${inline ? "inline" : "attachment"};filename="${name}"`,
    "cache-control": context.identity?.contactId || context.identity?.id ? "private" : "public",
    "x-content-type-options": "nosniff",
  });
  res.end(req.method === "HEAD" ? undefined : bytes);
}

const downloads = new Map();
function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The signed-in contact's row (token claims read it regardless of table permissions). */
function contactRow(context) {
  const id = canonical(context.identity?.contactId ?? context.identity?.id);
  if (!id || typeof context.store?.snapshot !== "function") return null;
  const state = context.store.snapshot({ tables: ["contact"], mappings: ["contact"] });
  const idColumn = state.mappings?.contact?.idColumn ?? "contactid";
  return (state.tables?.contact ?? []).find((row) => canonical(row[idColumn]) === id) ?? null;
}

/**
 * Ad and poll services (legacy CmsAreaRegistration routes): /_services/ads/{site}/{id},
 * /_services/ads/{site}/placements/{id}[/random] and the poll equivalents render the ad or
 * poll through the portal's Liquid ad/poll rendering (its web template or the default
 * markup). A placement renders its first active item (the platform picks a random one).
 */
async function serveCommunityPlacement(req, res, url, context, websiteId) {
  const route = /^\/_services\/(ads|polls)\/([^/]+)\/(?:placements\/([^/]+)(?:\/random)?|([^/]+))\/?$/i.exec(url.pathname);
  if (!route || canonical(route[2]) !== websiteId || typeof context.renderLiquid !== "function") return false;
  if (!["GET", "HEAD", "POST"].includes(req.method)) return false;
  const [, kind, , placement, item] = route;
  if (!placement && /^submitpoll$/i.test(item ?? "")) return false;
  let key;
  try {
    key = decodeURIComponent(placement ?? item);
  } catch {
    return false;
  }
  if (!/^[\w .-]{1,200}$/.test(key)) return false;
  const variable = kind.toLowerCase() === "ads" ? (placement ? "ad_placement_name" : "ad_name") : placement ? "poll_placement_name" : "poll_name";
  const tag = kind.toLowerCase() === "ads" ? "mirage_ad" : "mirage_poll";
  // The controllers render with the full portal view context (resx, snippets, settings, now).
  const request = { url: url.href, path: url.pathname, params: Object.fromEntries(url.searchParams), method: req.method };
  const base = typeof context.pageContext === "function" ? context.pageContext(url.pathname + url.search) : { user: context.identity };
  const html = await context.renderLiquid(`{% assign ${variable} = "${key}" %}{% ${tag} %}`, { ...base, request: { ...(base.request ?? {}), ...request } });
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
  res.end(req.method === "HEAD" ? undefined : html);
  return true;
}

/** The anti-forgery cookie token the platform issues with each token refresh. */
export function antiForgeryCookie(csrf) {
  const value = createHmac("sha256", String(csrf ?? "")).update("__RequestVerificationToken").digest("base64url");
  return `__RequestVerificationToken=${value}; path=/; secure; HttpOnly; SameSite=None`;
}

/**
 * Dispatch native portal services. Returns true when the request was handled.
 * The caller supplies the current portal, store, providers and persona.
 */
export async function handleNativeService(req, res, url, context) {
  const staticAsset = STATIC.get(url.pathname);
  if (staticAsset) {
    if (!["GET", "HEAD"].includes(req.method)) return false;
    const body = await fs.readFile(fileURLToPath(staticAsset));
    res.writeHead(200, {
      "content-type": staticType(url.pathname),
      "cache-control": "no-cache",
      "x-sim-resource-provider": "local-compatibility",
    });
    res.end(req.method === "HEAD" ? undefined : body);
    return true;
  }
  if (context.config?.pageMode === "live") return false;
  const annotation = /^\/_entity\/annotation\/([0-9a-f-]{36})(?:\/(?:documentbody|[0-9a-f-]{36}))?\/?$/i.exec(url.pathname);
  if (annotation) {
    try {
      await handleAnnotation(req, res, annotation[1], context);
    } catch (error) {
      sendError(res, error);
    }
    return true;
  }
  const websiteId = canonical(context.portal.website?.id);
  if (await serveNativeEquivalent(req, res, url, context, websiteId)) return true;
  if (await handleODataFeed(req, res, url, context)) return true;
  if (await handleImplicitGrant(req, res, url, { portal: context.portal, identity: context.identity, contact: contactRow(context), origin: context.origin })) return true;
  if (await serveCommunityPlacement(req, res, url, context, websiteId)) return true;
  const quick = /^\/_portal\/quickform-template-path\/([0-9a-f-]{36})\/?$/i.exec(url.pathname);
  if (quick) {
    if (canonical(quick[1]) !== websiteId) return false;
    try {
      if (!["GET", "HEAD"].includes(req.method)) fail("Quick view forms require GET.", 405, "MethodNotAllowed");
      const body = await renderQuickForm({
        portal: context.portal,
        schemas: context.schemas,
        store: context.store,
        readProvider: context.readProvider,
        identity: context.identity,
        params: Object.fromEntries(url.searchParams),
      });
      const styles = (context.portal.webFiles ?? [])
        .filter((file) => /bootstrap(?:\.min)?\.css$/i.test(file.url ?? ""))
        .map((file) => `<link rel="stylesheet" href="${xmlEscape(file.url)}">`)
        .join("");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Quick view</title>${styles}</head><body><form id="content_form"><div id="content-container">${body}</div></form></body></html>`);
    } catch (error) {
      res.writeHead(error.status ?? 500, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(`<!doctype html><title>Quick view</title><p role="alert">${xmlEscape(error.message)}</p>`);
    }
    return true;
  }
  const token = /^\/_portal\/([^/]+)\/Layout\/GetAntiForgeryToken\/?$/i.exec(url.pathname);
  if (token) {
    if (canonical(token[1]) !== websiteId) return false;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "set-cookie": antiForgeryCookie(context.csrf) });
    res.end(`<input name="__RequestVerificationToken" type="hidden" value="${xmlEscape(context.csrf)}" />`);
    return true;
  }
  const match = SERVICE.exec(url.pathname);
  if (!match) return false;
  const [, action, scope] = match;
  if (canonical(scope) !== websiteId) return false;
  const handled = new Set([
    "entity-grid-data.json",
    "entity-subgrid-data.json",
    "entity-lookup-grid-data.json",
    "entity-grid-delete",
    "entity-lookup-associate",
    "entity-grid-disassociate",
    "action-deactivate",
    "action-activate",
    "download-as-csv",
    "download-as-excel",
    "execute-workflow",
    "entity-notes",
    "entity-form-addnote",
    "entity-form-updatenote",
    "entity-form-deletenote",
  ]);
  if (!handled.has(action.toLowerCase())) return false;
  try {
    const normalized = action.toLowerCase();
    if (/^download-as-(csv|excel)$/.test(normalized) && req.method === "GET") {
      const key = url.searchParams.get("key");
      const file = key ? downloads.get(key) : null;
      if (!file) {
        res.writeHead(204);
        res.end();
        return true;
      }
      downloads.delete(key);
      res.writeHead(200, {
        "content-type": file.type,
        "content-disposition": `attachment; filename="${file.name.replace(/"/g, "")}"`,
        "content-length": file.body.length,
        "cache-control": "no-store",
      });
      res.end(file.body);
      return true;
    }
    if (req.method !== "POST") fail("Native portal services require POST.", 405, "MethodNotAllowed");
    verifyToken(req, context.csrf);
    if (/^entity-(notes|form-addnote|form-updatenote|form-deletenote)$/.test(normalized)) {
      await handleNotes(normalized, req, res, context);
      return true;
    }
    const body = await readJson(req);
    if (/^entity-(grid|subgrid|lookup-grid)-data\.json$/.test(normalized)) {
      const secure = unprotectConfiguration(body.base64SecureConfiguration);
      if (canonical(secure.w) !== websiteId) fail("Invalid_Request", 403, "Invalid_Request");
      const expected = { "entity-grid-data.json": ["list"], "entity-subgrid-data.json": ["subgrid", "associate"], "entity-lookup-grid-data.json": ["lookup"] }[normalized];
      if (!expected.includes(secure.t)) fail("Invalid_Request", 403, "Invalid_Request");
      const model = modelFor(secure, context);
      if (model.kind === "subgrid" && model.definition && secure.parent) {
        if (!(await context.readProvider.get(model.schema.entity, secure.parent, context.identity)))
          return sendJson(res, 200, { AccessDenied: true }), true;
      }
      const data = await gridData(model, body, { ...context, secure, timezoneOffset: Number(body.timezoneOffset) || 0 });
      sendJson(res, 200, data);
      return true;
    }
    if (normalized === "entity-grid-delete") {
      const entity = body.LogicalName ?? body.logicalName;
      const id = body.Id ?? body.id;
      if (!safeName(entity) || !GUID.test(String(id ?? ""))) fail("Invalid_Request", 400, "Invalid_Request");
      // A form subgrid delete must name its declared grid; plain list and form
      // deletes rely on the table permission of the current persona.
      if (body.base64SecureConfiguration) {
        const secure = unprotectConfiguration(body.base64SecureConfiguration);
        if (secure.t === "subgrid") {
          await context.change(() =>
            deletePortalSubgridRecord(secure.kind, secure.form, secure.grid, id, { parentId: secure.parent, stepId: secure.step }, {
              portal: context.portal,
              store: context.store,
              schemas: context.schemas,
              identity: context.identity,
              readProvider: context.readProvider,
              writeProvider: { delete: (table, rowId) => writeOperation(context, "delete", table, rowId) },
            }),
          );
          res.writeHead(204);
          res.end();
          return true;
        }
      }
      await context.change(() => writeOperation(context, "delete", entity, id));
      res.writeHead(204);
      res.end();
      return true;
    }
    if (normalized === "action-deactivate" || normalized === "action-activate") {
      const entity = body.LogicalName ?? body.logicalName;
      const id = body.Id ?? body.id;
      if (!safeName(entity) || !GUID.test(String(id ?? ""))) fail("Invalid_Request", 400, "Invalid_Request");
      const state = normalized === "action-deactivate" ? 1 : 0;
      await context.change(() =>
        writeOperation(context, "update", entity, id, { statecode: state, statuscode: defaultStatus(context.metadata, entity, state) }),
      );
      res.writeHead(204);
      res.end();
      return true;
    }
    if (normalized === "entity-lookup-associate" || normalized === "entity-grid-disassociate") {
      const target = body.Target ?? body.target ?? {};
      const relationship = body.Relationship ?? body.relationship ?? {};
      const related = body.RelatedEntities ?? body.relatedEntities ?? [];
      if (!safeName(target.LogicalName) || !GUID.test(String(target.Id ?? "")) || !Array.isArray(related) || !related.length)
        fail("Invalid_Request", 400, "Invalid_Request");
      const mapping = mappingFor(context.store, target.LogicalName);
      const navigation = Object.entries(mapping.relationships ?? {}).find(
        ([name, rel]) => rel.many && (name === relationship.SchemaName || rel.schemaName === relationship.SchemaName),
      );
      if (!navigation) fail("Missing_Permissions_For_Operation_Exception", 403, "RelationshipNotMapped");
      await context.change(async () => {
        for (const entry of related) {
          if (!GUID.test(String(entry.Id ?? ""))) fail("Invalid_Request", 400, "Invalid_Request");
          if (navigation[1].intersect)
            await associationOperation(context, normalized === "entity-lookup-associate", target.LogicalName, target.Id, navigation[0], navigation[1].entity, entry.Id);
          else
            await writeOperation(context, "update", navigation[1].entity, entry.Id, {
              [`${Object.entries(mappingFor(context.store, navigation[1].entity).relationships ?? {}).find(([, rel]) => rel.many === false && rel.from === navigation[1].to && rel.entity === canonical(target.LogicalName))?.[0] ?? navigation[1].to}@odata.bind`]:
                normalized === "entity-lookup-associate" ? `/${mapping.entitySet}(${target.Id})` : null,
            });
        }
      });
      res.writeHead(204);
      res.end();
      return true;
    }
    if (/^download-as-(csv|excel)$/.test(normalized)) {
      const secure = unprotectConfiguration(body.base64SecureConfiguration);
      if (canonical(secure.w) !== websiteId) fail("Invalid_Request", 403, "Invalid_Request");
      const model = modelFor(secure, context);
      // ADX downloads ignore the request's page and pageSize: page 1 of up to
      // Grid/Download/MaximumResults records (default 5000), read in 5000-record fetch pages
      // (docs/platform-internals-reference.md, download routes and §5.4 paging).
      const maximum = Math.max(1, Math.floor(Number(siteSetting(context.portal, "Grid/Download/MaximumResults")) || 5000));
      const records = [];
      for (let page = 1; records.length < maximum; page++) {
        const data = await gridData(model, { ...body, page, pageSize: Math.min(maximum, 5000), allowLargePages: true, download: true }, { ...context, secure });
        if (data.AccessDenied) {
          sendJson(res, 200, { AccessDenied: true });
          return true;
        }
        records.push(...(data.Records ?? []));
        if (!data.MoreRecords || !data.Records?.length) break;
      }
      const columns = (Array.isArray(body.columns) ? body.columns : []).filter((column) => column?.LogicalName && column.Type !== 1 && column.Type !== 2);
      const header = columns.map((column) => csvCell(String(column.Name ?? column.LogicalName).replace(/<[^>]*>/g, ""))).join(",");
      const lines = records.slice(0, maximum).map((record) => columns.map((column) => csvCell(record.Attributes.find((attribute) => attribute.Name === column.LogicalName)?.FormattedValue ?? "")).join(","));
      // Excel downloads are served as CSV with an explicit diagnostic header:
      // the local runtime does not generate Office Open XML workbooks.
      const key = `${new Date().toISOString().slice(0, 19)}|${String(body.viewName ?? "export").replace(/[\\/:*?"<>|]/g, "_")}.csv`;
      downloads.set(key, { type: "text/csv; charset=utf-8", name: key.split("|")[1], body: Buffer.from("﻿" + [header, ...lines].join("\r\n")) });
      if (downloads.size > 50) downloads.delete(downloads.keys().next().value);
      sendJson(res, 200, { success: true, sessionKey: key }, normalized === "download-as-excel" ? { "x-sim-download-format": "csv" } : {});
      return true;
    }
    if (normalized === "execute-workflow")
      fail("Classic workflows are not executed by the local runtime. Model the backend effect with a declarative plugin.", 501, "WorkflowUnsupported");
    return false;
  } catch (error) {
    sendError(res, error);
    return true;
  }
}
