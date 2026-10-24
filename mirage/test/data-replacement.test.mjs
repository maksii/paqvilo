import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';

const fixture = () => {
  const state = emptyState();
  state.mappings.widget = { idColumn: 'widgetid', entitySet: 'widgets' };
  state.tables.widget = [{ widgetid: 'invented', name: 'Before' }];
  return new DataStore({ state });
};

test('replacement default results and inputs remain detached; runtime callers may omit the unused snapshot', async () => {
  const store = fixture(),
    candidate = store.snapshot();
  candidate.tables.widget[0].name = 'After';
  const result = await store.replaceState(candidate);
  candidate.tables.widget[0].name = 'Changed caller input';
  result.tables.widget[0].name = 'Changed caller result';
  assert.equal(store.state.tables.widget[0].name, 'After');
  const replacement = store.snapshot();
  replacement.tables.widget[0].name = 'Runtime composition';
  let snapshots = 0;
  const snapshot = store.snapshot.bind(store);
  store.snapshot = (...args) => {
    snapshots++;
    return snapshot(...args);
  };
  assert.equal(await store.replaceState(replacement, { returnSnapshot: false }), undefined);
  replacement.tables.widget[0].name = 'Changed runtime input';
  assert.equal(store.state.tables.widget[0].name, 'Runtime composition');
  assert.equal(snapshots, 0, 'omitting a result must not allocate a discarded state snapshot');
});

test('replacement without a result retains revision conflict, validation and persistence rollback', async () => {
  const store = fixture(),
    before = store.snapshot(),
    revision = store.revision;
  await assert.rejects(
    store.replaceState(before, { expectedRevision: revision + 1, returnSnapshot: false }),
    (error) => error.code === 'StateConflict',
  );
  assert.deepEqual(store.snapshot(), before);
  assert.equal(store.revision, revision);
  await assert.rejects(
    store.replaceState({ ...before, tables: { widget: [null] } }, { returnSnapshot: false }),
    /Invalid row/,
  );
  assert.deepEqual(store.snapshot(), before);
  const replacement = store.snapshot();
  replacement.tables.widget[0].name = 'Failed replacement';
  store.save = async () => {
    throw Object.assign(new Error('Invented persistence failure'), { persistenceFailure: true });
  };
  await assert.rejects(store.replaceState(replacement, { returnSnapshot: false }), /Invented persistence failure/);
  assert.deepEqual(store.snapshot(), before);
  assert.equal(store.revision, revision);
});
