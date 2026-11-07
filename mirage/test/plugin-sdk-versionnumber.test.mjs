// @test-kind parity: native and native-r2 recorder corpora (crud, bulk, reads, async pq.r.0.40.1): no plug-in SDK entity carries a versionnumber attribute; Entity.RowVersion carries the version
// The row version reaches a plug-in only as Entity.RowVersion. Invented tables and identities only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { createOrganizationBackend } from '../lib/organization-backend.mjs';
import { pluginCatalogue } from '../lib/exported-plugins.mjs';
import { recordToSdkEntity, recordToSdkReadEntity } from '../lib/plugin-clr.mjs';
import { DataStore, emptyState } from '../lib/data.mjs';

const id = '20000000-0000-0000-0000-0000000000d1';

function versionStore() {
  const state = emptyState();
  state.mappings.x_item = {
    logicalName: 'x_item',
    idColumn: 'x_itemid',
    sdkRowVersionColumn: 'versionnumber',
    fields: { x_name: { dataverseType: 'nvarchar' } },
  };
  state.tables.x_item = [{ x_itemid: id, x_name: 'Invented', versionnumber: 794 }];
  const store = new DataStore({ state });
  store.platformFields = () => ({ versionnumber: { dataverseType: 'bigint' } });
  return store;
}

// @test-kind parity: native recorder corpus crud and bulk Targets and images, reads (Retrieve ColumnSet(true)) and async pq.r.0.40.1 attribute lists carry no versionnumber; the value is the row version
test('an SDK entity omits the versionnumber attribute for all-column, Target and image projections and keeps the RowVersion', () => {
  const store = versionStore();
  const row = store.tableRows('x_item')[0];
  for (const columns of [{ allColumns: true, target: true }, { allColumns: true, image: true }, { allColumns: true }]) {
    const entity = recordToSdkEntity(store, 'x_item', row, columns);
    assert(!Object.hasOwn(entity.attributes, 'versionnumber'), `no versionnumber for ${JSON.stringify(columns)}`);
    assert.equal(entity.rowVersion, '794');
  }
  const read = recordToSdkReadEntity(store, 'x_item', row, { allColumns: true, columns: [] });
  assert(!Object.hasOwn(read.attributes, 'versionnumber'), 'Retrieve ColumnSet(true) has no versionnumber');
  assert.equal(read.rowVersion, '794');
  assert.equal(read.attributes.x_name, 'Invented');
});

// @test-kind unproven: an SDK ColumnSet naming versionnumber was never captured natively; the attribute is kept as the current behaviour the caller asked for
test('an explicit ColumnSet naming versionnumber keeps the attribute', () => {
  const store = versionStore();
  const row = store.tableRows('x_item')[0];
  const read = recordToSdkReadEntity(store, 'x_item', row, { allColumns: false, columns: ['versionnumber'] });
  assert.deepEqual(read.attributes.versionnumber, { $type: 'Int64', value: '794' });
  assert.equal(read.rowVersion, '794');
  const explicit = recordToSdkEntity(store, 'x_item', row, { allColumns: false, columns: ['versionnumber'] });
  assert.deepEqual(explicit.attributes.versionnumber, { $type: 'Int64', value: '794' });
});

// @test-kind parity: native recorder corpus async pq.r.0.40.1 and crud Update/40 Target: the Retrieve BusinessEntity and PostOperation Targets carry no versionnumber; the row version is Entity.RowVersion
test('a Retrieve step sees the BusinessEntity without versionnumber, and an Update PostOperation Target omits it', async (t) => {
  const seen = [];
  const f = await fixture(t, (context) => {
    if (context.MessageName === 'Retrieve' && context.Stage === 40)
      seen.push({ message: 'Retrieve', business: structuredClone(context.OutputParameters?.BusinessEntity ?? null) });
    if (context.MessageName === 'Update' && context.Stage === 40)
      seen.push({ message: 'Update', target: structuredClone(context.InputParameters.Target ?? null) });
  });
  const created = await f.request('POST', '/x_items', { x_itemid: id, x_name: 'Created' });
  assert(created.status < 300, await created.text());
  const updated = await f.request('PATCH', `/x_items(${id})`, { x_name: 'Changed' }, { 'If-Match': '*' });
  assert(updated.status < 300, await updated.text());
  const update = seen.find((entry) => entry.message === 'Update');
  assert(update, 'Update stage 40 ran');
  assert(!Object.hasOwn(update.target ?? {}, 'versionnumber'), 'Update/40 Target has no versionnumber');
  const read = await f.request('GET', `/x_items(${id})`);
  assert(read.status < 300, await read.text());
  const retrieve = seen.find((entry) => entry.message === 'Retrieve');
  assert(retrieve, 'Retrieve stage 40 ran');
  assert(!Object.hasOwn(retrieve.business ?? {}, 'versionnumber'), 'Retrieve/40 BusinessEntity has no versionnumber');
});

// @test-kind compatibility: the Web API JSON response keeps @odata.etag W/"<versionnumber>" from the stored row version while a Retrieve step runs (Web API output unchanged by the SDK projection)
test('a Web API GET with a Retrieve step keeps the ETag from the stored row version', async (t) => {
  const f = await fixture(t, () => {});
  const created = await f.request('POST', '/x_items', { x_itemid: id, x_name: 'Created' });
  assert(created.status < 300, await created.text());
  const version = f.store.tableRows('x_item')[0].versionnumber;
  const read = await f.request('GET', `/x_items(${id})`);
  const text = await read.text();
  assert(read.status < 300, text);
  assert.equal(read.headers.get('etag'), `W/"${version}"`);
  assert.equal(JSON.parse(text)['@odata.etag'], `W/"${version}"`);
});

async function fixture(t, edit) {
  const f = await contractModuleFixture(t, {
    mappings: {
      x_item: {
        logicalName: 'x_item',
        entitySet: 'x_items',
        idColumn: 'x_itemid',
        fields: { x_name: { dataverseType: 'nvarchar' } },
      },
    },
    tables: { x_item: [] },
    extension: { name: 'sdk-versionnumber-probe', install: () => {} },
  });
  const steps = [
    ['Create', 10],
    ['Update', 40],
    ['Retrieve', 40],
  ].map(([message, stage], n) => ({
    id: `30000000-0000-0000-0000-0000000000d${n}`,
    enabled: true,
    entity: 'x_item',
    message,
    stage,
    rank: 1,
    mode: 0,
    supportedDeployment: 0,
    filteringAttributes: [],
    images: [],
    typeName: 'Invented.Recorder',
    assemblyId: 'invented',
  }));
  const handlers = new Map([['Invented.Recorder', ({ context }) => edit(context)]]);
  const items = pluginCatalogue({ plugins: { steps }, handlers });
  const backend = await createOrganizationBackend({ store: f.store, items: () => items, handlers });
  t.after(() => backend.close());
  return { ...f, backend };
}
