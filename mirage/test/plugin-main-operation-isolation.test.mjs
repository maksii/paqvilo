// @test-kind contract: a named message's main operation belongs to its own request context, so other requests and later requests never run under it
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore } from '../lib/data.mjs';
import { pluginCatalogue, runPluginPhase } from '../lib/exported-plugins.mjs';
import { runEntryMessage } from '../lib/plugin-platform-messages.mjs';

// Invented widget row and a log table with two plug-in steps on Create.
const ROW = '30000000-0000-4000-8000-000000000001';
const base = {
  enabled: true,
  mode: 0,
  rank: 1,
  supportedDeployment: 0,
  filteringAttributes: [],
  images: [],
  assemblyId: 'invented',
};
const steps = [
  {
    ...base,
    id: '10000000-0000-4000-8000-000000000001',
    name: 'action pre',
    entity: 'x_widget',
    message: 'InventedAction',
    stage: 20,
    typeName: 'Invented.Action',
  },
  {
    ...base,
    id: '10000000-0000-4000-8000-000000000002',
    name: 'log pv',
    entity: 'x_log',
    message: 'Create',
    stage: 10,
    typeName: 'Invented.LogPv',
  },
  {
    ...base,
    id: '10000000-0000-4000-8000-000000000003',
    name: 'log pre',
    entity: 'x_log',
    message: 'Create',
    stage: 20,
    typeName: 'Invented.LogPre',
  },
];

const requestKey = (value) => value?.value ?? value ?? null;
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

// A store whose plug-in handlers record the context each Create step sees.
function storeRecording(seen) {
  const store = new DataStore({
    state: {
      version: 1,
      mappings: {
        x_widget: { entitySet: 'x_widgets', idColumn: 'x_widgetid' },
        x_log: { entitySet: 'x_logs', idColumn: 'x_logid' },
      },
      tables: { x_widget: [{ x_widgetid: ROW, x_name: 'w' }], x_log: [] },
      permissions: [],
      plugins: [],
      settings: { permissionMode: 'enforce' },
    },
  });
  const view =
    (label) =>
    ({ context }) => {
      seen.push({
        label,
        request: requestKey(context.RequestId),
        parent: context.ParentContext ? `${context.ParentContext.MessageName}/${context.ParentContext.Stage}` : null,
      });
    };
  const handlers = new Map([
    ['Invented.Action', view('action/20')],
    ['Invented.LogPv', view('create/10')],
    ['Invented.LogPre', view('create/20')],
  ]);
  const items = pluginCatalogue({ plugins: { steps }, handlers });
  store.setPluginPipeline((context) => runPluginPhase({ ...context, store, items, handlers }));
  return store;
}

// Each request runs in its own fresh operation context, as separate HTTP requests do.
const isolated = (store, fn) => store.withOperationContext(fn, { fresh: true });
const createLog = (store, name) => isolated(store, () => store.create('x_log', { x_name: name }, { admin: true }));
const runAction = (store, main) =>
  isolated(store, () =>
    runEntryMessage(store, {
      message: 'InventedAction',
      entity: 'x_widget',
      id: ROW,
      inputs: {},
      context: { identity: { admin: true } },
      main,
    }),
  );

test('a Create issued while a named message main awaits has no ParentContext and its own RequestId', async () => {
  const seen = [];
  const store = storeRecording(seen);
  await createLog(store, 'baseline');
  const started = deferred(),
    release = deferred();
  let actionRequest;
  const action = runAction(store, async () => {
    actionRequest = requestKey(store.pluginMainOperation?.context?.values?.RequestId);
    started.resolve();
    await release.promise;
    return {};
  });
  await started.promise;
  seen.length = 0;
  await createLog(store, 'concurrent');
  release.resolve();
  await action;
  const creates = seen.filter((entry) => entry.label.startsWith('create/'));
  // A PreOperation step's parent is its own record pipeline's PreValidation step, never the pending message.
  assert.deepEqual(
    creates.map((entry) => [entry.label, entry.parent]),
    [
      ['create/10', null],
      ['create/20', 'Create/10'],
    ],
  );
  for (const entry of creates) {
    assert.ok(entry.request);
    assert.notEqual(entry.request, actionRequest);
  }
});

test('two overlapping named messages that finish in start order leave no main operation for later requests', async () => {
  const seen = [];
  const store = storeRecording(seen);
  const startedA = deferred(),
    startedB = deferred(),
    releaseA = deferred(),
    releaseB = deferred();
  const actionA = runAction(store, async () => {
    startedA.resolve();
    await releaseA.promise;
    return {};
  });
  await startedA.promise;
  const actionB = runAction(store, async () => {
    startedB.resolve();
    await releaseB.promise;
    return {};
  });
  await startedB.promise;
  releaseA.resolve();
  await actionA;
  releaseB.resolve();
  await actionB;
  assert.equal(store.pluginMainOperation, undefined);
  seen.length = 0;
  await createLog(store, 'later, unrelated');
  assert.deepEqual(
    seen.map((entry) => [entry.label, entry.parent]),
    [
      ['create/10', null],
      ['create/20', 'Create/10'],
    ],
  );
});
