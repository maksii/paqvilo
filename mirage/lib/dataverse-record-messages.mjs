// Record messages of the simulated Dataverse Web API: the Merge action and the
// InitializeFrom, CalculateRollupField, IsValidStateTransition and FormatAddress
// functions. install(api) registers them with the operation registry; each handler
// authorizes through api.principals and writes through api.store inside api.change.
// Stored lookups are { id, logical_name, name } objects; exported metadata keeps column
// facts under columnMetadata. Secured columns pass through api.fieldSecurity?.mask.
import { DataError } from "./data-error.mjs";
import { parseEntityReference } from "./data.mjs";
import { contextUrl, preferenceApplied } from "./dataverse-odata.mjs";
import { relationshipsOf } from "./dataverse-standard.mjs";

// Only account and contact are documented for Merge; lead and incident are assumed to merge too.
const MERGE_TABLES = new Set(["account", "contact", "lead", "incident"]);
// Never copied by a merge: ownership, audit and state columns.
const SYSTEM_COLUMNS = new Set(["createdby", "createdon", "createdonbehalfby", "modifiedby", "modifiedon", "modifiedonbehalfby", "ownerid", "owninguser", "owningteam", "owningbusinessunit", "versionnumber", "statecode", "statuscode", "masterid"]);
const FIELD_TYPE_FLAG = { ValidForCreate: "validForCreate", ValidForUpdate: "validForUpdate", ValidForRead: "validForRead" };
// TargetFieldType enum: All = 0, ValidForCreate = 1, ValidForUpdate = 2, ValidForRead = 3.
const TARGET_FIELD_TYPES = ["All", "ValidForCreate", "ValidForUpdate", "ValidForRead"];
const LOOKUP_TYPES = new Set(["lookup", "customer", "owner"]);
const ROLLUP_SOURCE_TYPE = 2;
const EDM_OBJECT = "EdmEntityObject passed should have the key property value set.";
// 0x80040203 is a guess for every 400 below; the reference pages give no inner codes.
const INVALID = "0x80040203";

const invalid = (message, innerCode = INVALID) => new DataError(message, 400, "InvalidRequest", { innerCode });
const notFound = (logical, id) => new DataError(`${logical} With Id = ${id} Does Not Exist`, 404, "NotFound", { id, innerCode: "0x80040217" });
const refId = (value) => (value !== null && typeof value === "object" ? value.id : value);
const sameId = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase() && a != null && b != null;
const enumValue = (value) => (value !== null && typeof value === "object" ? value.Value : value);
const logicalOf = (type) => /^#?Microsoft\.Dynamics\.CRM\.(\w+)$/.exec(String(type ?? ""))?.[1] ?? null;
const stripOrigin = (text) => text.trim().replace(/^https?:\/\/[^/]+/i, "").replace(/^\/?api\/data\/v\d+\.\d+\//i, "");
const contextFor = (ctx, suffix) => contextUrl(ctx.origin, ctx.version, suffix);
const write = (api, fn) => api.change(() => api.store.transact(fn, { incremental: true }));
const authorize = (api, ctx, mapping, operation, row) =>
  api.principals.authorize({ user: ctx.user, entity: mapping.logicalName, operation, row, mapping });
// Exported metadata nests column facts under columnMetadata; runtime definitions may hold them at the top level.
const facts = (definition) => ({ ...definition, ...(definition?.columnMetadata ?? {}) });
const fieldOf = (api, mapping, column) => facts(api.store.fieldDefinition(mapping.logicalName, column, api.metadataFields));
// Secured columns the caller cannot read are nulled; without a fieldSecurity module the row passes through.
// Every use is an answer the caller receives, so masking rules apply as on a collection read (no UnMaskedData here).
const maskRow = (api, ctx, logical, row) => api.fieldSecurity?.mask?.(ctx.user, logical, row, { view: { unmask: false, single: false } }) ?? row;

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
function lookupNav(api, child, parent, column = null) {
  return Object.entries(relationshipsOf(api.store, child.logicalName, child.relationships)).find(([key, rel]) =>
    rel.entity === parent && !rel.many && (column == null || (rel.from ?? key) === column))?.[0];
}

// "<nav>@odata.bind" on a many:false navigation of the mapping; null for any other key.
function lookupBindNav(api, mapping, name) {
  const nav = /^(\w+)@odata\.bind$/.exec(name)?.[1];
  const relationships = relationshipsOf(api.store, mapping.logicalName, mapping.relationships);
  return nav && Object.hasOwn(relationships, nav) && !relationships[nav].many ? nav : null;
}

// The entitymap/attributemap column names are not documented; they are guesses.
function attributeMaps(api, source, target) {
  const ids = new Set(api.store.tableRows("entitymap")
    .filter((row) => row.sourceentityname === source && row.targetentityname === target)
    .map((row) => String(refId(row.entitymapid)).toLowerCase()));
  return api.store.tableRows("attributemap")
    .filter((row) => ids.has(String(refId(row.entitymapid)).toLowerCase()))
    .map((row) => [row.sourceattributename, row.targetattributename]);
}

// Assumed: validForUpdate and validForRead follow the validForCreate flag name on metadata definitions.
function allowedFor(api, mapping, column, fieldType) {
  if (fieldType === "All") return true;
  return fieldOf(api, mapping, column)[FIELD_TYPE_FLAG[fieldType]] ?? true;
}

// Accepts the enum name, the enum value (0-3) or the qualified name, e.g. Microsoft.Dynamics.CRM.TargetFieldType'ValidForCreate'.
function fieldTypeOf(value) {
  const text = String(value ?? "").replace(/^.*'(\w+)'$/, "$1");
  if (/^[0-3]$/.test(text)) return TARGET_FIELD_TYPES[Number(text)];
  if (TARGET_FIELD_TYPES.includes(text)) return text;
  throw invalid(`The TargetFieldType ${value} is not valid.`);
}

// Merge: the target gains the subordinate's empty values and UpdateContent; the subordinate
// is deactivated, takes masterid when declared, and its child rows move to the target.
// ponytail: the missing-parent variant of PerformParentingChecks (async cascade docs) is not modelled.
async function merge(api, ctx) {
  const body = ctx.body ?? {};
  const target = typedRef(api, body.Target, MERGE_TABLES);
  const subordinate = typedRef(api, body.Subordinate, MERGE_TABLES);
  // The same-table and same-record rules are not documented; they are guesses.
  if (target.mapping.logicalName !== subordinate.mapping.logicalName) throw invalid("Target and Subordinate must be records of the same table.");
  if (sameId(target.id, subordinate.id)) throw invalid("Target and Subordinate must be different records.");
  // The reference marks PerformParentingChecks as required.
  if (typeof body.PerformParentingChecks !== "boolean") throw invalid("The PerformParentingChecks parameter is required.");
  const { mapping } = target;
  const idColumn = mapping.idColumn;
  const fields = mapping.fields ?? {};
  const targetRow = rowOf(api, mapping, target.id);
  const subRow = rowOf(api, mapping, subordinate.id);
  // Merge has no documented privilege of its own: update on both records and append on moved children are checked.
  authorize(api, ctx, mapping, "update", targetRow);
  authorize(api, ctx, mapping, "update", subRow);

  if (body.PerformParentingChecks) {
    // Only "check if the parent information is different" is documented; two different non-null values on the table's self lookup
    // are taken to conflict.
    for (const [nav, rel] of Object.entries(relationshipsOf(api.store, mapping.logicalName, mapping.relationships))) {
      if (rel.many || rel.entity !== mapping.logicalName) continue;
      const column = rel.from ?? nav;
      const left = refId(targetRow[column]);
      const right = refId(subRow[column]);
      if (left != null && right != null && !sameId(left, right)) throw invalid("The Target and Subordinate records have different parent records.");
    }
  }

  const copied = Object.fromEntries(Object.keys(fields)
    .filter((name) => name !== idColumn && !SYSTEM_COLUMNS.has(name) && subRow[name] != null && targetRow[name] == null)
    .map((name) => [name, subRow[name]]));
  // The incident merge ignores UpdateContent (reference: Merge behavior for incident).
  const contentAllowed = (name) => !name.startsWith("@") && name !== idColumn && (Object.hasOwn(fields, name) || lookupBindNav(api, mapping, name) !== null);
  const content = mapping.logicalName === "incident" ? {} : Object.fromEntries(Object.entries(body.UpdateContent ?? {}).filter(([name]) => contentAllowed(name)));
  const subordinateChanges = { statecode: 1 };
  if (Object.hasOwn(fields, "masterid")) subordinateChanges.masterid = target.id;

  const children = [];
  for (const [, rel] of Object.entries(relationshipsOf(api.store, mapping.logicalName, mapping.relationships))) {
    if (!rel.many || rel.intersect) continue;
    const childMapping = api.store.resolveMapping(rel.entity);
    const nav = lookupNav(api, childMapping, mapping.logicalName, rel.to) ?? rel.to;
    for (const row of api.store.tableRows(childMapping.logicalName)) {
      if (sameId(refId(row[rel.to]), refId(subRow[rel.from ?? idColumn]))) children.push({ childMapping, row, nav });
    }
  }
  for (const child of children) authorize(api, ctx, child.childMapping, "append", child.row);

  // The three writes run the record pipeline (hooks, column security, audit, plug-in steps, modifiedby and version stamps);
  // the privileges were checked above. Without an organization (a bare store) there is no pipeline to run.
  const updated = (logical, id, data) => api.records?.updateInternal
    ? api.records.updateInternal(ctx, logical, id, data, { authorized: true })
    : api.store.updateRecordAsync(logical, id, data, ctx.identity);
  await write(api, async () => {
    await updated(mapping.logicalName, targetRow[idColumn], { ...copied, ...content });
    await updated(mapping.logicalName, subRow[idColumn], subordinateChanges);
    for (const { childMapping, row, nav } of children) {
      await updated(childMapping.logicalName, row[childMapping.idColumn], { [`${nav}@odata.bind`]: `${mapping.entitySet}(${target.id})` });
    }
  });
  return { status: 204 };
}

// InitializeFrom: the new record's data as a body; the parental lookup bind comes first.
// A stored lookup on the source becomes its navigation bind on the target.
async function initializeFrom(api, ctx) {
  const params = ctx.params ?? {};
  const source = referenceOf(api, params.EntityMoniker, "EntityMoniker");
  const target = api.store.resolveMapping(String(params.TargetEntityName ?? ""));
  const fieldType = fieldTypeOf(params.TargetFieldType);
  const sourceRow = rowOf(api, source.mapping, source.id);
  authorize(api, ctx, source.mapping, "read", sourceRow);
  // Secured source columns the caller cannot read are not copied.
  const visible = maskRow(api, ctx, source.mapping.logicalName, sourceRow);

  const data = {};
  if (String(params.SkipParentalRelationshipMapping) !== "true") {
    const nav = lookupNav(api, target, source.mapping.logicalName);
    if (nav) data[`${nav}@odata.bind`] = `${source.mapping.entitySet}(${source.id})`;
  }
  for (const [from, to] of attributeMaps(api, source.mapping.logicalName, target.logicalName)) {
    const value = visible[from];
    if (value == null || !allowedFor(api, target, to, fieldType)) continue;
    const field = fieldOf(api, target, to);
    if (LOOKUP_TYPES.has(field.dataverseType) && typeof value === "object" && value.id != null && value.logical_name) {
      const nav = lookupNav(api, target, value.logical_name, to) ?? to;
      data[`${nav}@odata.bind`] = `${api.store.resolveMapping(value.logical_name).entitySet}(${value.id})`;
    } else {
      data[to] = value;
    }
  }
  // Preference-Applied echoes the Prefer the request sent; none when it sent none.
  const applied = preferenceApplied(ctx.prefer);
  return {
    status: 200,
    headers: applied ? { "Preference-Applied": applied } : {},
    body: {
      "@odata.context": contextFor(ctx, `${target.entitySet}/$entity`),
      "@odata.type": `#Microsoft.Dynamics.CRM.${target.logicalName}`,
      ...maskRow(api, ctx, target.logicalName, data),
    },
  };
}

// CalculateRollupField: recalculates through api.rollups.recalculate when dataverse-rollup.mjs is installed; otherwise reruns
// the column's FetchXML aggregate and stores the value with its date and state.
// Reads under the read privilege and keeps modifiedon. ponytail: the aggregate itself ignores FLS.
// The {id} placeholder, the aggregate alias convention and the Calculated state (1) are assumed.
async function calculateRollupField(api, ctx) {
  const params = ctx.params ?? {};
  const target = referenceOf(api, params.Target, "Target");
  const name = String(params.FieldName ?? "");
  const { mapping } = target;
  const row = rowOf(api, mapping, target.id);
  const definition = fieldOf(api, mapping, name);
  if (Number(enumValue(definition.sourceType)) !== ROLLUP_SOURCE_TYPE || !definition.formulaDefinition) throw invalid(`The ${name} column has no rollup definition.`);
  authorize(api, ctx, mapping, "read", row);

  // dataverse-rollup.mjs, when installed, owns the evaluation (pack rollups, its subset parser and the state-2 diagnostics).
  let result;
  if (api.rollups?.recalculate) result = await api.rollups.recalculate(mapping.logicalName, row[mapping.idColumn], name);
  else {
    const answer = await api.store.fetchXml(definition.formulaDefinition.replaceAll("{id}", target.id), ctx.identity);
    result = { value: answer.entities?.[0]?.[name] ?? null, date: new Date(api.clock ? api.clock() : Date.now()).toISOString(), state: 1 };
    const values = { [name]: result.value, [`${name}_date`]: result.date, [`${name}_state`]: result.state };
    const kept = { systemColumns: { modifiedon: row.modifiedon } };
    await write(api, () => api.records?.updateInternal
      ? api.records.updateInternal(ctx, mapping.logicalName, row[mapping.idColumn], values, { authorized: true, writeOptions: kept })
      : api.store.updateRecordAsync(mapping.logicalName, row[mapping.idColumn], values, ctx.identity, kept));
  }
  const payload = maskRow(api, ctx, mapping.logicalName, {
    [mapping.idColumn]: row[mapping.idColumn], [name]: result.value, [`${name}_date`]: result.date, [`${name}_state`]: result.state,
  });
  return { status: 200, body: { "@odata.context": contextFor(ctx, `${mapping.entitySet}/$entity`), ...payload } };
}

// IsValidStateTransition: the new status must exist, carry the proposed state and, when the
// current status lists TransitionData, be one of its allowed targets. NewState is the statecode
// value as a string, or the invariant name or label of that statecode option.
// TransitionData is assumed to be an array of allowed status values; the exported metadata carries it as null.
// Exported: dataverse-state-transitions.mjs calls this evaluator for its enforced-table answer.
export async function isValidStateTransition(api, ctx) {
  const params = ctx.params ?? {};
  const entity = referenceOf(api, params.Entity, "Entity");
  const row = rowOf(api, entity.mapping, entity.id);
  authorize(api, ctx, entity.mapping, "read", row);

  const options = fieldOf(api, entity.mapping, "statuscode").options ?? [];
  const status = Number(params.NewStatus);
  const next = options.find((option) => Number(option.value) === status);
  // 0x8004F00E (InvalidStateCodeStatusCode) for an unknown status is a guess (0x80044331 is StringLengthTooLong, not a status error).
  if (!next) throw new DataError(`The status ${params.NewStatus} is not valid for ${entity.mapping.logicalName}.`, 400, "InvalidValue", { innerCode: "0x8004F00E" });
  const current = options.find((option) => Number(option.value) === Number(row.statuscode));
  const allowed = current?.TransitionData;
  const stateValue = Number(next.state ?? 0);
  const stateOption = (fieldOf(api, entity.mapping, "statecode").options ?? []).find((option) => Number(option.value) === stateValue);
  const wanted = String(params.NewState ?? "").toLowerCase();
  const stateMatches = wanted === String(stateValue)
    || [stateOption?.invariantName, stateOption?.label].some((name) => name != null && String(name).toLowerCase() === wanted);
  const isValid = stateMatches && (!Array.isArray(allowed) || allowed.map(Number).includes(status));
  return { status: 200, body: { "@odata.context": contextFor(ctx, "Microsoft.Dynamics.CRM.IsValidStateTransitionResponse"), IsValid: isValid } };
}

// ponytail: US layout only; per-country formats need a table.
// The layout (street, city and state, postal code, country on separate lines) is a guess.
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

// CSDL per operation; the registry joins the fragments into the service schema.
// The mscrm entity and enum names are assumed to be declared elsewhere in the schema.
const csdlOf = (tag, name, parameters, returns = null) => [
  `<${tag} Name="${name}">`,
  ...parameters.map(([param, type]) => `  <Parameter Name="${param}" Type="${type}" />`),
  ...(returns ? [`  <ReturnType Type="${returns}" Nullable="false" />`] : []),
  `</${tag}>`,
].join("\n");
const responseType = (name, property, type) => `<ComplexType Name="${name}Response"><Property Name="${property}" Type="${type}" /></ComplexType>`;
const CSDL = {
  Merge: csdlOf("Action", "Merge", [["Target", "mscrm.crmbaseentity"], ["Subordinate", "mscrm.crmbaseentity"], ["UpdateContent", "mscrm.crmbaseentity"], ["PerformParentingChecks", "Edm.Boolean"]]),
  InitializeFrom: [
    '<EnumType Name="TargetFieldType"><Member Name="All" Value="0" /><Member Name="ValidForCreate" Value="1" /><Member Name="ValidForUpdate" Value="2" /><Member Name="ValidForRead" Value="3" /></EnumType>',
    csdlOf("Function", "InitializeFrom", [["EntityMoniker", "mscrm.crmbaseentity"], ["TargetEntityName", "Edm.String"], ["TargetFieldType", "mscrm.TargetFieldType"], ["SkipParentalRelationshipMapping", "Edm.Boolean"]], "mscrm.crmbaseentity"),
  ].join("\n"),
  CalculateRollupField: csdlOf("Function", "CalculateRollupField", [["Target", "mscrm.crmbaseentity"], ["FieldName", "Edm.String"]], "mscrm.crmbaseentity"),
  IsValidStateTransition: [
    responseType("IsValidStateTransition", "IsValid", "Edm.Boolean"),
    csdlOf("Function", "IsValidStateTransition", [["Entity", "mscrm.crmbaseentity"], ["NewState", "Edm.String"], ["NewStatus", "Edm.Int32"]], "mscrm.IsValidStateTransitionResponse"),
  ].join("\n"),
  FormatAddress: [
    responseType("FormatAddress", "Address", "Edm.String"),
    csdlOf("Function", "FormatAddress", [["Line1", "Edm.String"], ["City", "Edm.String"], ["StateOrProvince", "Edm.String"], ["PostalCode", "Edm.String"], ["Country", "Edm.String"]], "mscrm.FormatAddressResponse"),
  ].join("\n"),
};

export function install(api) {
  const register = (name, kind, handle, csdl) => api.registry.register({ name, kind, binding: "unbound", handle: (ctx) => handle(api, ctx), csdl });
  register("Merge", "action", merge, CSDL.Merge);
  register("InitializeFrom", "function", initializeFrom, CSDL.InitializeFrom);
  register("CalculateRollupField", "function", calculateRollupField, CSDL.CalculateRollupField);
  // dataverse-state-transitions.mjs answers through api.stateTransitions.isValid (which calls this evaluator) when installed.
  register("IsValidStateTransition", "function", (api, ctx) => api.stateTransitions?.isValid?.(ctx) ?? isValidStateTransition(api, ctx), CSDL.IsValidStateTransition);
  register("FormatAddress", "function", formatAddress, CSDL.FormatAddress);
}

export const EXTENSION = { name: "record-messages", install };
