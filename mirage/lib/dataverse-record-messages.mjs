// Record messages of the simulated Dataverse Web API: the Merge action and the
// InitializeFrom, CalculateRollupField, IsValidStateTransition and FormatAddress
// functions. install(api) registers them with the operation registry; each handler
// authorizes through api.principals and writes through api.store inside api.change.
import { DataError } from "./data-error.mjs";
import { parseEntityReference } from "./data.mjs";
import { contextUrl } from "./dataverse-odata.mjs";

// unverified: the Merge reference lists account and contact only; lead and incident follow the gap review.
const MERGE_TABLES = new Set(["account", "contact", "lead", "incident"]);
// Never copied by a merge: ownership, audit and state columns.
const SYSTEM_COLUMNS = new Set(["createdby", "createdon", "createdonbehalfby", "modifiedby", "modifiedon", "modifiedonbehalfby", "ownerid", "owninguser", "owningteam", "owningbusinessunit", "versionnumber", "statecode", "statuscode", "masterid"]);
const FIELD_TYPE_FLAG = { ValidForCreate: "validForCreate", ValidForUpdate: "validForUpdate", ValidForRead: "validForRead" };
const ROLLUP_SOURCE_TYPE = 2;
const EDM_OBJECT = "EdmEntityObject passed should have the key property value set.";
// unverified: 0x80040203 is assumed for every 400 below; the reference pages give no inner codes.
const INVALID = "0x80040203";

const invalid = (message, innerCode = INVALID) => new DataError(message, 400, "InvalidRequest", { innerCode });
const notFound = (logical, id) => new DataError(`${logical} With Id = ${id} Does Not Exist`, 404, "NotFound", { id, innerCode: "0x80040217" });
const sameId = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
const logicalOf = (type) => /^#?Microsoft\.Dynamics\.CRM\.(\w+)$/.exec(String(type ?? ""))?.[1] ?? null;
const stripOrigin = (text) => text.trim().replace(/^https?:\/\/[^/]+/i, "").replace(/^\/?api\/data\/v\d+\.\d+\//i, "");
const contextFor = (ctx, suffix) => contextUrl(ctx.origin, ctx.version, suffix);
const write = (api, fn) => api.change(() => api.store.transact(fn, { incremental: true }));
const authorize = (api, ctx, mapping, operation, row) =>
  api.principals.authorize({ user: ctx.user, entity: mapping.logicalName, operation, row, mapping });

// Entity-typed object: @odata.type names the table, its key column carries the id.
function typedRef(api, value, allowed = null) {
  const logical = logicalOf(value?.["@odata.type"]);
  if (!logical) throw invalid(EDM_OBJECT);
  if (allowed && !allowed.has(logical)) throw invalid(`Merge does not support the ${logical} table.`);
  const mapping = api.store.resolveMapping(logical);
  if (value[mapping.idColumn] == null) throw invalid(EDM_OBJECT);
  return { mapping, id: String(value[mapping.idColumn]) };
}

// Entity reference parameter: an @odata.id string or object, or a typed object.
function referenceOf(api, value, name) {
  if (value && typeof value === "object" && value["@odata.id"] === undefined) return typedRef(api, value);
  const ref = parseEntityReference(stripOrigin(String((value && typeof value === "object" ? value["@odata.id"] : value) ?? "")));
  if (!ref) throw invalid(`The ${name} parameter is not an entity reference.`, "0x80048d19");
  return { mapping: api.store.resolveMapping(ref.set), id: ref.id };
}

function rowOf(api, mapping, id) {
  const row = api.store.tableRows(mapping.logicalName).find((item) => sameId(item[mapping.idColumn], id));
  if (!row) throw notFound(mapping.logicalName, id);
  return row;
}

// The navigation on `child` that points at `parent` (optionally through column `column`); undefined when none.
function lookupNav(child, parent, column = null) {
  return Object.entries(child.relationships ?? {}).find(([key, rel]) =>
    rel.entity === parent && !rel.many && (column == null || (rel.from ?? key) === column))?.[0];
}

// unverified: entitymap/attributemap column names are not in the reference pages.
function attributeMaps(api, source, target) {
  const ids = new Set(api.store.tableRows("entitymap")
    .filter((row) => row.sourceentityname === source && row.targetentityname === target)
    .map((row) => String(row.entitymapid)));
  return api.store.tableRows("attributemap")
    .filter((row) => ids.has(String(row.entitymapid)))
    .map((row) => [row.sourceattributename, row.targetattributename]);
}

// unverified: validForUpdate and validForRead follow the validForCreate flag name on metadata definitions.
function allowedFor(api, mapping, column, fieldType) {
  if (fieldType === "All") return true;
  const definition = api.store.fieldDefinition(mapping.logicalName, column, api.metadataFields);
  return definition?.[FIELD_TYPE_FLAG[fieldType]] ?? true;
}

function fieldTypeOf(value) {
  const name = String(value ?? "").replace(/^.*'(\w+)'$/, "$1");
  if (name !== "All" && !Object.hasOwn(FIELD_TYPE_FLAG, name)) throw invalid(`The TargetFieldType ${value} is not valid.`);
  return name;
}

// Merge: the target gains the subordinate's empty values and UpdateContent; the subordinate
// is deactivated, takes masterid when declared, and its child rows move to the target.
// ponytail: PerformParentingChecks is accepted but the parent-mismatch check is not modelled.
async function merge(api, ctx) {
  const body = ctx.body ?? {};
  const target = typedRef(api, body.Target, MERGE_TABLES);
  const subordinate = typedRef(api, body.Subordinate, MERGE_TABLES);
  // unverified: the same-table and same-record rules are not on the Merge reference page.
  if (target.mapping.logicalName !== subordinate.mapping.logicalName) throw invalid("Target and Subordinate must be records of the same table.");
  if (sameId(target.id, subordinate.id)) throw invalid("Target and Subordinate must be different records.");
  const { mapping } = target;
  const idColumn = mapping.idColumn;
  const fields = mapping.fields ?? {};
  const targetRow = rowOf(api, mapping, target.id);
  const subRow = rowOf(api, mapping, subordinate.id);
  authorize(api, ctx, mapping, "update", targetRow);
  authorize(api, ctx, mapping, "update", subRow);

  const copied = Object.fromEntries(Object.keys(fields)
    .filter((name) => name !== idColumn && !SYSTEM_COLUMNS.has(name) && subRow[name] != null && targetRow[name] == null)
    .map((name) => [name, subRow[name]]));
  const content = Object.fromEntries(Object.entries(body.UpdateContent ?? {})
    .filter(([name]) => !name.startsWith("@") && name !== idColumn && Object.hasOwn(fields, name)));
  const subordinateChanges = { statecode: 1 };
  if (Object.hasOwn(fields, "masterid")) subordinateChanges.masterid = target.id;

  const children = [];
  for (const [, rel] of Object.entries(mapping.relationships ?? {})) {
    if (!rel.many || rel.intersect) continue;
    const childMapping = api.store.resolveMapping(rel.entity);
    const nav = lookupNav(childMapping, mapping.logicalName, rel.to) ?? rel.to;
    for (const row of api.store.tableRows(childMapping.logicalName)) {
      if (sameId(row[rel.to], subRow[rel.from ?? idColumn])) children.push({ childMapping, row, nav });
    }
  }
  for (const child of children) authorize(api, ctx, child.childMapping, "append", child.row);

  await write(api, () => {
    api.store.updateRecord(mapping.logicalName, targetRow[idColumn], { ...copied, ...content }, ctx.identity);
    api.store.updateRecord(mapping.logicalName, subRow[idColumn], subordinateChanges, ctx.identity);
    for (const { childMapping, row, nav } of children) {
      api.store.updateRecord(childMapping.logicalName, row[childMapping.idColumn], { [`${nav}@odata.bind`]: `${mapping.entitySet}(${target.id})` }, ctx.identity);
    }
  });
  return { status: 204 };
}

// InitializeFrom: the new record's data as a body; the parental lookup bind comes first.
async function initializeFrom(api, ctx) {
  const params = ctx.params ?? {};
  const source = referenceOf(api, params.EntityMoniker, "EntityMoniker");
  const target = api.store.resolveMapping(String(params.TargetEntityName ?? ""));
  const fieldType = fieldTypeOf(params.TargetFieldType);
  const sourceRow = rowOf(api, source.mapping, source.id);
  authorize(api, ctx, source.mapping, "read", sourceRow);

  const data = {};
  if (String(params.SkipParentalRelationshipMapping) !== "true") {
    const nav = lookupNav(target, source.mapping.logicalName);
    if (nav) data[`${nav}@odata.bind`] = `${source.mapping.entitySet}(${source.id})`;
  }
  for (const [from, to] of attributeMaps(api, source.mapping.logicalName, target.logicalName)) {
    if (sourceRow[from] != null && allowedFor(api, target, to, fieldType)) data[to] = sourceRow[from];
  }
  // unverified: Preference-Applied is taken from the Dataverse return=representation convention.
  return {
    status: 200,
    headers: { "Preference-Applied": "return=representation" },
    body: { "@odata.context": contextFor(ctx, `${target.entitySet}/$entity`), "@odata.type": `#Microsoft.Dynamics.CRM.${target.logicalName}`, ...data },
  };
}

// CalculateRollupField: reruns the column's FetchXML aggregate and stores the value with its date and state.
// unverified: the {id} placeholder, the aggregate alias convention and the Calculated state (1) are assumed.
async function calculateRollupField(api, ctx) {
  const params = ctx.params ?? {};
  const target = referenceOf(api, params.Target, "Target");
  const name = String(params.FieldName ?? "");
  const { mapping } = target;
  const row = rowOf(api, mapping, target.id);
  const definition = api.store.fieldDefinition(mapping.logicalName, name, api.metadataFields);
  if (definition?.SourceType !== ROLLUP_SOURCE_TYPE || !definition.formulaDefinition) throw invalid(`The ${name} column has no rollup definition.`);
  authorize(api, ctx, mapping, "update", row);

  const answer = await api.store.fetchXml(definition.formulaDefinition.replaceAll("{id}", target.id), ctx.identity);
  const value = answer.entities?.[0]?.[name] ?? null;
  const now = new Date(api.clock ? api.clock() : Date.now()).toISOString();
  await write(api, () => api.store.updateRecord(mapping.logicalName, row[mapping.idColumn], {
    [name]: value, [`${name}_date`]: now, [`${name}_state`]: 1,
  }, ctx.identity));
  return { status: 200, body: { "@odata.context": contextFor(ctx, `${mapping.entitySet}/$entity`), ...rowOf(api, mapping, target.id) } };
}

// IsValidStateTransition: the new status must exist, carry the proposed state and, when the
// current status lists TransitionData, be one of its allowed targets.
// unverified: TransitionData is read as an array of allowed status values; metadata today exports it as null.
async function isValidStateTransition(api, ctx) {
  const params = ctx.params ?? {};
  const entity = referenceOf(api, params.Entity, "Entity");
  const row = rowOf(api, entity.mapping, entity.id);
  authorize(api, ctx, entity.mapping, "read", row);

  const options = api.store.fieldDefinition(entity.mapping.logicalName, "statuscode", api.metadataFields)?.options ?? [];
  const status = Number(params.NewStatus);
  const next = options.find((option) => Number(option.value) === status);
  if (!next) throw new DataError(`The status ${params.NewStatus} is not valid for ${entity.mapping.logicalName}.`, 400, "InvalidValue", { innerCode: "0x80044331" });
  const current = options.find((option) => Number(option.value) === Number(row.statuscode));
  const allowed = current?.TransitionData;
  const isValid = String(next.state ?? 0) === String(params.NewState)
    && (!Array.isArray(allowed) || allowed.map(Number).includes(status));
  return { status: 200, body: { "@odata.context": contextFor(ctx, "Microsoft.Dynamics.CRM.IsValidStateTransitionResponse"), IsValid: isValid } };
}

// ponytail: US layout only; per-country formats need a table.
// unverified: the layout (street, city and state, postal code, country on separate lines) is the gap review's form.
async function formatAddress(api, ctx) {
  const params = ctx.params ?? {};
  const [line1, city, state, postal, country] = ["Line1", "City", "StateOrProvince", "PostalCode", "Country"].map((name) => {
    if (params[name] == null) throw invalid(`The ${name} parameter is required.`);
    return String(params[name]);
  });
  return {
    status: 200,
    body: { "@odata.context": contextFor(ctx, "Microsoft.Dynamics.CRM.FormatAddressResponse"), Address: `${line1}\r\n${city}, ${state} ${postal}\r\n${country}` },
  };
}

export function install(api) {
  const register = (name, kind, handle) => api.registry.register({ name, kind, binding: "unbound", handle: (ctx) => handle(api, ctx) });
  register("Merge", "action", merge);
  register("InitializeFrom", "function", initializeFrom);
  register("CalculateRollupField", "function", calculateRollupField);
  register("IsValidStateTransition", "function", isValidStateTransition);
  register("FormatAddress", "function", formatAddress);
}

export const EXTENSION = { name: "record-messages", install };
