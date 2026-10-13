import test from 'node:test';
import assert from 'node:assert/strict';
import { compileODataPermissionQuery, authoredScalarODataFetch, odataPermissionPathFeatures } from '../lib/odata-permission-query.mjs';
import { permissionOrderGraphFingerprint } from '../lib/permission-query.mjs';
import { parseXmlDocument } from '../lib/fetchxml-engine.mjs';

const actor = { contactId: '00000000-0000-0000-0000-000000000abc', roleIds: ['ra'], roleSource: 'memberships' };
const mappings = { company: { idColumn: 'companyid' }, grant: { idColumn: 'grantid' } };
const permissions = [{ id: 'principal', entity: 'grant', scope: 'contact', field: 'holderid', operations: ['read'], roleIds: ['ra'] },
  { id: 'company', entity: 'company', scope: 'parent', parentPermissionId: 'principal', operations: ['read'], roleIds: ['ra'],
    relationship: { entity: 'grant', from: 'companyid', to: 'grantid', intersect: { entity: 'grantcompany', from: 'companyid', to: 'grantid' } } }];
const authored = '<fetch><entity name="company"><attribute name="companyid"/><filter type="and"><filter type="or"><filter type="and"><condition attribute="companyid" operator="eq" value="00000000-0000-0000-0000-000000000def"/></filter><filter type="and"><condition attribute="name" operator="null"/></filter></filter></filter><order attribute="companyid"/></entity></fetch>';
const compile = (extra = {}) => compileODataPermissionQuery(authored, { permissions, mappings, identity: actor, ...extra });

test('OData compiler produces compact any/inner native-shaped paths, uppercase GUIDs and authored-then-permission filters', () => {
  const result = compile();
  assert.equal(result.xml, '<fetch distinct="false" useraworderby="true" no-lock="false" mapping="logical" page="1" count="5000" returntotalrecordcount="true"><entity name="company"><attribute name="companyid" /><filter type="and"><filter type="and"><filter type="or"><condition attribute="companyid" operator="eq" value="{00000000-0000-0000-0000-000000000DEF}" /><condition attribute="name" operator="null" /></filter></filter><filter type="and"><link-entity name="grantcompany" to="companyid" from="companyid" link-type="any"><link-entity name="grant" to="grantid" from="grantid" link-type="inner"><filter type="and" anyallalias="grantcompany1"><condition attribute="grantid" operator="not-null" /><condition attribute="holderid" operator="eq" value="{00000000-0000-0000-0000-000000000ABC}" /></filter></link-entity></link-entity></filter></filter><order attribute="companyid" descending="false" /></entity></fetch>');
  assert.equal(result.permissionLinkCount, 2);
  assert.deepEqual(result.generatedLinkOrdinals, [0, 1]);
  assert.deepEqual(result.generatedAnyAllAliases, [{ filterOrdinal: 4, alias: 'grantcompany1' }]);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.universalNativeParity, false);
  assert.equal(result.xml.includes('\n'), false);
});

test('same-table Parent adds lookup existence without reinterpreting the witnessed N:N anchor', () => {
  const unit = { ...permissions[1], id: 'unit', parentPermissionId: 'company', relationship: { entity: 'company', from: 'parentcompanyid', to: 'companyid' } };
  const all = [...permissions, unit], order = { normalizedGraphHash: permissionOrderGraphFingerprint(all), tables: { company: [['unit'], ['company']] } };
  assert.throws(() => compile({ permissions: all, grantOrder: order }), /explicit evidenced profile/);
  const result = compile({ permissions: all, grantOrder: order, sameTableParentAnchor: 'shared-root' });
  assert.ok(result.xml.includes('<condition attribute="parentcompanyid" operator="not-null" />'));
  assert.equal((result.xml.match(/name="grantcompany" to="companyid"/g) ?? []).length, 2);
  assert.equal(result.permissionLinkCount, 4);
  assert.deepEqual(result.grantIds, ['unit', 'company']);
});

test('source order is independently required and graph drift/missing grants reject construction', () => {
  const second = { ...permissions[1], id: 'second' }, all = [...permissions, second];
  assert.throws(() => compile({ permissions: all }), error => error.code === 'PermissionGrantOrderUnqualified');
  const order = { normalizedGraphHash: permissionOrderGraphFingerprint(all), tables: { company: [['second'], ['company']] } };
  const result = compile({ permissions: all, grantOrder: order });
  assert.deepEqual(result.grantIds, ['second', 'company']);
  const root = parseXmlDocument(result.xml).children[0], union = root.children.find(child => child.name === 'filter').children[1];
  assert.equal(union.attrs.type, 'or');
  assert.throws(() => compile({ permissions: all, grantOrder: { ...order, normalizedGraphHash: 'a'.repeat(64) } }), /source graph/);
  assert.throws(() => compile({ permissions: all, grantOrder: { ...order, tables: { company: [['company']] } } }), /every selected/);
});

test('unqualified native conversion directions and foreign memberships cannot produce a partial authorized query', () => {
  assert.throws(() => compile({ identity: { ...actor, roleIds: ['foreign'] } }), error => error.status === 403);
  const broken = [{ ...permissions[0], enabled: false }, permissions[1]];
  assert.throws(() => compile({ permissions: broken }), /complete enabled Read path/);
  const different = [{ ...permissions[1], relationship: { entity: 'grant', from: 'grantlookup', to: 'grantid' } }, permissions[0]];
  assert.throws(() => compile({ permissions: different }), /Different-table Parent/);
  assert.throws(() => compileODataPermissionQuery(authored.replace('<fetch>', '<fetch top="10">'), { permissions, identity: actor, mappings }), /separately qualified/);
});

test('authored eighteen-term OData preserves boolean shape without inheriting the SDK sixteen-level limit', () => {
  const terms = Array.from({ length: 18 }, (_, i) => `companyid eq 00000000-0000-0000-0000-${String(i).padStart(12, '0')}`);
  const or = values => values.length === 1 ? values[0] : `${values[0]} or (${or(values.slice(1))})`;
  const xml = authoredScalarODataFetch('company', { $select: 'companyid,_ownerid_value', $filter: `(${or(terms)}) and (name ne 'marker')`, $orderby: 'companyid' }, {
    resolveAttribute: (_table, attribute) => attribute === '_ownerid_value' ? 'ownerid' : attribute });
  assert.equal((xml.match(/operator="eq"/g) ?? []).length, 18);
  assert.ok(xml.includes('<attribute name="ownerid" />'));
  const result = compileODataPermissionQuery(xml, { permissions, mappings, identity: actor });
  assert.equal(result.permissionLinkCount, 2);
  assert.ok(result.xml.includes('<order attribute="companyid" descending="false" />'));
  const left = authoredScalarODataFetch('company', { $filter: terms.slice(0, 3).join(' or ') });
  const values = [...left.matchAll(/value="\{([^}]+)\}"/g)].map(match => match[1]);
  assert.deepEqual(values, [2, 0, 1].map(i => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`));
});

test('admission calibration features distinguish a one-hop N:N root, cross-table descendant and inactive parent without granting access', () => {
  const child = { id: 'asset', entity: 'asset', scope: 'parent', parentPermissionId: 'company', operations: ['read'], roleIds: ['ra'],
    relationship: { entity: 'company', from: 'companylookup', to: 'companyid' } };
  const all = [...permissions, child];
  assert.equal(odataPermissionPathFeatures({ table: 'company', permissions: all, identity: actor }).multiLevelCrossTable, false);
  assert.equal(odataPermissionPathFeatures({ table: 'asset', permissions: all, identity: actor }).multiLevelCrossTable, true);
  const broken = all.map(permission => permission.id === 'company' ? { ...permission, enabled: false } : permission);
  const unsupported = odataPermissionPathFeatures({ table: 'asset', permissions: broken, identity: actor });
  assert.equal(unsupported.paths[0].unresolved, true);
  assert.equal(unsupported.multiLevelCrossTable, false);
  assert.equal(unsupported.nativeQualified, false);
});
