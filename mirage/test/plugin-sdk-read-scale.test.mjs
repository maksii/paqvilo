// @test-kind contract: a query answer converts to SDK entities by indexing each table once, not by scanning it per row
// Invented schema and rows. The read budget counts element reads of the table arrays, never elapsed time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore } from '../lib/data.mjs';
import { recordToSdkReadEntity } from '../lib/plugin-clr.mjs';

const OWNERS = 50;
const ITEMS = 2000;
const guid = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;

const schema = () => ({
  x_item: {
    entitySet: 'x_items',
    idColumn: 'x_itemid',
    sdkRowVersionColumn: 'versionnumber',
    fields: {
      x_itemid: { dataverseType: 'uniqueidentifier' },
      x_name: { dataverseType: 'nvarchar' },
      x_owner: { dataverseType: 'lookup', targets: ['x_owner'] },
      versionnumber: { dataverseType: 'bigint' },
    },
  },
  x_owner: {
    entitySet: 'x_owners',
    idColumn: 'x_ownerid',
    fields: {
      x_ownerid: { dataverseType: 'uniqueidentifier' },
      x_ownername: { dataverseType: 'nvarchar', isPrimaryName: true },
      versionnumber: { dataverseType: 'bigint' },
    },
  },
});

// A view of a table array that counts every element it reads.
function countedRows(rows, counter) {
  return new Proxy(rows, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) counter.reads += 1;
      return Reflect.get(target, key, receiver);
    },
  });
}

function readStore(state) {
  const store = new DataStore({ state: { mappings: schema(), tables: state } });
  store.platformFields = () => ({});
  const reads = new Map(),
    views = new Map(),
    tableRows = store.tableRows.bind(store);
  store.tableRows = (logical) => {
    if (!views.has(logical)) {
      const rows = tableRows(logical),
        counter = { reads: 0, length: rows.length };
      reads.set(logical, counter);
      views.set(logical, countedRows(rows, counter));
    }
    return views.get(logical);
  };
  return { store, reads };
}

test('a page of query rows converts to entities with their names and row versions', () => {
  const owners = [
    { x_ownerid: '{' + guid(1).toUpperCase() + '}', x_ownername: 'Ada', versionnumber: 7 },
    { x_ownerid: guid(2), x_ownername: 'Bo', versionnumber: 9 },
  ];
  const items = [
    { x_itemid: guid(101), x_name: 'first', x_owner: guid(2), versionnumber: 11 },
    { x_itemid: '{' + guid(102).toUpperCase() + '}', x_name: 'second', x_owner: guid(1), versionnumber: 12 },
    { x_itemid: guid(103), x_name: 'third', x_owner: null, versionnumber: 13 },
  ];
  const { store } = readStore({ x_owner: owners, x_item: items });
  const converted = {
    items: store.tableRows('x_item').map((row) => recordToSdkReadEntity(store, 'x_item', row, { allColumns: true })),
    owners: store.tableRows('x_owner').map((row) => recordToSdkReadEntity(store, 'x_owner', row, { allColumns: true })),
  };
  assert.deepEqual(converted, {
    items: [
      {
        $type: 'Entity',
        logicalName: 'x_item',
        id: guid(101),
        attributes: {
          x_itemid: { $type: 'Guid', value: guid(101) },
          x_name: 'first',
          x_owner: { $type: 'EntityReference', logicalName: 'x_owner', id: guid(2), name: 'Bo' },
        },
        rowVersion: '11',
        formattedValues: { x_owner: 'Bo' },
      },
      {
        $type: 'Entity',
        logicalName: 'x_item',
        id: '{' + guid(102).toUpperCase() + '}',
        attributes: {
          x_itemid: { $type: 'Guid', value: '{' + guid(102).toUpperCase() + '}' },
          x_name: 'second',
          x_owner: { $type: 'EntityReference', logicalName: 'x_owner', id: guid(1), name: 'Ada' },
        },
        rowVersion: '12',
        formattedValues: { x_owner: 'Ada' },
      },
      {
        $type: 'Entity',
        logicalName: 'x_item',
        id: guid(103),
        attributes: {
          x_itemid: { $type: 'Guid', value: guid(103) },
          x_name: 'third',
        },
        rowVersion: '13',
      },
    ],
    owners: [
      {
        $type: 'Entity',
        logicalName: 'x_owner',
        id: '{' + guid(1).toUpperCase() + '}',
        attributes: {
          x_ownerid: { $type: 'Guid', value: '{' + guid(1).toUpperCase() + '}' },
          x_ownername: 'Ada',
        },
        rowVersion: '7',
      },
      {
        $type: 'Entity',
        logicalName: 'x_owner',
        id: guid(2),
        attributes: {
          x_ownerid: { $type: 'Guid', value: guid(2) },
          x_ownername: 'Bo',
        },
        rowVersion: '9',
      },
    ],
  });
});

test('converting a page reads each table a bounded number of times, whatever the page size', () => {
  const owners = Array.from({ length: OWNERS }, (_, index) => ({
    x_ownerid: guid(index + 1),
    x_ownername: `Owner ${index + 1}`,
    versionnumber: 1000 + index,
  }));
  const items = Array.from({ length: ITEMS }, (_, index) => ({
    x_itemid: guid(100000 + index),
    x_name: `Item ${index}`,
    x_owner: owners[index % OWNERS].x_ownerid,
    versionnumber: 2000 + index,
  }));
  for (const pageSize of [20, 200]) {
    const { store, reads } = readStore({ x_owner: owners, x_item: items });
    // The last rows of the table: a scan per row would read most of the table for each of them.
    const page = items.slice(-pageSize);
    const entities = page.map((row) => recordToSdkReadEntity(store, 'x_item', row, { allColumns: true }));
    assert.equal(entities.length, pageSize);
    entities.forEach((entity, position) => {
      const row = page[position],
        owner = owners.find((candidate) => candidate.x_ownerid === row.x_owner);
      assert.equal(entity.rowVersion, String(row.versionnumber));
      assert.equal(entity.attributes.x_owner.name, owner.x_ownername);
    });
    for (const [logical, { reads: count, length }] of reads)
      assert.ok(count <= length + 4 * pageSize, `${pageSize} rows read ${logical} ${count} times (table of ${length})`);
  }
});
