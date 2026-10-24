import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore } from '../lib/data.mjs';

const identity = { contactId: 'visitor', roles: ['Member'] };
const reference = (id) => ({ id, logical_name: 'businessunit' });
function fixture() {
  return new DataStore({
    state: {
      mappings: {
        exa_item: {
          entitySet: 'exa_items',
          idColumn: 'exa_itemid',
          relationships: {
            owningbusinessunit: {
              entity: 'businessunit',
              from: 'owningbusinessunit',
              to: 'businessunitid',
              many: false,
            },
          },
        },
        businessunit: { entitySet: 'businessunits', idColumn: 'businessunitid' },
      },
      tables: { exa_item: [], businessunit: [{ businessunitid: 'runtime-unit' }, { businessunitid: 'other-unit' }] },
      permissions: [{ entity: 'exa_item', roles: ['Member'], scope: 'global', operations: ['create', 'append'] }],
      settings: { permissionMode: 'enforce', associationPermissions: 'enforce' },
    },
  });
}
const options = () => ({ systemColumns: { owningbusinessunit: reference('runtime-unit') } });

test('unchanged internal ownership stamps do not require visitor appendTo privileges', async () => {
  const store = fixture();
  const row = await store.createRecordAsync('exa_item', { name: 'Owned runtime stamp' }, identity, options());
  assert.deepEqual(row.owningbusinessunit, reference('runtime-unit'));
  assert.equal(store.tableRows('exa_item').length, 1);
});

test('explicit user-supplied ownership bindings still require appendTo and roll back', async () => {
  for (const values of [
    { owningbusinessunit: reference('runtime-unit') },
    { 'owningbusinessunit@odata.bind': '/businessunits(runtime-unit)' },
  ]) {
    const store = fixture();
    await assert.rejects(
      store.transact(() => store.createRecordAsync('exa_item', values, identity, options())),
      (error) => error.status === 403,
    );
    assert.equal(store.tableRows('exa_item').length, 0);
  }
});

test('a plugin changing an internal stamp still requires visitor appendTo and rolls back', async () => {
  const store = fixture();
  store.setPluginPipeline(({ target, stage }) => {
    if (stage === 20) target.owningbusinessunit = reference('other-unit');
  });
  await assert.rejects(
    store.transact(() => store.createRecordAsync('exa_item', { name: 'Plugin changed' }, identity, options())),
    (error) => error.status === 403,
  );
  assert.equal(store.tableRows('exa_item').length, 0);
});
