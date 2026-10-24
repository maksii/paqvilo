import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';

function fixture() {
  const state = emptyState();
  state.simulator = {};
  state.mappings.widget = { entitySet: 'widgets', idColumn: 'widgetid' };
  state.tables.widget = [];
  return new DataStore({ state });
}
test('synchronous mutation observers update derived state before persistence and unsubscribe cleanly', async () => {
  const store = fixture(),
    seen = [];
  const stop = store.addMutationObserver(
    (event) => {
      seen.push(event.operation);
      store.state.simulator.derived = { id: event.row.widgetid, name: event.row.name };
    },
    { matches: (event) => event.entity === 'widget' },
  );
  const row = await store.create('widget', { name: 'First' }, { admin: true });
  assert.deepEqual(store.state.simulator.derived, { id: row.widgetid, name: 'First' });
  await store.update('widget', row.widgetid, { name: 'Updated' }, { admin: true });
  assert.equal(store.state.simulator.derived.name, 'Updated');
  assert.deepEqual(seen, ['create', 'update']);
  stop();
  await store.update('widget', row.widgetid, { name: 'Later' }, { admin: true });
  assert.equal(store.state.simulator.derived.name, 'Updated');
});
test('derived observer state and primary rows both roll back in incremental and isolated transactions', async () => {
  for (const options of [{ incremental: true }, { isolated: true }]) {
    const store = fixture(),
      before = store.snapshot();
    store.addMutationObserver((event) => {
      store.state.simulator.derived = { id: event.row.widgetid };
    });
    await assert.rejects(
      store.transact(() => {
        store.createRecord('widget', { name: 'Temporary' }, { admin: true });
        throw new Error('later refusal');
      }, options),
      /later refusal/,
    );
    assert.deepEqual(store.snapshot(), before);
  }
});
test('asynchronous mutation observers are rejected and thenable results roll back', async () => {
  const store = fixture(),
    before = store.snapshot();
  assert.throws(() => store.addMutationObserver(async () => {}), /synchronous/);
  store.addMutationObserver(() => Promise.reject(new Error('Invalid async observer rejection')));
  await assert.rejects(store.create('widget', { name: 'Refused' }, { admin: true }), /cannot return a promise/);
  assert.deepEqual(store.snapshot(), before);
  await new Promise((resolve) => setImmediate(resolve));
});
