import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { compileManifest, digest, validateManifest } from './manifest.mjs';
import { metadataId } from './client.mjs';
import { existingPathError, privateJson, pacExecutable, runProcess } from './connection.mjs';
import { parseXmlDocument } from '../../mirage/lib/fetchxml-engine.mjs';
import { requiredArgument } from '../../mirage/lib/required-argument.mjs';

// Dataverse adds a savedqueryid and reserializes metadata XML on publish.
// Normalize syntax only; preserve every field, filter, join, value and order.
export function metadataXml(source) {
  const tree = parseXmlDocument(source);
  const normalize = (node, isRoot = false) => ({
    name: node.name,
    attrs: Object.fromEntries(
      Object.entries(node.attrs)
        .filter(([key]) => !(isRoot && node.name === 'fetch' && key === 'savedqueryid'))
        .sort(([a], [b]) => a.localeCompare(b, 'en')),
    ),
    text: node.text.trim() ? node.text : '',
    children: node.children.map((n) => normalize(n)),
  });
  return JSON.stringify(normalize(tree, true));
}

const TYPES = { table: 1, 'table-reference': 1, column: 2, choice: 9, relationship: 10, key: 14, form: 60, view: 26 };
const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const escape = (value) => value.replaceAll("'", "''");
function normalizeExpectedScalar(actual, expected, key) {
  if (
    typeof actual === 'string' &&
    typeof expected === 'string' &&
    ['formxml', 'fetchxml', 'layoutxml'].includes(key)
  ) {
    try {
      return metadataXml(actual);
    } catch {
      return actual;
    }
  }
  if (typeof actual === 'string' && typeof expected === 'string' && ['SchemaName', 'LogicalName', 'Name'].includes(key))
    return actual.toLowerCase();
  return actual;
}

function normalizeExpectedArray(actual, expected, key) {
  if (!Array.isArray(actual)) return null;
  if (key === 'Attributes')
    return expected.map((e) =>
      normalizeExpected(
        actual.find((a) => a.SchemaName?.toLowerCase() === e.SchemaName?.toLowerCase()),
        e,
      ),
    );
  if (key === 'LocalizedLabels')
    return expected.map((e) =>
      normalizeExpected(
        actual.find((a) => a.LanguageCode === e.LanguageCode),
        e,
      ),
    );
  if (key === 'Options')
    return actual.length === expected.length
      ? expected.map((e) =>
          normalizeExpected(
            actual.find((a) => a.Value === e.Value),
            e,
          ),
        )
      : actual;
  // Preserve Array#sort's string coercion for metadata returned by the service.
  if (key === 'KeyAttributes') return [...actual].sort(); // NOSONAR: default string coercion is intentional
  return actual;
}

function normalizeExpectedObject(actual, expected) {
  const result = {};
  for (const [property, value] of Object.entries(expected)) {
    if (property === '@odata.type' || property === 'CanBeChanged' || property === 'ManagedPropertyLogicalName')
      continue;
    if (property === 'GlobalOptionSet@odata.bind')
      result[property] = actual?.GlobalOptionSet?.Name
        ? `/GlobalOptionSetDefinitions(Name='${actual.GlobalOptionSet.Name}')`
        : actual?.[property];
    else if (property.endsWith('AssociatedMenuConfiguration'))
      result[property] = { Behavior: actual?.[property]?.Behavior };
    else result[property] = normalizeExpected(actual?.[property], value, property);
  }
  return result;
}

function normalizeExpected(actual, expected, key = '') {
  if (expected === null || typeof expected !== 'object') {
    return normalizeExpectedScalar(actual, expected, key);
  }
  if (Array.isArray(expected)) return normalizeExpectedArray(actual, expected, key);
  return normalizeExpectedObject(actual, expected);
}
export function compatible(actual, desired) {
  if (!actual) return false;
  if (
    desired['@odata.type'] &&
    actual['@odata.type'] &&
    actual['@odata.type'].replace(/^#/, '') !== desired['@odata.type'].replace(/^#/, '')
  )
    return false;
  return JSON.stringify(normalizeExpected(actual, desired)) === JSON.stringify(normalizeExpected(desired, desired));
}

// The declared properties whose existing values differ, as { property, declared, actual }, with the same
// normalization as compatible(). Array members are named by their schema name, language code or option value.
export function metadataDifferences(actual, desired) {
  if (!actual) return [];
  const type = (value) => value?.['@odata.type']?.replace(/^#/, '');
  if (type(desired) && type(actual) && type(actual) !== type(desired))
    return [{ property: '@odata.type', declared: type(desired), actual: type(actual) }];
  const differences = [];
  const memberPath = (parent, key, value, inArray) => {
    if (inArray) return `${parent}[${value?.SchemaName ?? value?.LanguageCode ?? value?.Value ?? key}]`;
    return parent ? `${parent}.${key}` : key;
  };
  const walk = (have, want, property) => {
    if (JSON.stringify(have) === JSON.stringify(want)) return;
    const inArray = Array.isArray(want);
    const descend =
      want && typeof want === 'object' && have && typeof have === 'object' && inArray === Array.isArray(have);
    if (descend && (!inArray || want.length === have.length)) {
      for (const [key, value] of Object.entries(want))
        walk(have[key], value, memberPath(property, key, value, inArray));
      return;
    }
    differences.push({ property, declared: want ?? null, actual: have ?? null });
  };
  walk(normalizeExpected(actual, desired), normalizeExpected(desired, desired), '');
  return differences;
}

// "table:x (Attributes[x_name].MaxLength)" for messages; values stay in plan and journal JSON only.
const driftLabel = (key, differences) =>
  differences.length ? `${key} (${differences.map((d) => d.property).join(', ')})` : key;

// Display labels and descriptions of a table (and its primary-name column) or a column: the only drift that
// `apply --update-labels` changes. Every other property, of these and of every other component kind, stays drift.
const LABEL_PROPERTY =
  /^(?:Attributes\[[^\]]+\]\.)?(?:DisplayName|DisplayCollectionName|Description)\.LocalizedLabels\[\d+\]\.Label$/;
export const labelsOnly = (action, differences) =>
  ['table', 'column'].includes(action.kind) &&
  differences.length > 0 &&
  differences.every((difference) => LABEL_PROPERTY.test(difference.property));

// A metadata definition read from Dataverse as an update body: annotations removed, its type stated.
function metadataBody(current, type) {
  const body = structuredClone(current);
  for (const key of Object.keys(body)) if (key.startsWith('@odata.')) delete body[key];
  body['@odata.type'] = type;
  return body;
}

const LABEL_NAMES = ['DisplayName', 'DisplayCollectionName', 'Description'];

// Updates only the differing display labels of a declared table or column, then verifies them by readback.
async function updateLabels(client, action, current, differences) {
  const changed = (prefix) =>
    LABEL_NAMES.filter((name) => differences.some((d) => d.property.startsWith(`${prefix}${name}.`)));
  const put = async (route, body, names, declared) => {
    for (const name of names) body[name] = declared[name];
    await client.request(route, { method: 'PUT', body, solution: action.solution, mergeLabels: true });
  };
  if (action.kind === 'table') {
    if (!guid.test(current.MetadataId ?? '')) throw new Error(`Table identity of ${action.table} is unavailable.`);
    const tableNames = changed('');
    if (tableNames.length) {
      // A table update carries the table's own properties only; its columns are updated separately.
      const table = metadataBody(current, 'Microsoft.Dynamics.CRM.EntityMetadata');
      delete table.Attributes;
      await put(`EntityDefinitions(${current.MetadataId})`, table, tableNames, action.body);
    }
    const declared = action.body.Attributes[0],
      primaryNames = changed(`Attributes[${declared.SchemaName}].`),
      primary = current.Attributes?.[0];
    if (primaryNames.length) {
      if (!guid.test(primary?.MetadataId ?? ''))
        throw new Error(`Primary-name identity of ${action.table} is unavailable.`);
      await put(
        `EntityDefinitions(LogicalName='${action.table}')/Attributes(${primary.MetadataId})`,
        metadataBody(primary, declared['@odata.type']),
        primaryNames,
        declared,
      );
    }
  } else {
    if (!guid.test(current.MetadataId ?? '')) throw new Error(`Column identity of ${action.key} is unavailable.`);
    await put(
      `EntityDefinitions(LogicalName='${action.table}')/Attributes(${current.MetadataId})`,
      metadataBody(current, action.body['@odata.type']),
      changed(''),
      action.body,
    );
  }
  const actual = await existingComponent(client, action);
  if (!compatible(actual, action.body))
    throw new Error(
      `Dataverse did not retain the declared labels of ${driftLabel(action.key, metadataDifferences(actual, action.body))}.`,
    );
  return differences.map(({ property, declared, actual: before }) => ({ property, declared, before }));
}

async function one(client, route) {
  const rows = await client.list(route);
  if (rows.length > 1) throw new Error('Metadata identity resolved to multiple components.');
  return rows[0] ?? null;
}

// An acknowledged metadata create can precede visibility in the read endpoint.
// Retry only these required reads, never an uncertain mutation or an optional
// preflight lookup. Persistent absence leaves the apply journal interrupted.
async function requiredMetadata(client, route) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.get(route);
    } catch (error) {
      if (error.status !== 404 || attempt >= 5) throw error;
      await delay(Math.min(250 * 2 ** attempt, 2000));
    }
  }
}

function optionSetExpansion(body, cast) {
  if (body['GlobalOptionSet@odata.bind']) return '?$expand=GlobalOptionSet';
  if (cast === 'Microsoft.Dynamics.CRM.BooleanAttributeMetadata') return '?$expand=OptionSet';
  return '';
}

/* NOSONAR: preserve client lookup and continuation ordering */ async function existingComponent(client, action) {
  const b = action.body;
  if (action.kind === 'publisher') return one(client, `publishers?$filter=uniquename eq '${escape(b.uniquename)}'`);
  if (action.kind === 'solution') return one(client, `solutions?$filter=uniquename eq '${escape(b.uniquename)}'`);
  if (action.kind === 'choice')
    return client.optional(`GlobalOptionSetDefinitions(Name='${b.Name}')/Microsoft.Dynamics.CRM.OptionSetMetadata`);
  if (action.kind === 'table' || action.kind === 'table-reference') {
    const table = await client.optional(`EntityDefinitions(LogicalName='${action.table}')`);
    if (table && action.kind === 'table')
      table.Attributes = [
        await client.get(
          `EntityDefinitions(LogicalName='${action.table}')/Attributes(LogicalName='${b.PrimaryNameAttribute}')`,
        ),
      ];
    return table;
  }
  if (action.kind === 'column') {
    const cast = b['@odata.type'];
    const attribute = await client.optional(
      `EntityDefinitions(LogicalName='${action.table}')/Attributes(LogicalName='${action.column}')`,
    );
    if (!attribute) return null;
    if (
      attribute['@odata.type'] &&
      attribute['@odata.type'].replace(/^#/, '') !== cast &&
      attribute['@odata.type'].replace(/^#/, '') !== 'Microsoft.Dynamics.CRM.AttributeMetadata'
    )
      return attribute;
    return client.get(
      `EntityDefinitions(LogicalName='${action.table}')/Attributes(LogicalName='${action.column}')/${cast}${optionSetExpansion(b, cast)}`,
    );
  }
  if (action.kind === 'relationship') {
    const relation = await one(client, `RelationshipDefinitions?$filter=SchemaName eq '${b.SchemaName}'`);
    if (relation && b.Lookup)
      relation.Lookup = await client.optional(
        `EntityDefinitions(LogicalName='${b.ReferencingEntity}')/Attributes(LogicalName='${b.Lookup.SchemaName.toLowerCase()}')/Microsoft.Dynamics.CRM.LookupAttributeMetadata`,
      );
    return relation;
  }
  if (action.kind === 'key')
    return one(client, `EntityDefinitions(LogicalName='${action.table}')/Keys?$filter=SchemaName eq '${b.SchemaName}'`);
  if (action.kind === 'form') return client.optional(`systemforms(${action.id})`);
  if (action.kind === 'view') return client.optional(`savedqueries(${action.id})`);
  throw new Error('Unknown provisioning component kind.');
}

function requiredTableMissing(found, table) {
  return !found && table.existing;
}

// Membership rules shared by remote plans and applies, so a plan lists the writes that apply will make.
function isMember(rows, componentId, componentType) {
  const id = componentId?.toLowerCase();
  return Boolean(id) && rows.some((row) => row.componenttype === componentType && row.objectid?.toLowerCase() === id);
}

function tableRoots(rows) {
  return rows.filter((row) => row.componenttype === 1 && row.rootcomponentbehavior === 0);
}

function undeclaredRoots(roots, known) {
  return roots.filter((root) => !known.has(root.objectid?.toLowerCase()));
}

// Tables declared `includeAllSubcomponents`: their solution root keeps every subcomponent (root behaviour 0), so the
// solution lists no separate membership for their columns, relationships, keys, forms or views.
const wholeTables = (manifest) => new Set(manifest.tables.filter((t) => t.includeAllSubcomponents).map((t) => t.name));

function wholeRoot(rows, tableId) {
  const id = tableId?.toLowerCase();
  return rows.some(
    (row) => row.componenttype === 1 && row.rootcomponentbehavior === 0 && row.objectid?.toLowerCase() === id,
  );
}

function membershipRoute(solutionId) {
  return `solutioncomponents?$select=solutioncomponentid,objectid,componenttype,rootcomponentbehavior&$filter=_solutionid_value eq ${solutionId}`;
}

// The primary-name attribute of a table, or the lookup of a one-to-many relationship: apply includes each beside its component.
function companionColumn(action) {
  if (action.kind === 'table')
    return { label: 'Primary-name', table: action.table, column: action.body.PrimaryNameAttribute };
  if (action.kind === 'relationship' && action.body.Lookup)
    return {
      label: 'Lookup',
      table: action.body.ReferencingEntity,
      column: action.body.Lookup.SchemaName.toLowerCase(),
    };
  return null;
}

function columnRoute({ table, column }) {
  return `EntityDefinitions(LogicalName='${table}')/Attributes(LogicalName='${column}')`;
}

const readsExisting = (client, action, missingTables) =>
  Boolean(client) && !(['column', 'key'].includes(action.kind) && missingTables.has(action.table));

// The plan summary: action statuses and the membership operations counted from the membership list.
const planSummary = (actions, membership) => {
  const count = (operation) => membership.filter((entry) => entry.operation === operation).length;
  return {
    create: actions.filter((a) => a.status === 'create').length,
    exists: actions.filter((a) => a.status === 'exists').length,
    drift: actions.filter((a) => a.status === 'drift').length,
    labelDrift: actions.filter((a) => a.labelsOnly).length,
    membershipAdd: count('membership:add'),
    rootScoping: count('membership:scope-root'),
    blocked: count('blocked'),
  };
};

export async function planManifest(
  manifest = requiredArgument('planManifest(manifest, { client })', 'a manifest object'),
  { client } = {},
) {
  manifest = validateManifest(manifest);
  const compiled = compileManifest(manifest),
    actions = [],
    missingTables = new Set();
  const publisher = { id: undefined };
  if (client) {
    for (const table of manifest.tables) {
      const found = await client.optional(`EntityDefinitions(LogicalName='${table.name}')`);
      if (requiredTableMissing(found, table)) throw new Error(`Required existing table ${table.name} is absent.`);
      if (!found) missingTables.add(table.name);
    }
  }
  for (const action of compiled.actions) {
    const existing = readsExisting(client, action, missingTables) ? await existingComponent(client, action) : null;
    actions.push(planActionResult(action, existing, publisher));
  }
  const membership = client ? await planMembership(client, actions, wholeTables(manifest)) : [];
  return {
    ...compiled,
    environmentUrl: client?.origin ?? null,
    mode: client ? 'remote-read-only' : 'offline',
    actions,
    membership,
    summary: planSummary(actions, membership),
  };
}

// Reads solution membership only (GET). Solutions that the plan will create have no membership yet and are skipped.
async function planMembership(client, actions, whole) {
  const known = new Map(),
    membership = [];
  for (const action of actions) {
    if (action.kind === 'table' && action.existingId) known.set(action.existingId.toLowerCase(), action.table);
  }
  for (const solution of actions.filter((a) => a.kind === 'solution' && a.existingId)) {
    const name = solution.body.uniquename,
      rows = await client.list(membershipRoute(solution.existingId));
    membership.push(
      ...(await planAdditions(client, name, rows, actions, whole)),
      ...planRootScoping(name, rows, known, whole),
    );
  }
  return membership;
}

async function planAdditions(client, solution, rows, actions, whole) {
  const additions = [];
  // Apply includes (or widens) a whole table's root before its parts, which are then members through it.
  const covered = (table) => whole.has(table);
  const want = (objectId, componentType, key, table) => {
    if (componentType !== 1 && covered(table)) return;
    if (!isMember(rows, objectId, componentType))
      additions.push({ operation: 'membership:add', solution, componentType, objectId, key });
  };
  for (const action of actions.filter((a) => a.solution === solution && TYPES[a.kind])) {
    if (action.status === 'create') {
      // The identity of a component that does not exist yet is known only after apply creates it.
      additions.push({
        operation: 'membership:add',
        solution,
        componentType: TYPES[action.kind],
        objectId: null,
        key: action.key,
      });
      continue;
    }
    want(action.existingId, TYPES[action.kind], action.key, action.table);
    const companion = companionColumn(action);
    if (companion && !covered(companion.table)) {
      const attribute = await client.optional(columnRoute(companion));
      if (attribute?.MetadataId) want(attribute.MetadataId, 2, `${action.key}/${companion.column}`, companion.table);
    }
  }
  return additions;
}

// A root differs from its declaration when it includes every subcomponent of a table declared with only its listed
// parts (narrowed to them), or lists only parts of a table declared `includeAllSubcomponents` (widened to all).
function planRootScoping(solution, rows, known, whole) {
  const roots = tableRoots(rows),
    undeclared = new Set(undeclaredRoots(roots, known));
  const scope = (root, subcomponents) => ({
    operation: 'membership:scope-root',
    solution,
    componentType: 1,
    objectId: root.objectid,
    table: known.get(root.objectid.toLowerCase()),
    subcomponents,
  });
  const widened = rows
    .filter((row) => row.componenttype === 1 && row.rootcomponentbehavior !== 0)
    .filter((row) => whole.has(known.get(row.objectid?.toLowerCase())))
    .map((row) => scope(row, 'all'));
  const narrowed = roots
    .filter((root) => !whole.has(known.get(root.objectid?.toLowerCase())))
    .map((root) =>
      undeclared.has(root)
        ? {
            operation: 'blocked',
            solution,
            componentType: 1,
            objectId: root.objectid,
            reason: 'undeclared table root would include unrelated subcomponents',
          }
        : scope(root, 'declared'),
    );
  return [...narrowed, ...widened];
}

function planActionResult(action, existing, publisher) {
  if (action.kind === 'publisher') publisher.id = existing?.publisherid;
  const wrongPublisher =
    action.kind === 'solution' &&
    existing &&
    (!publisher.id || existing._publisherid_value?.toLowerCase() !== publisher.id.toLowerCase());
  let status;
  if (!existing) status = 'create';
  else if (compatible(existing, action.body) && !wrongPublisher) status = 'exists';
  else status = 'drift';
  const differences =
    status === 'drift'
      ? [
          ...metadataDifferences(existing, action.body),
          ...(wrongPublisher
            ? [{ property: 'publisher', declared: publisher.id ?? null, actual: existing._publisherid_value ?? null }]
            : []),
        ]
      : null;
  return {
    ...action,
    status,
    ...(differences ? { differences } : {}),
    ...(differences && labelsOnly(action, differences) ? { labelsOnly: true } : {}),
    ...(existing
      ? {
          existingId:
            existing.MetadataId ??
            existing.publisherid ??
            existing.solutionid ??
            existing.formid ??
            existing.savedqueryid,
        }
      : {}),
    ...(action.kind === 'key' && existing ? { keyStatus: existing.EntityKeyIndexStatus } : {}),
  };
}

/* NOSONAR: preserve write, journal and progress callback ordering */ export async function applyManifest(
  input = requiredArgument('applyManifest(manifest, { client, journalFile })', 'a manifest object'),
  { client, journalFile, expectedOrganisationId, updateLabels: labelsAllowed = false, onProgress = () => {} },
) {
  const manifest = validateManifest(input);
  const identity = await client.verify(expectedOrganisationId);
  const plan = await planManifest(manifest, { client });
  const refused = plan.actions.filter((a) => a.status === 'drift' && !(labelsAllowed && a.labelsOnly));
  if (refused.length) {
    const drifted = refused.map((a) => driftLabel(a.key, a.differences));
    const hint = refused.every((a) => a.labelsOnly)
      ? 'Only display labels differ: rerun apply with --update-labels to change them to the declared labels.'
      : 'Inspect a remote plan; additive provisioning will not overwrite them.';
    throw new Error(
      `Existing metadata has ${refused.length} incompatible component(s): ${drifted.join('; ')}. ${hint}`,
    );
  }
  if (plan.summary.blocked) {
    const roots = plan.membership.filter((e) => e.operation === 'blocked').map((e) => `${e.solution}/${e.objectId}`);
    throw new Error(
      `Undeclared table root would include unrelated subcomponents; apply refuses before writing: ${roots.join(', ')}.`,
    );
  }
  const journal = {
    schemaVersion: 1,
    manifestHash: plan.manifestHash,
    environmentUrl: client.origin,
    identity,
    startedAt: new Date().toISOString(),
    state: 'Running',
    entries: [],
  };
  if (journalFile) await privateJson(journalFile, journal, true);
  let publisherId,
    membershipWrites = 0;
  const solutionIds = new Map();
  const choiceIds = new Map();
  const whole = wholeTables(manifest),
    tableIds = new Map();
  const members = (solutionId, id, type) =>
    client.list(
      `solutioncomponents?$select=objectid,componenttype,rootcomponentbehavior&$filter=_solutionid_value eq ${solutionId} and objectid eq ${id} and componenttype eq ${type}`,
    );
  // A table root carries its declared subcomponent scope; a part of a whole root is already a member through it.
  const include = async (id, type, solution, table, root = false) => {
    const solutionId = solutionIds.get(solution);
    if (!guid.test(solutionId ?? '')) throw new Error('Solution identity is unavailable.');
    const all = root && whole.has(table),
      tableId = whole.has(table) && !root ? tableIds.get(table) : null;
    if (tableId && wholeRoot(await members(solutionId, tableId, 1), tableId)) return;
    const included = await members(solutionId, id, type);
    if (isMember(included, id, type) && !(all && !wholeRoot(included, id))) return;
    membershipWrites++;
    await client.request('AddSolutionComponent', {
      method: 'POST',
      body: {
        ComponentId: id,
        ComponentType: type,
        SolutionUniqueName: solution,
        AddRequiredComponents: false,
        ...(root ? { DoNotIncludeSubcomponents: !all } : {}),
      },
    });
    if (all && !wholeRoot(await members(solutionId, id, 1), id))
      throw new Error(`Dataverse did not retain the whole-table root of ${table}.`);
  };
  try {
    for (const planned of plan.actions) {
      journal.pending = planned.key;
      if (journalFile) await privateJson(journalFile, journal);
      // Re-read each identity before its write; preflight snapshots can become stale.
      const current = await existingComponent(client, planned);
      let labels = null;
      if (current && !compatible(current, planned.body)) {
        const differences = metadataDifferences(current, planned.body);
        if (!(labelsAllowed && planned.labelsOnly && labelsOnly(planned, differences)))
          throw new Error(
            `Metadata changed while applying ${driftLabel(planned.key, differences)}. Re-plan before continuing.`,
          );
        labels = await updateLabels(client, planned, current, differences);
      }
      if (
        planned.kind === 'solution' &&
        current &&
        current._publisherid_value?.toLowerCase() !== publisherId?.toLowerCase()
      )
        throw new Error('Solution publisher changed while applying.');
      let componentId =
        current?.MetadataId ?? current?.publisherid ?? current?.solutionid ?? current?.formid ?? current?.savedqueryid;
      let status = labels ? 'labels-updated' : 'exists';
      let primaryNameLength = null;
      if (!current) {
        if (planned.kind === 'table-reference') throw new Error('Required existing table disappeared.');
        const body = structuredClone(planned.body);
        // Name resolves reliably for reads; bind writes use the server MetadataId.
        // Some Dataverse builds reject Name-key bindings with a GUID parse error.
        const binding = body['GlobalOptionSet@odata.bind']?.match(/^\/GlobalOptionSetDefinitions\(Name='([^']+)'\)$/);
        if (binding) {
          const id = choiceIds.get(binding[1]);
          if (!guid.test(id ?? '')) throw new Error('Global choice identity is unavailable.');
          body['GlobalOptionSet@odata.bind'] = `/GlobalOptionSetDefinitions(${id})`;
        }
        if (planned.kind === 'solution') {
          if (!publisherId || !guid.test(publisherId)) throw new Error('Publisher identity is missing.');
          body['publisherid@odata.bind'] = `/publishers(${publisherId})`;
        }
        const result = await client.request(planned.route, { method: 'POST', body, solution: planned.solution });
        componentId = planned.id ?? metadataId(result);
        status = 'created';
        if (planned.kind === 'table') primaryNameLength = await completePrimaryNameLength(client, planned);
        if (planned.kind === 'relationship' && planned.body.Lookup)
          await completeLookupAudit(
            client,
            planned.body.ReferencingEntity,
            planned.body.Lookup.SchemaName.toLowerCase(),
            planned.solution,
          );
      }
      if (planned.kind === 'publisher') publisherId = componentId;
      if (planned.kind === 'solution') solutionIds.set(planned.body.uniquename, componentId);
      if (planned.kind === 'choice') choiceIds.set(planned.body.Name, componentId);
      if (planned.kind === 'table') tableIds.set(planned.table, componentId);
      if (TYPES[planned.kind]) {
        if (!guid.test(componentId ?? '')) throw new Error('Invalid component ID; reconcile before continuing.');
        await include(
          componentId,
          TYPES[planned.kind],
          planned.solution,
          planned.table,
          ['table', 'table-reference'].includes(planned.kind),
        );
        const companion = companionColumn(planned);
        if (companion) {
          const attribute = await requiredMetadata(client, columnRoute(companion));
          if (!guid.test(attribute.MetadataId ?? ''))
            throw new Error(`${companion.label} metadata identity is unavailable; reconcile before exporting.`);
          await include(attribute.MetadataId, 2, planned.solution, companion.table);
        }
      }
      const entry = {
        key: planned.key,
        status,
        componentId,
        bodyHash: digest(planned.body),
        ...(primaryNameLength ? { primaryNameLength } : {}),
        ...(labels ? { labels } : {}),
        finishedAt: new Date().toISOString(),
      };
      journal.entries.push(entry);
      delete journal.pending;
      if (journalFile) await privateJson(journalFile, journal);
      onProgress(entry);
    }
    journal.solutionRoots = await scopeSolutionRoots(manifest, client, {
      onProgress: async (event) => {
        journal.rootScoping ??= [];
        journal.rootScoping.push(event);
        if (journalFile) await privateJson(journalFile, journal);
      },
    });
    // The outcome, not the operation: Created when a component was created, Updated when only labels, solution
    // membership or table-root scoping were written, Unchanged when the run wrote nothing.
    if (journal.entries.some((entry) => entry.status === 'created')) journal.state = 'Created';
    else if (
      membershipWrites ||
      journal.solutionRoots.changedRoots ||
      journal.entries.some((entry) => entry.status === 'labels-updated')
    )
      journal.state = 'Updated';
    else journal.state = 'Unchanged';
    journal.finishedAt = new Date().toISOString();
    if (journalFile) await privateJson(journalFile, journal);
    return journal;
  } catch (error) {
    journal.state = error.code === 'UNKNOWN_COMMIT' ? 'UnknownCommit' : 'Interrupted';
    journal.error = { code: error.code ?? 'PROVISIONING_STOPPED', message: error.message };
    if (journalFile) await privateJson(journalFile, journal);
    throw error;
  }
}

// Creating metadata with SolutionUniqueName can automatically add a table root
// with IncludeSubcomponents. That later pulls another solution's forms/columns
// into this export. Keep explicitly added subcomponents and narrow only known
// table roots through the supported AddSolutionComponent action.
/* NOSONAR: preserve public lifecycle await ordering */ export async function scopeSolutionRoots(
  input = requiredArgument('scopeSolutionRoots(manifest, client)', 'a manifest object'),
  client,
  { onProgress = () => {} } = {},
) {
  const manifest = validateManifest(input),
    whole = wholeTables(manifest),
    known = new Map(),
    changes = [];
  for (const table of manifest.tables) {
    const actual = await client.get(`EntityDefinitions(LogicalName='${table.name}')?$select=MetadataId,LogicalName`);
    if (!guid.test(actual.MetadataId ?? '')) throw new Error('Table identity unavailable for solution scoping.');
    known.set(actual.MetadataId.toLowerCase(), table.name);
  }
  const solutionIds = new Map(),
    scopes = [],
    declared = [];
  for (const action of compileManifest(manifest).actions.filter((a) => TYPES[a.kind])) {
    const current = await existingComponent(client, action);
    if (!current)
      throw new Error(`Declared metadata must exist unchanged before solution scoping: ${action.key} is missing.`);
    if (!compatible(current, action.body))
      throw new Error(
        'Declared metadata must exist unchanged before solution scoping: ' +
          `${driftLabel(action.key, metadataDifferences(current, action.body))} differs.`,
      );
    declared.push({ action, current });
  }
  const add = async (id, type, solution) =>
    client.request('AddSolutionComponent', {
      method: 'POST',
      body: {
        ComponentId: id,
        ComponentType: type,
        SolutionUniqueName: solution,
        AddRequiredComponents: false,
        ...(type === 1 ? { DoNotIncludeSubcomponents: true } : {}),
      },
    });
  for (const solution of manifest.solutions) {
    const rows = await client.list(`solutions?$select=solutionid&$filter=uniquename eq '${solution.uniqueName}'`);
    if (rows.length !== 1) throw new Error('Solution identity unavailable for table-root scoping.');
    const sid = rows[0].solutionid;
    solutionIds.set(solution.uniqueName, sid);
    const route = membershipRoute(sid),
      before = await client.list(route),
      roots = tableRoots(before);
    if (undeclaredRoots(roots, known).length)
      throw new Error('Undeclared table root would include unrelated subcomponents; scoping refused.');
    // A table declared includeAllSubcomponents keeps its whole root.
    scopes.push({
      solution,
      sid,
      route,
      before,
      roots: roots.filter((r) => !whole.has(known.get(r.objectid.toLowerCase()))),
    });
  }
  for (const { solution, sid, route, before, roots } of scopes) {
    if (!roots.length) continue;
    // The action does not narrow an existing IncludeAll root. Removing only its
    // solution membership leaves the Dataverse table/data intact. Save every
    // explicit component first; the caller's journal makes interruption reviewable.
    /* NOSONAR: Preserve the original progress callback await boundary. */ await onProgress({
      state: 'before-membership-replacement',
      solution: solution.uniqueName,
      components: before,
    });
    for (const root of roots) {
      await client.request('RemoveSolutionComponent', {
        method: 'POST',
        body: {
          SolutionComponent: {
            '@odata.type': 'Microsoft.Dynamics.CRM.solutioncomponent',
            solutioncomponentid: root.objectid,
          },
          ComponentType: 1,
          SolutionUniqueName: solution.uniqueName,
        },
      });
      await add(root.objectid, 1, solution.uniqueName);
      const after = (await client.list(route)).find(
        (row) => row.componenttype === 1 && row.objectid?.toLowerCase() === root.objectid.toLowerCase(),
      );
      if (after?.rootcomponentbehavior !== 1) throw new Error('Dataverse did not retain explicit table-root scoping.');
      changes.push({
        solution: solution.uniqueName,
        table: known.get(root.objectid.toLowerCase()),
        before: 0,
        after: 1,
      });
    }
    for (const component of before.filter((row) => row.componenttype !== 1)) {
      const present = await client.list(
        `solutioncomponents?$select=objectid&$filter=_solutionid_value eq ${sid} and objectid eq ${component.objectid} and componenttype eq ${component.componenttype}`,
      );
      if (!present.length) await add(component.objectid, component.componenttype, solution.uniqueName);
    }
    /* NOSONAR: Preserve the original progress callback await boundary. */ await onProgress({
      state: 'roots-scoped',
      solution: solution.uniqueName,
    });
  }
  // IncludeAll roots can mask absent explicit membership. Restore the declared
  // metadata after narrowing; never create/alter a table, column or business row.
  for (const { action, current } of declared) {
    if (whole.has(action.table)) continue; // a member through its whole table root
    const id = current.MetadataId ?? current.formid ?? current.savedqueryid,
      type = TYPES[action.kind],
      sid = solutionIds.get(action.solution);
    if (!guid.test(id ?? '')) throw new Error('Declared component identity unavailable during solution scoping.');
    const present = await client.list(
      `solutioncomponents?$select=objectid&$filter=_solutionid_value eq ${sid} and objectid eq ${id} and componenttype eq ${type}`,
    );
    if (!present.length) await add(id, type, action.solution);
    if (action.kind === 'table') {
      const primary = await client.get(
        `EntityDefinitions(LogicalName='${action.table}')/Attributes(LogicalName='${action.body.PrimaryNameAttribute}')`,
      );
      if (!guid.test(primary.MetadataId ?? ''))
        throw new Error('Primary-name component unavailable during solution scoping.');
      const included = await client.list(
        `solutioncomponents?$select=objectid&$filter=_solutionid_value eq ${sid} and objectid eq ${primary.MetadataId} and componenttype eq 2`,
      );
      if (!included.length) await add(primary.MetadataId, 2, action.solution);
    }
  }
  for (const relation of manifest.relationships.filter((r) => r.kind === 'oneToMany' && !whole.has(r.child))) {
    const attribute = await client.get(
        `EntityDefinitions(LogicalName='${relation.child}')/Attributes(LogicalName='${relation.lookup.name}')`,
      ),
      sid = solutionIds.get(relation.solution);
    if (!guid.test(attribute.MetadataId ?? ''))
      throw new Error('Lookup component unavailable during solution scoping.');
    const included = await client.list(
      `solutioncomponents?$select=objectid&$filter=_solutionid_value eq ${sid} and objectid eq ${attribute.MetadataId} and componenttype eq 2`,
    );
    if (!included.length) await add(attribute.MetadataId, 2, relation.solution);
  }
  /* NOSONAR: Preserve the original progress callback await boundary. */ await onProgress({
    state: 'declared-memberships-restored',
    changedRoots: changes.length,
  });
  return { changedRoots: changes.length, changes };
}

// Observed on the live developer environment (2026-11-18): creating a table stores its primary-name column with
// MaxLength 850 whatever the create declares, and a follow-up attribute update sets the declared value, which then
// persists. Apply makes that update right after the create and verifies it by readback. Returns the journal record of
// the correction, or null when the platform already kept the declared length.
async function completePrimaryNameLength(client, action) {
  const table = action.table,
    declared = action.body.Attributes[0].MaxLength,
    route = `${columnRoute({ table, column: action.body.PrimaryNameAttribute })}/Microsoft.Dynamics.CRM.StringAttributeMetadata`;
  const attribute = await requiredMetadata(client, route);
  if (attribute.MaxLength === declared) return null;
  if (!guid.test(attribute.MetadataId ?? ''))
    throw new Error(`Primary-name metadata identity of ${table} is unavailable; reconcile before continuing.`);
  const body = structuredClone(attribute);
  for (const key of Object.keys(body)) if (key.startsWith('@odata.') && key !== '@odata.type') delete body[key];
  body['@odata.type'] = 'Microsoft.Dynamics.CRM.StringAttributeMetadata';
  body.MaxLength = declared;
  await client.request(`EntityDefinitions(LogicalName='${table}')/Attributes(${attribute.MetadataId})`, {
    method: 'PUT',
    body,
    solution: action.solution,
    mergeLabels: true,
  });
  const actual = await client.get(route);
  if (actual.MaxLength !== declared)
    throw new Error(
      `Dataverse did not retain the declared primary-name maxLength ${declared} of ${table} ` +
        `(it stores ${actual.MaxLength}); reconcile the column before continuing.`,
    );
  return { declared, created: attribute.MaxLength, updated: actual.MaxLength };
}

async function completeLookupAudit(client, table, column, solution) {
  const attribute = await requiredMetadata(
    client,
    `EntityDefinitions(LogicalName='${table}')/Attributes(LogicalName='${column}')/Microsoft.Dynamics.CRM.LookupAttributeMetadata`,
  );
  if (attribute.IsAuditEnabled?.Value === true) return false;
  if (attribute.IsAuditEnabled?.CanBeChanged === false || !guid.test(attribute.MetadataId ?? ''))
    throw new Error('Declared lookup audit setting cannot be completed.');
  const body = structuredClone(attribute);
  for (const key of Object.keys(body)) if (key.startsWith('@odata.') && key !== '@odata.type') delete body[key];
  body['@odata.type'] = 'Microsoft.Dynamics.CRM.LookupAttributeMetadata';
  body.IsAuditEnabled.Value = true;
  await client.request(`EntityDefinitions(LogicalName='${table}')/Attributes(${attribute.MetadataId})`, {
    method: 'PUT',
    body,
    solution,
    mergeLabels: true,
  });
  const actual = await client.get(
    `EntityDefinitions(LogicalName='${table}')/Attributes(LogicalName='${column}')/Microsoft.Dynamics.CRM.LookupAttributeMetadata`,
  );
  if (actual.IsAuditEnabled?.Value !== true) throw new Error('Dataverse did not retain the lookup audit setting.');
  return true;
}
export async function completeLookupAuditing(
  input = requiredArgument('completeLookupAuditing(manifest, client)', 'a manifest object'),
  client,
) {
  const m = validateManifest(input);
  let checked = 0,
    updated = 0;
  for (const r of m.relationships.filter((r) => r.kind === 'oneToMany')) {
    checked++;
    if (await completeLookupAudit(client, r.child, r.lookup.name, r.solution)) updated++;
  }
  return { checkedLookups: checked, updatedLookups: updated };
}

const xmlEscape = (s) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
export async function publishManifest(
  input = requiredArgument('publishManifest(manifest, client)', 'a manifest object'),
  client,
) {
  const manifest = validateManifest(input);
  const entities = manifest.tables.map((t) => `<entity>${xmlEscape(t.name)}</entity>`).join('');
  const choices = manifest.choices.map((c) => `<optionset>${xmlEscape(c.name)}</optionset>`).join('');
  await client.request('PublishXml', {
    method: 'POST',
    body: {
      ParameterXml: `<importexportxml><entities>${entities}</entities><optionsets>${choices}</optionsets></importexportxml>`,
    },
  });
  return { publishedTables: manifest.tables.length, publishedChoices: manifest.choices.length };
}

export async function checkKeys(input = requiredArgument('checkKeys(manifest, client)', 'a manifest object'), client) {
  const manifest = validateManifest(input),
    keys = [];
  for (const table of manifest.tables)
    for (const key of table.keys) {
      const actual = await one(
        client,
        `EntityDefinitions(LogicalName='${table.name}')/Keys?$filter=SchemaName eq '${key.name}'`,
      );
      keys.push({
        table: table.name,
        key: key.name,
        status: actual?.EntityKeyIndexStatus ?? 'Missing',
        asyncJob: actual?.AsyncJob ?? null,
      });
    }
  return { ready: keys.every((k) => k.status === 'Active'), keys };
}

export async function exportSolution(
  { client, solutionName, zipFile, unpackFolder } = requiredArgument(
    'exportSolution({ client, solutionName, zipFile, unpackFolder })',
    'an options object with client, solutionName, zipFile and unpackFolder',
  ),
) {
  if (!/^[a-z][a-z0-9_]*$/i.test(solutionName)) throw new Error('Invalid solution name.');
  const result = await client.request('ExportSolution', {
    method: 'POST',
    body: { SolutionName: solutionName, Managed: false },
  });
  const encoded = result.data?.ExportSolutionFile;
  if (typeof encoded !== 'string' || !encoded) throw new Error('Export did not return a solution file.');
  const zip = Buffer.from(encoded, 'base64');
  if (zip.subarray(0, 2).toString() !== 'PK') throw new Error('Export is not a ZIP archive.');
  await fs.mkdir(path.dirname(path.resolve(zipFile)), { recursive: true });
  await fs.writeFile(zipFile, zip, { flag: 'wx', mode: 0o600 }).catch((error) => {
    throw error.code === 'EEXIST' ? existingPathError(zipFile) : error;
  });
  if (unpackFolder) {
    const result = await runProcess(pacExecutable(), [
      'solution',
      'unpack',
      '--zipfile',
      path.resolve(zipFile),
      '--folder',
      path.resolve(unpackFolder),
      '--packagetype',
      'Unmanaged',
    ]);
    /* NOSONAR */ if (
      result.code !== 0 ||
      result.timedOut ||
      /^(?:(?![\r\n\u2028\u2029])\s)*Error:/im.test(result.stdout + '\n' + result.stderr)
    )
      throw new Error('PAC unpack failed; exported ZIP preserved. PAC output withheld.');
  }
  return {
    solutionName,
    zipFile: path.resolve(zipFile),
    zipHash: digest(zip),
    unpackFolder: unpackFolder ? path.resolve(unpackFolder) : null,
  };
}
