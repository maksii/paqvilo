// Metadata writes for the simulated Dataverse Web API: 1:N and N:N relationships, customer and polymorphic lookups,
// global option sets and the option actions. Each write checks its privilege, validates, then mutates inside one
// store transaction under api.change. metadataWriteRoutes(api) feeds api.addRoute; metadataWriteOperations(api) feeds
// the operation registry. Metadata ids match dataverse-metadata.mjs (uuidV5 over the organization).
// Refusal messages, status codes and parameter rules without a documented native form are guesses.
//
// Canonical choice storage (dataverse-metadata.mjs reads this shape):
//   global set:   state.dataverse.globalOptionSets[name] = { name, type: "picklist", displayLabels: { <lcid>: text },
//                 descriptionLabels: { <lcid>: text }, options: [{ value, label, labels: { <lcid>: text }, descriptionLabels, color }] }
//   local column: fields[attr].columnMetadata.optionSet = { options: [{ value, label, labels, descriptionLabels, color }] }
//   global bind:  fields[attr].globalOptionSet = name and fields[attr].columnMetadata.optionSet = { isGlobal: true, name }
//   status/state: fields[attr].statuses / fields[attr].states (unchanged)
import { randomUUID } from 'node:crypto';
import { DataError } from './data-error.mjs';
import { contextUrl, entityUrl } from './dataverse-odata.mjs';
import { privilegeDeniedError } from './dataverse-security.mjs';
import { pluralizeEntitySetName } from './solution-standard.mjs';
import { relationshipsOf, standardGlobalOptionSets } from './dataverse-standard.mjs';
import { assertElasticManyToMany, assertElasticOneToMany, isElastic, partitionColumnOf } from './dataverse-elastic.mjs';
import { metadataComponentId } from './dataverse-metadata.mjs';

const ROUTE = /^\/api\/data\/v[\d.]+\/(RelationshipDefinitions|GlobalOptionSetDefinitions)(?:\(([^()]*)\))?\/?$/i;
const FIRST_VALUE = 100000000; // option values start from a publisher prefix base; the base is not modelled
const LCID = 1033; // assumed language code for labels without a LanguageCode
const LIST_KEY = { picklist: 'options', status: 'statuses', state: 'states' };

const lower = (value) => String(value ?? '').toLowerCase();
const bad = (message) => new DataError(message, 400, 'InvalidRequest');
const missing = (what) => new DataError(`${what} does not exist.`, 404, 'NotFound');
const orgId = (api) => api.settings.organizationId;
// Every metadata id is the reader's MetadataId (dataverse-metadata.mjs metadataComponentId).
const relationshipId = (api, schemaName) => metadataComponentId(orgId(api), 'relationship', schemaName);
const attributeId = (api, logical, name) => metadataComponentId(orgId(api), 'attribute', logical, name);
const globalId = (api, name) => metadataComponentId(orgId(api), 'optionset', name);
const mappings = (api) => api.store.state.mappings;
const globalSets = (api) => {
  const dv = (api.store.state.dataverse ??= {});
  return (dv.globalOptionSets ??= {});
};

function requiredText(value, name) {
  if (value == null || String(value).trim() === '') throw bad(`${name} is required.`);
  return String(value).trim();
}

// Appends one entry to state.dataverse.metadataLog, the change log the metadata reader consumes. Call it inside the
// write's transaction, so a failed write logs nothing. logical is the table (or the option set name for a global set).
export function logMetadataChange(api, op, kind, logical, name = null) {
  const log = ((api.store.state.dataverse ??= {}).metadataLog ??= []);
  const at = new Date(api.clock?.() ?? Date.now()).toISOString();
  log.push({ seq: (log.at(-1)?.seq ?? 0) + 1, at, op, kind, logical, name });
}

// Managed layer stacks. state.dataverse.managedLayers is keyed by the component's
// metadata id (managedLayerId, the id the metadata reader gives it) and holds { kind, logical, name, stack, activeOnTop, seq }:
// stack is the ordered managed layers [{ solutionid, version, body, seq }], the last entry on top. A non-empty stack makes the
// component managed (managedOwner); dataverse-solutions.mjs pushes on a managed import and dataverse-solution-messages.mjs pops on
// uninstall and promote. A record in the legacy single-layer shape ({ body, solutionid }) reads as a one-entry stack.
export const managedLayerId = (api, kind, logical, name = null) => metadataComponentId(orgId(api), kind, logical, name);
export function layerStack(layer) {
  if (!layer) return [];
  if (!Array.isArray(layer.stack)) {
    layer.stack =
      layer.body !== undefined
        ? [{ solutionid: layer.solutionid ?? null, version: null, body: layer.body, seq: layer.seq ?? 0 }]
        : [];
    delete layer.body;
    delete layer.solutionid;
  }
  return layer.stack;
}
export const managedLayerOf = (api, kind, logical, name = null) =>
  api.store.state.dataverse?.managedLayers?.[managedLayerId(api, kind, logical, name)] ?? null;
/** The solution id of the top managed layer of a component, or null when no managed solution holds a layer of it. */
export function managedOwner(api, kind, logical, name = null) {
  return layerStack(managedLayerOf(api, kind, logical, name)).at(-1)?.solutionid ?? null;
}
// A managed component may be deleted only by the uninstall or upgrade that owns its layer.
export function assertNotManaged(api, kind, logical, name, label) {
  const owner = managedOwner(api, kind, logical, name);
  if (!owner) return;
  const solution =
    (api.store.state.tables?.solution ?? []).find((row) => lower(row.solutionid) === lower(owner))?.uniquename ?? owner;
  const noun =
    { entity: 'Entity', attribute: 'Attribute', relationship: 'Relationship', key: 'EntityKey' }[kind] ?? kind;
  // InvalidDeleteOnProtectedComponent; the HTTP status and the solution name in the text are guesses.
  throw new DataError(
    `You cannot delete ${noun} ${label}. Deletion cannot be performed when ${noun} is managed (solution ${solution}).`,
    400,
    'ManagedComponentModification',
    { innerCode: '0x8004F013' },
  );
}

// True when an unmanaged customization sits on top of the managed stack: the import kept an existing definition (activeOnTop),
// or a metadata change came after the layer's last managed write (seq).
export function activeOnTop(api, layer) {
  if (layer.activeOnTop === true) return true;
  return (api.store.state.dataverse?.metadataLog ?? []).some(
    (entry) =>
      entry.seq > (layer.seq ?? 0) &&
      entry.op === 'change' &&
      entry.kind === layer.kind &&
      lower(entry.logical) === lower(layer.logical) &&
      (layer.kind === 'entity' || lower(entry.name ?? '') === lower(layer.name)),
  );
}
// Projects ownership onto the definitions the metadata reader serves (IsManaged): managedLayer is true on a table's
// dataverseMetadata, a column (mapping field and its customColumns copy), an alternate key and a relationship entry while a
// managed layer holds them, and absent otherwise. The stacks stay the source of truth; this runs after every stack change and
// on reseed, so a reloaded mapping gets its flags back.
export function projectManagedFlags(api) {
  const state = api.store.state;
  const owned = new Set(
    Object.entries(state.dataverse?.managedLayers ?? {})
      .filter(([, layer]) => layerStack(layer).length)
      .map(([id]) => id),
  );
  const has = owned.size ? (kind, logical, name) => owned.has(managedLayerId(api, kind, logical, name)) : () => false;
  const mark = (target, on) => {
    if (!target) return;
    if (on) target.managedLayer = true;
    else delete target.managedLayer;
  };
  for (const [logical, mapping] of Object.entries(state.mappings ?? {})) {
    const tableOwned = has('entity', logical);
    if (tableOwned) (mapping.dataverseMetadata ??= {}).managedLayer = true;
    else if (mapping.dataverseMetadata) delete mapping.dataverseMetadata.managedLayer;
    const bucket = state.dataverse?.customColumns?.[logical] ?? {};
    for (const [name, field] of Object.entries(mapping.fields ?? {})) {
      if (!field || typeof field !== 'object') continue;
      const on = has('attribute', logical, name);
      if (on && field.managedLayer !== true)
        mapping.fields[name] = { ...field, managedLayer: true }; // a field object may be shared
      else if (!on && field.managedLayer) mapping.fields[name] = (({ managedLayer, ...rest }) => rest)(field);
      mark(bucket[name], on);
    }
    for (const key of mapping.alternateKeys ?? []) mark(key, has('key', logical, key.name));
    for (const [nav, rel] of Object.entries(mapping.relationships ?? {}))
      mark(rel, has('relationship', null, schemaOf(logical, nav, rel)));
  }
}

// Solution membership. A metadata write that names a solution in the MSCRM.SolutionUniqueName header adds the components it
// creates to that solution: state.dataverse.solutionComponents[uniqueName] = [{ kind, logical, name }]. The components are
// the "add" entries the write appended to metadataLog (kinds: entity, attribute, relationship, optionset).
export const solutionHeaderOf = (headers) =>
  String(
    Object.entries(headers ?? {}).find(([name]) => lower(name) === 'mscrm.solutionuniquename')?.[1] ?? '',
  ).trim() || null;
export const lastMetadataSeq = (api) => api.store.state.dataverse?.metadataLog?.at(-1)?.seq ?? 0;
export function addSolutionComponents(api, solution, entries, options) {
  const bag = ((api.store.state.dataverse ??= {}).solutionComponents ??= {});
  const list = (bag[lower(solution)] ??= []);
  for (const entry of entries) {
    const key = `${entry.kind}|${lower(entry.logical)}|${lower(entry.name ?? '')}`;
    if (!list.some((item) => `${item.kind}|${lower(item.logical)}|${lower(item.name ?? '')}` === key))
      list.push({ kind: entry.kind, logical: entry.logical, name: entry.name ?? null });
  }
  addSolutionComponentRows(api, solution, entries, options);
}

// solutioncomponent rows. A component joins the named solution and the Default solution (the solution header adds it to the
// default solution too). objectid is the component's MetadataId (for MetadataBase components the component id is the
// MetadataId), the id the metadata reader returns, so it is stable across export and import into the same organization.
// ponytail: the Default solution row is created on first use with no publisher; the bag above stays the export source.
export const SOLUTION_COMPONENT_TYPE = { entity: 1, attribute: 2, optionset: 9, relationship: 10, key: 14 };
export const DEFAULT_SOLUTION = 'Default';
export const DEFAULT_SOLUTION_ID = 'fd140aaf-4df4-11dd-bd17-0019b9312238'; // the Default solution's fixed id
/** The solution component id (MetadataId) of a metadata component entry { kind, logical, name } in an organization. */
export const componentObjectId = (entry, organizationId) =>
  metadataComponentId(organizationId, entry.kind, lower(entry.logical), entry.name == null ? null : lower(entry.name));
export function solutionRowOf(store, uniquename, { create = false } = {}) {
  const rows = (store.state.tables.solution ??= []);
  let row = rows.find((s) => lower(s.uniquename) === lower(uniquename));
  if (!row && create) {
    row = {
      solutionid: uniquename === DEFAULT_SOLUTION ? DEFAULT_SOLUTION_ID : randomUUID(),
      uniquename,
      friendlyname: uniquename === DEFAULT_SOLUTION ? 'Default Solution' : uniquename,
      version: '1.0',
      ismanaged: false,
      installedon: null,
    };
    rows.push(row);
  }
  return row ?? null;
}
export function addSolutionComponentRows(api, solution, entries, { defaultSolution = true } = {}) {
  const store = api.store;
  const rows = (store.state.tables.solutioncomponent ??= []);
  for (const name of new Set(defaultSolution ? [solution, DEFAULT_SOLUTION] : [solution])) {
    const row = solutionRowOf(store, name, { create: name === DEFAULT_SOLUTION });
    if (!row) continue; // a header that names no solution row adds the component to the Default solution only
    for (const entry of entries) {
      // A payload component (form, view, web resource, ...) carries its own type and row id; a metadata component its MetadataId.
      const metadata = SOLUTION_COMPONENT_TYPE[entry.kind] !== undefined;
      const componenttype = metadata ? SOLUTION_COMPONENT_TYPE[entry.kind] : entry.type;
      if (componenttype === undefined) continue;
      const objectid = metadata ? componentObjectId(entry, orgId(api)) : lower(entry.id);
      if (
        rows.some(
          (r) =>
            lower(r.solutionid) === lower(row.solutionid) &&
            lower(r.objectid) === objectid &&
            r.componenttype === componenttype,
        )
      )
        continue;
      rows.push({
        solutioncomponentid: randomUUID(),
        solutionid: row.solutionid,
        objectid,
        componenttype,
        rootcomponentbehavior: 0,
        ismetadata: metadata,
      });
    }
  }
}
// Patch lock: a base solution that has patches is locked, so it cannot be changed or exported.
// Throws 0x80048538 when the row has patches. The caller passes the base solution row.
export function assertUnpatched(store, row) {
  const patches = (store.state.tables.solution ?? []).filter(
    (s) => s.parentsolutionid != null && lower(s.parentsolutionid) === lower(row.solutionid),
  );
  if (!patches.length) return;
  const names = patches.map((p) => p.friendlyname ?? p.uniquename).join(', ');
  throw new DataError(`Cannot modify solution because it has the following patches: ${names}.`, 400, 'InvalidRequest', {
    innerCode: '0x80048538',
  });
}

// Runs a synchronous metadata write and records the components it created under the request's solution header, if any.
export function withSolutionMembership(api, headers, fn) {
  const before = lastMetadataSeq(api);
  const solution = solutionHeaderOf(headers);
  if (solution) {
    const base = (api.store.state.tables.solution ?? []).find(
      (s) => lower(s.uniquename) === lower(solution) && s.parentsolutionid == null,
    );
    if (base) assertUnpatched(api.store, base);
  }
  const result = fn();
  if (solution) {
    const added = (api.store.state.dataverse?.metadataLog ?? []).filter(
      (entry) => entry.seq > before && entry.op === 'add',
    );
    addSolutionComponents(api, solution, added);
  }
  return result;
}

// Privilege for a metadata write: the seeded prv*Entity / prv*Attribute names that System Administrator and System Customizer
// hold (dataverse-security.mjs). Every metadata write and metadata message checks here. A request without a caller is refused.
// Impersonation: the impersonator (c.caller) needs prvActOnBehalfOfAnotherUser, and the
// privileges that apply are the intersection of the impersonator's and the impersonated user's (c.user), so the write is
// allowed only when both hold the privilege (principals.effectivePrincipal / privileges).
export function requireMetadataPrivilege(api, c, privilege, entity) {
  const caller = c.caller ?? c.user,
    user = c.user ?? caller;
  if (!caller)
    throw new DataError(`A metadata write needs an authenticated caller for ${privilege}.`, 403, 'PrivilegeDenied');
  const impersonating = lower(caller.systemuserid) !== lower(user.systemuserid);
  if (impersonating && !api.principals.canImpersonate(caller)) {
    throw privilegeDeniedError(caller, 'prvActOnBehalfOfAnotherUser', 'systemuser', {
      roleCount: api.principals.roles(caller).length,
      privilegeCount: api.principals.privileges(caller).size,
    });
  }
  const acting = impersonating && !user.impersonator ? api.principals.effectivePrincipal(caller, user) : user;
  const held = api.principals.privileges(acting);
  if (held.has(privilege)) return;
  throw privilegeDeniedError(acting, privilege, entity, {
    roleCount: api.principals.roles(acting).length,
    privilegeCount: held.size,
  });
}

// Label blocks: the default-language text, and labels keyed by LanguageCode (the shape optionOf reads).
const textOf = (block) =>
  block?.UserLocalizedLabel?.Label ?? block?.LocalizedLabels?.find((l) => l?.Label != null)?.Label ?? null;
const labelsOf = (block) =>
  Object.fromEntries(
    (block?.LocalizedLabels ?? [])
      .filter((l) => l?.Label != null)
      .map((l) => [String(l.LanguageCode ?? LCID), String(l.Label)]),
  );
// MergeLabels keeps the languages the write does not name; without it the write replaces them.
const mergedLabels = (previous, block, merge) =>
  merge ? { ...(previous ?? {}), ...labelsOf(block) } : labelsOf(block);
const mergeLabelsHeader = (c) =>
  Object.entries(c.headers ?? {}).some(
    ([name, value]) => lower(name) === 'mscrm.mergelabels' && lower(value) === 'true',
  );

function tableOf(api, name) {
  const logical = lower(requiredText(name, 'Table logical name'));
  const table = mappings(api)[logical];
  if (!table) throw missing(`Table ${logical}`);
  return table;
}

// Only tables this API created are changed here; seeded and Solution tables keep their mappings.
function writable(table, logical) {
  if (table?.dataverseOnly !== true || table.dataverseMetadata?.createdByMetadataApi !== true) {
    throw bad(`${logical} is a solution table and cannot be changed through the Web API.`);
  }
}

const hasField = (table, name) => name === table.idColumn || Object.hasOwn(table.fields ?? {}, name);
const navTaken = (api, table, nav) =>
  Object.hasOwn(relationshipsOf(api.store, table.logicalName, table.relationships), nav);
const pathOf = (c) => new URL(String(c.url), c.origin).pathname;
const location = (c, set, id) => entityUrl(c.origin, c.version, set, id);
// The schema name of a relationship entry; entries without one use the metadata default (dataverse-metadata.mjs).
const schemaOf = (logical, nav, rel) => rel.schemaName ?? (rel.intersect ? rel.intersect.entity : `${logical}_${nav}`);

// Every relationship entry written under a SchemaName.
function entriesOf(api, schemaName) {
  const found = [];
  for (const [logical, table] of Object.entries(mappings(api))) {
    for (const [nav, rel] of Object.entries(table.relationships ?? {})) {
      if (lower(schemaOf(logical, nav, rel)) === lower(schemaName)) found.push({ logical, nav, rel });
    }
  }
  return found;
}

// The table a relationship is logged under: the referencing side of a 1:N, else the first entry (N:N).
const primaryHit = (hits) => hits.find((hit) => !hit.rel.many) ?? hits[0];

// Origin guard: only a relationship this API created is customizable. Solution and seeded entries carry no
// isManaged: false / isCustomizable: true pair, so they are refused whatever table they reference. An N:N relationship
// also owns its intersect table, which must be one this API created.
function guardHits(api, schema, hits) {
  if (hits.some(({ rel }) => rel.isManaged !== false || rel.isCustomizable !== true)) {
    throw bad(`${schema} is a managed Solution relationship and cannot be changed or deleted.`); // no documented relationship-specific code
  }
  for (const { rel } of hits) if (rel.intersect) writable(mappings(api)[rel.intersect.entity], rel.intersect.entity);
}

function lookupNameOf(lookup) {
  // Assumed: a missing LogicalName is derived from SchemaName, lowercased.
  return lower(requiredText(lookup?.LogicalName ?? lookup?.SchemaName, 'Lookup.LogicalName'));
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

// Validates one 1:N relationship and returns the plan. Nothing is written here. The lookup lands on the referencing table,
// so that table must be writable; the referenced table may be any table.
function planOneToMany(api, body, { lookupName, referencingNav }) {
  const schemaName = requiredText(body.SchemaName, 'SchemaName');
  const referencedLogical = lower(requiredText(body.ReferencedEntity, 'ReferencedEntity'));
  const referencingLogical = lower(requiredText(body.ReferencingEntity, 'ReferencingEntity'));
  const referenced = tableOf(api, referencedLogical);
  const referencing = tableOf(api, referencingLogical);
  writable(referencing, referencingLogical);
  const cascade = assertElasticOneToMany({ referencing, referenced, cascade: body.CascadeConfiguration }); // elastic rules (dataverse-elastic.mjs)
  const referencedAttribute = lower(body.ReferencedAttribute ?? referenced.idColumn); // assumed default: the key
  const referencedNav = body.ReferencedEntityNavigationPropertyName ?? schemaName;
  if (entriesOf(api, schemaName).length) throw bad(`A relationship named ${schemaName} already exists.`);
  if (!hasField(referenced, referencedAttribute))
    throw missing(`Attribute ${referencedLogical}.${referencedAttribute}`);
  if (hasField(referencing, lookupName)) throw bad(`${referencingLogical}.${lookupName} already exists.`);
  if (navTaken(api, referenced, referencedNav))
    throw bad(`${referencedLogical} already has navigation ${referencedNav}.`);
  if (navTaken(api, referencing, referencingNav))
    throw bad(`${referencingLogical} already has navigation ${referencingNav}.`);
  const hierarchical = body.IsHierarchical === true;
  // Assumed: IsHierarchical is allowed once per table.
  if (
    hierarchical &&
    Object.values(relationshipsOf(api.store, referencing.logicalName, referencing.relationships)).some(
      (rel) => rel.hierarchical,
    )
  ) {
    throw bad(`${referencingLogical} already has a hierarchical relationship.`);
  }
  return {
    schemaName,
    referencedLogical,
    referencingLogical,
    referencedAttribute,
    lookupName,
    referencedNav,
    referencingNav,
    hierarchical,
    ...(cascade ? { cascade } : {}),
    ...(body.AssociatedMenuConfiguration ? { associatedMenu: body.AssociatedMenuConfiguration } : {}),
  };
}

// Writes the plan: the lookup column (when this plan creates it) and both navigation entries.
function writeOneToMany(api, plan, field) {
  const referenced = mappings(api)[plan.referencedLogical];
  const referencing = mappings(api)[plan.referencingLogical];
  if (field) {
    (referencing.fields ??= {})[plan.lookupName] = field;
    // A lookup to an elastic table also gets <lookup>pid, the partitionid of the row it points at.
    if (isElastic(referenced)) referencing.fields[partitionColumnOf(plan.lookupName)] = { dataverseType: 'nvarchar' };
    logMetadataChange(api, 'add', 'attribute', plan.referencingLogical, plan.lookupName);
  }
  const shared = {
    schemaName: plan.schemaName,
    isManaged: false,
    isCustomizable: true, // created through the metadata API: a custom component

    ...(plan.cascade ? { cascade: plan.cascade } : {}),
    ...(plan.associatedMenu ? { associatedMenu: plan.associatedMenu } : {}),
    ...(plan.hierarchical ? { hierarchical: true } : {}),
  };
  (referenced.relationships ??= {})[plan.referencedNav] = {
    entity: plan.referencingLogical,
    from: plan.referencedAttribute,
    to: plan.lookupName,
    many: true,
    partner: plan.referencingNav,
    ...shared,
  };
  (referencing.relationships ??= {})[plan.referencingNav] = {
    entity: plan.referencedLogical,
    from: plan.lookupName,
    to: plan.referencedAttribute,
    many: false,
    partner: plan.referencedNav,
    ...shared,
  };
  logMetadataChange(api, 'add', 'relationship', plan.referencingLogical, plan.schemaName);
}

export function createOneToMany(api, body) {
  const lookupName = lookupNameOf(body.Lookup);
  const plan = planOneToMany(api, body, {
    lookupName,
    referencingNav: body.ReferencingEntityNavigationPropertyName ?? lookupName,
  });
  writeOneToMany(api, plan, lookupField(body.Lookup, [plan.referencedLogical], 'lookup'));
  return plan.schemaName;
}

// A lookup whose targets are the referenced tables of one-to-many relationships; the first relationship creates the column.
function createPolymorphic(api, body) {
  const pairs = body.OneToManyRelationships ?? [];
  if (!Array.isArray(pairs) || !pairs.length)
    throw bad('A multi-table lookup needs at least one OneToManyRelationships entry.');
  const lookupName = lookupNameOf(body.Lookup);
  const plans = pairs.map((rel) =>
    planOneToMany(api, rel, {
      lookupName,
      // Assumed default: each navigation is named per target so the relationships do not collide.
      referencingNav: rel.ReferencingEntityNavigationPropertyName ?? `${lookupName}_${lower(rel.ReferencedEntity)}`,
    }),
  );
  const [first] = plans;
  if (plans.some((p) => p.referencingLogical !== first.referencingLogical))
    throw bad('All relationships must reference the same table.');
  const targets = plans.map((p) => p.referencedLogical);
  if (new Set(targets).size !== targets.length) throw bad('The relationships must reference different tables.');
  if (new Set(plans.map((p) => p.schemaName)).size !== plans.length)
    throw bad('The relationships must have distinct schema names.');
  if (new Set(plans.map((p) => p.referencingNav)).size !== plans.length)
    throw bad('The relationships must have distinct navigation names.');
  writeOneToMany(api, first, lookupField(body.Lookup, targets, 'customer'));
  for (const plan of plans.slice(1)) writeOneToMany(api, plan, null);
  return {
    RelationshipIds: plans.map((plan) => relationshipId(api, plan.schemaName)),
    AttributeId: attributeId(api, first.referencingLogical, lookupName),
  };
}

function createCustomerRelationships(api, body) {
  if ((body.OneToManyRelationships ?? []).length !== 2)
    throw bad('CreateCustomerRelationships needs exactly two OneToManyRelationships.');
  return createPolymorphic(api, body);
}

export function createManyToMany(api, body) {
  const schemaName = requiredText(body.SchemaName, 'SchemaName');
  const l1 = lower(requiredText(body.Entity1LogicalName, 'Entity1LogicalName'));
  const l2 = lower(requiredText(body.Entity2LogicalName, 'Entity2LogicalName'));
  const intersect = lower(requiredText(body.IntersectEntityName, 'IntersectEntityName'));
  const e1 = tableOf(api, l1);
  const e2 = tableOf(api, l2);
  assertElasticManyToMany(e1, e2); // no N:N with an elastic table (dataverse-elastic.mjs)
  if (entriesOf(api, schemaName).length || mappings(api)[intersect]) throw bad(`${schemaName} already exists.`);
  const attr1 = lower(body.Entity1IntersectAttribute ?? e1.idColumn);
  const attr2 = lower(body.Entity2IntersectAttribute ?? e2.idColumn);
  const nav1 = body.Entity1NavigationPropertyName ?? schemaName;
  const nav2 = body.Entity2NavigationPropertyName ?? schemaName;
  // A self-referencing relationship has both sides on one table: its intersect columns and navigation names must differ.
  if (
    l1 === l2 &&
    (!body.Entity1IntersectAttribute || !body.Entity2IntersectAttribute || attr1 === attr2 || nav1 === nav2)
  ) {
    throw bad(
      'A self-referencing many-to-many relationship needs distinct Entity1 and Entity2 intersect attributes and navigation names.',
    );
  }
  if (navTaken(api, e1, nav1) || navTaken(api, e2, nav2)) throw bad('A navigation property is already in use.');

  mappings(api)[intersect] = {
    logicalName: intersect,
    entitySet: pluralizeEntitySetName(intersect),
    idColumn: `${intersect}id`,
    userConfigured: true,
    dataverseOnly: true,
    dataverseMetadata: { createdByMetadataApi: true },
    fields: {
      [attr1]: { dataverseType: 'lookup', targets: [l1] },
      [attr2]: { dataverseType: 'lookup', targets: [l2] },
    },
    relationships: {},
  };
  api.store.state.tables[intersect] ??= [];
  (e1.relationships ??= {})[nav1] = {
    entity: l2,
    from: e1.idColumn,
    to: e2.idColumn,
    many: true,
    schemaName,
    partner: nav2,
    isManaged: false,
    isCustomizable: true,
    intersect: { entity: intersect, from: attr1, to: attr2 },
  };
  (e2.relationships ??= {})[nav2] = {
    entity: l1,
    from: e2.idColumn,
    to: e1.idColumn,
    many: true,
    schemaName,
    partner: nav1,
    isManaged: false,
    isCustomizable: true,
    intersect: { entity: intersect, from: attr2, to: attr1 },
  };
  logMetadataChange(api, 'add', 'entity', intersect);
  logMetadataChange(api, 'add', 'relationship', l1, schemaName);
  return schemaName;
}

// Key of a PUT or DELETE: the MetadataId the create response named.
function schemaByKey(api, key) {
  const wanted = lower(key);
  for (const [logical, table] of Object.entries(mappings(api))) {
    for (const [nav, rel] of Object.entries(table.relationships ?? {})) {
      const schema = schemaOf(logical, nav, rel);
      if (lower(relationshipId(api, schema)) === wanted) return schema;
    }
  }
  throw missing(`Relationship ${key}`);
}

function updateRelationship(api, c, key) {
  const schema = schemaByKey(api, key);
  const body = c.body ?? {};
  const merge = mergeLabelsHeader(c);
  if (body.SchemaName && lower(body.SchemaName) !== lower(schema)) throw bad('SchemaName cannot change.');
  const hits = entriesOf(api, schema);
  guardHits(api, schema, hits);
  for (const { rel } of hits) {
    if (body.CascadeConfiguration) rel.cascade = body.CascadeConfiguration;
    if (body.AssociatedMenuConfiguration) rel.associatedMenu = body.AssociatedMenuConfiguration;
    if (body.DisplayName) rel.displayLabels = mergedLabels(rel.displayLabels, body.DisplayName, merge);
    if (body.Description) rel.descriptionLabels = mergedLabels(rel.descriptionLabels, body.Description, merge);
  }
  logMetadataChange(api, 'change', 'relationship', primaryHit(hits).logical, schema);
  return { status: 204 };
}

// Removes the navigation entries of one relationship, its intersect table (N:N) or its lookup column (1:N, unless another
// relationship still uses the column). No privilege or writable check: the callers decide that.
export function dropRelationship(api, schema) {
  const hits = entriesOf(api, schema);
  if (!hits.length) return;
  const intersect = hits.find((hit) => hit.rel.intersect)?.rel.intersect.entity;
  for (const { logical, nav } of hits) delete mappings(api)[logical].relationships[nav];
  logMetadataChange(api, 'delete', 'relationship', primaryHit(hits).logical, schema);
  if (intersect) {
    delete mappings(api)[intersect];
    delete api.store.state.tables?.[intersect];
    logMetadataChange(api, 'delete', 'entity', intersect);
    return;
  }
  for (const hit of hits.filter((h) => !h.rel.many)) {
    const table = mappings(api)[hit.logical];
    const field = hit.rel.from;
    const remaining = Object.values(table.relationships ?? {}).filter((rel) => !rel.many && rel.from === field);
    if (remaining.length) {
      if (table.fields?.[field]) table.fields[field].targets = remaining.map((rel) => rel.entity);
      continue;
    }
    delete table.fields?.[field];
    logMetadataChange(api, 'delete', 'attribute', hit.logical, field);
    for (const row of api.store.state.tables?.[hit.logical] ?? []) delete row[field];
  }
}

function deleteRelationship(api, key) {
  const schema = schemaByKey(api, key);
  assertNotManaged(api, 'relationship', null, schema, schema);
  guardHits(api, schema, entriesOf(api, schema));
  dropRelationship(api, schema);
  return { status: 204 };
}

/** A table delete cascades: every relationship that names the table, on either side, goes with it (no writable check). */
export function removeRelationshipsOf(api, logical) {
  const schemas = new Set();
  for (const [owner, table] of Object.entries(mappings(api))) {
    for (const [nav, rel] of Object.entries(table.relationships ?? {})) {
      if (owner === logical || rel.entity === logical || rel.intersect?.entity === logical)
        schemas.add(schemaOf(owner, nav, rel));
    }
  }
  for (const schema of schemas) dropRelationship(api, schema);
}

// Global option sets: keyed by Name in state.dataverse.globalOptionSets.
function findSet(api, name) {
  const wanted = lower(name);
  return Object.values(globalSets(api)).find((set) => lower(set.name) === wanted) ?? null;
}

function setByKey(api, key) {
  const named = /^Name=['"]?([^'"]+)['"]?$/i.exec(String(key ?? ''));
  const set = named
    ? findSet(api, named[1])
    : Object.values(globalSets(api)).find((s) => lower(globalId(api, s.name)) === lower(key));
  if (!set) throw missing(`Global option set ${key}`);
  return set;
}

// The global set a field is bound to (canonical: globalOptionSet, or columnMetadata.optionSet with isGlobal).
const boundSetOf = (field) =>
  field.globalOptionSet ??
  (field.columnMetadata?.optionSet?.isGlobal ? field.columnMetadata.optionSet.name : undefined);

// Every [table, column] bound to a global set.
export function boundFields(api, setName) {
  return Object.entries(mappings(api)).flatMap(([logical, table]) =>
    Object.entries(table.fields ?? {})
      .filter(([, field]) => lower(boundSetOf(field)) === lower(setName))
      .map(([attr]) => [logical, attr]),
  );
}

export function createGlobalSet(api, body) {
  const name = requiredText(body.Name, 'Name');
  // A standard global option set (the standard file) is taken too, by name, whatever the case.
  const standard = Object.keys(standardGlobalOptionSets()).some((set) => lower(set) === lower(name));
  if (findSet(api, name) || standard) throw bad(`A global option set named ${name} already exists.`);
  if (body.OptionSetType !== undefined && lower(body.OptionSetType) !== 'picklist') {
    throw bad('Only Picklist global option sets are supported.');
  }
  const options = [];
  for (const item of body.Options ?? []) options.push(optionFrom(item, assignValue(options, item.Value)));
  globalSets(api)[name] = {
    name,
    type: 'picklist',
    displayLabels: labelsOf(body.DisplayName),
    descriptionLabels: labelsOf(body.Description),
    options,
  };
  logMetadataChange(api, 'add', 'optionset', name);
  return globalId(api, name);
}

function updateGlobalSet(api, c, key) {
  const set = setByKey(api, key);
  const body = c.body ?? {};
  const merge = mergeLabelsHeader(c);
  if (body.Name && lower(body.Name) !== lower(set.name)) throw bad('Name cannot change.');
  if (body.OptionSetType !== undefined && lower(body.OptionSetType) !== 'picklist')
    throw bad('OptionSetType cannot change.');
  // Only base properties are updated. Options are not part of OptionSetMetadataBase; the option actions change them.
  if (body.DisplayName) set.displayLabels = mergedLabels(set.displayLabels, body.DisplayName, merge);
  if (body.Description) set.descriptionLabels = mergedLabels(set.descriptionLabels, body.Description, merge);
  logMetadataChange(api, 'change', 'optionset', set.name);
  return { status: 204 };
}

function deleteGlobalSet(api, key) {
  const set = setByKey(api, key);
  const users = boundFields(api, set.name).map(([logical, attr]) => `${logical}.${attr}`);
  if (users.length) throw bad(`Global option set ${set.name} is used by ${users.join(', ')}.`);
  dropGlobalSet(api, set.name);
  return { status: 204 };
}

// Removes a global option set with no guard: the caller has checked that no column is bound to it.
export function dropGlobalSet(api, name) {
  delete globalSets(api)[name];
  logMetadataChange(api, 'delete', 'optionset', name);
}

// Option values: a requested value must be unused; a null value takes the next value after the list's highest.
export function assignValue(list, requested) {
  if (requested == null) return Math.max(FIRST_VALUE - 1, ...list.map((o) => o.value)) + 1;
  const value = Number(requested);
  if (!Number.isInteger(value)) throw bad('Value must be an integer.');
  if (list.some((o) => o.value === value)) throw bad(`Option value ${value} already exists.`);
  return value;
}

// One option in the canonical shape: { value, label, labels, descriptionLabels, color }.
export function optionFrom(item, value, extra = {}) {
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
  if (body.OptionSetName && types.includes('picklist')) {
    const set = findSet(api, body.OptionSetName);
    if (!set) throw missing(`Global option set ${body.OptionSetName}`);
    return { holder: set, key: 'options', users: boundFields(api, set.name) };
  }
  const logical = lower(requiredText(body.EntityLogicalName, 'EntityLogicalName'));
  const table = tableOf(api, logical);
  const attr = lower(requiredText(body.AttributeLogicalName, 'AttributeLogicalName'));
  const field = table.fields?.[attr];
  if (!field) throw missing(`Attribute ${logical}.${attr}`);
  const type = lower(field.dataverseType);
  if (!types.includes(type)) throw bad(`${attr} is not a ${types.join(' or ')} column.`);
  const users = [[logical, attr]];
  const optionSet = field.columnMetadata?.optionSet;
  if (optionSet?.isGlobal) throw bad(`${attr} uses a global choice; change it with OptionSetName.`);
  if (type === 'picklist' && optionSet) return { holder: optionSet, key: 'options', users };
  return {
    holder: field,
    key: type !== 'picklist' && Array.isArray(field[LIST_KEY[type]]) ? LIST_KEY[type] : 'options',
    users,
  };
}

// The change log entry for an option action: the global set, or the local column the action edits.
function logChoice(api, body) {
  if (body.OptionSetName) logMetadataChange(api, 'change', 'optionset', findSet(api, body.OptionSetName).name);
  else logMetadataChange(api, 'change', 'attribute', lower(body.EntityLogicalName), lower(body.AttributeLogicalName));
}

function findOption(list, value) {
  const wanted = Number(requiredText(value, 'Value'));
  const option = list.find((o) => o.value === wanted);
  if (!option) throw missing(`Option ${wanted}`);
  return option;
}

function applyLabels(option, body, merge) {
  if (body.Label != null) {
    option.label = textOf(body.Label) ?? option.label;
    option.labels = mergedLabels(option.labels, body.Label, merge);
  }
  if (body.Description != null)
    option.descriptionLabels = mergedLabels(option.descriptionLabels, body.Description, merge);
  if (body.Color !== undefined) option.color = body.Color;
}

const newValueBody = (c, name, value) => ({
  '@odata.context': contextUrl(c.origin, c.version, `Microsoft.Dynamics.CRM.${name}Response`),
  NewOptionValue: value,
});

function insertOption(api, c) {
  const body = c.body ?? {};
  const { holder, key } = choiceHolder(api, body, ['picklist']);
  const list = (holder[key] ??= []);
  const value = assignValue(list, body.Value);
  list.push(optionFrom(body, value));
  logChoice(api, body);
  return { status: 200, body: newValueBody(c, 'InsertOptionValue', value) };
}

function updateOption(api, c) {
  const body = c.body ?? {};
  const { holder, key } = choiceHolder(api, body, ['picklist']);
  applyLabels(findOption(holder[key] ?? [], body.Value), body, mergeLabelsHeader(c));
  logChoice(api, body);
  return { status: 204 };
}

// A stored choice value: a number, a comma-separated text, or a list (multi-select).
function storesValue(stored, value) {
  if (stored == null) return false;
  const parts = Array.isArray(stored) ? stored : String(stored).split(',');
  return parts.some((part) => String(part).trim() !== '' && Number(part) === value);
}

function deleteOption(api, c) {
  const body = c.body ?? {};
  const { holder, key, users } = choiceHolder(api, body, ['picklist']);
  const list = holder[key] ?? [];
  const option = findOption(list, body.Value);
  for (const [logical, attr] of users) {
    for (const row of api.store.state.tables?.[logical] ?? []) {
      if (storesValue(row[attr], option.value)) throw bad(`Option ${option.value} is used by ${logical}.${attr}.`);
    }
  }
  list.splice(list.indexOf(option), 1);
  logChoice(api, body);
  return { status: 204 };
}

function orderOptions(api, c) {
  const body = c.body ?? {};
  const { holder, key } = choiceHolder(api, body, ['picklist']);
  const list = holder[key] ?? [];
  const order = Array.isArray(body.Values) ? body.Values.map(Number) : null;
  // Assumed: the order must name every option value exactly once.
  if (
    !order ||
    order.length !== list.length ||
    new Set(order).size !== order.length ||
    order.some((v) => !list.some((o) => o.value === v))
  ) {
    throw bad('Values must list every option value once.');
  }
  list.sort((a, b) => order.indexOf(a.value) - order.indexOf(b.value));
  logChoice(api, body);
  return { status: 204 };
}

function insertStatus(api, c) {
  const body = c.body ?? {};
  const { holder, key } = choiceHolder(api, body, ['status', 'picklist']);
  const state = Number(body.StateCode);
  if (body.StateCode == null || !Number.isInteger(state) || state < 0) throw bad('StateCode must be a state code.');
  const list = (holder[key] ??= []);
  const value = assignValue(list, body.Value);
  list.push(optionFrom(body, value, { state }));
  logChoice(api, body);
  return { status: 200, body: newValueBody(c, 'InsertStatusValue', value) };
}

function updateState(api, c) {
  const body = c.body ?? {};
  const { holder, key } = choiceHolder(api, body, ['state']);
  const option = findOption(holder[key] ?? [], body.Value);
  applyLabels(option, body, mergeLabelsHeader(c));
  if (body.DefaultStatusCode != null) option.defaultStatusCode = Number(body.DefaultStatusCode);
  logChoice(api, body);
  return { status: 204 };
}

// Privilege for a relationship or global set write, by HTTP method.
const privilegeOf = (method) =>
  ({ POST: 'prvCreateAttribute', PUT: 'prvWriteAttribute', DELETE: 'prvDeleteAttribute' })[method];

/** Routes for api.addRoute: RelationshipDefinitions and GlobalOptionSetDefinitions writes. */
export function metadataWriteRoutes(api) {
  const is = (set, keyed) => (pathname, method) => {
    const m = ROUTE.exec(pathname);
    if (!m || m[1].toLowerCase() !== set.toLowerCase()) return false;
    return (keyed ? m[2] !== undefined : m[2] === undefined) && (keyed ? ['PUT', 'DELETE'] : ['POST']).includes(method);
  };
  const keyOf = (c) => decodeURIComponent(ROUTE.exec(pathOf(c))?.[2] ?? '');
  const run = (fn) => async (c) => {
    requireMetadataPrivilege(api, c, privilegeOf(c.method), 'attribute');
    return api.change(() => api.store.transact(() => withSolutionMembership(api, c.headers, () => fn(c))));
  };
  return [
    { match: is('RelationshipDefinitions', false), handle: run((c) => relationshipCreate(api, c)) },
    {
      match: is('RelationshipDefinitions', true),
      handle: run((c) =>
        c.method === 'PUT' ? updateRelationship(api, c, keyOf(c)) : deleteRelationship(api, keyOf(c)),
      ),
    },
    {
      match: is('GlobalOptionSetDefinitions', false),
      handle: run((c) => ({
        status: 204,
        headers: { 'OData-EntityId': location(c, 'GlobalOptionSetDefinitions', createGlobalSet(api, c.body ?? {})) },
      })),
    },
    {
      match: is('GlobalOptionSetDefinitions', true),
      handle: run((c) => (c.method === 'PUT' ? updateGlobalSet(api, c, keyOf(c)) : deleteGlobalSet(api, keyOf(c)))),
    },
  ];
}

function relationshipCreate(api, c) {
  const body = c.body ?? {};
  const type = lower(body['@odata.type']);
  let schemaName;
  if (type.endsWith('onetomanyrelationshipmetadata')) schemaName = createOneToMany(api, body);
  else if (type.endsWith('manytomanyrelationshipmetadata')) schemaName = createManyToMany(api, body);
  else
    throw bad(
      'RelationshipDefinitions needs a OneToManyRelationshipMetadata or ManyToManyRelationshipMetadata @odata.type.',
    );
  return {
    status: 204,
    headers: { 'OData-EntityId': location(c, 'RelationshipDefinitions', relationshipId(api, schemaName)) },
  };
}

/** Operations for the registry: unbound actions. Each checks its privilege, then runs in one store transaction. */
export function metadataWriteOperations(api) {
  const op = (name, privilege, fn) => ({
    name,
    kind: 'action',
    binding: 'unbound',
    handle: async (c) => {
      requireMetadataPrivilege(api, c, privilege, 'attribute');
      return api.change(() => api.store.transact(() => withSolutionMembership(api, c.headers, () => fn(c))));
    },
  });
  return [
    op('CreateCustomerRelationships', 'prvCreateAttribute', (c) => ({
      status: 200,
      body: {
        '@odata.context': contextUrl(c.origin, c.version, 'Microsoft.Dynamics.CRM.CreateCustomerRelationshipsResponse'),
        ...createCustomerRelationships(api, c.body ?? {}),
      },
    })),
    op('CreatePolymorphicLookupAttribute', 'prvCreateAttribute', (c) => ({
      status: 200,
      body: {
        '@odata.context': contextUrl(
          c.origin,
          c.version,
          'Microsoft.Dynamics.CRM.CreatePolymorphicLookupAttributeResponse',
        ),
        ...createPolymorphic(api, c.body ?? {}),
      },
    })),
    op('InsertOptionValue', 'prvWriteAttribute', (c) => insertOption(api, c)),
    op('UpdateOptionValue', 'prvWriteAttribute', (c) => updateOption(api, c)),
    op('DeleteOptionValue', 'prvWriteAttribute', (c) => deleteOption(api, c)),
    op('OrderOption', 'prvWriteAttribute', (c) => orderOptions(api, c)),
    op('InsertStatusValue', 'prvWriteAttribute', (c) => insertStatus(api, c)),
    op('UpdateStateValue', 'prvWriteAttribute', (c) => updateState(api, c)),
  ];
}
