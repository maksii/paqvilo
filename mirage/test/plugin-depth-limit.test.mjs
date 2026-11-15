// @test-kind parity: native depth39 (two captures): a synchronous nested chain runs to Depth 12, then the request answers 400 0x80044182 (infinite loop) and nothing is kept
// @parity-evidence: native and native-r2 depth39: Create Depth 1..12, POST 400 0x80044182 'This workflow job was canceled because the workflow that started it included an infinite loop...', all children rolled back
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
    (error) =>
      error.code === 'LocalPluginDepth' &&
      error.status === 400 &&
      error.details?.innerCode === '0x80044182' &&
      /included an infinite loop/.test(error.message),
  );
  return { store, row, calls, depths, handlers, items };
}

// A JavaScript Update self-recursion stops the way native depth39's Create chain does: Depth 12, then 0x80044182 and
// the chain rolls back (the Update shape itself is not captured).
// @parity-evidence: native and native-r2 depth39 are a Create chain (Depth 1..12, 400 0x80044182, children rolled back), pinned by the last test; this Update recursion is retagged unproven
// @test-kind unproven: a JavaScript Update self-recursion; the native depth39 capture is a Create chain
test('A step-id handler that updates its own row stops at depth 12 with the infinite-loop fault and rolls back', async () => {
  const { store, row, calls } = await recursion(id);
  assert.equal(calls, 12);
  assert.equal(store.snapshot().tables.x_widget.find((r) => r.x_widgetid === row.x_widgetid).x_count, 0);
});

// @test-kind unproven: a JavaScript Update self-recursion; the native depth39 capture is a Create chain
test('A plug-in type handler sees Depth 1 to 12 before the depth fault, and the counter is balanced afterwards', async () => {
  const { store, row, calls, depths } = await recursion(step.typeName);
  assert.equal(calls, 12);
  assert.deepEqual(
    depths,
    Array.from({ length: 12 }, (_, i) => i + 1),
  );
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

// Native depth39 shape: a synchronous Create PostOperation step creates a child row through the SDK; each child triggers the
// same step, Depth 1 to 12. The 13th level fails the original POST with 0x80044182 and every child row is rolled back.
test('a synchronous Create chain runs to Depth 12, then the root create answers 400 0x80044182 and no row remains', async () => {
  const store = data(),
    depths = [];
  const createStep = {
    ...step,
    id: '10000000-0000-4000-8000-000000000042',
    message: 'Create',
    typeName: 'Invented.CreateChain',
  };
  const handlers = new Map([
    [
      createStep.typeName,
      ({ context }) => {
        depths.push(context.Depth);
        store.sdkMutation(() => store.createRecord('x_widget', { x_name: 'child' }, { admin: true }));
      },
    ],
  ]);
  const items = pluginCatalogue({ plugins: { steps: [createStep] }, handlers });
  store.setPluginPipeline((context) => runPluginPhase({ ...context, store, items, handlers }));
  await assert.rejects(
    store.create('x_widget', { x_name: 'Root' }, { admin: true }),
    (error) =>
      error.status === 400 &&
      error.details?.innerCode === '0x80044182' &&
      /included an infinite loop/.test(error.message),
  );
  assert.deepEqual(
    depths,
    Array.from({ length: 12 }, (_, i) => i + 1),
  );
  assert.equal(store.snapshot().tables.x_widget.length, 0);
});
