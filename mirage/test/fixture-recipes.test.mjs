import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixtureRecipes } from '../testing.mjs';
import { DataStore } from '../api.mjs';

test('named recreation coordinates state, IDs, clock and scheduled outcomes without rewinding another runtime', async (t) => {
  const definitions = {
    baseline: {
      epochMs: Date.UTC(2026, 0, 1),
      state: {
        mappings: { x_item: { idColumn: 'x_itemid', entitySet: 'x_items' } },
        tables: { x_item: [] },
        settings: { permissionMode: 'permissive' },
      },
    },
  };
  const before = structuredClone(definitions),
    recipes = createFixtureRecipes(definitions);
  definitions.baseline.state.tables.x_item.push({ x_itemid: 'not in captured recipe' });
  const replay = async () => {
    const fixture = recipes.create('baseline');
    t.after(() => fixture.scheduler.close());
    assert.equal(fixture.scheduler.status().pending, 0);
    const store = await new DataStore(fixture).init();
    const created = await store.transact(() => store.createRecord('x_item', { x_name: 'Synthetic' }));
    fixture.scheduler.schedule(
      () => store.transact(() => store.updateRecord('x_item', created.x_itemid, { x_name: 'After schedule' })),
      { delay: 10, name: 'synthetic update' },
    );
    await fixture.scheduler.advance(10);
    const result = {
      rows: structuredClone(store.tableRows('x_item')),
      now: fixture.clock.now(),
      next: fixture.ids.uuid(),
    };
    fixture.scheduler.close();
    return result;
  };
  assert.deepEqual(await replay(), await replay());
  const a = recipes.create('baseline'),
    b = recipes.create('baseline');
  t.after(() => a.scheduler.close());
  t.after(() => b.scheduler.close());
  a.scheduler.schedule(() => a.state.tables.x_item.push({ x_name: 'must not run in b' }), { delay: 100 });
  a.clock.advance(50);
  a.ids.uuid();
  assert.equal(b.clock.now(), before.baseline.epochMs);
  assert.equal(b.scheduler.status().pending, 0);
  assert.deepEqual(b.state.tables.x_item, []);
  assert.deepEqual(recipes.names(), ['baseline']);
});
test('recipe definitions reject active callbacks and malformed names/times/namespaces', () => {
  assert.throws(() => createFixtureRecipes({ baseline: { state: { callback() {} } } }), /cloneable/);
  assert.throws(() => createFixtureRecipes({ baseline: { state: {}, epochMs: NaN } }), /finite/);
  assert.throws(() => createFixtureRecipes({ baseline: { state: {}, namespace: 'not a GUID' } }), /namespace|GUID/i);
  assert.throws(() => createFixtureRecipes(JSON.parse('{"__proto__":{"state":{}}}')), /valid name/);
  assert.throws(() => createFixtureRecipes({ baseline: { state: {} } }).create('absent'), /Unknown/);
});

test('shared memory is rejected while ordinary buffer copies stay independent', () => {
  const shared = new SharedArrayBuffer(4);
  for (const probe of [shared, new Uint8Array(shared), new Map([['shared', shared]])])
    assert.throws(() => createFixtureRecipes({ baseline: { state: { probe } } }), /shared-memory/);
  const original = new Uint8Array(4),
    recipes = createFixtureRecipes({ baseline: { state: { probe: original } } });
  original[0] = 9;
  const a = recipes.create('baseline'),
    b = recipes.create('baseline');
  a.state.probe[1] = 7;
  assert.deepEqual([...b.state.probe], [0, 0, 0, 0]);
  a.scheduler.close();
  b.scheduler.close();
});

test('non-enumerable cloned Error causes cannot hide shared memory across recreated fixtures', () => {
  const shared = new SharedArrayBuffer(4);
  for (const memory of [shared, new Uint8Array(shared)]) {
    const failure = new Error('Synthetic failure', { cause: { memory } });
    assert.equal(Object.keys(structuredClone(failure)).length, 0);
    for (const state of [{ failure }, { failures: new Map([['failure', failure]]) }])
      assert.throws(() => createFixtureRecipes({ baseline: { state } }), /shared-memory/);
  }
  const memory = new Uint8Array(4),
    recipes = createFixtureRecipes({
      baseline: { state: { failure: new Error('Synthetic failure', { cause: { memory } }) } },
    }),
    a = recipes.create('baseline'),
    b = recipes.create('baseline');
  memory[0] = 5;
  a.state.failure.cause.memory[1] = 7;
  assert.deepEqual([...b.state.failure.cause.memory], [0, 0, 0, 0]);
  assert.deepEqual([...memory], [5, 0, 0, 0]);
  a.scheduler.close();
  b.scheduler.close();
});

test('shared WebAssembly memory cannot hide shared bytes behind a cloneable native object', () => {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  assert.equal(structuredClone(memory).buffer instanceof SharedArrayBuffer, true);
  for (const state of [{ memory }, { nested: new Map([['memory', memory]]) }])
    assert.throws(() => createFixtureRecipes({ baseline: { state } }), /shared-memory/);
});
