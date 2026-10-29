import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DataStore } from '../lib/data.mjs';
import { install as installStandard } from '../lib/dataverse-standard.mjs';

async function fixture(t, persistence) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mirage-private-init-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'state.json');
  const store = await new DataStore({
    file,
    persistence,
    unpublished: true,
    state: { tables: { widget: [{ widgetid: 'one', name: 'Original' }] } },
  }).init();
  return { file, store, before: await fs.readFile(file) };
}

test('private initialization keeps one data graph and defers nested persistence until commit', async (t) => {
  const { store, file, before } = await fixture(t);
  const rows = store.state.tables.widget;
  await store.initialize(async () => {
    assert.equal(store.isInitializing(), true);
    assert.equal(store.state.tables.widget, rows);
    await store.transact(() => {
      store.state.tables.widget[0].name = 'Changed';
    });
    await store.save();
    assert.deepEqual(await fs.readFile(file), before);
  });
  assert.equal(store.isInitializing(), false);
  assert.equal(store.state.tables.widget, rows);
  assert.equal((await new DataStore({ file }).init()).state.tables.widget[0].name, 'Changed');
  store.completeInitialization();
  assert.throws(() => store.initialize(() => {}), /unpublished/);
});

test('a reordered but unchanged private stage does not rewrite its checkpoint', async (t) => {
  const { store, file, before } = await fixture(t);
  for (const method of ['prepareCheckpoint', 'appendChanges'])
    store.storage[method] = () => {
      throw new Error('An unchanged private stage must not publish storage writes');
    };
  await store.initialize(() => {
    store.state.tables.widget[0] = { name: 'Original', widgetid: 'one' };
  });
  assert.deepEqual(await fs.readFile(file), before);
});

for (const persistenceFailure of [false, true])
  test(`failed private initialization discards its graph and preserves durable state (save=${persistenceFailure})`, async (t) => {
    const { store, file, before } = await fixture(t);
    if (persistenceFailure)
      store.storage.prepareCheckpoint = async () => {
        throw new Error('Injected save failure');
      };
    await assert.rejects(
      store.initialize(async () => {
        store.state.tables.widget[0].name = 'Uncommitted';
        await store.save();
        if (!persistenceFailure) throw new Error('Injected installer failure');
      }),
      /Injected/,
    );
    assert.deepEqual(await fs.readFile(file), before);
    assert.equal(store.initializationFailed, true);
    assert.throws(() => store.initialize(() => {}), /unpublished/);
    assert.equal((await new DataStore({ file }).init()).state.tables.widget[0].name, 'Original');
  });

test('published stores retain detached isolated transactions', async () => {
  const store = new DataStore({ state: { tables: { widget: [{ widgetid: 'one', name: 'Original' }] } } });
  const before = store.state;
  await assert.rejects(
    store.transact(
      () => {
        store.state.tables.widget[0].name = 'Uncommitted';
        throw new Error('Rejected');
      },
      { isolated: true },
    ),
    /Rejected/,
  );
  assert.equal(before.tables.widget[0].name, 'Original');
  assert.equal(store.state.tables.widget[0].name, 'Original');
  assert.throws(() => store.initialize(() => {}), /unpublished/);
});

test('a private-stage preparation failure closes initialization and preserves its checkpoint', async (t) => {
  const { store, file, before } = await fixture(t);
  store.state.invalid = store.state;
  let called = false;
  await assert.rejects(
    store.initialize(() => {
      called = true;
    }),
    /circular/,
  );
  assert.equal(called, false);
  assert.equal(store.isInitializing(), false);
  assert.equal(store.initializationFailed, true);
  assert.equal(store.inTransaction(), false);
  assert.deepEqual(await fs.readFile(file), before);
  assert.throws(() => store.initialize(() => {}), /unpublished/);
});

test('journal initialization persists only changed sections/tables and keeps all other records', async (t) => {
  const { store, file } = await fixture(t, { journalThresholdBytes: 0 });
  await store.initialize(() => {
    store.state.tables.untouched = Array.from({ length: 10000 }, (_, i) => ({
      id: String(i),
      text: 'Invented record',
    }));
    store.state.obsolete = { removed: true };
    store.state.tables.obsolete = [{ id: 'removed' }];
  });
  const rows = store.state.tables.untouched;
  const append = store.storage.appendChanges.bind(store.storage),
    observed = [];
  store.storage.prepareCheckpoint = async () => {
    throw new Error('Unexpected full checkpoint');
  };
  store.storage.appendChanges = async (entries) => {
    const operations = [...entries];
    observed.push(...operations);
    return append(operations);
  };
  await store.initialize(() => {
    delete store.state.obsolete;
    delete store.state.tables.obsolete;
    store.state.settings.mode = 'Changed';
    store.state.tables.widget[0].name = 'Changed';
    store.state.tables.added = [{ id: 'new', text: 'Inserted' }];
  });
  assert.equal(store.state.tables.untouched, rows);
  assert.ok(observed.some((entry) => entry.op === 'remove-section' && entry.key === 'obsolete'));
  assert.ok(observed.some((entry) => entry.op === 'remove-table' && entry.table === 'obsolete'));
  assert.ok(observed.some((entry) => entry.op === 'section' && entry.key === 'settings'));
  assert.ok(observed.some((entry) => entry.op === 'insert' && entry.table === 'added'));
  assert.ok(observed.every((entry) => entry.table !== 'untouched'));
  const restarted = await new DataStore({ file }).init();
  assert.deepEqual(restarted.snapshot(), store.snapshot());
  const info = await fs.stat(file, { bigint: true });
  await store.initialize(() => {
    store.state.tables.widget[0] = { name: 'Changed', widgetid: 'one' };
  });
  assert.equal((await fs.stat(file, { bigint: true })).mtimeNs, info.mtimeNs);
});

test('failed private journal publication preserves the previous committed file', async (t) => {
  const { store, file, before } = await fixture(t, { journalThresholdBytes: 0 });
  store.storage.appendChanges = async () => {
    throw new Error('Injected journal failure');
  };
  await assert.rejects(
    store.initialize(() => {
      store.state.tables.widget[0].name = 'Uncommitted';
    }),
    /Injected journal failure/,
  );
  assert.deepEqual(await fs.readFile(file), before);
  assert.equal(store.initializationFailed, true);
  assert.equal((await new DataStore({ file }).init()).state.tables.widget[0].name, 'Original');
});

test('private journal initialization cannot overwrite an external checkpoint change', async (t) => {
  const { store, file, before } = await fixture(t, { journalThresholdBytes: 0 });
  await assert.rejects(
    store.initialize(async () => {
      store.state.tables.widget[0].name = 'Uncommitted';
      await fs.writeFile(file, Buffer.concat([before, Buffer.from('external edit')]));
    }),
    { code: 'StateConflict' },
  );
  assert.deepEqual(await fs.readFile(file), Buffer.concat([before, Buffer.from('external edit')]));
  assert.equal(store.initializationFailed, true);
});

test('a private no-op stage cannot publish state after an external checkpoint change', async (t) => {
  const { store, file, before } = await fixture(t, { journalThresholdBytes: 0 });
  await assert.rejects(
    store.initialize(() => fs.writeFile(file, Buffer.concat([before, Buffer.from('external edit')]))),
    { code: 'StateConflict' },
  );
  assert.deepEqual(await fs.readFile(file), Buffer.concat([before, Buffer.from('external edit')]));
  assert.equal(store.initializationFailed, true);
});

test('standard installation avoids an unused private snapshot while public results stay detached', async () => {
  const store = new DataStore({ unpublished: true });
  const rows = new Array(100000);
  rows[0] = { id: 'one', payload: 'Invented row' };
  store.state.tables.bulk = rows;
  const payload = Object.getOwnPropertyDescriptor(rows[0], 'payload');
  Object.defineProperty(rows[0], 'payload', {
    enumerable: true,
    configurable: true,
    get() {
      throw new Error('Unnecessary complete state result');
    },
  });
  await store.initialize(() => installStandard({ store }));
  assert.equal(store.state.tables.bulk, rows);
  Object.defineProperty(rows[0], 'payload', payload);
  store.completeInitialization();
  const result = await installStandard({ store });
  assert.notEqual(result, store.state);
  assert.notEqual(result.tables.bulk[0], rows[0]);
  result.tables.bulk[0].payload = 'Detached';
  assert.equal(rows[0].payload, 'Invented row');
});

test('successive private journal stages compare against the durable receipt and retain intervening changes', async (t) => {
  const { store, file } = await fixture(t, { journalThresholdBytes: 0 });
  await store.initialize(() => {
    store.state.tables.widget[0].payload = 'Unchanged invented payload';
  });
  const stringify = JSON.stringify;
  let encoded = 0;
  try {
    JSON.stringify = (value, ...args) => {
      if (value === 'Unchanged invented payload' || value?.payload === 'Unchanged invented payload') encoded++;
      return stringify(value, ...args);
    };
    await store.initialize(() => {
      store.state.settings.mode = 'Changed';
    });
  } finally {
    JSON.stringify = stringify;
  }
  assert.equal(encoded, 1, 'The preceding committed fingerprint is reused before the next stage.');
  store.state.tables.widget[0].name = 'Changed between stages';
  await store.initialize(() => {});
  assert.equal((await new DataStore({ file }).init()).state.tables.widget[0].name, 'Changed between stages');
  await store.update('widget', 'one', { name: 'A normal intervening commit' }, { admin: true });
  await store.initialize(() => {});
  assert.equal((await new DataStore({ file }).init()).state.tables.widget[0].name, 'A normal intervening commit');
});

test('private section fingerprints distinguish omitted values, nulls and deletion', async (t) => {
  const { store, file } = await fixture(t, { journalThresholdBytes: 0 });
  await store.initialize(() => {
    store.state.optional = undefined;
  });
  await store.initialize(() => {
    store.state.optional = null;
  });
  assert.equal((await new DataStore({ file }).init()).state.optional, null);
  await store.initialize(() => {
    delete store.state.optional;
  });
  assert.equal(Object.hasOwn((await new DataStore({ file }).init()).state, 'optional'), false);
});

test('owned construction adopts a private graph while ordinary construction still detaches inputs', () => {
  const state = { tables: { widget: [{ widgetid: 'one', nested: { value: 1 } }] } };
  const ordinary = new DataStore({ state });
  assert.notEqual(ordinary.state.tables.widget, state.tables.widget);
  ordinary.state.tables.widget[0].nested.value = 2;
  assert.equal(state.tables.widget[0].nested.value, 1);
  const owned = new DataStore({ state, ownedState: true });
  assert.equal(owned.state.tables.widget, state.tables.widget);
});

test('private replacement releases superseded state roots and a failed commit preserves the durable baseline', async (t) => {
  const { store, file } = await fixture(t, { journalThresholdBytes: 0 });
  const original = store._state;
  const oldName = original.tables.widget[0].name;
  const next = structuredClone(original);
  next.tables.widget[0].name = 'Private replacement';
  const append = store.storage.appendChanges;
  store.storage.appendChanges = async () => {
    throw Error('Invented replacement append failure');
  };
  await assert.rejects(
    store.initialize(async () => {
      await store.replaceState(next, { cloneInput: false, returnSnapshot: false });
      assert.notEqual(store._state, original);
      assert.equal(store._state, store.state);
      assert.equal(store.pluginRollbackBoundary.backup, null);
    }),
    /Invented replacement append failure/,
  );
  store.storage.appendChanges = append;
  assert.equal(store.initializationFailed, true);
  assert.equal((await new DataStore({ file }).init()).state.tables.widget[0].name, oldName);
});
