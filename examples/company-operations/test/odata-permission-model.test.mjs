import test from 'node:test';
import assert from 'node:assert/strict';
import { buildODataPermissionFilter, inspectNativeODataPermissionFilter, binaryOr,
  serializeODataPermissionNode, sourceODataAdmissionFeatures } from '../portal-security/odata-permission-model.mjs';

const actor = { contactId: 'abcdef12-0000-0000-0000-000000000001', roleIds: ['r'] };
const root = { id: 'root', entity: 'grant', scope: 'contact', field: 'operatorid', roleIds: ['r'], operations: ['read'] };
const relation = { entity: 'grant', from: 'teamid', to: 'grantid', intersect: { entity: 'grant_teams', from: 'teamid', to: 'grantid' } };
const permission = { id: 'team', entity: 'team', scope: 'parent', parentPermissionId: 'root', roleIds: ['r'], operations: ['read'], relationship: relation };

test('OData N:N alternatives use any/inner with source principal filter and stable per-path anyallalias', () => {
  const result = buildODataPermissionFilter({ table: 'team', identity: actor, permissions: [root, permission], grantOrder: ['team'] });
  assert.deepEqual(result.diagnostics, []);
  assert.match(result.xml, /name="grant_teams" to="teamid" from="teamid" link-type="any"/);
  assert.match(result.xml, /anyallalias="grant_teams1"/);
  assert.match(result.xml, /attribute="grantid" operator="not-null"/);
  assert.match(result.xml, /attribute="operatorid" operator="eq"/);
  assert.match(result.xml, /value="\{ABCDEF12-0000-0000-0000-000000000001\}"/);
  assert.doesNotMatch(result.xml, /generated_alias_|name="contact"/);
  assert.equal(result.nativeQualified, false);
});

test('same-table Parent reuses observed anchor filter and adds child lookup non-null, without pretending it is outer FetchXML', () => {
  const child = { ...permission, id: 'child', parentPermissionId: 'team', relationship: { entity: 'team', from: 'parentteamid', to: 'teamid' } };
  const result = buildODataPermissionFilter({ table: 'team', identity: actor, permissions: [root, permission, child], grantOrder: ['child', 'team'] });
  assert.match(result.alternatives[0].xml, /attribute="parentteamid" operator="not-null"/);
  assert.match(result.alternatives[0].xml, /to="teamid" from="teamid" link-type="any"/);
  assert.doesNotMatch(result.alternatives[0].xml, /to="parentteamid"|link-type="outer"/);
  const wrapped = inspectNativeODataPermissionFilter(`<fetch><entity name="team"><filter type="and"><filter type="and"><condition attribute="name" operator="not-null" /></filter>${result.xml}</filter></entity></fetch>`);
  assert.equal(wrapped.alternatives.length, 2);
  assert.match(wrapped.alternatives[0].xml, /attribute="parentteamid" operator="not-null"/);
});

test('authoring right-nested OR and native permission left-nested OR retain different binary ASTs and order', () => {
  const alternatives = ['a', 'b', 'c'].map(value => ({ name: 'condition', attrs: { attribute: value, operator: 'not-null' }, children: [], text: '' }));
  const left = serializeODataPermissionNode(binaryOr(alternatives));
  const right = serializeODataPermissionNode(binaryOr(alternatives, 'right'));
  assert.notEqual(left, right);
  const received = inspectNativeODataPermissionFilter(`<fetch distinct="false" useraworderby="true"><entity name="team">${left}</entity></fetch>`);
  assert.deepEqual(received.alternatives.map(alternative => alternative.expression.attrs.attribute), ['a', 'b', 'c']);
  assert.equal(received.fetchAttributes.distinct, 'false'); assert.equal(received.nativeQualified, false);
});

test('unsupported parent/identity directions, missing parent privileges and unknown ordering remain unqualified', () => {
  const different = { ...permission, relationship: { entity: 'grant', from: 'grantid', to: 'grantid' } };
  const result = buildODataPermissionFilter({ table: 'team', identity: actor, permissions: [root, different] });
  assert.equal(result.xml, null);
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === 'ODATA_DIFFERENT_TABLE_PARENT_UNQUALIFIED'));
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === 'ODATA_PERMISSION_ORDER_UNQUALIFIED'));
  assert.equal(buildODataPermissionFilter({ table: 'team', identity: actor, permissions: [{ ...root, operations: [] }, permission], grantOrder: ['team'] }).xml, null);
});

test('admission hypotheses derive multi-level cross-table features without treating all Parent or N:N scopes as failures', () => {
  const simple = sourceODataAdmissionFeatures({ table: 'team', permissions: [root, permission], identity: actor });
  assert.equal(simple.admissionPrediction, 'backend-query-candidate');
  assert.equal(simple.paths[0].parentHops, 1); assert.equal(simple.paths[0].intersectHops, 1);
  const sameTable = { ...permission, id: 'child', parentPermissionId: 'team', relationship: { entity: 'team', from: 'parentteamid', to: 'teamid' } };
  assert.equal(sourceODataAdmissionFeatures({ table: 'team', permissions: [root, permission, sameTable], identity: actor }).admissionPrediction, 'backend-query-candidate');
  const deeper = { ...permission, id: 'device', entity: 'device', parentPermissionId: 'team', relationship: { entity: 'team', from: 'teamid', to: 'teamid' } };
  const features = sourceODataAdmissionFeatures({ table: 'device', permissions: [root, permission, deeper], identity: actor });
  assert.equal(features.admissionPrediction, 'native-cds-error-candidate'); assert.equal(features.nativeQualified, false);
  const direct = { ...deeper, parentPermissionId: 'root', relationship: { entity: 'grant', from: 'grantid', to: 'grantid' } };
  assert.equal(sourceODataAdmissionFeatures({ table: 'device', permissions: [root, direct], identity: actor }).admissionPrediction, 'requires-native-calibration');
  assert.equal(sourceODataAdmissionFeatures({ table: 'device', permissions: [{ ...deeper, scope: 'global' }, root], identity: actor }).admissionPrediction, 'global-bypass-calibration-required');
});
