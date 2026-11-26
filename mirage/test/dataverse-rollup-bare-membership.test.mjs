// @test-kind contract: legacy bare polymorphic lookups mark a calculated designer Count for recalculation when target membership changes
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EXTENSION } from '../lib/dataverse-rollup.mjs';
import { builtInKey, sweepExpired } from '../lib/dataverse-elastic.mjs';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { makeTemporaryDirectory, ownedFixture } from '../testing/owned-fixture.mjs';

const PARENT = 'be000000-0000-4000-8000-000000000001';
const OTHER = 'be000000-0000-4000-8000-000000000002';
const CHILD = 'be000000-0000-4000-8000-000000000003';
const ADMIN = { admin: true };
const CHILD_TABLE = 'test_child';
const DESIGNER_EXPORT = new URL(
  '../../examples/project/baseline/solution/Entities/pqvd_baselineparent/Formulas/pqvd_baselineparent-pqvd_rollup.xaml',
  import.meta.url,
);

async function designerCountFormula() {
  return (await fs.readFile(DESIGNER_EXPORT, 'utf8'))
    .replaceAll('pqvd_baselineparent_baselineitem', 'test_parent_child')
    .replaceAll('pqvd_parentid', 'test_parentid')
    .replaceAll('pqvd_baselineitem', 'test_child');
}

// A table kind outside regular local storage: an elastic (Cosmos DB) table or a virtual (provider) table.
// A mapping that declares its own fields keeps them; the elastic system columns serve the competing target.
const KINDS = {
  elastic: {
    tableType: 'Elastic',
    fields: { partitionid: { dataverseType: 'nvarchar' }, ttlinseconds: { dataverseType: 'int' } },
  },
  virtual: { isVirtual: true },
};

async function fixture(
  t,
  { collision = false, typed = false, padding = 0, file, selfTarget = false, kinds = {}, partition } = {},
) {
  const formula = await designerCountFormula();
  const kind = (table) => {
    const declared = KINDS[kinds[table]] ?? {};
    return declared.tableType === 'Elastic' ? { ...declared, alternateKeys: [builtInKey(`${table}id`)] } : declared;
  };
  const { api, request, json, store } = await contractModuleFixture(t, {
    extension: EXTENSION,
    file,
    mappings: {
      test_parent: {
        logicalName: 'test_parent',
        entitySet: 'test_parents',
        idColumn: 'test_parentid',
        ...kind('test_parent'),
        fields: {
          child_count: { dataverseType: 'int', columnMetadata: { sourceType: 2, formulaDefinition: formula } },
          second_count: { dataverseType: 'int', columnMetadata: { sourceType: 2, formulaDefinition: formula } },
        },
      },
      test_alternate: {
        logicalName: 'test_alternate',
        entitySet: 'test_alternates',
        idColumn: 'test_alternateid',
        ...kind('test_alternate'),
      },
      test_third: { logicalName: 'test_third', entitySet: 'test_thirds', idColumn: 'test_thirdid' },
      test_unrelated: { logicalName: 'test_unrelated', entitySet: 'test_unrelateds', idColumn: 'test_unrelatedid' },
      test_child: {
        logicalName: 'test_child',
        entitySet: 'test_children',
        idColumn: 'test_childid',
        ...kind('test_child'),
        fields: {
          test_parentid: {
            dataverseType: 'lookup',
            targets: ['test_parent', selfTarget ? CHILD_TABLE : 'test_alternate', 'test_third'],
          },
        },
        relationships: {
          test_parentid_parent: {
            entity: 'test_parent',
            from: 'test_parentid',
            to: 'test_parentid',
            many: false,
            schemaName: 'test_parent_child',
          },
          test_parentid_alternate: {
            entity: selfTarget ? CHILD_TABLE : 'test_alternate',
            from: 'test_parentid',
            to: selfTarget ? 'test_childid' : 'test_alternateid',
            many: false,
            schemaName: 'test_alternate_child',
            cascade: { delete: 'NoCascade' },
          },
          test_parentid_third: {
            entity: 'test_third',
            from: 'test_parentid',
            to: 'test_thirdid',
            many: false,
            schemaName: 'test_third_child',
            cascade: { delete: 'NoCascade' },
          },
        },
      },
    },
    tables: {
      test_parent: [{ test_parentid: PARENT }],
      test_alternate: collision ? [{ test_alternateid: PARENT }] : [],
      test_third: [],
      test_child: [
        ...Array.from({ length: padding }, (_, i) => ({
          test_childid: 'be000000-0000-4000-8000-' + String(i + 100).padStart(12, '0'),
          test_parentid: OTHER,
        })),
        {
          test_childid: CHILD,
          test_parentid: typed ? { id: PARENT, logical_name: 'test_parent' } : PARENT,
          ...(partition === undefined ? {} : { test_parentidpid: partition }),
        },
      ],
    },
  });

  if (file) ownedFixture(t).add(() => store.closeRecordStorage());
  const parent = () => store.tableRows('test_parent')[0];
  // The mass recalculation's mark: hosted rollups keep _state and _date when a child changes (summary-F6 DATA-04c).
  parent.stale = (column = 'child_count') => api.rollups.isStale('test_parent', PARENT, column);
  const lookup = () => store.tableRows('test_child')[0].test_parentid;
  const recalculate = async (column = 'child_count') =>
    json(
      await request(
        'GET',
        `/CalculateRollupField(Target=@target,FieldName=@field)?${new URLSearchParams({
          '@target': JSON.stringify({ '@odata.id': `test_parents(${PARENT})` }),
          '@field': `'${column}'`,
        })}`,
      ),
      200,
    );

  const addAlternate = async (id, extra = {}) =>
    json(await request('POST', '/test_alternates', { test_alternateid: id, ...extra }), 201);
  const deleteAlternate = async (id) => json(await request('DELETE', `/test_alternates(${id})`), 204);
  return { api, store, request, json, parent, lookup, recalculate, addAlternate, deleteAlternate };
}

test('creating a competing target invalidates an existing bare child reference', async (t) => {
  const { parent, lookup, recalculate, addAlternate } = await fixture(t);
  assert.equal((await recalculate()).child_count, 1);

  await addAlternate(OTHER);
  assert.equal(parent.stale(), false);

  await addAlternate(PARENT);
  assert.equal(lookup(), PARENT);
  assert.equal(parent().child_count, 1);
  assert.equal(parent.stale(), true);
  assert.equal((await recalculate()).child_count, 0);
});

test('deleting a competing target with NoCascade invalidates an ambiguous bare child reference', async (t) => {
  const { parent, lookup, recalculate, deleteAlternate } = await fixture(t, { collision: true });
  assert.equal((await recalculate()).child_count, 0);

  await deleteAlternate(PARENT);
  assert.equal(lookup(), PARENT);
  assert.equal(parent().child_count, 0);
  assert.equal(parent.stale(), true);
  assert.equal((await recalculate()).child_count, 1);
});

test('competing target membership does not invalidate a typed child reference', async (t) => {
  const { parent, lookup, recalculate, addAlternate, deleteAlternate } = await fixture(t, { typed: true });
  assert.equal((await recalculate()).child_count, 1);

  await addAlternate(PARENT);
  assert.equal(parent.stale(), false);
  await deleteAlternate(PARENT);
  assert.equal(parent.stale(), false);
  assert.deepEqual(lookup(), { id: PARENT, logical_name: 'test_parent' });
});

test('only a changing parent membership scans its source, once across two rollup columns', async (t) => {
  async function measure(padding) {
    const { store, parent, recalculate, addAlternate, deleteAlternate } = await fixture(t, { padding });
    const delta = async (write) => {
      const before = store.work.rowsVisited;
      await write();
      return store.work.rowsVisited - before;
    };
    assert.equal((await recalculate()).child_count, 1);
    assert.equal((await recalculate('second_count')).second_count, 1);
    const unrelated = await delta(() => addAlternate(OTHER));
    const create = await delta(() => addAlternate(PARENT));
    assert.equal(parent.stale(), true);
    assert.equal(parent.stale('second_count'), true);
    assert.equal((await recalculate()).child_count, 0);
    assert.equal((await recalculate('second_count')).second_count, 0);
    const remove = await delta(() => deleteAlternate(PARENT));
    assert.equal(parent.stale(), true);
    assert.equal(parent.stale('second_count'), true);
    return { unrelated, create, remove };
  }

  const small = await measure(4);
  const large = await measure(132);
  assert.equal(large.unrelated, small.unrelated);
  assert.equal(large.create - small.create, 128);
  assert.equal(large.remove - small.remove, 128);
});

test('ambiguity that remains after a third target changes leaves the calculated rollup alone', async (t) => {
  const { store, request, json, parent, recalculate } = await fixture(t, { collision: true, padding: 128 });
  assert.equal((await recalculate()).child_count, 0);
  const before = store.work.rowsVisited;
  await json(await request('POST', '/test_thirds', { test_thirdid: PARENT }), 201);
  assert.equal(parent.stale(), false);
  await json(await request('DELETE', `/test_thirds(${PARENT})`), 204);
  assert.equal(parent.stale(), false);
  assert.ok(store.work.rowsVisited - before < 128);
});

test('source replacement and same-transaction plain lookup edits are read before invalidation', async (t) => {
  const { store, parent, recalculate, addAlternate, deleteAlternate } = await fixture(t, { typed: true });
  assert.equal((await recalculate()).child_count, 1);
  await addAlternate(OTHER);

  await store.transact(
    () => {
      store.state.tables[CHILD_TABLE][0].test_parentid = PARENT;
      store.createRecord('test_alternate', { test_alternateid: PARENT }, ADMIN);
      assert.equal(parent.stale(), true);
    },
    { incremental: true },
  );
  assert.equal((await recalculate()).child_count, 0);

  await store.transact(() => {
    store.state.tables[CHILD_TABLE] = [
      {
        test_childid: CHILD,
        test_parentid: { id: PARENT, logical_name: 'test_parent' },
      },
    ];
  });
  assert.equal((await recalculate()).child_count, 1);
  await deleteAlternate(PARENT);
  assert.equal(parent.stale(), false);
});

test('the stale state rolls back together with a competing target insert', async (t) => {
  const { store, parent, recalculate, addAlternate } = await fixture(t);
  assert.equal((await recalculate()).child_count, 1);
  const version = parent().versionnumber;
  await assert.rejects(
    store.transact(
      () => {
        store.createRecord('test_alternate', { test_alternateid: PARENT }, ADMIN);
        assert.equal(parent.stale(), true);
        throw new Error('invented membership rollback');
      },
      { incremental: true },
    ),
    /invented membership rollback/,
  );
  assert.equal(parent.stale(), false);
  assert.equal(parent().versionnumber, version);
  assert.equal(store.get('test_alternate', PARENT, ADMIN), null);
  await addAlternate(PARENT);
  assert.equal(parent.stale(), true);
  assert.equal(parent().versionnumber, version);
});

test('a competing row in its own child table was absent from the old contribution', async (t) => {
  const { store, parent, recalculate } = await fixture(t, { typed: true, selfTarget: true });
  assert.equal((await recalculate()).child_count, 1);
  await store.transact(
    () => {
      const rows = store.state.tables[CHILD_TABLE];
      store.insertRow(CHILD_TABLE, rows, { test_childid: PARENT, test_parentid: PARENT });
      assert.equal(parent.stale(), false);
    },
    { incremental: true },
  );
  assert.equal((await recalculate()).child_count, 1);
  await store.remove(CHILD_TABLE, PARENT, ADMIN);
  assert.equal(parent.stale(), false);
});

test('a reopened standard store uses pre-existing plain source rows without setup or migration', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'invented-rollup-bounded-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'state.json');
  const seeded = await fixture(t, { file });
  assert.equal((await seeded.recalculate()).child_count, 1);

  const reopened = await fixture(t, { file });
  assert.equal(reopened.parent.stale(), false);
  await reopened.addAlternate(PARENT);
  assert.equal(reopened.parent.stale(), true);
  assert.equal((await reopened.recalculate()).child_count, 0);
});

test('a refreshed relationship catalogue drops an alternate target removed from the source metadata', async (t) => {
  const { store, parent, recalculate, addAlternate } = await fixture(t);
  assert.equal((await recalculate()).child_count, 1);
  await addAlternate(OTHER); // Warm the catalogue with the alternate lookup.
  await store.transact(() => {
    delete store.state.mappings[CHILD_TABLE].relationships.test_parentid_alternate;
  });
  await addAlternate(PARENT);
  assert.equal(parent.stale(), false);
  assert.equal((await recalculate()).child_count, 1);
});

test('a paged local source also requires no projection before a membership transition', async (t) => {
  const { store, parent, recalculate, addAlternate } = await fixture(t);
  await store.transact(() => {
    store.state.tables[CHILD_TABLE] = store
      .ensureRecordSession()
      .from(store.state.tables[CHILD_TABLE], { primaryKey: 'test_childid' });
  });
  ownedFixture(t).add(() => store.closeRecordStorage());
  assert.equal((await recalculate()).child_count, 1);
  await addAlternate(PARENT);
  assert.equal(parent.stale(), true);
  assert.equal((await recalculate()).child_count, 0);
});

// Counts column metadata reads (the catalogue's per-table field resolution) from here on.
function countMetadataReads(t, api) {
  const metadataFields = api.metadataFields;
  const counter = { reads: 0 };
  api.metadataFields = (logical) => {
    counter.reads++;
    return metadataFields(logical);
  };
  t.after(() => {
    api.metadataFields = metadataFields;
  });
  return counter;
}

const rowId = (index) => 'be000000-0000-4000-8000-' + String(index + 1000).padStart(12, '0');

test('seeded rows outside every polymorphic lookup resolve no rollup metadata, also across commits', async (t) => {
  const { api, store, parent, recalculate, addAlternate } = await fixture(t);
  assert.equal((await recalculate()).child_count, 1);
  const counter = countMetadataReads(t, api);
  // Each seed commits on its own: every non-incremental commit moves the table revision, as bulk seeding does.
  for (let index = 0; index < 64; index++)
    await store.transact(() => {
      const rows = (store.state.tables.test_unrelated ??= []);
      store.insertRow('test_unrelated', rows, { test_unrelatedid: rowId(index) });
    });
  await store.transact(() => {
    const rows = store.state.tables.test_unrelated;
    while (rows.length) store.removeRow('test_unrelated', rows, rows.length - 1);
  });
  assert.equal(counter.reads, 0);
  assert.equal(parent.stale(), false);

  await addAlternate(PARENT);
  assert.equal(parent.stale(), true);
  assert.equal((await recalculate()).child_count, 0);
});

test('competing target inserts read the rollup metadata once per catalogue, not once per row', async (t) => {
  async function measure(count) {
    const { api, store, parent, recalculate } = await fixture(t);
    assert.equal((await recalculate()).child_count, 1);
    const counter = countMetadataReads(t, api);
    await store.transact(
      () => {
        const rows = store.state.tables.test_alternate;
        for (let index = 0; index < count; index++)
          store.insertRow('test_alternate', rows, { test_alternateid: rowId(index) });
        assert.equal(parent.stale(), false);
        store.insertRow('test_alternate', rows, { test_alternateid: PARENT });
      },
      { incremental: true },
    );
    assert.equal(parent.stale(), true);
    assert.equal((await recalculate()).child_count, 0);
    return counter.reads;
  }

  const one = await measure(1);
  const many = await measure(64);
  assert.ok(one > 0, 'The first competing target write reads the rollup columns of the polymorphic targets.');
  assert.equal(many, one);
});

const diagnosticOf = (api, code) => api.rollups.diagnostics().find((entry) => entry.code === code);

// @test-kind compatibility: Learn "Create and edit virtual tables" (virtual table columns can't be used in rollups), "Known limitations ... with virtual tables" (rollups can't be calculated for virtual tables) and "Create and edit elastic tables" (calculated and rollup columns are not supported; a lookup on an elastic table is not supported)
for (const [table, tableKind] of [
  ['test_parent', 'virtual'],
  ['test_parent', 'elastic'],
  ['test_child', 'virtual'],
  ['test_child', 'elastic'],
])
  test(`a rollup on or over a ${tableKind} ${table === 'test_parent' ? 'parent' : 'child'} table is refused with a diagnostic`, async (t) => {
    const { api, parent, recalculate } = await fixture(t, { typed: true, kinds: { [table]: tableKind } });
    assert.equal(Object.hasOwn(await recalculate(), 'child_count'), false, 'a null value is absent');
    assert.equal(parent().child_count_state, 2);
    const diagnostic = diagnosticOf(api, 'ROLLUP_UNSUPPORTED');
    assert.equal(diagnostic?.table, 'test_parent');
    assert.match(diagnostic.message, new RegExp(`${table} is an? ${tableKind} table`));
  });

test('an elastic competing target changes bare membership only in the partition the child lookup names', async (t) => {
  for (const childPartition of [undefined, 'p1']) {
    const other = childPartition === undefined ? 'p1' : undefined;
    const { parent, recalculate, addAlternate, request, json } = await fixture(t, {
      kinds: { test_alternate: 'elastic' },
      partition: childPartition,
    });
    const extra = (value) => (value === undefined ? {} : { partitionid: value });
    assert.equal((await recalculate()).child_count, 1);
    await addAlternate(PARENT, extra(other));
    assert.equal(parent.stale(), false, 'another partition holds no row the child names');
    await addAlternate(PARENT, extra(childPartition));
    assert.equal(parent.stale(), true);
    assert.equal((await recalculate()).child_count, 0);
    const key = childPartition === undefined ? PARENT : `test_alternateid=${PARENT},partitionid='${childPartition}'`;
    await json(await request('DELETE', `/test_alternates(${key})`), 204);
    assert.equal(parent.stale(), true);
    assert.equal((await recalculate()).child_count, 1);
  }
});

test('the TTL purge of an expired competing elastic target invalidates an ambiguous bare child reference', async (t) => {
  const { api, store, parent, recalculate } = await fixture(t, {
    collision: true,
    kinds: { test_alternate: 'elastic' },
  });
  assert.equal((await recalculate()).child_count, 0);
  await store.transact(() => {
    Object.assign(store.state.tables.test_alternate[0], { ttlinseconds: 1, modifiedon: '2000-01-01T00:00:00Z' });
  });
  assert.equal(await sweepExpired(api), 1);
  assert.equal(parent.stale(), true);
  assert.equal((await recalculate()).child_count, 1);
});

// @test-kind unproven: assumed that a bare GUID cannot be attributed while a candidate target's rows live outside the store (Learn: rollups need locally stored data), so membership of that table never changes a count
test('a bare child of a polymorphic lookup with a virtual target is not attributed and needs no invalidation', async (t) => {
  for (const typed of [false, true]) {
    const { api, store, parent, recalculate } = await fixture(t, { typed, kinds: { test_alternate: 'virtual' } });
    assert.equal((await recalculate()).child_count, typed ? 1 : 0);
    if (!typed) assert.equal(diagnosticOf(api, 'ROLLUP_BARE_LOOKUP_UNRESOLVED')?.table, 'test_parent');
    await store.transact(
      () => store.insertRow('test_alternate', store.state.tables.test_alternate, { test_alternateid: PARENT }),
      { incremental: true },
    );
    assert.equal(parent.stale(), false);
    assert.equal((await recalculate()).child_count, typed ? 1 : 0);
  }
});

test('a raw replacement of a competing target table invalidates exactly the changed bare memberships', async (t) => {
  const replace = (store, rows, options) =>
    store.transact(() => {
      store.state.tables.test_alternate = rows;
    }, options);
  const created = await fixture(t);
  assert.equal((await created.recalculate()).child_count, 1);
  await replace(created.store, [{ test_alternateid: OTHER }]);
  assert.equal(created.parent.stale(), false, 'an unrelated GUID changes no membership');
  await replace(created.store, [{ test_alternateid: OTHER }, { test_alternateid: PARENT }]);
  assert.equal(created.parent.stale(), true);
  assert.equal((await created.recalculate()).child_count, 0);

  const removed = await fixture(t, { collision: true });
  assert.equal((await removed.recalculate()).child_count, 0);
  await assert.rejects(
    removed.store.transact(() => {
      removed.store.state.tables.test_alternate = [];
      throw new Error('invented replacement rollback');
    }),
    /invented replacement rollback/,
  );
  assert.equal(removed.parent.stale(), false);
  await replace(removed.store, [{ test_alternateid: PARENT }, { test_alternateid: OTHER }]);
  assert.equal(removed.parent.stale(), false, 'a rolled-back replacement leaves no false membership change');
  await replace(removed.store, [{ test_alternateid: PARENT }], { isolated: true });
  assert.equal(removed.parent.stale(), false, 'OTHER leaving changes no membership of PARENT');
  await replace(removed.store, [], { isolated: true });
  assert.equal(removed.parent.stale(), true);
  assert.equal((await removed.recalculate()).child_count, 1);
  await replace(removed.store, [{ test_alternateid: PARENT }], { incremental: true });
  assert.equal(removed.parent.stale(), true);
  assert.equal((await removed.recalculate()).child_count, 0);
});

test('raw target replacements without a colliding GUID resolve no rollup metadata, also across commits', async (t) => {
  const { api, store, parent, recalculate } = await fixture(t);
  assert.equal((await recalculate()).child_count, 1);
  const counter = countMetadataReads(t, api);
  for (let index = 0; index < 64; index++)
    await store.transact(() => {
      store.state.tables.test_alternate = [{ test_alternateid: rowId(index) }];
      store.state.tables.test_unrelated = [{ test_unrelatedid: rowId(index) }];
    });
  assert.equal(counter.reads, 0);
  assert.equal(parent.stale(), false);
  await store.transact(() => {
    store.state.tables.test_alternate = [{ test_alternateid: PARENT }];
  });
  assert.equal(parent.stale(), true);
});

test('the commit check copies no untouched target table into a tracked rollback backup', async (t) => {
  const { store, parent, recalculate } = await fixture(t);
  assert.equal((await recalculate()).child_count, 1);
  await store.transact(() => {
    store.state.tables.test_alternate = Array.from({ length: 128 }, (_, index) => ({ test_alternateid: rowId(index) }));
  });
  const before = store.work.backupRows;
  await store.transact(
    () => store.insertRow('test_unrelated', (store.state.tables.test_unrelated ??= []), { test_unrelatedid: OTHER }),
    { tracked: true },
  );
  assert.ok(store.work.backupRows - before < 128, `${store.work.backupRows - before} rows copied into the backup`);
  await store.transact(
    () => {
      store.state.tables.test_alternate = [...store.state.tables.test_alternate, { test_alternateid: PARENT }];
    },
    { tracked: true },
  );
  assert.equal(parent.stale(), true, 'a replacement in a tracked transaction is still found');
});
