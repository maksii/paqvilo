// @test-kind contract: Paqvilo's tracing and activity design (docs/design/tracing.md)
// Tracing of plug-ins (docs/design/tracing.md): a plugin-stage span only for a stage with matched steps, a plugin-step span
// per step whose trace lines are events and whose SDK writes nest under it, sdk-call spans for CLR RPCs, one bulk span per
// message and a custom-api span per invocation. Invented schemas and handlers only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { localOrganizationService } from '../lib/local-organization-service.mjs';
import { pluginCatalogue, runPluginPhase } from '../lib/exported-plugins.mjs';
import { dispatchSdkCall } from '../lib/plugin-clr.mjs';
import { executeBulkRecords } from '../lib/plugin-bulk.mjs';
import { customApiHandlers, install as installCustomApis } from '../lib/dataverse-customapi.mjs';
import { createTraceStore } from '../lib/trace-store.mjs';
import { itemNoteOrganization, pingApiStore } from './support/trace-plugins.mjs';

const USER = '77777777-7777-4777-8777-0000000000f2';
const STEP = '30000000-0000-4000-8000-0000000000a1';
const profile = {
  userId: USER,
  evidence: 'invented test grants',
  grants: [
    { entity: 'x_item', operations: ['create', 'read', 'update', 'delete'] },
    { entity: 'x_note', operations: ['create', 'read', 'update', 'delete'] },
  ],
};
const mapping = (logical) => ({
  logicalName: logical,
  entitySet: `${logical}s`,
  idColumn: `${logical}id`,
  nameColumn: 'x_name',
  fields: { x_name: { dataverseType: 'nvarchar' } },
});
const step = {
  id: STEP,
  name: 'Invented note writer',
  entity: 'x_item',
  message: 'Create',
  enabled: true,
  stage: 40,
  rank: 1,
  mode: 0,
  typeName: 'Invented.NoteWriter',
  assemblyId: 'invented-notes',
  supportedDeployment: 0,
  filteringAttributes: [],
  images: [],
};

// An organization store whose x_item Create PostOperation step writes an x_note through the SDK service.
async function organization(t, { level = 'full', handler } = {}) {
  const store = await itemNoteOrganization(t, mapping);
  store.traces = createTraceStore({ settings: { level } });
  const sdk = localOrganizationService(store, profile);
  const handlers = new Map([
    [
      STEP,
      handler ??
        (({ trace }) => {
          trace('Invented handler line');
          sdk.create('x_note', { x_name: 'Nested note' });
        }),
    ],
  ]);
  const items = pluginCatalogue({ plugins: { steps: [step] }, handlers });
  store.setPluginPipeline(
    (context) => runPluginPhase({ ...context, store, items, handlers }),
    ({ entity }) => entity === 'x_item',
  );
  return { store, sdk, traces: store.traces };
}
const byId = (spans) => new Map(spans.map((span) => [span.spanId, span]));
const parentOf = (spans, span) => byId(spans).get(span.parentSpanId);

test('an SDK create nests dataverse, plugin-stage, plugin-step and the step’s own SDK write in one trace', async (t) => {
  const { sdk, traces } = await organization(t);
  const root = traces.start({ kind: 'http', name: 'POST /invented', module: 'portal' });
  traces.run(root, () => sdk.create('x_item', { x_name: 'Root item' }));
  root.end();
  const { spans } = traces.tree(root.traceId);
  const item = spans.find((span) => span.kind === 'dataverse' && span.entity === 'x_item');
  assert.equal(item.parentSpanId, root.spanId);
  assert.equal(item.name, 'Create x_item');
  assert.equal(item.attributes.method, 'SDK');
  assert.equal(item.attributes.sdkUserId, USER);

  const stages = spans.filter((span) => span.kind === 'plugin-stage');
  assert.deepEqual(
    stages.map((span) => span.name),
    ['Create x_item · PostOperation'],
    'only the stage with a matched step has a span',
  );
  assert.equal(parentOf(spans, stages[0]).spanId, item.spanId);
  assert.equal(stages[0].attributes.matched, 1);
  assert.equal(stages[0].attributes.stage, 40);

  const [run] = spans.filter((span) => span.kind === 'plugin-step');
  assert.equal(run.parentSpanId, stages[0].spanId);
  assert.equal(run.name, 'Invented note writer');
  assert.equal(run.module, 'plugins');
  assert.equal(run.status, 'ok');
  assert.deepEqual(run.actor, { kind: 'plugin', id: STEP, name: 'Invented.NoteWriter' });
  assert.equal(run.attributes.stepId, STEP);
  assert.equal(run.attributes.mode, 'handler');
  assert.deepEqual(
    run.events.filter((event) => event.type === 'trace').map((event) => event.message),
    ['Invented handler line'],
  );
  assert.equal(run.input.target.x_name, 'Root item');

  const note = spans.find((span) => span.kind === 'dataverse' && span.entity === 'x_note');
  assert.equal(note.parentSpanId, run.spanId, 'the nested SDK write runs inside the step span');
  assert.equal(note.depth, run.depth + 1);
  assert.equal(traces.query({}).total, 1, 'one trace');
});

test('a rejecting step fails its step and stage spans with the fault, and summary keeps no payloads', async (t) => {
  const { sdk, traces } = await organization(t, {
    level: 'summary',
    handler: ({ reject }) => reject('Invented rule refused the item.'),
  });
  assert.throws(() => sdk.create('x_item', { x_name: 'Refused' }), /Invented rule refused the item/);
  const [run] = traces.spans({ kind: 'plugin-step' }).items;
  assert.equal(run.status, 'error');
  // The plug-in fault identity (D-R3-19), never the local PluginValidation code.
  assert.deepEqual(run.error, {
    type: 'InvalidPluginExecutionException',
    code: '0x80040265',
    status: 'Failed',
    message: 'Invented rule refused the item.',
    pluginType: 'Invented.NoteWriter',
    step: STEP,
    stage: 40,
    depth: 1,
  });
  assert.equal(run.input, undefined);
  assert.equal(run.output, undefined);
  const [stage] = traces.spans({ kind: 'plugin-stage' }).items;
  assert.equal(stage.status, 'error');
  const [item] = traces.spans({ kind: 'dataverse' }).items;
  assert.equal(item.status, 'error');
});

test('a CLR SDK call is an sdk-call span with its record write nested under it', async (t) => {
  const { store, traces } = await organization(t);
  const root = traces.start({ kind: 'plugin-step', name: 'Invented CLR step', module: 'clr' });
  traces.run(root, () =>
    dispatchSdkCall({
      store,
      profile,
      message: {
        method: 'Create',
        userId: USER,
        arguments: [{ $type: 'Entity', logicalName: 'x_note', attributes: { x_name: 'From CLR' } }],
      },
    }),
  );
  root.end();
  const { spans } = traces.tree(root.traceId);
  const call = spans.find((span) => span.kind === 'sdk-call');
  assert.equal(call.parentSpanId, root.spanId);
  assert.equal(call.name, 'Create');
  assert.equal(call.module, 'clr');
  assert.equal(call.entity, 'x_note');
  assert.equal(call.attributes.userId, USER);
  assert.equal(call.input[0].attributes.x_name, 'From CLR');
  const write = spans.find((span) => span.kind === 'dataverse');
  assert.equal(write.parentSpanId, call.spanId);
});

test('a bulk message is one bulk span, never one span per row', async (t) => {
  const { store, traces } = await organization(t, { level: 'summary' });
  const root = traces.start({ kind: 'sdk-call', name: 'CreateMultiple' });
  const targets = Array.from({ length: 5 }, (_, index) => ({
    $type: 'Entity',
    logicalName: 'x_note',
    attributes: { x_name: `Bulk ${index}` },
  }));
  const result = traces.run(root, () =>
    store.sdkMutation(() =>
      executeBulkRecords({
        store,
        entity: 'x_note',
        operation: 'createmultiple',
        targets,
        identity: { admin: true },
        authorize: () => {},
        responseToken: null,
      }),
    ),
  );
  root.end();
  assert.equal(result.ids.length, 5);
  const { spans } = traces.tree(root.traceId);
  const bulk = spans.filter((span) => span.kind === 'bulk');
  assert.equal(bulk.length, 1);
  assert.equal(bulk[0].name, 'CreateMultiple x_note');
  assert.equal(bulk[0].attributes.targets, 5);
  assert.deepEqual(
    spans.filter((span) => span.parentSpanId === bulk[0].spanId),
    [],
    'its rows open no spans',
  );
});

test('a custom API invocation is a custom-api span whose handler trace lines are events', async () => {
  const store = pingApiStore();
  const ops = [];
  installCustomApis(
    {
      store,
      change: (fn) => fn(),
      registry: { register: (op) => ops.push(op), has: (name) => ops.some((o) => o.name === name), find: () => null },
      principals: { privileges: () => new Map() },
    },
    {
      handlers: customApiHandlers([
        {
          id: 'invented-pack',
          customApis: {
            fx_Ping: (ctx) => {
              ctx.trace('Invented ping line');
              return { outputs: { Reply: `pong ${ctx.inputs.Message}` } };
            },
          },
        },
      ]),
    },
  );
  const origin = 'http://127.0.0.1:5555';
  const answer = await ops
    .find((op) => op.name === 'fx_Ping')
    .handle({
      method: 'POST',
      url: new URL('/api/data/v9.2/fx_Ping', origin),
      origin,
      version: 'v9.2',
      params: {},
      body: { Message: 'hello' },
      user: { systemuserid: USER },
    });
  assert.equal(answer.body.Reply, 'pong hello');
  const [api] = store.traces.spans({ kind: 'custom-api' }).items;
  assert.equal(api.name, 'fx_Ping');
  assert.equal(api.module, 'customapi');
  assert.equal(api.status, 'ok');
  assert.deepEqual(
    { isFunction: api.attributes.isFunction, bindingType: api.attributes.bindingType, handler: api.attributes.handler },
    { isFunction: false, bindingType: 0, handler: 'handler' },
  );
  assert.deepEqual(
    api.events.filter((event) => event.type === 'trace').map((event) => event.message),
    ['Invented ping line'],
  );
  assert.deepEqual(api.output, { inputs: { Message: 'hello' }, outputs: { Reply: 'pong hello' } });
});
