// @test-kind observation: native capture 2026-11-23 (paqvilo-developer feedback-251-252-parity q2-q2-1795452185577.json): on Create through the portal /_api a lookup the request sends needs AppendTo (90040106, nothing created) and one a stage-20 plug-in sets is not checked
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

test('a lookup a stage-20 plug-in sets on create is not checked against the visitor, as the portal does not check it', async () => {
  const store = fixture();
  store.setPluginPipeline(({ target, stage }) => {
    if (stage === 20) target.owningbusinessunit = reference('other-unit');
  });
  const row = await store.transact(() =>
    store.createRecordAsync('exa_item', { name: 'Plugin set' }, identity, options()),
  );
  assert.deepEqual(row.owningbusinessunit, reference('other-unit'));
  assert.equal(store.tableRows('exa_item').length, 1);
  // The same lookup sent by the visitor is refused and nothing is created.
  const sent = fixture();
  await assert.rejects(
    sent.transact(() =>
      sent.createRecordAsync(
        'exa_item',
        { name: 'Sent', owningbusinessunit: reference('other-unit') },
        identity,
        options(),
      ),
    ),
    (error) => error.status === 403,
  );
  assert.equal(sent.tableRows('exa_item').length, 0);
});

// @test-kind observation: native capture 2026-11-23 (paqvilo-developer feedback-251-252-parity q3-* evidence): on Update through the portal /_api a client-sent lookup without AppendTo is refused (403 90040106, row unchanged), while a stage-20 plug-in that sets or changes the same lookup on a name-only PATCH succeeds (204) with the plug-in's value
test('a lookup a stage-20 plug-in sets or changes on update is not checked; the same lookup sent is refused', async () => {
  const updatable = (initial) => {
    const store = fixture();
    store.state.permissions[0].operations.push('read', 'update');
    store.state.tables.exa_item.push({ exa_itemid: 'row', name: 'Before', ...initial });
    return store;
  };
  for (const initial of [{}, { owningbusinessunit: reference('runtime-unit') }]) {
    const store = updatable(initial);
    store.setPluginPipeline(({ target, stage }) => {
      if (stage === 20) target.owningbusinessunit = reference('other-unit');
    });
    await store.transact(() => store.updateRecordAsync('exa_item', 'row', { name: 'Plugin set' }, identity));
    assert.equal(store.tableRows('exa_item')[0].name, 'Plugin set');
    assert.equal(store.tableRows('exa_item')[0].owningbusinessunit.id, 'other-unit');
  }
  const sent = updatable({});
  await assert.rejects(
    sent.transact(() =>
      sent.updateRecordAsync(
        'exa_item',
        'row',
        { name: 'Sent', owningbusinessunit: reference('other-unit') },
        identity,
      ),
    ),
    (error) => error.status === 403,
  );
  assert.equal(sent.tableRows('exa_item')[0].name, 'Before');
});
