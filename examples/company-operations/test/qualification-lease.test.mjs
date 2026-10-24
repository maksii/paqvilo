import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildBlueprint } from '../portal-security/blueprint.mjs';
import { highRiskNativeConfigurations, equipmentLifecycleConfigurations } from '../portal-security/qualification-priority.mjs';
import { planQualificationLease, withQualificationLease, inspectQualificationLease, restoreQualificationLease } from '../portal-security/qualification-lease.mjs';
import { planQualificationFixtures, bindQualificationFixtureRequests } from '../portal-security/qualification-fixtures.mjs';

const schema = JSON.parse(await readFile(new URL('../dataverse/manifest.json', import.meta.url)));
const catalogue = JSON.parse(await readFile(new URL('../data/stress-catalogue.json', import.meta.url)));
const blueprint = buildBlueprint(schema, catalogue);
const priority = highRiskNativeConfigurations({ schema, catalogue });
const ids = Array.from({ length: 8 }, (_, index) => `00000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`);
const bindings = { actorContactId: ids[2], nativeDataVerified: true, nativeFixtureSnapshotHash: 'a'.repeat(64), ownAccountId: ids[3],
  regionRecordIds: { 'own-scope': [ids[3]], 'same-company-other-branch': [ids[4]], 'foreign-company': [ids[5]] } };
const prepared = configuration => planQualificationLease(configuration, { blueprint, organisationId: ids[0], siteId: ids[1],
  actorContactId: ids[2], fixtureBindings: bindings, roleMask: 1, leaseId: ids[6] });

function fakeClient(plan, { failCommittedCreate = false } = {}) {
  let version = 0, failed = false;
  const etag = () => `W/"${++version}"`;
  const baselineNodes = blueprint.nodes.filter(node => node.role === 'TESTRUNNER');
  const registry = new Map(baselineNodes.map(baseline => ({ powerpagecomponentid: baseline.id, name: baseline.name, powerpagecomponenttype: 18,
    _powerpagesiteid_value: plan.siteId, statecode: 0, statuscode: 1,
    content: JSON.stringify({ entitylogicalname: baseline.table, scope: baseline.parent ? 756150003 : baseline.scope === 'Self' ? 756150004 : 756150001,
      ...(baseline.parent ? { parententitypermission: blueprint.nodes.find(node => node.key === baseline.parent).id } : {}),
      adx_entitypermission_webrole: [plan.protectedRunnerRoleId] }),
    '@odata.etag': etag() })).map(component => [component.powerpagecomponentid, component]));
  const roles = new Set([plan.protectedRunnerRoleId, plan.businessRoleIds[0], ids[7]]);
  const actor = { contactid: plan.actorContactId, _parentcustomerid_value: ids[4], '@odata.etag': etag() };
  const clone = object => structuredClone(object);
  const componentId = route => route.match(/^powerpagecomponents\(([^)]+)\)/)?.[1];
  const client = {
    registry, roles, actor, writes: [],
    url: route => 'https://fixture.invalid/api/data/v9.2/' + route,
    verify: async expected => { assert.equal(expected, plan.organisationId); return { organisationId: expected }; },
    get: async route => {
      if (route.startsWith('powerpagesites(')) return { datamodelversion: '2.0', enhancedauthorization: 0 };
      if (route.startsWith('contacts(')) return clone(actor);
      if (componentId(route) && registry.has(componentId(route))) return clone(registry.get(componentId(route)));
      throw new Error('Missing fake record: ' + route);
    },
    optional: async route => clone(registry.get(componentId(route)) ?? null),
    list: async route => {
      if (route.startsWith('contacts(')) return [...roles].map(role => ({ powerpagecomponentid: role }));
      if (route.startsWith('EntityDefinitions')) return [{ ReferencingAttribute: 'parentcustomerid', ReferencedEntity: 'account', ReferencingEntityNavigationPropertyName: 'parentcustomerid_account' }];
      return [...registry.values()].map(clone);
    },
    request: async (route, options) => {
      client.writes.push({ route, ...clone(options) });
      if (route.startsWith('contacts(') && route.includes('powerpagecomponent_mspp_webrole_contact')) {
        if (options.method === 'DELETE') roles.delete(route.match(/contact\(([^)]+)\)\/\$ref$/)[1]);
        else roles.add(options.body['@odata.id'].match(/powerpagecomponents\(([^)]+)\)$/)[1]);
        actor['@odata.etag'] = etag(); return {};
      }
      if (route.startsWith('contacts(')) {
        assert.equal(options.ifMatch, actor['@odata.etag']);
        const bind = options.body['parentcustomerid_account@odata.bind']; actor._parentcustomerid_value = bind?.match(/\(([^)]+)\)/)?.[1] ?? null;
        actor['@odata.etag'] = etag(); return {};
      }
      if (options.method === 'POST') {
        const body = options.body;
        registry.set(body.powerpagecomponentid, { powerpagecomponentid: body.powerpagecomponentid, powerpagecomponenttype: body.powerpagecomponenttype,
          _powerpagesiteid_value: plan.siteId, name: body.name, content: body.content, statecode: body.statecode,
          statuscode: body.statuscode, '@odata.etag': etag() });
        if (failCommittedCreate && !failed) { failed = true; throw Object.assign(new Error('Unknown create commit'), { code: 'UNKNOWN_COMMIT' }); }
        return {};
      }
      const record = registry.get(componentId(route)); assert.equal(options.ifMatch, record['@odata.etag']);
      if (options.method === 'DELETE') registry.delete(componentId(route));
      else Object.assign(record, options.body, { '@odata.etag': etag() });
      return {};
    },
  };
  return client;
}

async function withJournal(callback) {
  // The lease refuses journals outside an ignored .paqvilo directory.
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qualification-lease-')), state = path.join(directory, '.paqvilo');
  await mkdir(state);
  try { return await callback(path.join(state, 'journal.json')); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('priority pilots explicitly add six roleless-ancestor graphs without silently expanding the original grammar', () => {
  assert.equal(priority.configurations.length, 20);
  assert.equal(priority.originalGrammarPilotCount, 14);
  assert.equal(priority.extraDomain.configurations, 6);
  assert.equal(priority.extraDomain.requiredNativeCells, 204);
  for (const configuration of priority.configurations.filter(configuration => !configuration.grammarMember)) {
    assert.equal(configuration.permissions.length, configuration.parameters.depth + 1);
    assert.equal(configuration.permissions.filter(permission => !permission.roleIds.length).length, 1);
    assert.equal(configuration.components.filter(component => component.type === 18 && !component.content.adx_entitypermission_webrole.length).length, 1);
    const query = configuration.bindingContract.bindRecordIds([ids[3]]);
    assert.equal(query.table, configuration.permissions.at(-1).table);
    assert.ok(query.fetchXml.includes(`<entity name="${query.table}">`));
    assert.equal(query.fetchXml.includes('{{qualificationRecordIdValues}}'), false);
    assert.equal(configuration.nativeQualifiedCells, 0);
  }
});

test('verified native three-region bindings are mandatory before any executable lease exists', () => {
  assert.throws(() => planQualificationLease(priority.configurations[0], { blueprint, organisationId: ids[0], siteId: ids[1], actorContactId: ids[2],
    fixtureBindings: { ...bindings, nativeDataVerified: false } }), /Bind verified/);
  assert.throws(() => planQualificationLease(priority.configurations[0], { blueprint, organisationId: ids[0], siteId: ids[1], actorContactId: ids[2],
    fixtureBindings: { ...bindings, regionRecordIds: { 'own-scope': [ids[3]] } } }), /Bind verified/);
});

test('concrete three-region fixture plans use fresh run keys, preserve seeds and keep negative principals separate', () => {
  const source = JSON.stringify(catalogue);
  const configuration = priority.configurations.find(configuration => configuration.parameters.scope === 'Contact' && configuration.parameters.direction === 'many-to-many');
  const plan = planQualificationFixtures(configuration, { schema, catalogue, actorContactId: ids[2], runId: ids[6],
    resolvedIds: Object.fromEntries(catalogue.records.map(record => [record.key, record.id])) });
  assert.equal(plan.nativeDataVerified, false); assert.equal(plan.nativeExecution, false);
  assert.equal(new Set(plan.records.map(record => record.id)).size, plan.records.length);
  assert.equal(plan.records.some(record => record.id === ids[2]), false);
  assert.equal(plan.regionRecordIds['own-scope'].length, 1);
  const own = plan.records.find(record => record.table === 'pqvd_orgcontact' && record.region === 'own-scope');
  const other = plan.records.find(record => record.table === 'pqvd_orgcontact' && record.region === 'foreign-company');
  assert.equal(own.refs.pqvd_contactid.id, ids[2]); assert.notEqual(other.refs.pqvd_contactid.id, ids[2]);
  for (const record of plan.records) for (const columns of catalogue.tables.find(table => table.name === record.table).keys ?? [])
    for (const column of columns) if (typeof record.fields[column] === 'string') assert.match(record.fields[column], /^QF-/);
  assert.equal(plan.cleanup.length, plan.records.length);
  assert.equal(JSON.stringify(catalogue), source);
  assert.throws(() => planQualificationFixtures(configuration, { schema, catalogue, actorContactId: ids[2], runId: ids[6], resolvedIds: {} }), /not bound/);
});

test('fixture executable request binding uses native lookup and N:N navigation metadata, performing reads only', async () => {
  const configuration = priority.configurations[0];
  const plan = planQualificationFixtures(configuration, { schema, catalogue, actorContactId: ids[2], runId: ids[6],
    resolvedIds: Object.fromEntries(catalogue.records.map(record => [record.key, record.id])) });
  const requests = [], fake = { url: route => 'https://fixture.invalid/api/data/v9.2/' + route,
    list: async route => {
      requests.push(route);
      if (route.startsWith('EntityDefinitions')) {
        const table = route.match(/LogicalName='([^']+)'/)[1];
        const relationships = new Map();
        for (const record of plan.records.filter(record => record.table === table)) for (const [column, target] of Object.entries(record.refs))
          relationships.set(column, { ReferencingAttribute: column, ReferencedEntity: target?.table ?? 'account', ReferencingEntityNavigationPropertyName: 'native_' + column });
        return [...relationships.values()];
      }
      const name = route.match(/SchemaName eq '([^']+)'/)[1];
      return [{ Entity1LogicalName: 'pqvd_accesspermission', Entity2LogicalName: 'account', Entity1NavigationPropertyName: 'native_' + name }];
    }, request: () => { throw new Error('Planner must perform no native write'); } };
  const bound = await bindQualificationFixtureRequests(fake, plan);
  assert.ok(requests.length); assert.equal(bound.metadataBound, true); assert.equal(bound.nativeExecution, false);
  assert.equal(bound.requests.filter(request => request.kind === 'create').length, plan.records.length);
  assert.ok(bound.requests.filter(request => request.kind === 'create').every(request => request.ifNoneMatch === '*'));
  assert.ok(bound.requests.find(request => request.kind === 'deferred-bind').requireReadbackETag);
  assert.ok(bound.requests.filter(request => request.kind === 'associate').every(request => request.endpoint.includes('/native_')));
});

test('distinct principals and branches really bind different regions rather than relabelling identical own-scope access', () => {
  const configuration = priority.configurations.find(configuration => configuration.parameters.shape === 'different-principal');
  const plan = planQualificationFixtures(configuration, { schema, catalogue, actorContactId: ids[2], runId: ids[6],
    resolvedIds: Object.fromEntries(catalogue.records.map(record => [record.key, record.id])) });
  const grants = plan.records.filter(record => record.table === 'pqvd_accesspermission');
  for (const [index, principal] of ['it', 'hr', 'cto'].entries())
    assert.deepEqual(grants.filter(record => record.refs[`pqvd_${principal}principalid`]?.id === ids[2]).map(record => record.region),
      [['own-scope'], ['same-company-other-branch'], ['foreign-company']][index]);
});

test('Equipment lifecycle domain exhausts leaf flags, separates Read/Write and requires object-bound cooperating targets', () => {
  const domain = equipmentLifecycleConfigurations({ schema, catalogue });
  assert.equal(domain.configurations.length, 128); assert.equal(domain.requiredNativeCells, 4352); assert.equal(domain.nativeQualifiedCells, 0);
  const writeOnly = domain.configurations.find(configuration => configuration.parameters.leafPrivileges === 4);
  const leaf = writeOnly.permissions.find(permission => permission.table === 'pqvd_equipment');
  assert.equal(leaf.privileges.write, true); assert.equal(leaf.privileges.read, false); assert.equal(leaf.privileges.create, false);
  const full = domain.configurations.find(configuration => configuration.parameters.leafPrivileges === 63 &&
    configuration.parameters.ancestorProfile === 'cooperating-lookup-targets');
  for (const table of ['account', 'pqvd_room']) {
    const target = full.permissions.find(permission => permission.table === table);
    assert.equal(target.privileges.append, true); assert.equal(target.privileges.appendTo, true); assert.equal(target.privileges.write, false);
  }
  assert.ok(full.configurationCells.filter(cell => cell.operation === 'append').every(cell => cell.objectBoundAppendChecks));
  assert.ok(full.configurationCells.filter(cell => cell.operation !== 'read').every(cell => cell.actualPortalCRUDRequired && cell.sdkFixtureProvisioningIsNotPositiveCredit));
  const bound = full.bindingContract.bindRecordIds([ids[3]]);
  assert.match(bound.fetchXml, /<entity name="pqvd_equipment">/); assert.match(bound.fetchXml, /attribute="pqvd_name"/);
  assert.doesNotMatch(bound.fetchXml, /attribute="name"/);
  const fixtures = planQualificationFixtures(full, { schema, catalogue, actorContactId: ids[2], runId: ids[6], ownedRunId: ids[7],
    resolvedIds: Object.fromEntries(catalogue.records.map(record => [record.key, record.id])) });
  assert.equal(fixtures.records.length, 24);
  for (const equipment of fixtures.records.filter(record => record.table === 'pqvd_equipment')) {
    assert.equal(equipment.fields.pqvd_equipmentstate, 183270000); assert.equal(equipment.refs.pqvd_currentassignmentid, null);
    assert.equal(equipment.refs.pqvd_canaryrunid.id, ids[7]); assert.match(equipment.fields.pqvd_assettag, /^CO-CANARY-/);
    assert.equal(fixtures.records.some(record => Object.values(record.refs).some(reference => reference?.id === equipment.id)), false);
  }
  const fixtureBindings = { ...bindings, ownedRunId: ids[7], ownedRunActorVerified: true, stockEquipmentVerified: true };
  const plan = planQualificationLease(full, { blueprint, organisationId: ids[0], siteId: ids[1], actorContactId: ids[2], fixtureBindings });
  assert.deepEqual(plan.baselineOverrides, blueprint.nodes.filter(permission => permission.role === 'TESTRUNNER' && permission.table === 'pqvd_equipment').map(permission => permission.id));
  assert.equal(plan.baselineOverrides.length, 1);
  assert.throws(() => planQualificationLease(full, { blueprint, organisationId: ids[0], siteId: ids[1], actorContactId: ids[2], fixtureBindings: bindings }), /Stock fixtures/);
});

test('component/membership lease restores exact baseline and unrelated roles after callback failure', () => withJournal(async journalFile => {
  const plan = prepared(priority.configurations[0]), client = fakeClient(plan), initialRoles = [...client.roles].sort();
  const initialComponents = client.registry.size;
  const original = structuredClone([...client.registry.values()][0]);
  await assert.rejects(withQualificationLease(client, plan, async () => {
    assert.equal(client.roles.has(plan.businessRoleIds[0]), false);
    assert.equal(client.roles.has(plan.protectedRunnerRoleId), true);
    assert.equal(client.roles.has(ids[7]), true);
    assert.equal(client.registry.size, plan.components.length + initialComponents);
    throw new Error('Capture intentionally interrupted');
  }, { journalFile }), /Capture intentionally/);
  assert.deepEqual([...client.roles].sort(), initialRoles);
  assert.equal(client.registry.size, initialComponents); assert.equal(client.registry.get(original.powerpagecomponentid).content, original.content);
  assert.equal(JSON.parse(await readFile(journalFile)).state, 'restored');
}));

test('unknown committed create is reconciled and cleaned without retrying the native mutation', () => withJournal(async journalFile => {
  const plan = prepared(priority.configurations[0]), client = fakeClient(plan, { failCommittedCreate: true });
  const initialComponents = client.registry.size;
  await assert.rejects(withQualificationLease(client, plan, async () => { throw new Error('Callback must not run'); }, { journalFile }), /Unknown create commit/);
  assert.equal(client.writes.filter(write => write.method === 'POST').length, 1);
  assert.equal(client.registry.size, initialComponents);
  assert.equal(JSON.parse(await readFile(journalFile)).state, 'restored');
}));

test('Contact Self contamination is disabled and restored; actor Account lease uses fresh conditional ETags', () => withJournal(async journalFile => {
  const configuration = priority.configurations.find(configuration => configuration.parameters.scope === 'Self');
  const plan = prepared(configuration), client = fakeClient(plan), self = [...client.registry.values()][0];
  assert.equal(plan.baselineOverrides.length, 1);
  await withQualificationLease(client, plan, async () => { assert.equal(client.registry.get(self.powerpagecomponentid).statecode, 1);
    assert.ok(plan.baselineOverrides.every(id => client.registry.get(id).statecode === 1)); }, { journalFile });
  assert.equal(client.registry.get(self.powerpagecomponentid).statecode, 0);
  assert.ok(plan.baselineOverrides.every(id => client.registry.get(id).statecode === 0));
  const accountConfiguration = priority.configurations.find(configuration => configuration.parameters.scope === 'Account');
  const accountPlan = prepared(accountConfiguration), accountClient = fakeClient(accountPlan);
  await withQualificationLease(accountClient, accountPlan, async () => { assert.equal(accountClient.actor._parentcustomerid_value, bindings.ownAccountId); },
    { journalFile: journalFile + '.account.json' });
  assert.equal(accountClient.actor._parentcustomerid_value, ids[4]);
}));

test('baseline overrides compute descendant closure and deactivate deepest children before their parent', () => {
  const configuration = priority.configurations.find(configuration => configuration.parameters.scope === 'Self');
  const graph = structuredClone(blueprint), parent = graph.nodes.find(permission => permission.role === 'TESTRUNNER' && permission.table === 'contact');
  graph.nodes.push({ ...parent, key: 'invented-descendant', id: ids[7], table: 'invented_probe', scope: 'Parent', parent: parent.key });
  const plan = planQualificationLease(configuration, { blueprint: graph, organisationId: ids[0], siteId: ids[1], actorContactId: ids[2], fixtureBindings: bindings });
  assert.deepEqual(plan.baselineOverrides, [ids[7], parent.id]);
});

test('recovery refuses concurrent foreign role or owned component content drift before writes', () => withJournal(async journalFile => {
  const plan = prepared(priority.configurations[0]), client = fakeClient(plan);
  await assert.rejects(withQualificationLease(client, plan, async () => { client.roles.add(ids[5]); }, { journalFile }), /Unrelated native role/);
  const journal = JSON.parse(await readFile(journalFile)); client.roles.delete(ids[5]);
  const owned = client.registry.get(plan.components[0].id); owned.content = '{}';
  const count = client.writes.length;
  await assert.rejects(restoreQualificationLease(client, journal, { journalFile, expectedOrganisationId: plan.organisationId }), /identity\/content/);
  assert.equal(client.writes.length, count);
}));
