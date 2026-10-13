import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { compilePermissionFetchXml } from 'paqvilo/mirage/lib/permission-query.mjs';
import { buildBlueprint } from '../portal-security/blueprint.mjs';
import { caseTemplate, dispatcher } from '../portal-harness/compile.mjs';
import { permissionPathSequence, permissionPathCatalogue, learnPermissionOrder,
  compareFilteredPermissionOrder, buildPermissionOrderProbe, diagnosePermissionOrder,
  permissionOrderGraphFingerprint } from '../portal-security/permission-order.mjs';

const authoredXml = '<fetch><entity name="asset"><attribute name="assetid"/><link-entity name="team" from="teamid" to="teamid" alias="authored_team" link-type="outer"/></entity></fetch>';
const actor = { contactId: '00000000-0000-0000-0000-000000000001', roleIds: ['ra', 'rb'], roleSource: 'memberships' };
const permissions = ['a', 'b'].flatMap(code => [
  { id: code + '-root', entity: 'grant', scope: 'contact', field: code + 'principalid', operations: ['read'], roleIds: ['r' + code] },
  { id: code + '-leaf', entity: 'asset', scope: 'parent', parentPermissionId: code + '-root', operations: ['read'], roleIds: ['r' + code],
    relationship: { entity: 'grant', from: code + 'grantid', to: 'grantid' } },
]);
const compiled = grants => compilePermissionFetchXml(authoredXml, { permissions, identity: actor,
  rules: entity => entity === 'asset' ? grants : permissions.filter(permission => permission.entity === entity) }).xml;
const catalogue = () => permissionPathCatalogue({ permissions, identity: actor, table: 'asset', authoredXml });
const witness = (xml, roleIds = actor.roleIds) => ({ authoredXml, receivedXml: xml, repeatReceivedXml: xml,
  permissionsSnapshotHash: catalogue().permissionsSnapshotHash, roleIds,
  observerProfileHash: 'c'.repeat(64),
  nativeMembershipsVerified: true, nativeCacheQualified: true, artifactIntegrityVerified: true,
  artifactHash: createHash('sha256').update(xml).digest('hex') });

test('native path signatures ignore generated alias numbering and retain actual permission joins and terminal values', () => {
  const xml = compiled(permissions.filter(permission => permission.entity === 'asset'));
  const original = permissionPathSequence(xml, authoredXml);
  assert.equal(original.sequence.length, 2);
  assert.deepEqual(original.diagnostics, []);
  assert.deepEqual(permissionPathSequence(xml.replaceAll('generated_alias_grant_0', 'generated_alias_grant_12'), authoredXml).sequence, original.sequence);
  assert.equal(original.sequence[0].shape.links.length, 1);
  assert.notEqual(permissionPathSequence(xml.replaceAll('aprincipalid', 'otherprincipalid'), authoredXml).sequence[0].signature, original.sequence[0].signature);
});

test('master order and filtered actual subset detect branch-order contradictions without claiming exhaustive coverage', () => {
  const leaves = permissions.filter(permission => permission.entity === 'asset');
  const source = catalogue(); assert.deepEqual(source.diagnostics, []);
  const order = learnPermissionOrder(source, witness(compiled([...leaves].reverse())));
  assert.equal(order.qualification, 'master-order-only');
  assert.deepEqual(order.orderedPermissionGroups, [['b-leaf'], ['a-leaf']]);
  assert.equal(compareFilteredPermissionOrder(order, source, witness(compiled([leaves[0]]), ['ra'])).verdict, 'equal');
  assert.equal(compareFilteredPermissionOrder(order, source, witness(compiled(leaves))).verdict, 'different');
  assert.equal(order.universalPermissionParity, false);
  assert.equal(learnPermissionOrder(source, { ...witness(compiled(leaves)), repeatReceivedXml: null }).qualification, 'unqualified');
  assert.equal(learnPermissionOrder(source, { ...witness(compiled(leaves)), roleIds: ['ra'] }).qualification, 'unqualified');
  assert.equal(learnPermissionOrder(source, { ...witness(compiled(leaves)), artifactHash: '0'.repeat(64) }).qualification, 'unqualified');
  assert.equal(compareFilteredPermissionOrder(order, source,
    { ...witness(compiled([leaves[0]]), ['ra']), observerProfileHash: 'd'.repeat(64) }).verdict, 'unqualified');
  const hypotheses = diagnosePermissionOrder(source, permissionPathSequence(compiled([...leaves].reverse()), authoredXml).sequence);
  assert.equal(hypotheses['permission-guid-lexical'].matches, false);
  assert.equal(hypotheses['source-definition-order'].qualification, 'hypothesis-only');
  assert.throws(() => diagnosePermissionOrder(source, permissionPathSequence(compiled(leaves), authoredXml).sequence,
    { externalOrders: { 'runtime-guid': ['a-leaf', 'a-leaf'] } }), /exactly/);
});

test('identical grant paths remain ambiguous source groups instead of invented native GUID order', () => {
  const source = catalogue(); source.entries.push({ ...source.entries[0], permissionId: 'duplicate-leaf' });
  const master = learnPermissionOrder(source, witness(compiled(permissions.filter(permission => permission.entity === 'asset'))));
  assert.equal(master.qualification, 'master-order-only');
  assert.deepEqual(master.orderedPermissionGroups[0], ['a-leaf', 'duplicate-leaf']);
});

test('graph fingerprint is independent of export order but invalidates scope, flags and relationship changes', () => {
  const graph = permissionOrderGraphFingerprint(permissions);
  assert.equal(permissionOrderGraphFingerprint([...permissions].reverse()), graph);
  assert.notEqual(permissionOrderGraphFingerprint(permissions.map(permission => ({ ...permission, operations: ['read', 'delete'] }))), graph);
  assert.notEqual(permissionOrderGraphFingerprint(permissions.map(permission => ({ ...permission, field: 'otherprincipalid' }))), graph);
  assert.notEqual(permissionOrderGraphFingerprint(permissions.map(permission => permission.relationship
    ? { ...permission, relationship: { ...permission.relationship, from: 'othergrantid' } } : permission)), graph);
});

test('same-table parent singleton catalogue retains ancestors and never falsely reports an unresolved path', () => {
  const ancestor = { id: 'ancestor', entity: 'asset', scope: 'contact', field: 'contactid', operations: ['read'], roleIds: ['ra'] };
  const child = { id: 'child', entity: 'asset', scope: 'parent', parentPermissionId: 'ancestor', operations: ['read'], roleIds: ['ra'],
    relationship: { entity: 'asset', from: 'parentassetid', to: 'assetid' } };
  const result = permissionPathCatalogue({ permissions: [ancestor, child], identity: actor, table: 'asset', authoredXml });
  // Singleton root compilation must exclude the ancestor as an independent
  // leaf but include it while resolving the child's same-table parent path.
  assert.equal(result.entries.filter(entry => entry.permissionId === 'child').length, 1);
});

test('current-source master probe has bounded independent requests and explicit representative versus exhaustive denominators', async () => {
  const schema = JSON.parse(await readFile(new URL('../dataverse/manifest.json', import.meta.url)));
  const records = JSON.parse(await readFile(new URL('../data/stress-catalogue.json', import.meta.url)));
  const probe = buildPermissionOrderProbe({ schema, catalogue: records, blueprint: buildBlueprint(schema, records), permissionsSnapshotHash: 'a'.repeat(64) });
  assert.equal(probe.masterMask, 4095);
  assert.equal(probe.representativeMasks.length, 92);
  assert.equal(probe.cases.length, 20);
  assert.equal(probe.calibrationCells, 3680);
  assert.equal(probe.exhaustiveSubsetCells, 163840);
  assert.ok(probe.cases.some(plan=>plan.table==='pqvd_currencyreference'));
  assert.ok(probe.cases.some(plan=>plan.table==='transactioncurrency'));
  assert.equal(probe.universalPermissionParity, false);
  for (const plan of probe.cases) {
    assert.equal(plan.authoredJoinCount, 0);
    assert.ok(encodeURIComponent(plan.fetchXml).length < 3500);
    assert.ok(plan.id.length <= 64);
    assert.match(caseTemplate(plan), /visibility_query.xml/);
    assert.match(caseTemplate(plan), /operation.pqvd_markeroperation/);
  }
  assert.match(dispatcher({ cases: probe.cases, datasetVersion: records.version }), /QF-ORDER-19/);
});
