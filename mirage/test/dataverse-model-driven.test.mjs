import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createPrincipals, ensureSecurityModel } from '../lib/dataverse-security.mjs';
import { createRecordHandlers, createRecordHooks } from '../lib/dataverse-records.mjs';
import { createModelDrivenRecordService } from '../lib/dataverse-model-driven.mjs';

const organizationId = '11111111-1111-4111-8111-111111111111';
const adminObjectId = '22222222-2222-4222-8222-222222222222';
const parentId = '33333333-3333-4333-8333-333333333333';

test('model-driven record service shares organization hooks, lookup validation, concurrency and rollback', async t => {
  const state = emptyState();
  state.mappings.x_item = { entitySet: 'x_items', idColumn: 'x_itemid', nameColumn: 'x_name',
    fields: { x_name: { dataverseType: 'nvarchar', required: true }, x_parentid: { dataverseType: 'lookup', targets: ['x_parent'] } },
    relationships: { x_parentid: { entity: 'x_parent', from: 'x_parentid', to: 'x_parentid', many: false } } };
  state.mappings.x_parent = { entitySet: 'x_parents', idColumn: 'x_parentid', nameColumn: 'x_name', fields: { x_name: { dataverseType: 'nvarchar' } } };
  state.tables.x_item = [];
  state.tables.x_parent = [{ x_parentid: parentId, x_name: 'Parent' }];
  const store = new DataStore({ state });
  const settings = { organizationId, users: [{ objectId: adminObjectId, upn: 'local@example.test', displayName: 'Local administrator', roles: ['System Administrator'] }] };
  await ensureSecurityModel(store, settings);
  const principals = createPrincipals(store, settings), user = principals.byObjectId(adminObjectId);
  const hooks = createRecordHooks(), events = [];
  hooks.add('beforeWrite', (context, mapping, info) => {
    events.push([mapping.logicalName, info.operation, context.identity.systemUserId]);
    if (info.data?.x_name === 'Rejected') throw Error('Organization validation rejected this name');
  });
  const records = createRecordHandlers({ store, principals, change: fn => fn(), hooks });
  t.after(() => records.close());
  const write = createModelDrivenRecordService({ store, records, principal: () => user, origin: () => 'http://127.0.0.1:5555', run: fn => store.transact(fn, { isolated: true }) });
  const created = await write({ entity: 'x_item', values: { x_name: 'Created', x_parentid: parentId } });
  assert.match(created.id, /^[a-f\d-]{36}$/i);
  const get = () => store.get('x_item', created.id, { admin: true });
  assert.equal(get().x_parentid.id, parentId);
  assert.equal(get().createdby.id, user.systemuserid);
  assert.deepEqual(events[0], ['x_item', 'create', user.systemuserid]);
  const missingParent = '44444444-4444-4444-8444-444444444444';
  await assert.rejects(write({ entity: 'x_item', values: { x_name: 'Orphan', x_parentid: missingParent } }), { status: 404, message: /x_parent With Id = 44444444-4444-4444-8444-444444444444 Does Not Exist/ });
  assert.equal(store.state.tables.x_item.some(row => row.x_name === 'Orphan'), false);
  const firstVersion = store.etag(get());
  await write({ entity: 'x_item', id: created.id, values: { x_name: 'Updated' }, etag: firstVersion });
  assert.equal(get().x_name, 'Updated');
  await assert.rejects(write({ entity: 'x_item', id: created.id, values: { x_name: 'Stale' }, etag: firstVersion }), error => error.status === 412);
  const before = store.snapshot();
  await assert.rejects(write({ entity: 'x_item', values: { x_name: 'Rejected' } }), /Organization validation/);
  assert.deepEqual(store.snapshot(), before);
  await write({ entity: 'x_item', id: created.id, remove: true, etag: store.etag(get()) });
  assert.equal(get(), null);
});
