// Metadata writes for the simulated Dataverse Web API: 1:N and N:N relationships, customer lookups,
// global option sets and the option actions. Each handler validates before it mutates the store, and
// mutates inside api.change. metadataWriteRoutes(api) feeds api.addRoute; metadataWriteOperations(api)
// feeds the operation registry. Metadata ids match dataverse-metadata.mjs (uuidV5 over the organization).
// unverified: marks messages, status codes and parameter rules that Microsoft Learn does not confirm.
import { DataError } from "./data-error.mjs";
import { contextUrl, entityUrl } from "./dataverse-odata.mjs";
import { uuidV5 } from "./dataverse-security.mjs";
import { pluralizeEntitySetName } from "./solution-standard.mjs";

const ROUTE = /^\/api\/data\/v[\d.]+\/(RelationshipDefinitions|GlobalOptionSetDefinitions)(?:\(([^()]*)\))?\/?$/i;
const FIRST_VALUE = 100000000; // unverified: option values start from a publisher prefix base; the base is not modelled
const LCID = 1033; // unverified: language code assumed for labels without a LanguageCode
const LIST_KEY = { picklist: "options", status: "statuses", state: "states" };

const lower = (value) => String(value ?? "").toLowerCase();
const bad = (message) => new DataError(message, 400, "InvalidRequest"); // unverified: InvalidRequest code
const missing = (what) => new DataError(`${what} does not exist.`, 404, "NotFound"); // unverified: NotFound code
const orgId = (api) => api.settings.organizationId;
const relationshipId = (api, schemaName) => uuidV5(orgId(api), `relationship:${schemaName}`);
const attributeId = (api, logical, name) => uuidV5(orgId(api), `attribute:${logical}:${name}`);
const globalId = (api, name) => uuidV5(orgId(api), `optionset:${name}`);
const mappings = (api) => api.store.state.mappings;
const globalSets = (api) => {
  const dv = (api.store.state.dataverse ??= {});
  return (dv.globalOptionSets ??= {});
};

function requiredText(value, name) {
  if (value == null || String(value).trim() === "") throw bad(`${name} is required.`); // unverified: message
  return String(value).trim();
}

// Label blocks: the default-language text, and labels keyed by LanguageCode (the shape optionOf reads).
const textOf = (block) => block?.UserLocalizedLabel?.Label ?? block?.LocalizedLabels?.find((l) => l?.Label != null)?.Label ?? null;
const labelsOf = (block) => Object.fromEntries((block?.LocalizedLabels ?? []).filter((l) => l?.Label != null)
  .map((l) => [String(l.LanguageCode ?? LCID), String(l.Label)]));
// MergeLabels keeps the languages the write does not name; without it the write replaces them.
const mergedLabels = (previous, block, merge) => (merge ? { ...(previous ?? {}), ...labelsOf(block) } : labelsOf(block));
const mergeLabelsHeader = (c) => Object.entries(c.headers ?? {})
  .some(([name, value]) => lower(name) === "mscrm.mergelabels" && lower(value) === "true");

function tableOf(api, name) {
  const logical = lower(requiredText(name, "Table logical name"));
  const table = mappings(api)[logical];
  if (!table) throw missing(`Table ${logical}`);
  return table;
}

const hasField = (table, name) => name === table.idColumn || Object.hasOwn(table.fields ?? {}, name);
const navTaken = (table, nav) => Object.hasOwn(table.relationships ?? {}, nav);
const pathOf = (c) => new URL(String(c.url), c.origin).pathname;
const location = (c, set, id) => entityUrl(c.origin, c.version, set, id);

// Every relationship entry written under a SchemaName. Entries without one use the metadata default.
function entriesOf(api, schemaName) {
  const found = [];
  for (const [logical, table] of Object.entries(mappings(api))) {
    for (const [nav, rel] of Object.entries(table.relationships ?? {})) {
      if (lower(rel.schemaName ?? `${logical}_${nav}`) === lower(schemaName)) found.push({ logical, nav, rel });
    }
  }
  return found;
}

function lookupNameOf(lookup) {
  // unverified: a missing LogicalName is derived from SchemaName, lowercased
  return lower(requiredText(lookup?.LogicalName ?? lookup?.SchemaName, "Lookup.LogicalName"));
}

function lookupField(lookup, targets, dataverseType) {
  const label = textOf(lookup.DisplayName);
  return {
    dataverseType,
    targets,
    ...(label ? { label } : {}),
    ...(lookup.SchemaName ? { schemaName: lookup.SchemaName } : {}),
  };
}

// Validates one 1:N relationship and returns the plan. Nothing is written here.
function planOneToMany(api, body, { lookupName, referencingNav }) {
  const schemaName = requiredText(body.SchemaName, "SchemaName");
  const referencedLogical = lower(requiredText(body.ReferencedEntity, "ReferencedEntity"));
  const referencingLogical = lower(requiredText(body.ReferencingEntity, "ReferencingEntity"));
  const referenced = tableOf(api, referencedLogical);
  const referencing = tableOf(api, referencingLogical);
  const referencedAttribute = lower(body.ReferencedAttribute ?? referenced.idColumn); // unverified: defaults to the key
  const referencedNav = body.ReferencedEntityNavigationPropertyName ?? schemaName;
  if (entriesOf(api, schemaName).length) throw bad(`A relationship named ${schemaName} already exists.`); // unverified
  if (!hasField(referenced, referencedAttribute)) throw missing(`Attribute ${referencedLogical}.${referencedAttribute}`);
  if (hasField(referencing, lookupName)) throw bad(`${referencingLogical}.${lookupName} already exists.`); // unverified
  if (navTaken(referenced, referencedNav)) throw bad(`${referencedLogical} already has navigation ${referencedNav}.`); // unverified
  if (navTaken(referencing, referencingNav)) throw bad(`${referencingLogical} already has navigation ${referencingNav}.`); // unverified
  const hierarchical = body.IsHierarchical === true;
  // unverified: IsHierarchical is allowed once per table
  if (hierarchical && Object.values(referencing.relationships ?? {}).some((rel) => rel.hierarchical)) {
    throw bad(`${referencingLogical} already has a hierarchical relationship.`);
  }
  return {
    schemaName, referencedLogical, referencingLogical, referencedAttribute, lookupName, referencedNav, referencingNav, hierarchical,
    ...(body.CascadeConfiguration ? { cascade: body.CascadeConfiguration } : {}),
    ...(body.AssociatedMenuConfiguration ? { associatedMenu: body.AssociatedMenuConfiguration } : {}),
  };
}

// Writes the plan: the lookup column (when this plan creates it) and both navigation entries.
function writeOneToMany(api, plan, field) {
  const referenced = mappings(api)[plan.referencedLogical];
  const referencing = mappings(api)[plan.referencingLogical];
  if (field) (referencing.fields ??= {})[plan.lookupName] = field;
  const shared = {
    schemaName: plan.schemaName,
    ...(plan.cascade ? { cascade: plan.cascade } : {}),
    ...(plan.associatedMenu ? { associatedMenu: plan.associatedMenu } : {}),
    ...(plan.hierarchical ? { hierarchical: true } : {}),
  };
  (referenced.relationships ??= {})[plan.referencedNav] = {
    entity: plan.referencingLogical, from: plan.referencedAttribute, to: plan.lookupName, many: true,
    partner: plan.referencingNav, ...shared,
  };
  (referencing.relationships ??= {})[plan.referencingNav] = {
    entity: plan.referencedLogical, from: plan.lookupName, to: plan.referencedAttribute, many: false,
    partner: plan.referencedNav, ...shared,
  };
}

function createOneToMany(api, body) {
  const lookupName = lookupNameOf(body.Lookup);
  const plan = planOneToMany(api, body, { lookupName, referencingNav: body.ReferencingEntityNavigationPropertyName ?? lookupName });
  writeOneToMany(api, plan, lookupField(body.Lookup, [plan.referencedLogical], "lookup"));
  return plan.schemaName;
}

function createCustomerRelationships(api, body) {
  const pairs = body.OneToManyRelationships ?? [];
  if (pairs.length !== 2) throw bad("CreateCustomerRelationships needs exactly two OneToManyRelationships."); // unverified
  const lookupName = lookupNameOf(body.Lookup);
  const plans = pairs.map((rel) => planOneToMany(api, rel, {
    lookupName,
    // unverified: customer navigations are named per target so the two relationships do not collide
    referencingNav: rel.ReferencingEntityNavigationPropertyName ?? `${lookupName}_${lower(rel.ReferencedEntity)}`,
  }));
  const [first, second] = plans;
  if (first.referencingLogical !== second.referencingLogical) throw bad("Both relationships must reference the same table."); // unverified
  if (first.referencedLogical === second.referencedLogical) throw bad("The two relationships must reference different tables."); // unverified
  if (first.schemaName === second.schemaName || first.referencingNav === second.referencingNav) {
    throw bad("The two relationships must have distinct names."); // unverified
  }
  writeOneToMany(api, first, lookupField(body.Lookup, [first.referencedLogical, second.referencedLogical], "customer"));
  writeOneToMany(api, second, null);
  return {
    RelationshipIds: plans.map((plan) => relationshipId(api, plan.schemaName)),
    AttributeId: attributeId(api, first.referencingLogical, lookupName),
  };
}

function createManyToMany(api, body) {
  const schemaName = requiredText(body.SchemaName, "SchemaName");
  const l1 = lower(requiredText(body.Entity1LogicalName, "Entity1LogicalName"));
  const l2 = lower(requiredText(body.Entity2LogicalName, "Entity2LogicalName"));
  const intersect = lower(requiredText(body.IntersectEntityName, "IntersectEntityName"));
  const e1 = tableOf(api, l1);
  const e2 = tableOf(api, l2);
  // unverified: a self-referencing many-to-many relationship is not modelled yet
  if (l1 === l2) throw bad("A self-referencing many-to-many relationship is not supported by the simulator.");
  if (entriesOf(api, schemaName).length || mappings(api)[intersect]) throw bad(`${schemaName} already exists.`); // unverified
  const attr1 = lower(body.Entity1IntersectAttribute ?? e1.idColumn);
  const attr2 = lower(body.Entity2IntersectAttribute ?? e2.idColumn);
  const nav1 = body.Entity1NavigationPropertyName ?? schemaName;
  const nav2 = body.Entity2NavigationPropertyName ?? schemaName;
  if (navTaken(e1, nav1) || navTaken(e2, nav2)) throw bad("A navigation property is already in use."); // unverified

  mappings(api)[intersect] = {
    logicalName: intersect,
    entitySet: pluralizeEntitySetName(intersect),
    idColumn: `${intersect}id`,
    userConfigured: true,
    dataverseOnly: true,
    fields: { [attr1]: { dataverseType: "lookup", targets: [l1] }, [attr2]: { dataverseType: "lookup", targets: [l2] } },
    relationships: {},
  };
  api.store.state.tables[intersect] ??= [];
  (e1.relationships ??= {})[nav1] = {
    entity: l2, from: e1.idColumn, to: e2.idColumn, many: true, schemaName, partner: nav2,
    intersect: { entity: intersect, from: attr1, to: attr2 },
  };
  (e2.relationships ??= {})[nav2] = {
    entity: l1, from: e2.idColumn, to: e1.idColumn, many: true, schemaName, partner: nav1,
    intersect: { entity: intersect, from: attr2, to: attr1 },
  };
  return schemaName;
}

// Key of a PUT or DELETE: the MetadataId the create response named.
function schemaByKey(api, key) {
  const wanted = lower(key);
  for (const [logical, table] of Object.entries(mappings(api))) {
    for (const [nav, rel] of Object.entries(table.relationships ?? {})) {
      const schema = rel.schemaName ?? `${logical}_${nav}`;
      if (lower(relationshipId(api, schema)) === wanted) return schema;
    }
  }
  throw missing(`Relationship ${key}`);
}

function updateRelationship(api, c, key) {
  const schema = schemaByKey(api, key);
  const body = c.body ?? {};
  const merge = mergeLabelsHeader(c);
  if (body.SchemaName && lower(body.SchemaName) !== lower(schema)) throw bad("SchemaName cannot change."); // unverified
  for (const { logical, nav, rel } of entriesOf(api, schema)) {
    if (body.CascadeConfiguration) rel.cascade = body.CascadeConfiguration;
    if (body.AssociatedMenuConfiguration) rel.associatedMenu = body.AssociatedMenuConfiguration;
    if (body.DisplayName) rel.displayLabels = mergedLabels(rel.displayLabels, body.DisplayName, merge);
    if (body.Description) rel.descriptionLabels = mergedLabels(rel.descriptionLabels, body.Description, merge);
  }
  return { status: 204 };
}

function deleteRelationship(api, key) {
  const schema = schemaByKey(api, key);
  const hits = entriesOf(api, schema);
  const intersect = hits.find((hit) => hit.rel.intersect)?.rel.intersect.entity;
  for (const { logical, nav } of hits) delete mappings(api)[logical].relationships[nav];
  if (intersect) {
    // unverified: deleting a many-to-many relationship removes its intersect table
    delete mappings(api)[intersect];
    delete api.store.state.tables[intersect];
    return { status: 204 };
  }
  // A 1:N relationship's lookup column goes with it, unless another relationship (a customer pair) still uses it.
  for (const hit of hits.filter((h) => !h.rel.many)) {
    const table = mappings(api)[hit.logical];
    const field = hit.rel.from;
    const remaining = Object.values(table.relationships ?? {}).filter((rel) => !rel.many && rel.from === field);
    if (remaining.length) {
      if (table.fields?.[field]) table.fields[field].targets = remaining.map((rel) => rel.entity);
      continue;
    }
    delete table.fields?.[field];
    for (const row of api.store.state.tables[hit.logical] ?? []) delete row[field];
  }
  return { status: 204 };
}

// Global option sets: keyed by Name in state.dataverse.globalOptionSets.
function findSet(api, name) {
  const wanted = lower(name);
  return Object.values(globalSets(api)).find((set) => lower(set.name) === wanted) ?? null;
}

function setByKey(api, key) {
  const named = /^Name=['"]?([^'"]+)['"]?$/i.exec(String(key ?? ""));
  const set = named ? findSet(api, named[1]) : Object.values(globalSets(api)).find((s) => lower(globalId(api, s.name)) === lower(key));
  if (!set) throw missing(`Global option set ${key}`);
  return set;
}

function createGlobalSet(api, body) {
  const name = requiredText(body.Name, "Name");
  if (findSet(api, name)) throw bad(`A global option set named ${name} already exists.`); // unverified
  if (body.OptionSetType !== undefined && lower(body.OptionSetType) !== "picklist") {
    throw bad("Only Picklist global option sets are supported."); // unverified
  }
  const options = [];
  for (const item of body.Options ?? []) options.push(optionFrom(item, assignValue(options, item.Value)));
  globalSets(api)[name] = {
    name, type: "picklist", displayLabels: labelsOf(body.DisplayName), descriptionLabels: labelsOf(body.Description), options,
  };
  return globalId(api, name);
}

function updateGlobalSet(api, c, key) {
  const set = setByKey(api, key);
  const body = c.body ?? {};
  const merge = mergeLabelsHeader(c);
  if (body.Name && lower(body.Name) !== lower(set.name)) throw bad("Name cannot change."); // unverified
  if (body.OptionSetType !== undefined && lower(body.OptionSetType) !== "picklist") throw bad("OptionSetType cannot change."); // unverified
  // Only base properties are updated. Options are not part of OptionSetMetadataBase; the option actions change them.
  if (body.DisplayName) set.displayLabels = mergedLabels(set.displayLabels, body.DisplayName, merge);
  if (body.Description) set.descriptionLabels = mergedLabels(set.descriptionLabels, body.Description, merge);
  return { status: 204 };
}

function deleteGlobalSet(api, key) {
  const set = setByKey(api, key);
  const users = Object.entries(mappings(api)).flatMap(([logical, table]) => Object.entries(table.fields ?? {})
    .filter(([, field]) => lower(field.globalOptionSet) === lower(set.name)).map(([attr]) => `${logical}.${attr}`));
  if (users.length) throw bad(`Global option set ${set.name} is used by ${users.join(", ")}.`); // unverified
  delete globalSets(api)[set.name];
  return { status: 204 };
}

// Option values: a requested value must be unused; a null value takes the next value after the list's highest.
function assignValue(list, requested) {
  if (requested == null) return Math.max(FIRST_VALUE - 1, ...list.map((o) => o.value)) + 1;
  const value = Number(requested);
  if (!Number.isInteger(value)) throw bad("Value must be an integer."); // unverified
  if (list.some((o) => o.value === value)) throw bad(`Option value ${value} already exists.`); // unverified
  return value;
}

function optionFrom(item, value, extra = {}) {
  return {
    value,
    label: textOf(item.Label) ?? String(value),
    labels: labelsOf(item.Label),
    descriptionLabels: labelsOf(item.Description),
    color: item.Color ?? null,
    ...extra,
  };
}

// The option list a choice action edits: a global set, or a local column (picklist, status or state).
function choiceHolder(api, body, types) {
  if (body.OptionSetName && types.includes("picklist")) {
    const set = findSet(api, body.OptionSetName);
    if (!set) throw missing(`Global option set ${body.OptionSetName}`);
    return { holder: set, key: "options" };
  }
  const table = tableOf(api, body.EntityLogicalName);
  const attr = lower(requiredText(body.AttributeLogicalName, "AttributeLogicalName"));
  const field = table.fields?.[attr];
  if (!field) throw missing(`Attribute ${lower(body.EntityLogicalName)}.${attr}`);
  const type = lower(field.dataverseType);
  if (!types.includes(type)) throw bad(`${attr} is not a ${types.join(" or ")} column.`); // unverified
  return { holder: field, key: type !== "picklist" && Array.isArray(field[LIST_KEY[type]]) ? LIST_KEY[type] : "options" };
}

function findOption(list, value) {
  const wanted = Number(requiredText(value, "Value"));
  const option = list.find((o) => o.value === wanted);
  if (!option) throw missing(`Option ${wanted}`);
  return option;
}

function applyLabels(option, body, merge) {
  if (body.Label != null) {
    option.label = textOf(body.Label) ?? option.label;
    option.labels = mergedLabels(option.labels, body.Label, merge);
  }
  if (body.Description != null) option.descriptionLabels = mergedLabels(option.descriptionLabels, body.Description, merge);
  if (body.Color !== undefined) option.color = body.Color;
}

const newValueBody = (c, name, value) => ({ "@odata.context": contextUrl(c.origin, c.version, `Microsoft.Dynamics.CRM.${name}Response`), NewOptionValue: value });

function insertOption(api, c) {
  const body = c.body ?? {};
  const { holder, key } = choiceHolder(api, body, ["picklist"]);
  const list = (holder[key] ??= []);
  const value = assignValue(list, body.Value);
  list.push(optionFrom(body, value));
  return { status: 200, body: newValueBody(c, "InsertOptionValue", value) };
}

function updateOption(api, c) {
  const body = c.body ?? {};
  const { holder, key } = choiceHolder(api, body, ["picklist"]);
  applyLabels(findOption(holder[key] ?? [], body.Value), body, mergeLabelsHeader(c));
  return { status: 204 };
}

function deleteOption(api, c) {
  const body = c.body ?? {};
  const { holder, key } = choiceHolder(api, body, ["picklist"]);
  const list = holder[key] ?? [];
  list.splice(list.indexOf(findOption(list, body.Value)), 1);
  return { status: 204 };
}

function orderOptions(api, c) {
  const body = c.body ?? {};
  const { holder, key } = choiceHolder(api, body, ["picklist"]);
  const list = holder[key] ?? [];
  const order = Array.isArray(body.Values) ? body.Values.map(Number) : null;
  // unverified: the order must name every option value exactly once
  if (!order || order.length !== list.length || new Set(order).size !== order.length || order.some((v) => !list.some((o) => o.value === v))) {
    throw bad("Values must list every option value once."); // unverified message
  }
  list.sort((a, b) => order.indexOf(a.value) - order.indexOf(b.value));
  return { status: 204 };
}

function insertStatus(api, c) {
  const body = c.body ?? {};
  const { holder, key } = choiceHolder(api, body, ["status", "picklist"]);
  const state = Number(body.StateCode);
  if (body.StateCode == null || !Number.isInteger(state) || state < 0) throw bad("StateCode must be a state code."); // unverified
  const list = (holder[key] ??= []);
  const value = assignValue(list, body.Value);
  list.push(optionFrom(body, value, { state }));
  return { status: 200, body: newValueBody(c, "InsertStatusValue", value) };
}

function updateState(api, c) {
  const body = c.body ?? {};
  const { holder, key } = choiceHolder(api, body, ["state"]);
  const option = findOption(holder[key] ?? [], body.Value);
  applyLabels(option, body, mergeLabelsHeader(c));
  if (body.DefaultStatusCode != null) option.defaultStatusCode = Number(body.DefaultStatusCode);
  return { status: 204 };
}

/** Routes for api.addRoute: RelationshipDefinitions and GlobalOptionSetDefinitions writes. */
export function metadataWriteRoutes(api) {
  const is = (set, keyed) => (pathname, method) => {
    const m = ROUTE.exec(pathname);
    if (!m || m[1].toLowerCase() !== set.toLowerCase()) return false;
    return (keyed ? m[2] !== undefined : m[2] === undefined) && (keyed ? ["PUT", "DELETE"] : ["POST"]).includes(method);
  };
  const keyOf = (c) => decodeURIComponent(ROUTE.exec(pathOf(c))?.[2] ?? "");
  const run = (fn) => (c) => api.change(() => fn(c));
  return [
    { match: is("RelationshipDefinitions", false), handle: run((c) => relationshipCreate(api, c)) },
    { match: is("RelationshipDefinitions", true), handle: run((c) => (c.method === "PUT"
      ? updateRelationship(api, c, keyOf(c)) : deleteRelationship(api, keyOf(c)))) },
    { match: is("GlobalOptionSetDefinitions", false), handle: run((c) => ({ status: 204, headers: { "OData-EntityId": location(c, "GlobalOptionSetDefinitions", createGlobalSet(api, c.body ?? {})) } })) },
    { match: is("GlobalOptionSetDefinitions", true), handle: run((c) => (c.method === "PUT"
      ? updateGlobalSet(api, c, keyOf(c)) : deleteGlobalSet(api, keyOf(c)))) },
  ];
}

function relationshipCreate(api, c) {
  const body = c.body ?? {};
  const type = lower(body["@odata.type"]);
  let schemaName;
  if (type.endsWith("onetomanyrelationshipmetadata")) schemaName = createOneToMany(api, body);
  else if (type.endsWith("manytomanyrelationshipmetadata")) schemaName = createManyToMany(api, body);
  else throw bad("RelationshipDefinitions needs a OneToManyRelationshipMetadata or ManyToManyRelationshipMetadata @odata.type."); // unverified
  return { status: 204, headers: { "OData-EntityId": location(c, "RelationshipDefinitions", relationshipId(api, schemaName)) } };
}

/** Operations for the registry: unbound actions. Each handle receives the action context. */
export function metadataWriteOperations(api) {
  const op = (name, fn) => ({ name, kind: "action", binding: "unbound", handle: (c) => api.change(() => fn(c)) });
  return [
    op("CreateCustomerRelationships", (c) => ({ status: 200, body: { "@odata.context": contextUrl(c.origin, c.version, "Microsoft.Dynamics.CRM.CreateCustomerRelationshipsResponse"), ...createCustomerRelationships(api, c.body ?? {}) } })),
    op("InsertOptionValue", (c) => insertOption(api, c)),
    op("UpdateOptionValue", (c) => updateOption(api, c)),
    op("DeleteOptionValue", (c) => deleteOption(api, c)),
    op("OrderOption", (c) => orderOptions(api, c)),
    op("InsertStatusValue", (c) => insertStatus(api, c)),
    op("UpdateStateValue", (c) => updateState(api, c)),
  ];
}
