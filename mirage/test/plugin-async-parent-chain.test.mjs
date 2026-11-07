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
  // @parity-evidence: fixture teardown order only (Windows EPERM when the CLR cache was removed before the backend closed); no assertion changed
  // A closer: it runs before the owned directory removers, so the CLR hosts release the runtime's files first, and the
  // receiver closes even when the backend does not.
  ownedFixture(t).add(async () => {
    try {
      await backend.close();
      store.close();
    } finally {
      await new Promise((resolve) => {
        receiver.close(resolve);
        receiver.closeAllConnections();
      });
    }
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

// An original CLR probe: an asynchronous step writes its own chain into a log row (x_level 100: "message/depth|request|
// operation|frames", input names sorted); a PostOperation Update at Depth 1 named 'fan out' updates the other rows with an SDK UpdateMultiple;
// an asynchronous Create of level 1 creates level 2; a PostOperation Update named 'wrap' creates a row through an
// ExecuteTransaction (x_level 5) and one through an ExecuteMultiple (x_level 6).
// @parity-evidence: native and native-r2 bulkRequests and sdkSurface: the probe only gains the ExecuteTransaction/ExecuteMultiple 'wrap' branch, a Messages using and an image-count field; no assertion changed
async function chainProbe(t, steps) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paq-async-origin-')),
    source = path.join(root, 'Probe.cs'),
    sdk = clrSdk();
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(
    source,
    `using System;using System.Linq;using Microsoft.Xrm.Sdk;using Microsoft.Xrm.Sdk.Query;using Microsoft.Xrm.Sdk.Messages;namespace Invented{public sealed class Probe:IPlugin{public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));var t=(Entity)c.InputParameters["Target"];var s=((IOrganizationServiceFactory)p.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId);
if(c.Mode==1){if(t.GetAttributeValue<int>("x_level")>=100)return;var chain="";for(var f=c.ParentContext;f!=null;f=f.ParentContext)chain+=f.MessageName+"/"+f.Stage+"/"+f.Mode+"/"+f.Depth+"["+string.Join(",",f.InputParameters.Keys.OrderBy(k=>k).ToArray())+"];";
var log=new Entity("x_node");log["x_level"]=100;var images="";for(var f=c.ParentContext;f!=null;f=f.ParentContext){var g=(IPluginExecutionContext4)f;images+=(g.PreEntityImagesCollection.Length+g.PostEntityImagesCollection.Length)+";";}log["x_name"]=c.MessageName+"/"+c.Depth+"|"+c.RequestId+"|"+c.OperationId+"|"+chain+"|"+images;s.Create(log);
if(c.MessageName=="Create"&&t.GetAttributeValue<int>("x_level")==1){var n=new Entity("x_node");n["x_name"]="level 2";n["x_level"]=2;s.Create(n);}return;}
if(c.MessageName=="Update"&&c.Depth==1&&t.GetAttributeValue<string>("x_name")=="fan out"){var targets=new EntityCollection{EntityName="x_node"};foreach(var e in s.RetrieveMultiple(new QueryExpression("x_node"){ColumnSet=new ColumnSet("x_level")}).Entities){if(e.Id==t.Id||e.GetAttributeValue<int>("x_level")>=100)continue;var u=new Entity("x_node",e.Id);u["x_level"]=9;targets.Entities.Add(u);}var request=new OrganizationRequest("UpdateMultiple");request["Targets"]=targets;s.Execute(request);}
if(c.MessageName=="Update"&&c.Depth==1&&t.GetAttributeValue<string>("x_name")=="wrap"){Func<int,OrganizationRequestCollection> one=level=>{var n=new Entity("x_node");n["x_name"]="wrapped";n["x_level"]=level;var r=new OrganizationRequest("Create");r["Target"]=n;return new OrganizationRequestCollection{r};};var transaction=new OrganizationRequest("ExecuteTransaction");transaction["Requests"]=one(5);s.Execute(transaction);var multiple=new OrganizationRequest("ExecuteMultiple");multiple["Requests"]=one(6);multiple["Settings"]=new ExecuteMultipleSettings{ContinueOnError=false,ReturnResponses=true};s.Execute(multiple);}}}}`,
  );
  compileClr(source, path.join(root, 'Probe.dll'), { references: [sdk, 'System.Core.dll'] });
  const runtime = await prepareClrRuntime({
    trust: 'execute-local-assembly',
    root,
    assembly: 'Probe.dll',
    typeName: 'Invented.Probe',
    sdkRoot: path.dirname(sdk),
    sdkAssembly: path.basename(sdk),
    cacheRoot: path.join(root, 'cache'),
    timeoutMs: ORDINARY_CLR_TIMEOUT_MS,
    serviceProfile: {
      userId: CALLER,
      evidence: 'Invented asynchronous origin probe',
      grants: [{ entity: 'x_node', operations: ['read', 'create', 'update'] }],
      bulkTables: [
        { entity: 'x_node', tableType: 'standard', evidence: 'Invented bulk table', messages: ['UpdateMultiple'] },
      ],
    },
    context: { initiatingUserId: CALLER, organizationId: id(5), businessUnitId: id(6) },
  });
  const probes = steps.map(([n, message, mode]) =>
    step(n, message, 40, mode, { typeName: 'Invented.Probe', assemblyId: 'invented' }),
  );
  const org = await organization(t, probes, new Map(), {
    runtimes: new Map(probes.map((probe) => [probe.id, runtime])),
  });
  const logs = () =>
    org.store
      .tableRows('x_node')
      .filter((row) => row.x_level === 100)
      .map((row) => {
        const [job, requestId, operationId, chain, images] = row.x_name.split('|');
        return {
          job,
          requestId,
          operationId,
          chain: chain.split(';').filter(Boolean),
          images: images.split(';').filter(Boolean).map(Number),
        };
      });
  return { ...org, logs };
}

// Native and native-r2 asyncLoop d2..d12: a Create an asynchronous step issues is a new root operation of the
// originating request, so its own job reports only its main operation (Create/30/m1/d2), not the issuing job's frames.
// @test-kind parity: native and native-r2 asyncLoop (nested job chain Create/30/m1/dN, RequestId the originating request)
test(
  'a job of a Create an asynchronous step issued reports only its own main operation',
  { skip: CLR_SKIP },
  async (t) => {
    const { store, settle, logs } = await chainProbe(t, [[1, 'Create', 1]]);
    await store.create('x_node', { x_name: 'level 1', x_level: 1 }, identity);
    await settle();
    await settle();
    const byJob = Object.fromEntries(logs().map((log) => [log.job, log]));
    assert.deepEqual(Object.keys(byJob).toSorted(), ['Create/1', 'Create/2']);
    assert.deepEqual(byJob['Create/1'].chain, ['Create/30/1/1[Target]']);
    assert.deepEqual(byJob['Create/2'].chain, ['Create/30/1/2[FromSandbox,Target]']);
    assert.equal(byJob['Create/2'].requestId, byJob['Create/1'].requestId);
  },
);

// Native and native-r2 sdkSurface 85-94: a record an SDK UpdateMultiple from a PostOperation step delegates queues a job
// that reports the four frames its synchronous step saw, relabelled as the job (Update/40 < Update/30 < Update/40 <
// Update/30), the root Update's job its main operation.
// @test-kind parity: native and native-r2 sdkSurface (four-frame jobs of records a nested SDK UpdateMultiple delegates)
test(
  'a job of a record a nested SDK UpdateMultiple delegates reports its four synchronous frames',
  { skip: CLR_SKIP },
  async (t) => {
    const { store, settle, logs } = await chainProbe(t, [
      [1, 'Update', 0],
      [2, 'Update', 1],
    ]);
    const rows = [];
    for (const name of ['root', 'first', 'second'])
      rows.push(await store.create('x_node', { x_name: name, x_level: 1 }, identity));
    await store.update('x_node', rows[0].x_nodeid, { x_name: 'fan out' }, identity);
    await settle();
    const chains = logs().map(
      (log) => `${log.job} ${log.chain.map((frame) => frame.replace(/\[.*\]$/, '')).join(' < ')}`,
    );
    assert.deepEqual(chains.toSorted(), [
      'Update/1 Update/30/1/1',
      'Update/2 Update/40/1/2 < Update/30/1/2 < Update/40/1/2 < Update/30/1/2',
      'Update/2 Update/40/1/2 < Update/30/1/2 < Update/40/1/2 < Update/30/1/2',
    ]);
    // The caller's frames lose their Context4 image collections in a delegated record's job (native sdkSurface 85-90).
    for (const log of logs().filter((entry) => entry.job === 'Update/2')) assert.deepEqual(log.images, [0, 0, 0, 0]);
  },
);

// Native and native-r2 bulkRequests: the job of a row an ExecuteTransaction from an Update/40 step created runs at the
// caller's Depth with the caller's frames (Create/30 < Create/40 < Create/30), the job of a row an ExecuteMultiple created
// at Depth 3 with only its main operation.
// @test-kind parity: native and native-r2 bulkRequests (jobs of ExecuteTransaction and ExecuteMultiple requests)
test(
  'jobs of ExecuteTransaction and ExecuteMultiple requests report their native frames',
  { skip: CLR_SKIP },
  async (t) => {
    const { store, settle, logs } = await chainProbe(t, [
      [1, 'Update', 0],
      [2, 'Create', 1],
    ]);
    const row = await store.create('x_node', { x_name: 'caller', x_level: 1 }, identity);
    await settle();
    const before = logs().length;
    await store.update('x_node', row.x_nodeid, { x_name: 'wrap' }, identity);
    await settle();
    const chains = logs()
      .slice(before)
      .map((log) => `${log.job} ${log.chain.map((frame) => frame.replace(/\[.*\]$/, '')).join(' < ')}`);
    assert.deepEqual(chains.toSorted(), [
      'Create/1 Create/30/1/1 < Create/40/1/1 < Create/30/1/1',
      'Create/3 Create/30/1/3',
    ]);
  },
);

// Native and native-r2 bulk: the jobs of a Web API UpsertMultiple end in its relabelled main operation: a new record's
// Create job Create/40 < Create/30 [] < Create/30 [tag] (UpsertMultiple/30 without Targets), an existing record's
// Update job Update/40 [ConcurrencyBehavior] < Update/30 [ConcurrencyBehavior] < Update/30 [tag], and the
// CreateMultiple job CreateMultiple/30 [Targets] < CreateMultiple/30 [Targets, tag]. The probe logs only from its
// asynchronous registrations.
// @test-kind parity: native and native-r2 bulk (asynchronous jobs of a Web API UpsertMultiple)
test('jobs of a Web API UpsertMultiple end in its relabelled main operation', { skip: CLR_SKIP }, async (t) => {
  const { contractModuleFixture } = await import('./contract-module-fixture.mjs');
  const existing = id(201),
    fresh = id(202);
  const f = await contractModuleFixture(t, {
    mappings: {
      x_item: {
        logicalName: 'x_item',
        entitySet: 'x_items',
        idColumn: 'x_itemid',
        ownership: 'UserOwned',
        fields: { x_name: { dataverseType: 'nvarchar' } },
      },
      x_log: {
        logicalName: 'x_log',
        entitySet: 'x_logs',
        idColumn: 'x_logid',
        fields: { x_name: { dataverseType: 'nvarchar' } },
      },
    },
    tables: { x_item: [{ x_itemid: existing, x_name: 'Existing' }], x_log: [] },
    extension: { name: 'upsert-multiple-jobs', install: () => {} },
  });
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paq-upsert-jobs-')),
    source = path.join(root, 'Log.cs'),
    sdk = clrSdk();
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(
    source,
    `using System;using System.Linq;using Microsoft.Xrm.Sdk;namespace Invented{public sealed class Log:IPlugin{public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));if(c.Mode!=1)return;var s=((IOrganizationServiceFactory)p.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId);var chain=c.MessageName;for(var f=c.ParentContext;f!=null;f=f.ParentContext)chain+=" < "+f.MessageName+"/"+f.Stage+"["+string.Join(",",f.InputParameters.Keys.OrderBy(k=>k,StringComparer.Ordinal).ToArray())+"]";var log=new Entity("x_log");log["x_name"]=chain;s.Create(log);}}}`,
  );
  compileClr(source, path.join(root, 'Log.dll'), { references: [sdk, 'System.Core.dll'] });
  const runtime = await prepareClrRuntime({
    trust: 'execute-local-assembly',
    root,
    assembly: 'Log.dll',
    typeName: 'Invented.Log',
    sdkRoot: path.dirname(sdk),
    sdkAssembly: path.basename(sdk),
    cacheRoot: path.join(root, 'cache'),
    timeoutMs: ORDINARY_CLR_TIMEOUT_MS,
    serviceProfile: {
      userId: CALLER,
      evidence: 'Invented UpsertMultiple job probe',
      grants: [{ entity: 'x_log', operations: ['create'] }],
    },
    context: { initiatingUserId: CALLER, organizationId: id(5), businessUnitId: id(6) },
  });
  // Synchronous steps on every stage of each message, as in the native scenario, beside the asynchronous ones.
  const steps = ['Create', 'Update', 'CreateMultiple'].flatMap((message, index) =>
    [
      [40, 1],
      [10, 0],
      [20, 0],
      [40, 0],
    ].map(([stage, mode], slot) => ({
      ...step(210 + index * 4 + slot, message, stage, mode, { typeName: 'Invented.Log', assemblyId: 'invented' }),
      entity: 'x_item',
    })),
  );
  const runtimes = new Map(steps.map((entry) => [entry.id, runtime])),
    descriptors = new Map(steps.map((entry) => [entry.id, runtime.descriptor]));
  const items = pluginCatalogue({
    plugins: { steps },
    handlers: new Map(),
    runtimes,
    descriptors,
    overrides: Object.fromEntries(steps.map((entry) => ['plugin-step:' + entry.id, { mode: 'clr' }])),
  });
  const scheduler = createScheduler({ clock: f.store.clock, manual: true });
  const backend = await createOrganizationBackend({
    store: f.store,
    items: () => items,
    handlers: new Map(),
    runtimes,
    descriptors,
    scheduler,
  });
  ownedFixture(t).add(() => backend.close());
  const target = (key) => ({ '@odata.type': 'Microsoft.Dynamics.CRM.x_item', x_itemid: key, x_name: 'Upserted' });
  const response = await f.request('POST', '/x_items/Microsoft.Dynamics.CRM.UpsertMultiple?tag=invented-upsert', {
    Targets: [target(fresh), target(existing)],
  });
  assert.equal(response.status, 204, await response.text());
  await scheduler.runDue();
  await backend.asyncPluginRunner.drain();
  assert.deepEqual(
    f.store
      .tableRows('x_log')
      .map((row) => row.x_name)
      .toSorted(),
    [
      'Create < Create/40[] < Create/30[] < Create/30[tag]',
      'CreateMultiple < CreateMultiple/30[Targets] < CreateMultiple/30[Targets,tag]',
      'Update < Update/40[ConcurrencyBehavior] < Update/30[ConcurrencyBehavior] < Update/30[tag]',
    ],
  );
});

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
// job, at most four frames (sdkSurface): new_RecorderApi/40 < new_RecorderApi/30 for a call made from an Update
// PostOperation step.
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
  // @parity-evidence: native and native-r2 sdkSurface 85-94: a four-frame synchronous chain stays four frames in its job (Update/40 < Update/30 < Update/40 < Update/30), so a job keeps four caller frames, not three
  assert.deepEqual(labels(context), ['Assign/40', 'Assign/30', 'Assign/30', 'Assign/20']);
  assertJobFrames(context);
  for (let parent = context.ParentContext; parent; parent = parent.ParentContext)
    assert.equal(parent.PrimaryEntityName, 'x_node');
});

// Native imagesOrder (two captures): the asynchronous SetStateDynamicEntity job of a plain Update that sets statecode
// reports the two Update/30 frames its synchronous steps see, relabelled as the job: SetStateDynamicEntity/30 (the
// main operation as it then stands: Target and ConcurrencyBehavior) < SetStateDynamicEntity/30 (the PreValidation
// inputs, with the request's tag).
// @test-kind parity: native imagesOrder (native and native-r2) SetStateDynamicEntity under a PATCH statecode with If-Match
test('a plain Update statecode job reports both Update main-operation frames', async (t) => {
  const { store, settle, received } = await organization(
    t,
    [
      webhook(1, 'SetStateDynamicEntity'),
      step(2, 'Update', 20, 0, { typeName: 'Invented.Observe', assemblyId: 'invented' }),
    ],
    new Map([['Invented.Observe', () => {}]]),
  );
  const row = await store.create('x_node', { x_name: 'stateful', x_level: 1 }, identity);
  await store.update('x_node', row.x_nodeid, { statecode: 1, statuscode: 2 }, identity);
  await settle();
  assert.equal(received.length, 1);
  const [context] = received;
  assert.deepEqual(labels(context), ['SetStateDynamicEntity/30', 'SetStateDynamicEntity/30']);
  assertJobFrames(context);
  assert.deepEqual(
    context.ParentContext.InputParameters.map(({ key }) => key),
    ['Target', 'ConcurrencyBehavior'],
  );
  assert.ok(context.ParentContext.ParentContext.InputParameters.some(({ key }) => key === 'Target'));
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
