import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildBlueprint } from '../portal-security/blueprint.mjs';
import { compilePlans, caseTemplate, dispatcher } from '../portal-harness/compile.mjs';
import { buildQualificationDomain, qualificationRoleMasks, qualificationReadCells,
  expectedPrincipalFootprint, summarizeQualification, scopeHierarchyVariantDomain, scopeHierarchyVariantCases,
  requiredNativeWitnesses, materializeScopeHierarchyVariant, summarizeConfigurationQualification, sealConfigurationWitnesses } from '../portal-security/qualification-domain.mjs';

const schema = JSON.parse(await readFile(new URL('../dataverse/manifest.json', import.meta.url)));
const catalogue = JSON.parse(await readFile(new URL('../data/stress-catalogue.json', import.meta.url)));
const blueprint = buildBlueprint(schema, catalogue);
const plans = compilePlans(catalogue, schema);
const witnesses = Object.fromEntries(requiredNativeWitnesses.map((name, index) => [name, String(index).repeat(64)]));
const build = overrides => buildQualificationDomain({ blueprint, schema, catalogue, manifest: plans, witnesses, ...overrides });

test('the source lattice enumerates all 4096 distinct role masks with one-role Gray-code transitions', () => {
  const domain = build(), combinations = [...qualificationRoleMasks(domain)];
  assert.equal(combinations.length, 4096);
  assert.equal(new Set(combinations.map(combination => combination.mask)).size, 4096);
  assert.deepEqual(combinations[0].roleCodes, []);
  for (const combination of combinations.slice(1)) {
    assert.equal(combination.changedRoleBits & (combination.changedRoleBits - 1), 0);
    assert.equal(combination.roleCodes.length, combination.mask.toString(2).replaceAll('0', '').length);
  }
  assert.deepEqual(combinations.find(combination => combination.mask === 4095).roleCodes, domain.businessRoles.map(role => role.code));
  assert.equal(domain.privilegeLedgerDomain.nativeQualification, false);
});

test('paired FetchXML and API-only OData are separate finite cells with stable resumable IDs', () => {
  const domain = build();
  assert.equal(domain.readDomain.laneCellsPerMask, 37 * 2 + 8);
  assert.equal(domain.readDomain.denominator, 335872);
  const sample = [...qualificationReadCells(domain, { masks: [0, 1] })];
  assert.equal(sample.length, 164);
  assert.equal(new Set(sample.map(cell => cell.id)).size, sample.length);
  assert.equal(sample.filter(cell => cell.queryId.endsWith('-odata') && cell.lane === 'liquid').length, 0);
  assert.deepEqual([...qualificationReadCells(domain, { masks: [0, 1], afterCellId: sample[40].id })], sample.slice(41));
  assert.throws(() => [...qualificationReadCells(domain, { masks: [4096] })], /finite/);
  assert.throws(() => [...qualificationReadCells(domain, { masks: [0], afterCellId: 'wrong' })], /resume/);
  assert.equal(build().domainHash, domain.domainHash);
});

test('the authored seventeen budget variants expand the fixed native read denominator to 475136', () => {
  const equipment = plans.cases.find(plan => plan.id === 'R09');
  const stressCases = Array.from({ length: 17 }, (_, count) => ({ ...equipment, id: `S01-J${String(count).padStart(2, '0')}`, variant: 'query-budget' }));
  const domain = build({ manifest: { ...plans, stressCases } });
  assert.equal(domain.readDomain.queryVariants, 62);
  assert.equal(domain.readDomain.denominator, 475136);
});

test('cache expectations preserve role path multiplicity and drop inactive complete subtrees', () => {
  const both = expectedPrincipalFootprint(blueprint, schema, 'pqvd_equipment', ['IT', 'COMPANYMANAGER']);
  assert.deepEqual(both.map(terminal => terminal.field).sort(), ['pqvd_companymanagerprincipalid', 'pqvd_itprincipalid']);
  const deep = expectedPrincipalFootprint(blueprint, schema, 'pqvd_finding', ['IT']);
  assert.equal(deep.length, 2);
  assert.deepEqual(deep.map(terminal => terminal.depth).sort((a, b) => a - b), [8, 10]);
  const variant = structuredClone(blueprint);
  variant.nodes.find(node => node.key === 'IT-EQUIPMENT-SERVICEREQUEST').active = false;
  assert.equal(expectedPrincipalFootprint(variant, schema, 'pqvd_finding', ['IT']).length, 1);
  assert.deepEqual(expectedPrincipalFootprint(blueprint, schema, 'pqvd_equipment', []), []);
});

test('missing snapshots/cache/backend/context evidence, duplicates and source drift cannot produce a green campaign', () => {
  const domain = build(), cell = qualificationReadCells(domain, { masks: [1] }).next().value;
  const evidence = Object.fromEntries(['nativeConfigurationVerified', 'nativeMembershipsVerified', 'nativeDataVerified', 'nativeCacheQualified',
    'completePages', 'backendBytesCompared', 'runtimeContextCompared', 'outcomeCompared', 'rowsCompared'].map(name => [name, true]));
  const good = { ...cell, verdict: 'equal', evidence };
  const report = summarizeQualification(domain, [good]);
  assert.equal(report.equal, 1);
  assert.equal(report.complete, false);
  assert.equal(report.universalPermissionParity, false);
  assert.equal(report.missing, domain.readDomain.denominator - 1);
  const missing = summarizeQualification(domain, [{ ...good, evidence: { ...evidence, nativeCacheQualified: false } }]);
  assert.equal(missing.equal, 0);
  assert.equal(missing.unqualified, 1);
  assert.equal(summarizeQualification(domain, [{ ...good, inputHash: 'a'.repeat(64) }]).unqualified, 1);
  const noSnapshots = build({ witnesses: {} }), unsealed = qualificationReadCells(noSnapshots, { masks: [1] }).next().value;
  assert.equal(summarizeQualification(noSnapshots, [{ ...unsealed, verdict: 'equal', evidence }]).unqualified, 1);
  assert.throws(() => summarizeQualification(domain, [good, good]), /Duplicate/);
  assert.throws(() => summarizeQualification(domain, [{ ...good, id: 'wrong' }]), /frozen/);
});

test('scope/hierarchy grammar names 2117 explicit configuration requirements without crediting unrecorded native coverage', () => {
  const domain = scopeHierarchyVariantDomain(), cases = [...scopeHierarchyVariantCases(domain)];
  assert.equal(domain.denominator, 2117);
  assert.equal(cases.length, 2117);
  assert.equal(new Set(cases.map(variant => variant.id)).size, 2117);
  assert.equal(domain.nativeQualifiedCases, 0);
  assert.ok(cases.every(variant => variant.nativeQualification === 'unrecorded' && variant.requiresIsolatedGraph));
  const all = cases.find(variant => variant.parameters.leafPrivileges === 63);
  assert.deepEqual(Object.values(all.leafPrivileges), [true, true, true, true, true, true]);
  assert.ok(domain.excluded.includes('Custom Access Preview/enhanced authorization'));
});

test('every finite variant materializes concrete native components and a bounded harness query contract', () => {
  const variants = [...scopeHierarchyVariantCases()];
  const configurations = variants.map(variant => materializeScopeHierarchyVariant(variant, { schema, catalogue }));
  const allComponentIds = configurations.flatMap(configuration => configuration.components.map(component => component.id));
  assert.equal(new Set(allComponentIds).size, allComponentIds.length);
  for (const configuration of configurations) {
    assert.equal(configuration.nativeExecution, false);
    assert.equal(configuration.nativeQualifiedCells, 0);
    assert.equal(configuration.configurationCells.length, configuration.nativeCellsPerRepeat);
    assert.ok(configuration.query.id.length <= 64, 'Operation case IDs fit Dataverse Text(64).');
    const ids = new Set(configuration.components.map(component => component.id));
    for (const component of configuration.components.filter(component => component.type === 18)) {
      assert.ok(schema.tables.some(table => table.name === component.content.entitylogicalname));
      assert.ok(component.content.scope >= 756150000 && component.content.scope <= 756150004);
      assert.ok(component.content.adx_entitypermission_webrole.every(id => ids.has(id)));
      if (component.content.parententitypermission) assert.ok(ids.has(component.content.parententitypermission));
      if (component.content.scope === 756150002) assert.ok(component.content.accountrelationship);
      if (component.content.scope === 756150004) assert.equal(component.content.entitylogicalname, 'contact');
    }
    const bound = configuration.bindingContract.bindRecordIds(['11111111-2222-4333-8444-555555555555']);
    assert.deepEqual(bound.fixtureBindings, []);
    assert.ok(!bound.fetchXml.includes('{{qualificationRecordIdValues}}'));
    assert.match(bound.fetchXml, /<value>11111111-2222-4333-8444-555555555555<\/value>/);
  }
  assert.equal(configurations.reduce((count, configuration) => count + configuration.configurationCells.length, 0), 177242);
});

test('the deep graph uses eleven actual Parent edges and classic scope templates retain server-stamped markers', () => {
  const variants = [...scopeHierarchyVariantCases()];
  const variant = variants.find(variant => variant.family === 'parent-depth' && variant.parameters.depth === 11 && variant.parameters.parentRead && variant.parameters.leafPrivileges === 63);
  const original = materializeScopeHierarchyVariant(variant, { schema, catalogue });
  const config = sealConfigurationWitnesses(original, { witnesses,
    boundQuery: original.bindingContract.bindRecordIds(['11111111-2222-4333-8444-555555555555']) });
  assert.equal(config.permissions.length, 12);
  assert.equal(config.permissions.filter(permission => permission.scope === 'Parent').length, 11);
  assert.equal(config.permissions[0].scope, 'Self');
  assert.equal(config.query.table, 'pqvd_finding');
  assert.equal(config.permissions.filter(permission => permission.relationship === 'pqvd_access_accounts').length, 1);
  const plan = config.bindingContract.bindRecordIds(['11111111-2222-4333-8444-555555555555']);
  const source = caseTemplate(plan);
  assert.match(source, /operation.pqvd_markerutc \| xml_escape/);
  assert.match(source, /operation.pqvd_markeroperation \| xml_escape/);
  assert.match(source, /visibility_query.xml \| xml_escape/);
  assert.ok(dispatcher({ cases: [plan], suiteVersion: 'fixture-suite', datasetVersion: 'fixture-data', manifestHash: 'a'.repeat(64) }).includes(plan.id));
  const nativeNn = materializeScopeHierarchyVariant(variants.find(variant => variant.family === 'relationship' && variant.parameters.scope === 'Contact' && variant.parameters.direction === 'many-to-many'), { schema, catalogue });
  assert.equal(nativeNn.metadataRequirements.length, 1);
  assert.equal(nativeNn.metadataRequirements[0].nativeBody['@odata.type'], 'Microsoft.Dynamics.CRM.ManyToManyRelationshipMetadata');
  assert.deepEqual(nativeNn.metadataRequirements[0].definition.intersectColumns, ['contactid', 'pqvd_orgcontactid']);
  const anonymous = materializeScopeHierarchyVariant(variants.find(variant => variant.family === 'root-scope' && variant.parameters.scope === 'Global' && variant.parameters.roleDefault === 'anonymous'), { schema, catalogue });
  assert.ok(anonymous.roles[0].anonymous);
  assert.ok(anonymous.runtimeRequirements.some(requirement => requirement.kind === 'anonymous-public-read-endpoint-and-observer-provenance'));
});

test('configuration proof counts actual role-mask cells and never credits a backend guard failure as a permission denial', () => {
  const variant = [...scopeHierarchyVariantCases()].find(variant => variant.family === 'alternative-grants' && variant.parameters.grants === 3);
  const original = materializeScopeHierarchyVariant(variant, { schema, catalogue });
  const config = sealConfigurationWitnesses(original, { witnesses,
    boundQuery: original.bindingContract.bindRecordIds(['11111111-2222-4333-8444-555555555555']) });
  assert.equal(config.roleMaskCount, 8);
  assert.equal(config.configurationCells.length, 136);
  const observation = { ...config.configurationCells.find(cell => cell.operation === 'write'), verdict: 'equal', inputHash: config.inputHash,
    evidence: Object.fromEntries(['nativeConfigurationVerified', 'nativeMembershipsVerified', 'nativeDataVerified', 'nativeCacheQualified',
      'actorContextQualified', 'completePages', 'backendBytesCompared', 'runtimeContextCompared', 'outcomeCompared', 'rowsCompared',
      'permissionBoundaryDistinguishedFromBusinessGuard', 'cleanupVerified'].map(name => [name, true])) };
  assert.equal(summarizeConfigurationQualification([config], [observation]).equal, 1);
  assert.equal(summarizeConfigurationQualification([original], [observation]).unqualified, 1);
  assert.equal(summarizeConfigurationQualification([config], [{ ...observation, evidence: { ...observation.evidence, cleanupVerified: false } }]).unqualified, 1);
  assert.equal(summarizeConfigurationQualification([config], [{ ...observation, evidence: { ...observation.evidence, permissionBoundaryDistinguishedFromBusinessGuard: false } }]).unqualified, 1);
  assert.throws(() => summarizeConfigurationQualification([config], [observation, observation]), /duplicated/);
  assert.throws(() => config.bindingContract.bindRecordIds(['{{injection}}']), /verified native fixture GUIDs/);
});
