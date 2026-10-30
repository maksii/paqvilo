// @test-kind compatibility: Learn plug-in tracing (plugintracelog survives the rolled-back request) and plug-in error codes; the ordinary-exception code is the native faults.json fact
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataStore, emptyState } from '../lib/data.mjs';
import { readStateFile } from '../lib/state-storage.mjs';
import {
  pluginCatalogue,
  pluginHandlers,
  pluginPhaseRequiresCheckpoint,
  runPluginPhase,
} from '../lib/exported-plugins.mjs';
import { contractModuleFixture } from './contract-module-fixture.mjs';

const ROW = '10000000-0000-4000-8000-000000000001';
const STEP = '20000000-0000-4000-8000-000000000001';
const CORRELATION = '30000000-0000-4000-8000-000000000001';
const traceId = (index) => `40000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const trace = (index) => ({ plugintracelogid: traceId(index), messageblock: 'Local trace ' + index });
const seed = () => {
  const state = emptyState();
  state.mappings.x_item = {
    logicalName: 'x_item',
    entitySet: 'x_items',
    idColumn: 'x_itemid',
    fields: { x_name: { dataverseType: 'nvarchar' } },
  };
  state.mappings.plugintracelog = {
    logicalName: 'plugintracelog',
    entitySet: 'plugintracelogs',
    idColumn: 'plugintracelogid',
  };
  state.tables.x_item = [{ x_itemid: ROW, x_name: 'original' }];
  state.tables.plugintracelog = [];
  return state;
};
const mutate = (store, name) => store.mutateRow('x_item', store.state.tables.x_item, 0, { x_name: name });

test('a rejected plugin leaves its correlated trace queryable over Web API while target and related writes roll back', async (t) => {
  const { store, request, json } = await contractModuleFixture(t, {
    mappings: seed().mappings,
    tables: seed().tables,
    extension: { name: 'local-trace-probe', install() {} },
  });
  await store.transact(() => {
    store.tableRows('organization')[0].plugintracelogsetting = 1;
  });
  const handlers = pluginHandlers([
    {
      id: 'trace-probe',
      pluginSteps: {
        [STEP]: ({ trace }) => {
          trace('Synthetic rejection detail');
          mutate(store, 'related change');
          throw new Error('Synthetic plugin rejection');
        },
      },
    },
  ]);
  const items = () =>
    pluginCatalogue({
      plugins: {
        steps: [
          {
            id: STEP,
            name: 'Local trace probe',
            entity: 'x_item',
            message: 'Create',
            enabled: true,
            stage: 20,
            rank: 1,
            mode: 0,
            typeName: 'Local.TraceProbe',
            typeId: '20000000-0000-4000-8000-000000000002',
            assemblyId: '20000000-0000-4000-8000-000000000003',
            supportedDeployment: 0,
            filteringAttributes: [],
            images: [],
          },
        ],
      },
      handlers,
    });
  store.setPluginPipeline(
    (context) => runPluginPhase({ ...context, store, items: items(), handlers }),
    ({ entity, operation }) => entity === 'x_item' && operation === 'create',
    (context) => pluginPhaseRequiresCheckpoint(items(), context),
  );
  const response = await request(
    'POST',
    '/x_items',
    { x_name: 'must not persist' },
    { 'x-ms-correlation-request-id': CORRELATION },
  );
  assert.ok(response.status >= 400);
  // An ordinary exception from a step handler is the platform's unhandled plug-in fault (native faults.json: a
  // plug-in's ordinary exception answered 400 0x80040224 with its message).
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, '0x80040224');
  const logs = await json(await request('GET', `/plugintracelogs?$filter=correlationid eq ${CORRELATION}`), 200);
  assert.equal(logs.value.length, 1);
  assert.equal(logs.value[0].messageblock, 'Synthetic rejection detail');
  assert.equal(logs.value[0].exceptiondetails, 'Synthetic plugin rejection');
  assert.equal(logs.value[0].depth, 1);
  assert.equal(logs.value[0].mode, 0);
  assert.deepEqual(store.tableRows('x_item'), seed().tables.x_item);
});

for (const isolated of [false, true])
  for (const journalThresholdBytes of [0, Number.MAX_SAFE_INTEGER])
    test(`trace-only rollback retention persists without aborted row journals (isolated ${isolated}, threshold ${journalThresholdBytes})`, async (t) => {
      const root = await fs.mkdtemp(join(tmpdir(), 'paqvilo-trace-rollback-'));
      t.after(() => fs.rm(root, { recursive: true, force: true }));
      const file = join(root, 'state.json');
      const store = await new DataStore({ state: seed(), file, persistence: { journalThresholdBytes } }).init();
      const before = store.snapshot(),
        revision = store.dataRevision(),
        tableRevision = store.tablesRevision(['plugintracelog']);
      const events = [];
      store.addCommittedEvents((event) => events.push(event));
      let staged = 0;
      store.addCommitStager(() => {
        staged++;
      });
      const rejection = new Error('Business rejection');
      await assert.rejects(
        store.transact(
          () => {
            mutate(store, 'aborted');
            store.recordCommittedEvent('x_item', 'update', store.tableRows('x_item')[0], ['x_name']);
            store.appendPluginTraceLog(trace(1));
            throw rejection;
          },
          { incremental: true, isolated },
        ),
        (error) => error === rejection,
      );
      assert.deepEqual(store.tableRows('x_item'), before.tables.x_item);
      assert.deepEqual(store.tableRows('plugintracelog'), [trace(1)]);
      assert.equal(store.state.rowVersion, before.rowVersion);
      assert.notEqual(store.dataRevision(), revision);
      assert.notEqual(store.tablesRevision(['plugintracelog']), tableRevision);
      assert.deepEqual(events, []);
      assert.equal(staged, 0, 'business events and their durable jobs are not staged by diagnostic retention');
      assert.equal(store.committedEventSequence ?? 0, 0);
      assert.equal(store.lastSave.mode, 'checkpoint', 'aborted business journal entries cannot be republished');
      assert.deepEqual(await readStateFile(file), store.snapshot());
      const reopened = await new DataStore({ file, persistence: { journalThresholdBytes } }).init();
      assert.deepEqual(reopened.snapshot(), store.snapshot());
      await reopened.transact(() => mutate(reopened, 'next valid write'), { incremental: true });
      const after = await readStateFile(file);
      assert.equal(after.tables.x_item[0].x_name, 'next valid write');
      assert.deepEqual(after.tables.plugintracelog, [trace(1)]);
    });

test('isolated failure publishes retained traces only after its business working copy has rolled back', async () => {
  const store = await new DataStore({ state: seed() }).init();
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const run = store.transact(
    async () => {
      mutate(store, 'private rejected value');
      store.appendPluginTraceLog(trace(1));
      entered.resolve();
      await release.promise;
      throw new Error('Isolated rejection');
    },
    { isolated: true, incremental: true },
  );
  await entered.promise;
  assert.equal(store.tableRows('x_item')[0].x_name, 'original');
  assert.deepEqual(store.tableRows('plugintracelog'), []);
  release.resolve();
  await assert.rejects(run, /Isolated rejection/);
  assert.equal(store.tableRows('x_item')[0].x_name, 'original');
  assert.deepEqual(store.tableRows('plugintracelog'), [trace(1)]);
});

test('caught and outer SDK rollbacks retain immutable trace facts exactly once', async () => {
  for (const outerFails of [false, true]) {
    const store = await new DataStore({ state: seed() }).init();
    const run = store.transact(
      () => {
        mutate(store, 'outer value');
        store.appendPluginTraceLog(trace(1));
        assert.throws(
          () =>
            store.sdkMutation(() => {
              mutate(store, 'inner aborted value');
              const fact = trace(2);
              store.appendPluginTraceLog(fact);
              fact.messageblock = 'must not replace retained fact';
              throw new Error('Inner rejection');
            }),
          /Inner rejection/,
        );
        assert.equal(store.tableRows('x_item')[0].x_name, 'outer value');
        assert.deepEqual(store.tableRows('plugintracelog'), [trace(1), trace(2)]);
        if (outerFails) throw new Error('Outer rejection');
      },
      { incremental: true },
    );
    if (outerFails) await assert.rejects(run, /Outer rejection/);
    else await run;
    assert.equal(store.tableRows('x_item')[0].x_name, outerFails ? 'original' : 'outer value');
    assert.deepEqual(store.tableRows('plugintracelog'), [trace(1), trace(2)]);
  }
});

test('independent PreValidation SDK commits keep their legitimate business writes and do not duplicate traces', async () => {
  const store = await new DataStore({ state: seed() }).init();
  await assert.rejects(
    store.transact(() => {
      store.pluginInTransaction = false;
      store.sdkMutation(() => {
        mutate(store, 'independently committed');
        store.appendPluginTraceLog(trace(1));
      });
      mutate(store, 'outer rejected');
      store.appendPluginTraceLog(trace(2));
      throw new Error('Outer rejection');
    }),
    /Outer rejection/,
  );
  assert.equal(store.tableRows('x_item')[0].x_name, 'independently committed');
  assert.deepEqual(store.tableRows('plugintracelog'), [trace(1), trace(2)]);
});

test('a caught SDK rollback retains its trace through a promoted outer checkpoint and restart', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'paqvilo-trace-savepoint-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = join(root, 'state.json');
  const store = await new DataStore({ state: seed(), file, persistence: { journalThresholdBytes: 0 } }).init();
  await store.transact(() => mutate(store, 'journal baseline'), { incremental: true });
  assert.equal(store.lastSave.mode, 'journal');
  await store.transact(
    () => {
      mutate(store, 'outer committed value');
      store.appendPluginTraceLog(trace(1));
      assert.throws(
        () =>
          store.sdkMutation(() => {
            mutate(store, 'inner rejected value');
            store.appendPluginTraceLog(trace(2));
            throw new Error('Caught SDK rejection');
          }),
        /Caught SDK rejection/,
      );
      assert.equal(store.tableRows('x_item')[0].x_name, 'outer committed value');
      assert.deepEqual(store.tableRows('plugintracelog'), [trace(1), trace(2)]);
    },
    { incremental: true },
  );
  assert.equal(store.lastSave.mode, 'checkpoint', 'the SDK savepoint promotes its parent before nested mutation');
  const persisted = await readStateFile(file);
  assert.equal(persisted.tables.x_item[0].x_name, 'outer committed value');
  assert.deepEqual(persisted.tables.plugintracelog, [trace(1), trace(2)]);
  const reopened = await new DataStore({ file, persistence: { journalThresholdBytes: 0 } }).init();
  assert.deepEqual(reopened.snapshot(), store.snapshot());
});

test('trace persistence failure retains both errors without speculative state or revision publication', async () => {
  const store = await new DataStore({ state: seed() }).init();
  const before = store.snapshot(),
    revision = store.revision;
  const priorCause = new Error('Original plugin cause');
  const original = new Error('Business rejection', { cause: priorCause });
  const storage = Object.assign(new Error('Trace storage unavailable'), { code: 'StateConflict', status: 409 });
  store.save = async () => {
    throw storage;
  };
  await assert.rejects(
    store.transact(
      () => {
        mutate(store, 'aborted');
        store.appendPluginTraceLog(trace(1));
        throw original;
      },
      { incremental: true },
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, original);
      assert.equal(error.cause.cause, priorCause);
      assert.deepEqual(error.errors, [original, storage]);
      assert.equal(error.persistenceFailure, true);
      assert.equal(error.code, 'StateConflict');
      return true;
    },
  );
  assert.deepEqual(store.snapshot(), before);
  assert.equal(store.revision, revision);
});

test('a primary persistence failure never retries trace retention as an independent commit', async () => {
  const store = await new DataStore({ state: seed() }).init();
  const before = store.snapshot();
  let saves = 0;
  const storage = Object.assign(new Error('Primary storage unavailable'), { persistenceFailure: true });
  store.save = async () => {
    saves++;
    throw storage;
  };
  await assert.rejects(
    store.transact(
      () => {
        mutate(store, 'aborted');
        store.appendPluginTraceLog(trace(1));
      },
      { incremental: true },
    ),
    (error) => error === storage,
  );
  assert.equal(saves, 1);
  assert.deepEqual(store.snapshot(), before);
  assert.equal(store.revision, 0);
});

test('failed combined elastic and trace retention restores the state before either diagnostic or business publication', async () => {
  const state = seed();
  state.mappings.x_item.tableType = 'Elastic';
  const store = await new DataStore({ state }).init();
  const before = store.snapshot();
  const original = new Error('Elastic post-operation rejection');
  const storage = new Error('Combined retention storage unavailable');
  store.save = async () => {
    throw storage;
  };
  await assert.rejects(
    store.transact(
      () => {
        mutate(store, 'elastic main operation');
        store.checkpointElastic(store.resolveMapping('x_item'), store.tableRows('x_item')[0]);
        store.appendPluginTraceLog(trace(1));
        throw original;
      },
      { incremental: true },
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, original);
      assert.deepEqual(error.errors, [original, storage]);
      assert.equal(error.persistenceFailure, true);
      return true;
    },
  );
  assert.deepEqual(store.snapshot(), before, 'the fallback snapshot cannot contain speculative trace facts');
  assert.equal(store.revision, 0);
});
