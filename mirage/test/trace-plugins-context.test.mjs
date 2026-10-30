// @test-kind contract: Paqvilo's tracing and activity design (docs/design/tracing.md)
// Tracing of what a plug-in step receives and how it fails (docs/design/tracing.md, D-R3-1, D-R3-19, D-R3-20, D-R3-23): the
// step span names the record, carries its registered images by alias and attribute filter, its input parameters, shared
// variables and execution context at level full, and its output parameters and shared variables after it ran; a plug-in fault
// records one identity on the step, stage, dispatch and request spans; custom API faults use the same identity; the internal
// message entry and CLR SDK calls name their message and record. Invented schemas and handlers only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { localOrganizationService } from '../lib/local-organization-service.mjs';
import { pluginCatalogue, runPluginPhase } from '../lib/exported-plugins.mjs';
import { dispatchSdkCall } from '../lib/plugin-clr.mjs';
import { customApiHandlers, install as installCustomApis } from '../lib/dataverse-customapi.mjs';
import { createTraceStore } from '../lib/trace-store.mjs';
import { itemNoteOrganization, pingApiStore } from './support/trace-plugins.mjs';

const USER = '77777777-7777-4777-8777-0000000000e1';
const UNIT = '88888888-8888-4888-8888-0000000000e1';
const PRE = '30000000-0000-4000-8000-0000000000e1';
const POST = '30000000-0000-4000-8000-0000000000e2';
const REFUSE = '30000000-0000-4000-8000-0000000000e3';
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
  fields: { x_name: { dataverseType: 'nvarchar' }, x_code: { dataverseType: 'nvarchar' } },
});
const step = (id, overrides) => ({
  id,
  name: `Invented step ${id.slice(-2)}`,
  entity: 'x_item',
  message: 'Update',
  enabled: true,
  rank: 1,
  mode: 0,
  assemblyId: 'invented-context',
  supportedDeployment: 0,
  filteringAttributes: [],
  images: [],
  ...overrides,
});
const STEPS = [
  // PreOperation, keyed by step id: a pre-image of x_name only, and a shared variable for the later stage.
  step(PRE, {
    stage: 20,
    typeName: 'Invented.Pre',
    images: [{ type: 0, alias: 'before', name: 'before', attributes: ['x_name'] }],
  }),
  // PostOperation, a plug-in type handler: a post-image of x_code only; it reads the variable through its context.
  step(POST, {
    stage: 40,
    typeName: 'Invented.Post',
    images: [{ type: 1, alias: 'after', name: 'after', attributes: ['x_code'] }],
  }),
  // Create PreOperation, a plug-in type handler that throws for one name (an InvalidPluginExecutionException).
  step(REFUSE, { message: 'Create', stage: 20, typeName: 'Invented.Refuse' }),
];

async function organization(t, level = 'full') {
  const store = await itemNoteOrganization(t, mapping);
  await store.transact(() =>
    store.insertRow('systemuser', (store.state.tables.systemuser ??= []), {
      systemuserid: USER,
      fullname: 'Invented context user',
      businessunitid: { id: UNIT, logical_name: 'businessunit' },
    }),
  );
  store.traces = createTraceStore({ settings: { level } });
  const seen = [];
  const handlers = new Map([
    [
      PRE,
      ({ sharedVariables }) => {
        sharedVariables.marker = 'from-pre-operation';
      },
    ],
    [
      'Invented.Post',
      ({ context, trace }) => {
        seen.push(context.SharedVariables.marker);
        trace(`marker ${context.SharedVariables.marker}`);
        context.SharedVariables.answer = 42;
      },
    ],
    [
      'Invented.Refuse',
      ({ target }) => {
        if (target.x_name === 'Refused') throw new Error('Invented rule refused the item.');
      },
    ],
  ]);
  const items = pluginCatalogue({ plugins: { steps: STEPS }, handlers });
  store.setPluginPipeline(
    (context) => runPluginPhase({ ...context, store, items, handlers }),
    ({ entity }) => entity === 'x_item',
  );
  return { store, sdk: localOrganizationService(store, profile), traces: store.traces, seen };
}

test('a step span names its record and carries its images by alias and filter, parameters, shared variables and context', async (t) => {
  const { sdk, traces, seen } = await organization(t);
  const { x_itemid: id } = sdk.create('x_item', { x_name: 'Old', x_code: 'A-1' });
  const root = traces.start({ kind: 'http', name: 'PATCH /invented', module: 'portal' });
  traces.run(root, () => sdk.update('x_item', id, { x_name: 'New', x_code: 'B-2' }));
  root.end();
  assert.deepEqual(seen, ['from-pre-operation'], 'the PostOperation step saw the PreOperation variable');

  const { spans } = traces.tree(root.traceId);
  const update = spans.find((span) => span.kind === 'dataverse' && span.entity === 'x_item');
  const stages = spans.filter((span) => span.kind === 'plugin-stage');
  const [pre, post] = [PRE, POST].map((stepId) => spans.find((span) => span.attributes.stepId === stepId));
  for (const span of [update, ...stages, pre, post]) assert.equal(span.recordId, id, `${span.kind} ${span.name}`);

  assert.deepEqual(pre.input.preImages, { before: { x_name: 'Old' } }, 'only the registered attribute');
  assert.deepEqual(pre.input.postImages, {});
  assert.equal(pre.input.inputParameters.Target.x_name, 'New');
  // The step's real context (exported-plugins.mjs typedContext): the platform's shared variables (IsAutoTransact,
  // AcceptLang) and the operation's correlation id.
  const platform = { IsAutoTransact: true, AcceptLang: '' };
  assert.deepEqual(pre.input.sharedVariables, platform);
  assert.match(pre.input.context.correlationId, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
  assert.deepEqual(pre.input.context, {
    messageName: 'Update',
    stage: 20,
    mode: 0,
    depth: 1,
    correlationId: pre.input.context.correlationId,
    initiatingUserId: USER,
    userId: USER,
    businessUnitId: UNIT,
    isolationMode: 2,
  });
  assert.deepEqual(pre.output.sharedVariables, { ...platform, marker: 'from-pre-operation' });

  assert.deepEqual(post.input.preImages, {});
  assert.deepEqual(post.input.postImages, { after: { x_code: 'B-2' } }, 'the saved row, limited to x_code');
  assert.deepEqual(post.input.sharedVariables, { ...platform, marker: 'from-pre-operation' });
  assert.equal(post.input.context.stage, 40);
  assert.deepEqual(post.output.sharedVariables, { ...platform, marker: 'from-pre-operation', answer: 42 });
  assert.equal('postImage' in post.output, false, 'the whole saved row is never the output');
  assert.deepEqual(
    post.events.filter((event) => event.type === 'trace').map((event) => event.message),
    ['marker from-pre-operation'],
  );
});

test('a create names its record before the PreOperation stage, so the stage and step spans carry it', async (t) => {
  const { store, sdk, traces } = await organization(t, 'summary');
  const root = traces.start({ kind: 'http', name: 'POST /invented', module: 'portal' });
  traces.run(root, () => sdk.create('x_item', { x_name: 'Accepted' }));
  root.end();
  const [{ x_itemid: id }] = store.tableRows('x_item');
  const { spans } = traces.tree(root.traceId);
  const named = spans.filter((span) => ['dataverse', 'plugin-stage', 'plugin-step'].includes(span.kind));
  assert.deepEqual(
    named.map((span) => [span.kind, span.recordId]),
    [
      ['dataverse', id],
      ['plugin-stage', id],
      ['plugin-step', id],
    ],
  );
  assert.equal(spans.find((span) => span.kind === 'plugin-step').input, undefined, 'summary keeps no payloads');
});

test('a plug-in fault records one identity on the step, the stage, the dispatch span and the request root', async (t) => {
  const { sdk, traces } = await organization(t, 'summary');
  const root = traces.start({ kind: 'http', name: 'POST /invented', module: 'portal' });
  let thrown;
  try {
    traces.run(root, () => sdk.create('x_item', { x_name: 'Refused' }));
  } catch (error) {
    thrown = error;
  }
  // The host answers its envelope from the thrown error and fails its root with it.
  root.fail(thrown);
  assert.equal(thrown.message, 'Invented rule refused the item.');
  assert.equal(thrown.details.innerCode, '0x80040265', 'the answer is the plug-in fault');
  const identity = {
    type: 'InvalidPluginExecutionException',
    code: '0x80040265',
    status: 'Failed',
    message: 'Invented rule refused the item.',
    pluginType: 'Invented.Refuse',
    step: REFUSE,
    stage: 20,
    depth: 1,
  };
  assert.deepEqual(thrown.traceError, identity);
  assert.equal(Object.keys(thrown).includes('traceError'), false, 'the identity never reaches the response body');
  const { spans } = traces.tree(root.traceId);
  const pick = (kind) => spans.find((span) => span.kind === kind);
  for (const kind of ['plugin-step', 'plugin-stage', 'dataverse', 'http']) {
    const span = pick(kind);
    assert.equal(span.status, 'error', kind);
    assert.deepEqual(span.error, identity, `${kind} records the plug-in fault identity`);
  }
});

test('a custom API plug-in fault has the same identity; the internal message entry is one span named by the message', async () => {
  const store = pingApiStore();
  const ops = [];
  const user = { systemuserid: USER, fullname: 'Invented flow user' };
  const api = {
    store,
    change: (fn) => fn(),
    records: {},
    registry: {
      register: (op) => ops.push(op),
      has: (name) => ops.some((o) => o.name === name),
      find: ({ name, kind }) => ops.find((o) => o.name === name && o.kind === kind) ?? null,
    },
    principals: { privileges: () => new Map(), byId: (id) => (id === USER ? user : null) },
  };
  installCustomApis(api, {
    handlers: customApiHandlers([
      {
        id: 'invented-pack',
        customApis: {
          fx_Ping: {
            pluginType: 'Invented.PingPlugin',
            handler: (ctx) => {
              if (ctx.inputs.Message === 'boom')
                throw { pluginFault: 'InvalidPluginExecutionException', message: 'Invented ping refused.' };
              return { outputs: { Reply: `pong ${ctx.inputs.Message}` } };
            },
          },
        },
      },
    ]),
  });
  const principal = {
    userId: USER,
    evidence: 'invented test grants',
    grants: [{ message: 'fx_Ping', operations: ['execute'] }],
  };
  const answer = await api.records.executeMessageInternal({
    principal,
    name: 'fx_Ping',
    parameters: { Message: 'hi' },
  });
  assert.deepEqual(answer, { statusCode: 200, body: { Reply: 'pong hi' } });
  const [message] = store.traces.spans({ kind: 'action' }).items;
  assert.deepEqual(
    [message.name, message.module, message.operation, message.status, message.attributes.message],
    ['fx_Ping', 'dataverse', 'fx_ping', 'ok', 'fx_Ping'],
  );
  assert.equal(message.attributes.systemUserId, USER, 'the systemuser the message runs as');
  assert.deepEqual(message.input, { parameters: { Message: 'hi' } });
  assert.equal(message.output.Reply, 'pong hi');
  const [ping] = store.traces.spans({ kind: 'custom-api' }).items;
  assert.equal(ping.parentSpanId, message.spanId, 'the custom API runs inside the message span');

  const failure = await api.records
    .executeMessageInternal({ principal, name: 'fx_Ping', parameters: { Message: 'boom' } })
    .catch((error) => error);
  const identity = {
    type: 'InvalidPluginExecutionException',
    code: '0x80040265',
    status: 'Failed',
    message: 'Invented ping refused.',
    pluginType: 'Invented.PingPlugin',
    step: store.tableRows('customapi')[0].customapiid,
    stage: 30,
    depth: 1,
  };
  assert.deepEqual(failure.traceError, identity);
  const failed = store.traces.spans({ kind: 'custom-api', status: 'error' }).items[0];
  assert.deepEqual(failed.error, identity, 'the custom-api span records the plug-in fault identity');
});

test('a CLR SDK create names its new record: never the empty GUID, and the created id as output', async (t) => {
  const { store, traces } = await organization(t);
  const root = traces.start({ kind: 'plugin-step', name: 'Invented CLR step', module: 'clr' });
  const created = traces.run(root, () =>
    dispatchSdkCall({
      store,
      profile,
      message: {
        method: 'Create',
        userId: USER,
        arguments: [
          {
            $type: 'Entity',
            logicalName: 'x_note',
            id: '00000000-0000-0000-0000-000000000000',
            attributes: { x_name: 'From CLR' },
          },
        ],
      },
    }),
  );
  root.end();
  const [call] = traces.spans({ kind: 'sdk-call' }).items;
  assert.equal(created.$type, 'Guid');
  assert.equal(call.recordId, created.value);
  assert.deepEqual(call.output, { type: 'Guid', id: created.value });
  const [{ x_noteid: id }] = store.tableRows('x_note');
  assert.equal(id, created.value);
});
