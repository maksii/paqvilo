import { componentId } from './blueprint.mjs';
import { createHash } from 'node:crypto';

const guid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const regions = ['own-scope', 'same-company-other-branch', 'foreign-company'];

/** Concrete disposable fixture graph. Native metadata navigation is bound by a
 * separate read-only step; this function creates no Dataverse records. Original
 * seed rows and the real actor remain untouched by these request plans. */
export function planQualificationFixtures(configuration, { schema, catalogue, actorContactId, resolvedIds, runId, ownedRunId, bindingCohorts = false } = {}) {
  if (!guid.test(actorContactId ?? '') || !guid.test(runId ?? '')) throw new Error('Fixture plan requires actor and unique run GUID.');
  if (configuration.family === 'equipment-lifecycle' && !guid.test(ownedRunId ?? ''))
    throw new Error('Equipment lifecycle fixture requires an actual verified Contact-owned test run.');
  const lifecycleTables = new Set(['account', 'contact', 'pqvd_orgcontact', 'pqvd_site', 'pqvd_building', 'pqvd_room', 'pqvd_equipment']);
  const prototypes = catalogue.records.filter(record => record.key.startsWith('CANARY-A-') &&
    (configuration.family !== 'equipment-lifecycle' || lifecycleTables.has(record.table)));
  if (!prototypes.length) throw new Error('The source catalogue has no disposable fixture prototypes.');
  const prototypeKeys = new Set(prototypes.map(record => record.key));
  const tables = new Map(catalogue.tables.map(table => [table.name, table]));
  const token = runId.replaceAll('-', '').slice(0, 20), records = [], associations = [];
  const regionRecordIds = {}, byKey = new Map(), grants = [];
  const external = (key, region) => {
    const remap = key === 'A-RIV' ? ['A-RIV', 'A-HILL', 'B-LAKE'][region]
      : key === 'A' && region === 2 ? 'B' : key;
    const value = resolvedIds?.[remap];
    if (!guid.test(value ?? '')) throw new Error('Native fixture reference is not bound: ' + remap);
    const source = catalogue.records.find(record => record.key === remap);
    if (!source) throw new Error('Unresolved native fixture source reference: ' + remap);
    return { id: value, table: source.table, externalKey: remap };
  };
  for (const [region, label] of regions.entries()) {
    const clones = new Map(prototypes.map(prototype => [prototype.key,
      { id: componentId(`qualification-fixture:${runId}:${region}:${prototype.key}`), table: prototype.table }]));
    for (const prototype of prototypes) {
      const key = `QF-${token}-${region}-${prototype.table}`, fields = structuredClone(prototype.fields);
      const meta = tables.get(prototype.table), unique = `QF-${token}-${region}-${hash(prototype.table).slice(0, 4)}`;
      for (const columns of meta.keys ?? []) for (const column of columns) if (typeof fields[column] === 'string') fields[column] = unique;
      const schemaTable = schema.tables.find(table => table.name === prototype.table);
      const primaryName = schemaTable?.primaryName?.name ?? ({ account: 'name', contact: 'fullname' }[prototype.table]);
      if (primaryName && Object.hasOwn(fields, primaryName)) fields[primaryName] = `Qualification ${token} ${label}`;
      const refs = {};
      for (const [column, reference] of Object.entries(prototype.refs ?? {})) {
        if (reference === null) { refs[column] = null; continue; }
        if (column === 'pqvd_contactid' && prototype.table === 'pqvd_orgcontact' && region === 0)
          refs[column] = { id: actorContactId, table: 'contact', realActor: true };
        else if ((column === 'pqvd_accountid' || column === 'pqvd_scopeaccountid') && !prototypeKeys.has(reference))
          refs[column] = clones.get('CANARY-A-account');
        else refs[column] = clones.get(reference) ?? external(reference, region);
      }
      if (prototype.table === 'pqvd_equipment' && configuration.family === 'equipment-lifecycle') {
        fields.pqvd_equipmentstate = 183270000;
        fields.pqvd_assettag = `CO-CANARY-QF-${token}-${region}`;
        refs.pqvd_currentassignmentid = null;
        refs.pqvd_canaryrunid = { id: ownedRunId, table: 'pqvd_testrun', externalRun: true };
      }
      const record = { key, id: clones.get(prototype.key).id, table: prototype.table, region: label,
        fields, refs, fieldTypes: Object.fromEntries((schemaTable?.columns ?? []).map(column =>
          [column.name, { type: column.type, behavior: column.behavior }])),
        deferredRefs: [...(prototype.deferredRefs ?? [])], uniqueRunToken: token };
      records.push(record); byKey.set(key, record);
    }
    const grantPrototype = catalogue.records.find(record => record.key === 'G-P-STRESS-IT');
    if (!grantPrototype) throw new Error('The source access projection prototype is absent.');
    const splitPrincipals = configuration.family === 'alternative-grants' && configuration.parameters.shape !== 'same-path';
    const peer = clones.get('CANARY-A-contact'), actor = { id: actorContactId, table: 'contact', realActor: true };
    const grantee = region === 0 || splitPrincipals ? actor : peer;
    const grant = { key: `QF-${token}-${region}-access`, id: componentId(`qualification-fixture:${runId}:${region}:access`),
      table: 'pqvd_accesspermission', region: label, fields: { ...structuredClone(grantPrototype.fields),
        pqvd_name: `Qualification projection ${token} ${label}`, pqvd_number: `QF-${token}-${region}-grant`,
        pqvd_scopekey: `QF-${token}-${region}-scope` }, refs: {
        ...Object.fromEntries(Object.entries(grantPrototype.refs).filter(([column]) =>
          !['pqvd_granteecontactid', 'pqvd_scopeaccountid', 'pqvd_itprincipalid', 'pqvd_hrprincipalid', 'pqvd_ctoprincipalid'].includes(column))
          .map(([column, target]) => [column, target === null ? null : external(target, region)])),
        pqvd_granteecontactid: grantee, pqvd_scopeaccountid: clones.get('CANARY-A-account'),
        pqvd_itprincipalid: splitPrincipals ? region === 0 ? actor : peer : grantee,
        pqvd_hrprincipalid: splitPrincipals ? region === 1 ? actor : peer : grantee,
        pqvd_ctoprincipalid: splitPrincipals ? region === 2 && configuration.parameters.grants === 3 ? actor : peer : grantee },
      deferredRefs: [], uniqueRunToken: token };
    records.push(grant); grants.push(grant);
    for (const relationship of ['pqvd_access_accounts', 'pqvd_access_referenceaccounts']) associations.push({ relationship,
      from: { id: grant.id, table: grant.table }, to: clones.get('CANARY-A-account'), region: label });
    if (configuration.metadataRequirements.some(requirement => requirement.definition.name === 'pqvd_qfcontactorgcontacts'))
      associations.push({ relationship: 'pqvd_qfcontactorgcontacts', from: grantee,
        to: clones.get('CANARY-A-pqvd_orgcontact'), region: label });
    regionRecordIds[label] = records.filter(record => record.region === label && record.table === configuration.query.table).map(record => record.id);
  }
  // Self is the actual actor's record. Fixture peers remain negative canaries;
  // actor CRUD requires its own conditional lease and is never a fixture create.
  if (configuration.permissions.some(permission => permission.scope === 'Self') && configuration.query.table === 'contact')
    regionRecordIds['own-scope'].push(actorContactId);
  if (bindingCohorts) {
    if (configuration.family !== 'equipment-lifecycle' || !schema.relationships.some(relationship => relationship.name === 'pqvd_equipment_crudprobes'))
      throw new Error('Source5 binding cohorts require lifecycle equipment and its provisioned optional cooperating Probe relationship.');
    for (const [index, region] of regions.entries()) {
      const originalRoom = records.find(record => record.region === region && record.table === 'pqvd_room');
      const originalEquipment = records.find(record => record.region === region && record.table === 'pqvd_equipment');
      const alternateRoom = structuredClone(originalRoom), alternateEquipment = structuredClone(originalEquipment);
      for (const record of [alternateRoom, alternateEquipment]) {
        record.id = componentId(`qualification-fixture:${runId}:${region}:rebind:${record.table}`);
        record.key += '-rebind'; record.fields.pqvd_name += ' rebind'; record.bindingAlternate = true;
        for (const key of tables.get(record.table).keys ?? []) for (const column of key)
          if (typeof record.fields[column] === 'string') record.fields[column] += '-R';
      }
      alternateEquipment.refs.pqvd_roomid = { id: alternateRoom.id, table: 'pqvd_room' };
      const probe = { key: `QF-${token}-${index}-binding-probe`, id: componentId(`qualification-fixture:${runId}:${region}:binding-probe`),
        table: 'pqvd_crudprobe', region, fields: { pqvd_name: `Qualification binding probe ${token} ${region}`,
          pqvd_token: `QF-${token}-${index}-binding-probe`, pqvd_value: 'Binding canary', pqvd_counter: 0 },
        refs: { pqvd_ownercontactid: { id: actorContactId, table: 'contact', realActor: true },
          pqvd_runid: { id: ownedRunId, table: 'pqvd_testrun', externalRun: true },
          pqvd_activeoperationid: null,
          pqvd_equipmentid: { id: originalEquipment.id, table: 'pqvd_equipment' } },
        deferredRefs: [], uniqueRunToken: token, bindingProbe: true };
      records.push(alternateRoom, alternateEquipment, probe);
      if (configuration.query.table === 'pqvd_equipment') regionRecordIds[region].push(alternateEquipment.id);
    }
  }
  const plan = { schemaVersion: 1, kind: 'disposable-native-qualification-fixture-requests', variantId: configuration.variantId,
    runId, actorContactId, records, associations, regionRecordIds,
    ...(configuration.family === 'equipment-lifecycle' ? { ownedRunId, ownedRunActorReadbackRequired: true } : {}),
    ownAccountId: records.find(record => record.region === 'own-scope' && record.table === 'account').id,
    requiredMetadata: configuration.metadataRequirements,
    nativeDataVerified: false, nativeExecution: false, tables: [...tables.values()],
    cleanup: [...records].reverse().map(record => ({ table: record.table, id: record.id,
      expectedUniqueRunToken: token, requireCurrentETag: true, requireOwnedRecordReadback: true })),
    prerequisites: ['SDK fixture writer must match the frozen original BusinessProjectionGuard trusted identity.',
      'Every lookup/association navigation is resolved from native metadata before generating executable requests.',
      'Journal each intended create/bind before execution and reconcile uncertain outcomes without blind retry.',
      'Verify native three-region graph, positive and negative associations before activating its permission lease.',
      'Restore actor scalar/Account leases separately; these fixtures never modify the actor.'] };
  plan.planHash = hash(plan); return plan;
}

/** Native metadata reads only. Returns precise executable API requests for the
 * sole coordinator's existing journalled writer, plus explicit readback fields. */
export async function bindQualificationFixtureRequests(client, plan) {
  if (plan.ownedRunId) {
    const run = await client.get(`pqvd_testruns(${plan.ownedRunId})?$select=_pqvd_runnercontactid_value`);
    if (run._pqvd_runnercontactid_value !== plan.actorContactId)
      throw new Error('Lifecycle fixture run is not owned by the actual portal Contact.');
  }
  const metadata = new Map(), tableOf = new Map(plan.tables.map(table => [table.name, table]));
  for (const table of [...new Set(plan.records.map(record => record.table))]) metadata.set(table,
    await client.list(`EntityDefinitions(LogicalName='${table}')/ManyToOneRelationships?$select=ReferencingAttribute,ReferencedEntity,ReferencingEntityNavigationPropertyName`));
  const lookupNavigation = {};
  const body = (record, deferred) => {
    const payload = deferred ? {} : { ...record.fields };
    for (const [column, target] of Object.entries(record.refs)) if (record.deferredRefs.includes(column) === deferred) {
      const candidates = metadata.get(record.table).filter(relationship => relationship.ReferencingAttribute === column &&
        (!target || relationship.ReferencedEntity === target.table));
      if (candidates.length !== 1 || !candidates[0].ReferencingEntityNavigationPropertyName)
        throw new Error('Native qualification lookup navigation is ambiguous: ' + record.table + '.' + column);
      (lookupNavigation[record.id] ??= {})[column] = candidates[0].ReferencingEntityNavigationPropertyName;
      payload[candidates[0].ReferencingEntityNavigationPropertyName + '@odata.bind'] = target
        ? `/${tableOf.get(target.table).entitySet}(${target.id})` : null;
    }
    return payload;
  };
  const requests = plan.records.map(record => ({ kind: 'create', key: record.key, method: 'PATCH',
    endpoint: `${tableOf.get(record.table).entitySet}(${record.id})`, ifNoneMatch: '*', body: body(record, false),
    readback: [tableOf.get(record.table).primaryId, ...Object.keys(record.fields), ...Object.keys(record.refs).map(column => `_${column}_value`)] }));
  for (const record of plan.records.filter(record => record.deferredRefs.length)) requests.push({ kind: 'deferred-bind', key: record.key,
    method: 'PATCH', endpoint: `${tableOf.get(record.table).entitySet}(${record.id})`, body: body(record, true), requireReadbackETag: true });
  for (const association of plan.associations) {
    const relationships = await client.list(`RelationshipDefinitions/Microsoft.Dynamics.CRM.ManyToManyRelationshipMetadata?$filter=SchemaName eq '${association.relationship}'`);
    if (relationships.length !== 1) throw new Error('Required native qualification N:N relationship is absent or ambiguous.');
    const relationship = relationships[0], side = relationship.Entity1LogicalName === association.from.table ? 1
      : relationship.Entity2LogicalName === association.from.table ? 2 : 0;
    const navigation = relationship[`Entity${side}NavigationPropertyName`];
    if (!side || !navigation || relationship[`Entity${side === 1 ? 2 : 1}LogicalName`] !== association.to.table)
      throw new Error('Qualification association endpoint metadata differs.');
    requests.push({ kind: 'associate', method: 'POST',
      endpoint: `${tableOf.get(association.from.table).entitySet}(${association.from.id})/${navigation}/$ref`,
      body: { '@odata.id': client.url(`${tableOf.get(association.to.table).entitySet}(${association.to.id})`) },
      requireExactAssociationReadback: true });
  }
  return { ...plan, requests, lookupNavigation, metadataBound: true, ...(plan.ownedRunId ? { ownedRunActorVerified: true } : {}), nativeExecution: false };
}
