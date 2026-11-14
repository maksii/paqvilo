// @test-kind contract: the SDK addresses a row by a declared alternate key whose part is a lookup, and a malformed key is a caller input fault (400), not an unsupported operation
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { localOrganizationService, sdkRecordKey } from '../lib/local-organization-service.mjs';
import { executePlatformSdkMessage } from '../lib/plugin-platform-messages.mjs';

const ROW = '10000000-0000-4000-8000-000000000001';
const PARENT = '20000000-0000-4000-8000-000000000002';
const mapping = { logicalName: 'item', entitySet: 'items', idColumn: 'itemid', nameColumn: 'name' };
const keyed = (keyAttributes) => ({ $type: 'EntityReference', logicalName: 'item', keyAttributes });
const lookupTo = (guid) => ({ $type: 'EntityReference', logicalName: 'account', id: guid });

async function fixture() {
  const state = emptyState();
  state.mappings.item = {
    ...mapping,
    alternateKeys: [{ name: 'item_parent', attributes: ['parentid'], indexStatus: 'Active' }],
  };
  state.tables.item = [
    { itemid: ROW, name: 'Invented item', parentid: { id: PARENT, logical_name: 'account', name: '' } },
  ];
  return new DataStore({ state }).init();
}

test('an alternate key part that is a lookup is sent as the referenced row id', async () => {
  const store = await fixture();
  assert.equal(sdkRecordKey(store, 'item', keyed({ parentid: lookupTo(PARENT) })), `parentid=${PARENT}`);
});

test('the emitted key finds the row whose lookup equals the referenced id through the declared alternate key', async () => {
  const store = await fixture();
  const key = sdkRecordKey(store, 'item', keyed({ parentid: lookupTo(PARENT) }));
  assert.equal(store.findByKey(store.resolveMapping('item'), key)?.itemid, ROW);
});

test('a malformed key attribute name is a 400 input fault', async () => {
  const store = await fixture();
  assert.throws(() => sdkRecordKey(store, 'item', keyed({ 'a b': 'x' })), {
    status: 400,
    code: 'InvalidKey',
    message: 'Invalid SDK key attribute.',
  });
});

test('a key part that is neither scalar nor a lookup is a 400 input fault', async () => {
  const store = await fixture();
  assert.throws(() => sdkRecordKey(store, 'item', keyed({ parentid: { nested: { deep: 1 } } })), {
    status: 400,
    code: 'InvalidKey',
    message: 'SDK key attributes require scalar values.',
  });
});

const CODE_ROW = '10000000-0000-4000-8000-000000000011';
const OTHER_ROW = '10000000-0000-4000-8000-000000000012';
const OTHER_PARENT = '20000000-0000-4000-8000-000000000003';
const USER = '30000000-0000-4000-8000-000000000003';
const GRANTS = [{ entity: 'item', operations: ['read', 'create', 'update', 'delete'] }];

async function keyedFixture() {
  const state = emptyState();
  state.mappings.item = {
    ...mapping,
    alternateKeys: [
      { name: 'item_code', attributes: ['code'], indexStatus: 'Active' },
      { name: 'item_region_code', attributes: ['region', 'code'], indexStatus: 'Active' },
      { name: 'item_parent', attributes: ['parentid'], indexStatus: 'Active' },
    ],
  };
  state.tables.item = [
    {
      itemid: CODE_ROW,
      name: 'Invented item',
      code: 'ALPHA',
      region: 'north',
      parentid: { id: PARENT, logical_name: 'account', name: '' },
    },
    {
      itemid: OTHER_ROW,
      name: 'Second item',
      code: 'BETA',
      region: 'south',
      parentid: { id: OTHER_PARENT, logical_name: 'account', name: '' },
    },
  ];
  return new DataStore({ state }).init();
}

const service = (store, grants = GRANTS) =>
  localOrganizationService(store, { userId: USER, evidence: 'invented test grants', grants }, null);
const rowById = (store, id) => store.tableRows('item').find((row) => row.itemid === id);
const failureOf = (run) => {
  try {
    run();
  } catch (error) {
    return { status: error.status, code: error.code };
  }
  return null;
};

test('service.get reads a row through a string alternate key', async () => {
  const store = await keyedFixture();
  const row = service(store).get('item', keyed({ code: 'BETA' }), { allColumns: true, columns: [] });
  assert.equal(row.itemid, OTHER_ROW);
});

test('service.get reads a row through a composite alternate key', async () => {
  const store = await keyedFixture();
  const row = service(store).get('item', keyed({ region: 'north', code: 'ALPHA' }), { allColumns: true, columns: [] });
  assert.equal(row.itemid, CODE_ROW);
});

test('service.get reads a row through a lookup alternate key', async () => {
  const store = await keyedFixture();
  const row = service(store).get('item', keyed({ parentid: lookupTo(PARENT) }), { allColumns: true, columns: [] });
  assert.equal(row.itemid, CODE_ROW);
});

test('service.update writes the row a string alternate key names', async () => {
  const store = await keyedFixture();
  service(store).update('item', keyed({ code: 'BETA' }), { name: 'Renamed by key' });
  assert.equal(rowById(store, OTHER_ROW).name, 'Renamed by key');
  assert.equal(rowById(store, CODE_ROW).name, 'Invented item');
});

test('service.update writes the row a composite alternate key names', async () => {
  const store = await keyedFixture();
  service(store).update('item', keyed({ region: 'north', code: 'ALPHA' }), { name: 'Renamed composite' });
  assert.equal(rowById(store, CODE_ROW).name, 'Renamed composite');
});

test('service.update writes the row a lookup alternate key names', async () => {
  const store = await keyedFixture();
  service(store).update('item', keyed({ parentid: lookupTo(OTHER_PARENT) }), { name: 'Renamed lookup' });
  assert.equal(rowById(store, OTHER_ROW).name, 'Renamed lookup');
});

test('service.remove deletes the row a string alternate key names', async () => {
  const store = await keyedFixture();
  service(store).remove('item', keyed({ code: 'BETA' }));
  assert.equal(rowById(store, OTHER_ROW), undefined);
  assert.equal(rowById(store, CODE_ROW).code, 'ALPHA');
});

test('service.remove deletes the row a composite alternate key names', async () => {
  const store = await keyedFixture();
  service(store).remove('item', keyed({ region: 'north', code: 'ALPHA' }));
  assert.equal(rowById(store, CODE_ROW), undefined);
});

test('service.remove deletes the row a lookup alternate key names', async () => {
  const store = await keyedFixture();
  service(store).remove('item', keyed({ parentid: lookupTo(PARENT) }));
  assert.equal(rowById(store, CODE_ROW), undefined);
});

test('an unknown alternate key value answers the same not-found fault as an unknown id', async () => {
  const store = await keyedFixture();
  const byKey = failureOf(() =>
    service(store).get('item', keyed({ code: 'MISSING' }), { allColumns: true, columns: [] }),
  );
  const byId = failureOf(() =>
    service(store).get('item', '10000000-0000-4000-8000-0000000000ff', { allColumns: true, columns: [] }),
  );
  assert.deepEqual(byKey, { status: 404, code: 'NotFound' });
  assert.deepEqual(byKey, byId);
  assert.deepEqual(
    failureOf(() => service(store).remove('item', keyed({ code: 'MISSING' }))),
    byKey,
  );
  assert.deepEqual(
    failureOf(() => service(store).update('item', keyed({ code: 'MISSING' }), { name: 'x' })),
    byKey,
  );
});

// A create whose lookup names its target by an alternate key (a record-shaped reference with keyAttributes) binds that row.
const UNKNOWN_ITEM = '10000000-0000-4000-8000-0000000000ff';
const keyedRef = (keyAttributes) => ({ logical_name: 'item', keyAttributes });
const CREATE_GRANTS = [
  { entity: 'item', operations: ['read'] },
  { entity: 'order', operations: ['create'] },
];

async function referringFixture() {
  const state = emptyState();
  state.mappings.item = {
    ...mapping,
    alternateKeys: [
      { name: 'item_code', attributes: ['code'], indexStatus: 'Active' },
      { name: 'item_region_code', attributes: ['region', 'code'], indexStatus: 'Active' },
      { name: 'item_parent', attributes: ['parentid'], indexStatus: 'Active' },
    ],
  };
  state.mappings.order = { logicalName: 'order', entitySet: 'orders', idColumn: 'orderid', nameColumn: 'name' };
  state.tables.item = [
    {
      itemid: CODE_ROW,
      name: 'Invented item',
      code: 'ALPHA',
      region: 'north',
      parentid: { id: PARENT, logical_name: 'account', name: '' },
    },
    {
      itemid: OTHER_ROW,
      name: 'Second item',
      code: 'BETA',
      region: 'south',
      parentid: { id: OTHER_PARENT, logical_name: 'account', name: '' },
    },
  ];
  state.tables.order = [];
  return new DataStore({ state }).init();
}

test('a create binds a lookup named by a string alternate key to the row that key names', async () => {
  const store = await referringFixture();
  service(store, CREATE_GRANTS).create('order', { name: 'Invented order', itemref: keyedRef({ code: 'BETA' }) });
  assert.equal(store.tableRows('order')[0].itemref.id, OTHER_ROW);
});

test('a create binds a lookup named by a composite alternate key to the row that key names', async () => {
  const store = await referringFixture();
  service(store, CREATE_GRANTS).create('order', {
    name: 'Invented order',
    itemref: keyedRef({ region: 'north', code: 'ALPHA' }),
  });
  assert.equal(store.tableRows('order')[0].itemref.id, CODE_ROW);
});

test('a create binds a lookup named by a lookup alternate key to the row that key names', async () => {
  const store = await referringFixture();
  service(store, CREATE_GRANTS).create('order', {
    name: 'Invented order',
    itemref: keyedRef({ parentid: lookupTo(OTHER_PARENT) }),
  });
  assert.equal(store.tableRows('order')[0].itemref.id, OTHER_ROW);
});

test('a create whose lookup names an unknown alternate key value answers the same fault as an unknown id', async () => {
  const store = await referringFixture();
  const byKey = failureOf(() =>
    service(store, CREATE_GRANTS).create('order', { name: 'Invented order', itemref: keyedRef({ code: 'MISSING' }) }),
  );
  const byId = failureOf(() =>
    service(store, CREATE_GRANTS).create('order', {
      name: 'Invented order',
      itemref: { logical_name: 'item', id: UNKNOWN_ITEM },
    }),
  );
  assert.deepEqual(byKey, { status: 404, code: 'NotFound' });
  assert.deepEqual(byKey, byId);
  assert.equal(store.tableRows('order').length, 0);
});

// The SDK Upsert by key: the platform message finds the row by its key columns, then writes it through the service's Update or Create.
test('SDK Upsert by a string alternate key updates the row it names and creates a row when no row has that key', async () => {
  const store = await keyedFixture();
  const sdk = service(store);
  const invoke = (method, [entity]) => {
    if (method === 'RetrieveMultiple') {
      const key = entity.criteria.conditions.map((c) => `${c.attributeName}='${c.values[0]}'`).join(',');
      return {
        entities: [store.findByKey(store.resolveMapping('item'), key)]
          .filter(Boolean)
          .map((row) => ({ id: row.itemid })),
      };
    }
    if (method === 'Update') return sdk.update(entity.logicalName, entity.id, entity.attributes);
    return sdk.create(entity.logicalName, entity.attributes);
  };
  const message = (code, name) =>
    executePlatformSdkMessage({
      store,
      profile: { userId: USER, evidence: 'invented test grants', grants: GRANTS },
      service: sdk,
      request: { requestName: 'Upsert' },
      parameters: { Target: { $type: 'Entity', logicalName: 'item', keyAttributes: { code }, attributes: { name } } },
      invoke,
    });
  const updated = message('BETA', 'Upserted by key');
  assert.equal(updated.results.RecordCreated, false);
  assert.equal(updated.results.Target.id, OTHER_ROW);
  assert.equal(rowById(store, OTHER_ROW).name, 'Upserted by key');
  const created = message('GAMMA', 'Created by key');
  assert.equal(created.results.RecordCreated, true);
  assert.equal(store.tableRows('item').find((row) => row.code === 'GAMMA')?.name, 'Created by key');
});

test('a row named by an alternate key is authorised exactly as the same row by its primary key', async () => {
  const store = await keyedFixture();
  const denied = service(store, []);
  const byKey = failureOf(() => denied.get('item', keyed({ code: 'BETA' }), { allColumns: true, columns: [] }));
  const byId = failureOf(() => denied.get('item', OTHER_ROW, { allColumns: true, columns: [] }));
  assert.deepEqual(byKey, { status: 403, code: 'LocalBackendPermissionDenied' });
  assert.deepEqual(byKey, byId);
});
