// @test-kind contract: Paqvilo execution receipts: only adapters that actually ran or delivered are reported
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { pluginCatalogue, runPluginPhase } from '../lib/exported-plugins.mjs';

const id = '10000000-0000-0000-0000-000000000001';
const registration = {
  id,
  entity: 'widget',
  message: 'Update',
  stage: 20,
  rank: 1,
  mode: 0,
  enabled: true,
  supportedDeployment: 0,
  filteringAttributes: [],
  images: [],
  typeName: 'Invented.Receipt',
  assemblyId: 'invented',
};
function phase({ step = {}, mode, context = {}, handler = () => {}, webhooks } = {}) {
  const state = emptyState();
  state.mappings.widget = { entitySet: 'widgets', idColumn: 'widgetid' };
  state.tables.widget = [];
  const store = new DataStore({ state });
  const handlers = new Map(mode === 'placeholder' || mode === 'webhook' ? [] : [[id, handler]]);
  const items = pluginCatalogue({
    plugins: { steps: [{ ...registration, ...step }] },
    handlers,
    overrides: mode ? { ['plugin-step:' + id]: { mode } } : {},
  });
  const observed = [];
  const run = () =>
    runPluginPhase({
      store,
      items,
      handlers,
      webhooks,
      entity: 'widget',
      operation: 'update',
      stage: 20,
      target: { title: 'After' },
      record: { widgetid: id, title: 'After' },
      previous: { widgetid: id, title: 'Before' },
      identity: { id, admin: true },
      changedAttributes: ['title'],
      onStepExecuted: (item) => observed.push(item.id),
      ...context,
    });
  return { run, observed };
}

test('execution receipts distinguish actual adapters from skipped, filtered and bypassed registrations', () => {
  for (const mode of ['handler', 'mock']) {
    const f = phase({ mode });
    f.run();
    assert.deepEqual(f.observed, [id], mode);
  }
  for (const options of [
    { mode: 'disabled' },
    { mode: 'placeholder' },
    { mode: 'placeholder', step: { supportedDeployment: 3 } },
    { step: { enabled: false } },
    { step: { supportedDeployment: 1 } },
    { step: { mode: 1, stage: 40 } },
    { step: { filteringAttributes: ['note'] } },
    { context: { bypassStepIds: [id] } },
    { context: { bypassCustomPlugins: true } },
  ]) {
    const f = phase({ ...options, handler: () => assert.fail('A skipped adapter must not be invoked') });
    f.run();
    assert.deepEqual(f.observed, [], JSON.stringify(options));
  }
  const rejected = phase({
    handler: () => {
      throw new Error('Rejected scalar');
    },
  });
  assert.throws(rejected.run, /Rejected scalar/);
  assert.deepEqual(rejected.observed, []);
});

test('a webhook receipt is produced only after successful synchronous or awaited delivery', async () => {
  const sync = phase({ mode: 'webhook', webhooks: { sync: () => {} } });
  sync.run();
  assert.deepEqual(sync.observed, [id]);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const pending = phase({ mode: 'webhook', context: { awaitIo: true }, webhooks: { send: () => gate } });
  const result = pending.run();
  assert.deepEqual(pending.observed, []);
  release();
  await result;
  assert.deepEqual(pending.observed, [id]);
  const rejected = phase({
    mode: 'webhook',
    context: { awaitIo: true },
    webhooks: {
      send: async () => {
        throw new Error('Delivery rejected');
      },
    },
  });
  await assert.rejects(rejected.run, /Delivery rejected/);
  assert.deepEqual(rejected.observed, []);
});
