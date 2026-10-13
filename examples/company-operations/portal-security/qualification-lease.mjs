import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { savePrivateJson } from '../portal-harness/private-journal.mjs';

// Project-local write-ahead persistence. Do not import toolkit checkout paths:
// this source must work against the public package in an external project.
const privateJson = (file, value, exclusive = false) => savePrivateJson(file, value, { exclusive });

const guid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const normalized = value => String(value).toLowerCase();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const memberRoute = actor => `contacts(${actor})/powerpagecomponent_mspp_webrole_contact`;
const members = async (client, actor) => (await client.list(memberRoute(actor) + '?$select=powerpagecomponentid'))
  .map(record => normalized(record.powerpagecomponentid)).sort();
const componentBody = component => ({ name: component.name, content: JSON.stringify(component.content),
  statecode: component.state, statuscode: component.state === 0 ? 1 : 2 });
const inactiveBody = { statecode: 1, statuscode: 2 };
const validateSite = async (client, siteId) => {
  const site = await client.get(`powerpagesites(${siteId})`);
  if (site.datamodelversion !== '2.0' || site.enhancedauthorization !== 0)
    throw new Error('Qualification lease requires enhanced data model with traditional authorization.');
};

/** Executable component/membership lease input. Fixture creation and native
 * captures are deliberately separate: a declaration of fixtures is insufficient
 * to activate a fault graph against live data. */
export function planQualificationLease(configuration, {
  blueprint, organisationId, siteId, actorContactId, fixtureBindings, roleMask = 0, leaseId = randomUUID(),
} = {}) {
  for (const value of [organisationId, siteId, actorContactId, leaseId]) if (!guid.test(value ?? ''))
    throw new Error('Qualification lease requires explicit organisation/site/actor/lease GUIDs.');
  if (!configuration?.components?.length || !configuration.roles?.length ||
      !Number.isInteger(roleMask) || roleMask < 0 || roleMask >= configuration.roleMaskCount)
    throw new Error('Qualification lease needs one materialized configuration and valid role mask.');
  if (fixtureBindings?.actorContactId !== actorContactId || !fixtureBindings.nativeDataVerified ||
      !/^[a-f0-9]{64}$/.test(fixtureBindings.nativeFixtureSnapshotHash ?? '') ||
      configuration.requiredRegions.some(region => !fixtureBindings.regionRecordIds?.[region]?.length ||
        fixtureBindings.regionRecordIds[region].some(value => !guid.test(value))))
    throw new Error('Bind verified native actor and all three fixture regions before preparing a live lease.');
  const businessRoleIds = blueprint.roles.filter(role => role.code !== 'TESTRUNNER').map(role => normalized(role.id));
  const runner = blueprint.roles.find(role => role.code === 'TESTRUNNER');
  if (!runner) throw new Error('The protected recording role is absent.');
  // Native Contact Self in the baseline recording role would otherwise grant
  // every isolated Contact query regardless of the temporary graph under test.
  const overrideKeys = new Set(['contact', 'pqvd_equipment'].includes(configuration.query.table)
    ? blueprint.nodes.filter(permission => permission.role === 'TESTRUNNER' && permission.table === configuration.query.table &&
      Object.values(permission.privileges).some(Boolean)).map(permission => permission.key) : []);
  for (let changed = true; changed;) {
    changed = false;
    for (const permission of blueprint.nodes) if (permission.parent && overrideKeys.has(permission.parent) && !overrideKeys.has(permission.key)) {
      overrideKeys.add(permission.key); changed = true;
    }
  }
  const byKey = new Map(blueprint.nodes.map(permission => [permission.key, permission]));
  const depth = permission => { let count = 0; while (permission.parent) { permission = byKey.get(permission.parent); count++; } return count; };
  const baselineOverrides = blueprint.nodes.filter(permission => overrideKeys.has(permission.key))
    .sort((a, b) => depth(b) - depth(a)).map(permission => normalized(permission.id));
  const components = configuration.components.map(component => ({ ...structuredClone(component),
    content: { ...structuredClone(component.content),
      description: `${component.content.description ?? ''} Qualification lease ${leaseId}` } }));
  const hasAccountScope = configuration.permissions.some(permission => permission.scope === 'Account' ||
    permission.scope === 'Contact' && permission.relationship === 'contact_customer_accounts');
  if (hasAccountScope && !guid.test(fixtureBindings.ownAccountId ?? '')) throw new Error('Account-scope lease requires its verified own Account GUID.');
  if (configuration.family === 'equipment-lifecycle' && (!guid.test(fixtureBindings.ownedRunId ?? '') ||
      fixtureBindings.ownedRunActorVerified !== true || fixtureBindings.stockEquipmentVerified !== true))
    throw new Error('Equipment lifecycle lease needs verified Stock fixtures and Contact-owned run.');
  return { schemaVersion: 1, kind: 'isolated-native-qualification-lease', leaseId, variantId: configuration.variantId,
    organisationId, siteId, actorContactId, roleMask, businessRoleIds, protectedRunnerRoleId: normalized(runner.id),
    desiredRoleIds: configuration.roles.filter((_, bit) => roleMask & (1 << bit)).map(role => normalized(role.id)),
    temporaryRoleIds: configuration.roles.map(role => normalized(role.id)), baselineOverrides, components,
    fixtureBindings: structuredClone(fixtureBindings), fixtureBindingsHash: hash(fixtureBindings),
    actorParentAccountId: hasAccountScope ? fixtureBindings.ownAccountId : null,
    negativeFault: configuration.permissions.some(permission => permission.active && permission.parentId &&
      configuration.permissions.find(parent => parent.id === permission.parentId)?.active === false),
    state: 'prepared-inputs', liveMutation: false, nativeQualification: false };
}

function validateOwned(component, current, siteId) {
  if (current.powerpagecomponentid !== component.id || current._powerpagesiteid_value !== siteId ||
      current.powerpagecomponenttype !== component.type || current.name !== component.name ||
      current.content !== JSON.stringify(component.content) ||
      ![0, 1].includes(current.statecode) || current.statuscode !== (current.statecode === 0 ? 1 : 2))
    throw new Error('Qualification component identity/content/activation drift; recovery refused.');
}

function assertForeignMemberships(plan, journal, current) {
  const touched = new Set([...plan.businessRoleIds, ...plan.temporaryRoleIds]);
  const expected = journal.before.memberships.filter(role => !touched.has(role));
  if (!same(current.filter(role => !touched.has(role)), expected))
    throw new Error('Unrelated native role associations changed; lease refused concurrent drift.');
}

async function persist(journal, journalFile, event) {
  if (event) journal.events.push({ ...event, time: new Date().toISOString() });
  await privateJson(journalFile, journal);
}

async function changeMembers(client, plan, journal, desired, journalFile) {
  let current = await members(client, plan.actorContactId); assertForeignMemberships(plan, journal, current);
  const touched = new Set([...plan.businessRoleIds, ...plan.temporaryRoleIds]);
  for (const roleId of current.filter(role => touched.has(role) && !desired.includes(role))) {
    journal.pending = { kind: 'membership-remove', roleId }; await persist(journal, journalFile);
    await client.request(`${memberRoute(plan.actorContactId)}(${roleId})/$ref`, { method: 'DELETE' });
    current = await members(client, plan.actorContactId); assertForeignMemberships(plan, journal, current);
    if (current.includes(roleId)) throw new Error('Qualification role removal readback failed.');
    delete journal.pending; await persist(journal, journalFile, { kind: 'membership-removed', roleId });
  }
  for (const roleId of desired.filter(role => touched.has(role) && !current.includes(role))) {
    journal.pending = { kind: 'membership-add', roleId }; await persist(journal, journalFile);
    await client.request(memberRoute(plan.actorContactId) + '/$ref', { method: 'POST',
      body: { '@odata.id': client.url(`powerpagecomponents(${roleId})`) } });
    current = await members(client, plan.actorContactId); assertForeignMemberships(plan, journal, current);
    if (!current.includes(roleId)) throw new Error('Qualification role addition readback failed.');
    delete journal.pending; await persist(journal, journalFile, { kind: 'membership-added', roleId });
  }
}

export async function inspectQualificationLease(client, plan) {
  await client.verify(plan.organisationId); await validateSite(client, plan.siteId);
  const memberships = await members(client, plan.actorContactId);
  if (!memberships.includes(plan.protectedRunnerRoleId)) throw new Error('Recording role must remain assigned during qualification.');
  const components = await client.list(`powerpagecomponents?$filter=_powerpagesiteid_value eq ${plan.siteId}`);
  for (const wanted of plan.components) if (components.some(component => component.powerpagecomponentid === wanted.id))
    throw new Error('Temporary qualification GUID already exists; recover its owning journal before reuse.');
  const overrides = [];
  for (const componentId of plan.baselineOverrides) {
    const before = components.find(component => normalized(component.powerpagecomponentid) === componentId);
    if (!before || before.powerpagecomponenttype !== 18 || !before['@odata.etag']) throw new Error('Contact baseline override missing or lacks ETag.');
    overrides.push(before);
  }
  const defaultRoles = new Set(components.filter(component => component.powerpagecomponenttype === 11 && component.statecode === 0)
    .filter(component => { const content = JSON.parse(component.content); return content.anonymoususersrole || content.authenticatedusersrole; })
    .map(component => normalized(component.powerpagecomponentid)));
  const testedTable = plan.components.filter(component => component.type === 18).at(-1)?.content.entitylogicalname;
  const permissionComponents = new Map(components.filter(component => component.powerpagecomponenttype === 18)
    .map(component => [normalized(component.powerpagecomponentid), component]));
  const effectiveRoles = (component, visited = new Set()) => {
    const key = normalized(component.powerpagecomponentid);
    if (visited.has(key)) throw new Error('Baseline permission cycle prevents isolated qualification.');
    const content = JSON.parse(component.content), own = content.adx_entitypermission_webrole ?? [];
    const parent = permissionComponents.get(normalized(content.parententitypermission));
    if (content.parententitypermission && (!parent || parent.statecode !== 0) && component.statecode === 0)
      throw new Error('Existing active orphan permission prevents isolated qualification.');
    return [...own, ...(parent ? effectiveRoles(parent, new Set([...visited, key])) : [])];
  };
  const contamination = components.filter(component => component.powerpagecomponenttype === 18 && component.statecode === 0)
    .filter(component => { const content = JSON.parse(component.content); return content.entitylogicalname === testedTable &&
      effectiveRoles(component).some(role => defaultRoles.has(normalized(role))); });
  if (contamination.length) throw new Error('Existing default/anonymous permission contaminates the isolated leaf table.');
  const actor = await client.get(`contacts(${plan.actorContactId})?$select=contactid,_parentcustomerid_value`);
  let parentNavigation;
  if (plan.actorParentAccountId) {
    const metadata = await client.list("EntityDefinitions(LogicalName='contact')/ManyToOneRelationships?$select=ReferencingAttribute,ReferencedEntity,ReferencingEntityNavigationPropertyName");
    const candidates = metadata.filter(relationship => relationship.ReferencingAttribute === 'parentcustomerid' && relationship.ReferencedEntity === 'account');
    if (candidates.length !== 1 || !candidates[0].ReferencingEntityNavigationPropertyName || !actor['@odata.etag'])
      throw new Error('Account-scope actor lease requires exact native lookup navigation and ETag.');
    parentNavigation = candidates[0].ReferencingEntityNavigationPropertyName;
  }
  return { memberships, overrides, actor, parentNavigation };
}

export async function restoreQualificationLease(client, journal, { journalFile, expectedOrganisationId } = {}) {
  const plan = journal.plan;
  if (!plan || plan.organisationId !== expectedOrganisationId || !journal.before ||
      !path.resolve(journalFile ?? '').split(path.sep).includes('.paqvilo') || journal.planHash !== hash(plan))
    throw new Error('Qualification recovery requires its owning organisation and exact before-state journal.');
  await client.verify(expectedOrganisationId); await validateSite(client, plan.siteId);
  // Preflight every object before the first restoration mutation.
  const live = new Map();
  for (const component of plan.components) {
    const current = await client.optional(`powerpagecomponents(${component.id})`);
    if (current) { validateOwned(component, current, plan.siteId); if (!current['@odata.etag']) throw new Error('Recovery component lacks ETag.'); }
    live.set(component.id, current);
  }
  const currentOverrides = new Map();
  for (const before of [...journal.before.overrides].reverse()) {
    const current = await client.get(`powerpagecomponents(${before.powerpagecomponentid})`);
    if (current.name !== before.name || current.content !== before.content || current.powerpagecomponenttype !== before.powerpagecomponenttype ||
        current._powerpagesiteid_value !== before._powerpagesiteid_value || !current['@odata.etag'] ||
        !(current.statecode === before.statecode || current.statecode === 1)) throw new Error('Baseline permission changed; recovery refused.');
    currentOverrides.set(before.powerpagecomponentid, current);
  }
  assertForeignMemberships(plan, journal, await members(client, plan.actorContactId));
  const actor = await client.get(`contacts(${plan.actorContactId})?$select=contactid,_parentcustomerid_value`);
  if (plan.actorParentAccountId && ![journal.before.actor._parentcustomerid_value ?? null, plan.actorParentAccountId].includes(actor._parentcustomerid_value ?? null))
    throw new Error('Actor Account scope changed concurrently; recovery refused.');
  for (const component of [...plan.components].reverse()) {
    const current = live.get(component.id); if (!current || current.statecode === 1) continue;
    journal.pending = { kind: 'component-deactivate', componentId: component.id }; await persist(journal, journalFile);
    await client.request(`powerpagecomponents(${component.id})`, { method: 'PATCH', body: inactiveBody, ifMatch: current['@odata.etag'] });
    const inactive = await client.get(`powerpagecomponents(${component.id})`); validateOwned(component, inactive, plan.siteId);
    if (inactive.statecode !== 1) throw new Error('Recovery deactivation readback failed.');
    delete journal.pending; await persist(journal, journalFile, { kind: 'component-deactivated', componentId: component.id });
  }
  await changeMembers(client, plan, journal, journal.before.memberships, journalFile);
  if (plan.actorParentAccountId && actor._parentcustomerid_value !== journal.before.actor._parentcustomerid_value) {
    const latest = await client.get(`contacts(${plan.actorContactId})?$select=contactid,_parentcustomerid_value`);
    if ((latest._parentcustomerid_value ?? null) !== (actor._parentcustomerid_value ?? null) || !latest['@odata.etag'])
      throw new Error('Actor Account changed during recovery; refusing stale conditional restoration.');
    journal.pending = { kind: 'actor-parent-restore' }; await persist(journal, journalFile);
    await client.request(`contacts(${plan.actorContactId})`, { method: 'PATCH',
      body: { [journal.before.parentNavigation + '@odata.bind']: journal.before.actor._parentcustomerid_value
        ? `/accounts(${journal.before.actor._parentcustomerid_value})` : null }, ifMatch: latest['@odata.etag'] });
    const restored = await client.get(`contacts(${plan.actorContactId})?$select=contactid,_parentcustomerid_value`);
    if ((restored._parentcustomerid_value ?? null) !== (journal.before.actor._parentcustomerid_value ?? null)) throw new Error('Actor Account restoration readback failed.');
    delete journal.pending; await persist(journal, journalFile, { kind: 'actor-parent-restored' });
  }
  for (const before of [...journal.before.overrides].reverse()) {
    const current = currentOverrides.get(before.powerpagecomponentid);
    if (current.statecode === before.statecode) continue;
    journal.pending = { kind: 'baseline-restore', componentId: before.powerpagecomponentid }; await persist(journal, journalFile);
    await client.request(`powerpagecomponents(${before.powerpagecomponentid})`, { method: 'PATCH',
      body: { statecode: before.statecode, statuscode: before.statuscode }, ifMatch: current['@odata.etag'] });
    const restored = await client.get(`powerpagecomponents(${before.powerpagecomponentid})`);
    if (restored.statecode !== before.statecode || restored.statuscode !== before.statuscode) throw new Error('Baseline permission restoration readback failed.');
    delete journal.pending; await persist(journal, journalFile, { kind: 'baseline-restored', componentId: before.powerpagecomponentid });
  }
  for (const component of [...plan.components].reverse()) {
    const current = await client.optional(`powerpagecomponents(${component.id})`); if (!current) continue;
    validateOwned(component, current, plan.siteId);
    journal.pending = { kind: 'component-delete', componentId: component.id }; await persist(journal, journalFile);
    await client.request(`powerpagecomponents(${component.id})`, { method: 'DELETE', ifMatch: current['@odata.etag'] });
    if (await client.optional(`powerpagecomponents(${component.id})`)) throw new Error('Qualification component cleanup readback failed.');
    delete journal.pending; await persist(journal, journalFile, { kind: 'component-deleted', componentId: component.id });
  }
  if (!same(await members(client, plan.actorContactId), journal.before.memberships)) throw new Error('Qualification exact membership restoration failed.');
  journal.state = 'restored'; await persist(journal, journalFile, { kind: 'restored' });
  return { state: journal.state, leaseId: plan.leaseId };
}

export async function withQualificationLease(client, plan, callback, { journalFile } = {}) {
  if (!path.resolve(journalFile ?? '').split(path.sep).includes('.paqvilo')) throw new Error('Lease journal must stay under ignored .paqvilo.');
  const before = await inspectQualificationLease(client, plan);
  const journal = { schemaVersion: 1, plan, planHash: hash(plan), before, state: 'prepared', events: [], startedAt: new Date().toISOString() };
  await privateJson(journalFile, journal, true);
  let result;
  try {
    for (const component of plan.components) {
      journal.pending = { kind: 'component-create', componentId: component.id }; await persist(journal, journalFile);
      await client.request('powerpagecomponents', { method: 'POST', body: { ...componentBody({ ...component, state: 1 }),
        powerpagecomponentid: component.id, powerpagecomponenttype: component.type, 'powerpagesiteid@odata.bind': `/powerpagesites(${plan.siteId})` } });
      const created = await client.get(`powerpagecomponents(${component.id})`); validateOwned(component, created, plan.siteId);
      if (created.statecode !== 1) throw new Error('New qualification component must begin inactive.');
      delete journal.pending; await persist(journal, journalFile, { kind: 'component-created', componentId: component.id });
    }
    for (const original of before.overrides.filter(component => component.statecode === 0)) {
      journal.pending = { kind: 'baseline-deactivate', componentId: original.powerpagecomponentid }; await persist(journal, journalFile);
      await client.request(`powerpagecomponents(${original.powerpagecomponentid})`, { method: 'PATCH', body: inactiveBody, ifMatch: original['@odata.etag'] });
      const changed = await client.get(`powerpagecomponents(${original.powerpagecomponentid})`);
      if (changed.content !== original.content || changed.statecode !== 1) throw new Error('Baseline deactivation readback failed.');
      delete journal.pending; await persist(journal, journalFile, { kind: 'baseline-deactivated', componentId: original.powerpagecomponentid });
    }
    await changeMembers(client, plan, journal, plan.desiredRoleIds, journalFile);
    if (plan.actorParentAccountId && before.actor._parentcustomerid_value !== plan.actorParentAccountId) {
      const latest = await client.get(`contacts(${plan.actorContactId})?$select=contactid,_parentcustomerid_value`);
      if ((latest._parentcustomerid_value ?? null) !== (before.actor._parentcustomerid_value ?? null) || !latest['@odata.etag'])
        throw new Error('Actor Account changed before activation; refusing stale conditional mutation.');
      journal.pending = { kind: 'actor-parent-change' }; await persist(journal, journalFile);
      await client.request(`contacts(${plan.actorContactId})`, { method: 'PATCH',
        body: { [before.parentNavigation + '@odata.bind']: `/accounts(${plan.actorParentAccountId})` }, ifMatch: latest['@odata.etag'] });
      const changed = await client.get(`contacts(${plan.actorContactId})?$select=contactid,_parentcustomerid_value`);
      if (changed._parentcustomerid_value !== plan.actorParentAccountId) throw new Error('Actor Account-scope readback failed.');
      delete journal.pending; await persist(journal, journalFile, { kind: 'actor-parent-changed' });
    }
    for (const component of plan.components.filter(component => component.state === 0)) {
      const current = await client.get(`powerpagecomponents(${component.id})`); validateOwned(component, current, plan.siteId);
      journal.pending = { kind: 'component-activate', componentId: component.id }; await persist(journal, journalFile);
      await client.request(`powerpagecomponents(${component.id})`, { method: 'PATCH', body: { statecode: 0, statuscode: 1 }, ifMatch: current['@odata.etag'] });
      const active = await client.get(`powerpagecomponents(${component.id})`); validateOwned(component, active, plan.siteId);
      if (active.statecode !== 0) throw new Error('Qualification activation readback failed.');
      delete journal.pending; await persist(journal, journalFile, { kind: 'component-activated', componentId: component.id });
    }
    journal.state = 'active'; await persist(journal, journalFile, { kind: 'active' });
    result = await callback({ plan, journal, qualification: 'configuration-active-await-native-cache-and-capture' });
  } finally {
    await restoreQualificationLease(client, journal, { journalFile, expectedOrganisationId: plan.organisationId });
  }
  return result;
}
