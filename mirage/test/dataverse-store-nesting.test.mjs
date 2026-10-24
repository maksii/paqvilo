import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';

const text = { dataverseType: 'nvarchar' };

function fixture() {
  const state = emptyState();
  state.mappings.note = {
    logicalName: 'note',
    entitySet: 'notes',
    idColumn: 'noteid',
    nameColumn: 'text',
    fields: { text },
  };
  state.tables.note = [{ noteid: 'a', text: 'one' }];
  state.tables.other = [{ otherid: 'x' }];
  return new DataStore({ state });
}

const ids = (store) => store.tableRows('note').map((row) => row.noteid);

test('default transact commits once and keeps its plain behaviour', async () => {
  const store = fixture();
  const before = store.revision;
  await store.transact(() => store.state.tables.note.push({ noteid: 'b', text: 'two' }));
  assert.equal(store.revision, before + 1);
  assert.deepEqual(ids(store), ['a', 'b']);
  // Without isolated, a concurrent reader sees in-flight rows (existing behaviour).
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const pending = store.transact(async () => {
    store.state.tables.note.push({ noteid: 'c', text: 'three' });
    await gate;
  });
  await new Promise((resolve) => setImmediate(resolve));
  const seenInFlight = ids(store);
  release();
  await pending;
  assert.deepEqual(seenInFlight, ['a', 'b', 'c']);
});

test('nested transact joins the outer transaction: one commit, no extra revision', async () => {
  const store = fixture();
  const before = store.revision;
  const result = await store.transact(async () => {
    store.state.tables.note.push({ noteid: 'b', text: 'two' });
    const inner = await store.transact(
      () => {
        store.state.tables.note.push({ noteid: 'c', text: 'three' });
        return 'inner';
      },
      { nested: true },
    );
    assert.equal(store.revision, before, 'nested call must not commit');
    return inner;
  });
  assert.equal(result, 'inner');
  assert.equal(store.revision, before + 1);
  assert.deepEqual(ids(store), ['a', 'b', 'c']);
});

test('nested transact outside a transaction behaves like a normal transaction', async () => {
  const store = fixture();
  const before = store.revision;
  await store.transact(() => store.state.tables.note.push({ noteid: 'b', text: 'two' }), { nested: true });
  assert.equal(store.revision, before + 1);
  assert.deepEqual(ids(store), ['a', 'b']);
});

test('a nested throw propagates, and the outermost rollback restores the changeset only', async () => {
  const store = fixture();
  const otherBefore = JSON.stringify(store.state.tables.other);
  await assert.rejects(
    store.transact(
      async () => {
        store.state.tables.note.push({ noteid: 'b', text: 'two' });
        store.state.tables.note[0].text = 'changed';
        await store.transact(
          () => {
            store.state.tables.note.push({ noteid: 'c', text: 'three' });
            throw new Error('nested boom');
          },
          { nested: true },
        );
      },
      { isolated: true },
    ),
    /nested boom/,
  );
  assert.deepEqual(store.tableRows('note'), [{ noteid: 'a', text: 'one' }]);
  assert.equal(JSON.stringify(store.state.tables.other), otherBefore);
});

test('an isolated nested commit is invisible to a concurrent reader until the outer commit', async () => {
  const store = fixture();
  let entered;
  const inside = new Promise((resolve) => (entered = resolve));
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const outer = store.transact(
    async () => {
      store.state.tables.note.push({ noteid: 'b', text: 'two' });
      await store.transact(() => store.state.tables.note.push({ noteid: 'c', text: 'three' }), { nested: true });
      entered();
      await gate;
    },
    { isolated: true },
  );
  await inside;
  // Concurrent reader from outside the transaction's async context.
  assert.deepEqual(ids(store), ['a']);
  assert.equal(store.get('note', 'b', { admin: true }), null);
  release();
  await outer;
  assert.deepEqual(ids(store), ['a', 'b', 'c']);
  assert.equal(store.get('note', 'c', { admin: true }).text, 'three');
});

test('an isolated transaction that throws leaves the committed state untouched for concurrent readers', async () => {
  const store = fixture();
  let entered;
  const inside = new Promise((resolve) => (entered = resolve));
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const outer = store.transact(
    async () => {
      store.state.tables.note[0].text = 'changed';
      entered();
      await gate;
      throw new Error('outer boom');
    },
    { isolated: true },
  );
  await inside;
  assert.equal(store.get('note', 'a', { admin: true }).text, 'one');
  release();
  await assert.rejects(outer, /outer boom/);
  assert.deepEqual(store.tableRows('note'), [{ noteid: 'a', text: 'one' }]);
});

test('committed events fire once at the outer commit, including nested ones', async () => {
  const store = fixture();
  const delivered = [];
  store.addCommittedEvents((events) => delivered.push(events));
  await store.transact(
    async () => {
      store.recordCommittedEvent('note', 'create', { noteid: 'b' }, []);
      await store.transact(() => store.recordCommittedEvent('note', 'create', { noteid: 'c' }, []), { nested: true });
    },
    { isolated: true },
  );
  await store.flushCommittedEvents();
  assert.equal(delivered.length, 1);
  assert.deepEqual(
    delivered[0].map((event) => event.row.noteid),
    ['b', 'c'],
  );
});

test('events recorded inside a rolled-back outer transaction are never dispatched', async () => {
  const store = fixture();
  const delivered = [];
  store.addCommittedEvents((events) => delivered.push(events));
  await assert.rejects(
    store.transact(
      async () => {
        store.recordCommittedEvent('note', 'create', { noteid: 'b' }, []);
        await store.transact(() => store.recordCommittedEvent('note', 'create', { noteid: 'c' }, []), { nested: true });
        throw new Error('rollback');
      },
      { isolated: true },
    ),
    /rollback/,
  );
  await store.flushCommittedEvents();
  assert.equal(delivered.length, 0);
});

test("a committed-event consumer's nested transact after the commit is a real commit", async () => {
  const store = fixture();
  let late;
  store.addCommittedEvents(() => {
    late ??= store.transact(() => store.state.tables.note.push({ noteid: 'late', text: 'late' }), { nested: true });
  });
  await store.transact(
    () => {
      store.recordCommittedEvent('note', 'create', { noteid: 'b' }, []);
      store.state.tables.note.push({ noteid: 'b', text: 'two' });
    },
    { isolated: true },
  );
  const afterOuter = store.revision;
  await store.flushCommittedEvents();
  await late;
  assert.equal(store.revision, afterOuter + 1);
  assert.deepEqual(ids(store), ['a', 'b', 'late']);
});

test('a continuation from a finished isolated transaction reads the committed state, not its old working copy', async () => {
  const store = fixture();
  const reads = [];
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  await store.transact(
    () => {
      store.state.tables.note.push({ noteid: 'A', text: 'a' });
      (async () => {
        await gate;
        reads.push(ids(store));
      })();
    },
    { isolated: true },
  );
  await store.transact(() => store.state.tables.note.push({ noteid: 'B', text: 'b' }), { isolated: true });
  let entered;
  const inside = new Promise((resolve) => (entered = resolve));
  let finish;
  const settled = new Promise((resolve) => (finish = resolve));
  const third = store.transact(
    async () => {
      entered();
      await settled;
    },
    { isolated: true },
  );
  await inside;
  release();
  await new Promise((resolve) => setImmediate(resolve));
  finish();
  await third;
  assert.deepEqual(reads, [['a', 'A', 'B']]);
});

test('an independent plugin commit inside an isolated transaction that later fails stays uncommitted', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'store-nesting-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'state.json');
  const state = emptyState();
  state.mappings.note = {
    logicalName: 'note',
    entitySet: 'notes',
    idColumn: 'noteid',
    nameColumn: 'text',
    fields: { text },
  };
  state.tables.note = [{ noteid: 'a', text: 'one' }];
  const store = await new DataStore({ state, file }).init();
  await store.transact(() => {});
  const revision = store.revision;
  await assert.rejects(
    store.transact(
      async () => {
        store.state.tables.note.push({ noteid: 'P', text: 'pre-validation' });
        store.pluginRollbackBoundary.backup = structuredClone(store.state);
        store.pluginRollbackBoundary.independentCommit = true;
        store.state.tables.note.push({ noteid: 'M', text: 'main' });
        throw new Error('boom');
      },
      { isolated: true },
    ),
    /boom/,
  );
  assert.deepEqual(ids(store), ['a']);
  assert.equal(store.revision, revision);
  const persisted = await fs.readFile(file, 'utf8');
  assert.equal(persisted.includes('"P"'), false);
  assert.equal(persisted.includes('"M"'), false);
});

test('a plain transact inside an isolated transaction joins it instead of deadlocking', { timeout: 5000 }, async () => {
  const store = fixture();
  const before = store.revision;
  await store.transact(
    async () => {
      await store.transact(() => store.state.tables.note.push({ noteid: 'x', text: 'x' }));
      assert.equal(store.revision, before, 'joined transact must not commit');
      store.state.tables.note.push({ noteid: 'b', text: 'two' });
    },
    { isolated: true },
  );
  assert.equal(store.revision, before + 1);
  assert.deepEqual(ids(store), ['a', 'x', 'b']);
});

test('a plain transact inside an isolated transaction joins it and rolls back with the outer throw', async () => {
  const store = fixture();
  const before = store.revision;
  await assert.rejects(
    store.transact(
      async () => {
        store.state.tables.note.push({ noteid: 'b', text: 'two' });
        await store.transact(() => store.state.tables.note.push({ noteid: 'c', text: 'three' }));
        throw new Error('outer boom');
      },
      { isolated: true },
    ),
    /outer boom/,
  );
  assert.equal(store.revision, before);
  assert.deepEqual(ids(store), ['a']);
});

test('an isolated count is not leaked when the transaction fails before its body runs', async () => {
  const store = fixture();
  Object.defineProperty(store, 'committedEventCandidates', {
    configurable: true,
    get: () => undefined,
    set() {
      throw new Error('setup failed');
    },
  });
  await assert.rejects(
    store.transact(() => {}, { isolated: true }),
    /setup failed/,
  );
  assert.equal(store.isolatedCount, 0);
  delete store.committedEventCandidates;
  await store.transact(() => store.state.tables.note.push({ noteid: 'b', text: 'two' }));
  assert.deepEqual(ids(store), ['a', 'b']);
});
