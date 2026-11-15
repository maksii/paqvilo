// @test-kind contract: Paqvilo's model-driven lookup formatting and read isolation over local state
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createModelDrivenData } from '../lib/model-driven/data.mjs';
import { createModelDrivenHandler } from '../lib/model-driven/http.mjs';
import { RecordPageSession, pagedRecordsOf } from '../lib/record-tables.mjs';
import { makeTemporaryDirectory, ownedFixture } from '../testing/owned-fixture.mjs';

const itemId = '11111111-1111-4111-8111-111111111111';
const targetId = '22222222-2222-4222-8222-222222222222';
const policyId = '33333333-3333-4333-8333-333333333333';
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test('catalogue, saved-view selection and lookup formatting cannot observe metadata from a rolled-back write', async () => {
  const state = emptyState();
  state.mappings = {
    x_item: {
      entitySet: 'x_items',
      idColumn: 'x_itemid',
      fields: { name: { dataverseType: 'nvarchar' }, reference: { dataverseType: 'lookup', targets: ['x_target'] } },
    },
    x_target: { entitySet: 'x_targets', idColumn: 'x_targetid', fields: { name: { dataverseType: 'nvarchar' } } },
    x_other: { entitySet: 'x_others', idColumn: 'x_otherid', fields: { name: { dataverseType: 'nvarchar' } } },
    x_policy: { entitySet: 'x_policies', idColumn: 'x_policyid', fields: { value: { dataverseType: 'nvarchar' } } },
  };
  state.tables = {
    x_item: [{ x_itemid: itemId, name: 'Original', reference: targetId }],
    x_target: [{ x_targetid: targetId, name: 'Original target' }],
    x_other: [],
    x_policy: [{ x_policyid: policyId, value: 'Original' }],
  };
  const store = new DataStore({ state });
  const catalogue = () => {
    const value = store.tableRows('x_policy')[0].value;
    const table = (entity, idColumn) => ({
      entity,
      idColumn,
      nameColumn: 'name',
      fields: { name: { type: 'text' } },
      projected: false,
    });
    return {
      apps: [{ name: value }],
      tables: {
        x_item: {
          ...table('x_item', 'x_itemid'),
          fields: {
            name: { name: 'name', type: 'text' },
            reference: { name: 'reference', type: 'lookup', targets: [value === 'Original' ? 'x_target' : 'x_other'] },
          },
          views: [
            {
              id: 'main',
              fields: [{ name: 'name' }, { name: 'reference' }],
              fetchXml: `<fetch><entity name="x_item"><filter><condition attribute="name" operator="eq" value="${value}"/></filter></entity></fetch>`,
            },
          ],
        },
        x_target: table('x_target', 'x_targetid'),
        x_other: table('x_other', 'x_otherid'),
      },
    };
  };
  const data = createModelDrivenData({ store, catalogue, portal: () => ({}) });
  let response;
  const handler = createModelDrivenHandler({
    catalogue,
    data,
    csrf: () => 'test',
    json: (_res, status, body) => {
      response = { status, body };
    },
    read: (fn) => store.readOperation(fn),
  });
  const entered = deferred(),
    release = deferred();
  const writing = store.transact(
    async () => {
      store.updateRecord('x_policy', policyId, { value: 'Tentative' }, { admin: true });
      entered.resolve();
      await release.promise;
      throw Error('Write rolled back');
    },
    { incremental: true },
  );
  const rollback = assert.rejects(writing, /Write rolled back/);
  await entered.promise;
  let finished = false;
  const reads = Promise.all([
    data.list('x_item'),
    data.get('x_item', itemId),
    handler({ method: 'GET', headers: {} }, { setHeader() {} }, new URL('http://127.0.0.1/_apps/api')),
  ]).then((results) => {
    finished = true;
    return results;
  });
  // No event reports that a read is queued. The reads are in-memory, so one macrotask drains every microtask and
  // timer-free continuation an unblocked read would need to finish.
  await new Promise((done) => setImmediate(done));
  assert.equal(finished, false);
  assert.equal(response, undefined, 'the catalogue must wait for the pending write');
  release.resolve();
  await rollback;
  const [list, record] = await reads;
  assert.equal(response.status, 200);
  assert.equal(response.body.apps[0].name, 'Original');
  assert.deepEqual(
    list.rows.map((row) => row.name),
    ['Original'],
  );
  assert.equal(record.row['reference@OData.Community.Display.V1.FormattedValue'], 'Original target');
});

test('lookup formatting finds a target row by any spelling of its key, in canonical, loose and padded storage', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'invented-lookup-keys-')),
    owner = ownedFixture(t);
  owner.remove(() => fs.rm(root, { recursive: true, force: true }));
  const session = new RecordPageSession(root);
  owner.add(() => session.close());
  const guid = '3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f',
    other = '7d1e2f3a-4b5c-4d6e-8f70-123456789abc',
    spellings = [guid, guid.toUpperCase(), `{${guid}}`, ` ${guid} `],
    // Upper-case and braced GUIDs normalise to the index form, so only the padded table is loose.
    storage = {
      canonical: { keys: [guid, other], loose: false },
      upperCase: { keys: [guid.toUpperCase(), other], loose: false },
      braced: { keys: [`{${guid}}`, other], loose: false },
      padded: { keys: [` ${guid} `, other], loose: true },
    };
  const catalogue = () => ({
    apps: [],
    tables: {
      x_item: {
        entity: 'x_item',
        idColumn: 'x_itemid',
        nameColumn: 'name',
        projected: false,
        fields: {
          name: { name: 'name', type: 'text' },
          reference: { name: 'reference', type: 'lookup', targets: ['x_target'] },
        },
        views: [],
      },
      x_target: {
        entity: 'x_target',
        idColumn: 'x_targetid',
        nameColumn: 'name',
        projected: false,
        fields: { name: { name: 'name', type: 'text' } },
        views: [],
      },
    },
  });
  // Target rows are paged with their primary key index, so the indexed path answers lookups unless the keys are loose.
  const formatted = async (keys) => {
    const state = emptyState();
    state.mappings = {
      x_item: {
        entitySet: 'x_items',
        idColumn: 'x_itemid',
        fields: { name: { dataverseType: 'nvarchar' }, reference: { dataverseType: 'lookup', targets: ['x_target'] } },
      },
      x_target: { entitySet: 'x_targets', idColumn: 'x_targetid', fields: { name: { dataverseType: 'nvarchar' } } },
    };
    state.tables = {
      x_item: spellings.map((reference, index) => ({ x_itemid: `item-${index}`, name: `Item ${index}`, reference })),
      x_target: session.from(
        keys.map((x_targetid, index) => ({ x_targetid, name: index === 0 ? 'Target' : 'Other target' })),
        { primaryKey: 'x_targetid' },
      ),
    };
    const store = new DataStore({ state });
    const data = createModelDrivenData({ store, catalogue, portal: () => ({}) });
    const names = [];
    for (let index = 0; index < spellings.length; index++) {
      const record = await data.get('x_item', `item-${index}`);
      names.push(record.row['reference@OData.Community.Display.V1.FormattedValue']);
    }
    return { names, loose: pagedRecordsOf(store.state.tables.x_target).looseBraceKeys };
  };
  const canonical = await formatted(storage.canonical.keys);
  assert.equal(canonical.loose, false);
  assert.deepEqual(canonical.names, ['Target', 'Target', 'Target', 'Target']);
  for (const [name, { keys, loose }] of Object.entries(storage)) {
    const result = await formatted(keys);
    assert.equal(result.loose, loose, `${name} storage flags its loose keys`);
    assert.deepEqual(result.names, canonical.names, `${name} storage answers like canonical storage`);
  }
});
