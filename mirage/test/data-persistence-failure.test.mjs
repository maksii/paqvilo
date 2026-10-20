import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DataStore, emptyState } from '../lib/data.mjs';

for (const isolated of [false, true]) test(`legacy persistence failure does not retry an elastic commit or publish events (isolated=${isolated})`, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mirage-elastic-save-fault-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'state.json'), state = emptyState();
  const id = '11111111-1111-4111-8111-111111111111';
  state.mappings.x_item = { entitySet: 'x_items', idColumn: 'x_itemid', tableType: 'Elastic' };
  state.tables.x_item = [{ x_itemid: id, partitionid: 'invented-partition', name: 'Before' }];
  const store = await new DataStore({ file, state }).init(); await store.save();
  const before = store.snapshot(), bytes = await fs.readFile(file), revision = store.revision;
  const prepare = store.storage.prepareCheckpoint.bind(store.storage);
  let publications = 0, events = 0;
  store.storage.prepareCheckpoint = async (...args) => {
    if (++publications === 1) throw Object.assign(new Error('Invented transient checkpoint failure'), { code: 'EIO' });
    return prepare(...args);
  };
  store.addCommittedEvents(() => events++);
  const update = name => store.transact(() => {
    const row = store.state.tables.x_item[0]; row.name = name;
    store.recordCommittedEvent('x_item', 'update', row, ['name']);
    store.checkpointElastic({ ...store.state.mappings.x_item, logicalName: 'x_item' }, row);
  }, { isolated });
  await assert.rejects(update('Must not commit'), { code: 'EIO', persistenceFailure: true });
  await store.flushCommittedEvents();
  assert.equal(publications, 1, 'a persistence failure must not enter independent elastic retention');
  assert.equal(events, 0); assert.equal(store.revision, revision);
  assert.deepEqual(store.snapshot(), before); assert.deepEqual(await fs.readFile(file), bytes);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['state.json']);
  await update('Explicit retry'); await store.flushCommittedEvents();
  assert.equal(publications, 2); assert.equal(events, 1);
  assert.equal(store.tableRows('x_item')[0].name, 'Explicit retry');
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).tables.x_item[0].name, 'Explicit retry');
});
