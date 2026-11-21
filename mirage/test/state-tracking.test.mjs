// @test-kind contract: Paqvilo's own transaction design (docs: DataStore#transact, state-tracking.mjs): a tracked or journaled transaction backs up only the tables and mappings it reaches; the whole-copy transaction and a plain-object model are the oracles
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DataStore, emptyState } from '../lib/data.mjs';
import { StateTracker, stateTrackingChecks, untracked, untrackedEntries } from '../lib/state-tracking.mjs';
import { cloneStateData } from '../lib/state-clone.mjs';
import { privateRecordEqual } from '../lib/record-clone.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const plain = (value) => structuredClone(value);
const descriptorKinds = (container) =>
  Object.keys(container).map((name) => (Object.getOwnPropertyDescriptor(container, name).get ? 'accessor' : 'data'));

// Every tracker in this file also keeps whole copies and compares them when it is released (stateTrackingChecks).
test.before(() => {
  stateTrackingChecks.verify = true;
});
test.after(() => {
  stateTrackingChecks.verify = false;
});

function trackerOf(state) {
  const copies = [];
  const tracker = StateTracker.install(state, {
    clone: (value) => cloneStateData(value, { forkTables: true }),
    equal: privateRecordEqual,
    count: (kind, value) => copies.push([kind, Array.isArray(value) ? value.length : null]),
  });
  return { tracker, copies };
}

test('a backup copies a member when it is first handed out, shares the others, and restores the state it opened on', () => {
  const state = {
    version: 1,
    mappings: { a: { idColumn: 'aid' }, b: { idColumn: 'bid' } },
    tables: { a: [{ aid: 1, name: 'one' }], b: [{ bid: 1 }, { bid: 2 }], c: [] },
    settings: { mode: 'x' },
  };
  const before = plain(state),
    untouched = state.tables.b,
    { tracker, copies } = trackerOf(state);
  assert.deepEqual(descriptorKinds(state.tables), ['accessor', 'accessor', 'accessor']);
  const backup = tracker.backup();
  assert.deepEqual(copies, [], 'opening a backup copies nothing that was not handed out');

  state.tables.a[0].name = 'changed';
  state.tables.a.push({ aid: 2, name: 'two' });
  void state.tables.a; // a second handout copies nothing
  assert.deepEqual(copies, [['tables', 1]]);
  state.mappings.a.idColumn = 'changed';
  state.settings.mode = 'changed';
  state.tables.d = [{ did: 1 }];
  delete state.tables.c;
  assert.equal(backup.equals(state), false);

  const restored = backup.restore();
  assert.deepEqual(restored, before);
  assert.deepEqual(Object.keys(restored.tables), ['a', 'b', 'c']);
  assert.equal(restored.tables.b, untouched, 'a table never handed out is shared, not copied');
  assert.notEqual(restored.tables.a, state.tables.a);
  assert.deepEqual(backup.restore(), before, 'a backup restores more than once');
  assert.deepEqual(copies, [
    ['tables', 1],
    ['mappings', null],
  ]);

  tracker.release();
  assert.deepEqual(descriptorKinds(state.tables), ['data', 'data', 'data']);
  assert.deepEqual(descriptorKinds(state.mappings), ['data', 'data']);
  assert.deepEqual(backup.restore(), before, 'a backup stays restorable after the tracking ended');
  assert.deepEqual(plain(state.tables), {
    a: [
      { aid: 1, name: 'changed' },
      { aid: 2, name: 'two' },
    ],
    b: before.tables.b,
    d: [{ did: 1 }],
  });
});

test('a backup opened after a member was handed out copies it at once, as a reference to it may be held', () => {
  const state = { mappings: {}, tables: { a: [{ aid: 1 }], b: [{ bid: 1 }] } },
    { tracker, copies } = trackerOf(state);
  const held = state.tables.a;
  held.push({ aid: 2 });
  const backup = tracker.backup();
  assert.deepEqual(copies, [['tables', 2]]);
  held.push({ aid: 3 }); // through the held reference: no handout
  assert.deepEqual(backup.restore().tables, { a: [{ aid: 1 }, { aid: 2 }], b: [{ bid: 1 }] });
  assert.equal(backup.equals(state), false);
  held.pop();
  assert.equal(backup.equals(state), true);
  assert.deepEqual([...backup.changedTables(state)], []);
  held.pop();
  assert.deepEqual([...backup.changedTables(state)], ['a']);
  tracker.release();
});

test('members replaced, removed and assigned again are restored, and reading code does not hand members out', () => {
  const state = { mappings: { a: { idColumn: 'aid' } }, tables: { a: [{ aid: 1 }], b: [{ bid: 1 }], c: [{ cid: 1 }] } },
    before = plain(state),
    { tracker, copies } = trackerOf(state);
  const backup = tracker.backup();
  // Whole-graph readers: a clone, a comparison and an entry scan read every member without a handout.
  assert.deepEqual(cloneStateData(state), before);
  assert.equal(privateRecordEqual(state, before), true);
  assert.deepEqual(untracked(state.tables), before.tables);
  assert.deepEqual(untrackedEntries(state.mappings), Object.entries(before.mappings));
  assert.deepEqual(copies, []);

  state.tables.a = [{ aid: 'replaced' }];
  delete state.tables.b;
  state.tables.b = [{ bid: 'assigned again' }];
  delete state.tables.c;
  state.tables.c = plain(before.tables.c); // the same content under a new array
  assert.deepEqual([...backup.changedTables(state)].sort(), ['a', 'b']);
  assert.deepEqual(backup.restore(), before);
  assert.deepEqual(backup.view(), before);
  const later = tracker.backup();
  assert.deepEqual(later.restore().tables, {
    a: [{ aid: 'replaced' }],
    b: [{ bid: 'assigned again' }],
    c: [{ cid: 1 }],
  });
  tracker.release();
  assert.deepEqual(backup.restore(), before);
});

test('a state whose containers cannot be tracked is left alone', () => {
  const tables = {};
  Object.defineProperty(tables, 'a', { enumerable: true, configurable: true, get: () => [] });
  assert.equal(trackerOf({ tables, mappings: null }).tracker, null);
  assert.equal(trackerOf({ tables: [], mappings: 'x' }).tracker, null);
});

const bigState = () => {
  const state = emptyState();
  for (const name of ['big', 'small', 'other']) {
    state.mappings[name] = {
      logicalName: name,
      entitySet: name + 's',
      idColumn: name + 'id',
      fields: { name: { type: 'string' } },
    };
    state.tables[name] = Array.from({ length: name === 'big' ? 5000 : 3 }, (_, n) => ({
      [name + 'id']: `${name}-${n}`,
      name: 'row ' + n,
    }));
  }
  return state;
};
const workDelta = async (store, run) => {
  const before = store.work;
  await run();
  const after = store.work;
  return Object.fromEntries(Object.keys(after).map((key) => [key, after[key] - before[key]]));
};

test('a tracked transaction copies the tables it reaches, never the whole state, and rolls back exactly', async () => {
  const store = new DataStore({ state: bigState() }),
    before = store.snapshot();
  const committed = await workDelta(store, () =>
    store.transact(
      () => {
        store.tableRows('small')[0].name = 'changed';
      },
      { tracked: true },
    ),
  );
  assert.deepEqual([committed.stateCopies, committed.backupRows], [0, 3]);
  assert.equal(store.tableRows('small')[0].name, 'changed');

  const failure = new Error('rolled back');
  const rolledBack = await workDelta(store, () =>
    assert.rejects(
      store.transact(
        () => {
          const rows = store.tableRows('small');
          rows.push({ smallid: 'new' });
          rows[1].name = 'gone';
          store.state.mappings.small.fields.added = { type: 'string' };
          store.state.tables.created = [{ createdid: 1 }];
          store.state.settings.permissionMode = 'permissive';
          throw failure;
        },
        { tracked: true },
      ),
      failure,
    ),
  );
  assert.deepEqual([rolledBack.stateCopies, rolledBack.backupRows], [0, 3]);
  before.tables.small[0].name = 'changed';
  assert.deepEqual(store.snapshot(), before);
});

test('a transaction that does not ask for tracking still copies the whole state, so a reference kept from before it rolls back', async () => {
  const store = new DataStore({ state: bigState() }),
    before = store.snapshot(),
    kept = store.tableRows('big')[0];
  const failure = new Error('rolled back');
  const delta = await workDelta(store, () =>
    assert.rejects(
      store.transact(() => {
        kept.name = 'changed through a reference kept from before the transaction';
        throw failure;
      }),
      failure,
    ),
  );
  assert.deepEqual([delta.stateCopies, delta.backupRows], [1, 0]);
  assert.deepEqual(store.snapshot(), before);
});

test('an independent SDK write inside a tracked transaction advances the rollback point without a whole copy', async () => {
  const store = new DataStore({ state: bigState() }),
    expected = store.snapshot();
  const failure = new Error('after the SDK write');
  const delta = await workDelta(store, () =>
    assert.rejects(
      store.transact(
        () => {
          store.tableRows('small')[0].name = 'before the SDK write';
          store.sdkMutation(() => store.insertRow('other', store.tableRows('other'), { otherid: 'sdk' }));
          store.tableRows('small')[1].name = 'after the SDK write';
          throw failure;
        },
        { tracked: true },
      ),
      failure,
    ),
  );
  assert.equal(delta.stateCopies, 0);
  assert.ok(delta.backupRows < 50, `the 5000-row table is never copied (${delta.backupRows} rows copied)`);
  expected.tables.small[0].name = 'before the SDK write';
  expected.tables.other.push({ otherid: 'sdk' });
  assert.deepEqual(store.snapshot(), expected);
});

test('an SDK write that moves the rollback point closes the backup it replaces, never the one commit uses', async () => {
  const store = new DataStore({ state: bigState() }),
    expected = store.snapshot();
  const failure = new Error('after two SDK writes');
  await assert.rejects(
    store.transact(
      () => {
        const boundary = store.pluginRollbackBoundary,
          tables = store.stateTracker.tracked.get('tables');
        store.sdkMutation(() => store.insertRow('other', store.tableRows('other'), { otherid: 'one' }));
        const first = boundary.backup;
        store.sdkMutation(() => store.insertRow('other', store.tableRows('other'), { otherid: 'two' }));
        assert.equal(tables.parts.size, 2, 'the backup commit uses and the latest rollback point');
        assert.equal(tables.parts.has(first.parts.get('tables')), false);
        assert.equal(tables.parts.has(boundary.persistenceBackup.parts.get('tables')), true);
        store.tableRows('small')[0].name = 'after the SDK writes';
        throw failure;
      },
      { tracked: true },
    ),
    failure,
  );
  expected.tables.other.push({ otherid: 'one' }, { otherid: 'two' });
  assert.deepEqual(store.snapshot(), expected);
});

test('a journaled write copies neither the tables nor the mappings it does not reach', async () => {
  const store = new DataStore({ state: bigState() });
  const delta = await workDelta(store, () =>
    store.transact(() => store.insertRow('small', store.tableRows('small'), { smallid: 'new' }), { incremental: true }),
  );
  assert.deepEqual([delta.stateCopies, delta.backupMembers, delta.backupRows], [0, 0, 0]);
  const failure = new Error('rolled back');
  const before = store.snapshot();
  await assert.rejects(
    store.transact(
      () => {
        store.insertRow('small', store.tableRows('small'), { smallid: 'lost' });
        store.state.mappings.small.fields.added = { type: 'string' };
        delete store.state.mappings.other;
        store.state.mappings.created = { idColumn: 'createdid' };
        throw failure;
      },
      { incremental: true },
    ),
    failure,
  );
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual(Object.keys(store.state.mappings), Object.keys(before.mappings), 'the mapping order is kept');
});

test('a row operation hands its table out first, so rows held from before the transaction are backed up before the write', async () => {
  const failure = new Error('rolled back');
  {
    const store = new DataStore({ state: bigState() }),
      before = store.snapshot(),
      held = store.tableRows('small');
    await assert.rejects(
      store.transact(
        () => {
          store.insertRow('small', held, { smallid: 'lost' });
          store.mutateRow('small', held, 0, { name: 'lost' });
          store.removeRow('small', held, 1);
          throw failure;
        },
        { tracked: true },
      ),
      failure,
    );
    assert.deepEqual(store.snapshot(), before);
  }
  {
    // Journaled: the SDK call promotes the journal to a backup and commits on its own; the later write is rolled back.
    const store = new DataStore({ state: bigState() }),
      expected = store.snapshot(),
      held = store.tableRows('small');
    const delta = await workDelta(store, () =>
      assert.rejects(
        store.transact(
          () => {
            store.insertRow('small', held, { smallid: 'journaled' });
            store.sdkMutation(() => store.insertRow('other', store.tableRows('other'), { otherid: 'sdk' }));
            store.mutateRow('small', held, 0, { name: 'after the SDK call' });
            throw failure;
          },
          { incremental: true },
        ),
        failure,
      ),
    );
    assert.equal(delta.stateCopies, 0, 'the promotion copies what the transaction reached, not the whole state');
    expected.tables.small.push({ smallid: 'journaled' });
    expected.tables.other.push({ otherid: 'sdk' });
    assert.deepEqual(store.snapshot(), expected);
  }
});

// A small deterministic generator (mulberry32): a failing sequence is reproduced by its seed.
const random = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const TABLES = ['t0', 't1', 't2', 't3', 't4', 't5'];
const seedState = () => {
  const state = emptyState();
  for (const [index, name] of TABLES.entries()) {
    if (index === 5) continue; // t5 starts absent
    state.mappings[name] = { logicalName: name, idColumn: name + 'id', fields: { v: { type: 'number' } } };
    state.tables[name] = Array.from({ length: index + 1 }, (_, n) => ({ [name + 'id']: n, v: n }));
  }
  return state;
};

// One generated step: a function that applies the same change to a target, { state, rowApi }. The store target reads
// the state through the store on every step (the tracked contract); the model target is a plain object.
function generateStep(next, { rowApiOnly }) {
  const pick = (list) => list[Math.floor(next() * list.length)],
    table = pick(TABLES),
    value = Math.floor(next() * 1000),
    position = next();
  const at = (rows) => Math.floor(position * rows.length);
  const kinds = [
    [
      'insert',
      ({ state, rowApi }) =>
        state.tables[table] && rowApi.insert(table, state.tables[table], { [table + 'id']: value, v: value }),
    ],
    [
      'mutate',
      ({ state, rowApi }) =>
        state.tables[table]?.length && rowApi.mutate(table, state.tables[table], at(state.tables[table]), { v: value }),
    ],
    [
      'remove',
      ({ state, rowApi }) =>
        state.tables[table]?.length && rowApi.remove(table, state.tables[table], at(state.tables[table])),
    ],
    [
      'mapping',
      ({ state }) => state.mappings[table] && (state.mappings[table].fields['f' + (value % 4)] = { type: 'x' + value }),
    ],
    [
      'mapping-drop-field',
      ({ state }) => state.mappings[table] && delete state.mappings[table].fields['f' + (value % 4)],
    ],
    ['section', ({ state }) => (state.settings['k' + (value % 3)] = value)],
    [
      'create-table',
      ({ state }) => {
        if (state.tables[table]) return;
        state.tables[table] = [];
        state.mappings[table] = { logicalName: table, idColumn: table + 'id', fields: {} };
      },
    ],
  ];
  if (!rowApiOnly)
    kinds.push(
      [
        'edit-in-place',
        ({ state }) => state.tables[table]?.length && (state.tables[table][at(state.tables[table])].v = value),
      ],
      ['push', ({ state }) => state.tables[table]?.push({ [table + 'id']: value, v: value })],
      ['splice', ({ state }) => state.tables[table]?.length && state.tables[table].splice(at(state.tables[table]), 1)],
      [
        'replace-table',
        ({ state }) =>
          state.tables[table] && (state.tables[table] = state.tables[table].map((row) => ({ ...row, v: value }))),
      ],
      [
        'drop-table',
        ({ state }) => {
          delete state.tables[table];
          delete state.mappings[table];
        },
      ],
      ['read-all', ({ state }) => Object.values(state.tables).reduce((sum, rows) => sum + rows.length, 0)],
    );
  const [kind, apply] = pick(kinds);
  return { kind, table, apply };
}

const storeTarget = (store) => ({
  get state() {
    return store.state;
  },
  rowApi: {
    insert: (table, rows, row) => store.insertRow(table, rows, row),
    mutate: (table, rows, index, values) => store.mutateRow(table, rows, index, values),
    remove: (table, rows, index) => store.removeRow(table, rows, index),
  },
});
const modelTarget = (model) => ({
  get state() {
    return model.state;
  },
  rowApi: {
    insert: (table, rows, row) => rows.push(row),
    mutate: (table, rows, index, values) => Object.assign(rows[index], values),
    remove: (table, rows, index) => rows.splice(index, 1),
  },
});

// One generated transaction: outer steps, SDK calls (savepoints) that commit or fail, then a commit or a failure.
function generateTransaction(next, { journaled }) {
  const parts = [];
  for (let count = 1 + Math.floor(next() * 6); count > 0; count--) {
    if (next() < 0.3) {
      const steps = Array.from({ length: 1 + Math.floor(next() * 3) }, () => generateStep(next, { rowApiOnly: true }));
      parts.push({ sdk: steps, fails: next() < 0.4 });
    } else parts.push({ step: generateStep(next, { rowApiOnly: journaled }) });
  }
  return { parts, fails: next() < 0.4 };
}

const sdkFailure = new Error('the SDK call failed'),
  outerFailure = new Error('the transaction failed');

// The whole-copy model of a transaction: every backup and savepoint is a complete copy of a plain state.
function runOnModel(model, transaction) {
  const target = modelTarget(model),
    start = plain(model.state);
  let committed = null; // the state at the last SDK call that committed on its own
  for (const part of transaction.parts) {
    if (part.step) {
      part.step.apply(target);
      continue;
    }
    const savepoint = plain(model.state);
    for (const step of part.sdk) step.apply(target);
    if (part.fails) model.state = savepoint;
    else committed = plain(model.state);
  }
  if (transaction.fails) model.state = committed ?? start;
}

async function runOnStore(store, transaction, options) {
  const target = storeTarget(store);
  const run = store.transact(() => {
    for (const part of transaction.parts) {
      if (part.step) {
        part.step.apply(target);
        continue;
      }
      try {
        store.sdkMutation(() => {
          for (const step of part.sdk) step.apply(target);
          if (part.fails) throw sdkFailure;
        });
      } catch (error) {
        if (error !== sdkFailure) throw error;
      }
    }
    if (transaction.fails) throw outerFailure;
  }, options);
  if (transaction.fails) await assert.rejects(run, outerFailure);
  else await run;
}

const describeTransaction = (transaction) =>
  JSON.stringify({
    fails: transaction.fails,
    parts: transaction.parts.map((part) =>
      part.step
        ? `${part.step.kind}:${part.step.table}`
        : { sdk: part.sdk.map((step) => `${step.kind}:${step.table}`), fails: part.fails },
    ),
  });

for (const [name, options, journaled] of [
  ['tracked', { tracked: true }, false],
  ['journaled', { incremental: true }, true],
]) {
  test(`generated ${name} transactions with rollbacks and SDK savepoints leave the state the whole-copy model leaves`, async () => {
    for (let seed = 1; seed <= 40; seed++) {
      const next = random(seed * 7919),
        store = new DataStore({ state: seedState() }),
        // The transaction that copies the whole state first (no option) is the second oracle of the tracked one.
        whole = journaled ? null : new DataStore({ state: seedState() }),
        model = { state: plain(store.snapshot()) };
      let copies = 0;
      for (let round = 0; round < 12; round++) {
        const transaction = generateTransaction(next, { journaled });
        const context = `seed ${seed}, round ${round}: ${describeTransaction(transaction)}`;
        runOnModel(model, transaction);
        const before = store.work.stateCopies;
        await runOnStore(store, transaction, options);
        copies += store.work.stateCopies - before;
        assert.deepEqual(store.snapshot(), model.state, context);
        assert.deepEqual(Object.keys(store.state.tables), Object.keys(model.state.tables), context);
        assert.deepEqual(
          descriptorKinds(store.state.tables).filter((kind) => kind !== 'data'),
          [],
          context,
        );
        if (whole) {
          await runOnStore(whole, transaction, {});
          assert.deepEqual(whole.snapshot(), model.state, context);
        }
      }
      assert.equal(copies, 0, `seed ${seed}: no transaction copied the whole state`);
    }
  });
}

test('a journaled state file replays the mapping changes a transaction made, and none it rolled back', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'state-tracking-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'state.json');
  const store = await new DataStore({ file, state: seedState(), persistence: { journalThresholdBytes: 0 } }).init();
  ownedFixture(t).add(() => store.close());
  const next = random(20261116),
    model = { state: plain(store.snapshot()) },
    modes = new Set();
  store.onSave = ({ mode }) => modes.add(mode);
  for (let round = 0; round < 30; round++) {
    const transaction = generateTransaction(next, { journaled: true });
    runOnModel(model, transaction);
    await runOnStore(store, transaction, { incremental: true });
    assert.deepEqual(store.snapshot(), model.state, `round ${round}: ${describeTransaction(transaction)}`);
  }
  assert.ok(modes.has('journal'), `the commits were appended to the journal (${[...modes]})`);
  const reopened = await new DataStore({ file, persistence: { journalThresholdBytes: 0 } }).init();
  ownedFixture(t).add(() => reopened.close());
  assert.deepEqual(reopened.snapshot(), store.snapshot());
});
