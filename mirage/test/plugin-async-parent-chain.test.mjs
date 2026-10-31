// @test-kind parity: native dataverse-recorder corpus (depth, crud, async, upsert, bulk, faults, ownerAndState, customApi): asynchronous job ParentContext, OperationCreatedOn, job creation order and the asynchronous web hook RemoteExecutionContext
// Invented schema, handlers and loopback receiver. Every asynchronous job is observed through an asynchronous web hook, whose
// RemoteExecutionContext is built from the same context the CLR pipeline gives an asynchronous plug-in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createOrganizationBackend } from '../lib/organization-backend.mjs';
import { pluginCatalogue } from '../lib/exported-plugins.mjs';
import { localOrganizationService } from '../lib/local-organization-service.mjs';
import { createScheduler, fixedClock } from '../lib/runtime-clock.mjs';
import { prepareClrRuntime } from '../lib/plugin-clr.mjs';
import { asyncMultipleJobParent, asynchronousParentChain } from '../lib/plugin-sdk-parent.mjs';
import { makeTemporaryDirectory, ownedFixture } from '../testing/owned-fixture.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';
import { ORDINARY_CLR_TIMEOUT_MS } from './fixtures/clr-budget.mjs';

const id = (n) => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CALLER = id(1),
  SYSTEM = id(2),
  ENDPOINT = id(3),
  CALLER_OBJECT = id(4);
const step = (n, message, stage, mode, extra = {}) => ({
  id: id(100 + n),
  enabled: true,
  name: `Invented ${message} ${stage} ${mode}`,
  entity: 'x_node',
  message,
  stage,
  mode,
  rank: 1,
  supportedDeployment: 0,
  filteringAttributes: [],
  images: [],
  ...extra,
});
const webhook = (n, message) => step(n, message, 40, 1, { serviceEndpointId: ENDPOINT });

async function organization(t, steps, handlers = new Map(), { runtimes = new Map() } = {}) {
  const received = [];
  const receiver = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      received.push(JSON.parse(Buffer.concat(chunks)));
      response.writeHead(200).end();
    });
  });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const state = emptyState(),
    text = { dataverseType: 'nvarchar' };
  state.mappings.x_node = {
    logicalName: 'x_node',
    entitySet: 'x_nodes',
    idColumn: 'x_nodeid',
    nameColumn: 'x_name',
    fields: { x_name: text, x_level: { dataverseType: 'int' } },
  };
  state.tables.x_node = [];
  state.tables.systemuser = [
    { systemuserid: CALLER, fullname: 'Invented caller', azureactivedirectoryobjectid: CALLER_OBJECT },
    { systemuserid: SYSTEM, fullname: 'SYSTEM' },
  ];
  state.tables.serviceendpoint = [
    { serviceendpointid: ENDPOINT, contract: 8, authtype: 0, url: `http://127.0.0.1:${receiver.address().port}/hook` },
  ];
  state.dataverse = { uniqueName: 'invented_unique' };
  const clock = fixedClock(Date.parse('2030-01-02T03:04:05.678Z')),
    store = new DataStore({ state, clock }),
    scheduler = createScheduler({ clock, manual: true }),
    descriptors = new Map([...runtimes].map(([key, runtime]) => [key, runtime.descriptor])),
    items = pluginCatalogue({
      plugins: { steps },
      handlers,
      runtimes,
      descriptors,
      overrides: Object.fromEntries([...runtimes.keys()].map((key) => ['plugin-step:' + key, { mode: 'clr' }])),
    });
  const backend = await createOrganizationBackend({
    store,
    items: () => items,
    handlers,
    runtimes,
    descriptors,
    scheduler,
  });
  t.after(async () => {
    await backend.close();
    store.close();
    await new Promise((resolve) => {
      receiver.close(resolve);
      receiver.closeAllConnections();
    });
  });
  const settle = async () => {
    await scheduler.runDue();
    await backend.asyncPluginRunner.drain();
  };
  return { store, clock, settle, received };
}
const identity = { admin: true, systemUserId: CALLER };
const labels = (context) => {
  const chain = [];
  for (let frame = context.ParentContext; frame; frame = frame.ParentContext)
    chain.push(`${frame.MessageName}/${frame.Stage}`);
  return chain;
};
const parameters = (list) => Object.fromEntries(list.map(({ key, value }) => [key, value]));
const assertJobFrames = (context) => {
  for (let frame = context.ParentContext; frame; frame = frame.ParentContext) {
    assert.equal(frame.Mode, 1);
    assert.equal(frame.Depth, context.Depth);
    assert.equal(frame.MessageName, context.MessageName);
    assert.equal(frame.PrimaryEntityId, context.PrimaryEntityId);
    assert.equal(frame.OperationId, context.OperationId);
    assert.equal(frame.OperationCreatedOn, context.OperationCreatedOn);
    assert.equal(frame.IsInTransaction, false);
    assert.equal(frame.IsolationMode, context.IsolationMode);
    assert.deepEqual(frame.OwningExtension, context.OwningExtension);
    assert.deepEqual(frame.PreEntityImages, []);
    assert.deepEqual(frame.PostEntityImages, []);
  }
};

// Native depth.json: OperationCreatedOn is whole seconds everywhere; each nested Create's job is created when its
// PostOperation begins, so jobs are created outer-first and their creation time rises with Depth; a job's parent chain
// never exceeds three frames, each relabelled as the job (mode 1, its Depth, message, row, step, operation id and time,
// outside a transaction, no images).
test('nested record operations queue outer-first whole-second jobs whose parent chain stops at three frames', async (t) => {
  let service, clock;
  const handlers = new Map([
    [
      'Invented.Recurse',
      ({ record }) => {
        if (record.x_level >= 4) return;
        // Each nested level starts one second later, as in the native chain.
        clock.advance(1000);
        service.create('x_node', { x_name: `level ${record.x_level + 1}`, x_level: record.x_level + 1 });
      },
    ],
  ]);
  const org = await organization(
    t,
    [step(1, 'Create', 40, 0, { typeName: 'Invented.Recurse', assemblyId: 'invented' }), webhook(2, 'Create')],
    handlers,
  );
  const { store, settle, received } = org;
  clock = org.clock;
  service = localOrganizationService(store, {
    userId: CALLER,
    evidence: 'Invented nested caller',
    grants: [{ entity: 'x_node', operations: ['read', 'create'] }],
  });
  await store.create('x_node', { x_name: 'level 1', x_level: 1 }, identity);
  const jobs = store.tableRows('asyncoperation');
  assert.deepEqual(
    jobs.map((job) => job.depth),
    [1, 2, 3, 4],
  );
  for (const job of jobs) assert.match(job.createdon, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/);
  assert.ok(
    jobs.every((job, index) => index === 0 || Date.parse(job.createdon) > Date.parse(jobs[index - 1].createdon)),
  );
  await settle();
  assert.equal(received.length, 4);
  for (const context of received) {
    const job = jobs.find((row) => row.asyncoperationid === context.OperationId);
    assert.ok(job, 'OperationId is the System Job');
    assert.equal(context.OperationCreatedOn, `/Date(${Date.parse(job.createdon)}+0000)/`);
    assert.equal(labels(context)[0], 'Create/30');
    assert.ok(labels(context).length <= 3);
    assertJobFrames(context);
  }
});

// Native depth.json with an original CLR PostOperation step creating the next row: Depth 1 jobs report X/30 and deeper
// jobs X/30 < X/40 < X/30 (the main operation, the calling step, the caller's main operation), never more.
test(
  'an original CLR chain of nested Creates gives every deeper job the native three-frame parent',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paq-async-chain-')),
      source = path.join(root, 'Recurse.cs'),
      sdk = clrSdk();
    ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
    await fs.writeFile(
      source,
      `using System;using Microsoft.Xrm.Sdk;namespace Invented{public sealed class Recurse:IPlugin{public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));var t=(Entity)c.InputParameters["Target"];var level=t.GetAttributeValue<int>("x_level");if(level>=4)return;var s=((IOrganizationServiceFactory)p.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId);var n=new Entity("x_node");n["x_name"]="level "+(level+1);n["x_level"]=level+1;s.Create(n);}}}`,
    );
    compileClr(source, path.join(root, 'Recurse.dll'), { references: [sdk] });
    const runtime = await prepareClrRuntime({
      trust: 'execute-local-assembly',
      root,
      assembly: 'Recurse.dll',
      typeName: 'Invented.Recurse',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, 'cache'),
      timeoutMs: ORDINARY_CLR_TIMEOUT_MS,
      serviceProfile: {
        userId: CALLER,
        evidence: 'Invented nested CLR caller',
        grants: [{ entity: 'x_node', operations: ['read', 'create'] }],
      },
      context: { initiatingUserId: CALLER, organizationId: id(5), businessUnitId: id(6) },
    });
    const recurse = step(1, 'Create', 40, 0, { typeName: 'Invented.Recurse', assemblyId: 'invented' });
    const { store, settle, received } = await organization(
      t,
      [recurse, webhook(2, 'Create'), webhook(3, 'CreateMultiple')],
      new Map(),
      { runtimes: new Map([[recurse.id, runtime]]) },
    );
    await store.create('x_node', { x_name: 'level 1', x_level: 1 }, identity);
    await settle();
    const creates = received.filter((context) => context.MessageName === 'Create'),
      multiples = received.filter((context) => context.MessageName === 'CreateMultiple');
    const native = (message) => [
      [`${message}/30`],
      [`${message}/30`, `${message}/40`, `${message}/30`],
      [`${message}/30`, `${message}/40`, `${message}/30`],
      [`${message}/30`, `${message}/40`, `${message}/30`],
    ];
    assert.deepEqual(creates.toSorted((a, b) => a.Depth - b.Depth).map(labels), native('Create'));
    for (const context of creates) assertJobFrames(context);
    // @parity-evidence: native depth.json CreateMultiple asynchronous jobs (Depth 2-10: CreateMultiple/30 < CreateMultiple/40 < CreateMultiple/30, PrimaryEntityId the single row), also faults.json and pipelineEffects.json
    // A CreateMultiple step bridged from each nested Create reports the same frames as CreateMultiple, naming the
    // single row (native depth.json CreateMultiple asynchronous jobs).
    assert.deepEqual(multiples.toSorted((a, b) => a.Depth - b.Depth).map(labels), native('CreateMultiple'));
    for (const context of multiples) {
      const row = parameters(context.ParentContext.InputParameters).Target.Id;
      for (let frame = context.ParentContext; frame; frame = frame.ParentContext) {
        assert.equal(frame.Mode, 1);
        assert.equal(frame.Depth, context.Depth);
        assert.equal(frame.PrimaryEntityId, row);
      }
    }
  },
);

// Native crud, async and upsert asynchronous web hook payloads: the 30 RemoteExecutionContext properties, with the
// caller's Entra object ids and user agent, the organization's unique name, the Create 'id' output, the platform's
// AsynchronousStepPrimaryName image (pre for Delete), no Update ConcurrencyBehavior input, the job's main operation as
// the parent, Delete running as SYSTEM, and OperationCreatedOn as whole seconds with the zero offset.
test('asynchronous record web hooks carry the context the asynchronous plug-in pipeline builds', async (t) => {
  const { store, settle, received } = await organization(t, [
    webhook(1, 'Create'),
    webhook(2, 'Update'),
    webhook(3, 'Delete'),
  ]);
  const caller = { ...identity, dataverse: { callerId: CALLER, userAgent: 'invented-agent' } };
  const row = await store.create('x_node', { x_name: 'webhook row', x_level: 1 }, caller);
  await settle();
  await store.update('x_node', row.x_nodeid, { x_name: 'renamed' }, caller);
  await settle();
  await store.remove('x_node', row.x_nodeid, caller);
  await settle();
  assert.deepEqual(
    received.map((context) => context.MessageName),
    ['Create', 'Update', 'Delete'],
  );
  const [create, update, remove] = received;
  for (const context of received) {
    assert.equal(Object.keys(context).length, 30);
    assert.equal(context.Mode, 1);
    assert.equal(context.IsInTransaction, false);
    assert.equal(context.OrganizationName, 'invented_unique');
    assert.equal(context.InitiatingUserId, CALLER);
    assert.equal(context.InitiatingUserAzureActiveDirectoryObjectId, CALLER_OBJECT);
    assert.equal(context.InitiatingUserAgent, 'invented-agent');
    assert.match(context.OperationCreatedOn, /^\/Date\(\d+000\+0000\)\/$/);
    assert.deepEqual(labels(context), [`${context.MessageName}/30`]);
    assertJobFrames(context);
  }
  assert.deepEqual(create.OutputParameters, [{ key: 'id', value: row.x_nodeid }]);
  assert.equal(create.UserId, CALLER);
  assert.equal(create.UserAzureActiveDirectoryObjectId, CALLER_OBJECT);
  assert.deepEqual(
    create.PostEntityImages.map((image) => image.key),
    ['AsynchronousStepPrimaryName'],
  );
  assert.deepEqual(parameters(create.PostEntityImages[0].value.Attributes), {
    x_name: 'webhook row',
    x_nodeid: row.x_nodeid,
  });
  assert.deepEqual(
    update.InputParameters.map(({ key }) => key),
    ['Target'],
  );
  assert.deepEqual(
    update.PostEntityImages.map((image) => image.key),
    ['AsynchronousStepPrimaryName'],
  );
  assert.equal(remove.UserId, SYSTEM);
  assert.deepEqual(remove.PostEntityImages, []);
  assert.deepEqual(
    remove.PreEntityImages.map((image) => image.key),
    ['AsynchronousStepPrimaryName'],
  );
});

// Native customApi and ownerAndState: a message without a main-operation model (a custom API called from a
// PostOperation step, SetStateDynamicEntity under an Upsert) reports its synchronous caller chain relabelled as the
// job, cut after three frames: new_RecorderApi/40 < new_RecorderApi/30 for a call made from an Update PostOperation step.
test('an asynchronous named message job reports its synchronous caller chain as its own frames', async (t) => {
  const { store, settle, received } = await organization(t, [webhook(1, 'Assign')]);
  const row = await store.create('x_node', { x_name: 'assigned', x_level: 1 }, identity);
  const frame = (stage, parent) => ({
    $type: 'ExecutionContext',
    values: {
      MessageName: 'Update',
      Stage: stage,
      Mode: 0,
      Depth: 1,
      PrimaryEntityName: 'x_node',
      PrimaryEntityId: { $type: 'Guid', value: row.x_nodeid },
      InputParameters: {
        $type: 'ParameterCollection',
        values: { Target: { $type: 'EntityReference', logicalName: 'x_node', id: row.x_nodeid } },
      },
      OutputParameters: { $type: 'ParameterCollection', values: {} },
      SharedVariables: { $type: 'ParameterCollection', values: {} },
      UserId: { $type: 'Guid', value: CALLER },
      InitiatingUserId: { $type: 'Guid', value: CALLER },
      OperationCreatedOn: { $type: 'DateTime', value: '2030-01-02T03:04:05' },
      IsInTransaction: true,
      ParentContext: parent,
    },
  });
  // The PostOperation step that issued the message, under its main operation and two further ancestors.
  const caller = frame(40, frame(30, frame(30, frame(20, null))));
  await store.withOperationContext(
    () =>
      store.transact(() => {
        store.pluginParentContext = caller;
        try {
          store.recordCommittedEvent('x_node', 'assign', store.tableRows('x_node')[0], [], {
            target: {},
            identity,
            messageEvent: true,
            frame: { operationDepth: 2 },
          });
        } finally {
          store.pluginParentContext = null;
        }
      }),
    { fresh: true },
  );
  await settle();
  assert.equal(received.length, 1);
  const [context] = received;
  assert.equal(context.MessageName, 'Assign');
  assert.deepEqual(labels(context), ['Assign/40', 'Assign/30', 'Assign/30']);
  assertJobFrames(context);
  for (let parent = context.ParentContext; parent; parent = parent.ParentContext)
    assert.equal(parent.PrimaryEntityName, 'x_node');
});

// Native depth.json and crud: a bridged CreateMultiple/UpdateMultiple job's parent frames report the job's identities
// (user, initiating user, business unit, organization), although the queued single operation kept only its request.
test('a bridged multiple job parent reports the job identities', () => {
  const guid = (value) => ({ $type: 'Guid', value });
  const context = {
    MessageName: 'CreateMultiple',
    Depth: 2,
    PrimaryEntityId: guid('00000000-0000-0000-0000-000000000000'),
    IsolationMode: 2,
    OwningExtension: { $type: 'EntityReference', logicalName: 'sdkmessageprocessingstep', id: id(9), name: null },
    OperationId: guid(id(10)),
    OperationCreatedOn: { $type: 'DateTime', value: '2030-01-02T03:04:05' },
    UserId: guid(CALLER),
    InitiatingUserId: guid(CALLER),
    BusinessUnitId: guid(id(11)),
    OrganizationId: guid(id(12)),
    OrganizationName: 'invented_unique',
    SecondaryEntityName: 'none',
  };
  const frame = {
    asyncSourceParent: {
      primaryId: id(13),
      inputParameters: { $type: 'ParameterCollection', values: {} },
    },
    operationDepth: 2,
    operationId: id(10),
    asyncCallerParent: {
      $type: 'ExecutionContext',
      values: { MessageName: 'Create', Stage: 40, UserId: guid(SYSTEM), ParentContext: null },
    },
  };
  const parent = asyncMultipleJobParent(frame, 'createmultiple', 'x_node', context);
  assert.equal(parent.values.PrimaryEntityId.value, id(13));
  for (const key of [
    'UserId',
    'InitiatingUserId',
    'BusinessUnitId',
    'OrganizationId',
    'OrganizationName',
    'SecondaryEntityName',
  ])
    assert.deepEqual(parent.values[key], context[key], key);
  // A caller frame keeps its own identities.
  assert.deepEqual(parent.values.ParentContext.values.UserId, guid(SYSTEM));
  assert.equal(parent.values.ParentContext.values.MessageName, 'CreateMultiple');
});

// @parity-evidence: native depth.json Depth 3 Create job: ParentContext.ParentContext (Create/40) PostEntityImagesCollection holds AsynchronousStepPrimaryName (all 18 deeper jobs); frames share the job correlation
// Native depth.json: in a Depth 3 job's parent chain the calling Create/40 frame keeps its Context4 post collection
// (AsynchronousStepPrimaryName) and every frame reports the job's correlation; only step images are empty.
test('an asynchronous parent frame keeps its image collections and takes the job correlation', () => {
  const guid = (value) => ({ $type: 'Guid', value });
  const collection = {
    $type: 'EntityImageCollectionArray',
    values: [
      {
        $type: 'EntityImageCollection',
        values: { AsynchronousStepPrimaryName: { $type: 'Entity', logicalName: 'x_node', id: id(20), attributes: {} } },
      },
    ],
  };
  const caller = {
    $type: 'ExecutionContext',
    values: {
      MessageName: 'Create',
      Stage: 40,
      CorrelationId: guid(id(21)),
      PostEntityImages: { $type: 'EntityImageCollection', values: { post: {} } },
      PostEntityImagesCollection: collection,
      ParentContext: null,
    },
  };
  const chain = asynchronousParentChain(caller, {
    MessageName: 'Create',
    Depth: 3,
    PrimaryEntityId: guid(id(22)),
    IsolationMode: 2,
    OwningExtension: { $type: 'EntityReference', logicalName: 'sdkmessageprocessingstep', id: id(23), name: null },
    OperationId: guid(id(24)),
    CorrelationId: guid(id(25)),
  });
  assert.deepEqual(chain.values.PostEntityImagesCollection, collection);
  assert.deepEqual(chain.values.PostEntityImages, { $type: 'EntityImageCollection', values: {} });
  assert.deepEqual(chain.values.CorrelationId, guid(id(25)));
});
