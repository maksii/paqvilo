import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore } from '../lib/data.mjs';
import { buildPermissionModel, resolvePortalIdentity } from '../lib/permissions.mjs';
import { webApiPolicy } from '../lib/webapi-policy.mjs';
import { pageAccess } from '../lib/page-access.mjs';

// Exported-policy regressions; the native policy is not verified here.
function fixture(roles = ['writer', 'deleter']) {
  const role = name => ({ kind: 'webrole', id: name, name });
  const grant = (id, entity, scope, roleIds, flags, extra = {}) => ({
    kind: 'tablepermission', id, name: id, mspp_entitylogicalname: entity,
    mspp_scope: scope, mspp_entitypermission_webrole: roleIds, ...flags, ...extra,
  });
  const root = (id, roleId, relationship) => grant(id, 'project', 756150001, [roleId], { mspp_read: true }, { mspp_contactrelationship: relationship });
  const child = (id, entity, parent, relationship, flags) => grant(id, entity, 756150003, [], flags, { mspp_parententitypermission: parent, mspp_parentrelationship: relationship });
  const portal = { records: [role('writer'), role('deleter'),
    root('own-project', 'writer', 'project_owner'), root('review-project', 'deleter', 'project_reviewer'),
    child('own-task', 'task', 'own-project', 'task_project', { mspp_read: true, mspp_write: true }),
    child('review-task', 'task', 'review-project', 'task_project', { mspp_read: true, mspp_delete: true }),
    child('own-note', 'note', 'own-task', 'note_task', { mspp_read: true }),
    child('review-note', 'note', 'review-task', 'note_task', { mspp_read: true, mspp_delete: true }),
  ] };
  const rel = (referencingEntity, referencedEntity, referencingAttribute, referencedAttribute) => ({ type: 'one-to-many', referencingEntity, referencedEntity, referencingAttribute, referencedAttribute });
  const relationships = {
    project_owner: rel('project', 'contact', 'owner', 'contactid'),
    project_reviewer: rel('project', 'contact', 'reviewer', 'contactid'),
    task_project: rel('task', 'project', 'project', 'projectid'),
    note_task: rel('note', 'task', 'task', 'taskid'),
  };
  const state = {
    mappings: Object.fromEntries(['contact', 'project', 'task', 'note'].map(entity => [entity, { entitySet: entity + 's', idColumn: entity + 'id' }])),
    tables: {
      contact: [{ contactid: 'person' }, { contactid: 'other' }],
      project: [{ projectid: 'a', owner: 'person', reviewer: 'other' }, { projectid: 'b', owner: 'other', reviewer: 'person' }, { projectid: 'c', owner: 'other', reviewer: 'other' }],
      task: ['a', 'b', 'c'].map(key => ({ taskid: 't' + key, project: key, title: 'Task ' + key, privatevalue: 'Hidden ' + key })),
      note: ['a', 'b', 'c'].map(key => ({ noteid: 'n' + key, task: 't' + key })),
    },
    permissions: [], settings: { permissionMode: 'enforce' },
    simulator: { identity: { contactId: 'person', roleSource: 'memberships' }, contactRoles: roles.map(roleId => ({ contactId: 'person', roleId })) },
  };
  return { portal, state, relationships };
}
function compile(f) {
  const model = buildPermissionModel(f.portal, f.state, { source: 'exported', relationships: f.relationships });
  const store = new DataStore({ state: { ...f.state, permissions: model.permissions } });
  return { model, store, identity: resolvePortalIdentity(f.portal, f.state) };
}
const ids = (store, entity, identity) => store.rows(entity, identity).map(row => row[entity + 'id']).sort();
const operationIds = (store, entity, operation, identity) => store.tableRows(entity).filter(row => store.allowed(entity, operation, row, identity)).map(row => row[entity + 'id']).sort();

test('independent role grants union readable branches while update and delete retain their own hierarchy', async () => {
  const lower = compile(fixture(['writer']));
  assert.deepEqual(ids(lower.store, 'task', lower.identity), ['ta']);
  assert.deepEqual(ids(lower.store, 'note', lower.identity), ['na']);
  assert.deepEqual(operationIds(lower.store, 'task', 'update', lower.identity), ['ta']);
  assert.deepEqual(operationIds(lower.store, 'task', 'delete', lower.identity), []);
  const { store, identity } = compile(fixture());
  assert.deepEqual(ids(store, 'task', identity), ['ta', 'tb']);
  assert.deepEqual(ids(store, 'note', identity), ['na', 'nb']);
  assert.deepEqual(operationIds(store, 'task', 'update', identity), ['ta']);
  assert.deepEqual(operationIds(store, 'task', 'delete', identity), ['tb']);
  assert.deepEqual(operationIds(store, 'note', 'delete', identity), ['nb']);
  await store.update('task', 'ta', { title: 'Edited own task' }, identity);
  await assert.rejects(store.update('task', 'tb', { title: 'Unpermitted edit' }, identity), error => error.code === 'PermissionDenied');
  assert.equal(store.tableRows('task').find(row => row.taskid === 'tb').title, 'Task b');
  await store.remove('note', 'nb', identity);
  assert.deepEqual(store.tableRows('note').map(row => row.noteid).sort(), ['na', 'nc']);
  assert.deepEqual(ids(store, 'note', identity), ['na']);
});

test('inactive roles, inactive ancestors and an actual source cycle do not activate the second branch', () => {
  for (const change of [
    f => { f.portal.records.find(record => record.id === 'deleter').mspp_statecode = 1; },
    f => { f.portal.records.find(record => record.id === 'review-project').mspp_statecode = 1; },
    f => { const parent = f.portal.records.find(record => record.id === 'review-project'); parent.mspp_scope = 756150003; parent.mspp_parententitypermission = 'review-task'; parent.mspp_parentrelationship = 'project_task'; f.relationships.project_task = { type: 'one-to-many', referencingEntity: 'task', referencedEntity: 'project', referencingAttribute: 'project', referencedAttribute: 'projectid' }; },
  ]) {
    const f = fixture(); change(f);
    const { store, identity, model } = compile(f);
    assert.deepEqual(ids(store, 'task', identity), ['ta']);
    assert.deepEqual(ids(store, 'note', identity), ['na']);
    assert.deepEqual(operationIds(store, 'task', 'delete', identity), []);
    assert.deepEqual(model.permissions.filter(rule => rule.enabled !== false && rule.id.startsWith('review-')).map(rule => rule.id), []);
  }
});

test('split source Append and target Append To roles bind an ordinary owned lookup without granting target Read', async () => {
  const original = {
    mappings: { item: { entitySet: 'items', idColumn: 'itemid', relationships: { parent: { entity: 'folder', from: 'folderid', to: 'folderid', many: false } } }, folder: { entitySet: 'folders', idColumn: 'folderid' } },
    tables: { item: [{ itemid: 'item', name: 'Item', folderid: 'before' }], folder: [{ folderid: 'before' }, { folderid: 'after' }] },
    settings: { permissionMode: 'enforce', associationPermissions: 'enforce' },
    permissions: [{ id: 'source', entity: 'item', scope: 'global', roles: ['Writer'], operations: ['update', 'append'] }, { id: 'target', entity: 'folder', scope: 'global', roles: ['Binder'], operations: ['appendTo'] }],
  };
  const identity = { contactId: 'person', roles: ['Writer', 'Binder'] };
  const store = new DataStore({ state: original });
  assert.deepEqual(ids(store, 'folder', identity), []);
  await store.update('item', 'item', { 'parent@odata.bind': '/folders(after)' }, identity);
  assert.deepEqual(store.tableRows('item')[0].folderid, { id: 'after', logical_name: 'folder', name: '' });
  const withoutTarget = new DataStore({ state: original });
  await assert.rejects(withoutTarget.update('item', 'item', { 'parent@odata.bind': '/folders(after)' }, { contactId: 'person', roles: ['Writer'] }), error => error.code === 'PermissionDenied');
  assert.equal(withoutTarget.tableRows('item')[0].folderid, 'before');
});

test('column profile restrictions intersect readable rows and enabled fields without granting a second branch', () => {
  const { store, identity } = compile(fixture(['writer']));
  const portal = { settings: { 'Webapi/task/enabled': 'true', 'Webapi/task/fields': 'title,privatevalue' }, webApiIdentity: identity, records: [
    { kind: 'columnpermissionprofile', id: 'profile', mspp_tablename: 'task', mspp_columnpermissionprofile_webrole: ['writer'], mspp_allcolumnpermissions: [746610001] },
    { kind: 'columnpermission', id: 'hidden', mspp_columnpermissionprofileid: 'profile', mspp_columnname: 'privatevalue', mspp_permissions: [746610002] },
    { kind: 'columnpermission', id: 'title', mspp_columnpermissionprofileid: 'profile', mspp_columnname: 'title', mspp_permissions: [746610001, 746610002] },
  ] };
  const policy = webApiPolicy(portal, store, 'task');
  assert.deepEqual(store.rows('task', identity).map(row => policy.project(row)), [{ taskid: 'ta', title: 'Task a' }]);
  policy.assertWrite({ title: 'Updated' }, 'update');
  assert.throws(() => policy.assertQuery(new URLSearchParams('$select=privatevalue')), error => error.code === 'WebApiFieldNotEnabled');
  assert.throws(() => policy.assertWrite({ title: 'Created' }, 'create'), error => error.code === 'WebApiColumnPermissionDenied');
  assert.deepEqual(ids(store, 'task', identity), ['ta']);
});

test('page ancestor and child roles intersect while a documented Grant Change role takes precedence', () => {
  const portal = { pages: [{ id: 'root', url: '/', parentId: null }, { id: 'child', url: '/child/', parentId: 'root' }], records: [
    ...['reader', 'child-reader', 'editor'].map(id => ({ id, name: id, kind: 'webrole' })),
    { kind: 'webpageaccesscontrolrule', id: 'root-rule', mspp_webpageid: 'root', mspp_right: 2, mspp_scope: 1, mspp_webpageaccesscontrolrule_webrole: ['reader'] },
    { kind: 'webpageaccesscontrolrule', id: 'child-rule', mspp_webpageid: 'child', mspp_right: 2, mspp_scope: 1, mspp_webpageaccesscontrolrule_webrole: ['child-reader'] },
    { kind: 'webpageaccesscontrolrule', id: 'edit-rule', mspp_webpageid: 'root', mspp_right: 1, mspp_scope: 1, mspp_webpageaccesscontrolrule_webrole: ['editor'] },
  ] };
  const person = roleIds => ({ contactId: 'person', roleSource: 'memberships', roleIds });
  const visible = identity => portal.pages.filter(page => pageAccess(portal, page, identity).allowed).map(page => page.id).sort();
  assert.deepEqual(visible(person(['reader'])), ['root']);
  assert.deepEqual(visible(person(['child-reader'])), []);
  assert.deepEqual(visible(person(['reader', 'child-reader'])), ['child', 'root']);
  assert.deepEqual(visible(person(['editor'])), ['child', 'root']);
  portal.records.find(record => record.id === 'child-rule').mspp_statecode = 1;
  assert.deepEqual(visible(person(['reader'])), ['child', 'root']);
});
