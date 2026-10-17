import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildPermissionModel, resolveScopedRelationship } from '../lib/permissions.mjs';
import { importSolutionData } from '../lib/solution-data.mjs';
import { DataStore } from '../lib/data.mjs';
import { createSimulator } from '../server.mjs';

function fixture() {
  const records = [
    {kind: 'webrole', id: 'reader', name: 'Reader'},
    {kind: 'tablepermission', id: 'own-roles', adx_name: 'Own roles', adx_entitylogicalname: 'assignment', adx_scope: 756150001, adx_contactrelationship: 'assignment_contact', adx_read: true, adx_entitypermission_webrole: ['reader']},
    {kind: 'tablepermission', id: 'organizations', adx_name: 'Organizations', adx_entitylogicalname: 'organization', adx_scope: 756150003, adx_parententitypermission: 'own-roles', adx_parentrelationship: 'assignment_organization', adx_read: true},
  ];
  const state = {mappings: {organization: {idColumn: 'organizationid'}, assignment: {idColumn: 'assignmentid'}, contact: {idColumn: 'contactid'}},
    tables: {organization: [{organizationid: 'one'}, {organizationid: 'two'}], assignment: [{assignmentid: 'a', organizationid: 'one', contactid: 'visitor'}, {assignmentid: 'b', organizationid: 'one', contactid: 'visitor'}, {assignmentid: 'c', organizationid: 'two', contactid: 'visitor'}]},
    permissions: [], settings: {permissionMode: 'enforce'}, simulator: {permissionSource: 'exported'}};
  return {portal: {records}, state};
}
async function metadata(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-permission-cardinality-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const xml = `<ImportExportXml><EntityRelationships>${['organization', 'contact'].map(target => `<EntityRelationship Name="assignment_${target}"><EntityRelationshipType>OneToMany</EntityRelationshipType><ReferencingEntityName>assignment</ReferencingEntityName><ReferencedEntityName>${target}</ReferencedEntityName><ReferencingAttributeName>${target}id</ReferencingAttributeName><ReferencedAttributeName>${target}id</ReferencedAttributeName></EntityRelationship>`).join('')}</EntityRelationships></ImportExportXml>`;
  await fs.writeFile(path.join(root, 'customizations.xml'), xml);
  return {root, relationships: (await importSolutionData([root])).relationships};
}
test('Solution-resolved cardinality survives native scoped DISTINCT and raw aggregate execution', async t => {
  const {relationships} = await metadata(t), {portal, state} = fixture();
  const model = buildPermissionModel(portal, state, {relationships});
  assert.equal(model.permissions.find(p => p.id === 'organizations').relationship.many, true);
  const store = new DataStore({state: {...state, permissions: model.permissions}});
  store.setObserved({tablePermissionQueryPipeline: 'native-classic', evidence: 'Synthetic metadata join'});
  const source='<fetch distinct="false"><entity name="organization"><attribute name="organizationid"/></entity></fetch>',identity={contactId:'visitor',roles:['Reader']};
  const native=store.fetchXml(source,identity,{portalRequest:true});
  assert.equal(native.entities.length,2);
  assert.equal(native.permissionQuery.permissionLinkCount,1);
  assert.deepEqual(store.fetchXml('<fetch aggregate="true" distinct="false"><entity name="organization"><attribute name="organizationid" aggregate="count" alias="total"/></entity></fetch>',identity,{portalRequest:true}).entities,[{total:3}]);
  store.setObserved(null);
  const result = store.fetchXml(source,identity,{portalRequest:true});
  assert.equal(result.entities.length, 3);
  assert.equal(store.previewPermissionFetchXml('<fetch><entity name="organization"/></fetch>', {contactId: 'visitor', roles: ['Reader']}).multiplicativePaths.length, 1);
  const diagnostic = result.permissionQuery.diagnostics.find(d => d.code === 'PERMISSION_QUERY_ROW_MULTIPLICATION');
  assert.equal(diagnostic.returnedRows, 3);
  assert.equal(diagnostic.uniqueRootRows, 2);
  const reverse = resolveScopedRelationship(relationships.assignment_organization, {entity: 'assignment'}, 'organization', state.mappings);
  assert.equal(reverse.descriptor.many === true, false);
});
test('runtime loading an existing state recompiles stale metadata cardinality', async t => {
  const {root, relationships} = await metadata(t), {portal, state} = fixture();
  const sourceDir = path.join(root, 'portal'); await fs.mkdir(sourceDir);
  await fs.writeFile(path.join(sourceDir, 'website.yml'), 'adx_websiteid: synthetic\nadx_name: Synthetic\n');
  await fs.writeFile(path.join(sourceDir, 'Reader.webrole.yml'), 'adx_webroleid: reader\nadx_name: Reader\n');
  for (const record of portal.records.filter(r => r.kind === 'tablepermission')) {
    await fs.writeFile(path.join(sourceDir, `${record.id}.tablepermission.yml`), `adx_entitypermissionid: ${record.id}\n` + Object.entries(record).filter(([key]) => key.startsWith('adx_')).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n'));
  }
  state.permissions = buildPermissionModel(portal, state, {relationships}).permissions;
  state.permissions.find(p => p.id === 'organizations').relationship.many = false;
  const stateFile = path.join(root, 'state.json'); await fs.writeFile(stateFile, JSON.stringify(state));
  const app = await createSimulator({sourceDir, stateFile, solutionRoots: [root], watch: false}); t.after(() => app.close());
  assert.equal(app.store.snapshot().permissions.find(p => p.id === 'organizations').relationship.many, true);
});
