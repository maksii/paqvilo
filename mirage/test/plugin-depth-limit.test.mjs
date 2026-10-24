import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore } from '../lib/data.mjs';
import { pluginCatalogue, runPluginPhase } from '../lib/exported-plugins.mjs';

const id = '10000000-0000-4000-8000-000000000041';
const step = {
  id,
  name: 'Invented recursive step',
  entity: 'x_widget',
  message: 'Update',
  enabled: true,
  stage: 40,
  rank: 1,
  mode: 0,
  typeName: 'Invented.Recursive',
  assemblyId: 'invented',
  supportedDeployment: 0,
  filteringAttributes: [],
  images: [],
};
const data = () =>
  new DataStore({
    state: {
      version: 1,
      mappings: { x_widget: { entitySet: 'x_widgets', idColumn: 'x_widgetid' } },
      tables: { x_widget: [] },
      permissions: [],
      plugins: [],
      settings: { permissionMode: 'enforce' },
    },
  });

async function recursion(key) {
  const store = data(),
    depths = [];
  let calls = 0;
  const handler = ({ record, context }) => {
    calls++;
    depths.push(context?.Depth);
    store.sdkMutation(() =>
      store.updateRecord('x_widget', record.x_widgetid, { x_count: (record.x_count ?? 0) + 1 }, { admin: true }),
    );
  };
  const handlers = new Map([[key, handler]]),
    items = pluginCatalogue({ plugins: { steps: [step] }, handlers });
  const row = await store.create('x_widget', { x_name: 'Root', x_count: 0 }, { admin: true });
  store.setPluginPipeline((context) => runPluginPhase({ ...context, store, items, handlers }));
  await assert.rejects(
    store.update('x_widget', row.x_widgetid, { x_count: 1 }, { admin: true }),
    (error) => error.code === 'LocalPluginDepth' && error.status === 400 && /depth exceeds eight/.test(error.message),
  );
  return { store, row, calls, depths, handlers, items };
}

test('A step-id handler that updates its own row stops at depth eight with the plug-in depth fault and rolls back', async () => {
  const { store, row, calls } = await recursion(id);
  assert.equal(calls, 8);
  assert.equal(store.snapshot().tables.x_widget.find((r) => r.x_widgetid === row.x_widgetid).x_count, 0);
});

test('A plug-in type handler sees Depth 1 to 8 before the depth fault, and the counter is balanced afterwards', async () => {
  const { store, row, calls, depths } = await recursion(step.typeName);
  assert.equal(calls, 8);
  assert.deepEqual(depths, [1, 2, 3, 4, 5, 6, 7, 8]);
  // The failed chain leaves no residue: a fresh non-recursive handler starts again at Depth 1.
  const seen = [],
    handlers = new Map([
      [
        step.typeName,
        ({ context }) => {
          seen.push(context.Depth);
        },
      ],
    ]),
    items = pluginCatalogue({ plugins: { steps: [step] }, handlers });
  store.setPluginPipeline((context) => runPluginPhase({ ...context, store, items, handlers }));
  await store.update('x_widget', row.x_widgetid, { x_count: 5 }, { admin: true });
  assert.deepEqual(seen, [1]);
});
