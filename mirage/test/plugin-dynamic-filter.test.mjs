// @test-kind unproven: assumes columns added by an earlier rank admit later filtered steps in the same stage; no native capture
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import {
  pluginCatalogue,
  pluginPhaseRequiresCheckpoint,
  pluginStepMatchesAttributes,
  runPluginPhase,
} from '../lib/exported-plugins.mjs';
import { createAsyncPluginRunner } from '../lib/plugin-async.mjs';
import { createScheduler, fixedClock } from '../lib/runtime-clock.mjs';

for (const typed of [false, true])
  test(`later-ranked Update filters observe newly added Target columns (${typed ? 'type' : 'step'} handler) and retain rollback`, async () => {
    const state = emptyState();
    state.mappings.widget = { entitySet: 'widgets', idColumn: 'widgetid' };
    state.tables.widget = [{ widgetid: '10000000-0000-0000-0000-000000000001', title: 'Before' }];
    state.tables.unrelated = [{ unrelatedid: 'other', title: 'Unchanged' }];
    const store = new DataStore({ state });
    const steps = [1, 2].map((rank) => ({
      id: `30000000-0000-0000-0000-00000000000${rank}`,
      enabled: true,
      entity: 'widget',
      message: 'Update',
      stage: 20,
      mode: 0,
      rank,
      supportedDeployment: 0,
      filteringAttributes: rank === 2 ? ['added'] : [],
      images: [],
      typeName: `Invented.Rule${rank}`,
      assemblyId: 'invented',
    }));
    let reached = false;
    const handlers = new Map([
      [
        typed ? steps[1].typeName : steps[1].id,
        (ctx) => {
          reached = true;
          assert.ok(ctx.changedAttributes.includes('added'));
          store.state.tables.unrelated[0].title = 'Arbitrary callback write';
          ctx.reject('Later filtered handler rejected');
        },
      ],
    ]);
    const items = pluginCatalogue({
      plugins: { steps },
      handlers,
      overrides: {
        ['plugin-step:' + steps[0].id]: { mode: 'mock', body: { target: { added: 'Added by earlier rank' } } },
      },
    });
    store.setPluginPipeline(
      (ctx) => runPluginPhase({ ...ctx, store, items, handlers }),
      () => true,
      (ctx) => pluginPhaseRequiresCheckpoint(items, ctx),
    );
    const before = store.snapshot();
    await assert.rejects(
      store.transact(
        () => store.updateRecord('widget', state.tables.widget[0].widgetid, { title: 'After' }, { admin: true }),
        { incremental: true },
      ),
      /Later filtered handler rejected/,
    );
    assert.equal(reached, true);
    assert.deepEqual(store.snapshot(), before);
  });

// A Create 20 handler step filtered on x_text; the handler counts its runs for one POST of the given columns.
async function createRunsFor(values) {
  const state = emptyState();
  state.mappings.x_widget = {
    entitySet: 'x_widgets',
    idColumn: 'x_widgetid',
    fields: { x_name: { dataverseType: 'nvarchar' }, x_text: { dataverseType: 'nvarchar' } },
  };
  state.tables.x_widget = [];
  const store = new DataStore({ state });
  const steps = [
    {
      id: '30000000-0000-0000-0000-0000000000c1',
      enabled: true,
      entity: 'x_widget',
      message: 'Create',
      stage: 20,
      mode: 0,
      rank: 1,
      supportedDeployment: 0,
      filteringAttributes: ['x_text'],
      images: [],
      typeName: 'Invented.CreateFilter',
      assemblyId: 'invented',
    },
  ];
  let runs = 0;
  const handlers = new Map([[steps[0].id, () => void (runs += 1)]]);
  const items = pluginCatalogue({ plugins: { steps }, handlers });
  store.setPluginPipeline(
    (ctx) => runPluginPhase({ ...ctx, store, items, handlers }),
    () => true,
    (ctx) => pluginPhaseRequiresCheckpoint(items, ctx),
  );
  await store.transact(
    () =>
      store.createRecord(
        'x_widget',
        { x_widgetid: '10000000-0000-0000-0000-0000000000a1', ...values },
        { admin: true },
      ),
    { incremental: true },
  );
  return runs;
}

// @test-kind parity: native and native-r2 filters 'Probe: Create 20 filter text' does not run for a POST without the filtered column
test('a Create step filtered on a column does not run for a POST that lacks it', async () => {
  assert.equal(await createRunsFor({ x_name: 'Invented' }), 0);
});

// @test-kind unproven: the positive Create control is not captured (NATIVE filter-semantics)
test('a Create step filtered on a column runs once for a POST that carries it', async () => {
  assert.equal(await createRunsFor({ x_name: 'Invented', x_text: 'Present' }), 1);
});

// @test-kind unproven: the Create filter rule is a local model; native shows only the absent-column refusal above
test('create filtering reads the Target keys and adds no id column, while update still adds it', () => {
  const store = { resolveMapping: () => ({ idColumn: 'x_widgetid' }) };
  const item = { filteringAttributes: ['x_widgetid'] };
  const matches = (operation, changedAttributes) =>
    pluginStepMatchesAttributes(item, { store, entity: 'x_widget', operation, changedAttributes });
  assert.equal(matches('create', ['x_widgetid', 'x_name']), true);
  assert.equal(matches('create', ['x_name']), false);
  assert.equal(matches('createmultiple', ['x_name']), false);
  assert.equal(matches('update', ['x_name']), true);
});

// An asynchronous Create 40 step filtered on x_text, queued by one POST; returns how many times its handler ran.
async function asyncCreateRunsFor(t, values) {
  const state = emptyState();
  state.mappings.x_widget = {
    entitySet: 'x_widgets',
    idColumn: 'x_widgetid',
    fields: { x_name: { dataverseType: 'nvarchar' }, x_text: { dataverseType: 'nvarchar' } },
  };
  state.tables.x_widget = [];
  const store = new DataStore({ state });
  const scheduler = createScheduler({ clock: fixedClock(), manual: true });
  store.scheduler = scheduler;
  const steps = [
    {
      id: '30000000-0000-0000-0000-0000000000c2',
      enabled: true,
      entity: 'x_widget',
      message: 'Create',
      stage: 40,
      mode: 1,
      rank: 1,
      supportedDeployment: 0,
      filteringAttributes: ['x_text'],
      images: [],
      typeName: 'Invented.AsyncCreateFilter',
      assemblyId: 'invented',
    },
  ];
  let runs = 0;
  const handlers = new Map([[steps[0].id, () => void (runs += 1)]]);
  const items = () => pluginCatalogue({ plugins: { steps }, handlers });
  const runner = createAsyncPluginRunner({ store, items, handlers, runtimes: new Map(), systemJobs: () => true });
  t.after(async () => {
    await runner.close();
    await scheduler.close();
    store.close();
  });
  await store.create('x_widget', { x_widgetid: '10000000-0000-0000-0000-0000000000a2', ...values }, { admin: true });
  await scheduler.runDue();
  await runner.drain();
  return runs;
}

// @test-kind unproven: asynchronous Create filtering is not captured natively; the queued-Create rule follows the synchronous Create rule
test('an asynchronous Create step is queued only for a POST that carries its filtered column', async (t) => {
  assert.equal(await asyncCreateRunsFor(t, { x_name: 'Invented' }), 0);
  assert.equal(await asyncCreateRunsFor(t, { x_name: 'Invented', x_text: 'Present' }), 1);
});
