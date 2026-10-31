// @test-kind security: transaction capabilities, identity, events and provisional writes never leak across independent operations or stores
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { localOrganizationService } from '../lib/local-organization-service.mjs';
import { dispatchSdkCall } from '../lib/plugin-clr.mjs';

const user = '10000000-0000-0000-0000-000000000001';
const gate = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const fixture = () => {
  const state = emptyState();
  for (const entity of ['widget', 'child']) {
    state.mappings[entity] = { entitySet: entity + 's', idColumn: entity + 'id' };
    state.tables[entity] = [];
  }
  return new DataStore({ state });
};
const profile = {
  userId: user,
  evidence: 'Invented operation isolation',
  grants: [{ entity: 'child', operations: ['create', 'update', 'read'] }],
};
function independentRead(store, attempts) {
  store.setPluginPipeline(
    (context) => {
      if (context.stage !== 10 || context.operation !== 'retrievemultiple') return {};
      assert.equal(store.inTransaction(), false);
      assert.equal(store.pluginInTransaction === true, false);
      assert.equal(store.pluginReadOnly, true);
      for (const name of [
        'pluginRollbackBoundary',
        'rowTransaction',
        'committedEventCandidates',
        'pluginParentContext',
        'pluginExecutionUserId',
        'pluginSdkTag',
        'flowChain',
      ])
        assert.equal(store[name] == null, true, name);
      const deniedProfile = { ...profile, grants: [{ entity: 'child', operations: ['read'] }] };
      assert.throws(
        () => localOrganizationService(store, deniedProfile).create('child', { title: 'Independent direct SDK' }),
        { code: 'LocalBackendPermissionDenied' },
      );
      attempts.push('refused');
      // @parity-evidence: native and native-r2 readNested: a Retrieve/RetrieveMultiple step's SDK write commits in its own transaction (its child rows persist after the read's own 400)
      // The read step's authorized SDK write commits in a transaction of its own (data.mjs openReadLane): it never joins,
      // waits inside or sees the awaiting transaction, and inherits none of its identity, tag or chain.
      dispatchSdkCall({
        store,
        profile,
        message: {
          method: 'Create',
          userId: user,
          arguments: [
            {
              $type: 'Entity',
              logicalName: 'child',
              id: '00000000-0000-0000-0000-000000000000',
              attributes: { title: 'Independent CLR SDK' },
            },
          ],
        },
      });
      assert.equal(store.pluginInTransaction === true, false);
      for (const name of ['pluginParentContext', 'pluginSdkTag', 'flowChain'])
        assert.equal(store[name] == null, true, name);
      assert.deepEqual(
        store.tableRows('child').map((row) => row.title),
        ['Independent CLR SDK'],
        'the read sees its own write, never the awaiting provisional one',
      );
      attempts.push('committed');
      return {};
    },
    ({ operation }) => operation === 'retrievemultiple',
  );
  assert.equal(store.query('widget', {}, { admin: true }).value.length, 0);
}

test('an independent read cannot inherit an awaiting transaction capability, identity, events or chain', async (t) => {
  const store = fixture(),
    entered = gate(),
    release = gate(),
    attempts = [],
    committed = [];
  store.addCommittedEvents((events) => committed.push(...events));
  const pending = store.transact(
    async () => {
      store.pluginInTransaction = true;
      store.pluginParentContext = {
        $type: 'ExecutionContext',
        values: { Depth: 7, UserId: { $type: 'Guid', value: user } },
      };
      store.pluginExecutionUserId = user;
      store.pluginSdkTag = 'Private originating tag';
      store.flowChain = { id: user, depth: 6 };
      localOrganizationService(store, profile).create('child', { title: 'Provisional writer' });
      entered.resolve();
      await release.promise;
      assert.equal(store.pluginInTransaction, true);
      assert.equal(store.pluginSdkTag, 'Private originating tag');
      assert.equal(store.pluginParentContext.values.Depth, 7);
      throw new Error('Controlled rollback');
    },
    { isolated: true },
  );
  t.after(async () => {
    release.resolve();
    await pending.catch(() => {});
  });
  await entered.promise;
  independentRead(store, attempts);
  const queued = store.transact(
    () => {
      assert.equal(store.pluginParentContext == null, true);
      assert.equal(store.pluginSdkTag == null, true);
      assert.equal(store.flowChain == null, true);
      localOrganizationService(store, profile).create('child', { title: 'Later independent operation' });
    },
    { isolated: true },
  );
  // The awaiting transaction has not committed: the read's write waits in its own queued commit, unseen by others.
  assert.equal(
    store.tableRows('child').some((row) => row.title === 'Independent CLR SDK'),
    false,
  );
  release.resolve();
  await assert.rejects(pending, /Controlled rollback/);
  await store.settleReadLanes();
  await queued;
  await store.flushCommittedEvents();
  assert.deepEqual(attempts, ['refused', 'committed']);
  // The read's write survives the other transaction's rollback, committed before the later independent operation.
  assert.deepEqual(
    store.tableRows('child').map((row) => row.title),
    ['Independent CLR SDK', 'Later independent operation'],
  );
  // Row events (the read's own RetrieveMultiple message event commits with its lane, as inside a read operation).
  const rowEvents = committed.filter((event) => event.entity === 'child');
  assert.deepEqual(
    rowEvents.map((event) => event.row.title),
    ['Independent CLR SDK', 'Later independent operation'],
  );
  for (const event of committed) assert.equal(event.chain, null);
});

test('a bare asynchronous record facade keeps its phase flags private while awaiting a provider', async (t) => {
  const store = fixture(),
    entered = gate(),
    release = gate(),
    attempts = [];
  store.setPluginPipeline(
    (context) => {
      if (context.operation === 'create' && context.stage === 20) {
        entered.resolve();
        return release.promise.then(() => ({}));
      }
      return {};
    },
    ({ operation }) => operation === 'create',
  );
  const pending = store.createRecordAsync('widget', { title: 'Awaiting write' }, { admin: true });
  t.after(async () => {
    release.resolve();
    await pending;
  });
  await entered.promise;
  independentRead(store, attempts);
  release.resolve();
  const row = await pending;
  await store.settleReadLanes();
  assert.equal(row.title, 'Awaiting write');
  assert.deepEqual(attempts, ['refused', 'committed']);
  assert.deepEqual(
    store.tableRows('child').map((value) => value.title),
    ['Independent CLR SDK'],
  );
  assert.equal(store.pluginInTransaction == null, true);
});

// @test-kind unproven: local model of serialized read observer write and rollback boundary; no native capture cited
test('a serialized read observer retains its own authorized SDK writes and rollback boundary', async () => {
  const store = fixture();
  const row = await store.create('childs', { title: 'Before' }, { admin: true });
  let observed = false;
  store.setPluginPipeline(
    (context) => {
      if (context.operation === 'retrieve' && context.stage === 20) {
        observed = true;
        assert.equal(store.inTransaction(), true);
        assert.equal(store.pluginReadOnly, false);
        assert.ok(store.pluginRollbackBoundary);
        localOrganizationService(store, profile).update('child', row.childid, { title: 'Authorized read SDK update' });
        assert.throws(() => localOrganizationService(store, profile).create('widget', {}), {
          code: 'LocalBackendPermissionDenied',
        });
      }
      return {};
    },
    ({ operation }) => operation === 'retrieve',
  );
  await store.readOperation(() => store.get('child', row.childid, { admin: true }));
  assert.equal(observed, true);
  assert.equal(store.tableRows('child')[0].title, 'Authorized read SDK update');
  assert.equal(store.tableRows('widget').length, 0);
});

test('nested stores retain each transaction graph and frame without publishing another store provisional writes', async () => {
  const first = fixture(),
    second = fixture();
  await assert.rejects(
    first.transact(
      async () => {
        first.pluginSdkTag = 'First operation';
        first.createRecord('widget', { title: 'First provisional' }, { admin: true });
        await second.transact(
          async () => {
            assert.equal(second.pluginSdkTag == null, true);
            second.pluginSdkTag = 'Second operation';
            second.createRecord('widget', { title: 'Second committed' }, { admin: true });
            assert.equal(first.inTransaction(), true);
            assert.equal(first.pluginSdkTag, 'First operation');
            await first.transact(() =>
              first.createRecord('widget', { title: 'Nested first provisional' }, { admin: true }),
            );
            assert.equal(second.pluginSdkTag, 'Second operation');
          },
          { isolated: true },
        );
        assert.equal(first.pluginSdkTag, 'First operation');
        assert.equal(first.tableRows('widget').length, 2);
        throw new Error('First operation rollback');
      },
      { isolated: true },
    ),
    /First operation rollback/,
  );
  assert.equal(first.tableRows('widget').length, 0);
  assert.deepEqual(
    second.tableRows('widget').map((row) => row.title),
    ['Second committed'],
  );
});
