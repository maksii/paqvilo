import { DataError } from "./data.mjs";
import { portalField } from "./importer.mjs";
import { contextualViewFetchXml, schemaFromFormXml } from "./platform.mjs";

const canonical = (value) =>
  String(value ?? "")
    .replace(/[{}]/g, "")
    .toLowerCase();
const scalar = (value) =>
  value && typeof value === "object" ? (value.id ?? value.value) : value;
const xmlEscape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c],
  );
const fail = (message, status = 400, code = "InvalidSubgridAction") => {
  throw new DataError(message, status, code);
};

export function subgridSettings(portal, definition, schema, gridId) {
  const metadata = portal.records?.find(
    (row) =>
      portalField(row, "subgrid_name") === gridId &&
      (schema.stepId
        ? canonical(portalField(row, "webformstep")) ===
          canonical(schema.stepId)
        : canonical(portalField(row, "entityform")) ===
          canonical(definition?.id)),
  );
  try {
    return JSON.parse(portalField(metadata ?? {}, "subgrid_settings", "{}"));
  } catch {
    fail(
      `Subgrid ${gridId} settings JSON is malformed`,
      501,
      "SUBGRID_SETTINGS_INVALID",
    );
  }
}

export function subgridUsesForm(action) {
  return (
    Boolean(action?.EntityFormId) &&
    (action.TargetType == null ||
      action.TargetType === "" ||
      Number(action.TargetType) === 0)
  );
}

export function subgridActionUrl(
  action,
  { portal, parentId, recordId, requestUrl = "http://localhost/" },
) {
  let target;
  const type =
    action.TargetType == null || action.TargetType === ""
      ? null
      : Number(action.TargetType);
  if (subgridUsesForm(action)) {
    target = new URL(
      `/_portal/modal-form-template-path/${encodeURIComponent(portal.website.id)}`,
      requestUrl,
    );
    target.searchParams.set("entityformid", action.EntityFormId);
    if (parentId) target.searchParams.set("parentId", parentId);
  } else if ((type === 1 || type === null) && action.RedirectWebpageId) {
    const page = portal.pages.find(
      (row) => canonical(row.id) === canonical(action.RedirectWebpageId),
    );
    if (!page)
      fail(
        "Subgrid action target page is not exported",
        501,
        "SUBGRID_PAGE_REQUIRED",
      );
    target = new URL(page.url, requestUrl);
  } else if ((type === 2 || type === null) && action.RedirectUrl)
    target = new URL(action.RedirectUrl, requestUrl);
  else return null;
  if (
    !["http:", "https:"].includes(target.protocol) ||
    target.username ||
    target.password
  )
    fail(
      "Subgrid redirect requires an HTTP page URL",
      501,
      "SUBGRID_REDIRECT_INVALID",
    );
  const value = recordId ?? parentId;
  if (value)
    target.searchParams.set(
      action.RecordIdQueryStringParameterName || "id",
      value,
    );
  const origin = new URL(requestUrl).origin;
  return target.origin === origin
    ? target.pathname + target.search
    : target.href;
}

/** Author-owned action conditions are evaluated by the same permission-trimmed read provider. */
export async function subgridActionApplies(
  action,
  { entity, idColumn, recordId, readProvider, identity, context = {} },
) {
  if (!action.FilterCriteria) return true;
  const source = action.FilterCriteria;
  const match = /<entity\b[^>]*\bname\s*=\s*(["'])(.*?)\1[^>]*>/i.exec(source);
  if (!match || canonical(match[2]) !== canonical(entity))
    fail(
      "Subgrid action filter must target its exported table",
      501,
      "SUBGRID_FILTER_INVALID",
    );
  const xml = source.replace(
    match[0],
    `${match[0]}<filter type="and"><condition attribute="${xmlEscape(idColumn)}" operator="eq" value="${xmlEscape(recordId)}"/></filter>`,
  );
  const result = await readProvider.fetchXml(
    contextualViewFetchXml(xml, { ...context, identity }),
    identity,
  );
  return (result.entities ?? result.value ?? []).some(
    (row) => canonical(row[idColumn]) === canonical(recordId),
  );
}

/** Native grid deletes require a declared action and a currently related, readable child. */
export async function deletePortalSubgridRecord(
  kind,
  componentId,
  gridId,
  rowId,
  body,
  {
    portal,
    store,
    schemas = {},
    identity = {},
    readProvider = store,
    writeProvider = store,
  },
) {
  if (!["entityform", "webform"].includes(kind))
    fail("Native grid form kind is unsupported", 404);
  const definition = (
    kind === "webform" ? portal.advancedForms : portal.forms
  )?.find((row) => canonical(row.id) === canonical(componentId));
  if (!definition)
    fail("Native grid form is not exported", 404, "FormNotFound");
  let schema = schemas[definition.id] ?? schemas[definition.name];
  if (!schema)
    fail("Native grid form schema is unresolved", 501, "FormSchemaRequired");
  if (schema.steps) {
    schema = schema.steps.find(
      (step) =>
        canonical(step.stepId) ===
        canonical(body?.stepId ?? schema.initialStepId),
    );
    if (!schema || schema.type === "redirect")
      fail("Native grid step is invalid", 400, "InvalidFormStep");
  } else if (body?.stepId)
    fail("Basic forms do not accept an advanced step", 400, "InvalidFormStep");
  if (schema.formXml)
    schema = { ...schema, ...schemaFromFormXml(schema.formXml, schema) };
  const parentId = schema.recordId ?? body?.parentId;
  if (!parentId || !rowId)
    fail("Native grid delete requires parent and row identifiers");
  if (
    schema.recordId &&
    canonical(schema.recordId) !== canonical(body?.parentId)
  )
    fail(
      "Native grid parent differs from its form",
      403,
      "SubgridParentMismatch",
    );
  const cells =
    schema.layout?.flatMap((tab) =>
      tab.columns.flatMap((column) =>
        column.sections.flatMap((section) => section.rows.flat()),
      ),
    ) ?? [];
  const cell = cells.find(
    (cell) => cell.type === "subgrid" && cell.id === gridId,
  );
  if (!cell)
    fail("Grid is not bound to the exported form", 403, "SubgridNotBound");
  const mapping = store.resolveMapping(schema.entity);
  const [navigation, relation] =
    Object.entries(mapping.relationships ?? {}).find(
      ([name, relation]) =>
        name === cell.relationship || relation.schemaName === cell.relationship,
    ) ?? [];
  if (!relation?.many || relation.entity !== cell.entity)
    fail(
      "Native grid relationship is unresolved",
      501,
      "SubgridRelationshipRequired",
    );
  const parent = await readProvider.get(schema.entity, parentId, identity);
  const row = await readProvider.get(cell.entity, rowId, identity);
  if (!parent || !row)
    fail(
      "Native grid parent or row does not exist",
      404,
      "SubgridRecordNotFound",
    );
  let related;
  if (relation.intersect) {
    const result = await readProvider.query(
      schema.entity,
      { $filter: `${mapping.idColumn} eq ${parentId}`, $expand: navigation },
      identity,
    );
    related = result.value?.some((parent) =>
      parent[navigation]?.some(
        (child) =>
          canonical(child[store.resolveMapping(cell.entity).idColumn]) ===
          canonical(rowId),
      ),
    );
  } else
    related =
      scalar(parent[relation.from]) != null &&
      canonical(scalar(parent[relation.from])) ===
        canonical(scalar(row[relation.to]));
  if (!related)
    fail(
      "Native grid row is not related to its selected parent",
      403,
      "SubgridRowNotRelated",
    );
  const settings = subgridSettings(portal, definition, schema, gridId);
  const actions =
    settings.ItemActions?.filter(
      (action) => action.Type === "CrmEntityFormView-DeleteAction",
    ) ?? [];
  const targetMapping = store.resolveMapping(cell.entity);
  let enabled = false;
  for (const action of actions)
    if (
      await subgridActionApplies(action, {
        entity: cell.entity,
        idColumn: targetMapping.idColumn,
        recordId: rowId,
        readProvider,
        identity,
        context: { website: portal.website },
      })
    ) {
      enabled = true;
      break;
    }
  if (!enabled)
    fail(
      "Exported grid does not permit deletion of this row",
      403,
      "SubgridDeleteNotEnabled",
    );
  const remove = writeProvider.delete ?? writeProvider.remove;
  if (!remove)
    fail(
      "Native grid write provider cannot delete",
      501,
      "SubgridDeleteProviderRequired",
    );
  await remove.call(writeProvider, cell.entity, rowId, identity);
  return { deleted: true, id: rowId };
}
