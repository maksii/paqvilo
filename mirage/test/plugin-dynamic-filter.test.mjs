// @test-kind unproven: assumes columns added by an earlier rank admit later filtered steps in the same stage; no native capture
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { pluginCatalogue, pluginPhaseRequiresCheckpoint, runPluginPhase } from '../lib/exported-plugins.mjs';

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
