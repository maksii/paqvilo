import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { compileManifest, digest, validateManifest } from './manifest.mjs';
import { metadataId } from './client.mjs';
import { privateJson, pacExecutable, runProcess } from './connection.mjs';
import { parseXmlDocument } from '../../mirage/lib/fetchxml-engine.mjs';

// Dataverse adds a savedqueryid and reserializes metadata XML on publish.
// Normalize syntax only; preserve every field, filter, join, value and order.
export function metadataXml(source) {
  const tree = parseXmlDocument(source);
  const normalize = (node, isRoot = false) => ({
    name: node.name,
    attrs: Object.fromEntries(
      Object.entries(node.attrs)
        .filter(([key]) => !(isRoot && node.name === 'fetch' && key === 'savedqueryid'))
        .sort(([a], [b]) => a.localeCompare(b)),
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

async function existingComponent(client, action) {
  const b = action.body;
  switch (action.kind) {
    case 'publisher':
      return one(client, `publishers?$filter=uniquename eq '${escape(b.uniquename)}'`);
    case 'solution':
      return one(client, `solutions?$filter=uniquename eq '${escape(b.uniquename)}'`);
    case 'choice':
      return client.optional(`GlobalOptionSetDefinitions(Name='${b.Name}')/Microsoft.Dynamics.CRM.OptionSetMetadata`);
    case 'table':
    case 'table-reference':
      return existingTable(client, action);
    case 'column':
      return existingColumn(client, action);
    case 'relationship':
      return existingRelationship(client, action);
    case 'key':
      return one(
        client,
        `EntityDefinitions(LogicalName='${action.table}')/Keys?$filter=SchemaName eq '${b.SchemaName}'`,
      );
    case 'form':
      return client.optional(`systemforms(${action.id})`);
    case 'view':
      return client.optional(`savedqueries(${action.id})`);
    default:
      throw new Error('Unknown provisioning component kind.');
  }
}

async function existingTable(client, action) {
  const table = await client.optional(`EntityDefinitions(LogicalName='${action.table}')`);
  if (table && action.kind === 'table')
    table.Attributes = [
      await client.get(
        `EntityDefinitions(LogicalName='${action.table}')/Attributes(LogicalName='${action.body.PrimaryNameAttribute}')`,
      ),
    ];
  return table;
}

async function existingColumn(client, action) {
  const b = action.body,
    cast = b['@odata.type'];
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
  let expand = '';
  if (b['GlobalOptionSet@odata.bind']) expand = '?$expand=GlobalOptionSet';
  else if (cast === 'Microsoft.Dynamics.CRM.BooleanAttributeMetadata') expand = '?$expand=OptionSet';
  return client.get(
    `EntityDefinitions(LogicalName='${action.table}')/Attributes(LogicalName='${action.column}')/${cast}${expand}`,
  );
}

async function existingRelationship(client, action) {
  const b = action.body,
    relation = await one(client, `RelationshipDefinitions?$filter=SchemaName eq '${b.SchemaName}'`);
  if (relation && b.Lookup)
    relation.Lookup = await client.optional(
      `EntityDefinitions(LogicalName='${b.ReferencingEntity}')/Attributes(LogicalName='${b.Lookup.SchemaName.toLowerCase()}')/Microsoft.Dynamics.CRM.LookupAttributeMetadata`,
    );
  return relation;
}

export async function planManifest(manifest, { client } = {}) {
  manifest = validateManifest(manifest);
  const compiled = compileManifest(manifest),
    actions = [],
    missingTables = client ? await missingManifestTables(manifest, client) : new Set();
  const publisher = { id: undefined };
  for (const action of compiled.actions) {
    if (!client) actions.push(offlinePlanAction(action, publisher));
    else if (['column', 'key'].includes(action.kind) && missingTables.has(action.table))
      actions.push(planActionResult(action, null, publisher));
    else actions.push(await planAction(client, action, publisher));
  }
  return {
    ...compiled,
    environmentUrl: client?.origin ?? null,
    mode: client ? 'remote-read-only' : 'offline',
    actions,
    summary: {
      create: actions.filter((a) => a.status === 'create').length,
      exists: actions.filter((a) => a.status === 'exists').length,
      drift: actions.filter((a) => a.status === 'drift').length,
    },
  };
}

async function missingManifestTables(manifest, client) {
  const missingTables = new Set();
  if (!client) return missingTables;
  for (const table of manifest.tables) {
    const found = await client.optional(`EntityDefinitions(LogicalName='${table.name}')`);
    if (!found && table.existing) throw new Error(`Required existing table ${table.name} is absent.`);
    if (!found) missingTables.add(table.name);
  }
  return missingTables;
}

async function planAction(client, action, publisher) {
  const existing = await existingComponent(client, action);
  return planActionResult(action, existing, publisher);
}

function offlinePlanAction(action, publisher) {
  return planActionResult(action, null, publisher);
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
  return {
    ...action,
    status,
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

export async function applyManifest(input, { client, journalFile, expectedOrganisationId, onProgress = () => {} }) {
  const manifest = validateManifest(input);
  const identity = await client.verify(expectedOrganisationId);
  const plan = await planManifest(manifest, { client });
  if (plan.summary.drift)
    throw new Error(
      `Existing metadata has ${plan.summary.drift} incompatible component(s). Inspect a remote plan; additive provisioning will not overwrite them.`,
    );
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
  const state = { publisherId: undefined, solutionIds: new Map(), choiceIds: new Map() };
  try {
    for (const planned of plan.actions) {
      journal.pending = planned.key;
      if (journalFile) await privateJson(journalFile, journal);
      // Re-read each identity before its write; preflight snapshots can become stale.
      const entry = await applyPlannedAction(client, planned, state);
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
    journal.state = 'Created';
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

async function applyPlannedAction(client, planned, state) {
  const current = await existingComponent(client, planned);
  if (current && !compatible(current, planned.body))
    throw new Error(`Metadata changed while applying ${planned.key}. Re-plan before continuing.`);
  if (
    planned.kind === 'solution' &&
    current &&
    current._publisherid_value?.toLowerCase() !== state.publisherId?.toLowerCase()
  )
    throw new Error('Solution publisher changed while applying.');
  let componentId =
    current?.MetadataId ?? current?.publisherid ?? current?.solutionid ?? current?.formid ?? current?.savedqueryid;
  let status = 'exists';
  if (!current) {
    const created = await createPlannedComponent(client, planned, state);
    componentId = created.componentId;
    status = created.status;
  }
  updateProvisioningIdentities(planned, componentId, state);
  if (TYPES[planned.kind]) await includePlannedComponent(client, planned, componentId, state.solutionIds);
  return {
    key: planned.key,
    status,
    componentId,
    bodyHash: digest(planned.body),
    finishedAt: new Date().toISOString(),
  };
}

async function createPlannedComponent(client, planned, state) {
  if (planned.kind === 'table-reference') throw new Error('Required existing table disappeared.');
  const body = structuredClone(planned.body);
  // Name resolves reliably for reads; bind writes use the server MetadataId.
  // Some Dataverse builds reject Name-key bindings with a GUID parse error.
  const binding = body['GlobalOptionSet@odata.bind']?.match(/^\/GlobalOptionSetDefinitions\(Name='([^']+)'\)$/);
  if (binding) {
    const id = state.choiceIds.get(binding[1]);
    if (!guid.test(id ?? '')) throw new Error('Global choice identity is unavailable.');
    body['GlobalOptionSet@odata.bind'] = `/GlobalOptionSetDefinitions(${id})`;
  }
  if (planned.kind === 'solution') {
    if (!state.publisherId || !guid.test(state.publisherId)) throw new Error('Publisher identity is missing.');
    body['publisherid@odata.bind'] = `/publishers(${state.publisherId})`;
  }
  const result = await client.request(planned.route, { method: 'POST', body, solution: planned.solution }),
    componentId = planned.id ?? metadataId(result);
  if (planned.kind === 'relationship' && planned.body.Lookup)
    await completeLookupAudit(
      client,
      planned.body.ReferencingEntity,
      planned.body.Lookup.SchemaName.toLowerCase(),
      planned.solution,
    );
  return { componentId, status: 'created' };
}

function updateProvisioningIdentities(planned, componentId, state) {
  if (planned.kind === 'publisher') state.publisherId = componentId;
  if (planned.kind === 'solution') state.solutionIds.set(planned.body.uniquename, componentId);
  if (planned.kind === 'choice') state.choiceIds.set(planned.body.Name, componentId);
}

async function includeComponent(client, id, type, solution, solutionIds, root = false) {
  const solutionId = solutionIds.get(solution);
  if (!guid.test(solutionId ?? '')) throw new Error('Solution identity is unavailable.');
  const included = await client.list(
    `solutioncomponents?$select=objectid,componenttype,rootcomponentbehavior&$filter=_solutionid_value eq ${solutionId} and objectid eq ${id} and componenttype eq ${type}`,
  );
  if (!included.length)
    await client.request('AddSolutionComponent', {
      method: 'POST',
      body: {
        ComponentId: id,
        ComponentType: type,
        SolutionUniqueName: solution,
        AddRequiredComponents: false,
        ...(root ? { DoNotIncludeSubcomponents: true } : {}),
      },
    });
}

async function includePlannedComponent(client, planned, componentId, solutionIds) {
  if (!guid.test(componentId ?? '')) throw new Error('Invalid component ID; reconcile before continuing.');
  await includeComponent(
    client,
    componentId,
    TYPES[planned.kind],
    planned.solution,
    solutionIds,
    ['table', 'table-reference'].includes(planned.kind),
  );
  if (planned.kind === 'table') await includePrimaryName(client, planned, solutionIds);
  if (planned.kind === 'relationship' && planned.body.Lookup) await includeLookup(client, planned, solutionIds);
}

async function includePrimaryName(client, planned, solutionIds) {
  const primary = await requiredMetadata(
    client,
    `EntityDefinitions(LogicalName='${planned.table}')/Attributes(LogicalName='${planned.body.PrimaryNameAttribute}')`,
  );
  if (!guid.test(primary.MetadataId ?? ''))
    throw new Error('Primary-name metadata identity is unavailable; reconcile before exporting.');
  await includeComponent(client, primary.MetadataId, 2, planned.solution, solutionIds);
}

async function includeLookup(client, planned, solutionIds) {
  const lookup = await requiredMetadata(
    client,
    `EntityDefinitions(LogicalName='${planned.body.ReferencingEntity}')/Attributes(LogicalName='${planned.body.Lookup.SchemaName.toLowerCase()}')`,
  );
  if (!guid.test(lookup.MetadataId ?? ''))
    throw new Error('Lookup metadata identity is unavailable; reconcile before exporting.');
  await includeComponent(client, lookup.MetadataId, 2, planned.solution, solutionIds);
}

// Creating metadata with SolutionUniqueName can automatically add a table root
// with IncludeSubcomponents. That later pulls another solution's forms/columns
// into this export. Keep explicitly added subcomponents and narrow only known
// table roots through the supported AddSolutionComponent action.
export async function scopeSolutionRoots(input, client, { onProgress = () => {} } = {}) {
  const manifest = validateManifest(input),
    known = await knownTableIdentities(manifest, client),
    changes = [];
  const declared = await declaredComponents(manifest, client),
    solutionIds = new Map(),
    scopes = await solutionScopes(manifest, client, known, solutionIds);
  for (const scope of scopes) {
    if (!scope.roots.length) continue;
    await scopeRoots(scope, client, known, changes, onProgress);
  }
  await restoreDeclaredComponents(declared, solutionIds, client);
  await restoreRelationshipLookups(manifest, solutionIds, client);
  await onProgress({ state: 'declared-memberships-restored', changedRoots: changes.length }); // NOSONAR: await kept: the value may be a thenable and timing matters
  return { changedRoots: changes.length, changes };
}

async function knownTableIdentities(manifest, client) {
  const known = new Map();
  for (const table of manifest.tables) {
    const actual = await client.get(`EntityDefinitions(LogicalName='${table.name}')?$select=MetadataId,LogicalName`);
    if (!guid.test(actual.MetadataId ?? '')) throw new Error('Table identity unavailable for solution scoping.');
    known.set(actual.MetadataId.toLowerCase(), table.name);
  }
  return known;
}

async function declaredComponents(manifest, client) {
  const declared = [];
  for (const action of compileManifest(manifest).actions.filter((a) => TYPES[a.kind])) {
    const current = await existingComponent(client, action);
    if (!current || !compatible(current, action.body))
      throw new Error('Declared metadata must exist unchanged before solution scoping.');
    declared.push({ action, current });
  }
  return declared;
}

async function solutionScopes(manifest, client, known, solutionIds) {
  const scopes = [];
  for (const solution of manifest.solutions) {
    const rows = await client.list(`solutions?$select=solutionid&$filter=uniquename eq '${solution.uniqueName}'`);
    if (rows.length !== 1) throw new Error('Solution identity unavailable for table-root scoping.');
    const sid = rows[0].solutionid;
    solutionIds.set(solution.uniqueName, sid);
    const route = `solutioncomponents?$select=solutioncomponentid,objectid,componenttype,rootcomponentbehavior&$filter=_solutionid_value eq ${sid}`,
      before = await client.list(route),
      roots = before.filter((row) => row.componenttype === 1 && row.rootcomponentbehavior === 0);
    if (roots.some((root) => !known.has(root.objectid?.toLowerCase())))
      throw new Error('Undeclared table root would include unrelated subcomponents; scoping refused.');
    scopes.push({ solution, sid, route, before, roots });
  }
  return scopes;
}

async function addSolutionComponent(client, id, type, solution) {
  return client.request('AddSolutionComponent', {
    method: 'POST',
    body: {
      ComponentId: id,
      ComponentType: type,
      SolutionUniqueName: solution,
      AddRequiredComponents: false,
      ...(type === 1 ? { DoNotIncludeSubcomponents: true } : {}),
    },
  });
}

async function scopeRoots({ solution, sid, route, before, roots }, client, known, changes, onProgress) {
  await onProgress({ state: 'before-membership-replacement', solution: solution.uniqueName, components: before });
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
    await addSolutionComponent(client, root.objectid, 1, solution.uniqueName);
    const after = (await client.list(route)).find(
      (row) => row.componenttype === 1 && row.objectid?.toLowerCase() === root.objectid.toLowerCase(),
    );
    if (after?.rootcomponentbehavior !== 1) throw new Error('Dataverse did not retain explicit table-root scoping.');
    changes.push({ solution: solution.uniqueName, table: known.get(root.objectid.toLowerCase()), before: 0, after: 1 });
  }
  await restoreExplicitComponents(before, sid, solution.uniqueName, client);
  await onProgress({ state: 'roots-scoped', solution: solution.uniqueName });
}

async function restoreExplicitComponents(before, sid, solution, client) {
  for (const component of before.filter((row) => row.componenttype !== 1)) {
    const present = await client.list(
      `solutioncomponents?$select=objectid&$filter=_solutionid_value eq ${sid} and objectid eq ${component.objectid} and componenttype eq ${component.componenttype}`,
    );
    if (!present.length) await addSolutionComponent(client, component.objectid, component.componenttype, solution);
  }
}

async function restoreDeclaredComponents(declared, solutionIds, client) {
  for (const { action, current } of declared) {
    const id = current.MetadataId ?? current.formid ?? current.savedqueryid,
      type = TYPES[action.kind],
      sid = solutionIds.get(action.solution);
    if (!guid.test(id ?? '')) throw new Error('Declared component identity unavailable during solution scoping.');
    const present = await client.list(
      `solutioncomponents?$select=objectid&$filter=_solutionid_value eq ${sid} and objectid eq ${id} and componenttype eq ${type}`,
    );
    if (!present.length) await addSolutionComponent(client, id, type, action.solution);
    if (action.kind === 'table') await restorePrimaryNameComponent(action, sid, client);
  }
}

async function restorePrimaryNameComponent(action, sid, client) {
  const primary = await client.get(
    `EntityDefinitions(LogicalName='${action.table}')/Attributes(LogicalName='${action.body.PrimaryNameAttribute}')`,
  );
  if (!guid.test(primary.MetadataId ?? ''))
    throw new Error('Primary-name component unavailable during solution scoping.');
  const included = await client.list(
    `solutioncomponents?$select=objectid&$filter=_solutionid_value eq ${sid} and objectid eq ${primary.MetadataId} and componenttype eq 2`,
  );
  if (!included.length) await addSolutionComponent(client, primary.MetadataId, 2, action.solution);
}

async function restoreRelationshipLookups(manifest, solutionIds, client) {
  for (const relation of manifest.relationships.filter((r) => r.kind === 'oneToMany')) {
    const attribute = await client.get(
        `EntityDefinitions(LogicalName='${relation.child}')/Attributes(LogicalName='${relation.lookup.name}')`,
      ),
      sid = solutionIds.get(relation.solution);
    if (!guid.test(attribute.MetadataId ?? ''))
      throw new Error('Lookup component unavailable during solution scoping.');
    const included = await client.list(
      `solutioncomponents?$select=objectid&$filter=_solutionid_value eq ${sid} and objectid eq ${attribute.MetadataId} and componenttype eq 2`,
    );
    if (!included.length) await addSolutionComponent(client, attribute.MetadataId, 2, relation.solution);
  }
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
export async function completeLookupAuditing(input, client) {
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
export async function publishManifest(input, client) {
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

export async function checkKeys(input, client) {
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

export async function exportSolution({ client, solutionName, zipFile, unpackFolder }) {
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
  await fs.writeFile(zipFile, zip, { flag: 'wx', mode: 0o600 });
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
      /^[^\S\r\n\u2028\u2029]*Error:/im.test(result.stdout + '\n' + result.stderr)
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
