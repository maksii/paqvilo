// @test-kind unproven: local model of async Retry restart durability and private queues (Paqvilo design)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DataStore, emptyState } from '../lib/data.mjs';
import { prepareClrRuntime, closeClrHostPool } from '../lib/plugin-clr.mjs';
import { createAsyncPluginRunner } from '../lib/plugin-async.mjs';
import { pluginCatalogue } from '../lib/exported-plugins.mjs';
import { createScheduler, fixedClock } from '../lib/runtime-clock.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';
import { ORDINARY_CLR_TIMEOUT_MS } from './fixtures/clr-budget.mjs';

const user = '10000000-0000-4000-8000-000000000001';
const stepId = '10000000-0000-4000-8000-000000000002';
const step = {
  id: stepId,
  enabled: true,
  entity: 'widget',
  message: 'Create',
  stage: 40,
  rank: 1,
  mode: 1,
  supportedDeployment: 0,
  typeName: 'Invented.Retry',
  assemblyId: 'invented',
  filteringAttributes: [],
  images: [],
};

async function fixture(t) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paq-async-retry-'));
  const stores = [],
    runners = [];
  let runtime;
  const sdk = clrSdk(),
    source = path.join(root, 'Retry.cs'),
    assembly = path.join(root, 'Retry.dll');
  t.after(async () => {
    for (const runner of runners) await runner.close();
    if (runtime) await closeClrHostPool({ runtime });
    for (const store of stores) store.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  await fs.writeFile(
    source,
    `using System;using System.IO;using Microsoft.Xrm.Sdk;
namespace Invented {public sealed class Retry:IPlugin {public void Execute(IServiceProvider p) {
var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));
if(c.Mode!=1||c.IsInTransaction)throw new Exception("Not independent async execution");
if(c.SharedVariables.Contains("AttemptMarker"))throw new Exception("Prior attempt context leaked");
c.SharedVariables["AttemptMarker"]=true;
var target=(Entity)c.InputParameters["Target"];var mode=target.GetAttributeValue<string>("title");
var file=Path.Combine(@"${root}",c.PrimaryEntityId.ToString("D")+".txt");
var attempt=File.Exists(file)?File.ReadAllLines(file).Length+1:1;File.AppendAllText(file,"attempt"+Environment.NewLine);
var service=((IOrganizationServiceFactory)p.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId);
var effect=new Entity("audit");effect["title"]=mode+":"+attempt;service.Create(effect);
if(mode=="ordinary")throw new Exception("Permanent ordinary failure");
if(mode=="failed")throw new InvalidPluginExecutionException(OperationStatus.Failed,123,"Permanent plugin failure");
if(mode=="always"||attempt<3)throw new InvalidPluginExecutionException(OperationStatus.Retry,123,"Invented transient retry");
}}}`,
  );
  compileClr(source, assembly, { references: [sdk] });
  runtime = await prepareClrRuntime({
    trust: 'execute-local-assembly',
    root,
    assembly: 'Retry.dll',
    typeName: 'Invented.Retry',
    sdkRoot: path.dirname(sdk),
    sdkAssembly: path.basename(sdk),
    cacheRoot: path.join(root, 'cache'),
    timeoutMs: ORDINARY_CLR_TIMEOUT_MS,
    persistentHost: true,
    serviceProfile: {
      userId: user,
      evidence: 'Invented documented async retry',
      grants: [{ entity: 'audit', operations: ['create'] }],
    },
    context: { executionUserId: user, initiatingUserId: user, organizationId: user, businessUnitId: user },
  });
  const runtimes = new Map([[stepId, runtime]]);
  const items = pluginCatalogue({
    plugins: { steps: [step] },
    runtimes,
    descriptors: new Map([[stepId, runtime.descriptor]]),
    overrides: { ['plugin-step:' + stepId]: { mode: 'clr' } },
  });
  const makeStore = async (file) => {
    const state = emptyState();
    state.mappings.widget = { entitySet: 'widgets', idColumn: 'widgetid' };
    state.mappings.audit = { entitySet: 'audits', idColumn: 'auditid' };
    state.tables.widget = [];
    state.tables.audit = [];
    const store = await new DataStore({ state, file }).init();
    stores.push(store);
    return store;
  };
  const attach = (store, { systemJobs = true } = {}) => {
    const notes = [];
    const runner = createAsyncPluginRunner({
      store,
      items: () => items,
      handlers: new Map(),
      runtimes,
      diagnostic: (note) => notes.push(note),
      systemJobs: () => systemJobs,
    });
    runners.push(runner);
    return { runner, notes };
  };
  const attempts = async (id) => (await fs.readFile(path.join(root, id + '.txt'), 'utf8')).trim().split('\n').length;
  return { root, makeStore, attach, attempts, stores };
}

// @parity-evidence: tag reason only; native asyncRetry is one capture with two concurrent runs (audit C2-02 VAL-c8)
// @test-kind parity: native asyncRetry (one capture, two concurrent runs): an always-Retry step executes five times and ends Failed with retrycount 4; coded and plain exceptions execute once; every failure has errorcode 0x80040265 and the authored text as friendlymessage; failed attempts' writes persist
test(
  'original CLR async Retry has five independent executions, fresh contexts and preserved completed SDK effects',
  { skip: CLR_SKIP, timeout: 180000 },
  async (t) => {
    const f = await fixture(t);
    for (const mode of ['always', 'eventual', 'failed', 'ordinary'])
      await t.test(mode, async () => {
        const store = await f.makeStore();
        const { runner, notes } = f.attach(store);
        const caller = await store.create('widget', { title: mode }, { admin: true });
        await runner.drain();
        // @parity-evidence: native asyncRetry: always-Retry 5 executions, retrycount 4; coded/plain 1 execution, retrycount 0
        const expected = mode === 'always' ? 5 : mode === 'eventual' ? 3 : 1;
        assert.equal(await f.attempts(caller.widgetid), expected);
        assert.equal(store.tableRows('widget').length, 1, 'the original caller stays committed');
        assert.equal(
          store.tableRows('audit').length,
          expected,
          'completed independent SDK calls survive failed attempts',
        );
        const [job] = store.tableRows('asyncoperation');
        assert.equal(job.statuscode, mode === 'eventual' ? 30 : 31);
        assert.equal(job.retrycount, expected - 1, 'retrycount counts actual claims after the first execution');
        const payload = JSON.parse(job.data);
        assert.equal(payload.pluginAttempts, expected);
        assert.equal(payload.attempts, undefined, 'intentional retries do not consume infrastructure poison attempts');
        assert.equal(
          notes.filter((note) => note.code === 'PLUGIN_ASYNC_RETRY_REQUESTED').length,
          mode === 'always' ? 4 : mode === 'eventual' ? 2 : 0,
        );
        if (mode !== 'eventual') {
          assert.equal(job.errorcode, 0x80040265 | 0, 'the authored code is not the job error code');
          assert.equal(
            job.friendlymessage,
            {
              always: 'Invented transient retry',
              failed: 'Permanent plugin failure',
              ordinary: 'Permanent ordinary failure',
            }[mode],
          );
          assert.match(job.message, /^Plugin Trace:\r\n\r\n\[[^\]]+: Invented\.Retry\]/);
        }
        if (mode === 'eventual') assert.equal(job.message, null, 'success does not retain a transient error');
        await runner.close();
      });
    for (const mode of ['autodelete', 'private queue'])
      await t.test(mode, async () => {
        const store = await f.makeStore();
        if (mode === 'autodelete')
          store.state.tables.sdkmessageprocessingstep = [{ sdkmessageprocessingstepid: stepId, asyncautodelete: true }];
        const { runner } = f.attach(store, { systemJobs: mode !== 'private queue' });
        const caller = await store.create(
          'widget',
          { title: mode === 'private queue' ? 'always' : 'eventual' },
          { admin: true },
        );
        await runner.drain();
        assert.equal(await f.attempts(caller.widgetid), mode === 'private queue' ? 5 : 3);
        assert.equal(store.tableRows('asyncoperation').length, 0);
        await runner.close();
      });
  },
);

// @test-kind unproven: restart durability of the attempt budget is Paqvilo design; the five-execution budget is native asyncRetry
test(
  'async retry attempts persist before execution and survive a runtime restart without resetting the five-attempt budget',
  { skip: CLR_SKIP, timeout: 180000 },
  async (t) => {
    const f = await fixture(t),
      file = path.join(f.root, 'state.json');
    const store = await f.makeStore(file),
      clock = fixedClock(),
      scheduler = createScheduler({ clock, manual: true });
    store.scheduler = scheduler;
    const schedule = scheduler.schedule;
    let admitted = 0;
    scheduler.schedule = (fn, delay, options) =>
      options?.name === 'committed-jobs' && ++admitted > 1 ? null : schedule(fn, delay, options);
    const { runner } = f.attach(store);
    const caller = await store.create('widget', { title: 'eventual' }, { admin: true });
    await scheduler.runDue();
    assert.equal(await f.attempts(caller.widgetid), 1);
    const [waiting] = store.tableRows('asyncoperation');
    assert.equal(waiting.statecode, 0);
    assert.equal(waiting.retrycount, 0, 'requesting a retry does not claim the next execution');
    assert.equal(JSON.parse(waiting.data).pluginAttempts, 1);
    await runner.close();
    scheduler.close();
    const restarted = await new DataStore({ file }).init();
    f.stores.push(restarted);
    const next = f.attach(restarted);
    restarted.committedJobs.resume();
    await next.runner.drain();
    assert.equal(await f.attempts(caller.widgetid), 3);
    assert.equal(restarted.tableRows('audit').length, 3);
    const [finished] = restarted.tableRows('asyncoperation');
    assert.equal(finished.statuscode, 30);
    assert.equal(finished.retrycount, 2);
    assert.equal(JSON.parse(finished.data).pluginAttempts, 3);
    // A crash after the fifth durable claim cannot admit an execution six.
    await restarted.transact(() => {
      const payload = JSON.parse(finished.data);
      finished.data = JSON.stringify({ ...payload, pluginAttempts: 5 });
      Object.assign(finished, { statecode: 2, statuscode: 20, retrycount: 4 });
    });
    await next.runner.close();
    const recovered = await new DataStore({ file }).init();
    f.stores.push(recovered);
    const last = f.attach(recovered);
    recovered.committedJobs.resume();
    await last.runner.drain();
    assert.equal(await f.attempts(caller.widgetid), 3, 'unfinished exhausted claim does not restart the budget');
    assert.equal(recovered.tableRows('asyncoperation')[0].statuscode, 31);
    assert.equal(recovered.tableRows('asyncoperation')[0].retrycount, 4);
    assert.equal(JSON.parse(recovered.tableRows('asyncoperation')[0].data).pluginAttempts, 5);
  },
);
