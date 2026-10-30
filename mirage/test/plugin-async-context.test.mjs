// @test-kind unproven: local model of async System Job context metadata, retry identity and webhook payload timing; no cited native recording
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createAsyncPluginRunner } from '../lib/plugin-async.mjs';
import { createOrganizationBackend } from '../lib/organization-backend.mjs';
import { pluginCatalogue, runPluginPhase } from '../lib/exported-plugins.mjs';
import { localOrganizationService } from '../lib/local-organization-service.mjs';
import { prepareClrRuntime, closeClrHostPool } from '../lib/plugin-clr.mjs';
import { serviceEndpointDelivery, remoteExecutionContext } from '../lib/dataverse-webhooks.mjs';
import { createScheduler, fixedClock } from '../lib/runtime-clock.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';
import { ORDINARY_CLR_TIMEOUT_MS } from './fixtures/clr-budget.mjs';

const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sourceFrame = {
  operationId: id(90),
  requestId: id(91),
  createdOn: '2001-01-01T00:00:00.000Z',
  createdOnWire: { $type: 'DateTime', value: '2001-01-01T00:00:00.0000000' },
};
const step = (n, extra = {}) => ({
  id: id(n),
  name: 'Invented async identity',
  enabled: true,
  entity: 'widget',
  message: 'Create',
  stage: 40,
  rank: n,
  mode: 1,
  supportedDeployment: 0,
  assemblyId: 'invented',
  typeName: 'Invented.AsyncIdentity',
  filteringAttributes: [],
  images: [],
  ...extra,
});
async function makeStore({ file, clock = fixedClock() } = {}) {
  const state = emptyState();
  state.mappings.widget = { entitySet: 'widgets', idColumn: 'widgetid' };
  state.tables.widget = [{ widgetid: id(1), title: 'Committed caller' }];
  return new DataStore({ state, file, clock }).init();
}
async function webhookReceiver() {
  const received = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      received.push(JSON.parse(Buffer.concat(chunks)));
      response.end('accepted');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, received };
}
const queue = (store, frame = sourceFrame) =>
  store.transact(() =>
    store.recordCommittedEvent('widget', 'create', store.tableRows('widget')[0], ['title'], {
      target: { title: 'Committed caller' },
      identity: { admin: true, systemUserId: id(2) },
      frame,
    }),
  );

test('async-only implicit multiple steps retain the known source request metadata with a fresh multiple-message contract', async (t) => {
  for (const operation of ['create', 'update']) {
    await t.test(operation, async (t) => {
      const clock = fixedClock(),
        store = await makeStore({ clock }),
        scheduler = createScheduler({ clock, manual: true }),
        seen = [];
      const handlers = new Map([
        [
          'Invented.AsyncIdentity',
          ({ context }) => {
            seen.push(context);
          },
        ],
      ]);
      const items = pluginCatalogue({
        plugins: { steps: [step(3, { message: operation === 'create' ? 'CreateMultiple' : 'UpdateMultiple' })] },
        handlers,
      });
      const backend = await createOrganizationBackend({ store, items: () => items, handlers, scheduler });
      let source;
      store.addCommitStager((events) => {
        source = events.find((event) => event.operation === operation);
      });
      t.after(async () => {
        await backend.close();
        store.close();
      });
      await store.withOperationContext(
        () => {
          store.pluginSdkTag = 'invented canonical multiple tag';
          store.pluginRequestId = id(99);
          return operation === 'create'
            ? store.create('widget', { title: 'Created' }, { admin: true })
            : store.update('widget', id(1), { title: 'Updated' }, { admin: true });
        },
        { fresh: true },
      );
      assert.equal(source.frame.multipleFrame, undefined, 'no synchronous multiple step manufactured a frame');
      assert.ok(source.frame.requestId);
      assert.notEqual(source.frame.requestId, id(99));
      const job = store.tableRows('asyncoperation')[0],
        queuedTime = job.createdon;
      assert.equal(job.requestid, source.frame.requestId);
      clock.advance(15_000);
      await scheduler.runDue();
      await backend.asyncPluginRunner.drain();
      assert.equal(seen.length, 1);
      const context = seen[0];
      assert.equal(context.RequestId, source.frame.requestId);
      assert.ok(context.CorrelationId);
      assert.equal(context.SharedVariables.tag, 'invented canonical multiple tag');
      assert.equal(context.OperationId, job.asyncoperationid);
      assert.notEqual(context.OperationId, source.frame.operationId);
      assert.equal(context.OperationCreatedOn, queuedTime.replace(/Z$/, ''));
      assert.equal(Object.hasOwn(context.InputParameters, 'Target'), false);
      assert.equal(context.InputParameters.Targets.length, 1);
      // Native recorder corpus crud/depth: the queued CreateMultiple job of a single Create has the Create's id output.
      assert.equal(Object.hasOwn(context.OutputParameters, 'id'), operation === 'create');
      assert.equal(store.tableRows('asyncoperation')[0].statuscode, 30);
      assert.equal(store.pluginSdkTag, undefined);
    });
  }
});

test('typed async contexts bind each actual System Job identity and creation time while retaining a distinct request identity', async (t) => {
  const clock = fixedClock(),
    store = await makeStore({ clock }),
    scheduler = createScheduler({ clock, manual: true });
  store.scheduler = scheduler;
  const seen = [],
    handlers = new Map([
      [
        'Invented.AsyncIdentity',
        ({ context, step }) => {
          const job = store.tableRows('asyncoperation').find((row) => row.owningextensionid.id === step.id);
          assert.equal(context.OperationId, job.asyncoperationid);
          assert.equal(context.OperationCreatedOn, job.createdon.replace(/Z$/, ''));
          assert.equal(context.RequestId, sourceFrame.requestId);
          assert.notEqual(context.OperationId, context.RequestId);
          assert.equal(job.requestid, sourceFrame.requestId);
          assert.equal(context.IsInTransaction, false);
          seen.push(context.OperationId);
        },
      ],
    ]);
  const items = pluginCatalogue({ plugins: { steps: [step(3), step(4)] }, handlers });
  const runner = createAsyncPluginRunner({
    store,
    items: () => items,
    handlers,
    runtimes: new Map(),
    systemJobs: () => true,
  });
  t.after(async () => {
    await runner.close();
    await scheduler.close();
    store.close();
  });
  await queue(store);
  const jobs = store.tableRows('asyncoperation').map((row) => ({ id: row.asyncoperationid, created: row.createdon }));
  clock.advance(90_000);
  await scheduler.runDue();
  assert.deepEqual(
    seen,
    jobs.map((job) => job.id),
  );
  assert.ok(store.tableRows('asyncoperation').every((row) => row.statuscode === 30));
  assert.equal(new Set(seen).size, 2);
  assert.equal(sourceFrame.operationId, id(90), 'the originating synchronous frame was not overwritten');
});

// @test-kind parity: native recorder corpus crud (async UpdateMultiple/40/m1 beside Update/40/m1 of the same PATCH): the multiple job sees the single job's request, shared variables and row under its own System Job identity
test('a queued multiple job runs the saved single-message frame under its own message name and System Job', async (t) => {
  const store = await makeStore(),
    scheduler = createScheduler({ clock: store.clock, manual: true }),
    seen = [];
  store.scheduler = scheduler;
  const handlers = new Map([
      [
        'Invented.AsyncIdentity',
        ({ context }) => {
          seen.push(context);
        },
      ],
    ]),
    items = pluginCatalogue({
      plugins: { steps: [step(3, { message: 'Update' }), step(4, { message: 'UpdateMultiple' })] },
      handlers,
    }),
    runner = createAsyncPluginRunner({
      store,
      items: () => items,
      handlers,
      runtimes: new Map(),
      systemJobs: () => true,
    });
  t.after(async () => {
    await runner.close();
    await scheduler.close();
    store.close();
  });
  await store.transact(() =>
    store.recordCommittedEvent('widget', 'update', store.tableRows('widget')[0], ['title'], {
      target: { title: 'Updated' },
      identity: { admin: true },
      frame: {
        ...sourceFrame,
        requestTag: 'source canonical',
        sharedVariables: { $type: 'ParameterCollection', values: { tag: 'source canonical', shared: 'from 20' } },
      },
    }),
  );
  await scheduler.runDue();
  await runner.drain();
  const jobs = store.tableRows('asyncoperation');
  assert.deepEqual(
    jobs.map((job) => [job.messagename, job.statuscode]),
    [
      ['Update', 30],
      ['UpdateMultiple', 30],
    ],
  );
  assert.deepEqual(
    seen.map((context) => context.MessageName),
    ['Update', 'UpdateMultiple'],
  );
  const [single, multiple] = seen;
  for (const [index, context] of seen.entries()) {
    assert.equal(context.RequestId, sourceFrame.requestId);
    assert.equal(context.OperationId, jobs[index].asyncoperationid);
    assert.equal(context.OperationCreatedOn, jobs[index].createdon.replace(/Z$/, ''));
    assert.equal(context.PrimaryEntityId, id(1));
    assert.deepEqual(context.SharedVariables, { tag: 'source canonical', shared: 'from 20' });
  }
  assert.notEqual(single.OperationId, multiple.OperationId);
  assert.equal(Object.hasOwn(multiple.InputParameters, 'Target'), false);
  assert.equal(multiple.InputParameters.Targets.length, 1);
  assert.equal(multiple.InputParameters.Targets[0].id, id(1));
  assert.equal(multiple.InputParameters.Targets[0].attributes.title, single.InputParameters.Target.title);
});

test('queued multiple execution preserves the actual originating SDK depth independently of the flow chain counter', async (t) => {
  for (const nestedSdk of [false, true])
    await t.test(
      nestedSdk ? 'SDK child of a depth-one handler' : 'top-level HTTP-shaped record operation',
      async (t) => {
        const store = await makeStore(),
          scheduler = createScheduler({ clock: store.clock, manual: true }),
          seen = [];
        store.state.mappings.parent = { entitySet: 'parents', idColumn: 'parentid' };
        store.state.tables.parent = [];
        const profile = {
          userId: id(2),
          evidence: 'Invented nested async source',
          grants: [{ entity: 'widget', operations: ['create'] }],
        };
        const handlers = new Map([
          [
            'Invented.AsyncIdentity',
            ({ context }) => {
              seen.push(context);
            },
          ],
          [
            'Invented.DepthParent',
            ({ context }) => {
              assert.equal(context.Depth, 1);
              localOrganizationService(store, profile).create('widget', { title: 'SDK-created' });
            },
          ],
        ]);
        const items = pluginCatalogue({
          plugins: {
            steps: [
              step(3, { message: 'CreateMultiple' }),
              step(4, { entity: 'parent', typeName: 'Invented.DepthParent', mode: 0, stage: 20 }),
            ],
          },
          handlers,
        });
        const backend = await createOrganizationBackend({ store, items: () => items, handlers, scheduler });
        t.after(async () => {
          await backend.close();
          store.close();
        });
        await store.create(
          nestedSdk ? 'parent' : 'widget',
          { title: 'Originating request' },
          { admin: true, systemUserId: id(2) },
        );
        const job = store.tableRows('asyncoperation')[0];
        assert.equal(job.depth, nestedSdk ? 2 : 1);
        await scheduler.runDue();
        await backend.asyncPluginRunner.drain();
        assert.equal(seen.length, 1);
        assert.equal(seen[0].Depth, job.depth);
        assert.equal(seen[0].IsInTransaction, false);
        const parent = seen[0].ParentContext;
        assert.equal(parent.MessageName, 'CreateMultiple');
        assert.equal(parent.Stage, 30);
        assert.equal(parent.Mode, 1);
        assert.equal(parent.Depth, job.depth);
        assert.equal(parent.OperationId, job.asyncoperationid);
        assert.equal(parent.RequestId, seen[0].RequestId);
        assert.equal(parent.OperationCreatedOn, seen[0].OperationCreatedOn);
        assert.equal(parent.InputParameters.Target.widgetid, parent.PrimaryEntityId);
        assert.equal(seen[0].SharedVariables.AcceptLang, '');
        assert.equal(seen[0].SharedVariables.IsAutoTransact, true);
        assert.equal(seen[0].SharedVariables.DefaultsAddedFlag, true);
        assert.equal(job.statuscode, 30, job.message);
      },
    );
});

test('an actual loopback webhook payload uses its queued System Job metadata rather than delivery time', async (t) => {
  const { server, received } = await webhookReceiver();
  const clock = fixedClock(),
    store = await makeStore({ clock }),
    scheduler = createScheduler({ clock, manual: true });
  store.scheduler = scheduler;
  store.state.tables.serviceendpoint = [
    { serviceendpointid: id(5), contract: 8, authtype: 0, url: `http://127.0.0.1:${server.address().port}/hook` },
  ];
  const items = pluginCatalogue({
    plugins: { steps: [step(6, { serviceEndpointId: id(5), typeName: null, assemblyId: null })] },
  });
  const runner = createAsyncPluginRunner({
    store,
    items: () => items,
    handlers: new Map(),
    runtimes: new Map(),
    webhooks: serviceEndpointDelivery(store),
    systemJobs: () => true,
  });
  t.after(async () => {
    await runner.close();
    await scheduler.close();
    store.close();
    await new Promise((resolve) => server.close(resolve));
  });
  await queue(store);
  const job = store.tableRows('asyncoperation')[0],
    expectedId = job.asyncoperationid,
    expectedCreated = job.createdon;
  clock.advance(120_000);
  await scheduler.runDue();
  await runner.drain();
  assert.equal(received.length, 1);
  assert.equal(received[0].OperationId, expectedId);
  assert.equal(received[0].OperationCreatedOn, `/Date(${Date.parse(expectedCreated)})/`);
  assert.equal(received[0].RequestId, sourceFrame.requestId);
  assert.notEqual(received[0].OperationId, received[0].RequestId);
  assert.equal(store.tableRows('asyncoperation')[0].statuscode, 30);
  const suppliedOnly = { suppliedRequestId: id(92) };
  const payload = (initialFrame) =>
    remoteExecutionContext(store, {
      item: items[0],
      entity: 'widget',
      operation: 'create',
      stage: 40,
      record: store.tableRows('widget')[0],
      target: {},
      identity: {},
      depth: 1,
      correlationId: id(93),
      initialFrame,
    });
  assert.equal(payload(suppliedOnly).RequestId, null, 'authored transport metadata cannot invent pipeline identity');
  assert.equal(payload({ ...suppliedOnly, requestId: sourceFrame.requestId }).RequestId, sourceFrame.requestId);
});

test('missing queued creation metadata fails explicitly before any original handler can execute', async (t) => {
  for (const [column, message] of [
    ['createdon', /no valid creation timestamp/],
    ['depth', /no valid execution depth/],
  ])
    await t.test(column, async (t) => {
      const clock = fixedClock(),
        store = await makeStore({ clock }),
        scheduler = createScheduler({ clock, manual: true });
      store.scheduler = scheduler;
      let calls = 0;
      const handlers = new Map([
        [
          'Invented.AsyncIdentity',
          () => {
            calls++;
          },
        ],
      ]);
      const items = pluginCatalogue({ plugins: { steps: [step(7)] }, handlers });
      const runner = createAsyncPluginRunner({
        store,
        items: () => items,
        handlers,
        runtimes: new Map(),
        systemJobs: () => true,
      });
      t.after(async () => {
        await runner.close();
        await scheduler.close();
        store.close();
      });
      await queue(store, { suppliedRequestId: id(92) });
      assert.equal(Object.hasOwn(store.tableRows('asyncoperation')[0], 'requestid'), false);
      await store.transact(() => {
        delete store.tableRows('asyncoperation')[0][column];
      });
      await scheduler.runDue();
      assert.equal(calls, 0);
      assert.equal(store.tableRows('asyncoperation')[0].statuscode, 31);
      assert.match(store.tableRows('asyncoperation')[0].message, message);
    });
});

test('a sync nested webhook retains known operation metadata and UTC components under a non-UTC host timezone', async (t) => {
  const previousZone = process.env.TZ;
  process.env.TZ = 'America/New_York';
  t.after(() => {
    if (previousZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousZone;
  });
  const noZone = '2026-06-01T12:34:56.1234567';
  const expectedTime = Date.parse(noZone + 'Z');
  assert.notEqual(Date.parse(noZone), expectedTime, 'the control actually runs with a different local offset');
  const { server, received } = await webhookReceiver();
  const clock = fixedClock(),
    store = await makeStore({ clock });
  store.state.tables.serviceendpoint = [
    { serviceendpointid: id(60), contract: 8, authtype: 0, url: `http://127.0.0.1:${server.address().port}/hook` },
  ];
  t.after(async () => {
    store.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const parent = {
    $type: 'ExecutionContext',
    values: {
      RequestId: { $type: 'Guid', value: id(61) },
      OperationId: { $type: 'Guid', value: id(62) },
      OperationCreatedOn: { $type: 'DateTime', value: noZone },
    },
  };
  const initialFrame = { requestId: id(61), operationId: id(62), createdOn: noZone };
  clock.advance(120_000);
  await store.withOperationContext(
    async () => {
      store.pluginParentContext = parent;
      store.pluginInTransaction = true;
      await serviceEndpointDelivery(store).send({
        item: step(63, { mode: 0, serviceEndpointId: id(60), typeName: null, assemblyId: null }),
        entity: 'widget',
        operation: 'create',
        stage: 20,
        target: {},
        record: store.tableRows('widget')[0],
        identity: { admin: true, systemUserId: id(2) },
        initialFrame,
        depth: 2,
        correlationId: id(64),
      });
    },
    { fresh: true },
  );
  assert.equal(received.length, 1);
  assert.equal(received[0].Mode, 0);
  assert.equal(received[0].OperationId, id(62));
  assert.equal(received[0].OperationCreatedOn, `/Date(${expectedTime})/`);
  assert.equal(received[0].RequestId, id(61));
  assert.equal(received[0].ParentContext.OperationId, id(62));
  assert.equal(received[0].ParentContext.OperationCreatedOn, `/Date(${expectedTime})/`);
  assert.equal(received[0].ParentContext.RequestId, id(61));
});

test(
  'original CLR retry and restart retain the same job operation identity, timestamp and separate originating request',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paq-async-context-'));
    const stores = [],
      runners = [],
      schedulers = [];
    let runtime, syncRuntime;
    t.after(async () => {
      for (const runner of runners) await runner.close();
      if (runtime) await closeClrHostPool({ runtime });
      if (syncRuntime) await closeClrHostPool({ runtime: syncRuntime });
      for (const scheduler of schedulers) await scheduler.close();
      for (const store of stores) store.close();
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
    });
    const sdk = clrSdk(),
      source = path.join(root, 'Identity.cs'),
      assembly = path.join(root, 'Identity.dll'),
      log = path.join(root, 'attempts.txt');
    await fs.writeFile(
      source,
      `using System;using System.IO;using Microsoft.Xrm.Sdk;namespace Invented {public sealed class AsyncIdentity:IPlugin {public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));if(c.Mode!=1||c.IsInTransaction)throw new Exception("Expected independent async context");if(c.Depth!=2)throw new Exception("Originating SDK depth lost after queue/restart");if(c.OperationCreatedOn.Kind!=DateTimeKind.Unspecified)throw new Exception("Qualified asynchronous operation DateTime kind lost");var path=@"${log}";File.AppendAllText(path,c.OperationId.ToString("D")+"|"+c.OperationCreatedOn.ToString("o")+"|"+c.RequestId.ToString()+Environment.NewLine);if(File.ReadAllLines(path).Length<3)throw new InvalidPluginExecutionException(OperationStatus.Retry,123,"Invented identity retry");}}
public sealed class SyncChild:IPlugin {public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));var parent=c.ParentContext;if(c.Mode!=0||parent==null||c.OperationCreatedOn.Kind!=DateTimeKind.Unspecified||parent.OperationCreatedOn.Kind!=DateTimeKind.Unspecified)throw new Exception("Synchronous JS parent DateTime kind lost");if(c.OperationId!=parent.OperationId||c.RequestId!=parent.RequestId||c.OperationCreatedOn!=parent.OperationCreatedOn)throw new Exception("Synchronous JS parent operation identity lost");((Entity)c.InputParameters["Target"])["verified"]=true;}}}`,
    );
    compileClr(source, assembly, { references: [sdk] });
    runtime = await prepareClrRuntime({
      trust: 'execute-local-assembly',
      root,
      assembly: 'Identity.dll',
      typeName: 'Invented.AsyncIdentity',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, 'cache'),
      persistentHost: true,
      timeoutMs: ORDINARY_CLR_TIMEOUT_MS,
      serviceProfile: { userId: id(2), evidence: 'Invented async operation identity', grants: [] },
      context: { initiatingUserId: id(2), organizationId: id(2), businessUnitId: id(2) },
    });
    const runtimes = new Map([[id(8), runtime]]),
      items = pluginCatalogue({
        plugins: { steps: [step(8)] },
        runtimes,
        overrides: { ['plugin-step:' + id(8)]: { mode: 'clr' } },
      });
    const file = path.join(root, 'state.json'),
      clock = fixedClock(),
      store = await makeStore({ file, clock });
    stores.push(store);
    const scheduler = createScheduler({ clock, manual: true });
    schedulers.push(scheduler);
    store.scheduler = scheduler;
    const schedule = scheduler.schedule;
    let admitted = 0;
    scheduler.schedule = (fn, delay, options) =>
      options?.name === 'committed-jobs' && ++admitted > 1 ? null : schedule(fn, delay, options);
    const attach = (store) => {
      const runner = createAsyncPluginRunner({
        store,
        items: () => items,
        handlers: new Map(),
        runtimes,
        systemJobs: () => true,
      });
      runners.push(runner);
      return runner;
    };
    const first = attach(store);
    await queue(store, { ...sourceFrame, operationDepth: 2 });
    const job = store.tableRows('asyncoperation')[0],
      expectedId = job.asyncoperationid,
      expectedCreated = job.createdon;
    assert.equal(job.depth, 2);
    clock.advance(30_000);
    await scheduler.runDue();
    assert.equal(store.tableRows('asyncoperation')[0].statuscode, 0);
    await first.close();
    await scheduler.close();
    store.close();
    const restarted = await new DataStore({ file, clock }).init();
    stores.push(restarted);
    const nextScheduler = createScheduler({ clock, manual: true });
    schedulers.push(nextScheduler);
    restarted.scheduler = nextScheduler;
    const next = attach(restarted);
    restarted.committedJobs.resume();
    clock.advance(60_000);
    await nextScheduler.runDue();
    await next.drain();
    const lines = (await fs.readFile(log, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map((line) => line.split('|'));
    assert.equal(lines.length, 3);
    for (const [operation, created, request] of lines) {
      assert.equal(operation, expectedId);
      assert.equal(created, expectedCreated.replace(/Z$/, '').replace(/\.([0-9]{3})$/, '.$10000'));
      assert.equal(request, sourceFrame.requestId);
      assert.notEqual(operation, request);
    }
    assert.equal(restarted.tableRows('asyncoperation')[0].statuscode, 30);
    assert.equal(restarted.tableRows('asyncoperation')[0].requestid, sourceFrame.requestId);
    assert.equal(restarted.tableRows('asyncoperation')[0].depth, 2);
    assert.equal(restarted.tableRows('widget')[0].title, 'Committed caller');
    await t.test(
      'a typed synchronous JavaScript parent preserves known time kind for its original CLR child',
      async () => {
        syncRuntime = await prepareClrRuntime({ ...runtime.descriptor, typeName: 'Invented.SyncChild' });
        const syncStore = await makeStore();
        stores.push(syncStore);
        syncStore.state.mappings.leaf = { entitySet: 'leaves', idColumn: 'leafid' };
        syncStore.state.tables.leaf = [];
        const profile = {
          userId: id(2),
          evidence: 'Invented synchronous JS parent',
          grants: [{ entity: 'leaf', operations: ['create'] }],
        };
        const handlers = new Map([
          [
            'Invented.SyncParent',
            () => {
              localOrganizationService(syncStore, profile).create('leaf', { title: 'Child' });
            },
          ],
        ]);
        const childRuntimes = new Map([[id(10), syncRuntime]]);
        const childItems = pluginCatalogue({
          plugins: {
            steps: [
              step(9, { mode: 0, stage: 20, typeName: 'Invented.SyncParent' }),
              step(10, { mode: 0, stage: 20, entity: 'leaf', typeName: 'Invented.SyncChild' }),
            ],
          },
          handlers,
          runtimes: childRuntimes,
          overrides: { ['plugin-step:' + id(10)]: { mode: 'clr' } },
        });
        syncStore.setPluginPipeline((context) =>
          runPluginPhase({ ...context, store: syncStore, items: childItems, handlers, runtimes: childRuntimes }),
        );
        await syncStore.create('widget', { title: 'Parent' }, { admin: true, systemUserId: id(2) });
        assert.equal(syncStore.tableRows('leaf').length, 1);
        assert.equal(syncStore.tableRows('leaf')[0].verified, true);
      },
    );
  },
);
